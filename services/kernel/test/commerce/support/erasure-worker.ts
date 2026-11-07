import type { Pool } from 'pg';
import { withConnection } from '../../../src/database/pool.ts';
import { readConsumerLag } from '../../../src/events/consumer-lag.ts';
import { EFFECTS_CONSUMER } from '../../../src/events/effects.ts';
import { partitionOf, routeOf } from '../../../src/route/route.ts';
import type { WorkClient } from '../../../src/work/client.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

const READY = 'Commerce erasure worker ready';
const TOMBSTONE = 'com.rezics.access.account-tombstoned.v1';

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

/** The next envelope after each effects checkpoint, oldest first. */
export async function readPendingEffects(pool: Pool, limit = 8) {
  return (
    await pool.query<{
      partition: number;
      position: string;
      type: string;
      payload_state: string;
      recorded_at: string;
    }>(
      `SELECT o.partition_no AS partition, o.position::text AS position, o.type, o.payload_state,
              to_char(o.recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS recorded_at
         FROM core.outbox o
         LEFT JOIN core.consumer_checkpoint c
           ON c.partition_no = o.partition_no AND c.consumer = $1
        WHERE o.position = COALESCE(c.position, 0) + 1
          AND o.event_seq = 0
        ORDER BY o.recorded_at ASC, o.partition_no
        LIMIT $2`,
      [EFFECTS_CONSUMER, limit],
    )
  ).rows;
}

/** Wait until the production effects relay has ticked and has no pending envelopes. */
export async function awaitEffectsCaughtUp(
  pool: Pool,
  ms = 90_000,
  detail?: () => Promise<unknown> | unknown,
): Promise<void> {
  await waitUntil(
    async () => {
      const lag = await withConnection(pool, (client) => readConsumerLag(client, EFFECTS_CONSUMER));
      const caughtUp =
        lag !== null && lag.oldestPendingAt === null && Date.now() - lag.observedAt.getTime() < 5_000;
      if (caughtUp) return { caughtUp: true as const };
      return {
        caughtUp: false as const,
        lag,
        pending: await readPendingEffects(pool),
        ...(detail === undefined ? {} : { detail: await detail() }),
      };
    },
    (value) => value.caughtUp,
    ms,
  );
}

/**
 * Wait until the effects relay has consumed this account's tombstone envelope.
 * Later walker traffic on the same partition must not move the goal.
 */
export async function drainTombstone(
  pool: Pool,
  accountId: string,
  { deadlineMs = 120_000 }: { deadlineMs?: number } = {},
): Promise<void> {
  const route = routeOf(accountId);
  if (route === null) throw new Error('Invalid commerce tombstone account');
  const partition = partitionOf(route);
  await waitUntil(
    async () => {
      const result = await pool.query<{ pos: string | null; checkpoint: string | null }>(
        `SELECT o.position::text AS pos, c.position::text AS checkpoint
           FROM core.outbox o
           LEFT JOIN core.consumer_checkpoint c
             ON c.partition_no = o.partition_no AND c.consumer = 'effects'
          WHERE o.partition_no = $1
            AND o.type = $2
            AND o.data->>'accountId' = $3
          ORDER BY o.position DESC, o.event_seq DESC
          LIMIT 1`,
        [partition, TOMBSTONE, accountId],
      );
      return result.rows[0] ?? { pos: null, checkpoint: null, partition };
    },
    (row) => row.pos !== null && row.checkpoint !== null && BigInt(row.checkpoint) >= BigInt(row.pos),
    deadlineMs,
  );
}

/**
 * Spawn the live default kernel worker against this suite's database. The child keeps
 * Content ambient and unsubscribes foreign tombstone consumers. Readiness is the ready
 * line, 5ms queue poll, and an effects consumer that has caught up.
 */
export async function startCommerceErasureWorker(pool: Pool, client: WorkClient, env: Record<string, string>) {
  let output = '';
  let errors = '';
  const running = Bun.spawn([process.execPath, new URL('./erasure-participant-runtime.ts', import.meta.url).pathname], {
    env: workerTestEnv({ ...process.env, ...env }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reading = Promise.all([
    (async () => {
      for await (const bytes of running.stdout as ReadableStream<Uint8Array>) output += new TextDecoder().decode(bytes);
    })(),
    (async () => {
      for await (const bytes of running.stderr as ReadableStream<Uint8Array>) errors += new TextDecoder().decode(bytes);
    })(),
  ]);
  const tail = () => ({ output: output.slice(-2000), errors: errors.slice(-2000) });
  try {
    await waitUntil(
      async () => {
        if (running.exitCode !== null) throw new Error(`Kernel worker ${running.pid} exited: ${errors}`);
        return output;
      },
      (value) => value.includes(READY),
      90_000,
    );
    for (const queue of await client.listQueues()) await queue.setMinPollingIntervalMs(5);
    await awaitEffectsCaughtUp(pool, 90_000, tail);
  } catch (error) {
    running.kill('SIGKILL');
    await running.exited;
    await reading;
    throw error;
  }
  return {
    get output() {
      return output;
    },
    get errors() {
      return errors;
    },
    async close() {
      // Erasure coordinators sleep through retention; production SIGTERM waits for them.
      running.kill('SIGKILL');
      await running.exited;
      await reading;
    },
  };
}
