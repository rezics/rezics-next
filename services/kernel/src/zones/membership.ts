import { memoizedValue } from '../memoized.ts';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { FilterDocument } from '@rezics/filter';
import type { Pool } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import { ProblemError } from '../http/problem.ts';
import {
  createCollectionSource,
  type CollectionAliasProgress,
  type PreparedCollectionSource,
  type CollectionSourceEvidence,
} from '../library/collection-source.ts';
import { type WorkAllowance, type WorkReceipt, type WorkDimensions } from '../library/contract/work-dimensions.ts';
import { CollectionSourceLedger } from '../library/collection-source-work.ts';
import {
  readCanonicalSourceState,
  seekCanonicalSourceGroup,
  type CanonicalAllowance,
  type CanonicalWork,
} from '../library/canonical-source-store.ts';
import { readNativeCollectionScopeIdentity } from '../library/collection-source-native.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { scopeAllowance, scopeWorkAxes, zeroScopeWork } from '../search/scope-execution.ts';
import { createSearchScopeForService, type SearchService } from '../search/service-scope.ts';
import type {
  PreparedSearchScope,
  ScopeEvaluationProgress,
  ScopeNativeOrder,
  ScopeNameSortTuple,
  ScopeCollectionsSortTuple,
} from '../search/scope-source.ts';

// Native observations contain bigint positions. Preserve their exact decimal value in commitments.
export const zoneDigest = (value: unknown) =>
  createHash('sha256')
    .update(
      canonicalize(
        JSON.parse(JSON.stringify(value, (_, item) => (typeof item === 'bigint' ? { bigint: item.toString() } : item))),
      )!,
    )
    .digest('hex');
export const zoneUnavailable = (): never => {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
};
export type ZoneSources = {
  scopes: readonly string[];
  mounts: readonly string[];
  releaseDigest: string;
  revision: string;
};
export type ZoneOrder = 'id' | ScopeNativeOrder;
export type ZoneKey = readonly [string] | ScopeNameSortTuple | ScopeCollectionsSortTuple;
export type ZoneCandidate = { id: string; key: ZoneKey; source: number };
export type ZonePending = {
  subject: string;
  source: number;
  collection?: CollectionAliasProgress;
  scope?: ScopeEvaluationProgress;
  conjunct?: 'source' | 'zone';
  zoneSource?: number;
};
export type ZoneVerdict = { value: true | false | 'not_proven'; pending?: ZonePending; source?: number };
export type ZonePrefix = { rows: ZoneCandidate[]; covered: ZoneKey | null; exhausted: boolean };
export type ZoneStream = {
  basis: unknown;
  prefix(after: ZoneKey | null, quota: number): Promise<ZonePrefix>;
  member(id: string, pending?: ZonePending): Promise<ZoneVerdict>;
};

/** Bytewise native order. UTF-8 comparison agrees with the engine's scalar order, including astral text. */
export function compareZoneKeys(order: ZoneOrder, a: ZoneKey, b: ZoneKey): number {
  const string = (left: string, right: string) => Buffer.compare(Buffer.from(left), Buffer.from(right));
  if (order === 'id') return string(a[0] as string, b[0] as string);
  const nameAt = order === 'collections' ? 1 : 0;
  if (order === 'collections' && a[0] !== b[0]) return (b[0] as number) - (a[0] as number);
  const left = a[nameAt] as string | null,
    right = b[nameAt] as string | null;
  const names = left === right ? 0 : left === null ? 1 : right === null ? -1 : string(left, right);
  return names || string(a[nameAt + 1] as string, b[nameAt + 1] as string);
}

/** One request reservation, shared by discovery, aliases, rejected/lookahead/reread keys and final use.
 * Native metadata is an independent axis; public ordered cost is a breakdown of the same receipt.
 */
class ZoneWorkLedger extends CollectionSourceLedger {
  private selected = 'target';
  private structuralKeys = 0;
  private ordered = zeroScopeWork();
  private readonly reads = new Map<
    string,
    { limit: WorkDimensions; used: WorkDimensions; engine: number; structural: boolean }
  >();
  select(key: string, order: ZoneOrder, size: number): void {
    this.selected = key;
    if (this.reads.has(key)) return;
    const candidates = order === 'id' ? 256 : Math.min(600, 6 * size + 3);
    this.reads.set(key, {
      engine: 0,
      structural: order === 'id',
      used: zeroScopeWork(),
      limit:
        order === 'id'
          ? scopeAllowance(256, this.initial.reservationId).remaining
          : {
              ...this.initial.remaining,
              candidateKeys: candidates,
              nativePoints: 16 + 8 * candidates,
              nativeRows: 64 + 16 * candidates,
              bytes: 16 * 1024 + 4 * 1024 * candidates,
              statements: 12,
            },
    });
  }
  override allowance(): WorkAllowance {
    let root = super.allowance();
    const read = this.reads.get(this.selected);
    if (!read) return root;
    if (read.structural)
      root = {
        ...root,
        remaining: {
          ...root.remaining,
          candidateKeys: Math.min(root.remaining.candidateKeys, 256 - this.structuralKeys),
        },
      };
    else
      root = {
        ...root,
        remaining: {
          ...root.remaining,
          nativeRows: Math.min(root.remaining.nativeRows, 14080 - this.ordered.nativeRows),
          nativePoints: Math.min(root.remaining.nativePoints, 6784 - this.ordered.nativePoints),
          statements: Math.min(root.remaining.statements, 72 - this.ordered.statements),
        },
      };
    return {
      ...root,
      remaining: Object.fromEntries(
        scopeWorkAxes.map((axis) => [axis, Math.min(root.remaining[axis], read.limit[axis] - read.used[axis])]),
      ) as unknown as WorkDimensions,
    };
  }
  override take(receipt: WorkReceipt): void {
    const read = this.reads.get(this.selected);
    if (scopeWorkAxes.some((axis) => receipt.used[axis] > this.allowance().remaining[axis])) return zoneUnavailable();
    super.take(receipt);
    if (read?.structural) this.structuralKeys += receipt.used.candidateKeys;
    else if (read)
      for (const axis of scopeWorkAxes)
        this.ordered = { ...this.ordered, [axis]: this.ordered[axis] + receipt.used[axis] };
    if (read)
      for (const axis of scopeWorkAxes) read.used = { ...read.used, [axis]: read.used[axis] + receipt.used[axis] };
  }
  orderedAvailable(): boolean {
    return (this.reads.get(this.selected)?.engine ?? 0) <= 4;
  }
  orderedCost(engineSearches: number): void {
    const read = this.reads.get(this.selected);
    if (!read || !Number.isSafeInteger(engineSearches) || engineSearches < 0 || read.engine + engineSearches > 6)
      return zoneUnavailable();
    read.engine += engineSearches;
  }
}

export function ZoneWork() {
  return memoizedValue(ZoneWork, () => ZoneWorkLedger);
}
export type ZoneWork = InstanceType<ReturnType<typeof ZoneWork>>;
export function zoneWork(deadline: number, orderedSlots: readonly number[] = []) {
  // NAME/COUNT use their own direct-plan operation class, rather than the structural UUID ceiling.
  const candidates = orderedSlots.length
    ? Math.min(816, orderedSlots.reduce((sum, size) => sum + Math.min(600, 6 * size + 3), 0) + 256)
    : 256;
  const ledger = new (ZoneWork())(
    scopeAllowance(candidates, crypto.randomUUID(), {
      candidateKeys: candidates,
      nativeRows: 65536,
      identityMetadataRows: 16384,
      emptySeeks: 256,
      nativePoints: orderedSlots.length ? 6784 : 4096,
      witnessKeys: 8192,
      statements: 8192,
      bytes: 4 * 1024 * 1024,
    }),
    deadline,
  );
  ledger.select('target', 'id', 1);
  return ledger;
}
function canonicalAllowance(allowance: WorkAllowance): CanonicalAllowance {
  const r = allowance.remaining;
  return {
    reservationId: allowance.reservationId,
    rawKeys: Math.min(100, r.candidateKeys),
    nativeRows: r.nativeRows,
    nativePoints: r.nativePoints,
    emptySeeks: r.emptySeeks,
    statements: r.statements,
    bytes: r.bytes,
    identityMetadataRows: r.identityMetadataRows,
  };
}
function canonicalReceipt(work: CanonicalWork): WorkReceipt {
  return {
    reservationId: work.reservationId,
    used: {
      ...zeroScopeWork(),
      candidateKeys:
        work.candidateKeys + work.aliasKeys + work.duplicateKeys + work.lookaheadKeys + work.internalDriverKeys,
      nativeRows: work.nativeRows,
      nativePoints: work.nativePoints,
      emptySeeks: work.emptySeeks,
      statements: work.statements,
      bytes: work.bytes,
      identityMetadataRows: work.identityMetadataRows,
    },
  };
}

export type ZoneSourceDependencies = {
  pool: Pool;
  access: Access;
  routeKey: Uint8Array;
  search?: SearchService;
  clock: () => Date;
};

/** Native owners retain every predicate, current Source, original and terminal check. This adapter
 * only supplies locators, immutable saved pins, a shrinking root allowance and the canonical union.
 */
export async function createZoneMembership(
  deps: ZoneSourceDependencies,
  input: {
    actor: Actor;
    at: AuthoritativeTime;
    deadline: number;
    sources: ZoneSources;
    work: ZoneWork;
    order?: ZoneOrder;
    filter?: FilterDocument;
    pageSize?: number;
    collection?: string;
  },
) {
  if (input.sources.scopes.length > 16 || input.sources.mounts.length > 16) throw new RangeError('Zone source bound');
  const order = input.order ?? 'id';
  const work = input.work;
  const context = { actor: input.actor, at: input.at, deadline: input.deadline };
  const collections = createCollectionSource(deps);
  let scope: ReturnType<typeof createSearchScopeForService> | undefined;
  function search() {
    if (!deps.search) return zoneUnavailable();
    return (scope ??= createSearchScopeForService(deps.search, {
      actor: input.actor,
      nativeT: input.at,
      access: deps.access,
      routeKey: deps.routeKey,
      deadline: input.deadline,
    }));
  }
  const streams: ZoneStream[] = [];
  async function prepareScope(filter: FilterDocument, releaseDigest?: string, collection?: PreparedCollectionSource) {
    const native = search();
    let nativeSource;
    if (collection) {
      const result = await work.run((allowance) =>
        readNativeCollectionScopeIdentity(deps.pool, {
          route: collection.observation.route,
          collectionId: collection.observation.collectionId,
          deadline: input.deadline,
          allowance,
        }),
      );
      if (!result.identity) return zoneUnavailable();
      nativeSource = result.identity;
    }
    const prepared = await native.prepare(filter, {
      ...(releaseDigest ? { releaseDigest } : {}),
      ...(nativeSource ? { order: { kind: 'id' as const, source: nativeSource } } : {}),
      ...(order === 'id' ? {} : { nativeOrder: order, pageSize: input.pageSize ?? 20 }),
      allowance: work.allowance(),
    });
    work.take(native.work(prepared));
    return prepared;
  }
  async function evaluate(prepared: PreparedSearchScope, id: string, pending?: ZonePending): Promise<ZoneVerdict> {
    const native = search(),
      r = work.allowance().remaining;
    if (
      [r.candidateKeys, r.nativePoints, r.witnessKeys, r.nativeRows, r.bytes, r.emptySeeks].some((value) => value < 1)
    )
      return { value: 'not_proven' };
    const result = await native.evaluate(prepared, [id], {
      rawKeys: r.candidateKeys,
      native: {
        points: r.nativePoints,
        witnesses: r.witnessKeys,
        rows: r.nativeRows,
        bytes: r.bytes,
        emptySeeks: r.emptySeeks,
      },
      allowance: work.allowance(),
      ...(pending?.scope ? { progress: pending.scope } : {}),
    });
    work.take(native.work(result));
    return {
      value: result.values[0] ?? 'not_proven',
      ...(result.progress
        ? {
            pending: { subject: id, source: -1, scope: result.progress },
          }
        : {}),
    };
  }
  function scopeStream(prepared: PreparedSearchScope): ZoneStream {
    return {
      basis: prepared.basis,
      member: (id, pending) => evaluate(prepared, id, pending),
      async prefix(after, quota) {
        const native = search();
        const budget = Math.min(order === 'id' ? 256 : 100, work.allowance().remaining.candidateKeys);
        quota = Math.min(quota, budget - 1, order === 'id' ? 100 : 99);
        if (quota < 1) return zoneUnavailable();
        if (order === 'id' && prepared.basis.nativeOwner) {
          const result = await native.sourcePrefix(prepared, {
            afterSubjectId: (after?.[0] as string) ?? null,
            allowance: work.allowance(),
          });
          work.take(result.work);
          return {
            rows: result.candidates.map((hit) => ({ id: hit.subjectId, key: [hit.subjectId] as const, source: -1 })),
            covered: result.coveredThrough ? [result.coveredThrough] : after,
            exhausted: result.exhausted,
          };
        }
        if (order === 'id') {
          const result = await native.prefix(prepared, {
            afterSubject: (after?.[0] as string) ?? null,
            quota,
            budget,
            allowance: work.allowance(),
          });
          if (!result.usage.work) return zoneUnavailable();
          work.take(result.usage.work);
          return {
            rows: result.hits.map((hit) => ({ id: hit.id, key: [hit.id] as const, source: -1 })),
            covered: result.coveredThrough ? [result.coveredThrough] : after,
            exhausted: result.exhausted,
          };
        }
        const request =
          order === 'name'
            ? { order, after: after as ScopeNameSortTuple | null, quota, budget, allowance: work.allowance() }
            : { order, after: after as ScopeCollectionsSortTuple | null, quota, budget, allowance: work.allowance() };
        const result = await native.orderedPrefix(prepared, request);
        work.take(result.usage.work);
        work.orderedCost(result.usage.public.engineSearches); // public cost is its breakdown, never a second charge.
        if (result.order !== order || zoneDigest(result.basis) !== zoneDigest(prepared.basis)) return zoneUnavailable();
        return {
          rows: result.hits.map((hit) => ({ id: hit.id, key: hit.sort, source: -1 })),
          covered: result.coveredThrough,
          exhausted: result.exhausted,
        };
      },
    };
  }
  for (const saved of input.sources.scopes) {
    const filter: FilterDocument = input.filter ? { and: [{ saved }, input.filter] } : { saved };
    streams.push(scopeStream(await prepareScope(filter, input.sources.releaseDigest)));
  }
  const mounted = input.collection ? [input.collection] : input.sources.mounts;
  for (const id of mounted) {
    let prepared: PreparedCollectionSource;
    try {
      prepared = (await work.run((allowance) => collections.prepare({ ...context, collectionId: id, allowance })))
        .source;
    } catch (error) {
      // Only an actual native concealed Source is an omitted mount. Unavailability is never empty.
      if (error instanceof ProblemError && error.code === 'not_found') continue;
      throw error;
    }
    if (order !== 'id' || input.filter) {
      // A Collection is the native population, not an owner predicate or a public Search result page.
      // The shared compiler admits the TypeList conjunct together with population and actual output order.
      if (!input.filter) return zoneUnavailable();
      streams.push(scopeStream(await prepareScope(input.filter, undefined, prepared)));
      continue;
    }
    const ref = { route: routeOf(id)!, collectionId: id, deadline: input.deadline };
    const state = await readCanonicalSourceState(deps.pool, {
      ...ref,
      allowance: canonicalAllowance(work.allowance()),
    });
    work.take(canonicalReceipt(state.work));
    if (state.state !== 'ready' || state.basis.digest !== prepared.observation.basis.digest) return zoneUnavailable();
    // Opaque evidence lives for this request only and is always checked by its native owner again.
    const witnesses = new Map<string, CollectionSourceEvidence>();
    streams.push({
      basis: prepared.observation,
      async prefix(after) {
        const seek = await seekCanonicalSourceGroup(deps.pool, {
          ...ref,
          basis: state.basis,
          generation: state.generation,
          afterSubjectId: (after?.[0] as string) ?? null,
          allowance: canonicalAllowance(work.allowance()),
        });
        work.take(canonicalReceipt(seek.work));
        if (seek.state !== 'ready') return zoneUnavailable();
        return {
          rows: seek.subjectId ? [{ id: seek.subjectId, key: [seek.subjectId], source: -1 }] : [],
          covered: seek.coveredThrough ? [seek.coveredThrough] : after,
          exhausted: seek.exhausted,
        };
      },
      async member(subjectId, pending) {
        const result = await work.run((allowance) =>
          collections.containsSubject({
            ...context,
            source: prepared,
            subjectId,
            allowance,
            ...(pending?.collection ? { progress: pending.collection } : {}),
            ...(witnesses.has(subjectId) ? { positiveEvidence: witnesses.get(subjectId)! } : {}),
          }),
        );
        if (result.result === true) witnesses.set(subjectId, result.positiveEvidence);
        return {
          value: result.result,
          ...(result.result === 'not_proven' && result.progress
            ? {
                pending: { subject: subjectId, source: -1, collection: result.progress },
              }
            : {}),
        };
      },
    });
  }
  const basis = zoneDigest({
    sources: input.sources,
    streams: streams.map((stream) => stream.basis),
    order,
    filter: input.filter ?? null,
    collection: input.collection ?? null,
  });
  return {
    streams,
    basis,
    order,
    prefixAvailable: () => order === 'id' || work.orderedAvailable(),
    /** Unknown sources can be bypassed only by an actual current true source. No cached truth vector. */
    async contains(id: string, pending?: ZonePending, preferred?: number): Promise<ZoneVerdict> {
      let unresolved: ZonePending | undefined;
      let unknown = false;
      const indices = streams.map((_, index) => index);
      if (preferred !== undefined && preferred >= 0 && preferred < indices.length)
        (indices.splice(indices.indexOf(preferred), 1), indices.unshift(preferred));
      for (const index of indices) {
        const result = await streams[index]!.member(
          id,
          pending?.source === index && pending.subject === id ? pending : undefined,
        );
        if (result.value === true) return { value: true, source: index };
        if (result.value === 'not_proven') {
          unknown = true;
          if (!unresolved && result.pending) unresolved = { ...result.pending, source: index };
        }
      }
      return { value: unknown ? 'not_proven' : false, ...(unresolved ? { pending: unresolved } : {}) };
    },
  };
}
export type ZoneMembership = Awaited<ReturnType<typeof createZoneMembership>>;
