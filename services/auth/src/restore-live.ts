import { NATIVE_PHASE_END } from './erasure-role-upgrade.ts';
import type {
  AuthErasureLiveObservation,
  AuthErasureLivePage,
  AuthErasureLivePorts,
  AuthErasureLiveReceiver,
} from '@rezics/auth-contract';
import type { Pool, PoolClient } from 'pg';
import { nativeRoleCoverageComplete } from './erasure-coverage.ts';
import {
  AuthRestoreAdmissionError,
  exactObligation,
  importProgress,
  inventoryFor,
  bindInventory,
  reconcileRestoredAuthCoverage,
  replayRestoredAuthPage,
  sourceCall,
  sourcePoint,
  stageRestoredAuthObligations,
  type AuthRestoredGeneration,
  type AuthRestoreInventory,
  type AuthRestorePendingCode,
} from './restore-admission.ts';

type Pending = { pending: AuthRestorePendingCode };
function refuse(code: AuthRestorePendingCode = 'source-live-handoff-pending'): never {
  throw new AuthRestoreAdmissionError(code);
}
const ordinal = (v: unknown): v is string =>
  typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9223372036854775807n;
const key = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 1024;
const bounded = (v: unknown, bytes: number) => Buffer.byteLength(JSON.stringify(v) ?? '') <= bytes;

/** A local typed adapter over the producer's ORIGINAL ABI. No replacement
 * declaration, transport, owner implementation or readiness flag lives here. */
function liveAdapter(ports: AuthErasureLivePorts): AuthErasureLivePorts {
  if (
    !ports ||
    ['armAuthErasureLivePartition', 'readAuthErasureLivePage', 'verifyAuthErasureLivePartition'].some(
      (method) => typeof ports[method as keyof AuthErasureLivePorts] !== 'function',
    )
  )
    refuse();
  return {
    armAuthErasureLivePartition: (input) => ports.armAuthErasureLivePartition(input),
    readAuthErasureLivePage: (input) => ports.readAuthErasureLivePage(input),
    verifyAuthErasureLivePartition: (input) => ports.verifyAuthErasureLivePartition(input),
  };
}
function receiverFor(inventory: AuthRestoreInventory, cutId: string): AuthErasureLiveReceiver {
  return {
    authGeneration: inventory.generation,
    databaseIdentity: inventory.databaseIdentity,
    inventoryEntry: inventory.inventoryEntry,
    inventoryVersion: inventory.inventoryVersion,
    cutId,
  };
}
function observation(value: AuthErasureLiveObservation, receiver: AuthErasureLiveReceiver, partition: number) {
  const r = value?.receiver;
  if (
    !r ||
    !bounded(value, 8192) ||
    r.authGeneration !== receiver.authGeneration ||
    r.databaseIdentity !== receiver.databaseIdentity ||
    r.inventoryEntry !== receiver.inventoryEntry ||
    r.inventoryVersion !== receiver.inventoryVersion ||
    r.cutId !== receiver.cutId ||
    value.partition !== partition ||
    !key(value.sourceGeneration) ||
    !key(value.sourceOwner) ||
    !Number.isSafeInteger(value.sourceEpoch) ||
    value.sourceEpoch! < 0 ||
    !ordinal(value.highWater) ||
    !ordinal(value.armHighWater) ||
    !ordinal(value.enrolledThrough) ||
    BigInt(value.enrolledThrough) < BigInt(value.highWater) ||
    BigInt(value.armHighWater) < BigInt(value.highWater) ||
    BigInt(value.armHighWater) > BigInt(value.enrolledThrough)
  )
    refuse();
}
function sameSource(a: AuthErasureLiveObservation, b: AuthErasureLiveObservation) {
  if (
    a.sourceGeneration !== b.sourceGeneration ||
    a.sourceEpoch !== b.sourceEpoch ||
    a.sourceOwner !== b.sourceOwner ||
    a.armHighWater !== b.armHighWater ||
    a.highWater !== b.highWater
  )
    refuse();
}
function validatePage(page: AuthErasureLivePage, arm: AuthErasureLiveObservation, after: string) {
  if (
    !page ||
    !bounded(page, 65536) ||
    !['page', 'tail-end', 'pending'].includes(page.state) ||
    !Array.isArray(page.obligations) ||
    !Array.isArray(page.pending) ||
    page.obligations.length + page.pending.length > 48 ||
    page.cursor?.partition !== arm.partition ||
    page.cursor.afterOrdinal !== after ||
    page.next?.partition !== arm.partition ||
    !ordinal(page.next.afterOrdinal)
  )
    refuse();
  if (
    page.partition?.state !== 'current' &&
    !(page.partition?.state === 'pending' && page.partition.reason === 'original-floor-unavailable')
  )
    refuse();
  observation(page.partition, arm.receiver, arm.partition);
  sameSource(page.partition, arm);
  let previous = BigInt(after);
  for (const raw of page.obligations) {
    const item = exactObligation(raw);
    if (BigInt(item.ordinal) <= previous || BigInt(item.ordinal) > BigInt(page.partition.enrolledThrough!)) refuse();
    previous = BigInt(item.ordinal);
  }
  if (
    BigInt(page.next.afterOrdinal) < previous ||
    BigInt(page.next.afterOrdinal) > BigInt(page.partition.enrolledThrough!) ||
    (page.state === 'page' && BigInt(page.next.afterOrdinal) <= BigInt(after)) ||
    (page.state === 'tail-end' &&
      (page.pending.length !== 0 || page.next.afterOrdinal !== page.partition.enrolledThrough))
  )
    refuse();
}
type Checkpoint = {
  arm: AuthErasureLiveObservation;
  after_ordinal: string;
  revision: string;
  verified: boolean;
};

/** ONE native partition or at most 48 tail obligations, under the caller's fixed
 * deadline. Every foreign call follows release of every Auth checkout. Imports
 * precede the CAS: interruption repeats immutable original recovery, never skips
 * a root or invents Auth progress absent from the independently recovered tail. */
export async function stageRestoredAuthLive(
  database: Pool,
  restored: AuthRestoredGeneration,
  inventory: AuthRestoreInventory,
  deadline = Date.now() + 5000,
): Promise<Pending> {
  if (!restored.live) return { pending: 'source-live-handoff-pending' };
  database = restoreDatabaseWithin(database, deadline);
  // Claim a rotating partition durably before calling Source. An unavailable
  // partition cannot starve future obligations in another partition.
  const generation = (
    await database.query<{ source_cut_id: string; selected: number }>(
      `UPDATE auth_restore_live_generation SET live_partition=(live_partition+1)%4096
     WHERE generation=$1
     RETURNING source_cut_id,(live_partition+4095)%4096 AS selected`,
      [restored.generation],
    )
  ).rows[0];
  if (!generation) return { pending: 'source-consumer-pending' };
  const selected = generation.selected;
  // Existing bounded home rotation, never an all-home scan or two held homes.
  // Revocation commits before this replacement may arm any receiving consumer.
  if (
    !restored.receiving?.invalidateAuthReceivingClosure ||
    !(await restored.receiving.invalidateAuthReceivingClosure({
      partition: selected,
      restoreGeneration: restored.generation,
      deadline,
    }))
  )
    return { pending: 'receiving-closure-pending' };
  const binding = await restored.receiving.readAuthReceivingControl?.({
    partition: selected,
    restoreGeneration: restored.generation,
    deadline,
  });
  if (!binding || binding.databaseIdentity !== inventory.databaseIdentity)
    return { pending: 'receiving-closure-pending' };
  const receiver = receiverFor(inventory, generation.source_cut_id);
  const matches = await database.query(
    'SELECT 1 FROM auth_restore_live_generation WHERE generation=$1 AND inventory=$2::jsonb',
    [restored.generation, JSON.stringify(inventory)],
  );
  if (!matches.rowCount) refuse('restore-lineage-mismatch');
  const original = (
    await database.query<{ verification: { highWater: string } }>(
      'SELECT verification FROM auth_restore_source_partition WHERE generation=$1 AND partition=$2',
      [restored.generation, selected],
    )
  ).rows[0]?.verification;
  if (!original || !ordinal(original.highWater)) refuse();
  let checkpoint = (
    await database.query<Checkpoint>(
      'SELECT arm,after_ordinal,revision,verified FROM auth_restore_live_partition WHERE generation=$1 AND partition=$2',
      [restored.generation, selected],
    )
  ).rows[0];
  if (checkpoint?.verified) {
    const client = await database.connect();
    try {
      await client.query('BEGIN');
      const changed = await client.query(
        `UPDATE auth_restore_live_partition SET verified=false,revision=revision+1
         WHERE generation=$1 AND partition=$2 AND revision=$3 RETURNING partition`,
        [restored.generation, selected, checkpoint.revision],
      );
      if (changed.rowCount)
        await client.query(
          'UPDATE auth_restore_live_generation SET live_verified_partitions=live_verified_partitions-1 WHERE generation=$1',
          [restored.generation],
        );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    checkpoint = (
      await database.query<Checkpoint>(
        'SELECT arm,after_ordinal,revision,verified FROM auth_restore_live_partition WHERE generation=$1 AND partition=$2',
        [restored.generation, selected],
      )
    ).rows[0]!;
  }
  let ports: AuthErasureLivePorts;
  try {
    ports = liveAdapter(restored.live(receiver));
  } catch (error) {
    if (error instanceof AuthRestoreAdmissionError) throw error;
    return refuse('source-authority-unavailable');
  }
  if (!checkpoint) {
    const arm = await sourceCall(deadline, () => ports.armAuthErasureLivePartition({ partition: selected, deadline }));
    if (arm?.state !== 'armed') refuse();
    observation(arm, receiver, selected);
    if (arm.highWater !== original.highWater) refuse();
    await database.query(
      `INSERT INTO auth_restore_live_partition(generation,partition,arm,after_ordinal)
       VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING`,
      [restored.generation, selected, JSON.stringify(arm), original.highWater],
    );
    checkpoint = (
      await database.query<Checkpoint>(
        'SELECT arm,after_ordinal,revision,verified FROM auth_restore_live_partition WHERE generation=$1 AND partition=$2',
        [restored.generation, selected],
      )
    ).rows[0]!;
  }
  observation(checkpoint.arm, receiver, selected);
  const page = await sourceCall(deadline, () =>
    ports.readAuthErasureLivePage({
      cursor: { partition: selected, afterOrdinal: checkpoint.after_ordinal },
      deadline,
    }),
  );
  validatePage(page, checkpoint.arm, checkpoint.after_ordinal);
  for (const raw of page.obligations) {
    const obligation = exactObligation(raw);
    if (!restored.obligations) refuse('source-authority-unavailable');
    const point = await sourcePoint(restored.obligations, obligation.accountId, deadline);
    if (JSON.stringify(point) !== JSON.stringify(obligation)) refuse('original-progress-mismatch');
    await importProgress(database, restored, inventory, obligation.accountId, obligation, deadline);
  }
  const verification = await sourceCall(deadline, () =>
    ports.verifyAuthErasureLivePartition({ partition: selected, deadline }),
  );
  let current = false;
  if (verification?.state === 'current') {
    observation(verification, receiver, selected);
    sameSource(verification, checkpoint.arm);
    current =
      page.state === 'tail-end' && page.pending.length === 0 && verification.enrolledThrough === page.next.afterOrdinal;
  }
  // A pending floor keeps its original cursor, including when useful earlier
  // roots were imported. Current Source enrollment is never a consumption ACK.
  const next =
    page.state !== 'pending' && page.pending.length === 0 ? page.next.afterOrdinal : checkpoint.after_ordinal;
  const client = await database.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const changed = await client.query(
      `UPDATE auth_restore_live_partition SET after_ordinal=$4,revision=revision+1,
       page=$5::jsonb,verification=$6::jsonb,verified=$7
       WHERE generation=$1 AND partition=$2 AND revision=$3 RETURNING partition`,
      [
        restored.generation,
        selected,
        checkpoint.revision,
        next,
        JSON.stringify(page),
        JSON.stringify(verification),
        current,
      ],
    );
    committed = Boolean(changed.rowCount);
    if (changed.rowCount)
      await client.query(
        `UPDATE auth_restore_live_generation SET live_verified_partitions=live_verified_partitions+$2
       WHERE generation=$1`,
        [restored.generation, Number(current) - Number(checkpoint.verified)],
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!committed || !current) return { pending: 'source-live-handoff-pending' };
  const count = (
    await database.query<{ live_verified_partitions: number }>(
      'SELECT live_verified_partitions FROM auth_restore_live_generation WHERE generation=$1',
      [restored.generation],
    )
  ).rows[0]!.live_verified_partitions;
  return count === 4096
    ? nextNativeBoundary(database, restored.generation)
    : { pending: 'source-live-handoff-pending' };
}

async function nextNativeBoundary(database: Pool, generation: string): Promise<Pending> {
  const inventory = (
    await database.query<{ replay_inventory_complete: boolean }>(
      'SELECT replay_inventory_complete FROM auth_restore_live_generation WHERE generation=$1',
      [generation],
    )
  ).rows[0]!;
  if (!inventory.replay_inventory_complete) return { pending: 'native-replay-pending' };
  const started = (
    await database.query<{ native_coverage_started: boolean }>(
      'SELECT native_coverage_started FROM auth_restore_generation WHERE generation=$1',
      [generation],
    )
  ).rows[0]?.native_coverage_started;
  if (!started) return { pending: 'native-replay-pending' };
  const client = await database.connect();
  let covered: boolean;
  try {
    await client.query('BEGIN');
    covered = await nativeRoleCoverageComplete(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (!covered) return { pending: 'native-replay-pending' };
  const native = await database.query(
    `SELECT 1 FROM auth_restore_live_work WHERE generation=$1 AND state='native' LIMIT 1`,
    [generation],
  );
  if (native.rowCount) return { pending: 'native-replay-pending' };
  const receiving = await database.query(
    "SELECT 1 FROM auth_restore_live_work WHERE generation=$1 AND state='receiving' LIMIT 1",
    [generation],
  );
  return { pending: receiving.rowCount ? 'receiving-closure-pending' : 'external-owner-pending' };
}

/** Isolated scheduling alternates Source and existing native replay durably.
 * No SDK/service/issuer is constructed. A restart resumes this generation's turn
 * and indexed native key; a held native consumer cannot starve other accounts. */
export async function reconcileRestoredAuthPage(database: Pool, restored: AuthRestoredGeneration): Promise<Pending> {
  const deadline = Date.now() + 5000;
  const local = restoreDatabaseWithin(database, deadline);
  const turn = (
    await local.query<{ turn: number; replay_after: string }>(
      `UPDATE auth_restore_live_generation SET reconcile_turn=1-reconcile_turn WHERE generation=$1
     RETURNING 1-reconcile_turn AS turn,replay_after`,
      [restored.generation],
    )
  ).rows[0];
  if (!turn || turn.turn === 0) return stageRestoredAuthObligations(database, restored, deadline);
  const inventory = await inventoryFor(database, restored, deadline);
  await bindInventory(local, inventory);
  if (await attachOriginalReplayPage(local, restored.generation))
    return sourceBoundary(local, restored, { pending: 'native-replay-pending' });
  const select = (after: string) =>
    local.query<{ obligation_id: string }>(
      `SELECT obligation_id FROM auth_restore_live_work WHERE generation=$1 AND obligation_id>$2
     AND state<>'external' ORDER BY obligation_id LIMIT 1`,
      [restored.generation, after],
    );
  const row = (await select(turn.replay_after)).rows[0] ?? (await select('0')).rows[0];
  if (!row) {
    if (await reconcileRestoredAuthCoverage(local, restored))
      return sourceBoundary(local, restored, { pending: 'native-replay-pending' });
    return stageRestoredAuthObligations(database, restored, deadline);
  }
  await local.query('UPDATE auth_restore_live_generation SET replay_after=$2 WHERE generation=$1', [
    restored.generation,
    row.obligation_id,
  ]);
  const result = await replayRestoredAuthPage(database, restored, row.obligation_id, undefined, deadline);
  await local.query(
    `UPDATE auth_restore_live_work SET state=CASE WHEN r.phase<>${NATIVE_PHASE_END} THEN 'native' WHEN r.copies_completed_at IS NOT NULL THEN 'external'
     WHEN r.native_completed_at IS NOT NULL AND r.consent_completed_at IS NOT NULL THEN 'receiving' ELSE 'native' END
     FROM auth_restore_replay r WHERE auth_restore_live_work.generation=$1 AND auth_restore_live_work.obligation_id=$2
     AND r.generation=$1 AND r.obligation_id=$2`,
    [restored.generation, row.obligation_id],
  );
  return sourceBoundary(local, restored, result);
}

/** Earlier restored-generation consumers already imported genuine immutable
 * progress. Attach at most 48 existing primary keys, rather than discovering
 * that work through an unindexed pending scan or treating an empty NEW queue as
 * native completion. Later imports enqueue in their original transaction. */
async function attachOriginalReplayPage(database: Pool, generation: string): Promise<boolean> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    const state = (
      await client.query<{ replay_inventory_after: string; replay_inventory_complete: boolean }>(
        'SELECT replay_inventory_after,replay_inventory_complete FROM auth_restore_live_generation WHERE generation=$1 FOR UPDATE',
        [generation],
      )
    ).rows[0]!;
    if (state.replay_inventory_complete) {
      await client.query('COMMIT');
      return false;
    }
    const rows = (
      await client.query<{ obligation_id: string; state: string }>(
        `SELECT obligation_id,CASE WHEN phase<>${NATIVE_PHASE_END} THEN 'native' WHEN copies_completed_at IS NOT NULL THEN 'external'
       WHEN native_completed_at IS NOT NULL AND consent_completed_at IS NOT NULL THEN 'receiving' ELSE 'native' END AS state
       FROM auth_restore_replay WHERE generation=$1 AND obligation_id>$2 ORDER BY obligation_id LIMIT 48`,
        [generation, state.replay_inventory_after],
      )
    ).rows;
    if (rows.length)
      await client.query(
        `INSERT INTO auth_restore_live_work(generation,obligation_id,state)
       SELECT $1,id,state FROM unnest($2::bigint[],$3::text[]) AS old(id,state) WHERE true ON CONFLICT DO NOTHING`,
        [generation, rows.map((row) => row.obligation_id), rows.map((row) => row.state)],
      );
    await client.query(
      `UPDATE auth_restore_live_generation SET replay_inventory_after=$2,replay_inventory_complete=$3 WHERE generation=$1`,
      [generation, rows.at(-1)?.obligation_id ?? state.replay_inventory_after, rows.length < 48],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function sourceBoundary(local: Pool, restored: AuthRestoredGeneration, result: Pending): Promise<Pending> {
  const source = (
    await local.query<{ source_cursor: unknown; source_verify_partition: number }>(
      'SELECT source_cursor,source_verify_partition FROM auth_restore_generation WHERE generation=$1',
      [restored.generation],
    )
  ).rows[0]!;
  if (source.source_cursor !== null || source.source_verify_partition !== 4096)
    return { pending: 'source-consumer-pending' };
  const live = (
    await local.query<{ live_verified_partitions: number }>(
      'SELECT live_verified_partitions FROM auth_restore_live_generation WHERE generation=$1',
      [restored.generation],
    )
  ).rows[0]!;
  if (!restored.live || live.live_verified_partitions !== 4096) return { pending: 'source-live-handoff-pending' };
  return result;
}

/** Apply the same absolute deadline to the EXISTING native engines without
 * mutating a shared pool or introducing another erasure implementation. Every
 * standalone query commits/releases before the caller can cross an owner port. */
export function restoreDatabaseWithin(database: Pool, deadline: number): Pool {
  const remaining = () => {
    if (Date.now() >= deadline) refuse('native-replay-pending');
    return String(Math.max(1, deadline - Date.now()));
  };
  const connect = async (): Promise<PoolClient> => {
    const wait = Number(remaining());
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const acquiring = database.connect().then((client) => {
      if (expired) {
        client.release();
        refuse('native-replay-pending');
      }
      return client;
    });
    let client: PoolClient;
    try {
      client = await Promise.race([
        acquiring,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new AuthRestoreAdmissionError('native-replay-pending'));
          }, wait);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    let transaction = false;
    return new Proxy(client, {
      get(target, property) {
        if (property === 'query')
          return async (...args: unknown[]) => {
            const sql = String(args[0]);
            if (/^ROLLBACK\b/i.test(sql)) {
              transaction = false;
              return Reflect.apply(target.query, target, args);
            }
            const ms = remaining();
            if (transaction)
              await target.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
                ms,
              ]);
            const result = await Reflect.apply(target.query, target, args);
            if (/^BEGIN\b/i.test(sql)) {
              transaction = true;
              await target.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
                remaining(),
              ]);
            }
            if (/^COMMIT\b/i.test(sql)) transaction = false;
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  return new Proxy(database, {
    get(target, property) {
      if (property === 'connect') return connect;
      if (property === 'query')
        return async (...args: unknown[]) => {
          const client = await connect();
          try {
            await client.query('BEGIN');
            const result = await Reflect.apply(client.query, client, args);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          } finally {
            client.release();
          }
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
