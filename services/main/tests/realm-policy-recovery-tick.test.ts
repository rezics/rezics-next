import { expect, spyOn, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { boundedPool, NestedPoolCheckoutError, nestedPoolCheckoutMode, setNestedPoolCheckoutMode } from '../src/infrastructure/pg-pool.ts';
import { RealmPolicyRecoveryWorker } from '../src/modules/access/realm-management-recovery.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { currentWorkerTick, runWorkerTick } from '../src/worker-tick.ts';

function idleClient(): PoolClient {
  const client = {
    release() {},
    query() { return { rows: [], rowCount: 0 }; },
    on() { return client; },
    once() { return client; },
    removeListener() { return client; },
  };
  return client as unknown as PoolClient;
}

/**
 * A recovery tick that still holds a pooled client must not make a worker
 * started afterwards, in the same caller context, fault as a nested checkout.
 *
 * Mutation: in RealmPolicyRecoveryWorker.tick, drop the runWorkerTick wrapper
 * and pass the withWorkerTelemetry call through directly. The later worker
 * then rejects with NestedPoolCheckoutError.
 */
test('a realm-policy recovery tick does not leak its checkout to the next worker', async () => {
  const previous = nestedPoolCheckoutMode();
  setNestedPoolCheckoutMode('throw');
  let releaseHold: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let tickDuringHold: string | undefined;
  let retained: unknown;
  const connect = spyOn(Pool.prototype, 'connect').mockImplementation((() => Promise.resolve(idleClient())) as Pool['connect']);
  // The page read is the tick's first checkout. Holding that client across the
  // tick's await is what leaks onto the caller when the tick has no resource of its own.
  const query = spyOn(Pool.prototype, 'query').mockImplementation(function (this: Pool) {
    const pending = this.connect();
    tickDuringHold = currentWorkerTick();
    return pending.then(async (client: PoolClient) => {
      retained = await this.connect().then(() => 'connected', (error: unknown) => error);
      await hold;
      client.release();
      return { rows: [], rowCount: 0 };
    });
  } as unknown as Pool['query']);
  const pool = boundedPool({ connectionString: 'postgres://u@127.0.0.1:1/access', max: 4, connectionTimeoutMillis: 50 });
  const worker = new RealmPolicyRecoveryWorker(pool, {} as WorkActivationEnvironment);
  try {
    worker.start();
    await runWorkerTick('main.realm-policy.recovery.peer', async () => {
      const client = await pool.connect();
      client.release();
    });
    for (let attempt = 0; attempt < 20 && retained === undefined; attempt++) await Promise.resolve();
    expect(tickDuringHold).toBe('main.realm-policy.recovery');
    expect(retained).toBeInstanceOf(NestedPoolCheckoutError);
  } finally {
    releaseHold();
    await worker.stop();
    query.mockRestore();
    connect.mockRestore();
    await pool.end();
    setNestedPoolCheckoutMode(previous);
  }
});
