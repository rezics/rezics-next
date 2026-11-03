/** The sole Collection Source ABI and native runtime composition.
 * Ordinary owner-working calls use the registered server query context, never a caller purpose flag.
 * A selected public output and its curator's private working capture remain separate authorities.
 */
import type { Pool } from 'pg';
import type { KernelClock } from '../clock.ts';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, Actor } from '../request/access.ts';
import type { CollectionMemberRow, CollectionRow } from './collection-model.ts';
import type { ListingStamp } from './listing-freshness-contract.ts';
import type { RawOrdinalCollectionPrefix, ReadRawOrdinalCollectionPrefix } from './collection-source-order.ts';
import type { ScopeWorkContext } from '../search/scope-work-context.ts';
import { isDeepStrictEqual } from 'node:util';
import {
  readCollectionSourceWorkState,
  readCollectionSourceWorkGroup,
  seekCollectionSourceWorkGroup,
  type CollectionSourceWorkState,
} from './collection-source-work-native.ts';

/** Shared caller-ledger dimensions. These types allocate no budget and implement no ledger. */
export interface WorkDimensions {
  readonly candidateKeys: number;
  /** Shared Source.rows unit: charged plan-proved row-work upper bound; observed physical rows are measured separately. */
  readonly nativeRows: number;
  /** TWO independently released 4096-home sweeps per full Semantic basis read; not candidate work. */
  readonly identityMetadataRows: number;
  readonly emptySeeks: number;
  readonly nativePoints: number;
  readonly witnessKeys: number;
  readonly statements: number;
  readonly bytes: number;
}

/** Reserved BEFORE dispatch, from the ONE Search/Zone request ledger; all dimensions are finite integers >= 0. */
export interface WorkAllowance {
  readonly reservationId: string;
  readonly remaining: WorkDimensions;
}

/**
 * Every used dimension <= its reservation. `used.nativeRows` sums charged per-operation plan bounds, not observed
 * physical tuples. Failures settle consumed dispatched work through caller instrumentation; unused reservation is
 * never reported as spent.
 */
export interface WorkReceipt {
  readonly reservationId: string;
  readonly used: WorkDimensions;
}

type SourceWorkContext<W extends ScopeWorkContext = ScopeWorkContext> = W extends ScopeWorkContext
  ? Readonly<{ actor?: never; at?: never; work: W }>
  : never;

export type CollectionSourceContext = Readonly<{ deadline: number }> &
  (Readonly<{ actor: Actor; at: AuthoritativeTime; work?: never }> | SourceWorkContext);

/** Exact structural reference assignable from Semantic's IdentityBasis; no second brand or identity authority. */
export type NativeIdentityBasis = Readonly<{ digest: string }>;

export interface CollectionSourceBasis {
  /** Commitment to the ACTUAL native query/meaning/profile/identity/projection compatibility inputs below. */
  readonly digest: string;
  readonly identity: NativeIdentityBasis;
  readonly query: string | null;
  readonly profilePins: readonly string[];
  readonly projection: string | null;
}

/** Authority references only; no query body, facts or permission claims. Private server-side evidence. */
export type CollectionSourceAuthority =
  | { readonly kind: 'curated' }
  | { readonly kind: 'private_builtin'; readonly curatorAccountId: CollectionRow['curatorAccountId'] }
  | { readonly kind: 'activated_output'; readonly generation: string }
  | { readonly kind: 'frozen_output'; readonly generation: string };

export interface CollectionSourceObservation {
  readonly collectionId: CollectionRow['collectionId'];
  readonly route: CollectionRow['route'];
  /** Actual owner incarnation reference, not a newly invented revision counter. */
  readonly incarnation: string;
  readonly revision: CollectionRow['revision'];
  readonly authority: CollectionSourceAuthority;
  /** Native partition observation, NOT structural meaning or a cross-page snapshot. */
  readonly stamp: ListingStamp;
  readonly basis: CollectionSourceBasis;
}

const preparedSource: unique symbol = Symbol('prepared Collection Source');
/** Not an allow capability. Ordinary operations reauthorize actor/source/required subject anchors;
 * mechanical work operations freshly admit the exact native episode and current Source instead.
 */
export interface PreparedCollectionSource {
  readonly [preparedSource]: true;
  readonly observation: CollectionSourceObservation;
}

const nativeEvidence: unique symbol = Symbol('native Collection evidence');
/** Owner evidence reference; no public DTO/debug serialization. Not a fake Search Hit. */
export type CollectionSourceEvidence = { readonly [nativeEvidence]: true };

export interface CanonicalCollectionCandidate {
  /** Ascending canonical subject ID; independent of the stored evidence key(s). */
  readonly subjectId: string;
  /** Real native membership/alias evidence; does not assert current viewer readability. */
  readonly evidence: CollectionSourceEvidence;
}

export interface CanonicalCollectionPrefix {
  readonly kind: 'canonical_subject_prefix';
  readonly candidates: readonly CanonicalCollectionCandidate[];
  /** Every canonical candidate in (afterSubjectId, coveredThrough] is represented, BEFORE filtering. */
  readonly coveredThrough: string | null;
  readonly exhausted: boolean;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

export interface RawStoredCollectionPrefix {
  readonly kind: 'raw_stored_subject_prefix';
  /** Strict stored-ID seeks or quota-bounded raw batches. Never canonical normalization. */
  readonly storedSubjectIds: readonly CollectionMemberRow['subjectId'][];
  readonly storedCoveredThrough: CollectionMemberRow['subjectId'] | null;
  readonly storedExhausted: boolean;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

/** Fixed native drivers: member, entry, label, session, copy, output, respectively. No predicate/profile vector. */
export type CollectionSourceDriverOrdinal = 0 | 1 | 2 | 3 | 4 | 5;
/**
 * Format 1: driver + stored subject UUID + occurrence/fact UUID, exactly 77 ASCII bytes.
 * Validate canonical lowercase UUIDs and decode to the native tuple before seeking. SQL orders real columns
 * (canonical subject, stored subject, driver, fact), NEVER this encoded string. Store owns validation/SQL.
 */
export type CollectionSourceAfter = `1:${CollectionSourceDriverOrdinal}:${string}:${string}`;

/**
 * Trusted internal handoff for ONE unfinished canonical group, reconstructible after shared cursor decode.
 * Never a permission, public DTO, seen set or nested token. See the exact eight-key mapping in the owner contract.
 */
export interface CollectionAliasProgress {
  readonly subjectId: string;
  /** Collection/source incarnation, authority and structural compatibility commitment; compare before any seek. */
  readonly basisDigest: CollectionSourceBasis['digest'];
  /** Last actually SETTLED Semantic original key, never a fetched but unchecked suffix/lookahead. */
  readonly aliasAfter: string | null;
  /** Last settled native source tuple; independent from aliasAfter and retained while its alias is unfinished. */
  readonly sourceAfter: CollectionSourceAfter | null;
}

interface MembershipResultBase {
  readonly subjectId: string;
  readonly observation: CollectionSourceObservation;
  readonly work: WorkReceipt;
}

export type CollectionSubjectMembership = MembershipResultBase &
  (
    | {
        readonly result: true;
        /** Ordinary reads include current original/terminal subject Access. Work results prove structural
         * membership only; the final ordinary reader must reauthorize both anchors before disclosure.
         */
        readonly positiveEvidence: CollectionSourceEvidence;
      }
    | {
        readonly result: false;
        /** Complete negative at the admitted basis; an exact stored-ID miss alone is insufficient. */
        readonly negativeEvidence: CollectionSourceEvidence;
      }
    | {
        readonly result: 'not_proven';
        readonly reason: 'allowance' | 'identity' | 'native_evidence' | 'owner_repair';
        /** Non-null only after real raw keyset progress; null requires owner repair/readiness, not an empty loop. */
        readonly progress: CollectionAliasProgress | null;
      }
  );

export type PrepareCollectionSource = CollectionSourceContext & {
  readonly collectionId: string;
  /** Preparation metadata/Access work also consumes admitted dimensions; no candidates before authorization. */
  readonly allowance: WorkAllowance;
};

export type CollectionSourceCall = CollectionSourceContext & {
  readonly source: PreparedCollectionSource;
  readonly allowance: WorkAllowance;
};

export type ContainsCollectionSubject = CollectionSourceCall & {
  readonly subjectId: string;
  /** Same group/source basis only. Source admission is repeated; ordinary reads also repeat both Subject guards. */
  readonly progress?: CollectionAliasProgress;
  /**
   * Optional previously observed witness key. The owner validates its subject/source/basis binding and treats it
   * as a lookup hint only: current Collection authorization and membership plus original/terminal Access are
   * reread at `at`.
   */
  readonly positiveEvidence?: CollectionSourceEvidence;
};

export interface CollectionSource {
  prepare(input: PrepareCollectionSource): Promise<{ source: PreparedCollectionSource; work: WorkReceipt }>;
  prefix(input: CollectionSourceCall & { readonly afterSubjectId: string | null }): Promise<CanonicalCollectionPrefix>;
  containsSubject(input: ContainsCollectionSubject): Promise<CollectionSubjectMembership>;
  readRawStoredPrefix(
    input: CollectionSourceCall & { readonly afterStoredSubjectId: string | null },
  ): Promise<RawStoredCollectionPrefix>;
  readRawOrdinalPrefix(input: ReadRawOrdinalCollectionPrefix): Promise<RawOrdinalCollectionPrefix>;
}

import { routeOf } from '../route/route.ts';
import {
  readNativeCollectionMetadata,
  authorizeNativeCollectionMetadata,
  readNativeCollectionRawPage,
  readNativeCollectionRawOrdinalPage,
  probeNativeCollectionOriginal,
  type NativeCollectionMetadata,
} from './collection-source-native.ts';
import { CollectionSourceLedger } from './collection-source-work.ts';
import {
  readCanonicalSourceState,
  readCanonicalSourceGroup,
  seekCanonicalSourceGroup,
  nativeSourceFence,
  type CanonicalAllowance,
  type CanonicalBasis,
  type CanonicalWork,
  type CanonicalRawKey,
} from './canonical-source-store.ts';
import { resolveSubject } from './subject-anchor.ts';

const sourceDrivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;
type Prepared = {
  metadata: NativeCollectionMetadata;
  basis: CanonicalBasis;
  generation: string;
  /** Mechanical handles cannot be reused through a different episode or the ordinary reader branch. */
  workBinding?: Readonly<{ kind: ScopeWorkContext['kind']; locator: ScopeWorkContext['locator'] }>;
};
function canonicalAllowance(a: WorkAllowance, rawLimit = 100): CanonicalAllowance {
  return {
    reservationId: a.reservationId,
    rawKeys: Math.min(rawLimit, a.remaining.candidateKeys),
    nativeRows: a.remaining.nativeRows,
    nativePoints: a.remaining.nativePoints,
    emptySeeks: a.remaining.emptySeeks,
    statements: a.remaining.statements,
    bytes: a.remaining.bytes,
    identityMetadataRows: a.remaining.identityMetadataRows,
  };
}
function canonicalReceipt(w: CanonicalWork): WorkReceipt {
  return {
    reservationId: w.reservationId,
    used: {
      candidateKeys: w.candidateKeys + w.aliasKeys + w.duplicateKeys + w.lookaheadKeys + w.internalDriverKeys,
      nativeRows: w.nativeRows,
      nativePoints: w.nativePoints,
      emptySeeks: w.emptySeeks,
      statements: w.statements,
      bytes: w.bytes,
      identityMetadataRows: w.identityMetadataRows,
      witnessKeys: 0,
    },
  };
}
async function useCanonical<T extends { work: CanonicalWork }>(
  l: CollectionSourceLedger,
  operation: () => Promise<T>,
): Promise<T> {
  const settled = await l.run(async () => {
    const result = await operation();
    return { result, work: canonicalReceipt(result.work) };
  });
  return settled.result;
}
function observation(metadata: NativeCollectionMetadata, basis: CanonicalBasis): CollectionSourceObservation {
  return {
    route: metadata.route,
    collectionId: metadata.collectionId,
    incarnation: metadata.incarnation,
    revision: metadata.revision,
    authority: basis.authority,
    stamp: metadata.stamp,
    basis: {
      digest: basis.digest,
      identity: basis.identity,
      query: basis.meaning,
      profilePins: metadata.releaseDigest ? [metadata.releaseDigest] : [],
      projection: null,
    },
  };
}
function decodeSourceAfter(value: CollectionSourceAfter | null): CanonicalRawKey | null {
  if (value === null) return null;
  const parts = /^1:([0-5]):([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(value);
  if (!parts || routeOf(parts[2]!) === null || routeOf(parts[3]!) === null) throw new ProblemError('invalid_cursor');
  const driver = sourceDrivers[Number(parts[1])];
  if (!driver) throw new ProblemError('invalid_cursor');
  return { driver, storedSubjectId: parts[2]!, factId: parts[3]! };
}
function encodeSourceAfter(key: CanonicalRawKey | null): CollectionSourceAfter | null {
  if (!key) return null;
  const driver = sourceDrivers.indexOf(key.driver);
  if (driver === 0 || driver === 1 || driver === 2 || driver === 3 || driver === 4 || driver === 5)
    return `1:${driver}:${key.storedSubjectId}:${key.factId}`;
  throw new ProblemError('invalid_cursor');
}
/** Handles retain provenance, never Access. Every operation reauthorizes current source and identity scope. */
export function createCollectionSource(dependencies: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
}): CollectionSource {
  const prepared = new WeakMap<PreparedCollectionSource, Prepared>();
  async function authorize(
    input: Extract<CollectionSourceContext, { actor: Actor }>,
    metadata: NativeCollectionMetadata,
    l: CollectionSourceLedger,
  ) {
    const allowed = await l.run((allowance) =>
      authorizeNativeCollectionMetadata(dependencies.pool, metadata, {
        ...input,
        access: dependencies.access,
        allowance,
      }),
    );
    if (!allowed.authorized) throw new ProblemError('not_found');
  }
  async function ready(input: CollectionSourceContext, metadata: NativeCollectionMetadata, l: CollectionSourceLedger) {
    // The private canonical producer below cannot certify a public/frozen output capture.
    if (metadata.authority !== 'curated' && metadata.authority !== 'private_builtin')
      throw new ProblemError('dependency_unavailable');
    const result = await useCanonical(l, () =>
      readCanonicalSourceState(dependencies.pool, {
        route: metadata.route,
        collectionId: metadata.collectionId,
        deadline: input.deadline,
        allowance: canonicalAllowance(l.allowance()),
      }),
    );
    if (result.state !== 'ready') throw new ProblemError('dependency_unavailable');
    if (result.basis.sourceFence !== nativeSourceFence(metadata)) throw new ProblemError('stale_cursor');
    return result;
  }
  async function revalidate(
    input: CollectionSourceCall,
    l: CollectionSourceLedger,
    current?: CollectionSourceWorkState,
  ): Promise<Prepared> {
    const saved = prepared.get(input.source);
    if (!saved) throw new ProblemError('invalid_cursor');
    if (input.work) {
      if (
        !current ||
        !isDeepStrictEqual(saved.workBinding, { kind: input.work.kind, locator: input.work.locator }) ||
        saved.generation !== current.generation ||
        !isDeepStrictEqual(saved.basis, current.basis) ||
        !isDeepStrictEqual(input.source.observation, current.observation)
      )
        throw new ProblemError('semantic_not_ready');
      return saved;
    }
    if (saved.workBinding) throw new ProblemError('invalid_cursor');
    await authorize(input, saved.metadata, l);
    const state = await ready(input, saved.metadata, l);
    if (state.basis.digest !== saved.basis.digest || state.generation !== saved.generation)
      throw new ProblemError('stale_cursor');
    return saved;
  }
  async function guarded<T>(
    input: PrepareCollectionSource | CollectionSourceCall,
    body: (l: CollectionSourceLedger, current?: CollectionSourceWorkState) => Promise<T>,
  ) {
    if (!Number.isFinite(input.deadline) || Date.now() >= input.deadline)
      throw new ProblemError('dependency_unavailable');
    const l = new CollectionSourceLedger(input.allowance, input.deadline);
    try {
      if (input.work) {
        const collectionId = 'collectionId' in input ? input.collectionId : input.source.observation.collectionId;
        if (collectionId !== input.work.locator.collectionId) throw new ProblemError('semantic_not_ready');
        const current = await l.run((allowance) =>
          readCollectionSourceWorkState(dependencies.pool, input.work!, {
            access: dependencies.access,
            deadline: input.deadline,
            allowance,
          }),
        );
        if ('source' in input && !isDeepStrictEqual(input.source.observation, current.observation))
          throw new ProblemError('semantic_not_ready');
        const result = await body(l, current);
        // This is a fresh native admission on the SAME live Core client, not a cached getter verdict.
        const final = await l.run((allowance) =>
          readCollectionSourceWorkState(dependencies.pool, input.work!, {
            access: dependencies.access,
            deadline: input.deadline,
            allowance,
          }),
        );
        if (
          !isDeepStrictEqual(current.definition, final.definition) ||
          current.generation !== final.generation ||
          !isDeepStrictEqual(current.basis, final.basis) ||
          !isDeepStrictEqual(current.metadata, final.metadata)
        )
          throw new ProblemError('semantic_not_ready');
        // Final comparisons consume the same reservation and are included in every successful receipt.
        return { ...result, work: l.receipt() };
      }
      return await body(l);
    } catch (error) {
      if (error instanceof Error) Object.defineProperty(error, 'work', { value: l.receipt(), configurable: true });
      throw error;
    }
  }
  async function membership(
    input: ContainsCollectionSubject,
    saved: Prepared,
    l: CollectionSourceLedger,
    current?: CollectionSourceWorkState,
  ): Promise<CollectionSubjectMembership> {
    if (routeOf(input.subjectId) === null) throw new ProblemError('not_found');
    const progress = input.progress;
    if (progress && (progress.subjectId !== input.subjectId || progress.basisDigest !== saved.basis.digest))
      throw new ProblemError('invalid_cursor');
    let after = decodeSourceAfter(progress?.sourceAfter ?? null);
    const obs = current?.observation ?? observation(saved.metadata, saved.basis);
    const partial = (reason: 'allowance' | 'native_evidence'): CollectionSubjectMembership => ({
      subjectId: input.subjectId,
      result: 'not_proven',
      reason,
      observation: obs,
      progress: after
        ? {
            subjectId: input.subjectId,
            basisDigest: saved.basis.digest,
            aliasAfter: null,
            sourceAfter: encodeSourceAfter(after),
          }
        : null,
      work: l.receipt(),
    });
    const raw = Math.min(100, Math.floor(l.allowance().remaining.candidateKeys / 4));
    if (!raw) return partial('allowance');
    const window =
      input.work && current
        ? await l.run((allowance) =>
            readCollectionSourceWorkGroup(input.work!, current, input.subjectId, after, raw, {
              deadline: input.deadline,
              allowance,
            }),
          )
        : await useCanonical(l, () =>
            readCanonicalSourceGroup(dependencies.pool, {
              route: obs.route,
              collectionId: obs.collectionId,
              deadline: input.deadline,
              allowance: canonicalAllowance(l.allowance(), raw),
              basis: saved.basis,
              progress: { pendingSubjectId: input.subjectId, after, generation: saved.generation, basis: saved.basis },
            }),
          );
    if (!('rows' in window)) return partial('native_evidence');
    for (const row of window.rows) {
      // Probe current original support, then consume the ordinary Semantic original AND terminal guards at T.
      const probe = await l.run((allowance) =>
        probeNativeCollectionOriginal(dependencies.pool, saved.metadata, {
          originalId: row.key.storedSubjectId,
          keyHint: row.key,
          ...(input.work ? { tx: input.work.tx } : {}),
          deadline: input.deadline,
          allowance,
        }),
      );
      if (probe.result === 'not_proven') return partial('native_evidence');
      if (probe.result === 'present') {
        // The admitted native canonical generation supplies structural identity only. No foreign Subject
        // read is made with the home checkout held; the final ordinary reader still checks both anchors.
        if (input.work) {
          return {
            result: true,
            subjectId: input.subjectId,
            positiveEvidence: { [nativeEvidence]: true },
            observation: obs,
            work: l.receipt(),
          };
        }
        const resolved = await l.bounded(
          { nativeRows: 8192, nativePoints: 128, statements: 128, bytes: 1024 * 1024 },
          () =>
            resolveSubject(dependencies, input.actor, row.key.storedSubjectId, input.at, {
              pool: dependencies.pool,
              deadline: input.deadline,
            }),
        );
        if (resolved?.subjectId === input.subjectId) {
          await revalidate(input, l, current);
          // A positive is issued only after a fresh fact reread as well as source/scope admission.
          const final = await l.run((allowance) =>
            probeNativeCollectionOriginal(dependencies.pool, saved.metadata, {
              originalId: row.key.storedSubjectId,
              keyHint: probe.key,
              deadline: input.deadline,
              allowance,
            }),
          );
          if (final.result !== 'present') return partial('native_evidence');
          return {
            result: true,
            subjectId: input.subjectId,
            positiveEvidence: { [nativeEvidence]: true },
            observation: obs,
            work: l.receipt(),
          };
        }
      }
      after = row.key;
    }
    if (!window.exhausted) return partial('allowance');
    await revalidate(input, l, current);
    return {
      result: false,
      subjectId: input.subjectId,
      negativeEvidence: { [nativeEvidence]: true },
      observation: obs,
      work: l.receipt(),
    };
  }
  return {
    prepare(input) {
      return guarded(input, async (l, current) => {
        const route = routeOf(input.collectionId);
        if (route === null) throw new ProblemError('not_found');
        const { metadata } =
          current ??
          (await l.run((allowance) =>
            readNativeCollectionMetadata(
              dependencies.pool,
              { route, collectionId: input.collectionId },
              { deadline: input.deadline, allowance },
            ),
          ));
        if (!metadata || metadata.state !== 'active') throw new ProblemError('not_found');
        if (!input.work) await authorize(input, metadata, l);
        const state = current ?? (await ready(input, metadata, l));
        const source: PreparedCollectionSource = {
          [preparedSource]: true,
          observation: current?.observation ?? observation(metadata, state.basis),
        };
        prepared.set(source, {
          metadata,
          basis: state.basis,
          generation: state.generation,
          ...(input.work
            ? { workBinding: { kind: input.work.kind, locator: Object.freeze({ ...input.work.locator }) } }
            : {}),
        });
        return { source, work: l.receipt() };
      });
    },
    containsSubject(input) {
      return guarded(input, async (l, current) => membership(input, await revalidate(input, l, current), l, current));
    },
    prefix(input) {
      return guarded(input, async (l, current) => {
        const saved = await revalidate(input, l, current),
          obs = current?.observation ?? observation(saved.metadata, saved.basis);
        if (input.afterSubjectId !== null && routeOf(input.afterSubjectId) === null)
          throw new ProblemError('invalid_cursor');
        const candidates: CanonicalCollectionCandidate[] = [];
        let coveredThrough = input.afterSubjectId,
          exhausted = false;
        while (l.allowance().remaining.candidateKeys > 0 && candidates.length < 100) {
          const seek =
            input.work && current
              ? await l.run((allowance) =>
                  seekCollectionSourceWorkGroup(input.work!, current, coveredThrough, {
                    deadline: input.deadline,
                    allowance,
                  }),
                )
              : await useCanonical(l, () =>
                  seekCanonicalSourceGroup(dependencies.pool, {
                    route: obs.route,
                    collectionId: obs.collectionId,
                    basis: saved.basis,
                    generation: saved.generation,
                    afterSubjectId: coveredThrough,
                    deadline: input.deadline,
                    allowance: canonicalAllowance(l.allowance(), 1),
                  }),
                );
          if (!('subjectId' in seek)) throw new ProblemError('dependency_unavailable');
          if (!seek.subjectId) {
            exhausted = true;
            break;
          }
          // Keep the last settled frontier when the seek leaves too little for a native group proof.
          // An empty Source can still prove exhaustion with the single seek key above.
          if (l.allowance().remaining.candidateKeys < 4) break;
          const result = await membership({ ...input, subjectId: seek.subjectId }, saved, l, current);
          if (result.result === 'not_proven') throw new ProblemError('dependency_unavailable');
          coveredThrough = seek.subjectId;
          if (result.result) candidates.push({ subjectId: result.subjectId, evidence: result.positiveEvidence });
        }
        if (!exhausted && candidates.length === 0) throw new ProblemError('dependency_unavailable');
        await revalidate(input, l, current);
        return {
          kind: 'canonical_subject_prefix',
          candidates,
          coveredThrough,
          exhausted,
          observation: obs,
          work: l.receipt(),
        };
      });
    },
    readRawStoredPrefix(input) {
      return guarded(input, async (l, current) => {
        const saved = await revalidate(input, l, current),
          ids: string[] = [];
        let after = input.afterStoredSubjectId,
          exhausted = false;
        if (after !== null && routeOf(after) === null) throw new ProblemError('invalid_cursor');
        const drivers: readonly CanonicalRawKey['driver'][] =
          saved.metadata.authority === 'curated'
            ? ['member']
            : saved.metadata.authority === 'activated_output'
              ? ['output']
              : saved.metadata.builtinKind === 'state'
                ? ['entry']
                : ['entry', 'label', 'session', 'copy'];
        while (l.allowance().remaining.candidateKeys >= drivers.length && ids.length < 100) {
          const heads: string[] = [];
          for (const driver of drivers) {
            const page = await l.run((allowance) =>
              readNativeCollectionRawPage(dependencies.pool, saved.metadata, {
                driver,
                ...(input.work ? { tx: input.work.tx } : {}),
                after: after
                  ? {
                      driver,
                      storedSubjectId: after,
                      factId: driver === 'output' ? after : 'ffffffff-ffff-ffff-ffff-ffffffffffff',
                    }
                  : null,
                limit: 1,
                deadline: input.deadline,
                allowance,
              }),
            );
            if (page.rows[0]) heads.push(page.rows[0].key.storedSubjectId);
          }
          const first = heads.sort()[0];
          if (!first) {
            exhausted = true;
            break;
          }
          ids.push(first);
          after = first;
        }
        if (!ids.length && !exhausted) throw new ProblemError('dependency_unavailable');
        await revalidate(input, l, current);
        return {
          kind: 'raw_stored_subject_prefix',
          storedSubjectIds: ids,
          storedCoveredThrough: after,
          storedExhausted: exhausted,
          observation: current?.observation ?? observation(saved.metadata, saved.basis),
          work: l.receipt(),
        };
      });
    },
    readRawOrdinalPrefix(input) {
      return guarded(input, async (l, current) => {
        const saved = await revalidate(input, l, current);
        const page = await l.run((allowance) =>
          readNativeCollectionRawOrdinalPage(dependencies.pool, saved.metadata, {
            after: input.after,
            limit: input.limit,
            ...(input.work ? { tx: input.work.tx } : {}),
            deadline: input.deadline,
            allowance,
          }),
        );
        await revalidate(input, l, current);
        return {
          kind: 'raw_curated_ordinal_prefix',
          rows: page.rows,
          frontier: page.frontier,
          exhausted: page.exhausted,
          observation: current?.observation ?? observation(saved.metadata, saved.basis),
          work: l.receipt(),
        };
      });
    },
  };
}
