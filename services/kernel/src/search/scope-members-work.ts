/** Read-only Members execution on the genuine admitted operational client. No Source or custody producer. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Release } from '@rezics/definitions';
import type { Pool, QueryResultRow } from 'pg';
import { hasLiveOperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import { readCollectionSourceWorkState } from '../library/collection-source-work-native.ts';
import type { MembersPreparationWorkDefinition } from '../library/members-preparation.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import type { WorkDimensions } from '../library/collection-source.ts';
import { leafProvider, type CollectionMemberAdmission, type OwnerFilterFactLocator } from '../library/owner-filter.ts';
import { readOwnerFilterCandidate, type OwnerFilterCandidateClosure } from '../library/owner-filter-plan.ts';
import factsQuery from '../library/owner-filter-native-closure-facts.sql';
import fenceQuery from '../library/owner-filter-native-binding-fence.sql';
import { readRelease } from '../semantic/definitions.ts';
import { createIdentityScopedObservations, identityScopeAddress } from '../semantic/identity-scoped-observations.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { readMembersPreparationWorkDefinition, type MembersPreparationWorkContext } from './scope-work-context.ts';
import {
  MEMBERS_SEARCH_QUERY_SQL,
  MEMBERS_SNAPSHOT_OWNER_FENCE_DIMENSIONS,
  membersBounded,
  membersFactsDimensions,
  membersGroupDimensions,
  membersOrdinalProbeDimensions,
  membersSnapshotScopeDimensions,
  membersSource,
  membersTerminalDimensions,
  meterMembersDefinition,
  withMembersWorkBudget,
} from './scope-members-work-cost.ts';
import { zeroScopeWork, type ScopeWork } from './scope-execution.ts';
import type { ScopeEvaluationProgress } from './scope-source.ts';

export type MembersWorkInput = Readonly<{
  pool: Pool;
  access: Access;
  deadline: number;
  work: MembersPreparationWorkContext;
}>;
export type MembersSnapshot = Readonly<{
  native: MembersPreparationWorkDefinition;
  source: Awaited<ReturnType<typeof readCollectionSourceWorkState>>;
  observation: IdentityScopeObservation;
  ownerFence: string | null;
}>;
type RawKey = { original: string; driver: number; fact: string };
type Group = { keys: RawKey[]; complete: boolean };
export type MembersExecution = {
  input: MembersWorkInput;
  snapshot: MembersSnapshot;
  admission: CollectionMemberAdmission;
  groups: Map<string, Group>;
};
const unavailable = () => new ProblemError('semantic_not_ready');

/** Transfer one remaining original allowance. Failures expose the cumulative Search receipt too. */
export async function runMembersWork<T>(
  input: MembersWorkInput,
  work: ScopeWork,
  body: (native: NativeCollectionWork) => Promise<T>,
): Promise<T> {
  const native = new NativeCollectionWork(work.remaining(), input.deadline);
  try {
    return await withMembersWorkBudget(native, () => body(native));
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  } finally {
    work.native(native.receipt());
  }
}

async function query<R extends QueryResultRow>(
  input: MembersWorkInput,
  work: NativeCollectionWork,
  sql: string,
  values: unknown[],
  bound: WorkDimensions,
): Promise<R[]> {
  if (!hasLiveOperationalTransaction(input.work.tx)) throw unavailable();
  return membersBounded(work, { ...zeroScopeWork(), ...bound }, async () => {
    const config = { text: sql, values, query_timeout: Math.max(1, input.deadline - Date.now()) };
    return (await input.work.tx.query<R>(config)).rows;
  });
}

/** The native source reader checks the complete canonical basis, metadata and immutable definition.
 * Read the actual capture/revision at that exact source fence; Collection observations are never cast to Scope70. */
export async function readMembersSnapshot(
  input: MembersWorkInput,
  work: NativeCollectionWork,
): Promise<MembersSnapshot> {
  const native = structuredClone(await readMembersPreparationWorkDefinition(input.work, input));
  const source = await membersSource(work, 1, (allowance) =>
    readCollectionSourceWorkState(input.pool, input.work, { ...input, allowance }),
  );
  if (!isDeepStrictEqual(source.definition, native)) throw unavailable();
  const scopeValues = [
    native.sourceIdentity.route,
    native.sourceIdentity.collectionId,
    source.basis.sourceFence,
    source.generation,
  ];
  const [scope] = await query<{ identity: unknown; capture: string; revision: string }>(
    input,
    work,
    MEMBERS_SEARCH_QUERY_SQL.snapshotScope,
    scopeValues,
    membersSnapshotScopeDimensions(scopeValues),
  );
  if (
    !scope?.capture ||
    !/^(0|[1-9][0-9]*)$/.test(scope.revision) ||
    !isDeepStrictEqual(scope.identity, native.sourceIdentity) ||
    createHash('sha256')
      .update(JSON.stringify([scope.capture, scope.revision]))
      .digest('hex') !== native.observation.basis.identity.digest
  )
    throw unavailable();
  const observation: IdentityScopeObservation = {
    key: { source: { kind: 'library', identity: native.sourceIdentity }, scopeId: 'collection-source' },
    captureId: scope.capture,
    committedRevision: BigInt(scope.revision),
  };
  await revalidateMembersObservation(input, observation, work);
  const owner = await membersBounded(work, MEMBERS_SNAPSHOT_OWNER_FENCE_DIMENSIONS, () =>
    fenceQuery.run(input.work.tx, { route: input.work.locator.route, account_id: input.work.locator.ownerAccountId }),
  );
  // Native owner predicates need the writer's real fence, including when their answer is absence.
  if (!owner) throw new ProblemError('dependency_unavailable');
  return { native, source, observation, ownerFence: owner.generation };
}

export async function revalidateMembersObservation(
  input: MembersWorkInput,
  observation: IdentityScopeObservation,
  work: NativeCollectionWork,
): Promise<void> {
  const result = await membersBounded(
    work,
    { identityMetadataRows: 32, nativeRows: 32, nativePoints: 4, statements: 1, emptySeeks: 1, bytes: 32768 },
    () =>
      createIdentityScopedObservations(input.pool).revalidate({
        key: observation.key,
        expected: observation,
        tx: input.work.tx,
        deadline: input.deadline,
      }),
  );
  if (result.status !== 'current' || !isDeepStrictEqual(result.observation, observation)) throw unavailable();
}

export function sameMembersSnapshot(expected: MembersSnapshot, actual: MembersSnapshot): boolean {
  const value = (snapshot: MembersSnapshot) => {
    const { work: _receipt, ...source } = snapshot.source;
    return { ...snapshot, source };
  };
  return isDeepStrictEqual(value(expected), value(actual));
}

export async function membersRelease(input: MembersWorkInput, work: NativeCollectionWork, digest: string) {
  return withMembersWorkBudget(work, () =>
    meterMembersDefinition(input.work.tx, () => readRelease(input.work.tx, digest, { composed: false })),
  );
}

export function membersExecution(
  input: MembersWorkInput,
  snapshot: MembersSnapshot,
  plan: CurrentOwnerFilterPlan,
  queryDigest: string,
  release: Release,
): MembersExecution {
  const definition = snapshot.native.definition;
  return {
    input,
    snapshot,
    groups: new Map(),
    admission: {
      filter: definition.filter,
      sort: 'id',
      plan,
      releaseDigest: definition.release.digest,
      release,
      queryDigest,
      owner: leafProvider(input.work.locator.ownerAccountId, definition.filter, input.deadline),
    },
  };
}

/** Indexed local directory of the actual READY capture. No foreign identity home is opened here.
 * Its native enrollment recorded the original's real control group; Scope70 checks fence changes. */
export async function membersTerminal(execution: MembersExecution, original: string, work: NativeCollectionWork) {
  const { input, snapshot } = execution;
  const address = identityScopeAddress(snapshot.observation.key);
  const terminalValues = [
    address.partition,
    address.source,
    address.scope,
    snapshot.observation.captureId,
    snapshot.observation.committedRevision.toString(),
    original,
  ];
  const [row] = await query<{
    terminal: string;
    ticket: { original?: string; capture_id?: string; registration?: string };
    registration: string;
  }>(
    input,
    work,
    MEMBERS_SEARCH_QUERY_SQL.terminal,
    terminalValues,
    membersTerminalDimensions(terminalValues),
  );
  if (
    !row ||
    routeOf(row.terminal) === null ||
    row.ticket.original !== original ||
    row.ticket.capture_id !== snapshot.observation.captureId ||
    row.ticket.registration !== row.registration
  )
    return null;
  return row.terminal;
}

/** Retain raw keys only. An incomplete window cannot prove absence or advance a caller's subject frontier. */
async function group(execution: MembersExecution, subject: string, work: NativeCollectionWork): Promise<Group> {
  const saved = execution.groups.get(subject) ?? { keys: [], complete: false };
  if (saved.complete || saved.keys.length >= 100) return saved;
  const limit = Math.min(100, 101 - saved.keys.length, work.available('candidateKeys'), work.available('witnessKeys'));
  if (limit < 1) return saved;
  const last = saved.keys.at(-1);
  const groupValues = [
    execution.input.work.locator.route,
    execution.input.work.locator.collectionId,
    execution.snapshot.source.generation,
    subject,
    last?.original ?? null,
    last?.fact ?? null,
    limit,
  ];
  const rows = await query<RawKey>(
    execution.input,
    work,
    MEMBERS_SEARCH_QUERY_SQL.group,
    groupValues,
    membersGroupDimensions(groupValues, limit),
  );
  if (rows.some((row) => row.driver !== 0 || routeOf(row.original) === null || routeOf(row.fact) === null))
    throw unavailable();
  saved.keys.push(...rows);
  saved.complete = rows.length < limit;
  execution.groups.set(subject, saved);
  return saved;
}

export function membersProgress(execution: MembersExecution, subject: string, basis: string): ScopeEvaluationProgress {
  return {
    subject,
    basis,
    leafOrdinal: 0,
    phase: 'selection',
    valueOrdinal: 0,
    after: String(execution.groups.get(subject)?.keys.length ?? 0),
  };
}

async function acceptedRelease(execution: MembersExecution, digest: string, work: NativeCollectionWork) {
  // Immutable cache hits still verify existence on this transaction. Only a real body projection
  // performs its size admission; a warm pin must not pay a fictitious compressed-body read.
  return membersRelease(execution.input, work, digest);
}

async function closure(
  execution: MembersExecution,
  subject: string,
  work: NativeCollectionWork,
): Promise<OwnerFilterCandidateClosure | null> {
  const raw = await group(execution, subject, work);
  if (!raw.complete || !raw.keys.length || raw.keys.length > 100) return null;
  const ids = [...new Set([subject, ...raw.keys.map((key) => key.original)])];
  if (ids.length + raw.keys.length > 100) return null;
  const originals: { subjectId: string; facts: OwnerFilterFactLocator[] }[] = [];
  const releases = new Map<string, Release>();
  let remaining = 100 - ids.length;
  for (const original of ids) {
    // The terminal may not itself be a stored occurrence. Every stored original must have the real capture mapping.
    if (original !== subject && (await membersTerminal(execution, original, work)) !== subject) throw unavailable();
    const limit = Math.min(remaining, work.available('candidateKeys'), work.available('witnessKeys'));
    if (limit < 1) return null;
    const rows = await membersBounded(work, membersFactsDimensions(limit), () =>
      factsQuery.run(execution.input.work.tx, {
        route: execution.input.work.locator.route,
        account_id: execution.input.work.locator.ownerAccountId,
        subject_id: original,
        limit,
      }),
    );
    if (rows.length === limit || rows.some((row) => row.driver === 0)) return null;
    const facts: OwnerFilterFactLocator[] = [];
    for (const row of rows) {
      let locator: OwnerFilterFactLocator;
      switch (row.driver) {
        case 1:
          locator = { kind: 'entry', subjectId: original };
          break;
        case 2:
          if (!row.labelId) return null;
          locator = { kind: 'label', subjectId: original, labelId: row.labelId };
          break;
        case 3:
          if (!row.factId || routeOf(row.factId) === null) return null;
          locator = { kind: 'session', subjectId: original, sessionId: row.factId };
          break;
        case 4:
          if (!row.factId || routeOf(row.factId) === null) return null;
          locator = { kind: 'holding', subjectId: original, copyId: row.factId };
          break;
        default:
          throw unavailable();
      }
      facts.push(locator);
      const wantsPin = execution.admission.plan!.leaves.some(
        (leaf) =>
          leaf.kind === 'owner' &&
          (('state' in leaf.leaf.owner && locator.kind === 'entry') ||
            ('session' in leaf.leaf.owner && locator.kind === 'session') ||
            ('holding' in leaf.leaf.owner && locator.kind === 'holding')),
      );
      if (wantsPin) {
        const fact = await execution.admission.owner!.read(execution.input.work.tx, locator, work);
        if (fact && 'pin' in fact && fact.pin && !releases.has(fact.pin.releaseDigest)) {
          const release = await acceptedRelease(execution, fact.pin.releaseDigest, work);
          if (!release) return null;
          releases.set(fact.pin.releaseDigest, release);
        }
      }
    }
    remaining -= facts.length;
    originals.push({ subjectId: original, facts });
  }
  return { subjectId: subject, originals, releases, catalogue: new Map() };
}

/** Same Library matcher, native owner point provider and Boolean plan as ordinary Members. */
export async function evaluateMembersSubject(execution: MembersExecution, subject: string, work: ScopeWork) {
  return runMembersWork(execution.input, work, async (native) => {
    const first = await closure(execution, subject, native);
    if (!first) return 'not_proven' as const;
    const value = await readOwnerFilterCandidate(execution.input.work.tx, execution.admission, first, native);
    // Repeat native facts, release pins and closure before using either a match or a rejection.
    const final = await closure(execution, subject, native);
    if (
      !final ||
      !isDeepStrictEqual(first, final) ||
      (await readOwnerFilterCandidate(execution.input.work.tx, execution.admission, final, native)) !== value
    )
      return 'not_proven' as const;
    return value;
  });
}

/** DISTINCT uses the earliest live native occurrence across the complete canonical group, independent of
 * the caller's output frontier. It therefore needs neither a pooled retained Search table nor an unbounded seen set. */
export async function firstMembersOrdinal(
  execution: MembersExecution,
  subject: string,
  work: NativeCollectionWork,
): Promise<NativeOrdinalKey | null> {
  const raw = await group(execution, subject, work);
  if (!raw.complete || !raw.keys.length || raw.keys.length > 100) return null;
  let first: NativeOrdinalKey | null = null;
  for (const key of raw.keys) {
    const ordinalValues = [
      execution.input.work.locator.route,
      execution.input.work.locator.collectionId,
      key.fact,
    ];
    const [row] = await query<{ memberId: string; ordinalKey: string; subject: string }>(
      execution.input,
      work,
      MEMBERS_SEARCH_QUERY_SQL.ordinalProbe,
      ordinalValues,
      membersOrdinalProbeDimensions(ordinalValues),
    );
    if (!row) continue;
    if (row.subject !== key.original) throw unavailable();
    if (
      !first ||
      row.ordinalKey < first.ordinalKey ||
      (row.ordinalKey === first.ordinalKey && row.memberId < first.memberId)
    )
      first = { ordinalKey: row.ordinalKey, memberId: row.memberId };
  }
  return first;
}
