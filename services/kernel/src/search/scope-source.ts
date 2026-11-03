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
import type { CollectionSourceObservation, WorkAllowance, WorkReceipt } from '../library/collection-source.ts';
import type { NativeSourceIdentity } from '../library/native-source-custody.ts';
import { admitCollectionMemberQuery } from '../library/owner-filter.ts';
import { bindOwnerFilterRead } from '../library/owner-filter-plan.ts';
import { withOwnerFilterNativeRead } from '../library/owner-filter-native-binding.ts';
import { NativeCollectionWork } from '../library/collection-source-work.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { readRelease } from '../semantic/definitions.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import { createPublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import { publicFilterSource } from '../semantic/public-filter-source.ts';
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
import { createOrderedScopePreparation, readOrderedScopeRows } from './scope-preparation-ordered.ts';
import { createScopeOrderedNative } from './scope-ordered-native.ts';
import type { PublicFilterSourceDefinition } from '../semantic/public-filter-source-binding.ts';
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
import { createRealmScopeSource, type RealmSubjectSource } from './realm-scope.ts';
import { subjectPartition, type RelationFacetMatch, type SubjectSource } from './source.ts';
import {
  readCollectionKindPreparationWorkDefinition,
  readCollectionPublicationScopeWorkDefinition,
  readScopeWorkDefinition,
} from './scope-work-context.ts';
import type { ScopeLeafResume } from './scope-execution.ts';
import type { CollectionKindWorkDefinition } from '../library/collection-kind-work-admission.ts';
import type { CollectionPublicationWorkDefinition } from '../library/collection-publication-work-admission.ts';
import {
  firstMembersOrdinal,
  membersExecution,
  membersRelease,
  membersTerminal,
  readMembersSnapshot,
  runMembersWork,
  sameMembersSnapshot,
  type MembersExecution,
  type MembersWorkInput,
} from './scope-members-work.ts';
import { membersSource } from './scope-members-work-cost.ts';
import {
  compareScopeOrderedTuple,
  addScopePublicCost,
  emptyScopePublicCost,
  validateScopeOrderedHit,
  type ScopeOrderedDefinition,
  type ScopeOrderedPreparation,
  type ScopeNameSortTuple,
  type ScopeCollectionsSortTuple,
  validateScopeOrderedPrepare,
  validateScopeOrderedPrefix,
  type ScopeNativeOrder,
  type ScopeOrderedPrefixRequest,
  type SearchScopeOrderedPrefix,
} from './scope-ordered.ts';
export type {
  ScopeNativeOrder,
  ScopeNameSortTuple,
  ScopeCollectionsSortTuple,
  ScopeOrderedPrefixRequest,
  SearchScopeOrderedPrefix,
} from './scope-ordered.ts';

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
}> &
  (
    | Readonly<{ generation: number; index: string; nativeOwner?: never }>
    | Readonly<{
        nativeOwner: Readonly<{ source: NativeSourceIdentity; observation: CollectionSourceObservation }>;
        generation?: never;
        index?: never;
      }>
  );

/** Additive preparation controls; future metadata-budget fields belong on this same options object. */
export type ScopePrepareOptions = Readonly<{
  releaseDigest?: string;
  order?: SearchScopeOrder;
  /** Immutable native output definition; separate from structural Collection traversal. */
  nativeOrder?: ScopeNativeOrder;
  /** Required with nativeOrder, together with an explicit caller allowance. */
  pageSize?: number;
  /** Native caller's shared root; omitted legacy calls retain the bounded compatibility ceilings. */
  allowance?: WorkAllowance;
  /** Read an already published scope without retaining, preparing or saving reader progress. */
  readOnly?: boolean;
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
  usage: {
    candidates: number;
    work?: import('../library/collection-source.ts').WorkReceipt;
  };
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
  throw new ProblemError('semantic_not_ready', {
    headers: { 'retry-after': '1' },
  });
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
  return digest({
    ...observation,
    committedRevision: observation.committedRevision.toString(),
  });
}
type ScopeState = {
  filter: FilterDocument;
  plan: CurrentOwnerFilterPlan;
  compiled: ReturnType<typeof compileFilter> | null;
  basis: ScopeBasis;
  uuid: string | null;
  observation: IdentityScopeObservation;
  publicObservation: IdentityScopeObservation | null;
  collection: SearchScopeCollection | null;
  readOnly: boolean;
  ordered?: {
    definition: ScopeOrderedDefinition;
    publicDefinition: PublicFilterSourceDefinition;
    state: ScopeOrderedPreparation;
  };
  workDefinition?: CollectionKindWorkDefinition | CollectionPublicationWorkDefinition;
  workResume?: ScopeLeafResume | null;
  members?: MembersExecution;
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
  realmSubjects,
  clock = systemClock,
}: {
  pool: Pool;
  client: OpenSearch;
  prefix: string;
  source: SubjectSource;
  release?: () => Promise<FilterRelease | null>;
  evidence?: LeafOptions;
  realmSubjects?: RealmSubjectSource;
  clock?: KernelClock;
}) {
  const states = new WeakMap<PreparedSearchScope, ScopeState>();
  const receipts = new WeakMap<object, WorkReceipt>();
  function measured<T extends object>(value: T, work: ScopeWork): T {
    receipts.set(value, work.receipt());
    return value;
  }
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
  function membersFailure(error: unknown, work: ScopeWork): never {
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
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
    if (value.members) {
      try {
        const options = context();
        const members = value.members;
        if (
          options.work !== members.input.work ||
          !value.collection ||
          !value.basis.nativeOwner ||
          !isDeepStrictEqual(value.basis.nativeOwner.source, value.collection.order.source) ||
          !isDeepStrictEqual(value.basis.nativeOwner.observation, value.collection.observation)
        )
          unavailable();
        await runMembersWork(members.input, work, async (native) => {
          if (!sameMembersSnapshot(members.snapshot, await readMembersSnapshot(members.input, native))) unavailable();
        });
      } catch (error) {
        membersFailure(error, work);
      }
      return;
    }
    const options = context();
    async function currentNativeWork() {
      if (!options.work) return;
      const native = await readScopeWorkDefinition(options.work, { ...options, pool });
      if (!value.workDefinition || !isDeepStrictEqual(structuredClone(native), value.workDefinition)) unavailable();
    }
    await currentNativeWork();
    const result = await observations.revalidate({
      key: value.observation.key,
      expected: value.observation,
      deadline: options.deadline,
      ...(options.work ? { tx: options.work.tx } : {}),
    });
    work.identity(result.work);
    if (result.status !== 'current' || !sameScopeObservation(result.observation, value.observation)) unavailable();
    if (value.publicObservation) {
      const currentPublic = await observations.revalidate({
        key: value.publicObservation.key,
        expected: value.publicObservation,
        deadline: options.deadline,
      });
      work.identity(currentPublic.work);
      if (
        currentPublic.status !== 'current' ||
        !sameScopeObservation(currentPublic.observation, value.publicObservation)
      )
        unavailable();
    }
    if (
      value.basis.nativeOwner &&
      (!value.collection ||
        !isDeepStrictEqual(value.basis.nativeOwner.source, value.collection.order.source) ||
        !isDeepStrictEqual(value.basis.nativeOwner.observation, value.collection.observation))
    )
      unavailable();
    if (value.collection) {
      const refreshed = await order!.prepare(value.collection.order, work.remaining());
      work.native(refreshed.work);
      if (!isDeepStrictEqual(refreshed.collection.observation, value.collection.observation)) unavailable();
    }
    if (!value.basis.nativeOwner) {
      work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
      if ((await discoveryIndexUuid(client, value.basis.index, engineWork(work))) !== value.uuid) unavailable();
    }
    await currentNativeWork();
  }
  async function ownerContext(value: ScopeState, work: ScopeWork) {
    if (!value.plan.leaves.some((leaf) => leaf.kind === 'owner')) return undefined;
    const reader = context();
    if (reader.work) return undefined;
    const collection = value.collection;
    const identity = collection?.order.source;
    if (
      !collection ||
      !identity ||
      identity.scope === 'public_output' ||
      reader.actor.kind !== 'account' ||
      reader.actor.accountId !== identity.accountId ||
      routeOf(reader.actor.accountId) !== identity.route
    )
      unavailable();
    // Family admission checks every private branch before looking up native evidence.
    // It is repeated on each use; no provider/Actor is restored from durable state.
    work.consume({ ...zeroScopeWork(), statements: 128, nativePoints: 128, nativeRows: 8192, bytes: 1024 * 1024 });
    const admission = await admitCollectionMemberQuery(
      { pool, access: reader.access, clock },
      reader.actor,
      { filter: JSON.stringify(value.filter), sort: 'id' },
      reader.deadline,
    );
    if (
      !admission.owner ||
      admission.releaseDigest !== value.basis.release ||
      !isDeepStrictEqual(admission.filter, value.filter)
    )
      unavailable();
    if (!reader.nativeT) unavailable();
    const nativeWork = new NativeCollectionWork(work.remaining(), reader.deadline);
    const bound = await (async () => {
      try {
        const captured = value.ordered?.state;
        const query = captured?.queried && captured.execution ? {
          filter: value.filter,
          source: publicFilterSource({ pool, routeKey: reader.routeKey, access: reader.access, clock }),
          binding: createPublicFilterSourceBinding(pool, reader.routeKey, reader.access),
          queried: captured.queried,
          execution: captured.execution,
        } : undefined;
        return await withOwnerFilterNativeRead({ actor: reader.actor, at: reader.nativeT!, work: nativeWork,
          ...(query ? { query } : {}),
        }, () =>
          bindOwnerFilterRead(
            { pool, access: reader.access, routeKey: reader.routeKey, clock },
            reader.actor,
            identity.collectionId,
            admission,
            reader.deadline,
          ),
        );
      } finally {
        work.native(nativeWork.receipt());
      }
    })();
    if (
      bound.status !== 'bound' ||
      bound.binding.input.actor !== reader.actor ||
      bound.binding.input.collectionId !== identity.collectionId ||
      bound.binding.input.deadline > reader.deadline ||
      !isDeepStrictEqual(bound.binding.scope.key.source, value.observation.key.source)
    )
      unavailable();
    const currentOwner = await observations.revalidate({
      key: bound.binding.scope.key,
      expected: bound.binding.scope,
      deadline: reader.deadline,
    });
    work.identity(currentOwner.work);
    if (currentOwner.status !== 'current' || !sameScopeObservation(currentOwner.observation, bound.binding.scope))
      unavailable();
    return { admission, binding: bound.binding, source: collection.source };
  }
  return {
    realm: createRealmScopeSource({
      pool,
      ...(evidence ? { reader: evidence } : {}),
      ...(realmSubjects ? { source: realmSubjects } : {}),
      release: (digest) => readSearchScopeRelease(pool, digest),
    }),
    /** Additive native caller accounting; opaque result shapes and the legacy evaluation ABI stay unchanged. */
    work(result: PreparedSearchScope | SearchScopeEvaluation): WorkReceipt {
      const receipt = receipts.get(result);
      if (!receipt) throw new TypeError('Foreign Search scope result');
      return receipt;
    },
    async prepare(filter: FilterDocument, options?: ScopePrepareOptions): Promise<PreparedSearchScope> {
      if (options?.nativeOrder !== undefined || options?.pageSize !== undefined) {
        validateScopeOrderedPrepare(options);
        // Missing reader context still refuses before ANY Source or release I/O.
        context();
        // Native work definitions currently retain only structural input order. A Core
        // locator cannot authorize caller-chosen output fields absent from that definition.
        if (evidence?.work) throw new ProblemError('dependency_unavailable');
      }
      if (evidence?.work?.kind === 'members-preparation') {
        context();
        const work = new ScopeWork(options?.allowance ?? scopeAllowance(256, 'scope.prepare'));
        const input: MembersWorkInput = {
          pool,
          access: evidence.access,
          deadline: evidence.deadline,
          work: evidence.work,
        };
        try {
          const snapshot = await runMembersWork(input, work, (native) => readMembersSnapshot(input, native));
          const { native } = snapshot;
          const nativeOrder: SearchScopeOrder = { kind: native.definition.sort, source: native.sourceIdentity };
          // Caller fields are compatibility hints only. Retain ALL native fields, including the release body.
          if (
            !isDeepStrictEqual(filter, native.definition.filter) ||
            (options?.releaseDigest !== undefined && options.releaseDigest !== native.definition.release.digest) ||
            (options?.order !== undefined && !isDeepStrictEqual(options.order, nativeOrder))
          )
            unavailable();
          const body = await runMembersWork(input, work, (budget) =>
            membersRelease(input, budget, native.definition.release.digest),
          );
          if (!body || !isDeepStrictEqual(body, native.definition.release.value)) unavailable();
          const admitted = admitFilter(parseFilter(native.definition.filter), body, { owner: true, saved: true });
          if (!isDeepStrictEqual(admitted, native.definition.filter)) unavailable();
          const plan = compileCurrentOwnerFilter(admitted);
          // No public capture or index proof is supplied by Members admission. Refuse the exact missing
          // evidence before any foreign checkout, even if an owner OR branch could evaluate true.
          if (!plan.leaves.length || plan.leaves.some((leaf) => leaf.kind !== 'owner'))
            throw new ProblemError('dependency_unavailable');
          const preparedOrder = await runMembersWork(input, work, (budget) =>
            membersSource(budget, 4, (allowance) => order!.prepare(nativeOrder, allowance)),
          );
          if (!isDeepStrictEqual(preparedOrder.collection.observation, native.observation)) unavailable();
          const query = digest({
            filter: admitted,
            release: native.definition.release.digest,
            order: nativeOrder,
            locator: input.work.locator,
            source: {
              ...native.observation,
              stamp: { ...native.observation.stamp, position: native.observation.stamp.position.toString() },
            },
            scope: observationDigest(snapshot.observation),
            ownerFence: snapshot.ownerFence,
          });
          const basis: ScopeBasis = Object.freeze({
            release: native.definition.release.digest,
            query,
            profile: native.observation.basis.digest,
            canonical: observationDigest(snapshot.observation),
            nativeOwner: Object.freeze({
              source: structuredClone(native.sourceIdentity),
              observation: structuredClone(native.observation),
            }),
          });
          const value: ScopeState = {
            filter: structuredClone(admitted),
            plan,
            compiled: null,
            basis,
            uuid: null,
            observation: snapshot.observation,
            publicObservation: null,
            collection: preparedOrder.collection,
            readOnly: false,
            members: membersExecution(input, snapshot, plan, query, body),
            workResume: null,
          };
          await current(value, work);
          const prepared: PreparedSearchScope = Object.freeze({
            [preparedScope]: true as const,
            readiness: 'ready',
            basis,
          });
          states.set(prepared, value);
          return measured(prepared, work);
        } catch (error) {
          membersFailure(error, work);
        }
      }
      const publicationWorkDefinition =
        evidence?.work?.kind === 'collection-publication'
          ? structuredClone(await readCollectionPublicationScopeWorkDefinition(evidence.work, { ...evidence, pool }))
          : undefined;
      const workDefinition =
        publicationWorkDefinition ??
        (evidence?.work?.kind === 'collection-kind-preparation'
          ? structuredClone(await readCollectionKindPreparationWorkDefinition(evidence.work, { ...evidence, pool }))
          : undefined);
      if (workDefinition) {
        const nativeOrder: SearchScopeOrder = { kind: 'id', source: workDefinition.sourceIdentity };
        if (
          (publicationWorkDefinition && !isDeepStrictEqual(filter, publicationWorkDefinition.definition.filter)) ||
          (options?.releaseDigest !== undefined && options.releaseDigest !== workDefinition.releaseDigest) ||
          (options?.order !== undefined && !isDeepStrictEqual(options.order, nativeOrder))
        )
          unavailable();
        // Kind's default predicate remains Library-owned. Search admits the supplied query
        // against the native pinned release and exact source, using the ordinary interpreter.
        options = { ...options, releaseDigest: workDefinition.releaseDigest, order: nativeOrder };
      }
      const work = new ScopeWork(options?.allowance ?? scopeAllowance(256, 'scope.prepare'));
      function releaseWork() {
        work.consume({
          ...zeroScopeWork(),
          statements: 1,
          nativeRows: 1,
          nativePoints: 1,
          bytes: 262144,
        });
      }
      async function selectRelease() {
        releaseWork();
        if (workDefinition && evidence?.work) {
          const release = await readRelease(evidence.work.tx, workDefinition.releaseDigest);
          return release ? { digest: workDefinition.releaseDigest, release } : null;
        }
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
            errors: error.errors.map(({ pointer, code }) => ({
              pointer: `/filter${pointer}`,
              code,
            })),
          });
        throw error;
      }
      const reader = context();
      selected ??= await selectRelease();
      if (!selected) unavailable();
      releaseWork();
      const nativeRelease = await readRelease(evidence?.work?.tx ?? pool, selected.digest);
      if (
        !nativeRelease ||
        (injectedBody !== undefined && !isDeepStrictEqual(injectedBody, nativeRelease)) ||
        (publicationWorkDefinition &&
          !isDeepStrictEqual(publicationWorkDefinition.definition.release.value, nativeRelease))
      )
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
      if (hasOwner && workDefinition?.sourceIdentity.scope === 'public_output') unavailable();
      const pureOwner = !options?.nativeOrder && hasOwner && plan.leaves.every((leaf) => leaf.kind === 'owner');
      if (hasOwner && !options?.order?.source) unavailable();
      const compiled = hasOwner ? null : compileFilter(admitted, { prefix: 'f', relationOverflow: true });
      // A native Collection order has its own real source generation. Public physical
      // index discovery belongs only to plans which actually consume public evidence.
      let indexed: Readonly<{ generation: number; index: string; uuid: string }> | null = null;
      if (!pureOwner) {
        work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
        const generations = await subjectGenerations(client, prefix, engineWork(work));
        if (generations.active === null) unavailable();
        const generation = generations.active;
        const index = subjectIndexName(prefix, generation);
        work.consume({ ...zeroScopeWork(), statements: 1, nativePoints: 1 });
        const uuid = await discoveryIndexUuid(client, index, engineWork(work));
        indexed = { generation, index, uuid };
      }
      const sort: SearchScopeOrder = structuredClone(options?.order ?? { kind: 'id' });
      let collection: SearchScopeCollection | null = null;
      let profile: string;
      let definition: ScopeCaptureDefinition;
      let nativeBasis: unknown;
      let orderedPublicDefinition: PublicFilterSourceDefinition | undefined;
      const outputDefinition: ScopeOrderedDefinition | undefined =
        options?.nativeOrder && indexed
          ? {
              nativeOrder: options.nativeOrder,
              pageSize: options.pageSize!,
              ...indexed,
            }
          : undefined;
      if (sort.source) {
        const prepared = await order!.prepare(sort, work.remaining());
        work.native(prepared.work);
        collection = prepared.collection;
        profile = collection.observation.basis.digest;
        definition = {
          kind: 'library',
          identity: sort.source,
          ...(outputDefinition
            ? { nativeOutput: { nativeOrder: outputDefinition.nativeOrder, pageSize: outputDefinition.pageSize } }
            : {}),
        };
        nativeBasis = {
          ...collection.observation,
          stamp: {
            ...collection.observation.stamp,
            position: collection.observation.stamp.position.toString(),
          },
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
        const meaning = {
          digest: selected.digest,
          release: nativeRelease,
          type,
        };
        const binding = createPublicFilterSourceBinding(pool, reader.routeKey, reader.access);
        const native = publicFilterSource({
          pool,
          routeKey: reader.routeKey,
          access: reader.access,
          clock,
        });
        const resolved = await binding.resolve(
          {
            source: native,
            meaning,
            capture: {
              sort: options?.nativeOrder ?? 'id',
              ...(options?.nativeOrder ? { pageSize: options.pageSize } : {}),
              filter: compiled.query,
              filterDocument: admitted,
              text: undefined,
              generation: indexed!.generation,
              size: 100,
            },
          },
          { deadline: reader.deadline },
        );
        work.public(resolved.cost);
        if (resolved.status !== 'resolved') unavailable();
        orderedPublicDefinition = resolved.definition;
        profile = digest([resolved.definition.readDefinition, resolved.definition.meaning.digest, type]);
        const { release: _body, ...meaningReference } = resolved.definition.meaning;
        definition = {
          kind: 'public',
          definition: { ...resolved.definition, meaning: meaningReference },
          ...(outputDefinition ? { ordered: outputDefinition } : {}),
        };
        nativeBasis = definition;
      }
      let publicObservation: IdentityScopeObservation | null = null;
      if ((hasOwner && !pureOwner) || (collection && options?.nativeOrder)) {
        // Capture the real public projection independently of the private Collection.
        // A true owner branch never substitutes for public source/index authority.
        const types = new Set(
          plan.leaves.flatMap((leaf) =>
            leaf.kind === 'catalogue' && leaf.clause.facet === 'type' ? leaf.clause.values : [],
          ),
        );
        const type = options?.type ?? (types.size === 1 ? [...types][0] : undefined);
        if (!type || !Object.hasOwn(nativeRelease.types, type) || !indexed) unavailable();
        // This metadata capture includes every expanded catalogue dependency, including
        // negated/excluded branches. It cannot assert the private predicate's membership.
        const catalogueLeaves: FilterDocument[] = plan.leaves.flatMap((leaf) => {
          if (leaf.kind !== 'catalogue') return [];
          const clause = leaf.clause;
          return [
            clause.facet === 'type'
              ? { type: { in: [...clause.values] } }
              : {
                  statement: {
                    property: clause.property,
                    ...('values' in clause ? { in: [...clause.values] } : { range: clause.range }),
                    ...(clause.qualifiers ? { qualifiers: [...clause.qualifiers] } : {}),
                  },
                },
          ];
        });
        const publicFilter: FilterDocument = !hasOwner
          ? admitted
          : catalogueLeaves.length
            ? { or: [{ type: { in: [type] } }, ...catalogueLeaves] }
            : { type: { in: [type] } };
        const publicQuery = compileFilter(publicFilter, { prefix: 'f', relationOverflow: true });
        const binding = createPublicFilterSourceBinding(pool, reader.routeKey, reader.access);
        const resolved = await binding.resolve(
          {
            source: publicFilterSource({ pool, routeKey: reader.routeKey, access: reader.access, clock }),
            meaning: { digest: selected.digest, release: nativeRelease, type },
            capture: {
              sort: options?.nativeOrder ?? 'id',
              ...(options?.nativeOrder ? { pageSize: options.pageSize } : {}),
              filter: publicQuery.query,
              filterDocument: publicFilter,
              text: undefined,
              generation: indexed.generation,
              size: 100,
            },
          },
          { deadline: reader.deadline },
        );
        work.public(resolved.cost);
        if (resolved.status !== 'resolved') unavailable();
        const { release: _body, ...meaningReference } = resolved.definition.meaning;
        orderedPublicDefinition = resolved.definition;
        const publicDefinition: ScopeCaptureDefinition = {
          kind: 'public',
          definition: { ...resolved.definition, meaning: meaningReference },
        };
        const publicIdentity = digest({
          definition: publicDefinition,
          release: selected.digest,
          indexed,
          ...(reader.work ? { work: reader.work.locator } : { actor: reader.actor }),
          collection: nativeBasis,
          filter: admitted,
        });
        if (workDefinition && reader.work) {
          const current = await readScopeWorkDefinition(reader.work, { ...reader, pool });
          if (!isDeepStrictEqual(structuredClone(current), workDefinition)) unavailable();
        }
        work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 262144 });
        await store.retain(publicIdentity, publicDefinition);
        await createScopePreparation({ pool, prefix, routeKey: reader.routeKey, access: reader.access, clock }).prepare(
          publicIdentity,
          reader.deadline,
          work,
        );
        work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 262144 });
        publicObservation = await readPreparedScopeObservation(pool, prefix, publicIdentity);
        if (
          !publicObservation ||
          publicObservation.key.scopeId !== publicIdentity ||
          !isDeepStrictEqual(publicObservation.key.source, { kind: 'public', identity: resolved.definition.source })
        )
          unavailable();
      }
      const identity = digest({
        requested: filter,
        expanded: admitted,
        release: selected.digest,
        sort,
        ...(outputDefinition ? { output: outputDefinition } : {}),
        profile,
        nativeBasis,
        ...(reader.work ? { work: reader.work.locator } : { actor: reader.actor }),
        ...(indexed ?? { nativeOwner: { source: sort.source, observation: nativeBasis } }),
        ...(publicObservation ? { publicScope: observationDigest(publicObservation) } : {}),
      });
      if (!options?.readOnly && !workDefinition) {
        work.consume({
          ...zeroScopeWork(),
          statements: 1,
          nativeRows: 1,
          bytes: 262144,
        });
        await store.retain(identity, definition);
        await createScopePreparation({
          pool,
          prefix,
          routeKey: reader.routeKey,
          access: reader.access,
          clock,
          search: client,
        }).prepare(identity, reader.deadline, work);
      }
      if (!workDefinition)
        work.consume({
          ...zeroScopeWork(),
          statements: 1,
          nativeRows: 1,
          bytes: 262144,
        });
      const observation =
        workDefinition?.identityObservation ?? (await readPreparedScopeObservation(pool, prefix, identity));
      if (
        !observation ||
        (!workDefinition && observation.key.scopeId !== identity) ||
        !isDeepStrictEqual(
          observation.key.source,
          definition.kind === 'library'
            ? { kind: 'library', identity: definition.identity }
            : { kind: 'public', identity: definition.definition.source },
        )
      )
        unavailable();
      const basis: ScopeBasis = Object.freeze({
        release: selected.digest,
        query: identity,
        profile,
        canonical: publicObservation
          ? digest([observationDigest(observation), observationDigest(publicObservation)])
          : observationDigest(observation),
        ...(indexed
          ? { generation: indexed.generation, index: indexed.index }
          : {
              nativeOwner: Object.freeze({
                source: structuredClone(sort.source!),
                observation: structuredClone(collection!.observation),
              }),
            }),
      });
      const value: ScopeState = {
        filter: admitted,
        plan,
        compiled,
        basis,
        uuid: indexed?.uuid ?? null,
        observation,
        publicObservation,
        collection,
        readOnly: options?.readOnly === true,
        ...(outputDefinition && orderedPublicDefinition
          ? {
              ordered: {
                definition: outputDefinition,
                publicDefinition: orderedPublicDefinition,
                state: { queried: null, repair: null, execution: null },
              },
            }
          : {}),
        ...(workDefinition ? { workDefinition, workResume: null } : {}),
      };
      await current(value, work);
      await ownerContext(value, work);
      await current(value, work);
      const prepared: PreparedSearchScope = Object.freeze({
        [preparedScope]: true as const,
        readiness: 'ready',
        basis,
      });
      states.set(prepared, value);
      return measured(prepared, work);
    },
    async orderedPrefix(
      prepared: PreparedSearchScope,
      request: ScopeOrderedPrefixRequest,
    ): Promise<SearchScopeOrderedPrefix> {
      validateScopeOrderedPrefix(request);
      const value = state(prepared);
      const captured = value.ordered;
      if (
        !captured ||
        captured.definition.nativeOrder !== request.order ||
        request.quota > captured.definition.pageSize ||
        value.basis.nativeOwner
      )
        unavailable();
      const work = new ScopeWork({
        ...request.allowance,
        remaining: {
          ...request.allowance.remaining,
          candidateKeys: Math.min(
            request.budget,
            value.collection
              ? Math.min(600, 6 * captured.definition.pageSize + 3)
              : 2 * captured.definition.pageSize + 2,
            request.allowance.remaining.candidateKeys,
          ),
        },
      });
      let publicCost = emptyScopePublicCost();
      const reader = context();
      const native = createScopeOrderedNative({
        pool,
        search: client,
        prefix,
        clock,
        source: publicFilterSource({ pool, routeKey: reader.routeKey, access: reader.access, clock }),
        binding: createPublicFilterSourceBinding(pool, reader.routeKey, reader.access),
        meaning: captured.publicDefinition.meaning,
        definition: captured.definition,
      });
      try {
        await current(value, work);
        let rows: readonly SearchHit[];
        if (value.collection) {
          // Native-owner input traversal remains ID/ordinal population order. A direct
          // output plan is admitted only when that actual bounded input is exhausted.
          // Larger owner results need Library's admitted owner/namespace preparation.
          if (value.collection.order.kind === 'ordinal') {
            const limit = Math.min(99, work.remaining().remaining.candidateKeys);
            if (limit < 1) unavailable();
            const raw = await order!.rawOrdinal(value.collection, null, limit, work.remaining());
            work.native(raw.work);
            if (!raw.exhausted) unavailable();
          }
          // Canonical population settlement is the native Source's responsibility,
          // after the requested structural input traversal has proved completeness.
          const population = await order!.prefix(value.collection, null, work.remaining());
          work.native(population.work);
          if (!population.exhausted || population.candidates.length > 99) unavailable();
          const capture = await native.capture(
            captured.publicDefinition.capture,
            captured.state,
            work,
            reader.deadline,
          );
          publicCost = addScopePublicCost(publicCost, capture.cost);
          captured.state = capture.state;
          if (!capture.ready) unavailable();
          const keys = population.candidates.map((row) => row.subjectId);
          const checked = await native.keys(captured.state, keys, work, reader.deadline, keys.length ? undefined : []);
          if (checked) {
            captured.state = checked.state;
            publicCost = addScopePublicCost(publicCost, checked.cost);
          }
          const hits = checked?.hits ?? [];
          const evaluated = await evaluateScopeSubjects({
            pool,
            options: reader,
            owner: await ownerContext(value, work),
            plan: value.plan,
            basis: value.basis.query,
            subjects: hits.map((hit) => hit.id),
            reservation: {
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
          if (evaluated.values.some((match) => match === 'not_proven')) unavailable();
          rows = hits.filter((_, i) => evaluated.values[i] === true);
          // Native keys are already sorted. The cursor is applied only after the complete
          // bounded population and current predicate have settled, never after a UUID LIMIT.
          if (request.after)
            rows = rows.filter((hit) => compareScopeOrderedTuple(request.order, hit.sort, request.after!) > 0);
          rows = rows.slice(0, request.quota + 1);
        } else {
          const retained = createOrderedScopePreparation({
            pool,
            prefix,
            search: client,
            routeKey: reader.routeKey,
            access: reader.access,
            clock,
          });
          const nativeState = await retained.state(value.basis.query, work);
          if (!nativeState.queried || !nativeState.populationComplete) unavailable();
          captured.state = nativeState;
          publicCost = addScopePublicCost(publicCost, await native.validate(nativeState, work, reader.deadline));
          rows = await readOrderedScopeRows(
            pool,
            prefix,
            value.basis.query,
            request.order,
            request.after,
            request.quota + 1,
            work,
          );
          const checked = await native.keys(
            nativeState,
            rows.map((hit) => hit.id),
            work,
            reader.deadline,
            rows,
          );
          publicCost = addScopePublicCost(publicCost, checked.cost);
          captured.state = checked.state;
          if (checked.hits.length !== rows.length) unavailable();
        }
        for (const hit of rows) validateScopeOrderedHit(request.order, hit, captured.definition.index);
        await current(value, work);
        publicCost = addScopePublicCost(publicCost, await native.validate(captured.state, work, reader.deadline));
        const selected = rows.slice(0, request.quota);
        publicCost = addScopePublicCost(publicCost, { ...emptyScopePublicCost(), outputSlots: selected.length });
        const usage = { candidates: work.receipt().used.candidateKeys, work: work.receipt(), public: publicCost };
        // Keep native Hits intact and expose the discriminated exact tuple only after validation.
        if (request.order === 'name')
          return {
            order: 'name',
            hits: selected as unknown as (Omit<SearchHit, 'sort'> & { sort: ScopeNameSortTuple })[],
            basis: value.basis,
            coveredThrough: (selected.at(-1)?.sort as unknown as ScopeNameSortTuple) ?? request.after,
            exhausted: rows.length <= request.quota,
            usage,
          };
        return {
          order: 'collections',
          hits: selected as unknown as (Omit<SearchHit, 'sort'> & { sort: ScopeCollectionsSortTuple })[],
          basis: value.basis,
          coveredThrough: (selected.at(-1)?.sort as unknown as ScopeCollectionsSortTuple) ?? request.after,
          exhausted: rows.length <= request.quota,
          usage,
        };
      } catch (error) {
        // Dispatched work is settled once by the caller even when Source refuses disclosure.
        if (error && typeof error === 'object')
          Object.defineProperty(error, 'work', { value: work.receipt(), configurable: true });
        throw error;
      }
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
      if (value.collection || !value.compiled || value.basis.nativeOwner) unavailable();
      const root = request.allowance ?? scopeAllowance(budget, value.basis.query);
      const work = new ScopeWork({
        ...root,
        remaining: {
          ...root.remaining,
          candidateKeys: Math.min(budget, root.remaining.candidateKeys),
        },
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
        packScopeLeafProgress(pending, {
          valueCounts: Array.from({ length: 32 }, () => 64),
        });
      }
      const value = state(prepared);
      if (reservation.progress && reservation.progress.basis !== value.basis.query)
        throw new RangeError('Scope progress basis changed');
      if (value.members && reservation.progress) {
        const pending = reservation.progress;
        if (
          pending.leafOrdinal !== 0 ||
          pending.valueOrdinal !== 0 ||
          pending.phase !== 'selection' ||
          pending.after === null ||
          !/^(?:0|[1-9][0-9]?|100)$/.test(pending.after)
        )
          throw new RangeError('Invalid Members raw progress');
      }
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
      if (value.members) await current(value, work);
      if (!work.leafBudget())
        return measured(
          {
            values: subjects.map(() => 'not_proven'),
            basis: value.basis,
            usage: {
              keys: value.members ? work.receipt().used.candidateKeys : 0,
              native: {
                points: value.members ? work.receipt().used.nativePoints : 0,
                witnesses: value.members ? work.receipt().used.witnessKeys : 0,
                rows: value.members ? work.receipt().used.nativeRows : 0,
                bytes: value.members ? work.receipt().used.bytes : 0,
                emptySeeks: value.members ? work.receipt().used.emptySeeks : 0,
              },
            },
            evidence: [],
            progress: null,
          },
          work,
        );
      await current(value, work);
      packScopeLeafProgress(reservation.progress ?? null, {
        valueCounts: value.plan.leaves.map((leaf) =>
          leaf.kind === 'catalogue' && 'values' in leaf.clause ? leaf.clause.values.length : 1,
        ),
      });
      if (!value.readOnly && !value.workDefinition && !value.members)
        work.consume({
          ...zeroScopeWork(),
          statements: 1,
          nativeRows: 1,
          bytes: 4096,
        });
      const resume = value.readOnly
        ? null
        : value.workDefinition || value.members
          ? (value.workResume ?? null)
          : await store.readLeafProgress(value.basis.query);
      const { resume: nextResume, ...checked } = await evaluateScopeSubjects({
        pool,
        options: context(),
        owner: await ownerContext(value, work),
        ...(value.members ? { members: value.members } : {}),
        plan: value.plan,
        basis: value.basis.query,
        subjects,
        reservation,
        resume,
        work,
      });
      if (!value.readOnly) {
        await current(value, work);
        if (value.workDefinition || value.members) value.workResume = nextResume;
        else {
          work.consume({ ...zeroScopeWork(), statements: 1, nativeRows: 1, bytes: 4096 });
          await store.saveLeafProgress(value.basis.query, nextResume);
        }
      }
      await current(value, work);
      const used = work.receipt().used;
      return measured(
        {
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
        },
        work,
      );
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
      const page = value.members
        ? await runMembersWork(value.members.input, work, (budget) =>
            membersSource(budget, 4, (allowance) =>
              order!.prefix(value.collection!, request.afterSubjectId, allowance),
            ),
          )
        : await order!.prefix(value.collection, request.afterSubjectId, work.remaining());
      if (!value.members) work.native(page.work);
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
      if (!value.collection || value.collection.order.kind !== 'ordinal' || value.readOnly) unavailable();
      const work = new ScopeWork(request.allowance);
      await current(value, work);
      if (value.members) {
        const members = value.members;
        // One fixed raw window, including deletions/rejections. Unknown work stops before that raw slot.
        const limit = Math.min(request.quota, work.remaining().remaining.candidateKeys);
        if (limit < 1) membersFailure(new ProblemError('dependency_unavailable'), work);
        const raw = await runMembersWork(members.input, work, (budget) =>
          membersSource(budget, 4, (allowance) =>
            order!.rawOrdinal(value.collection!, request.after, limit, allowance),
          ),
        );
        const subjects: { subject: string; after: NativeOrdinalKey }[] = [];
        let after = request.after;
        let unknown = false;
        for (const row of raw.rows) {
          const position = { ordinalKey: row.ordinalKey, memberId: row.memberId };
          if (row.deletionId || row.deletedAt) {
            after = position;
            continue;
          }
          const terminal = await runMembersWork(members.input, work, (budget) =>
            membersTerminal(members, row.subjectId, budget),
          );
          if (!terminal) {
            unknown = true;
            break;
          }
          const first = await runMembersWork(members.input, work, (budget) =>
            firstMembersOrdinal(members, terminal, budget),
          );
          if (!first) {
            unknown = true;
            break;
          }
          if (!isDeepStrictEqual(position, first)) {
            after = position;
            continue;
          }
          const remaining = work.remaining().remaining;
          const checked = await evaluateScopeSubjects({
            pool,
            options: context(),
            plan: value.plan,
            members,
            basis: value.basis.query,
            subjects: [terminal],
            resume: value.workResume ?? null,
            reservation: {
              rawKeys: remaining.candidateKeys,
              native: {
                points: remaining.nativePoints,
                witnesses: remaining.witnessKeys,
                rows: remaining.nativeRows,
                bytes: remaining.bytes,
                emptySeeks: remaining.emptySeeks,
              },
            },
            work,
          });
          value.workResume = checked.resume;
          if (checked.values[0] === 'not_proven') {
            unknown = true;
            break;
          }
          if (checked.values[0] === true) subjects.push({ subject: terminal, after: position });
          after = position;
        }
        await current(value, work);
        return {
          subjects,
          frontier: { after },
          exhausted: !unknown && raw.exhausted && isDeepStrictEqual(after, raw.frontier.after),
          observation: value.collection.observation,
          work: work.receipt(),
        };
      }
      work.consume({
        ...zeroScopeWork(),
        statements: 1,
        nativeRows: 1,
        bytes: 16384,
      });
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
          const position = {
            ordinalKey: row.ordinalKey,
            memberId: row.memberId,
          };
          const progress =
            retained.membership && isDeepStrictEqual(retained.membership.row, position)
              ? retained.membership.value
              : undefined;
          const membership = await order!.contains(value.collection, mapping.terminal, work.remaining(), progress);
          work.native(membership.work);
          if (membership.result === 'not_proven') {
            await current(value, work);
            work.consume({
              ...zeroScopeWork(),
              statements: 1,
              nativeRows: 1,
              bytes: 8192,
            });
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
          work.consume({
            ...zeroScopeWork(),
            statements: 1,
            nativeRows: 1,
            bytes: 4096,
          });
          const resume = await store.readLeafProgress(value.basis.query);
          const checked = await evaluateScopeSubjects({
            pool,
            options: context(),
            owner: await ownerContext(value, work),
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
          await current(value, work);
          work.consume({
            ...zeroScopeWork(),
            statements: 1,
            nativeRows: 1,
            bytes: 4096,
          });
          await store.saveLeafProgress(value.basis.query, checked.resume);
          if (checked.values.includes('not_proven')) unavailable();
          if (checked.values.every((match) => match === true))
            rows.push({
              subject: mapping.terminal,
              after: { ordinalKey: row.ordinalKey, memberId: row.memberId },
            });
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
      work.consume({
        ...zeroScopeWork(),
        statements: 1,
        nativeRows: request.quota + 1,
      });
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
          work.consume({
            ...zeroScopeWork(),
            statements: 1,
            nativeRows: 1,
            bytes: 8192,
          });
          await store.saveOrdinalMembership(
            value.basis.query,
            value.observation,
            membership.progress ? { row: row.after, value: membership.progress } : null,
          );
          unavailable();
        }
        if (membership.result !== true) unavailable();
      }
      work.consume({
        ...zeroScopeWork(),
        statements: 1,
        nativeRows: 1,
        bytes: 4096,
      });
      const resume = await store.readLeafProgress(value.basis.query);
      const checked = await evaluateScopeSubjects({
        pool,
        options: context(),
        owner: await ownerContext(value, work),
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
      work.consume({
        ...zeroScopeWork(),
        statements: 1,
        nativeRows: 1,
        bytes: 4096,
      });
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
