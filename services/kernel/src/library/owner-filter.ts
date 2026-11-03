import { admitFilter, FilterError, parseFilter, walkFilter, type FilterDocument, type OwnerLeaf } from '@rezics/filter';
import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import { deadlineClient } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { commandAccessContext } from '../access/command-admission.ts';
import { authoritativeTimeValue, type AuthoritativeTime, type CommandAttempt } from '../command/command.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import { parseStrictJson } from '../http/strict-json.ts';
import { accessCheck, AuthenticationError, type Access, type Actor } from '../request/access.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { routeOf } from '../route/route.ts';
import { activeRelease, freeze, readRelease } from '../semantic/definitions.ts';
import type { RelationFacetMatch } from '../search/source.ts';
import {
  compileCurrentOwnerFilter,
  currentOwnerClauseKey,
  type CurrentNativeLeaf,
  type CurrentOwnerFilterPlan,
} from '../search/current-filter-plan.ts';
import { holdsCurrentStatements, holdsCurrentType } from '../search/current-leaf.ts';
import type { LeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import { createCollectionSource, type PrepareCollectionSource, type WorkDimensions } from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import type { AdmittedCollectionRule } from './collection-rules.ts';
import { decodeLibraryProfilePin } from './profile-pin.ts';
import {
  hasCopyStatus,
  hasEntryState,
  progressUnit,
  resolveLibraryProfilePin,
  type LibraryProfilePin,
} from './profile.ts';
import entryPoint from './owner-filter-entry.sql';
import labelPoint from './owner-filter-label.sql';
import sessionPoint from './owner-filter-session.sql';
import holdingPoint from './owner-filter-holding.sql';
import entrySize from './owner-filter-entry-size.sql';
import sessionSize from './owner-filter-session-size.sql';
import holdingSize from './owner-filter-holding-size.sql';
import entryPresence from './owner-filter-entry-presence.sql';
import sessionPresence from './owner-filter-session-presence.sql';
import holdingPresence from './owner-filter-holding-presence.sql';

type EntryOperand = Extract<OwnerLeaf['owner'], { state: unknown }>['state'];
type NativeFactBase = { subjectId: string };
export type OwnerFilterEntryFact = NativeFactBase & {
  kind: 'entry';
  state: string;
  ownerWriteSeq: bigint | null;
  pin: LibraryProfilePin | null;
};
export type OwnerFilterNativeFact =
  | OwnerFilterEntryFact
  | (NativeFactBase & { kind: 'label'; labelId: string; assignmentId: string })
  | (NativeFactBase & {
      kind: 'session';
      sessionId: string;
      lifecycle: 'active' | 'completed' | 'abandoned';
      mode: 'scalar_amount' | 'cursor_position' | 'completed_units';
      unit: string;
      pin: LibraryProfilePin | null;
    })
  | (NativeFactBase & {
      kind: 'holding';
      copyId: string;
      copyKind: string | null;
      status: string;
      pin: LibraryProfilePin | null;
    });

/** Native keys discovered by the sole candidate/support producer, never an owner/account selector. */
export type OwnerFilterFactLocator =
  | { kind: 'entry'; subjectId: string }
  | { kind: 'label'; subjectId: string; labelId: string }
  | { kind: 'session'; subjectId: string; sessionId: string }
  | { kind: 'holding'; subjectId: string; copyId: string };

export interface OwnerFilterLeafProvider {
  /** One current supporter, independent of profile/pin readiness; false is not canonical absence. */
  readPresence(
    client: Pick<PoolClient, 'query'>,
    locator: OwnerFilterFactLocator,
    work: NativeCollectionWork,
  ): Promise<boolean>;
  /**
   * Exact native point only. The caller supplies its source-authorized snapshot and SAME shared Source ledger.
   * A miss is NOT complete canonical absence; original/terminal disclosure and complete support remain required.
   * No history/alias enumeration, readiness, Source observation or permission is supplied by this provider.
   */
  read(
    client: Pick<PoolClient, 'query'>,
    locator: OwnerFilterFactLocator,
    work: NativeCollectionWork,
  ): Promise<OwnerFilterNativeFact | null>;
}

export type CollectionMemberAdmission = {
  filter: FilterDocument | undefined;
  sort: 'id';
  plan: CurrentOwnerFilterPlan | null;
  /** Immutable admitted meaning and exact expanded query; private cursor/preparation input, never permission. */
  releaseDigest: string | null;
  release: Release | null;
  queryDigest: string;
  /** Bound only after every expanded private-family branch has passed current viewer-self admission. */
  owner: OwnerFilterLeafProvider | null;
};

const NATIVE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function nativeId(id: string): void {
  if (NATIVE_UUID.exec(id)?.[0] !== id || routeOf(id) === null) throw new TypeError('Invalid native owner fact key');
}

const NO_WORK: WorkDimensions = Object.freeze({
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
});

/** Native point footprint, reserved before SQL, including input bytes, misses and failure work. */
async function nativePoint<T>(
  work: NativeCollectionWork,
  query: { sql: string },
  input: object,
  outputBytes: number,
  read: () => Promise<T | null>,
  parents = 0,
): Promise<T | null> {
  const reservation = work.reserve({
    ...NO_WORK,
    candidateKeys: 1,
    // A live-parent label point includes its CTE, exact assignment and exact parent probe.
    nativeRows: parents ? 20 : 4,
    nativePoints: 1 + parents,
    witnessKeys: 1,
    statements: 1,
    emptySeeks: 1,
    bytes: Buffer.byteLength(query.sql) + Buffer.byteLength(JSON.stringify(input)) + outputBytes,
  });
  reservation.dispatch();
  let row: T | null;
  try {
    row = await read();
  } catch (error) {
    // Dispatched work remains charged when PostgreSQL cannot produce a row/EOF observation.
    reservation.settle();
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
  reservation.settle({
    candidateKeys: row === null ? 0 : 1,
    witnessKeys: row === null ? 0 : 1,
    emptySeeks: row === null ? 1 : 0,
  });
  return row;
}

function pinProjectionBytes(size: { projectionBytes: string | null; projectionCompressed: boolean }): number {
  // Same native projection bound used by collection-source-native: compressed TOAST needs its full bound.
  // Insufficient allowance rejects BEFORE hydration; a size point never certifies current pin meaning.
  if (size.projectionBytes === null) throw new Error('Missing native owner projection size');
  const bytes = Number(size.projectionBytes);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid native owner projection size');
  return 6 * (size.projectionCompressed ? 4 * 1024 * 1024 * 1024 : bytes) + 1024;
}

/** Native point implementation only. Callers must independently admit the owner and complete original closure. */
export function leafProvider(accountId: string, filter: FilterDocument, deadline: number): OwnerFilterLeafProvider {
  const route = routeOf(accountId);
  if (route === null) throw new TypeError('Invalid native owner');
  const families = new Set<OwnerFilterFactLocator['kind']>();
  let presence = false;
  for (const node of walkFilter(filter)) {
    if (!('owner' in node)) continue;
    if ('presence' in node.owner) {
      presence = true;
      for (const family of ['entry', 'label', 'session', 'holding'] as const) families.add(family);
    }
    if ('state' in node.owner) families.add('entry');
    if ('label' in node.owner) families.add('label');
    if ('session' in node.owner) families.add('session');
    if ('holding' in node.owner) families.add('holding');
  }
  return {
    async readPresence(connection, locator, work) {
      requireAccessDeadline(deadline);
      if (!presence) throw new TypeError('Owner presence was not admitted');
      nativeId(locator.subjectId);
      const client = deadlineClient(connection, deadline);
      const key = { route, account_id: accountId, subject_id: locator.subjectId };
      switch (locator.kind) {
        case 'entry':
          return (await nativePoint(work, entryPresence, key, 128, () => entryPresence.run(client, key))) !== null;
        case 'label': {
          nativeId(locator.labelId);
          const input = { ...key, label_id: locator.labelId };
          return (await nativePoint(work, labelPoint, input, 256, () => labelPoint.run(client, input), 1)) !== null;
        }
        case 'session': {
          nativeId(locator.sessionId);
          if (routeOf(locator.sessionId) !== route) return false;
          const input = { ...key, session_id: locator.sessionId };
          return (
            (await nativePoint(work, sessionPresence, input, 128, () => sessionPresence.run(client, input))) !== null
          );
        }
        case 'holding': {
          nativeId(locator.copyId);
          if (routeOf(locator.copyId) !== route) return false;
          const input = { ...key, copy_id: locator.copyId };
          return (
            (await nativePoint(work, holdingPresence, input, 128, () => holdingPresence.run(client, input))) !== null
          );
        }
      }
    },
    async read(connection, locator, work) {
      requireAccessDeadline(deadline);
      if (!families.has(locator.kind)) throw new TypeError('Owner fact family was not admitted');
      nativeId(locator.subjectId);
      const client = deadlineClient(connection, deadline);
      const key = { route, account_id: accountId, subject_id: locator.subjectId };
      switch (locator.kind) {
        case 'entry': {
          const size = await nativePoint(work, entrySize, key, 128, () => entrySize.run(client, key));
          if (size === null) return null;
          const row = await nativePoint(work, entryPoint, key, pinProjectionBytes(size), () =>
            entryPoint.run(client, key),
          );
          if (!row) return null;
          const sequence = row.ownerWriteSeq === null ? null : BigInt(row.ownerWriteSeq);
          if (sequence !== null && sequence <= 0n) throw new Error('Invalid native owner write sequence');
          return {
            kind: 'entry',
            subjectId: row.subjectId,
            state: row.state,
            ownerWriteSeq: sequence,
            pin: decodeLibraryProfilePin(row.libraryProfilePin),
          };
        }
        case 'label': {
          nativeId(locator.labelId);
          const input = { ...key, label_id: locator.labelId };
          const row = await nativePoint(work, labelPoint, input, 256, () => labelPoint.run(client, input), 1);
          if (!row) return null;
          if (row.assignmentId === null) throw new Error('Live label reservation has no native identity');
          return { kind: 'label', subjectId: row.subjectId, labelId: row.labelId, assignmentId: row.assignmentId };
        }
        case 'session': {
          nativeId(locator.sessionId);
          if (routeOf(locator.sessionId) !== route) return null;
          const input = { ...key, session_id: locator.sessionId };
          const size = await nativePoint(work, sessionSize, input, 128, () => sessionSize.run(client, input));
          if (size === null) return null;
          const row = await nativePoint(work, sessionPoint, input, pinProjectionBytes(size), () =>
            sessionPoint.run(client, input),
          );
          if (!row) return null;
          if (row.lifecycle !== 'active' && row.lifecycle !== 'completed' && row.lifecycle !== 'abandoned')
            throw new Error('Invalid native session lifecycle');
          if (row.mode !== 'scalar_amount' && row.mode !== 'cursor_position' && row.mode !== 'completed_units')
            throw new Error('Invalid native session mode');
          return {
            kind: 'session',
            subjectId: row.subjectId,
            sessionId: row.sessionId,
            lifecycle: row.lifecycle,
            mode: row.mode,
            unit: row.unit,
            pin: decodeLibraryProfilePin(row.libraryProfilePin),
          };
        }
        case 'holding': {
          nativeId(locator.copyId);
          if (routeOf(locator.copyId) !== route) return null;
          const input = { ...key, copy_id: locator.copyId };
          const size = await nativePoint(work, holdingSize, input, 128, () => holdingSize.run(client, input));
          if (size === null) return null;
          const row = await nativePoint(work, holdingPoint, input, pinProjectionBytes(size), () =>
            holdingPoint.run(client, input),
          );
          return row
            ? {
                kind: 'holding',
                subjectId: row.subjectId,
                copyId: row.copyId,
                copyKind: row.kind,
                status: row.status,
                pin: decodeLibraryProfilePin(row.libraryProfilePin),
              }
            : null;
        }
      }
    },
  };
}

/**
 * Resolve immutable accepted meaning, never the current release or current subject type.
 * Missing evidence stays unknown. This matcher proves ONE native supporter, not source completeness.
 */
function factProfile(fact: Exclude<OwnerFilterNativeFact, { kind: 'label' }>, releases: ReadonlyMap<string, Release>) {
  if (fact.pin === null) return null;
  const release = releases.get(fact.pin.releaseDigest);
  return release ? resolveLibraryProfilePin({ digest: fact.pin.releaseDigest, release }, fact.pin) : null;
}

export function matchOwnerFilterSupport(
  leaf: Exclude<OwnerLeaf['owner'], { state: unknown }>,
  fact: OwnerFilterNativeFact,
  releases: ReadonlyMap<string, Release>,
): RelationFacetMatch {
  // Native live support proves presence; immutable pin meaning is a separate profiled-leaf dependency.
  if ('presence' in leaf) return true;
  if (fact.kind === 'label') return 'label' in leaf && leaf.label.id === fact.labelId;
  if ('label' in leaf) return false;
  if ('session' in leaf && fact.kind !== 'session') return false;
  if ('holding' in leaf && fact.kind !== 'holding') return false;
  const profile = factProfile(fact, releases);
  if (!profile) return 'not_proven';
  if (fact.kind === 'entry') {
    if (!hasEntryState(profile, fact.state)) return 'not_proven';
    return false;
  }
  if (fact.kind === 'session') {
    if (!progressUnit(profile, fact.mode, fact.unit)) return 'not_proven';
    return (
      'session' in leaf && leaf.session.profileId === fact.pin?.profileId && leaf.session.lifecycle === fact.lifecycle
    );
  }
  if (fact.copyKind === null || !hasCopyStatus(profile, fact.copyKind, fact.status)) return 'not_proven';
  return (
    'holding' in leaf &&
    leaf.holding.profileId === fact.pin?.profileId &&
    (leaf.holding.kind === undefined || leaf.holding.kind === fact.copyKind) &&
    (leaf.holding.status === undefined || leaf.holding.status === fact.status)
  );
}

/**
 * Fold already settled LIVE native entry points before testing any requested state. Bounded source work owns
 * enumeration/completeness. Unsequenced entries cannot lose to a sequenced entry by an invented tie-breaker.
 */
export function ownerFilterStateWinner(
  entries: Iterable<OwnerFilterEntryFact>,
): OwnerFilterEntryFact | null | 'not_proven' {
  let winner: OwnerFilterEntryFact | null = null;
  for (const entry of entries) {
    if (entry.ownerWriteSeq === null || entry.ownerWriteSeq <= 0n) return 'not_proven';
    if (winner?.ownerWriteSeq === entry.ownerWriteSeq && winner.subjectId !== entry.subjectId) return 'not_proven';
    if (winner === null || entry.ownerWriteSeq > winner.ownerWriteSeq!) winner = entry;
  }
  return winner;
}

/** Null is usable only after the shared Source establishes complete no-entry evidence. */
export function matchOwnerFilterState(
  leaf: EntryOperand,
  winner: ReturnType<typeof ownerFilterStateWinner>,
  releases: ReadonlyMap<string, Release>,
): RelationFacetMatch {
  if (winner === 'not_proven') return 'not_proven';
  if (winner === null) return false;
  const profile = factProfile(winner, releases);
  if (!profile || !hasEntryState(profile, winner.state)) return 'not_proven';
  return (
    winner.pin?.profileId === leaf.profileId &&
    profile.entryStateSet?.id === leaf.stateSetId &&
    leaf.in.includes(winner.state)
  );
}

/**
 * Consume the existing Semantic leaf evidence for the EXACT requested catalogue leaf. Current Source,
 * original/terminal disclosure and identity observations belong to the caller, independently of this matcher.
 * A selected positive can suffice; a partial selection can never manufacture absence beneath NOT.
 */
export function matchOwnerFilterCatalogue(
  leaf: Extract<CurrentNativeLeaf, { kind: 'catalogue' }>,
  evidence: LeafEvidence,
): RelationFacetMatch {
  if (evidence.state !== 'current') return 'not_proven';
  const matches =
    leaf.clause.facet === 'type'
      ? evidence.type !== null && holdsCurrentType(evidence.type, leaf.clause)
      : holdsCurrentStatements(
          evidence.facts.map((fact) => fact.statement),
          leaf.clause,
        );
  if (matches) return true;
  return evidence.coverage?.basis === evidence.basis && evidence.progress === null ? false : 'not_proven';
}

/** Resolve/admit ALL deduplicated leaves before invoking Search's sole Boolean interpreter. */
export function evaluateOwnerFilterLeaves(
  plan: CurrentOwnerFilterPlan,
  observations: ReadonlyMap<string, RelationFacetMatch>,
): RelationFacetMatch {
  if (observations.size !== plan.leaves.length) throw new TypeError('Incomplete owner-filter observations');
  return plan.evaluate(
    plan.leaves.map((leaf) => {
      const key = currentOwnerClauseKey(leaf);
      if (!observations.has(key)) throw new TypeError('Incomplete owner-filter observations');
      return observations.get(key)!;
    }),
  );
}

export type CollectionMemberQuery = {
  cursor?: string | null;
  limit?: number;
  filter?: string;
  sort?: string;
  view?: 'BASIC' | 'FULL';
};

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
const nativeAdmissions = new WeakMap<
  CollectionMemberAdmission,
  Readonly<{
    actor: Actor;
    pool: Pool;
    deadline: number;
    retainedMeaning: boolean;
  }>
>();

/** Exact native grammar/family admission, not a permission verdict or a serializable capability.
 * Consumers must repeat ordinary current authority and Source/identity fences at their actual T.
 */
export function readNativeCollectionMemberAdmission(admission: CollectionMemberAdmission) {
  return nativeAdmissions.get(admission);
}
type PrivateRead = { action: string; group: string };

/** Native family list authority, including branches whose truth could otherwise short circuit. */
export function collectionMemberPrivateReads(filter: FilterDocument): PrivateRead[] {
  const reads = new Map<string, PrivateRead>();
  const add = (action: string, group: string) => reads.set(action, { action, group });
  for (const node of walkFilter(filter)) {
    if (!('owner' in node)) continue;
    const leaf = node.owner;
    if ('presence' in leaf || 'state' in leaf || 'label' in leaf) add('library_entry:list', 'personal_library');
    if ('presence' in leaf || 'session' in leaf) add('progress_session:list', 'reading_progress');
    if ('presence' in leaf || 'holding' in leaf) add('copy:list', 'personal_library');
  }
  return [...reads.values()];
}

/** Repeat the admitted expanded families at the actual caller time, including every negative branch. */
export async function prepareNativeCollectionMemberAuthority(
  deps: Dependencies,
  viewer: Actor,
  admission: CollectionMemberAdmission,
  at: AuthoritativeTime,
  deadline: number,
  attempt?: CommandAttempt,
) {
  const saved = nativeAdmissions.get(admission);
  if (!saved || saved.actor !== viewer || saved.pool !== deps.pool)
    throw new TypeError('Foreign native owner admission');
  if (!admission.owner || !admission.filter) return [];
  if (viewer.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  const route = routeOf(viewer.accountId);
  if (route === null || (attempt && attempt.time !== at)) throw new TypeError('Foreign native owner time');
  const checks = [];
  for (const { action, group } of collectionMemberPrivateReads(admission.filter)) {
    if (!viewer.scopes.includes(action)) throw new ProblemError('forbidden');
    await admitGroup({
      pool: deps.pool,
      access: () => deps.access,
      actor: viewer,
      group,
      clientAction: action,
      deadline,
      clock: () => new Date(authoritativeTimeValue(at)),
    });
    const context = { pool: deps.pool, deadline };
    checks.push(
      await accessCheck(
        deps.access,
        viewer,
        action,
        { route, id: viewer.accountId },
        attempt ? commandAccessContext(context, attempt) : context,
      ),
    );
  }
  return checks;
}

function invalidFilter(error: unknown): never {
  if (error instanceof FilterError)
    throw new ProblemError(error.problem, {
      errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
    });
  if (error instanceof SyntaxError)
    throw new ProblemError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_format' }] });
  throw error;
}

/** Shared grammar/release admission only. The returned AST certifies neither execution nor disclosure. */
export async function admitCollectionMemberQuery(
  deps: Dependencies,
  viewer: Actor,
  options: CollectionMemberQuery,
  deadline: number,
): Promise<CollectionMemberAdmission> {
  requireAccessDeadline(deadline);
  if (options.sort !== undefined && options.sort !== 'id')
    throw new ProblemError('unsupported_query', { errors: [{ pointer: '/sort', code: 'unsupported' }] });
  let filter: FilterDocument | undefined;
  let releaseDigest: string | null = null;
  let release: Release | null = null;
  if (options.filter !== undefined) {
    if (typeof options.filter !== 'string')
      throw new ProblemError('invalid_request', { errors: [{ pointer: '/filter', code: 'invalid_type' }] });
    try {
      filter = parseFilter(parseStrictJson(options.filter));
      const snapshot = await activeRelease(deps.pool);
      requireAccessDeadline(deadline);
      if (!snapshot) throw new ProblemError('semantic_not_ready');
      // Expand saved filters before collecting private dependencies. Never erase owner nodes to fit a plan.
      filter = admitFilter(filter, snapshot.release, { owner: true });
      releaseDigest = snapshot.digest;
      release = snapshot.release;
    } catch (error) {
      invalidFilter(error);
    }
  }
  return finishCollectionMemberAdmission(deps, viewer, filter, release, releaseDigest, deadline);
}

/** Stored expanded meaning keeps its accepted release; it is never reinterpreted by current activation. */
export async function admitSavedCollectionMemberQuery(
  deps: Dependencies,
  viewer: Actor,
  rule: AdmittedCollectionRule,
  options: CollectionMemberQuery,
  deadline: number,
): Promise<CollectionMemberAdmission> {
  requireAccessDeadline(deadline);
  if (options.sort !== undefined && options.sort !== rule.sort) throw new ProblemError('unsupported_query');
  const release = await readRelease(deps.pool, rule.releaseDigest);
  requireAccessDeadline(deadline);
  if (!release) throw new ProblemError('dependency_unavailable');
  let filter = rule.filter;
  if (options.filter !== undefined) {
    try {
      // The combined document still pays the shared expansion/size limits and uses one accepted meaning.
      filter = admitFilter(parseFilter({ and: [rule.filter, parseStrictJson(options.filter)] }), release, {
        owner: true,
      });
    } catch (error) {
      invalidFilter(error);
    }
  }
  return finishCollectionMemberAdmission(deps, viewer, filter, release, rule.releaseDigest, deadline, true);
}

async function finishCollectionMemberAdmission(
  deps: Dependencies,
  viewer: Actor,
  filter: FilterDocument | undefined,
  release: Release | null,
  releaseDigest: string | null,
  deadline: number,
  retainedMeaning = false,
): Promise<CollectionMemberAdmission> {
  const reads = filter === undefined ? [] : collectionMemberPrivateReads(filter);
  if (reads.length) {
    if (viewer.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
    if (reads.some(({ action }) => !viewer.scopes.includes(action)))
      throw new ProblemError('forbidden', { headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' } });
    const route = routeOf(viewer.accountId);
    if (route === null) throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    const account = await readAccount(deadlineClient(deps.pool, deadline), route, viewer.accountId);
    if (
      !account ||
      account.kind !== 'actor' ||
      account.state !== 'active' ||
      account.fenced ||
      !Number.isSafeInteger(viewer.authnEpoch) ||
      viewer.authnEpoch < 1 ||
      BigInt(viewer.authnEpoch) < account.minimumAuthnEpoch
    )
      throw new AuthenticationError(401, 'Bearer error="invalid_token"');
    for (const { action, group } of reads)
      await admitGroup({
        pool: deps.pool,
        access: () => deps.access,
        actor: viewer,
        group,
        clientAction: action,
        deadline,
        clock: deps.clock ?? systemClock,
      });
  }
  const admission: CollectionMemberAdmission = {
    filter,
    sort: 'id',
    plan: filter === undefined ? null : compileCurrentOwnerFilter(filter),
    releaseDigest,
    release,
    queryDigest:
      'sha256:' +
      createHash('sha256')
        .update(canonicalize({ filter: filter ?? null, sort: 'id', releaseDigest })!)
        .digest('hex'),
    owner:
      filter !== undefined && reads.length && viewer.kind === 'account'
        ? leafProvider(viewer.accountId, filter, deadline)
        : null,
  };
  freeze(admission);
  nativeAdmissions.set(admission, { actor: viewer, pool: deps.pool, deadline, retainedMeaning });
  return admission;
}

/**
 * Native common-member/saved-rule composition boundary. The enclosing caller supplies its EXISTING Source
 * context and reserved allowance. Only the real Source producer can return its opaque authorized handle.
 * No private fact SQL, raw-window fallback, fabricated handle, readiness or additional allowance is supplied.
 */
export async function prepareCollectionMemberFilter(
  deps: Dependencies,
  options: CollectionMemberQuery,
  input: PrepareCollectionSource,
) {
  // Request admission requires the current reader; background completion cannot supply an Actor.
  if (input.work) throw new ProblemError('dependency_unavailable');
  const admission = await admitCollectionMemberQuery(deps, input.actor, options, input.deadline);
  const prepared = await createCollectionSource(deps).prepare(input);
  return { admission, ...prepared };
}
