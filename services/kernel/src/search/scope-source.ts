import {
  admitFilter,
  FilterError,
  parseFilter,
  positiveFilter,
  type FilterDocument,
  type FilterRelease,
} from '@rezics/filter';
import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { isDeepStrictEqual } from 'node:util';
import { systemClock, type KernelClock } from '../clock.ts';
import type { WorkAllowance } from '../library/collection-source.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { readRelease } from '../semantic/definitions.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
import {
  createSearchScopeOrder,
  sameScopeObservation,
  type SearchScopeOrder,
  type SearchScopeCollection,
  type SearchScopeOrdinalPrefix,
} from './service-scope-order.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { createScopePreparationStore, type ScopeCaptureDefinition } from './scope-preparation-store.ts';
import { createScopePreparation, readPreparedScopeObservation } from './scope-preparation.ts';
import { ScopeWork, scopeAllowance, zeroScopeWork, evaluateScopeSubjects } from './scope-execution.ts';
import { compileCurrentOwnerFilter, type CurrentOwnerFilterPlan } from './current-filter-plan.ts';
import { discoveryIndexUuid, subjectGenerations, subjectIndexName } from './indices.ts';
import { searchSubjectHits } from './query.ts';
import { ProblemError } from '../http/problem.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../semantic/scope-leaf-evidence.ts';
import { packScopeLeafProgress, type ScopeLeafPosition } from './scope-progress.ts';
import { compileFilter } from './filter.ts';
import type { OpenSearch, SearchRequestWork } from './opensearch.ts';
import { isOrdinalKey } from '../library/ordinal.ts';
import { routeOf } from '../route/route.ts';
import type { SearchHit } from './query.ts';
import { readSearchScopeRelease } from './scope-release.ts';
import { subjectPartition, type RelationFacetMatch, type SubjectSource } from './source.ts';

/** Independent native work reservation; none of these units are candidate keys. */
export type ScopeNativeBudget = Omit<LeafWork, 'keys'>;

/** One unfinished original/leaf; basis is the composite owner digest, never a native leaf basis. */
export type ScopeEvaluationProgress = Readonly<{
  subject: string;
  basis: string;
}> &
  Pick<NonNullable<ScopeLeafPosition>, 'leafOrdinal'> &
  Omit<LeafProgress, 'basis'>;

export type ScopeEvaluationReservation = Readonly<{
  /** Explicit remaining allowance in the caller's shared raw-key ledger, including alias and prefix work. */
  rawKeys: number;
  native: ScopeNativeBudget;
  progress?: ScopeEvaluationProgress | null;
  allowance?: WorkAllowance;
}>;

export type ScopeBasis = Readonly<{
  release: string;
  query: string;
  profile: string;
  canonical: string;
  generation: number;
  index: string;
}>;

/** Additive preparation controls; future metadata-budget fields belong on this same options object. */
export type ScopePrepareOptions = Readonly<{
  releaseDigest?: string;
  order?: SearchScopeOrder;
  /** Native caller's shared root; omitted legacy calls retain the bounded compatibility ceilings. */
  allowance?: WorkAllowance;
  /** Exact released projection type, when the source requires a selected catalogue profile. */
  type?: string;
}>;

const preparedScope: unique symbol = Symbol('prepared Search scope');
/** Factory-local opaque state, never an Access or bearer allow claim. */
export type PreparedSearchScope = {
  readonly [preparedScope]: true;
  readonly readiness: 'ready';
  readonly basis: ScopeBasis;
};

export type SearchScopePrefix = {
  hits: readonly SearchHit[];
  basis: ScopeBasis;
  /** Last covered raw key, excluding unused lookahead; null only at the beginning. */
  coveredThrough: string | null;
  exhausted: boolean;
  usage: { candidates: number; work?: import('../library/collection-source.ts').WorkReceipt };
};

export type SearchScopeEvaluation = {
  values: readonly RelationFacetMatch[];
  basis: ScopeBasis;
  usage: { keys: number; native: ScopeNativeBudget };
  /** Native evidence references for final current revalidation, never allow tokens. */
  evidence: readonly string[];
  progress: ScopeEvaluationProgress | null;
};

function unavailable(): never {
  throw new ProblemError('semantic_not_ready', { headers: { 'retry-after': '1' } });
}

function bounded(value: number, maximum: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError('Scope reservation is out of range');
}

function nativeBudget(budget: ScopeNativeBudget): void {
  if (!budget || typeof budget !== 'object' || Array.isArray(budget))
    throw new RangeError('Invalid native reservation');
  for (const key of ['points', 'witnesses', 'rows', 'bytes', 'emptySeeks'] as const)
    bounded(budget[key], Number.MAX_SAFE_INTEGER);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)!).digest('hex');
}
function observationDigest(observation: IdentityScopeObservation): string {
  return digest({ ...observation, committedRevision: observation.committedRevision.toString() });
}
type ScopeState = {
  filter: FilterDocument;
  plan: CurrentOwnerFilterPlan;
  compiled: ReturnType<typeof compileFilter> | null;
  basis: ScopeBasis;
  uuid: string;
  observation: IdentityScopeObservation;
  collection: SearchScopeCollection | null;
};

/** Native service runtime, immutable admission and factory-local handles. Native producers
 * own structural capture, current authorization and evidence; this module owns execution.
 */
export function createSearchScopeSource({
  pool,
  client,
  prefix,
  source: _source,
  release,
  evidence,
  clock = systemClock,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  release?: () => Promise<FilterRelease | null>;
  evidence?: LeafOptions;
  clock?: KernelClock;
}) {
  const states = new WeakMap<PreparedSearchScope, ScopeState>();
  const observations = createIdentityScopedObservations(pool);
  const store = createScopePreparationStore(pool, prefix);
  const order = evidence ? createSearchScopeOrder({ pool, options: evidence, clock }) : null;
  function state(prepared: PreparedSearchScope): ScopeState {
    const value = states.get(prepared);
    if (!value || prepared.basis !== value.basis) unavailable();
    return value;
  }
  function context(): LeafOptions {
    if (!evidence || Date.now() >= evidence.deadline) unavailable();
    return evidence;
  }
  function engineWork(work: ScopeWork): SearchRequestWork {
    const options = context();
    return {
      bytes: work.remaining().remaining.bytes,
      deadline: options.deadline,
      settle(bytes) {
        work.consume({ ...zeroScopeWork(), bytes });
      },
    };
  }
  async function current(value: ScopeState, work: ScopeWork): Promise<void> {
    const options = context();
    const result = await observations.revalidate({
      key: value.observation.key,
      expected: value.observation,
      deadline: options.deadline,
    });
    work.identity(result.work);
    if (result.status !== 'current' || !sameScopeObservation(result.observation, value.observation)) unavailable();
    if (value.collection) {
      const refreshed = await order!.prepare(value.collection.order, work.remaining());
      work.native(refreshed.work);
      if (!isDeepStrictEqual(refreshed.collection.observation, value.collection.observation)) unavailable();
    }
    work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
    if ((await discoveryIndexUuid(client, value.basis.index, engineWork(work))) !== value.uuid) unavailable();
  }
  return {
    async prepare(filter: FilterDocument, options?: ScopePrepareOptions): Promise<PreparedSearchScope> {
      const work = new ScopeWork(options?.allowance ?? scopeAllowance(256, 'scope.prepare'));
      function releaseWork() {
        work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, nativePoints: 1, bytes: 262144 });
      }
      async function selectRelease() {
        releaseWork();
        return readSearchScopeRelease(pool, options?.releaseDigest);
      }
      let admitted: FilterDocument;
      let selected: Awaited<ReturnType<typeof readSearchScopeRelease>>;
      let injectedBody: FilterRelease | null | undefined;
      try {
        const parsed = parseFilter(filter);
        // The resolved service reader remains the admission reader. Immutable release lookup
        // follows only after structural admission and actual native context are present.
        let injected: FilterRelease | null | undefined;
        if (options?.releaseDigest === undefined && release) {
          releaseWork();
          injected = await release();
        }
        selected = injected === undefined ? await selectRelease() : null;
        injectedBody = injected;
        const body = injected === undefined ? selected?.release : injected;
        if (!body) unavailable();
        admitted = admitFilter(parsed, body, options?.order?.source ? { owner: true } : undefined);
        if (!positiveFilter(admitted))
          throw new ProblemError('unsupported_query', {
            errors: [{ pointer: '/filter', code: 'unsupported' }],
          });
      } catch (error) {
        if (error instanceof FilterError)
          throw new ProblemError(error.problem, {
            errors: error.errors.map(({ pointer, code }) => ({ pointer: `/filter${pointer}`, code })),
          });
        throw error;
      }
      const reader = context();
      selected ??= await selectRelease();
      if (!selected) unavailable();
      releaseWork();
      const nativeRelease = await readRelease(pool, selected.digest);
      if (!nativeRelease || (injectedBody !== undefined && !isDeepStrictEqual(injectedBody, nativeRelease)))
        unavailable();
      // Re-admit with the exact immutable body. A changed current-release callback cannot
      // be paired with a newer digest, even if both accept the same AST.
      const immutable = admitFilter(
        parseFilter(filter),
        nativeRelease,
        options?.order?.source ? { owner: true } : undefined,
      );
      if (!isDeepStrictEqual(admitted, immutable)) unavailable();
      admitted = structuredClone(immutable);
      const plan = compileCurrentOwnerFilter(admitted);
      const hasOwner = plan.leaves.some((leaf) => leaf.kind === 'owner');
      // No admitted owner plan may bypass unresolved native owner-leaf authorization under OR/NOT.
      if (hasOwner) unavailable();
      const compiled = hasOwner ? null : compileFilter(admitted, { prefix: 'f', relationOverflow: true });
      work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
      const generations = await subjectGenerations(client, prefix, engineWork(work));
      if (generations.active === null) unavailable();
      const generation = generations.active;
      const index = subjectIndexName(prefix, generation);
      work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
      const uuid = await discoveryIndexUuid(client, index, engineWork(work));
      const sort: SearchScopeOrder = structuredClone(options?.order ?? { kind: 'id' });
      let collection: SearchScopeCollection | null = null;
      let profile: string;
      let definition: ScopeCaptureDefinition;
      let nativeBasis: unknown;
      if (sort.source) {
        const prepared = await order!.prepare(sort, work.remaining());
        work.native(prepared.work);
        collection = prepared.collection;
        profile = collection.observation.basis.digest;
        definition = { kind: 'library', identity: sort.source };
        nativeBasis = {
          ...collection.observation,
          stamp: { ...collection.observation.stamp, position: collection.observation.stamp.position.toString() },
        };
      } else {
        if (hasOwner || !compiled) unavailable();
        const types = new Set(
          plan.leaves.flatMap((leaf) =>
            leaf.kind === 'catalogue' && leaf.clause.facet === 'type' ? leaf.clause.values : [],
          ),
        );
        const type = options?.type ?? (types.size === 1 ? [...types][0] : undefined);
        if (!type || !Object.hasOwn(nativeRelease.types, type)) unavailable();
        const meaning = { digest: selected.digest, release: nativeRelease, type };
        const binding = createPublicFilterSourceBinding(pool, reader.routeKey, reader.access);
        const native = publicFilterSource({ pool, routeKey: reader.routeKey, access: reader.access, clock });
        const resolved = await binding.resolve(
          {
            source: native,
            meaning,
            capture: {
              sort: 'id',
              filter: compiled.query,
              filterDocument: admitted,
              text: undefined,
              generation,
              size: 100,
            },
          },
          { deadline: reader.deadline },
        );
        work.public(resolved.cost);
        if (resolved.status !== 'resolved') unavailable();
        profile = digest([resolved.definition.readDefinition, resolved.definition.meaning.digest, type]);
        const { release: _body, ...meaningReference } = resolved.definition.meaning;
        definition = {
          kind: 'public',
          definition: { ...resolved.definition, meaning: meaningReference },
        };
        nativeBasis = definition;
      }
      const identity = digest({
        requested: filter,
        expanded: admitted,
        release: selected.digest,
        sort,
        profile,
        nativeBasis,
        actor: reader.actor,
        generation,
        index,
        uuid,
      });
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 262144 });
      await store.retain(identity, definition);
      await createScopePreparation({ pool, prefix, routeKey: reader.routeKey, access: reader.access, clock }).prepare(
        identity,
        reader.deadline,
        work,
      );
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 262144 });
      const observation = await readPreparedScopeObservation(pool, prefix, identity);
      if (
        !observation ||
        observation.key.scopeId !== identity ||
        !isDeepStrictEqual(
          observation.key.source,
          definition.kind === 'library'
            ? { kind: 'library', identity: definition.identity }
            : { kind: 'public', identity: definition.definition.source },
        )
      )
        unavailable();
      const basis = Object.freeze({
        release: selected.digest,
        query: identity,
        profile,
        canonical: observationDigest(observation),
        generation,
        index,
      });
      const value: ScopeState = { filter: admitted, plan, compiled, basis, uuid, observation, collection };
      await current(value, work);
      await current(value, work);
      const prepared: PreparedSearchScope = Object.freeze({
        [preparedScope]: true as const,
        readiness: 'ready',
        basis,
      });
      states.set(prepared, value);
      return prepared;
    },
    async prefix(
      prepared: PreparedSearchScope,
      request: {
        afterSubject: string | null;
        quota: number;
        budget: number;
        allowance?: WorkAllowance;
      },
    ): Promise<SearchScopePrefix> {
      const { afterSubject, quota, budget } = request;
      bounded(quota, 100, 1);
      bounded(budget, 256, 1);
      if (quota + 1 > budget) throw new RangeError('Reserve quota plus lookahead before dispatch');
      if (afterSubject !== null) subjectPartition(afterSubject);
      const value = state(prepared);
      if (value.collection || !value.compiled) unavailable();
      const root = request.allowance ?? scopeAllowance(budget, value.basis.query);
      const work = new ScopeWork({
        ...root,
        remaining: { ...root.remaining, candidateKeys: Math.min(budget, root.remaining.candidateKeys) },
      });
      await current(value, work);
      if (work.remaining().remaining.candidateKeys < quota + 1) unavailable();
      // One physical, count-free raw prefix. Lookahead is charged but not covered.
      work.consume({ ...zeroScopeWork(), statements: 1 });
      const result = await searchSubjectHits(client, prefix, {
        sort: 'id',
        filter: value.compiled.query,
        generation: value.basis.generation,
        size: quota + 1,
        work: engineWork(work),
        ...(afterSubject === null ? {} : { after: [afterSubject] }),
        overflowProperties: [
          ...new Set(
            value.plan.leaves.flatMap((leaf) =>
              leaf.kind === 'catalogue' && leaf.clause.facet === 'statement' ? [leaf.clause.property] : [],
            ),
          ),
        ],
      });
      work.consume({ ...zeroScopeWork(), candidateKeys: result.hits.length });
      await current(value, work);
      const hits = result.hits.slice(0, quota);
      return {
        hits,
        basis: value.basis,
        coveredThrough: hits.at(-1)?.id ?? afterSubject,
        exhausted: result.hits.length <= quota,
        usage: { candidates: result.hits.length, work: work.receipt() },
      };
    },
    async evaluate(
      prepared: PreparedSearchScope,
      subjects: readonly string[],
      reservation: ScopeEvaluationReservation,
    ): Promise<SearchScopeEvaluation> {
      if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation))
        throw new RangeError('Invalid evaluation reservation');
      bounded(reservation.rawKeys, 256);
      bounded(subjects.length, 256);
      nativeBudget(reservation.native);
      for (const subject of subjects) subjectPartition(subject);
      if (reservation.progress != null) {
        const pending = reservation.progress;
        subjectPartition(pending.subject);
        if (!subjects.includes(pending.subject)) throw new RangeError('Pending subject was not requested');
        if (typeof pending.basis !== 'string' || !/^[0-9a-f]{64}$/.test(pending.basis))
          throw new RangeError('Invalid owner basis');
        packScopeLeafProgress(pending, { valueCounts: Array.from({ length: 32 }, () => 64) });
      }
      const value = state(prepared);
      if (reservation.progress && reservation.progress.basis !== value.basis.query)
        throw new RangeError('Scope progress basis changed');
      const { native } = reservation;
      const supplied =
        reservation.allowance ??
        scopeAllowance(reservation.rawKeys, value.basis.query, {
          candidateKeys: reservation.rawKeys,
          nativeRows: native.rows,
          identityMetadataRows: 16384,
          emptySeeks: native.emptySeeks,
          nativePoints: native.points,
          witnessKeys: native.witnesses,
          statements: 8192,
          bytes: native.bytes,
        });
      const work = new ScopeWork({
        ...supplied,
        remaining: {
          ...supplied.remaining,
          candidateKeys: Math.min(reservation.rawKeys, supplied.remaining.candidateKeys),
          nativeRows: Math.min(native.rows, supplied.remaining.nativeRows),
          emptySeeks: Math.min(native.emptySeeks, supplied.remaining.emptySeeks),
          nativePoints: Math.min(native.points, supplied.remaining.nativePoints),
          witnessKeys: Math.min(native.witnesses, supplied.remaining.witnessKeys),
          bytes: Math.min(native.bytes, supplied.remaining.bytes),
        },
      });
      if (!work.leafBudget())
        return {
          values: subjects.map(() => 'not_proven'),
          basis: value.basis,
          usage: { keys: 0, native: { points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 } },
          evidence: [],
          progress: null,
        };
      await current(value, work);
      packScopeLeafProgress(reservation.progress ?? null, {
        valueCounts: value.plan.leaves.map((leaf) =>
          leaf.kind === 'catalogue' && 'values' in leaf.clause ? leaf.clause.values.length : 1,
        ),
      });
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
      const resume = await store.readLeafProgress(value.basis.query);
      const { resume: nextResume, ...checked } = await evaluateScopeSubjects({
        pool,
        options: context(),
        plan: value.plan,
        basis: value.basis.query,
        subjects,
        reservation,
        resume,
        work,
      });
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
      await store.saveLeafProgress(value.basis.query, nextResume);
      await current(value, work);
      const used = work.receipt().used;
      return {
        ...checked,
        basis: value.basis,
        usage: {
          keys: used.candidateKeys,
          native: {
            points: used.nativePoints,
            witnesses: used.witnessKeys,
            rows: used.nativeRows,
            bytes: used.bytes,
            emptySeeks: used.emptySeeks,
          },
        },
      };
    },
    async sourcePrefix(
      prepared: PreparedSearchScope,
      request: {
        afterSubjectId: string | null;
        allowance: WorkAllowance;
      },
    ) {
      if (request.afterSubjectId !== null) subjectPartition(request.afterSubjectId);
      const value = state(prepared);
      if (!value.collection || value.collection.order.kind !== 'id') unavailable();
      const work = new ScopeWork(request.allowance);
      await current(value, work);
      const page = await order!.prefix(value.collection, request.afterSubjectId, work.remaining());
      work.native(page.work);
      await current(value, work);
      return { ...page, basis: value.basis, work: work.receipt() };
    },
    /** Raw native ordinal input, CURRENT canonical membership and native fact evidence are
     * consumed in order. This direct preview never truncates raw rows then post-sorts them.
     */
    async ordinalPrefix(
      prepared: PreparedSearchScope,
      request: {
        after: NativeOrdinalKey | null;
        quota: number;
        allowance: WorkAllowance;
      },
    ): Promise<SearchScopeOrdinalPrefix> {
      bounded(request.quota, 100, 1);
      if (
        request.after !== null &&
        (!isOrdinalKey(request.after.ordinalKey) || routeOf(request.after.memberId) === null)
      )
        throw new RangeError('Invalid native ordinal position');
      const value = state(prepared);
      if (
        request.after !== null &&
        value.collection?.order.source &&
        routeOf(request.after.memberId) !== value.collection.order.source.route
      )
        throw new RangeError('Foreign native ordinal member');
      if (!value.collection || value.collection.order.kind !== 'ordinal') unavailable();
      const work = new ScopeWork(request.allowance);
      await current(value, work);
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 16384 });
      const retained = await store.ordinalState(value.basis.query, value.observation);
      if (!retained.complete) {
        // Each retry advances a retained, finite native frontier. No request scans the
        // collection to completion, and raw exhaustion alone never publishes a page.
        const limit = Math.min(1, work.remaining().remaining.candidateKeys);
        if (limit < 1) unavailable();
        const raw = await order!.rawOrdinal(value.collection, retained.frontier, limit, work.remaining());
        work.native(raw.work);
        const rows: { subject: string; after: NativeOrdinalKey }[] = [];
        for (const row of raw.rows) {
          if (row.deletionId || row.deletedAt) continue;
          // The point reader has two source/control collections. Reserve its fixed
          // per-key metadata footprint before dispatch; known-ID mapping is no scope proof.
          work.consume({
            ...zeroScopeWork(),
            candidateKeys: 1,
            identityMetadataRows: 16,
            nativePoints: 8,
            statements: 32,
            bytes: 8192,
          });
          const [mapping] = await readIdentityMappings(pool, [row.subjectId]);
          if (!mapping || mapping.state === 'pending' || mapping.state === 'unavailable') unavailable();
          if (mapping.state === 'absent') continue;
          const position = { ordinalKey: row.ordinalKey, memberId: row.memberId };
          const progress =
            retained.membership && isDeepStrictEqual(retained.membership.row, position)
              ? retained.membership.value
              : undefined;
          const membership = await order!.contains(value.collection, mapping.terminal, work.remaining(), progress);
          work.native(membership.work);
          if (membership.result === 'not_proven') {
            work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 8192 });
            await store.saveOrdinalMembership(
              value.basis.query,
              value.observation,
              membership.progress ? { row: position, value: membership.progress } : null,
            );
            unavailable();
          }
          if (!membership.result) continue;
          // Resolve BOTH the occurrence's actual original and terminal through the
          // same native leaf producer. Hidden/partial evidence is never an exclusion.
          const originals = row.subjectId === mapping.terminal ? [mapping.terminal] : [row.subjectId, mapping.terminal];
          work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
          const resume = await store.readLeafProgress(value.basis.query);
          const checked = await evaluateScopeSubjects({
            pool,
            options: context(),
            plan: value.plan,
            basis: value.basis.query,
            subjects: originals,
            resume,
            reservation: {
              progress: resume?.progress ?? null,
              rawKeys: work.remaining().remaining.candidateKeys,
              native: {
                points: work.remaining().remaining.nativePoints,
                witnesses: work.remaining().remaining.witnessKeys,
                rows: work.remaining().remaining.nativeRows,
                bytes: work.remaining().remaining.bytes,
                emptySeeks: work.remaining().remaining.emptySeeks,
              },
            },
            work,
          });
          work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
          await store.saveLeafProgress(value.basis.query, checked.resume);
          if (checked.values.includes('not_proven')) unavailable();
          if (checked.values.every((match) => match === true))
            rows.push({ subject: mapping.terminal, after: { ordinalKey: row.ordinalKey, memberId: row.memberId } });
        }
        if (!raw.exhausted && isDeepStrictEqual(raw.frontier.after, retained.frontier)) unavailable();
        await current(value, work);
        work.consume({
          ...zeroScopeWork(),
          statements: 4 + rows.length,
          nativeRows: 1 + rows.length,
          bytes: 8192 + rows.length * 512,
        });
        if (
          !(await store.advanceOrdinal(
            value.basis.query,
            value.basis.canonical,
            value.observation,
            retained.frontier,
            raw.frontier.after,
            raw.exhausted,
            rows,
          ))
        )
          unavailable();
        await current(value, work);
        if (!raw.exhausted) unavailable();
      }
      // SQL orders the retained canonical DISTINCT keys before output LIMIT. It does
      // not fetch the first raw N members and sort/filter a truncated array.
      if (
        work.remaining().remaining.candidateKeys < request.quota + 1 ||
        work.remaining().remaining.bytes < (request.quota + 1) * 512
      )
        unavailable();
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: request.quota + 1 });
      const page = await store.ordinalPage(value.basis.query, value.basis.canonical, request.after, request.quota + 1);
      work.consume({
        ...zeroScopeWork(),
        candidateKeys: page.length,
        bytes: Buffer.byteLength(JSON.stringify(page), 'utf8'),
      });
      const selected = page.slice(0, request.quota);
      for (const row of selected) {
        const progress =
          retained.membership && isDeepStrictEqual(retained.membership.row, row.after)
            ? retained.membership.value
            : undefined;
        const membership = await order!.contains(value.collection, row.subject, work.remaining(), progress);
        work.native(membership.work);
        if (membership.result === 'not_proven') {
          work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 8192 });
          await store.saveOrdinalMembership(
            value.basis.query,
            value.observation,
            membership.progress ? { row: row.after, value: membership.progress } : null,
          );
          unavailable();
        }
        if (membership.result !== true) unavailable();
      }
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
      const resume = await store.readLeafProgress(value.basis.query);
      const checked = await evaluateScopeSubjects({
        pool,
        options: context(),
        plan: value.plan,
        basis: value.basis.query,
        resume,
        subjects: selected.map((row) => row.subject),
        reservation: {
          progress: resume?.progress ?? null,
          rawKeys: work.remaining().remaining.candidateKeys,
          native: {
            points: work.remaining().remaining.nativePoints,
            witnesses: work.remaining().remaining.witnessKeys,
            rows: work.remaining().remaining.nativeRows,
            bytes: work.remaining().remaining.bytes,
            emptySeeks: work.remaining().remaining.emptySeeks,
          },
        },
        work,
      });
      work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
      await store.saveLeafProgress(value.basis.query, checked.resume);
      if (checked.values.some((match) => match !== true)) unavailable();
      await current(value, work);
      return {
        subjects: selected,
        frontier: { after: selected.at(-1)?.after ?? request.after },
        exhausted: page.length <= request.quota,
        observation: value.collection.observation,
        work: work.receipt(),
      };
    },
  };
}
