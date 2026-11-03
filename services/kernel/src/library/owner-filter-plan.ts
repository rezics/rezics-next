import type { Release } from '@rezics/definitions';
import type { Pool, PoolClient } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import type { CommandAttempt } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
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
import {
  bindNativeOwnerFilterRead,
  releaseNativeOwnerFilterRead,
  revalidateOwnerFilterDisclosure,
  nativeOwnerFilterBinding,
  withNativeOwnerFilterSource,
} from './owner-filter-native-binding.ts';
import { readNativeOwnerFilterClosure } from './owner-filter-native-closure.ts';
import { createMembersPreparation } from './members-preparation.ts';
import { attachCollectionListFacts } from './collection-list-facts.ts';
import {
  createCollectionSource,
  type CollectionSourceObservation,
  type PrepareCollectionSource,
  type PreparedCollectionSource,
  type WorkDimensions,
} from './collection-source.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import {
  admitCollectionMemberQuery,
  evaluateOwnerFilterLeaves,
  matchOwnerFilterCatalogue,
  matchOwnerFilterState,
  matchOwnerFilterSupport,
  ownerFilterStateWinner,
  type CollectionMemberAdmission,
  type CollectionMemberQuery,
  type OwnerFilterEntryFact,
  type OwnerFilterFactLocator,
  type OwnerFilterNativeFact,
} from './owner-filter.ts';

type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  routeKey?: Uint8Array;
  clock?: KernelClock;
  workClient?: () => Promise<WorkClient>;
};
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

/** Bind the current native Source and scoped capture at the caller's actual authoritative time.
 * Commands retain their executor time and partition; Search transfers its existing reservation and read time.
 */
export async function bindOwnerFilterRead(
  dependencies: Omit<Dependencies, 'tokens'>,
  actor: Actor,
  collectionId: string,
  admission: CollectionMemberAdmission,
  deadline: number,
  attempt?: CommandAttempt,
): Promise<Unavailable | Readonly<{ status: 'bound'; binding: OwnerFilterReadBinding }>> {
  return bindNativeOwnerFilterRead(dependencies, actor, collectionId, admission, deadline, attempt);
}

/** Complete native original/fact closure, independently of positive candidate enumeration.
 * Missing coverage never supplies private absence, even underneath a negative filter branch.
 */
export async function readOwnerFilterCandidateClosure(
  binding: OwnerFilterReadBinding,
  source: PreparedCollectionSource,
  subjectId: string,
  work: NativeCollectionWork,
  deferDisclosure = false,
): Promise<Unavailable | Readonly<{ status: 'complete'; closure: OwnerFilterCandidateClosure }>> {
  return withNativeOwnerFilterSource(binding, work, () =>
    readNativeOwnerFilterClosure(binding, source, subjectId, work, deferDisclosure),
  );
}

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
): Promise<{ preparing: true }> {
  if (!deps.workClient || !admission.filter || !admission.release || !admission.releaseDigest) throw unavailable();
  const workClient = await deps.workClient();
  // reserve owns the fenced operational transaction, exact definition bytes, durable intent and enqueue.
  // The caller never enqueues again, touches LRU on a duplicate, or claims a pending result is ready.
  const result = await createMembersPreparation({ pool: deps.pool, access: deps.access, workClient }).reserve(
    binding.input.actor,
    binding.input.collectionId,
    [{ filter: admission.filter, sort: 'id', release: { digest: admission.releaseDigest, value: admission.release } }],
    { deadline: binding.input.deadline },
  );
  if (result.episodes.length !== 1 || result.episodes[0]!.state !== 'preparing') throw unavailable();
  return { preparing: true };
}

/** All native points share the caller's snapshot and ledger. No Boolean branch skips authority or evidence. */
export async function readOwnerFilterCandidate(
  client: Pick<PoolClient, 'query'>,
  admission: CollectionMemberAdmission,
  closure: OwnerFilterCandidateClosure,
  work: NativeCollectionWork,
): Promise<RelationFacetMatch> {
  const plan = admission.plan;
  if (plan === null) return true;
  const facts: OwnerFilterNativeFact[] = [];
  const entries: OwnerFilterEntryFact[] = [];
  const presence: boolean[] = [];
  const wantsPresence = plan.leaves.some((leaf) => leaf.kind === 'owner' && 'presence' in leaf.leaf.owner);
  const seen = new Set<string>();
  const originals = new Set<string>();
  let raw = 0;
  for (const original of closure.originals) {
    raw += 1 + original.facts.length;
    if (raw > 100) throw unavailable();
  }
  for (const original of closure.originals) {
    if (originals.has(original.subjectId) || routeOf(original.subjectId) === null)
      throw new TypeError('Invalid native owner original closure');
    originals.add(original.subjectId);
    for (const locator of original.facts) {
      if (locator.subjectId !== original.subjectId) throw new TypeError('Foreign native owner fact');
      const key = JSON.stringify(locator);
      if (seen.has(key)) throw new TypeError('Duplicate native owner locator');
      seen.add(key);
      if (!admission.owner) throw new TypeError('Native owner family was not admitted');
      if (wantsPresence) presence.push(await admission.owner.readPresence(client, locator, work));
      const needed = plan.leaves.some((leaf) => {
        if (leaf.kind !== 'owner') return false;
        const owner = leaf.leaf.owner;
        return (
          ('state' in owner && locator.kind === 'entry') ||
          ('label' in owner && locator.kind === 'label' && locator.labelId === owner.label.id) ||
          ('session' in owner && locator.kind === 'session') ||
          ('holding' in owner && locator.kind === 'holding')
        );
      });
      // Presence uses independent fixed-width native liveness points, without hydrating a profile pin.
      if (!needed) continue;
      const fact = await admission.owner.read(client, locator, work);
      if (!fact) continue;
      facts.push(fact);
      if (fact.kind === 'entry') entries.push(fact);
    }
  }
  if (!originals.has(closure.subjectId)) throw new TypeError('Missing native owner terminal original');
  const winner = ownerFilterStateWinner(entries);
  const observations = new Map<string, RelationFacetMatch>();
  for (const leaf of plan.leaves) {
    const key = currentOwnerClauseKey(leaf);
    if (leaf.kind === 'catalogue') {
      const evidence = closure.catalogue.get(key);
      observations.set(key, evidence ? matchOwnerFilterCatalogue(leaf, evidence) : 'not_proven');
      continue;
    }
    const owner = leaf.leaf.owner;
    if ('presence' in owner) observations.set(key, presence.some(Boolean));
    else if ('state' in owner) observations.set(key, matchOwnerFilterState(owner.state, winner, closure.releases));
    else {
      const matches = facts.map((fact) => matchOwnerFilterSupport(owner, fact, closure.releases));
      observations.set(key, matches.includes(true) ? true : matches.includes('not_proven') ? 'not_proven' : false);
    }
  }
  return evaluateOwnerFilterLeaves(plan, observations);
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
export async function readBoundOwnerFilterPage(
  deps: Dependencies,
  admission: CollectionMemberAdmission,
  options: CollectionMemberQuery,
  binding: OwnerFilterReadBinding,
): Promise<{ members: { kind: 'dynamic'; subjectId: string }[]; next: string | null } | { preparing: true }> {
  const work = new NativeCollectionWork(binding.input.allowance, binding.input.deadline);
  return withNativeOwnerFilterSource(binding, work, () =>
    readWorkingOwnerFilterPage(deps, admission, options, binding, work),
  );
}

async function readWorkingOwnerFilterPage(
  deps: Dependencies,
  admission: CollectionMemberAdmission,
  options: CollectionMemberQuery,
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
): Promise<{ members: { kind: 'dynamic'; subjectId: string }[]; next: string | null } | { preparing: true }> {
  const input = binding.input;
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  requireAccessDeadline(input.deadline);
  const source = createCollectionSource(deps);
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
  const cursorBinding: ListCursorBinding = {
    route: 'GET /v1/collections/{collectionId}/members',
    viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
    query: {
      collectionId: input.collectionId,
      query: admission.queryDigest,
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
      fence !== nativeOwnerFilterBinding(binding)?.ownerFence ||
      revision !== binding.scope.committedRevision.toString()
    )
      throw new ProblemError('stale_cursor');
    after = last;
  }
  const members: { kind: 'dynamic'; subjectId: string }[] = [];
  let exhausted = false;
  // The existing direct plan has at most three refill rounds. The transferred allowance is never renewed.
  for (let round = 0; round < 3 && members.length < limit && !exhausted; round++) {
    const quota = Math.min(100, 2 * (limit - members.length) + 1);
    const prefix = await work.compose((allowance) =>
      source.prefix({
        ...input,
        source: current,
        allowance: {
          ...allowance,
          remaining: {
            ...allowance.remaining,
            candidateKeys: Math.min(allowance.remaining.candidateKeys, quota),
          },
        },
        afterSubjectId: after,
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
      const closure = await readOwnerFilterCandidateClosure(binding, current, candidate.subjectId, work, true);
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
            const result = await readOwnerFilterCandidate(client, admission, closure.closure, work);
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
  if (!exhausted && members.length < limit) return prepareSparsePage(deps, admission, binding);
  // Reauthorize the source and ALL selective dependencies after negative/order work, before any row/cursor.
  const revalidate = async () => {
    const final = await work.compose((allowance) => source.prepare({ ...input, allowance }));
    if (!compatible(current.observation, final.source.observation)) throw new ProblemError('stale_cursor');
    await revalidateOwnerFilterDisclosure(binding, work);
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
              nativeOwnerFilterBinding(binding)!.ownerFence,
              after!,
            ],
          },
          (deps.clock ?? systemClock)(),
        ),
  };
}

export async function readOwnerFilterPage(
  deps: Dependencies,
  actor: Actor,
  collectionId: string,
  options: CollectionMemberQuery,
  deadline: number,
) {
  const admission = await admitCollectionMemberQuery(deps, actor, options, deadline);
  const bound = await bindOwnerFilterRead(deps, actor, collectionId, admission, deadline);
  if (bound.status !== 'bound') throw unavailable();
  if (
    bound.binding.input.actor !== actor ||
    bound.binding.input.collectionId !== collectionId ||
    bound.binding.input.deadline > deadline
  )
    throw new TypeError('Foreign native owner read binding');
  try {
    return await readBoundOwnerFilterPage(deps, admission, options, bound.binding);
  } finally {
    releaseNativeOwnerFilterRead(bound.binding);
  }
}
