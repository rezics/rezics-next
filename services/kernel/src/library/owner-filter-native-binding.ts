/** Native request composition. Captures and locators are structural evidence, never permission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { deadlineClient } from '../access/authenticate.ts';
import { commandAccessContext, requireCommandAdmission } from '../access/command-admission.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  commandAttemptDeadline,
  mintReadTime,
  releaseOperationalTime,
  type AuthoritativeTime,
  type CommandAttempt,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccessContext, Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { scopeAllowance, zeroScopeWork } from '../search/scope-execution.ts';
import { createIdentityScopedObservations } from '../semantic/identity-scoped-observations.ts';
import type { IdentityScopeLibraryIdentity, IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { freeze } from '../semantic/definitions.ts';
import { nativeSourceFence, type CanonicalAllowance, type CanonicalWork } from './canonical-source-store.ts';
import {
  createCollectionSource,
  type CollectionSourceObservation,
  type WorkAllowance,
  type WorkDimensions,
} from './collection-source.ts';
import { readNativeCollectionMetadata, type NativeCollectionMetadata } from './collection-source-native.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import {
  prepareNativeCollectionMemberAuthority,
  readNativeCollectionMemberAdmission,
  type CollectionMemberAdmission,
} from './owner-filter.ts';
import type { OwnerFilterReadBinding } from './owner-filter-plan.ts';
import { withAdmittedOwnerWorkingSource } from './owner-filter-working-source.ts';
import scopeQuery from './owner-filter-native-binding-scope.sql';
import activeQuery from '../semantic/definitions-active.sql';
import ownerFenceQuery from './owner-filter-native-binding-fence.sql';
import { compileCurrentOwnerFilter, currentOwnerClauseKey } from '../search/current-filter-plan.ts';
import type { PublicFilterQueriedObservation } from '../search/public-filter-consumer-contract.ts';
import type { PublicFilterSourceBinding } from '../semantic/public-filter-source-binding.ts';
import type { PublicFilterSource, PublicFilterCost } from '../semantic/public-filter-source-contract.ts';
import type { FilterDocument } from '@rezics/filter';
import { resolveSubject } from './subject-anchor.ts';

type Dependencies = {
  pool: Pool;
  access: Access;
  routeKey?: Uint8Array;
  clock?: KernelClock;
};
/** References to an existing native execution, never a caller-issued safety assertion. */
export type OwnerFilterQueryRead = Readonly<{
  filter: FilterDocument;
  source: PublicFilterSource;
  binding: PublicFilterSourceBinding;
  queried: PublicFilterQueriedObservation;
  execution: string;
}>;
type NativeRead = Readonly<{
  actor: Actor;
  at: AuthoritativeTime;
  work: NativeCollectionWork;
  query?: OwnerFilterQueryRead;
}>;
const reads = new AsyncLocalStorage<NativeRead>();

/** Additive accounting port for an enclosing native reader, with no new binder or allowance.
 * The callback still calls bindOwnerFilterRead with its CLOSED arguments. The enclosing reader settles work.
 */
export function withOwnerFilterNativeRead<T>(input: NativeRead, read: () => Promise<T>): Promise<T> {
  authoritativeTimeValue(input.at);
  input.work.assertReady();
  return reads.run(input, read);
}

export type NativeOwnerFilterBinding = Readonly<{
  dependencies: Dependencies;
  admission: CollectionMemberAdmission;
  metadata: NativeCollectionMetadata;
  observation: CollectionSourceObservation;
  attempt?: CommandAttempt;
  ownsTime: boolean;
  ownerFence: string | null;
  query?: OwnerFilterQueryRead;
  originals: Map<string, string>;
}>;
const bindings = new WeakMap<OwnerFilterReadBinding, NativeOwnerFilterBinding>();

/** Only a direct ordinary read owns its minted read time. Commands/Search keep their caller's lifetime. */
export function releaseNativeOwnerFilterRead(binding: OwnerFilterReadBinding): void {
  const saved = bindings.get(binding);
  if (saved?.ownsTime) releaseOperationalTime(binding.input.at);
  bindings.delete(binding);
}

export function nativeOwnerFilterBinding(binding: OwnerFilterReadBinding): NativeOwnerFilterBinding | undefined {
  authoritativeTimeValue(binding.input.at);
  requireAccessDeadline(binding.input.deadline);
  return bindings.get(binding);
}

/** Every declared consumer reenters with its actual immutable binding and transferred ledger. */
export function withNativeOwnerFilterSource<T>(
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
  body: () => Promise<T>,
): Promise<T> {
  const saved = nativeOwnerFilterBinding(binding);
  if (!saved || work.receipt().reservationId !== binding.input.allowance.reservationId) throw ownerFilterUnavailable();
  return withAdmittedOwnerWorkingSource(
    {
      ...binding.input,
      pool: saved.dependencies.pool,
      admission: saved.admission,
      work,
      ...(saved.attempt ? { attempt: saved.attempt } : {}),
    },
    body,
  );
}

export function sameOwnerFilterSource(left: CollectionSourceObservation, right: CollectionSourceObservation) {
  return (
    left.collectionId === right.collectionId &&
    left.route === right.route &&
    left.incarnation === right.incarnation &&
    left.revision === right.revision &&
    left.stamp.epoch === right.stamp.epoch &&
    isDeepStrictEqual(left.authority, right.authority) &&
    isDeepStrictEqual(left.basis, right.basis)
  );
}

export const ownerFilterUnavailable = () => new ProblemError('dependency_unavailable');

/** Keep every original actually used, including rejected and order-only support, until final disclosure. */
export function retainOwnerFilterOriginal(binding: OwnerFilterReadBinding, original: string, terminal: string) {
  const saved = nativeOwnerFilterBinding(binding);
  if (!saved) throw ownerFilterUnavailable();
  const previous = saved.originals.get(original);
  if (previous !== undefined && previous !== terminal) throw ownerFilterUnavailable();
  saved.originals.set(original, terminal);
}

export async function revalidateOwnerFilterDisclosure(binding: OwnerFilterReadBinding, work: NativeCollectionWork) {
  const saved = nativeOwnerFilterBinding(binding);
  if (!saved) throw ownerFilterUnavailable();
  for (const [original, terminal] of saved.originals) {
    const current = await ownerFilterBounded(
      work,
      { nativeRows: 8192, nativePoints: 128, statements: 128, bytes: 1024 * 1024 },
      () =>
        resolveSubject(
          saved.dependencies,
          binding.input.actor,
          original,
          binding.input.at,
          ownerFilterAccessContext(saved.dependencies, binding.input.deadline, saved.attempt),
        ),
    );
    if (current?.subjectId !== terminal) throw ownerFilterUnavailable();
  }
  await revalidateNativeOwnerFilter(binding, work);
}

/** Join the actual complete native filter/order execution, rather than certifying its returned IDs.
 * The original execution start detects a reduction even if repair/ACK completed during this read.
 */
async function revalidateQuery(binding: OwnerFilterReadBinding, work: NativeCollectionWork) {
  const saved = nativeOwnerFilterBinding(binding)!;
  if (!saved.admission.owner) return;
  const leaves = saved.admission.plan?.leaves.filter((leaf) => leaf.kind === 'catalogue') ?? [];
  if (!leaves.length) return;
  const query = saved.query;
  if (!query || !isDeepStrictEqual(query.filter, saved.admission.filter)) throw ownerFilterUnavailable();
  const context = { deadline: binding.input.deadline };
  const charge = async <T extends { cost: PublicFilterCost }>(read: () => Promise<T>) => {
    const result = await work.compose(async (allowance) => {
      const value = await read();
      const physical = value.cost as PublicFilterCost & { rows?: number; statements?: number; bytes?: number };
      return {
        value,
        work: {
          reservationId: allowance.reservationId,
          used: {
            ...zeroScopeWork(),
            candidateKeys: physical.inputKeys,
            nativePoints: physical.accessPoints + physical.dependencyPoints,
            nativeRows: physical.rows ?? 0,
            statements: physical.statements ?? 0,
            bytes: physical.bytes ?? 0,
          },
        },
      };
    });
    return result.value;
  };
  const joined = await charge(() =>
    query.binding.join({ queried: query.queried, execution: query.execution }, context),
  );
  if (
    joined.status !== 'joined' ||
    !joined.execution ||
    joined.execution.id !== query.execution ||
    !isDeepStrictEqual(joined.queried, query.queried) ||
    joined.definition.meaning.digest !== saved.admission.releaseDigest
  )
    throw ownerFilterUnavailable();
  const capture = joined.definition.capture;
  if ('purpose' in capture || 'representation' in capture || !capture.filterDocument) throw ownerFilterUnavailable();
  const covered = new Set(compileCurrentOwnerFilter(capture.filterDocument).leaves.map(currentOwnerClauseKey));
  if (leaves.some((leaf) => !covered.has(currentOwnerClauseKey(leaf)))) throw ownerFilterUnavailable();
  const observed = await charge(() =>
    query.source.readPrivacyReductionHeads({
      kind: 'population',
      queried: query.queried,
      start: joined.execution!.start,
      execution: query.execution,
      context,
    }),
  );
  if (
    observed.status !== 'observed' ||
    observed.coverage !== 'all_native_homes' ||
    !observed.routingComplete ||
    observed.blocking.length ||
    observed.unacknowledged.length ||
    observed.changed.length
  )
    throw ownerFilterUnavailable();
}

export function ownerFilterAllowance(work: NativeCollectionWork): WorkAllowance {
  const remaining = { ...zeroScopeWork() };
  for (const axis of Object.keys(remaining) as (keyof WorkDimensions)[]) remaining[axis] = work.available(axis);
  return { reservationId: work.receipt().reservationId, remaining };
}

export function ownerFilterCanonicalAllowance(allowance: WorkAllowance): CanonicalAllowance {
  return {
    reservationId: allowance.reservationId,
    rawKeys: Math.min(100, allowance.remaining.candidateKeys),
    nativeRows: allowance.remaining.nativeRows,
    nativePoints: allowance.remaining.nativePoints,
    emptySeeks: allowance.remaining.emptySeeks,
    statements: allowance.remaining.statements,
    bytes: allowance.remaining.bytes,
    identityMetadataRows: allowance.remaining.identityMetadataRows,
  };
}

export async function ownerFilterCanonical<T extends { work: CanonicalWork }>(
  work: NativeCollectionWork,
  read: (allowance: CanonicalAllowance) => Promise<T>,
): Promise<T> {
  const result = await work.compose(async (allowance) => {
    const result = await read(ownerFilterCanonicalAllowance(allowance));
    const w = result.work;
    return {
      result,
      work: {
        reservationId: w.reservationId,
        used: {
          ...zeroScopeWork(),
          candidateKeys: w.candidateKeys + w.aliasKeys + w.duplicateKeys + w.lookaheadKeys + w.internalDriverKeys,
          nativeRows: w.nativeRows,
          nativePoints: w.nativePoints,
          statements: w.statements,
          bytes: w.bytes,
          emptySeeks: w.emptySeeks,
          identityMetadataRows: w.identityMetadataRows,
        },
      },
    };
  });
  return result.result;
}

/** Reserve before dispatch, including failure and control work. No result size substitutes for row work. */
export async function ownerFilterBounded<T>(
  work: NativeCollectionWork,
  cost: Partial<WorkDimensions>,
  read: () => Promise<T>,
): Promise<T> {
  const reserved = work.reserve({ ...zeroScopeWork(), ...cost });
  reserved.dispatch();
  try {
    return await read();
  } finally {
    reserved.settle();
  }
}

export function ownerFilterQuery<R extends QueryResultRow>(
  client: Pick<PoolClient, 'query'>,
  work: NativeCollectionWork,
  query: { sql: string; params: readonly string[] },
  input: Record<string, unknown>,
  cost: Partial<WorkDimensions>,
): Promise<R[]> {
  const reserved = work.reserve({
    ...zeroScopeWork(),
    nativePoints: 1,
    statements: 1,
    emptySeeks: 1,
    ...cost,
    bytes: Buffer.byteLength(query.sql) + Buffer.byteLength(JSON.stringify(input)) + (cost.bytes ?? 1024),
  });
  reserved.dispatch();
  return (async () => {
    try {
      const rows = (
        await client.query<R>(
          query.sql,
          query.params.map((name) => input[name]),
        )
      ).rows;
      reserved.settle({
        candidateKeys: cost.candidateKeys ? rows.length : 0,
        witnessKeys: cost.witnessKeys ? rows.length : 0,
        emptySeeks: rows.length ? 0 : (cost.emptySeeks ?? 1),
      });
      return rows;
    } catch (error) {
      reserved.settle();
      throw error;
    }
  })();
}

export function ownerFilterAccessContext(
  dependencies: Dependencies,
  deadline: number,
  attempt?: CommandAttempt,
): AccessContext {
  const context = { pool: dependencies.pool, deadline };
  return attempt ? commandAccessContext(context, attempt) : context;
}

async function privateAuthority(
  dependencies: Dependencies,
  actor: Actor,
  admission: CollectionMemberAdmission,
  at: AuthoritativeTime,
  deadline: number,
  work: NativeCollectionWork,
  attempt?: CommandAttempt,
) {
  if (!admission.owner) return;
  if (actor.kind !== 'account' || !admission.filter) throw ownerFilterUnavailable();
  await ownerFilterBounded(
    work,
    { nativeRows: 8192, nativePoints: 128, statements: 128, bytes: 1024 * 1024 },
    async () => {
      const checks = await prepareNativeCollectionMemberAuthority(
        dependencies,
        actor,
        admission,
        at,
        deadline,
        attempt,
      );
      // Every family is evaluated, including excluded/nonmatching/negative branches.
      await withConnection(dependencies.pool, async (client) => {
        for (const check of checks)
          if (!(await check(deadlineClient(client, deadline), at))) throw new ProblemError('forbidden');
      });
    },
  );
}

export async function revalidateNativeOwnerFilter(
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
): Promise<void> {
  return withNativeOwnerFilterSource(binding, work, () => revalidateWorkingOwnerFilter(binding, work));
}

async function revalidateWorkingOwnerFilter(
  binding: OwnerFilterReadBinding,
  work: NativeCollectionWork,
): Promise<void> {
  const saved = nativeOwnerFilterBinding(binding);
  if (!saved || work.receipt().reservationId !== binding.input.allowance.reservationId) throw ownerFilterUnavailable();
  const { dependencies, admission, metadata, attempt } = saved;
  const { actor, at, deadline } = binding.input;
  if (admission.releaseDigest !== null) {
    const [active] = await withConnection(dependencies.pool, (client) =>
      ownerFilterQuery<{ digest: string }>(
        deadlineClient(client, deadline),
        work,
        activeQuery,
        { route: 0 },
        { nativeRows: 4, bytes: 256 },
      ),
    );
    if (active?.digest !== admission.releaseDigest) throw ownerFilterUnavailable();
  }
  if (attempt) {
    commandAttemptDeadline(attempt);
    await ownerFilterBounded(work, { nativeRows: 8, nativePoints: 2, statements: 2, bytes: 2048 }, () =>
      requireCommandAdmission(dependencies.access, actor, ownerFilterAccessContext(dependencies, deadline, attempt)),
    );
  }
  await privateAuthority(dependencies, actor, admission, at, deadline, work, attempt);
  if (admission.owner && actor.kind === 'account') {
    const [ownerFence] = await withConnection(dependencies.pool, (client) =>
      ownerFilterQuery<{ generation: string }>(
        deadlineClient(client, deadline),
        work,
        ownerFenceQuery,
        { route: routeOf(actor.accountId), account_id: actor.accountId },
        { nativeRows: 4, bytes: 256 },
      ),
    );
    if (!ownerFence || ownerFence.generation !== saved.ownerFence) throw ownerFilterUnavailable();
  }
  const current = await work.compose((allowance) =>
    readNativeCollectionMetadata(dependencies.pool, metadata, { deadline, allowance }),
  );
  if (
    !current.metadata ||
    current.metadata.curatorAccountId !== metadata.curatorAccountId ||
    current.metadata.ruleRevision !== metadata.ruleRevision ||
    current.metadata.ruleReleaseDigest !== metadata.ruleReleaseDigest ||
    nativeSourceFence(current.metadata) !== nativeSourceFence(metadata)
  )
    throw ownerFilterUnavailable();
  const prepared = await work.compose((allowance) =>
    createCollectionSource(dependencies).prepare({ ...binding.input, allowance }),
  );
  if (!sameOwnerFilterSource(prepared.source.observation, saved.observation)) throw ownerFilterUnavailable();
  await ownerFilterBounded(work, { nativeRows: 32, nativePoints: 2, statements: 6, bytes: 16384 }, async () => {
    const result = await createIdentityScopedObservations(dependencies.pool).revalidate({
      key: binding.scope.key,
      expected: binding.scope,
      deadline,
    });
    if (result.status !== 'current' || !isDeepStrictEqual(result.observation, binding.scope))
      throw ownerFilterUnavailable();
  });
  await revalidateQuery(binding, work);
}

/** No capture creation or repair occurs in a read. Only current native producer evidence can bind. */
export async function bindNativeOwnerFilterRead(
  dependencies: Dependencies,
  actor: Actor,
  collectionId: string,
  admission: CollectionMemberAdmission,
  deadline: number,
  attempt?: CommandAttempt,
) {
  requireAccessDeadline(deadline);
  const route = routeOf(collectionId);
  if (route === null) throw new ProblemError('not_found');
  const admitted = readNativeCollectionMemberAdmission(admission);
  if (!admitted || admitted.actor !== actor || admitted.pool !== dependencies.pool)
    throw new TypeError('Foreign native owner admission');
  deadline = Math.min(deadline, admitted.deadline);
  const inherited = reads.getStore();
  if (inherited && inherited.actor !== actor) throw new TypeError('Foreign native owner reader');
  if (attempt) {
    deadline = Math.min(deadline, commandAttemptDeadline(attempt));
    if (
      attempt.partition !== partitionOf(route) ||
      actor.kind !== 'account' ||
      attempt.basis?.actorAccountId !== actor.accountId ||
      attempt.basis.clientId !== actor.clientId ||
      attempt.basis.requestedBy !== actor.requestedBy ||
      (inherited && inherited.at !== attempt.time)
    )
      throw ownerFilterUnavailable();
  }
  // The direct reader owns one root; a nested Search reader lends its existing root instead.
  const root = scopeAllowance(100, randomUUID());
  // One direct Source request reservation, never renewed by a candidate/refill/closure.
  // Search supplies its own existing ceilings unchanged.
  const work =
    inherited?.work ??
    new NativeCollectionWork({ ...root, remaining: { ...root.remaining, bytes: 16 * 1024 * 1024 } }, deadline);
  const ownTime = !attempt && !inherited;
  const at =
    attempt?.time ??
    inherited?.at ??
    (await ownerFilterBounded(work, { nativeRows: 1, nativePoints: 1, statements: 1, bytes: 1024 }, () =>
      withConnection(dependencies.pool, (client) => mintReadTime(deadlineClient(client, deadline), dependencies.clock)),
    ));
  let retained = false;
  try {
    return await withAdmittedOwnerWorkingSource(
      {
        pool: dependencies.pool,
        actor,
        collectionId,
        admission,
        at,
        deadline,
        work,
        ...(attempt ? { attempt } : {}),
      },
      async () => {
        authoritativeTimeValue(at);
        if (attempt)
          await ownerFilterBounded(work, { nativeRows: 8, nativePoints: 2, statements: 2, bytes: 2048 }, () =>
            requireCommandAdmission(
              dependencies.access,
              actor,
              ownerFilterAccessContext(dependencies, deadline, attempt),
            ),
          );
        if (admission.releaseDigest !== null) {
          const [active] = await withConnection(dependencies.pool, (client) =>
            ownerFilterQuery<{ digest: string }>(
              deadlineClient(client, deadline),
              work,
              activeQuery,
              { route: 0 },
              { nativeRows: 4, bytes: 256 },
            ),
          );
          if (active?.digest !== admission.releaseDigest) throw ownerFilterUnavailable();
        }
        const current = await work.compose((allowance) =>
          readNativeCollectionMetadata(dependencies.pool, { route, collectionId }, { deadline, allowance }),
        );
        const metadata = current.metadata;
        if (!metadata || metadata.state !== 'active') throw new ProblemError('not_found');
        if (
          admission.owner &&
          (actor.kind !== 'account' ||
            (metadata.membershipKind === 'dynamic' && metadata.curatorAccountId !== actor.accountId))
        )
          throw new ProblemError('not_found');
        // Only the admitted actual owner can select working metadata. Public/frozen metadata still refuses.
        if (metadata.authority !== 'curated' && metadata.authority !== 'private_builtin')
          return { status: 'unavailable' } as const;
        await privateAuthority(dependencies, actor, admission, at, deadline, work, attempt);
        const source = await work.compose((allowance) =>
          createCollectionSource(dependencies).prepare({ actor, at, deadline, collectionId, allowance }),
        );
        const [row] = await withConnection(dependencies.pool, (client) =>
          ownerFilterQuery<{
            identity: IdentityScopeLibraryIdentity;
            captureId: string | null;
            revision: string | null;
          }>(
            deadlineClient(client, deadline),
            work,
            scopeQuery,
            {
              route,
              collection_id: collectionId,
              source_fence: nativeSourceFence(metadata),
            },
            { nativeRows: 4, bytes: 6144 },
          ),
        );
        if (
          !row ||
          !row.captureId ||
          row.revision === null ||
          row.identity.scope === 'public_output' ||
          row.identity.collectionId !== collectionId ||
          row.identity.route !== route ||
          row.identity.incarnation !== metadata.incarnation ||
          row.identity.generation !== metadata.sourceGeneration ||
          row.identity.accountId !== metadata.curatorAccountId ||
          row.identity.ownerEpoch !== metadata.stamp.epoch ||
          row.identity.scope !== metadata.authority
        )
          return { status: 'unavailable' } as const;
        const scope: IdentityScopeObservation = {
          key: { source: { kind: 'library', identity: row.identity }, scopeId: 'collection-source' },
          captureId: row.captureId,
          committedRevision: BigInt(row.revision),
        };
        let ownerFence: string | null = null;
        if (admission.owner && actor.kind === 'account') {
          const [row] = await withConnection(dependencies.pool, (client) =>
            ownerFilterQuery<{ generation: string }>(
              deadlineClient(client, deadline),
              work,
              ownerFenceQuery,
              { route: routeOf(actor.accountId), account_id: actor.accountId },
              { nativeRows: 4, bytes: 256 },
            ),
          );
          if (!row) return { status: 'unavailable' } as const;
          ownerFence = row.generation;
        }
        const binding: OwnerFilterReadBinding = {
          input: { actor, at, deadline, collectionId, allowance: ownerFilterAllowance(work) },
          scope,
        };
        bindings.set(binding, {
          dependencies,
          admission,
          metadata,
          observation: source.source.observation,
          ownsTime: ownTime,
          ownerFence,
          originals: new Map(),
          ...(inherited?.query ? { query: inherited.query } : {}),
          ...(attempt ? { attempt } : {}),
        });
        await revalidateNativeOwnerFilter(binding, work);
        // Binding work is already spent. Subsequent Source and closure consumers inherit only the remainder.
        const result: OwnerFilterReadBinding = {
          ...binding,
          input: { ...binding.input, allowance: ownerFilterAllowance(work) },
        };
        freeze(result);
        bindings.set(result, bindings.get(binding)!);
        retained = true;
        return { status: 'bound', binding: result } as const;
      },
    );
  } finally {
    if (ownTime && !retained) releaseOperationalTime(at);
  }
}
