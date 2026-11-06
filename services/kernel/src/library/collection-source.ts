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
import { CANONICAL_SOURCE_RAW_KEY_LIMIT, COLLECTION_SOURCE_WORK_GROUP_LIMIT } from './canonical-source-limits.ts';
export { COLLECTION_SOURCE_DRIVER_COUNT } from './canonical-source-limits.ts';
import {
  readCollectionSourceWorkState,
  readCollectionSourceWorkGroup,
  seekCollectionSourceWorkGroup,
  type CollectionSourceWorkState,
} from './collection-source-work-native.ts';

import type { WorkAllowance, WorkDimensions, WorkReceipt } from './contract/work-dimensions.ts';
import {
  nativeEvidence,
  preparedSource,
  type CanonicalCollectionCandidate,
  type CanonicalCollectionPrefix,
  type CollectionAliasProgress,
  type CollectionSourceAfter,
  type CollectionSourceAuthority,
  type CollectionSourceBasis,
  type CollectionSourceObservation,
  type CollectionSourceEvidence,
  type CollectionSubjectMembership,
  type NativeIdentityBasis,
  type PreparedCollectionSource,
  type RawStoredCollectionPrefix,
} from './contract/index.ts';

export {
  nativeEvidence,
  preparedSource,
  type CanonicalCollectionCandidate,
  type CanonicalCollectionPrefix,
  type CollectionAliasProgress,
  type CollectionSourceAfter,
  type CollectionSourceAuthority,
  type CollectionSourceBasis,
  type CollectionSourceObservation,
  type CollectionSubjectMembership,
  type NativeIdentityBasis,
  type PreparedCollectionSource,
  type RawStoredCollectionPrefix,
};
export type { CollectionSourceDriverOrdinal, CollectionSourceEvidence } from './contract/index.ts';

type SourceWorkContext<W extends ScopeWorkContext = ScopeWorkContext> = W extends ScopeWorkContext
  ? Readonly<{ actor?: never; at?: never; work: W }>
  : never;

export type CollectionSourceContext = Readonly<{ deadline: number }> &
  (Readonly<{ actor: Actor; at: AuthoritativeTime; work?: never }> | SourceWorkContext);

export type PrepareCollectionSource = CollectionSourceContext & {
  readonly collectionId: string;
  readonly allowance: WorkAllowance;
};

export type CollectionSourceCall = CollectionSourceContext & {
  readonly source: PreparedCollectionSource;
  readonly allowance: WorkAllowance;
};

export type ContainsCollectionSubject = CollectionSourceCall & {
  readonly subjectId: string;
  readonly progress?: CollectionAliasProgress;
  readonly positiveEvidence?: CollectionSourceEvidence;
};

export interface CollectionSource {
  prepare(input: PrepareCollectionSource): Promise<{ source: PreparedCollectionSource; work: WorkReceipt }>;
  prefix(
    input: CollectionSourceCall & { readonly afterSubjectId: string | null; readonly candidateLimit?: number },
  ): Promise<CanonicalCollectionPrefix>;
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
// Cursor driver ordinals; the order is part of the encoded cursor and matches COLLECTION_SOURCE_DRIVER_COUNT.
const sourceDrivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;

type Prepared = {
  metadata: NativeCollectionMetadata;
  basis: CanonicalBasis;
  generation: string;
  /** Mechanical handles cannot be reused through a different episode or the ordinary reader branch. */
  workBinding?: Readonly<{ kind: ScopeWorkContext['kind']; locator: ScopeWorkContext['locator'] }>;
};
function canonicalAllowance(
  a: WorkAllowance,
  rawLimit = CANONICAL_SOURCE_RAW_KEY_LIMIT,
  fixed = false,
): CanonicalAllowance {
  return {
    reservationId: a.reservationId,
    rawKeys: fixed ? rawLimit : Math.min(rawLimit, a.remaining.candidateKeys),
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
  return createCollectionSourceRuntime(dependencies, false);
}

/** Local bridge for one ordinary page: fixed structural limits drive Source work, receipts still admit it. */
export function createOrdinaryCollectionPageSource(dependencies: {
  pool: Pool;
  access: Access;
  clock?: KernelClock;
}): CollectionSource {
  return createCollectionSourceRuntime(dependencies, true);
}

function createCollectionSourceRuntime(
  dependencies: { pool: Pool; access: Access; clock?: KernelClock },
  fixedPageWork: boolean,
): CollectionSource {
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
        allowance: canonicalAllowance(l.allowance(), 100, fixedPageWork),
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
        const current = await readCollectionSourceWorkState(dependencies.pool, input.work, {
          access: dependencies.access,
          deadline: input.deadline,
        });
        if ('source' in input && !isDeepStrictEqual(input.source.observation, current.observation))
          throw new ProblemError('semantic_not_ready');
        const result = await body(l, current);
        // This is a fresh native admission on the SAME live Core client, not a cached getter verdict.
        const final = await readCollectionSourceWorkState(dependencies.pool, input.work, {
          access: dependencies.access,
          deadline: input.deadline,
        });
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
    const raw = fixedPageWork
      ? COLLECTION_SOURCE_WORK_GROUP_LIMIT
      : input.work && current
        ? COLLECTION_SOURCE_WORK_GROUP_LIMIT
        : Math.min(COLLECTION_SOURCE_WORK_GROUP_LIMIT, Math.floor(l.allowance().remaining.candidateKeys / 4));
    if (!raw) return partial('allowance');
    const window =
      input.work && current
        ? await readCollectionSourceWorkGroup(input.work, current, input.subjectId, after, raw, {
            deadline: input.deadline,
          })
        : await useCanonical(l, () =>
            readCanonicalSourceGroup(dependencies.pool, {
              route: obs.route,
              collectionId: obs.collectionId,
              deadline: input.deadline,
              allowance: canonicalAllowance(l.allowance(), raw, fixedPageWork),
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
    prefix(input: CollectionSourceCall & { afterSubjectId: string | null; candidateLimit?: number }) {
      if (
        input.candidateLimit !== undefined &&
        (!Number.isSafeInteger(input.candidateLimit) ||
          input.candidateLimit < 1 ||
          input.candidateLimit > COLLECTION_SOURCE_WORK_GROUP_LIMIT)
      )
        throw new RangeError('Invalid Collection Source candidate limit');
      if (input.work && input.candidateLimit === undefined)
        throw new RangeError('Selected Collection Source candidate limit required');
      return guarded(input, async (l, current) => {
        const saved = await revalidate(input, l, current),
          obs = current?.observation ?? observation(saved.metadata, saved.basis);
        if (input.afterSubjectId !== null && routeOf(input.afterSubjectId) === null)
          throw new ProblemError('invalid_cursor');
        const candidates: CanonicalCollectionCandidate[] = [];
        let coveredThrough = input.afterSubjectId,
          exhausted = false,
          groups = 0;
        if (fixedPageWork && input.candidateLimit === undefined)
          throw new RangeError('Ordinary Collection page candidate limit required');
        const selectedLimit = fixedPageWork ? input.candidateLimit! : input.work ? input.candidateLimit! : 100;
        while (
          (input.work || fixedPageWork ? groups < selectedLimit : l.allowance().remaining.candidateKeys > 0) &&
          candidates.length < COLLECTION_SOURCE_WORK_GROUP_LIMIT
        ) {
          const seek =
            input.work && current
              ? await seekCollectionSourceWorkGroup(input.work, current, coveredThrough, {
                  deadline: input.deadline,
                })
              : await useCanonical(l, () =>
                  seekCanonicalSourceGroup(dependencies.pool, {
                    route: obs.route,
                    collectionId: obs.collectionId,
                    basis: saved.basis,
                    generation: saved.generation,
                    afterSubjectId: coveredThrough,
                    deadline: input.deadline,
                    allowance: canonicalAllowance(l.allowance(), 1, fixedPageWork),
                  }),
                );
          if (!('subjectId' in seek)) throw new ProblemError('dependency_unavailable');
          if (!seek.subjectId) {
            exhausted = true;
            break;
          }
          groups++;
          // Keep the last settled frontier when the seek leaves too little for a native group proof.
          // An empty Source can still prove exhaustion with the single seek key above.
          if (!input.work && !fixedPageWork && l.allowance().remaining.candidateKeys < 4) break;
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
        while (
          (fixedPageWork
            ? ids.length < COLLECTION_SOURCE_WORK_GROUP_LIMIT
            : l.allowance().remaining.candidateKeys >= drivers.length) &&
          ids.length < COLLECTION_SOURCE_WORK_GROUP_LIMIT
        ) {
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
