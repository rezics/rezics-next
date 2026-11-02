import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import type { OperationalTransaction } from '../command/operational.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import type { IdentityScopedObservations, IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { createNativeLibrarySourceCustody, type NativeLibrarySourceCustody } from './native-source-custody.ts';
import {
  createCollectionSource,
  type CollectionSource,
  type CollectionAliasProgress,
  type CollectionSourceObservation,
  type CollectionSourceContext,
  type PreparedCollectionSource,
  type WorkAllowance,
  type WorkDimensions,
  type WorkReceipt,
} from './collection-source.ts';
import { createCollectionKindPreparation } from './collection-kind-preparation.ts';
import type { KindAudienceAccess } from '../access/kind-audience.ts';
import type { WorkClient } from '../work/client.ts';
import type { KindConsentConsumer, KindConsentReference } from '@rezics/auth-contract';

/** Presentation arithmetic only. These values are not Source, identity or disclosure evidence. */
export type AutomaticCollectionKind =
  | { presentationKind: string; presentationKindSource: 'members' }
  | { presentationKind: null; presentationKindSource: 'empty' | 'pending' };

export type CollectionKind =
  | { presentationKind: null; presentationKindSource: 'mixed' }
  | { presentationKind: string; presentationKindSource: 'owner' };

/** A declaration's native predicate result for one canonical item. Unknown is
 * retained explicitly: it can only be ignored when a proven higher-ranked
 * declaration already wins that item. */
export type ConfiguredKindMatch = Readonly<{
  id: string;
  eligible: boolean;
  precedence: number;
  result: 'match' | 'no-match' | 'unknown';
}>;
export type ConfiguredKindVote = Readonly<{ subjectId: string; matches: readonly ConfiguredKindMatch[] }>;
export type ConfiguredKindReduction =
  | Readonly<{ status: 'selected'; kindId: string }>
  | Readonly<{ status: 'empty' }>
  | Readonly<{ status: 'unavailable' }>;

/** Apply the versioned Kind policy after native evidence has classified each
 * declaration for every unique canonical item. Each item casts at most one
 * vote. A possibly winning unknown predicate makes the whole reduction
 * unavailable instead of silently falling back to a lower-ranked result. */
export function reduceConfiguredCollectionKinds(votes: readonly ConfiguredKindVote[]): ConfiguredKindReduction {
  const seenSubjects = new Set<string>();
  const counts = new Map<string, number>();
  for (const vote of votes) {
    if (!vote.subjectId || vote.subjectId.includes('\0') || seenSubjects.has(vote.subjectId))
      return { status: 'unavailable' };
    seenSubjects.add(vote.subjectId);
    let bestMatch: ConfiguredKindMatch | undefined;
    let bestUnknown: ConfiguredKindMatch | undefined;
    const seenKinds = new Set<string>();
    for (const candidate of vote.matches) {
      if (
        !candidate.id ||
        candidate.id.includes('\0') ||
        seenKinds.has(candidate.id) ||
        !Number.isInteger(candidate.precedence) ||
        candidate.precedence < -2_147_483_648 ||
        candidate.precedence > 2_147_483_647 ||
        !['match', 'no-match', 'unknown'].includes(candidate.result)
      )
        return { status: 'unavailable' };
      seenKinds.add(candidate.id);
      if (!candidate.eligible || candidate.result === 'no-match') continue;
      const current = candidate.result === 'match' ? bestMatch : bestUnknown;
      if (
        !current ||
        candidate.precedence > current.precedence ||
        (candidate.precedence === current.precedence && candidate.id < current.id)
      ) {
        if (candidate.result === 'match') bestMatch = candidate;
        else bestUnknown = candidate;
      }
    }
    if (
      bestUnknown &&
      (!bestMatch ||
        bestUnknown.precedence > bestMatch.precedence ||
        (bestUnknown.precedence === bestMatch.precedence && bestUnknown.id < bestMatch.id))
    )
      return { status: 'unavailable' };
    if (bestMatch) counts.set(bestMatch.id, (counts.get(bestMatch.id) ?? 0) + 1);
  }
  let winner: string | undefined;
  let maximum = 0;
  for (const [id, count] of counts) {
    if (count > maximum || (count === maximum && winner !== undefined && id < winner)) {
      winner = id;
      maximum = count;
    }
  }
  return winner === undefined ? { status: 'empty' } : { status: 'selected', kindId: winner };
}

/** Unset presentation uses each member's Type hints; a stored owner choice needs no member evidence. */
export function collectionKind(override: string | null): CollectionKind {
  return override === null
    ? { presentationKind: null, presentationKindSource: 'mixed' }
    : { presentationKind: override, presentationKindSource: 'owner' };
}

/**
 * Repair-side reduction of COMPLETE current canonical visible support, keyed by terminal subject ID.
 * The native producer must establish completeness, currentness and canonical identity before using this result.
 * A missing observation must never be passed as an empty map. This function does not run on metadata GET.
 */
export function dominantCollectionKind(canonicalTypes: ReadonlyMap<string, string>): AutomaticCollectionKind {
  const counts = new Map<string, number>();
  let winner: string | null = null;
  let maximum = 0;
  for (const type of canonicalTypes.values()) {
    const count = (counts.get(type) ?? 0) + 1;
    counts.set(type, count);
    if (count > maximum || (count === maximum && (winner === null || type < winner))) {
      winner = type;
      maximum = count;
    }
  }
  return winner === null
    ? { presentationKind: null, presentationKindSource: 'empty' }
    : { presentationKind: winner, presentationKindSource: 'members' };
}

export const COLLECTION_KIND_RAW_LIMIT = 100;
export const COLLECTION_KIND_BYTE_LIMIT = 4096;
export const pendingCollectionKind = (): AutomaticCollectionKind => ({
  presentationKind: null,
  presentationKindSource: 'pending',
});

/** Opaque native retained observation, NOT a cached permission, invented epoch or serialized Actor. */
export type CollectionKindCapture = Readonly<{
  collectionId: string;
  accountId: string;
  audience: string;
  sourceGeneration: string;
  token: string;
  /** Auth enrollment lookup plus the exact Source generation; never ordinary authorization. */
  consent?: Readonly<{
    reference: KindConsentReference;
    consumer: KindConsentConsumer;
    captureGeneration: string;
    catalogueRoot: string;
  }>;
}>;
export type CollectionKindVote = Readonly<{ subjectId: string; typeId: string }>;
type NativeUnavailable = Readonly<{ status: 'unavailable'; reason: 'source_unready' }>;
export type CollectionKindPage = Readonly<{
  status: 'progress' | 'complete';
  afterSubject: string | null;
  /** Native retained unfinished-group locator, not a public cursor or a permission. */
  frontier: string | null;
  /** Raw examined work includes excluded/duplicate originals, not just votes. */
  examined: number;
  bytes: number;
  votes: readonly CollectionKindVote[];
}>;

/**
 * Owned integration boundary, not a new Source/matcher/permission API. The native binding must retain COMPLETE
 * original+terminal Type/disclosure/selective (including excluded/order) dependencies in existing custody.
 * A capture is audience-specific. Work never stores an Actor or mints a worker principal from an account ID.
 * Revalidation resolves retained native records, never trusts this locator or an old custody hold as fresh authority.
 */
export interface CollectionKindNative {
  /** Ephemeral original entry only; never part of a DBOS locator or restored Actor. */
  prepareInput?: KindAudienceAccess['resolveInput'];
  prepare(input: {
    collectionId: string;
    accountId: string;
    audience: string | null;
    deadline: number;
  }): Promise<NativeUnavailable | { status: 'prepared'; capture: CollectionKindCapture }>;
  page(input: {
    capture: CollectionKindCapture;
    afterSubject: string | null;
    frontier: string | null;
    inputLimit: number;
    byteLimit: number;
    deadline: number;
  }): Promise<NativeUnavailable | CollectionKindPage>;
  select(input: {
    collectionId: string;
    actor: Actor;
    deadline: number;
  }): Promise<NativeUnavailable | { status: 'selected'; audience: string }>;
  /** Includes fresh Collection authority and current grant after all foreign waits, as well as Type dependencies. */
  revalidate(input: {
    capture: CollectionKindCapture;
    actor?: Actor;
    deadline: number;
  }): Promise<NativeUnavailable | { status: 'current' | 'stale' }>;
  /** Same-home adoption of already retained native custody, with current account-T fencing and no foreign checkout.
   * OperationalTransaction is never cast to CommandTransaction to manufacture a native readAndHold call. */
  adopt(input: {
    capture: CollectionKindCapture;
    tx: OperationalTransaction;
    deadline: number;
  }): Promise<NativeUnavailable | { status: 'adopted' | 'stale' }>;
  /** Resolve exact native custody, release only this retired observation, never its business Source. */
  retire(input: {
    collectionId: string;
    accountId: string;
    token: string;
    deadline: number;
  }): Promise<NativeUnavailable | { status: 'retired' }>;
}

export type CollectionKindSourceBindings = Readonly<{
  source(access: Access): CollectionSource;
  identity: IdentityScopedObservations;
  custody: NativeLibrarySourceCustody;
  dependencies: CollectionKindPreparationDependencies;
}>;

export type CollectionKindPreparationDependencies = Readonly<{
  pool: Pool;
  clock?: KernelClock;
  access?: Access;
  routeKey?: Uint8Array;
  workClient?: WorkClient;
}>;

/** Real producer factories. Missing service configuration never becomes a worker principal. */
export function collectionKindSourceBindings(
  dependencies: CollectionKindPreparationDependencies,
): CollectionKindSourceBindings {
  // Only native reader handles are retained; this contains no Actor, permission or observation verdict.
  const readers = new WeakMap<Access, CollectionSource>();
  return {
    source(access) {
      let reader = readers.get(access);
      if (!reader) {
        reader = createCollectionSource({ ...dependencies, access });
        readers.set(access, reader);
      }
      return reader;
    },
    identity: createIdentityScopedObservations(dependencies.pool),
    custody: createNativeLibrarySourceCustody(dependencies),
    dependencies,
  };
}

/** Native preparation owner; Source traversal remains in readCollectionKindSourcePage. */
export type CollectionKindPreparation = Omit<CollectionKindNative, 'page'> & {
  resume(input: { capture: CollectionKindCapture; deadline: number }): Promise<
    | NativeUnavailable
    | {
        status: 'prepared';
        step: Omit<CollectionKindSourceStep, 'collection' | 'afterSubject' | 'progress'>;
        access: Access;
        identity: IdentityScopeObservation;
      }
  >;
};

export function createCollectionKindNative(
  sources: CollectionKindSourceBindings,
  preparation: CollectionKindPreparation = createCollectionKindPreparation(sources),
): CollectionKindNative {
  return {
    ...(sources.dependencies.access?.kindAudience
      ? { prepareInput: sources.dependencies.access.kindAudience.resolveInput }
      : {}),
    prepare: (input) => preparation.prepare(input),
    select: (input) => preparation.select(input),
    revalidate: (input) => preparation.revalidate(input),
    adopt: (input) => preparation.adopt(input),
    retire: (input) => preparation.retire(input),
    async page(input) {
      const unavailable: NativeUnavailable = { status: 'unavailable', reason: 'source_unready' };
      if (input.inputLimit !== COLLECTION_KIND_RAW_LIMIT || input.byteLimit !== COLLECTION_KIND_BYTE_LIMIT)
        return unavailable;
      const resumed = await preparation.resume({ capture: input.capture, deadline: input.deadline });
      if (resumed.status !== 'prepared') return resumed;
      if (
        resumed.step.source.observation.collectionId !== input.capture.collectionId ||
        resumed.step.source.observation.route !== routeOf(input.capture.collectionId)
      )
        return unavailable;
      const check = () =>
        sources.identity.revalidate({
          key: resumed.identity.key,
          expected: resumed.identity,
          deadline: input.deadline,
        });
      if ((await check()).status !== 'current') return unavailable;
      const progress = decodeCollectionKindProgress(input.frontier);
      const result = await readCollectionKindSourcePage({
        ...resumed.step,
        deadline: input.deadline,
        collection: sources.source(resumed.access),
        afterSubject: input.afterSubject,
        ...(progress === null ? {} : { progress }),
      });
      if ((await check()).status !== 'current') return unavailable;
      if (result.status === 'settled') return result.page;
      // An owner-repair wait with no raw progress cannot become an empty-loop continuation.
      if (result.progress === null && result.afterSubject === input.afterSubject) return unavailable;
      const frontier = result.progress === null ? null : JSON.stringify(result.progress);
      const bytes = new TextEncoder().encode(JSON.stringify({ frontier, votes: result.votes })).byteLength;
      if (bytes > input.byteLimit) return unavailable;
      return {
        status: 'progress',
        frontier,
        afterSubject: result.afterSubject,
        votes: result.votes,
        examined: result.work.used.candidateKeys,
        bytes,
      };
    },
  };
}

/** Private durable Source progress only; exact structural validation never creates identity or membership proof. */
function decodeCollectionKindProgress(frontier: string | null): CollectionAliasProgress | null {
  if (frontier === null) return null;
  const value: unknown = JSON.parse(frontier);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('subjectId' in value) ||
    typeof value.subjectId !== 'string' ||
    routeOf(value.subjectId) === null ||
    !('basisDigest' in value) ||
    typeof value.basisDigest !== 'string' ||
    !value.basisDigest ||
    !('aliasAfter' in value) ||
    (value.aliasAfter !== null && (typeof value.aliasAfter !== 'string' || routeOf(value.aliasAfter) === null)) ||
    !('sourceAfter' in value) ||
    !sourceAfter(value.sourceAfter)
  )
    throw new ProblemError('dependency_unavailable');
  return {
    subjectId: value.subjectId,
    basisDigest: value.basisDigest,
    aliasAfter: value.aliasAfter,
    sourceAfter: value.sourceAfter,
  };
}
function sourceAfter(value: unknown): value is CollectionAliasProgress['sourceAfter'] {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^1:[0-5]:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(value)) return false;
  return routeOf(value.slice(4, 40)) !== null && routeOf(value.slice(41)) !== null;
}

/** Shared allowance settlement for actual Source calls; no reset/refill between prefix and membership probes. */
class KindSourceWork {
  private readonly used: Record<keyof WorkDimensions, number> = {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
  constructor(private readonly allowance: WorkAllowance) {}
  remaining(): WorkAllowance {
    const remaining = { ...this.allowance.remaining };
    for (const axis of Object.keys(this.used) as (keyof WorkDimensions)[])
      remaining[axis] = this.allowance.remaining[axis] - this.used[axis];
    return { reservationId: this.allowance.reservationId, remaining };
  }
  settle(receipt: WorkReceipt) {
    if (receipt.reservationId !== this.allowance.reservationId) throw new ProblemError('dependency_unavailable');
    for (const axis of Object.keys(this.used) as (keyof WorkDimensions)[]) {
      const amount = receipt.used[axis];
      if (!Number.isSafeInteger(amount) || amount < 0 || amount > this.allowance.remaining[axis] - this.used[axis])
        throw new ProblemError('dependency_unavailable');
      this.used[axis] += amount;
    }
  }
  receipt(): WorkReceipt {
    return { reservationId: this.allowance.reservationId, used: { ...this.used } };
  }
}

/**
 * Owned Source traversal for an admitted native repair step. Type projection is supplied by the native capture
 * binding with charged work, not a second Semantic reader. Never called by metadata GET. The same fresh opaque T,
 * actor and deadline bind prefix, original+terminal membership and Type projection. EOF is canonical Source EOF,
 * never raw EOF, a page limit, preview completion or count zero. No group is skipped when native proof is pending.
 */
export type CollectionKindSourceStep = Extract<CollectionSourceContext, { work?: never }> & {
  source: PreparedCollectionSource;
  collection: CollectionSource;
  allowance: WorkAllowance;
  afterSubject: string | null;
  progress?: CollectionAliasProgress;
  readType(request: {
    subjectId: string;
    at: AuthoritativeTime;
    actor: Actor;
    deadline: number;
    allowance: WorkAllowance;
  }): Promise<{ status: 'current'; typeId: string; work: WorkReceipt } | { status: 'unavailable'; work: WorkReceipt }>;
};

export async function readCollectionKindSourcePage(input: CollectionKindSourceStep): Promise<
  | { status: 'settled'; page: CollectionKindPage; observation: CollectionSourceObservation; work: WorkReceipt }
  | {
      status: 'pending';
      afterSubject: string | null;
      pendingSubject: string;
      progress: CollectionAliasProgress | null;
      votes: readonly CollectionKindVote[];
      observation: CollectionSourceObservation;
      work: WorkReceipt;
    }
> {
  if (
    input.progress &&
    (input.progress.basisDigest !== input.source.observation.basis.digest ||
      (input.afterSubject !== null && input.progress.subjectId <= input.afterSubject))
  )
    throw new ProblemError('dependency_unavailable');
  const work = new KindSourceWork({
    ...input.allowance,
    remaining: {
      ...input.allowance.remaining,
      candidateKeys: Math.min(COLLECTION_KIND_RAW_LIMIT, input.allowance.remaining.candidateKeys),
      bytes: Math.min(COLLECTION_KIND_BYTE_LIMIT, input.allowance.remaining.bytes),
    },
  });
  const prefixAllowance = work.remaining();
  const prefix = await input.collection.prefix({
    ...input,
    allowance: {
      ...prefixAllowance,
      remaining: {
        ...prefixAllowance.remaining,
        candidateKeys: Math.floor(prefixAllowance.remaining.candidateKeys / 3),
      },
    },
    afterSubjectId: input.afterSubject,
  });
  work.settle(prefix.work);
  if (
    prefix.observation.basis.digest !== input.source.observation.basis.digest ||
    prefix.observation.incarnation !== input.source.observation.incarnation ||
    prefix.observation.stamp.epoch !== input.source.observation.stamp.epoch ||
    prefix.observation.stamp.position !== input.source.observation.stamp.position ||
    prefix.candidates.length > COLLECTION_KIND_RAW_LIMIT
  )
    throw new ProblemError('dependency_unavailable');
  if (input.progress && prefix.candidates[0]?.subjectId !== input.progress.subjectId)
    throw new ProblemError('dependency_unavailable');
  const votes: CollectionKindVote[] = [];
  let previous = input.afterSubject;
  let settled = input.afterSubject;
  for (const candidate of prefix.candidates) {
    if (routeOf(candidate.subjectId) === null || (previous !== null && candidate.subjectId <= previous))
      throw new ProblemError('dependency_unavailable');
    previous = candidate.subjectId;
    const membership = await input.collection.containsSubject({
      ...input,
      subjectId: candidate.subjectId,
      allowance: work.remaining(),
      positiveEvidence: candidate.evidence,
      ...(input.progress?.subjectId === candidate.subjectId ? { progress: input.progress } : {}),
    });
    work.settle(membership.work);
    if (
      membership.subjectId !== candidate.subjectId ||
      membership.observation.basis.digest !== prefix.observation.basis.digest ||
      membership.observation.incarnation !== prefix.observation.incarnation ||
      membership.observation.stamp.epoch !== prefix.observation.stamp.epoch ||
      membership.observation.stamp.position !== prefix.observation.stamp.position
    )
      throw new ProblemError('dependency_unavailable');
    if (membership.result === 'not_proven')
      return {
        status: 'pending',
        afterSubject: settled,
        pendingSubject: candidate.subjectId,
        progress: membership.progress,
        votes,
        observation: prefix.observation,
        work: work.receipt(),
      };
    if (!membership.result) {
      settled = candidate.subjectId;
      continue;
    }
    const type = await input.readType({
      subjectId: candidate.subjectId,
      at: input.at,
      actor: input.actor,
      deadline: input.deadline,
      allowance: work.remaining(),
    });
    work.settle(type.work);
    if (type.status !== 'current') throw new ProblemError('dependency_unavailable');
    votes.push({ subjectId: candidate.subjectId, typeId: type.typeId });
    settled = candidate.subjectId;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(votes)).byteLength;
  // The binding admits these bytes BEFORE native dispatch; this also rejects a broken producer boundary.
  if (bytes > COLLECTION_KIND_BYTE_LIMIT || work.receipt().used.candidateKeys > COLLECTION_KIND_RAW_LIMIT)
    throw new ProblemError('dependency_unavailable');
  if (
    !prefix.exhausted &&
    (prefix.coveredThrough === null || (input.afterSubject !== null && prefix.coveredThrough <= input.afterSubject))
  )
    throw new ProblemError('dependency_unavailable');
  return {
    status: 'settled',
    page: {
      frontier: null,
      status: prefix.exhausted ? 'complete' : 'progress',
      afterSubject: prefix.coveredThrough,
      examined: work.receipt().used.candidateKeys,
      bytes,
      votes,
    },
    observation: prefix.observation,
    work: work.receipt(),
  };
}

export function validateCollectionKindPage(
  page: CollectionKindPage,
  after: string | null,
  frontier: string | null = null,
): void {
  if (
    !Number.isSafeInteger(page.examined) ||
    page.examined < 0 ||
    page.examined > COLLECTION_KIND_RAW_LIMIT ||
    !Number.isSafeInteger(page.bytes) ||
    page.bytes < 0 ||
    page.bytes > COLLECTION_KIND_BYTE_LIMIT ||
    page.votes.length > page.examined ||
    new TextEncoder().encode(JSON.stringify(page.votes)).byteLength > page.bytes ||
    (page.afterSubject !== null && routeOf(page.afterSubject) === null) ||
    (page.frontier !== null &&
      (!page.frontier || new TextEncoder().encode(page.frontier).byteLength > COLLECTION_KIND_BYTE_LIMIT)) ||
    (page.status === 'complete' && page.frontier !== null) ||
    (page.votes.length > 0 && page.afterSubject === null) ||
    (page.status === 'progress' && page.afterSubject === after && page.frontier === frontier) ||
    (page.afterSubject !== null && after !== null && page.afterSubject < after) ||
    (page.afterSubject === null && after !== null)
  )
    throw new ProblemError('dependency_unavailable');
  let previous = after;
  for (const vote of page.votes) {
    if (
      routeOf(vote.subjectId) === null ||
      !vote.typeId ||
      vote.typeId.includes('\0') ||
      (previous !== null && vote.subjectId <= previous) ||
      (page.afterSubject !== null && vote.subjectId > page.afterSubject)
    )
      throw new ProblemError('dependency_unavailable');
    previous = vote.subjectId;
  }
}
