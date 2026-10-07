import assert from 'node:assert/strict';
import { AsyncResource } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { context, trace } from '@opentelemetry/api';
import {
  shutdownTelemetry,
  startTelemetry,
  withTelemetrySpan,
  withWorkerTelemetry,
} from '@rezics/observability/runtime';

// Created before checkout adoption, as a socket/event callback can be at startup.
const releaseContext = new AsyncResource('pool-release-before-checkout');
const collector = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    await request.arrayBuffer();
    return new Response(null, { status: 200 });
  },
});
const instrumented = process.argv[3] === 'telemetry';
if (instrumented)
  startTelemetry('main', {
    OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.origin,
    OTEL_SDK_DISABLED: 'false',
  });
const { boundedPool, NestedPoolCheckoutError, setNestedPoolCheckoutMode } =
  await import('../src/infrastructure/pg-pool.ts');
const { inAccess } = await import('../src/modules/recommendation/derived-generation.ts');
const { DiscoveryRefreshStore } = await import('../src/modules/discovery/refresh-store.ts');
const { AlsoEnjoyedStore } = await import('../src/modules/also-enjoyed/store.ts');
const { nameBackfillCheckpoint } = await import('../src/modules/search/backfill-checkpoint.ts');
const { NotificationRealtimeHub } = await import('../src/modules/notification/realtime.ts');
const { Client } = await import('pg');
if (instrumented) assert.equal(Reflect.get(Client.prototype.query, '__wrapped'), true);
setNestedPoolCheckoutMode('throw');
const failures: { scenario: string; error: string }[] = [];
let completed = 0;
async function scenario(
  name: string,
  work: (pool: ReturnType<typeof boundedPool>) => Promise<void>,
) {
  const pool = boundedPool({
    connectionString: process.argv[2],
    max: 1,
    connectionTimeoutMillis: 250,
  });
  try {
    await work(pool);
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.waitingCount, 0);
    completed++;
  } catch (error) {
    failures.push({ scenario: name, error: String(error) });
  } finally {
    await pool.end();
  }
}

try {
  await scenario('release in a pre-existing async resource', async (pool) => {
    const client = await pool.connect();
    await assert.rejects(pool.connect(), NestedPoolCheckoutError);
    releaseContext.runInAsyncScope(() => client.release());
    assert.deepEqual(await nameBackfillCheckpoint(pool, 'startup', 'pool-hold-probe'), {
      after: '',
      complete: false,
    });
    assert.equal(await new DiscoveryRefreshStore(pool).purge(), 0);
    assert.equal(await new AlsoEnjoyedStore(pool, pool).purge(), 0);
  });
  await scenario('a child checkout does not mark its waiting sibling as nested', async (pool) => {
    // Prime the idle client and its empty inherited detector context.
    const primer = await pool.connect();
    primer.release();
    const owner = new AsyncResource('checkout-owner');
    const ready = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const held = owner.runInAsyncScope(async () => {
      const client = await pool.connect();
      try {
        await assert.rejects(pool.query('SELECT 1'), NestedPoolCheckoutError);
        ready.resolve();
        await finish.promise;
      } finally {
        client.release();
      }
    });
    try {
      await ready.promise;
      setTimeout(() => finish.resolve(), 10);
      assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
    } finally {
      finish.resolve();
      await held;
      owner.emitDestroy();
    }
  });
  await scenario(
    'ordinary queries and immediate releases permit sequential worker transactions',
    async (pool) => {
      const run = async () => {
        if (instrumented) assert.ok(trace.getSpan(context.active()));
        for (let tick = 0; tick < 8; tick++) {
          const client = await pool.connect();
          client.release();
          assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
          await inAccess(pool, async (held) => {
            await assert.rejects(pool.connect(), NestedPoolCheckoutError);
            await assert.rejects(pool.query('SELECT 1'), NestedPoolCheckoutError);
            await held.query('SELECT 1');
          });
          await new DiscoveryRefreshStore(pool).purge();
          await new AlsoEnjoyedStore(pool, pool).purge();
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      };
      if (instrumented)
        await withWorkerTelemetry('main.discovery.refresh', run, () => ({ outcome: 'idle' }));
      else await run();
    },
  );
  await scenario(
    'retained listener startup does not lend its ownership to subsequent startup work',
    async (pool) => {
      const hub = new NotificationRealtimeHub(pool);
      await hub.start();
      // With one client the checkpoint must wait for the listener's release,
      // rather than misclassifying the startup continuation as its owner.
      const stopped = Promise.withResolvers<void>();
      setTimeout(() => {
        void releaseContext.runInAsyncScope(() => hub.stop()).then(stopped.resolve, stopped.reject);
      }, 10);
      try {
        assert.deepEqual(await nameBackfillCheckpoint(pool, 'startup', 'pool-hold-probe'), {
          after: '',
          complete: false,
        });
        await stopped.promise;
        assert.equal(await new DiscoveryRefreshStore(pool).purge(), 0);
        assert.equal(await new AlsoEnjoyedStore(pool, pool).purge(), 0);
      } finally {
        await stopped.promise;
        await hub.stop();
      }
    },
  );
  await scenario('a queued checkout failure clears only its own hold', async (pool) => {
    const primer = await pool.connect();
    primer.release();
    const owner = new AsyncResource('checkout-timeout-owner');
    const ready = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const held = owner.runInAsyncScope(async () => {
      const client = await pool.connect();
      try {
        ready.resolve();
        await finish.promise;
        await assert.rejects(pool.connect(), NestedPoolCheckoutError);
      } finally {
        client.release();
      }
    });
    try {
      await ready.promise;
      await assert.rejects(pool.connect(), /timeout exceeded when trying to connect/);
      finish.resolve();
      await held;
      assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
    } finally {
      finish.resolve();
      await held;
      owner.emitDestroy();
    }
  });
  await scenario(
    'log mode retains ownership of an allowed nested checkout after the first release',
    async (pool) => {
      const logged: unknown[][] = [],
        original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      let second: PoolClient | undefined;
      try {
        const first = await pool.connect();
        setNestedPoolCheckoutMode('log');
        const pending = pool.connect();
        releaseContext.runInAsyncScope(() => first.release());
        second = await pending;
        assert.equal(logged.length, 1);
        assert.equal(JSON.parse(String(logged[0]![0]))['error.class'], 'NestedPoolCheckoutError');
        setNestedPoolCheckoutMode('throw');
        await assert.rejects(pool.connect(), NestedPoolCheckoutError);
        await assert.rejects(pool.query('SELECT 1'), NestedPoolCheckoutError);
        second.release();
        second = undefined;
        assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
      } finally {
        second?.release();
        setNestedPoolCheckoutMode('throw');
        console.error = original;
      }
    },
  );
  if (instrumented) await withTelemetrySpan('startup.complete', async () => undefined);
} finally {
  releaseContext.emitDestroy();
  await shutdownTelemetry();
  await collector.stop(true);
}
console.log(JSON.stringify({ instrumented, completed, failures }));
process.exitCode = failures.length ? 1 : 0;
