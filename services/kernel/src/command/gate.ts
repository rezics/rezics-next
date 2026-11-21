import type { Pool, PoolClient } from 'pg';
import { discardConnection } from '../database/pool.ts';

const MAX_WAITERS_PER_PARTITION = 64;

type GateState = {
  active: boolean;
  waiters: Waiter[];
};

type Waiter = {
  resolve: (admission: CommandGateAdmission) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CommandGateAdmission =
  | { readonly status: 'acquired'; readonly release: () => void }
  | { readonly status: 'deadline' | 'overloaded' };

const gates = new WeakMap<Pool, Map<number, GateState>>();

function cleanup(pool: Pool, partition: number, state: GateState): void {
  if (state.active || state.waiters.length > 0) return;
  const partitions = gates.get(pool);
  if (partitions?.get(partition) !== state) return;
  partitions.delete(partition);
}

function releaseFor(pool: Pool, partition: number, state: GateState): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = state.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
      return;
    }
    state.active = false;
    cleanup(pool, partition, state);
  };
}

/** FIFO admission for serializable transactions sharing a process-local pool and partition. */
export function enterCommandGate(pool: Pool, partition: number, deadline: number): Promise<CommandGateAdmission> {
  if (Date.now() >= deadline) return Promise.resolve({ status: 'deadline' });

  let partitions = gates.get(pool);
  if (!partitions) {
    partitions = new Map();
    gates.set(pool, partitions);
  }

  let state = partitions.get(partition);
  if (!state) {
    state = { active: true, waiters: [] };
    partitions.set(partition, state);
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
  }

  if (!state.active) {
    state.active = true;
    return Promise.resolve({ status: 'acquired', release: releaseFor(pool, partition, state) });
  }
  if (state.waiters.length >= MAX_WAITERS_PER_PARTITION) return Promise.resolve({ status: 'overloaded' });

  return new Promise((resolve) => {
    const waiter = {} as Waiter;
    waiter.resolve = resolve;
    waiter.timer = setTimeout(
      () => {
        const index = state!.waiters.indexOf(waiter);
        if (index >= 0) state!.waiters.splice(index, 1);
        resolve({ status: 'deadline' });
        cleanup(pool, partition, state!);
      },
      Math.max(0, deadline - Date.now()),
    );
    state!.waiters.push(waiter);
  });
}

const IDENTITY_BIRTH_LOCK = 0x525a4160;

/** A contended miss waits outside the write snapshot, then prepares fresh authority
 * while retaining the same session lock. The writer's transaction owns its release. */
export async function beginIdentityBirthTransaction(
  client: PoolClient,
  home: number,
  wait?: { deadline: number; prepare: () => Promise<void> },
): Promise<'writer' | 'receipt'> {
  const key = [IDENTITY_BIRTH_LOCK, home % 64];
  let preparing = false;
  try {
    if (wait) {
      await client.query(
        `SELECT pg_advisory_lock($1::integer, $2::integer)
         FROM set_config('lock_timeout', $3::text, true)`,
        [...key, `${Math.max(1, wait.deadline - Date.now())}ms`],
      );
      preparing = true;
      await wait.prepare();
      preparing = false;
    } else {
      const attempt = await client.query('SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', key);
      if (!attempt.rows[0]?.acquired) {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        return 'receipt';
      }
    }
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const transfer = await client.query<{ released: boolean }>(
      `SELECT pg_advisory_unlock($1::integer, $2::integer) AS released
       FROM pg_advisory_xact_lock($1::integer, $2::integer)`,
      key,
    );
    if (!transfer.rows[0]?.released) throw new Error('Missing identity birth session lock');
    return 'writer';
  } catch (error) {
    let released = false;
    if (preparing) {
      try {
        released =
          (await client.query('SELECT pg_advisory_unlock($1::integer, $2::integer) AS released', key)).rows[0]
            ?.released === true;
      } catch {
        // Preserve the admission error and close the uncertain session below.
      }
    }
    if (!released) discardConnection(client, error instanceof Error ? error : new Error('Identity birth lock failed'));
    throw error;
  }
}
