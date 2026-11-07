import type { Release } from '@rezics/definitions';
import canonicalize from 'canonicalize';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import type { CommandAttempt } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { parseStrictJson } from '../http/strict-json.ts';
import type { Access, Actor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { currentOwnerClauseKey } from '../search/current-filter-plan.ts';
import type { RelationFacetMatch } from '../search/source.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import type { LeafEvidence } from '../semantic/scope-leaf-evidence.ts';
import { decodeListCursor, encodeListCursor, type ListCursorBinding } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import type { NativeOwnerFilterCeilings } from './owner-filter-native-binding.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import {
  createOrdinaryCollectionPageSource,
  type CollectionSourceObservation,
  type PrepareCollectionSource,
  type PreparedCollectionSource,
} from './collection-source.ts';
import { type WorkDimensions } from './contract/work-dimensions.ts';
import { NativeCollectionWork } from './collection-native-work.ts';
import {
  admitCollectionMemberQuery,
  type CollectionMemberAdmission,
  type CollectionMemberQuery,
  type OwnerFilterFactLocator,
} from './owner-filter.ts';
import { readNativeCollectionMemberAdmission } from './owner-filter-admission.ts';
import { ordinaryCollectionPagePlan, type OrdinaryCollectionPagePlan } from './ordinary-read-bounds.ts';
import type { MembersPreparation, PreparationDefinitionInput } from './members-preparation.ts';
import type { NativeOwnerFilterCapability } from './contract/members-preparation.ts';
import { requireLibraryMembersPreparation } from './domain-binding.ts';

type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey?: Uint8Array;
  clock?: KernelClock;
  workClient?: () => Promise<WorkClient>;
};
export type OwnerFilterPlanDependencies = Dependencies;
type Unavailable = Readonly<{ status: 'unavailable' }>;

/** Private structural inputs to the Library matcher, never permission or an HTTP-supplied alias list.
 * The native Source binding must obtain the complete original population, including originals contributing
 * only exclusion/order evidence. A stored-ID point, returned candidate list or readMappings is not this closure.
 */
export type OwnerFilterCandidateClosure = Readonly<{
  subjectId: string;
  originals: readonly Readonly<{ subjectId: string; facts: readonly OwnerFilterFactLocator[] }>[];
  releases: ReadonlyMap<string, Release>;
  catalogue: ReadonlyMap<string, LeafEvidence>;
}>;

export type OwnerFilterReadBinding = Readonly<{
  input: Extract<PrepareCollectionSource, { actor: Actor }>;
  scope: IdentityScopeObservation;
}>;

const zero: WorkDimensions = {
  candidateKeys: 0,
  nativeRows: 0,
  identityMetadataRows: 0,
  emptySeeks: 0,
  nativePoints: 0,
  witnessKeys: 0,
  statements: 0,
  bytes: 0,
};
const unavailable = () => new ProblemError('dependency_unavailable');

async function prepareSparsePage(
  deps: Dependencies,
  admission: CollectionMemberAdmission,
  binding: OwnerFilterReadBinding,
  reservation: OwnerFilterReservation,
): Promise<{ preparing: true }> {
  if (!deps.workClient || !admission.filter || !admission.release || !admission.releaseDigest) throw unavailable();
  const workClient = await deps.workClient();
  // reserve owns the fenced operational transaction, exact definition bytes, durable intent and enqueue.
  // The caller never enqueues again, touches LRU on a duplicate, or claims a pending result is ready.
  const result = await reservation.reserve(
    { pool: deps.pool, access: deps.access, workClient },
    binding.input.actor,
    binding.input.collectionId,
    [
      {
        filter: admission.filter,
        sort: 'id',
        source: { kind: admission.source },
        release: { digest: admission.releaseDigest, value: admission.release },
      },
    ],
    { deadline: binding.input.deadline },
  );
  if (result.episodes.length !== 1 || result.episodes[0]!.state !== 'preparing') throw unavailable();
  return { preparing: true };
}

export type OwnerFilterReservation = Readonly<{
  reserve(
    dependencies: Readonly<{ pool: Pool; access: Access; workClient: WorkClient }>,
    actor: Actor,
    collectionId: string,
    definitions: readonly PreparationDefinitionInput[],
    options?: Parameters<MembersPreparation['reserve']>[3],
  ): ReturnType<MembersPreparation['reserve']>;
}>;

export type OwnerFilterNativeOperations = NativeOwnerFilterCapability<
  Omit<Dependencies, 'tokens'>,
  Actor,
  CollectionMemberAdmission,
  OwnerFilterReadBinding,
  PreparedCollectionSource,
  NativeCollectionWork,
  OwnerFilterCandidateClosure,
  RelationFacetMatch,
  CommandAttempt,
  OrdinaryCollectionPagePlan,
  NativeOwnerFilterCeilings,
  CollectionSourceObservation,
  Pick<PoolClient, 'query'>,
  import('./owner-filter-native-binding.ts').NativeOwnerFilterBinding
>;

export type OwnerFilterPlan = Readonly<{
  bindOwnerFilterRead(
    actor: Actor,
    collectionId: string,
    admission: CollectionMemberAdmission,
    deadline: number,
    attempt?: CommandAttempt,
    pagePlan?: OrdinaryCollectionPagePlan,
    ceilings?: NativeOwnerFilterCeilings,
  ): Promise<Unavailable | Readonly<{ status: 'bound'; binding: OwnerFilterReadBinding }>>;
  readOwnerFilterCandidateClosure(
    binding: OwnerFilterReadBinding,
    source: PreparedCollectionSource,
    subjectId: string,
    work: NativeCollectionWork,
    deferDisclosure?: boolean,
  ): ReturnType<typeof readOwnerFilterCandidateClosureNative>;
  readOwnerFilterCandidate(
    client: Pick<PoolClient, 'query'>,
    admission: CollectionMemberAdmission,
    closure: OwnerFilterCandidateClosure,
    work: NativeCollectionWork,
  ): ReturnType<typeof readOwnerFilterCandidateNative>;
  readBoundOwnerFilterPage(
    admission: CollectionMemberAdmission,
    options: CollectionMemberQuery,
    binding: OwnerFilterReadBinding,
  ): Promise<{ members: { kind: 'dynamic'; subjectId: string }[]; next: string | null } | { preparing: true }>;
  readOwnerFilterPage(
    actor: Actor,
    collectionId: string,
    options: CollectionMemberQuery,
    deadline: number,
  ): ReturnType<typeof readOwnerFilterPageNative>;
}>;

function bindOwnerFilterReadNative(
  deps: Omit<Dependencies, 'tokens'>,
  native: OwnerFilterNativeOperations,
  actor: Actor,
  collectionId: string,
  admission: CollectionMemberAdmission,
  deadline: number,
  attempt?: CommandAttempt,
  pagePlan?: OrdinaryCollectionPagePlan,
  ceilings?: NativeOwnerFilterCeilings,
) {
  return native.bind(deps, actor, collectionId, admission, deadline, attempt, pagePlan, ceilings);
}

function readOwnerFilterCandidateClosureNative(
  native: OwnerFilterNativeOperations,
  binding: OwnerFilterReadBinding,
  source: PreparedCollectionSource,
  subjectId: string,
  work: NativeCollectionWork,
  deferDisclosure = false,
) {
  return native.readClosure(binding, source, subjectId, work, deferDisclosure);
}

function readOwnerFilterCandidateNative(
  native: OwnerFilterNativeOperations,
  client: Pick<PoolClient, 'query'>,
  admission: CollectionMemberAdmission,
  closure: OwnerFilterCandidateClosure,
  work: NativeCollectionWork,
) {
  return native.evaluate(client, admission, closure, work);
}

function compatible(before: CollectionSourceObservation, after: CollectionSourceObservation): boolean {
  return (
    before.collectionId === after.collectionId &&
    before.route === after.route &&
    before.incarnation === after.incarnation &&
    before.basis.digest === after.basis.digest &&
    JSON.stringify(before.authority) === JSON.stringify(after.authority)
  );
}

/** Scoped currentness is revalidated for the whole source, including excluded and ordering originals.
 * A relevant pending claim cannot be converted into a point mapping or a global identity-ready gate.
 */
async function revalidateScope(deps: Dependencies, binding: OwnerFilterReadBinding, work: NativeCollectionWork) {
  const result = await work.compose(async (allowance) => {
    const result = await createIdentityScopedObservations(deps.pool).revalidate({
      key: binding.scope.key,
      expected: binding.scope,
      deadline: binding.input.deadline,
    });
    return {
      result,
      work: {
        reservationId: allowance.reservationId,
        used: {
          ...zero,
          nativeRows: result.work.rows,
          nativePoints: result.work.points,
          statements: result.work.statements,
          bytes: result.work.bytes,
        },
      },
    };
  });
  if (
    result.result.status !== 'current' ||
    result.result.observation.captureId !== binding.scope.captureId ||
    result.result.observation.committedRevision !== binding.scope.committedRevision
  )
    throw unavailable();
}

/** Full-page caller over the one Source and Search interpreter. An incomplete window is never a 200 page. */
async function readBoundOwnerFilterPageNative(
  deps: Dependencies,
  native: OwnerFilterNativeOperations,
  reservation: OwnerFilterReservation,
  admission: CollectionMemberAdmission,
  options: CollectionMemberQuery,
  binding: OwnerFilterReadBinding,
): Promise<{ members: { kind: 'dynamic'; subjectId: string }[]; next: string | null } | { preparing: true }> {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const plan =
    native.pagePlan(binding) ?? ordinaryCollectionPagePlan(limit, options.view === 'FULL' ? 'FULL' : 'BASIC');
  const work = new NativeCollectionWork(binding.input.allowance, binding.input.deadline);
  return native.withSource(binding, work, () =>
    readWorkingOwnerFilterPage(deps, native, reservation, admission, options, binding, work, plan),
  );
}

async function readWorkingOwnerFilterPage(
  deps: Dependencies,
  native: OwnerFilterNativeOperations,
  reservation: OwnerFilterReservation,
  admission: CollectionMemberAdmission,
  options: CollectionMemberQuery,
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
  plan: OrdinaryCollectionPagePlan,
): Promise<{ members: { kind: 'dynamic'; subjectId: string }[]; next: string | null } | { preparing: true }> {
  const input = binding.input;
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  requireAccessDeadline(input.deadline);
  const source = createOrdinaryCollectionPageSource(deps);
  const prepared = await work.compose((allowance) => source.prepare({ ...input, allowance }));
  const current = prepared.source;
  if (
    binding.scope.key.source.kind !== 'library' ||
    binding.scope.key.source.identity.collectionId !== input.collectionId ||
    binding.scope.key.source.identity.incarnation !== current.observation.incarnation
  )
    throw unavailable();
  // Public output supplies explicitly completed membership; viewer owner facts cannot personalize its graph.
  if (
    admission.owner &&
    (current.observation.authority.kind === 'activated_output' ||
      current.observation.authority.kind === 'frozen_output')
  )
    throw new ProblemError('unsupported_query');
  await revalidateScope(deps, binding, work);
  // The saved rule is versioned Source state, while caller filters are request identity. Keeping those
  // separate lets an authenticated old cursor report stale when the owner edits the stored rule.
  const savedRule =
    readNativeCollectionMemberAdmission(admission)?.retainedMeaning &&
    native.binding(binding)?.metadata.ruleReady;
  const query = savedRule
    ? createHash('sha256')
        .update(canonicalize(options.filter === undefined ? null : parseStrictJson(options.filter))!)
        .digest('hex')
    : admission.queryDigest;
  const cursorBinding: ListCursorBinding = {
    route: 'GET /v1/collections/{collectionId}/members',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: {
      collectionId: input.collectionId,
      query,
      limit,
      sort: 'id',
    },
  };
  let after: string | null = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    if (!options.cursor || options.cursor.length > 4096) throw new ProblemError('invalid_cursor');
    const cursor = await decodeListCursor(deps.tokens, cursorBinding, options.cursor, (deps.clock ?? systemClock)());
    if (!cursor.ok) throw new ProblemError('invalid_cursor');
    const [basis, capture, revision, fence, last] = cursor.after;
    if (cursor.after.length !== 5 || typeof last !== 'string' || routeOf(last) === null)
      throw new ProblemError('invalid_cursor');
    if (
      cursor.epoch !== current.observation.stamp.epoch ||
      basis !== current.observation.basis.digest ||
      capture !== binding.scope.captureId ||
      fence !== (native.binding(binding)?.ownerFence ?? '') ||
      revision !== binding.scope.committedRevision.toString()
    )
      throw new ProblemError('stale_cursor');
    after = last;
  }
  const members: { kind: 'dynamic'; subjectId: string }[] = [];
  let exhausted = false;
  // The existing direct plan has at most three refill rounds. The transferred allowance is never renewed.
  for (let round = 0; round < plan.rounds && members.length < limit && !exhausted; round++) {
    const quota = Math.min(100, 2 * (limit - members.length) + 1);
    const prefix = await work.compose((allowance) =>
      source.prefix({
        ...input,
        source: current,
        allowance,
        afterSubjectId: after,
        candidateLimit: Math.min(plan.prefixGroupLimit, quota),
      }),
    );
    if (!compatible(current.observation, prefix.observation)) throw new ProblemError('stale_cursor');
    if (prefix.candidates.length > Math.min(100, 2 * (limit - members.length) + 1)) throw unavailable();
    for (const candidate of prefix.candidates) {
      if (routeOf(candidate.subjectId) === null || (after !== null && candidate.subjectId <= after))
        throw unavailable();
      const membership = await work.compose((allowance) =>
        source.containsSubject({
          ...input,
          source: current,
          allowance,
          subjectId: candidate.subjectId,
          positiveEvidence: candidate.evidence,
        }),
      );
      if (!compatible(current.observation, membership.observation) || membership.result === 'not_proven')
        throw unavailable();
      after = candidate.subjectId;
      if (!membership.result) continue;
      const closure = await readOwnerFilterCandidateClosureNative(native, binding, current, candidate.subjectId, work, true);
      if (closure.status !== 'complete') throw unavailable();
      if (closure.closure.subjectId !== candidate.subjectId) throw new TypeError('Foreign native owner closure');
      const transaction = work.reserve({ ...zero, nativePoints: 1, statements: 3, bytes: 256 });
      transaction.dispatch();
      let match: RelationFacetMatch;
      try {
        match = await withConnection(deps.pool, async (connection) => {
          const client = deadlineClient(connection, input.deadline);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          try {
            const result = await readOwnerFilterCandidateNative(native, client, admission, closure.closure, work);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
        });
      } finally {
        transaction.settle();
      }
      if (match === 'not_proven') throw unavailable();
      if (match) members.push({ kind: 'dynamic', subjectId: candidate.subjectId });
      if (members.length === limit) break;
    }
    exhausted = prefix.exhausted && (prefix.candidates.length === 0 || after === prefix.candidates.at(-1)!.subjectId);
    if (members.length < limit && !exhausted && prefix.candidates.length === 0) throw unavailable();
  }
  if (!exhausted && members.length < limit) return prepareSparsePage(deps, admission, binding, reservation);
  // Reauthorize the source and ALL selective dependencies after negative/order work, before any row/cursor.
  const revalidate = async () => {
    const final = await work.compose((allowance) => source.prepare({ ...input, allowance }));
    if (!compatible(current.observation, final.source.observation)) throw new ProblemError('stale_cursor');
    await native.revalidateDisclosure(binding, work);
  };
  await revalidate();
  let disclosed = members;
  if (options.view === 'FULL') {
    if (!deps.routeKey) throw unavailable();
    disclosed = await attachCollectionListFacts(
      {
        pool: deps.pool,
        access: deps.access,
        actor: input.actor,
        routeKey: deps.routeKey,
        deadline: input.deadline,
      },
      members,
      { revalidate },
    );
    // A changed/denied summary may require repair; it must never turn a useful page into a short 200 window.
    if (disclosed.length !== members.length) throw unavailable();
  }
  requireAccessDeadline(input.deadline);
  return {
    members: disclosed,
    next: exhausted
      ? null
      : await encodeListCursor(
          deps.tokens,
          cursorBinding,
          {
            epoch: current.observation.stamp.epoch,
            after: [
              current.observation.basis.digest,
              binding.scope.captureId,
              binding.scope.committedRevision.toString(),
              native.binding(binding)!.ownerFence ?? '',
              after!,
            ],
          },
          (deps.clock ?? systemClock)(),
        ),
  };
}

async function readOwnerFilterPageNative(
  deps: Dependencies,
  native: OwnerFilterNativeOperations,
  reservation: OwnerFilterReservation,
  actor: Actor,
  collectionId: string,
  options: CollectionMemberQuery,
  deadline: number,
) {
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const plan = ordinaryCollectionPagePlan(limit, options.view === 'FULL' ? 'FULL' : 'BASIC');
  const admission = await admitCollectionMemberQuery(deps, actor, options, deadline);
  const bound = await bindOwnerFilterReadNative(deps, native, actor, collectionId, admission, deadline, undefined, plan);
  if (bound.status !== 'bound') throw unavailable();
  if (
    bound.binding.input.actor !== actor ||
    bound.binding.input.collectionId !== collectionId ||
    bound.binding.input.deadline > deadline
  )
    throw new TypeError('Foreign native owner read binding');
  try {
    return await readBoundOwnerFilterPageNative(deps, native, reservation, admission, options, bound.binding);
  } finally {
    native.release(bound.binding);
  }
}

/** All operations in this plan share the supplied native implementation and reservation capability. */
export function createOwnerFilterPlan(
  dependencies: Dependencies,
  native: OwnerFilterNativeOperations,
  reservation: OwnerFilterReservation,
): OwnerFilterPlan {
  return Object.freeze({
    bindOwnerFilterRead: (actor, collectionId, admission, deadline, attempt, pagePlan, ceilings) =>
      bindOwnerFilterReadNative(
        dependencies,
        native,
        actor,
        collectionId,
        admission,
        deadline,
        attempt,
        pagePlan,
        ceilings,
      ),
    readOwnerFilterCandidateClosure: (binding, source, subjectId, work, deferDisclosure) =>
      readOwnerFilterCandidateClosureNative(native, binding, source, subjectId, work, deferDisclosure),
    readOwnerFilterCandidate: (client, admission, closure, work) =>
      readOwnerFilterCandidateNative(native, client, admission, closure, work),
    readBoundOwnerFilterPage: (admission, options, binding) =>
      readBoundOwnerFilterPageNative(dependencies, native, reservation, admission, options, binding),
    readOwnerFilterPage: (actor, collectionId, options, deadline) =>
      readOwnerFilterPageNative(dependencies, native, reservation, actor, collectionId, options, deadline),
  });
}

function installed() {
  return requireLibraryMembersPreparation();
}

/** Compatibility operations used by Search delegate to the application installed by Library composition. */
export function bindOwnerFilterRead(
  dependencies: Omit<Dependencies, 'tokens'>,
  actor: Actor,
  collectionId: string,
  admission: CollectionMemberAdmission,
  deadline: number,
  attempt?: CommandAttempt,
  pagePlan?: OrdinaryCollectionPagePlan,
  ceilings?: NativeOwnerFilterCeilings,
) {
  return installed().native.bind(
    dependencies,
    actor,
    collectionId,
    admission,
    deadline,
    attempt,
    pagePlan,
    ceilings,
  );
}

export function readOwnerFilterCandidateClosure(
  binding: OwnerFilterReadBinding,
  source: PreparedCollectionSource,
  subjectId: string,
  work: NativeCollectionWork,
  deferDisclosure = false,
) {
  return installed().native.readClosure(binding, source, subjectId, work, deferDisclosure);
}

export function readOwnerFilterCandidate(
  client: Pick<PoolClient, 'query'>,
  admission: CollectionMemberAdmission,
  closure: OwnerFilterCandidateClosure,
  work: NativeCollectionWork,
) {
  return installed().native.evaluate(client, admission, closure, work);
}

export function readBoundOwnerFilterPage(
  dependencies: Dependencies,
  admission: CollectionMemberAdmission,
  options: CollectionMemberQuery,
  binding: OwnerFilterReadBinding,
) {
  return installed().createPlan(dependencies).readBoundOwnerFilterPage(admission, options, binding);
}

export function readOwnerFilterPage(
  dependencies: Dependencies,
  actor: Actor,
  collectionId: string,
  options: CollectionMemberQuery,
  deadline: number,
) {
  return installed().createPlan(dependencies).readOwnerFilterPage(actor, collectionId, options, deadline);
}
