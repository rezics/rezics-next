import { ProblemError } from '../http/problem.ts';
import { libraryIdentitySQL } from './identity-native-planner-statements.ts';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, QueryResultRow } from 'pg';
import { shareAccount } from '../access/account-share.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import {
  currentCommand,
  currentCommandResources,
  withSingleCommandAttempt,
  noEffect,
  registerCommandCallback,
  runCommand,
  type CommandTransaction,
} from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withConnection } from '../database/pool.ts';
import {
  identityEpochStore,
  identityJobPartition,
  pageLibraryIdentityEpochChanges,
  IdentityEpochStoreError,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from '../semantic/identity-epoch-store.ts';
import { withReadTransaction } from '../semantic/read.ts';
import {
  isPrepaidIdentitySourceConsumerMaintenance,
  withIdentitySourceNoEffectCommand,
} from '../semantic/identity-source-consumer-maintenance.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../semantic/events.ts';
import type { IdentityChange, IdentityFrontier, IdentityJobRef } from '../semantic/identity-epoch-contract.ts';
import type {
  IdentityReceivingDisposition,
  IdentityReceivingSelection,
} from '../semantic/identity-receiving-effects-types.ts';
import { instrumentNativeCollectionWork, NativeCollectionWork } from './collection-source-work.ts';
import { createNativeLibrarySourceCustodyWithWork, readNativeIdentitySourceBasis, validateNativeIdentitySource } from './native-source-custody.ts';
import { readNativeCollectionMetadataWithWork, readNativeCollectionRawPageWithWork } from './collection-source-native.ts';
import { readOwnerNativeFactPage, type OwnerNativeFactDriver } from './owner-index.ts';
import type { CanonicalBasis, CanonicalRawKey } from './canonical-source-store.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';
import type { LibraryScopeEffectsKey } from './identity-scope-effects.ts';
import type {
  LibraryIdentityPlan,
  LibraryIdentityPlanInput,
  LibraryIdentityPlanResult,
  LibraryIdentityPlannedOriginal,
} from './identity-native-planner-types.ts';
import { libraryIdentityBoundedPlanSQL, libraryIdentityBoundedJobSQL } from './identity-native-planner-projection.ts';
import currentRead from './identity-native-planner-current.sql';
import {
  libraryIdentityFootprint,
  withLibraryIdentityWork,
  libraryIdentityWorkFor,
  allowance as remainingAllowance,
  deadlineOf,
  bounded,
  bindLibraryIdentityDeadline,
  bindLibraryIdentityPrepaidWork,
  consumeLibraryIdentitySelectedCall,
} from './identity-native-planner-work.ts';

export type { LibraryIdentityPlanInput, LibraryIdentityPlanResult } from './identity-native-planner-types.ts';
const drivers = ['member', 'entry', 'label', 'session', 'copy', 'output'] as const;
const stale = (detail: string) => new IdentityEpochStoreError('identity_effect_stale', detail);
const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalize(JSON.parse(json(value)))!)
    .digest('hex');
export const libraryIdentityPlanKey = (key: LibraryScopeEffectsKey) =>
  digest({ job: key.job, sourceIdentity: key.sourceIdentity, scope: key.scope });
export const equalLibraryIdentityValue = (a: unknown, b: unknown) =>
  canonicalize(JSON.parse(json(a))) === canonicalize(JSON.parse(json(b)));
export function validateLibraryIdentityPlanKey(key: LibraryScopeEffectsKey): void {
  const s = key.sourceIdentity;
  if (s.scope !== 'public_output') validateNativeIdentitySource(s);
  if (
    routeOf(s.collectionId) !== s.route ||
    (s.scope !== 'public_output' && routeOf(s.accountId) === null) ||
    routeOf(key.job.jobId) === null ||
    typeof key.job.epoch !== 'bigint' ||
    key.job.epoch <= 0n ||
    key.job.epoch > 9223372036854775807n ||
    !key.scope ||
    Buffer.byteLength(key.scope) > 256 ||
    Buffer.byteLength(json(s)) > 2048
  )
    throw new TypeError('Invalid native Library identity plan locator');
}
export function libraryIdentityPlanFrontier(
  plan: Pick<
    LibraryIdentityPlan,
    'capture_id' | 'generation' | 'driver' | 'after_subject' | 'after_fact' | 'version' | 'phase'
  >,
): IdentityFrontier {
  return {
    after: [
      plan.capture_id,
      plan.generation,
      plan.driver,
      plan.after_subject,
      plan.after_fact,
      plan.version,
      plan.phase,
    ],
    segment: 0,
  };
}
export function libraryIdentityPlanEffects(
  key: LibraryScopeEffectsKey,
  plan: LibraryIdentityPlan,
  item: LibraryIdentityPlannedOriginal,
): readonly { selection: IdentityReceivingSelection; operation: unknown }[] {
  const source = key.sourceIdentity;
  if (source.scope === 'public_output') throw stale('Public output native identity planning is unavailable');
  if (!item.change) return [];
  const dispositions: IdentityReceivingDisposition[] = plan.phase === 'raw' ? ['OLD', 'NEW', 'first-apply'] : ['OLD'];
  if (plan.old_head || plan.old_state) dispositions.push('handoff');
  return dispositions.map((disposition) => {
    const operation = {
      job: key.job,
      sourceIdentity: key.sourceIdentity,
      scope: key.scope,
      generation: plan.generation,
      phase: plan.phase,
      captureId: plan.capture_id,
      collectionFence: plan.collection_fence,
      accountFence: plan.account_fence,
      raw: item.key,
      change: item.change,
      oldHead: plan.old_head,
      oldState: plan.old_state,
      disposition,
    };
    return {
      operation,
      selection: {
        job: key.job,
        original: item.change!.original,
        effectKey: `library-native:${digest(operation)}`,
        owner: source.accountId,
        sourceId: key.sourceIdentity.collectionId,
        scope: key.scope,
        disposition,
        capture: { identity: key.sourceIdentity, frontier: plan.capture_frontier },
      },
    };
  });
}

/** Exact primary-key read. Hash is a hint; always compare the complete retained identity. */
export async function readLibraryIdentityPlan(
  tx: CommandTransaction,
  key: LibraryScopeEffectsKey,
  lock = false,
): Promise<LibraryIdentityPlan | null> {
  const row = (
    await tx.query<LibraryIdentityPlan & { projection_valid: boolean }>(libraryIdentityBoundedPlanSQL.replace(/;\s*$/, lock ? ' FOR UPDATE' : ''), [
      key.sourceIdentity.route,
      key.sourceIdentity.collectionId,
      libraryIdentityPlanKey(key),
    ])
  ).rows[0];
  if (!row) return null;
  if (!row.projection_valid || !row.capture_frontier ||
      !Number.isSafeInteger(row.capture_frontier.version) || row.capture_frontier.version < 0 ||
      row.capture_frontier.version > 2147483647 ||
      typeof row.capture_frontier.scanned !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(row.capture_frontier.scanned) ||
      BigInt(row.capture_frontier.scanned) > 9223372036854775807n)
    throw stale('Invalid native Library plan projection');
  if (
    !equalLibraryIdentityValue(row.source_identity, key.sourceIdentity) ||
    row.job_id !== key.job.jobId ||
    BigInt(row.job_epoch) !== key.job.epoch ||
    row.scope !== key.scope
  )
    throw stale('Native Source plan key collision');
  return row;
}
async function query<R extends QueryResultRow>(tx: CommandTransaction, sql: string, values: unknown[]): Promise<R[]> {
  return (await tx.query<R>(sql, values)).rows;
}
/** No foreign client survives into this function. Owner, capture and control all resolve on this native client. */
export async function currentLibraryIdentityPlan(
  tx: CommandTransaction,
  key: LibraryScopeEffectsKey,
  plan: LibraryIdentityPlan,
  ledger: NativeCollectionWork,
): Promise<boolean> {
  if (
    key.sourceIdentity.scope === 'public_output' ||
    currentCommand(tx).partition !== partitionOf(key.sourceIdentity.route) ||
    identityJobPartition(key.job) !== currentCommand(tx).partition
  )
    return false;
  const source = key.sourceIdentity;
  const current = await tx.query(currentRead.sql, [
    source.route,
    source.collectionId,
    plan.capture_id,
    routeOf(source.accountId),
    source.accountId,
    source.ownerEpoch,
    source.incarnation,
    source.generation,
    source.scope,
    source.receivingEpoch,
    source.effectKey,
    plan.collection_fence,
    plan.account_fence,
    plan.capture_frontier.version,
    plan.capture_frontier.scanned,
  ]);
  if (current.rowCount !== 1 || plan.capture_frontier.driver !== 'done') return false;
  // Account-backed explicit output has its own native publication/commit/fence proof.
  if (source.scope === 'active_explicit_output') {
    const basis = await readNativeIdentitySourceBasis(
      tx,
      source,
      {
        allowance: remainingAllowance(ledger),
        deadline: currentCommandResources(tx).deadline,
        captureId: plan.capture_id,
      },
      ledger,
    );
    if (
      basis.status !== 'current' ||
      !basis.complete ||
      !equalLibraryIdentityValue(basis.frontier, plan.capture_frontier)
    )
      return false;
  }
  const job = (
    await query<{ transaction_id: string; scope_digest: string; writer_fence: unknown }>(tx, libraryIdentityBoundedJobSQL, [
      currentCommand(tx).partition,
      key.job.jobId,
      key.job.epoch.toString(),
    ])
  )[0];
  return (
    !!job &&
    job.transaction_id === plan.job_transaction_id &&
    job.scope_digest === plan.scope_digest &&
    equalLibraryIdentityValue(job.writer_fence, plan.job_writer_fence)
  );
}
function event(job: IdentityJobRef) {
  return {
    type: IDENTITY_EPOCH_ADMITTED,
    data: {
      partition: identityJobPartition(job),
      jobId: job.jobId,
      epoch: job.epoch.toString(),
    },
  };
}
/** Framework statements, Source locks, callbacks, outbox and receipts consume the same reservation. */
export async function libraryIdentityCommand<T>(
  pool: Pool,
  ledger: NativeCollectionWork,
  partition: number,
  operation: (tx: CommandTransaction) => Promise<ReturnType<typeof noEffect<T>>>,
): Promise<T> {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    bindLibraryIdentityPrepaidWork(pool, ledger, deadlineOf(ledger));
  return withLibraryIdentityWork(pool, ledger, async () => {
    if (isPrepaidIdentitySourceConsumerMaintenance(pool)) {
      // Source binds Core's real lifetime to the private original and reserves
      // its disjoint controls. Only Library body SQL belongs to this partition.
      const result = await withIdentitySourceNoEffectCommand(pool, deadlineOf(ledger), () =>
        withSingleCommandAttempt(() => runCommand(pool, { partition, deadline: deadlineOf(ledger) }, (tx) =>
          libraryIdentityWorkFor(tx, ledger, () => instrumentNativeCollectionWork(
            pool, ledger, (sql, values) => libraryIdentityFootprint(sql, values, ledger),
            () => operation(tx), tx,
          )),
        )),
      );
      return result.value;
    }
    const result = await instrumentNativeCollectionWork(
      pool,
      ledger,
      (sql, values) => libraryIdentityFootprint(sql, values, ledger),
      () =>
        withSingleCommandAttempt(() =>
          runCommand(pool, { partition, deadline: deadlineOf(ledger) }, async (tx) => {
            return libraryIdentityWorkFor(tx, ledger, () => operation(tx));
          }),
        ),
    );
    return result.value;
  });
}

/** Resolve pending mappings only through the admitted job's immutable native input-generation transform.
 * The predecessor is an indexed seek, not an ordinary pending=>self mapping or a history walk.
 */
async function plannedOriginal(
  pool: Pool,
  job: IdentityJobRef,
  key: CanonicalRawKey,
  ledger: NativeCollectionWork,
): Promise<LibraryIdentityPlannedOriginal | null> {
  const n = BigInt(`0x${key.storedSubjectId.replaceAll('-', '')}`) - 1n;
  const hex = n.toString(16).padStart(32, '0');
  const after =
    n > 0n ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : null;
  const page = await bounded(ledger, () =>
    withReadTransaction(
      pool,
      (tx) => pageLibraryIdentityEpochChanges(tx, job, after),
      deadlineOf(ledger),
    ),
  );
  const change: IdentityChange | undefined = page.changes.find((item) => item.original === key.storedSubjectId);
  if (change) return { key, change, terminal: change.terminal, mappingEpoch: null };
  const mapping = await bounded(ledger, () =>
    withRequestDeadline(deadlineOf(ledger), () => identityEpochStore.readMapping(pool, key.storedSubjectId)),
  );
  return mapping.state === 'mapped'
    ? { key, change: null, terminal: mapping.terminal, mappingEpoch: mapping.epoch.toString() }
    : null;
}

/** Old ready/working evidence is traversed too: a removed raw fact may still have an OLD reference.
 * Both stores are existing Source-owned derived generations, never original fact mirrors.
 */
async function readRetainedIdentityReferences(
  pool: Pool,
  plan: LibraryIdentityPlan,
  limit: number,
  ledger: NativeCollectionWork,
) {
  const legacy = plan.phase !== 'old-references';
  const generation = !legacy
    ? plan.old_head
    : plan.phase === 'old-ready'
      ? plan.old_state?.readyGeneration
      : plan.old_state?.workingGeneration;
  const basis = plan.phase === 'old-ready' ? plan.old_state?.readyBasis : plan.old_state?.workingBasis;
  if (!generation || (legacy && !basis)) throw stale('Missing retained OLD Source generation');
  const rows = await bounded(ledger, () =>
    withConnection(
      pool,
      async (tx) =>
        (
          await deadlineClient(tx, deadlineOf(ledger)).query<{ storedSubjectId: string; factId: string }>(
            legacy ? libraryIdentitySQL.oldFacts : libraryIdentitySQL.oldReferences,
            legacy
              ? [
                  plan.route,
                  plan.collection_id,
                  generation,
                  plan.driver,
                  plan.after_subject ?? '00000000-0000-0000-0000-000000000000',
                  plan.after_fact ?? '00000000-0000-0000-0000-000000000000',
                  basis,
                  limit,
                ]
              : [
                  plan.route,
                  plan.collection_id,
                  generation,
                  drivers.indexOf(plan.driver as CanonicalRawKey['driver']),
                  plan.after_subject ?? '00000000-0000-0000-0000-000000000000',
                  plan.after_fact ?? '00000000-0000-0000-0000-000000000000',
                  limit,
                ],
          )
        ).rows,
    ),
  );
  const keys = rows.map((row) => ({ key: { driver: plan.driver as CanonicalRawKey['driver'], ...row } }));
  return { rows: keys, after: keys.at(-1)?.key ?? null, exhausted: rows.length < limit };
}

/** The sole native manifest producer. One RAW six-driver page, released mapping homes, then native final CAS.
 * A building derived generation never becomes a ready head or participant acknowledgement here.
 */
async function advanceNativePlan(
  pool: Pool,
  input: LibraryIdentityPlanInput,
  l: NativeCollectionWork,
): Promise<LibraryIdentityPlanResult> {
  validateLibraryIdentityPlanKey(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
    throw new TypeError('Native identity plan limit must be 1..100');
  const result = (status: LibraryIdentityPlanResult['status']): LibraryIdentityPlanResult => ({
    status,
    work: l.receipt(),
  });
  const s = input.sourceIdentity;
  const home = partitionOf(s.route);
  if (input.scope !== 'collection-source' || s.scope === 'public_output') return result('unavailable');
  if (home !== identityJobPartition(input.job) || partitionOf(routeOf(s.accountId)!) !== home)
    return result('unavailable');
  const initial = await readNativeCollectionMetadataWithWork(pool, s, {
    allowance: remainingAllowance(l), deadline: input.deadline,
  }, l);
  const native = initial.metadata;
  if (
    !native ||
    native.incarnation !== s.incarnation ||
    native.sourceGeneration !== s.generation ||
    native.curatorAccountId !== s.accountId ||
    native.authority !== (s.scope === 'active_explicit_output' ? 'activated_output' : s.scope) ||
    (s.scope === 'private_builtin' && !native.builtinKind)
  ) {
    // A rekey/birth/owner move can change metadata before capture lookup. Exclude this stale
    // retained episode from the pending prefix without deleting any private evidence.
    await libraryIdentityCommand(pool, l, home, async (tx) => {
      const prior = await readLibraryIdentityPlan(tx, input, true);
      if (prior?.state !== 'building') return noEffect(null);
      await tx.query(libraryIdentitySQL.invalidateKey, [s.route, s.collectionId, prior.plan_key]);
      return { value: null, events: [event(input.job)] };
    });
    return result('unavailable');
  }
  // Independently acquire genuine raw custody; ordinary Source readiness is not a producer dependency.
  const observedBasis = await libraryIdentityCommand(pool, l, home, async (tx) => {
    const prior = await readLibraryIdentityPlan(tx, input, true);
    const basis = await readNativeIdentitySourceBasis(
      tx,
      s,
      {
        allowance: remainingAllowance(l),
        deadline: input.deadline,
        ...(prior ? { captureId: prior.capture_id } : {}),
      },
      l,
    );
    if (basis.status !== 'current' && prior && prior.state !== 'invalidated') {
      await tx.query(libraryIdentitySQL.invalidateKey, [s.route, s.collectionId, prior.plan_key]);
      return { value: { basis, prior: true }, events: [event(input.job)] };
    }
    return noEffect({ basis, prior: !!prior });
  });
  if (observedBasis.basis.status !== 'current') {
    if (observedBasis.prior) return result('unavailable');
    const allowance = remainingAllowance(l);
    const started = await createNativeLibrarySourceCustodyWithWork(pool, l).capturePage({
      identity: s,
      frontier: null,
      limit: Math.min(input.limit, allowance.remaining.candidateKeys),
      allowance,
      deadline: input.deadline,
    });
    return result(started.status === 'pending' ? 'pending' : 'unavailable');
  }
  let plan = await libraryIdentityCommand(pool, l, home, async (tx) => {
    await shareAccount(tx, s.accountId);
    const prior = await readLibraryIdentityPlan(tx, input, true);
    const source = await readNativeIdentitySourceBasis(
      tx,
      s,
      {
        allowance: remainingAllowance(l),
        deadline: input.deadline,
        ...(prior ? { captureId: prior.capture_id } : {}),
      },
      l,
    );
    if (source.status !== 'current') {
      if (prior?.state === 'building') {
        await tx.query(libraryIdentitySQL.invalidateKeyInline, [s.route, s.collectionId, prior.plan_key]);
        return { value: null, events: [event(input.job)] };
      }
      return noEffect(null);
    }
    const job = (
      await query<{ transaction_id: string; scope_digest: string; writer_fence: unknown }>(tx, libraryIdentityBoundedJobSQL, [
        home,
        input.job.jobId,
        input.job.epoch.toString(),
      ])
    )[0];
    if (!job || !job.scope_digest) return noEffect(null);
    if (prior) return noEffect(prior.state === 'invalidated' ? null : prior);
    // Two retained native generations is the existing Source capacity; do not silently evict old custody.
    const retained = await query<{ generation: string; state: string }>(tx, libraryIdentitySQL.retainedGenerations, [
      s.route,
      s.collectionId,
    ]);
    if (retained.length === 2) return noEffect(null);
    const heads = await query<{ generation: string }>(tx, libraryIdentitySQL.oldHead, [s.route, s.collectionId]);
    const states = await query<{ basis: NonNullable<LibraryIdentityPlan['old_state']> }>(
      tx,
      libraryIdentitySQL.oldState,
      [s.route, s.collectionId],
    );
    const generation = randomUUID();
    const basis: CanonicalBasis = {
      digest: digest([libraryIdentityPlanKey(input), generation, source.frontier.captureId, job.transaction_id]),
      incarnation: s.incarnation,
      authority:
        s.scope === 'curated'
          ? { kind: 'curated' }
          : s.scope === 'active_explicit_output'
            ? { kind: 'activated_output', generation: s.outputGeneration }
            : { kind: 'private_builtin', curatorAccountId: s.accountId },
      sourceFence: digest([source.collectionFence, source.accountFence]),
      identity: { digest: job.scope_digest },
      meaning:
        s.scope === 'private_builtin'
          ? digest([native.builtinKind, native.releaseDigest, native.profileId, native.stateSetId, native.stateId])
          : null,
    };
    // Prior work is detached and retained, never deleted. A later query publication needs its independent protocol.
    const previousWorking = retained.find((row) => row.state === 'working');
    if (previousWorking)
      await tx.query(libraryIdentitySQL.invalidateGeneration, [s.route, s.collectionId, previousWorking.generation]);
    await tx.query(libraryIdentitySQL.abandonWorking, [s.route, s.collectionId]);
    const oldHead = heads[0]?.generation ?? retained.find((row) => row.state === 'working')?.generation ?? null;
    const oldState = states[0]?.basis ?? null;
    const phase: LibraryIdentityPlan['phase'] = oldHead
      ? 'old-references'
      : oldState?.readyGeneration
        ? 'old-ready'
        : oldState?.workingGeneration
          ? 'old-working'
          : 'raw';
    const driver =
      phase !== 'raw' || s.scope === 'curated' ? 'member' : s.scope === 'active_explicit_output' ? 'output' : 'entry';
    await tx.query(libraryIdentitySQL.insertGeneration, [s.route, s.collectionId, generation, json(basis), driver]);
    const frontier = libraryIdentityPlanFrontier({
      capture_id: source.frontier.captureId,
      generation,
      driver,
      after_subject: null,
      after_fact: null,
      version: '0',
      phase,
    });
    await tx.query(libraryIdentitySQL.insertPlan, [
      s.route,
      s.collectionId,
      libraryIdentityPlanKey(input),
      s.accountId,
      json(s),
      input.job.jobId,
      input.job.epoch.toString(),
      input.scope,
      generation,
      source.frontier.captureId,
      json(source.frontier),
      source.collectionFence,
      source.accountFence,
      job.transaction_id,
      job.scope_digest,
      driver,
      oldHead,
      oldState ? json(oldState) : null,
      json(frontier),
      phase,
      json(job.writer_fence),
    ]);
    return { value: await readLibraryIdentityPlan(tx, input), events: [event(input.job)] };
  });
  if (!plan) return result('unavailable');
  if (plan.state === 'sealed') {
    const current = await libraryIdentityCommand(pool, l, home, async (tx) =>
      noEffect(await currentLibraryIdentityPlan(tx, input, plan!, l)),
    );
    return result(current ? 'sealed' : 'pending');
  }
  // A completed capture is actual all-family RAW coverage. Its immutable receipt, not EOF alone, is required.
  const current = await libraryIdentityCommand(pool, l, home, async (tx) => {
    const source = await readNativeIdentitySourceBasis(
      tx,
      s,
      {
        allowance: remainingAllowance(l),
        deadline: input.deadline,
        captureId: plan!.capture_id,
      },
      l,
    );
    if (source.status !== 'current' || !source.complete || source.frontier.captureId !== plan!.capture_id)
      return noEffect(false);
    if (source.collectionFence !== plan!.collection_fence || source.accountFence !== plan!.account_fence)
      return noEffect(false);
    if (!equalLibraryIdentityValue(source.frontier, plan!.capture_frontier)) {
      await tx.query(libraryIdentitySQL.advanceCapture, [
        s.route,
        s.collectionId,
        plan!.plan_key,
        json(source.frontier),
      ]);
      plan = { ...plan!, capture_frontier: source.frontier };
      return { value: true, events: [event(input.job)] };
    }
    return noEffect(true);
  });
  if (!current) {
    const basis = observedBasis.basis;
    if (!basis.complete) {
      const custody = createNativeLibrarySourceCustodyWithWork(pool, l);
      if (basis.frontier.driver === 'done') {
        const finished = await custody.finishCapture({
          identity: s, frontier: basis.frontier, allowance: remainingAllowance(l), deadline: input.deadline,
        });
        return result(finished.status === 'complete' ? 'pending' : 'unavailable');
      }
      const allowance = remainingAllowance(l);
      const captured = await custody.capturePage({
        identity: s,
        frontier: basis.frontier,
        limit: Math.min(input.limit, allowance.remaining.candidateKeys),
        allowance,
        deadline: input.deadline,
      });
      return result(captured.status === 'pending' ? 'pending' : 'unavailable');
    }
    return result('pending');
  }
  const observed = await readNativeCollectionMetadataWithWork(pool, s, {
    allowance: remainingAllowance(l), deadline: input.deadline,
  }, l);
  const metadata = observed.metadata;
  if (
    !metadata ||
    metadata.incarnation !== s.incarnation ||
    metadata.sourceGeneration !== s.generation ||
    metadata.curatorAccountId !== s.accountId ||
    metadata.authority !== (s.scope === 'active_explicit_output' ? 'activated_output' : s.scope)
  )
    return result('unavailable');
  const rawSequence: readonly CanonicalRawKey['driver'][] =
    s.scope === 'curated'
      ? ['member']
      : s.scope === 'active_explicit_output'
        ? ['output']
        : ['entry', 'label', 'session', 'copy'];
  const sequence: readonly CanonicalRawKey['driver'][] = plan.phase === 'raw' ? rawSequence : drivers;
  if (plan.driver !== 'done' && !sequence.includes(plan.driver))
    throw stale('Native Source driver disagrees with the actual source kind');
  if (plan.driver !== 'done' && remainingAllowance(l).remaining.candidateKeys < 1) return result('pending');
  const page =
    plan.driver === 'done'
      ? null
      : plan.phase !== 'raw'
        ? await readRetainedIdentityReferences(
            pool,
            plan,
            Math.min(input.limit, remainingAllowance(l).remaining.candidateKeys),
            l,
          )
        : metadata.authority === 'private_builtin'
          ? await bounded(l, () =>
              withConnection(pool, (client) =>
                readOwnerNativeFactPage(
                  deadlineClient(client, input.deadline),
                  s.accountId,
                  plan!.driver as OwnerNativeFactDriver,
                  plan!.after_subject && plan!.after_fact
                    ? {
                        driver: plan!.driver as OwnerNativeFactDriver,
                        storedSubjectId: plan!.after_subject,
                        factId: plan!.after_fact,
                      }
                    : null,
                  Math.min(input.limit, l.available('candidateKeys')),
                ),
              ),
            )
          : await readNativeCollectionRawPageWithWork(pool, metadata, {
                driver: plan!.driver as CanonicalRawKey['driver'],
                after:
                  plan!.after_subject && plan!.after_fact
                    ? {
                        driver: plan!.driver as CanonicalRawKey['driver'],
                        storedSubjectId: plan!.after_subject,
                        factId: plan!.after_fact,
                      }
                    : null,
                limit: Math.min(input.limit, l.available('candidateKeys')),
                allowance: remainingAllowance(l),
                deadline: input.deadline,
              }, l);
  const staged: LibraryIdentityPlannedOriginal[] = [];
  const originalPlans = new Map<string, LibraryIdentityPlannedOriginal>();
  for (const row of page?.rows ?? []) {
    const saved = originalPlans.get(row.key.storedSubjectId);
    const item = saved ? { ...saved, key: row.key } : await plannedOriginal(pool, input.job, row.key, l);
    if (item) originalPlans.set(row.key.storedSubjectId, item);
    if (!item) return result('pending');
    // The current native local claim is compared again in the final Source transaction.
    if (partitionOf(routeOf(item.key.storedSubjectId)!) !== home) return result('unavailable');
    staged.push(item);
  }
  const status = await libraryIdentityCommand(pool, l, home, async (tx) => {
    await shareAccount(tx, s.accountId);
    const locked = await readLibraryIdentityPlan(tx, input, true);
    if (
      !locked ||
      locked.version !== plan!.version ||
      locked.state !== 'building' ||
      !(await currentLibraryIdentityPlan(tx, input, locked, l))
    )
      return noEffect('pending' as const);
    for (const item of staged) {
      const gate = (
        await query<{ terminal: string; epoch: string; pending_job: string | null; pending_epoch: string | null }>(
          tx,
          libraryIdentitySQL.mappingClaim,
          [routeOf(item.key.storedSubjectId), item.key.storedSubjectId, home],
        )
      )[0];
      if (
        !gate ||
        (item.change
          ? gate.pending_job !== input.job.jobId || gate.pending_epoch !== input.job.epoch.toString()
          : gate.pending_job !== null || gate.terminal !== item.terminal || gate.epoch !== item.mappingEpoch)
      )
        throw stale('Native Source mapping or pending claim changed before plan commit');
      // Enrollment and structural derived generation writes are one native commit; no callback can omit a row.
      for (const expected of libraryIdentityPlanEffects(input, locked, item)) {
        const inserted = await tx.query(libraryIdentitySQL.insertEffect, [
          s.route,
          s.collectionId,
          locked.plan_key,
          expected.selection.effectKey,
          expected.selection.disposition,
          item.key.storedSubjectId,
          json(expected.operation),
        ]);
        if (!inserted.rowCount) {
          const row = (
            await query<{ operation: unknown }>(tx, libraryIdentitySQL.readEffect, [
              s.route,
              s.collectionId,
              locked.plan_key,
              expected.selection.effectKey,
              expected.selection.disposition,
            ])
          )[0];
          if (!row || !equalLibraryIdentityValue(row.operation, expected.operation))
            throw stale('Native effect key collision');
        }
      }
      if (locked.phase === 'raw')
        await tx.query(libraryIdentitySQL.insertReference, [
          s.route,
          s.collectionId,
          locked.generation,
          item.terminal,
          item.key.storedSubjectId,
          drivers.indexOf(item.key.driver),
          item.key.factId,
        ]);
    }
    let driver = !page
      ? 'done'
      : page.exhausted
        ? (sequence[sequence.indexOf(locked.driver as CanonicalRawKey['driver']) + 1] ?? 'done')
        : locked.driver;
    let phase = locked.phase;
    if (driver === 'done' && phase !== 'raw') {
      phase =
        phase === 'old-references' && locked.old_state?.readyGeneration
          ? 'old-ready'
          : phase !== 'old-working' && locked.old_state?.workingGeneration
            ? 'old-working'
            : 'raw';
      driver = phase === 'raw' ? rawSequence[0]! : 'member';
    }
    const next = {
      ...locked,
      phase,
      driver,
      after_subject: !page || page.exhausted ? null : (page.after?.storedSubjectId ?? null),
      after_fact: !page || page.exhausted ? null : (page.after?.factId ?? null),
      version: (BigInt(locked.version) + 1n).toString(),
    };
    const frontier = libraryIdentityPlanFrontier(next);
    const advanced = await tx.query(libraryIdentitySQL.advanceGeneration, [
      s.route,
      s.collectionId,
      locked.generation,
      driver,
      next.after_subject,
      next.after_fact,
      driver === 'done',
      locked.version,
    ]);
    if (advanced.rowCount !== 1) throw stale('Native identity derived generation was replaced');
    await tx.query(libraryIdentitySQL.advancePlan, [
      s.route,
      s.collectionId,
      locked.plan_key,
      driver,
      next.after_subject,
      next.after_fact,
      json(frontier),
      phase,
    ]);
    if (driver === 'done') {
      // Detach only after all raw producers have enrolled their OLD/NEW/first-apply/handoff rows.
      // Presence selects the mutation; retained RAW coverage and the final fence establish completeness.
      await tx.query(libraryIdentitySQL.detachHead, [s.route, s.collectionId, locked.old_head, locked.plan_key]);
      await tx.query(libraryIdentitySQL.detachState, [s.route, s.collectionId, locked.plan_key]);
      // This is the final native writer/capture/current-job compare, after ALL required raw drivers and enrollment.
      if (!(await currentLibraryIdentityPlan(tx, input, next, l)))
        throw stale('Native Source changed at final plan fence');
      recordIdentityEpochNativeCommit(tx, 'library-private-follow-counts');
      registerCommandCallback(tx, async (transactionId) => {
        await tx.query(libraryIdentitySQL.insertSeal, [
          s.route,
          s.collectionId,
          locked.plan_key,
          locked.generation,
          next.version,
          json(frontier),
          json(locked.capture_frontier),
          transactionId,
        ]);
        await tx.query(libraryIdentitySQL.sealPlan, [
          s.route,
          s.collectionId,
          locked.plan_key,
          transactionId,
          next.version,
        ]);
      });
    }
    return { value: driver === 'done' ? ('sealed' as const) : ('pending' as const), events: [event(input.job)] };
  });
  return result(status);
}

/** Fixed participant resumes only its exact job's native building prefix, sixteen routed index seeks. */
export async function nextLibraryIdentityNativePlan(
  pool: Pool,
  job: IdentityJobRef,
  input: { allowance: WorkAllowance; deadline: number },
): Promise<{ key: LibraryScopeEffectsKey | null; work: WorkReceipt }> {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    throw new TypeError('Selected Library original cannot fund independent discovery');
  const ledger = bindLibraryIdentityDeadline(new NativeCollectionWork(input.allowance, input.deadline), input.deadline);
  return withLibraryIdentityWork(pool, ledger, () => nextNativePlan(pool, job, input.deadline, ledger));
}

export async function nextLibraryIdentityNativePlanWithWork(
  pool: Pool,
  job: IdentityJobRef,
  input: { deadline: number },
  work: NativeCollectionWork,
): Promise<{ key: LibraryScopeEffectsKey | null; work: WorkReceipt }> {
  bindLibraryIdentityPrepaidWork(pool, work, input.deadline);
  consumeLibraryIdentitySelectedCall(pool, work, 'discovery');
  return withLibraryIdentityWork(pool, work, () => nextNativePlan(pool, job, input.deadline, work));
}
async function nextNativePlan(pool: Pool, job: IdentityJobRef, deadline: number, ledger: NativeCollectionWork) {
  const home = identityJobPartition(job);
  for (let route = home * 16; route < home * 16 + 16; route++) {
    const row = await bounded(ledger, () =>
      withConnection(
        pool,
        async (tx) =>
          (
            await deadlineClient(tx, deadline).query<{
              source_identity: LibraryScopeEffectsKey['sourceIdentity'];
              scope: string;
            }>(libraryIdentitySQL.nextPlan, [route, job.jobId, job.epoch.toString()])
          ).rows[0],
      ),
    );
    if (row) return { key: { job, sourceIdentity: row.source_identity, scope: row.scope }, work: ledger.receipt() };
  }
  return { key: null, work: ledger.receipt() };
}

export async function advanceLibraryIdentityNativePlan(
  pool: Pool,
  input: LibraryIdentityPlanInput,
): Promise<LibraryIdentityPlanResult> {
  if (isPrepaidIdentitySourceConsumerMaintenance(pool))
    throw new TypeError('Selected Library original cannot fund independent planning');
  const work = bindLibraryIdentityDeadline(new NativeCollectionWork(input.allowance, input.deadline), input.deadline);
  try {
    return await withLibraryIdentityWork(pool, work, () => advanceNativePlan(pool, input, work));
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'dependency_unavailable')
      return { status: 'unavailable', work: work.receipt() };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}

/** Server-only continuation with a genuinely prepaid partition; no refill or second ledger. */
export async function advanceLibraryIdentityNativePlanWithWork(
  pool: Pool,
  input: Omit<LibraryIdentityPlanInput, 'allowance'>,
  work: NativeCollectionWork,
): Promise<LibraryIdentityPlanResult> {
  bindLibraryIdentityPrepaidWork(pool, work, input.deadline);
  consumeLibraryIdentitySelectedCall(pool, work, 'plannerSteps');
  try {
    return await withLibraryIdentityWork(pool, work, () =>
      advanceNativePlan(pool, { ...input, allowance: remainingAllowance(work) }, work),
    );
  } catch (error) {
    if (error instanceof ProblemError && error.code === 'dependency_unavailable')
      return { status: 'unavailable', work: work.receipt() };
    if (error instanceof Error) Object.defineProperty(error, 'work', { get: () => work.receipt(), configurable: true });
    throw error;
  }
}
