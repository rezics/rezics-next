import type { Pool } from 'pg';
import { withConnection } from '../../../src/database/pool.ts';
import { readConsumerLag } from '../../../src/events/consumer-lag.ts';
import { EFFECTS_CONSUMER } from '../../../src/events/effects.ts';
import type { WorkClient } from '../../../src/work/client.ts';
import { workerTestEnv } from '../../support/worker-env.ts';

const READY = 'Commerce erasure worker ready';

async function waitUntil<T>(read: () => Promise<T>, accept: (value: T) => boolean, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await Bun.sleep(25);
  }
}

/** Wait until the production effects relay has ticked and has no pending envelopes. */
export async function awaitEffectsCaughtUp(pool: Pool, ms = 90_000): Promise<void> {
  await waitUntil(
    () => withConnection(pool, (client) => readConsumerLag(client, EFFECTS_CONSUMER)),
    (lag) => lag !== null && lag.oldestPendingAt === null && Date.now() - lag.observedAt.getTime() < 5_000,
    ms,
  );
}

/**
 * Spawn the default kernel worker against this suite's database. Readiness is the
 * ready line, 5ms queue poll, and an effects consumer that has caught up.
 */
export async function startCommerceErasureWorker(pool: Pool, client: WorkClient, env: Record<string, string>) {
  let output = '';
  let errors = '';
  const running = Bun.spawn([process.execPath, new URL('./erasure-participant-runtime.ts', import.meta.url).pathname], {
    env: { ...process.env, ...workerTestEnv(env) },
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
    await awaitEffectsCaughtUp(pool);
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
