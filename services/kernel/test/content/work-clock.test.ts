import { expect, expectTypeOf, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { systemClock, type KernelClock } from '../../src/clock.ts';
import type { KernelDependencies } from '../../src/http/kernel.ts';
import { readWorkerConfig, startWorker, type WorkerConfig } from '../../src/worker.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork, type WorkContext, type WorkModule, type WorkOptions } from '../../src/work/registry.ts';

test('HTTP and worker composition expose the same trusted clock type', () => {
  expectTypeOf<KernelDependencies['clock']>().toEqualTypeOf<KernelClock | undefined>();
  expectTypeOf<WorkerConfig['clock']>().toEqualTypeOf<KernelClock | undefined>();
  expectTypeOf<WorkOptions['clock']>().toEqualTypeOf<KernelClock | undefined>();
  expectTypeOf<WorkContext['clock']>().toEqualTypeOf<KernelClock>();
});

test('the shared system clock samples actual time and returns fresh Dates', async () => {
  const before = Date.now();
  const first = systemClock();
  await Bun.sleep(5);
  const second = systemClock();
  expect(first).toBeInstanceOf(Date);
  expect(first.getTime()).toBeGreaterThanOrEqual(before);
  expect(second.getTime()).toBeLessThanOrEqual(Date.now());
  expect(second.getTime()).toBeGreaterThanOrEqual(first.getTime());
  expect(second).not.toBe(first);
  first.setTime(0);
  expect(systemClock().getTime()).toBeGreaterThanOrEqual(before);
  expect((await import('../../src/clock.ts')).systemClock).toBe(systemClock);
});

test('worker environment configuration cannot select domain time', () => {
  const config = readWorkerConfig({
    DATABASE_URL: 'postgres://localhost/kernel',
    CLOCK: '2000-01-01T00:00:00Z',
    KERNEL_CLOCK: '2000-01-01T00:00:00Z',
    KERNEL_WORKER_CLOCK: '2000-01-01T00:00:00Z',
  });
  expect(config).toEqual({ databaseUrl: 'postgres://localhost/kernel', poolSize: 10 });
  expect(Object.hasOwn(config, 'clock')).toBe(false);
});

for (const boundary of ['composeWork', 'startWorker'] as const) {
  for (const selection of ['trusted', 'default'] as const) {
    const name = `${boundary} selects the ${selection} clock once for every native module`;
    test(
      name,
      async () => {
        // Each composition owns native DBOS process globals; do not replace its runtime.
        if (process.env.KERNEL_CLOCK_TEST_CHILD !== name) {
          const child = Bun.spawn([process.execPath, 'test', import.meta.path, '--test-name-pattern', `^${name}$`], {
            env: { ...process.env, KERNEL_CLOCK_TEST_CHILD: name },
            stdout: 'pipe',
            stderr: 'pipe',
          });
          try {
            const [exitCode, output, errors] = await Promise.all([
              child.exited,
              new Response(child.stdout).text(),
              new Response(child.stderr).text(),
            ]);
            expect(exitCode, `${output}\n${errors}`).toBe(0);
          } finally {
            child.kill();
          }
          return;
        }

        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
        const instant = new Date('2000-01-01T00:00:00Z');
        let samples = 0;
        const trustedClock: KernelClock = () => {
          samples++;
          return instant;
        };
        let configuredClock = selection === 'trusted' ? trustedClock : undefined;
        let selections = 0;
        const config: WorkerConfig = {
          databaseUrl,
          poolSize: 10,
        };
        Object.defineProperty(config, 'clock', {
          enumerable: true,
          get() {
            selections++;
            return configuredClock;
          },
        });
        const env = Object.freeze({ KERNEL_CLOCK: '1900-01-01T00:00:00Z' });
        const contexts: WorkContext[] = [];
        const modules: WorkModule[] = ['first', 'second'].map((name) => ({
          name,
          async register(context) {
            expect(DBOS.isInitialized()).toBe(false);
            expect(context.env).toBe(env);
            expect(Object.isFrozen(context)).toBe(true);
            expect(Reflect.set(context, 'clock', () => new Date(0))).toBe(false);
            contexts.push(context);
            configuredClock = () => {
              throw new Error('Clock must be selected before registration');
            };
            DBOS.registerWorkflow(async () => context.clock().toISOString(), { name: `clock.${name}` });
            await Promise.resolve();
          },
        }));
        const verify = () => {
          expect(contexts).toHaveLength(2);
          expect(selections).toBe(1);
          expect(samples).toBe(0);
          const expected = selection === 'trusted' ? trustedClock : systemClock;
          for (const context of contexts) {
            expect(context).toBe(contexts[0]!);
            expect(context.clock).toBe(expected);
            const before = Date.now();
            const actual = context.clock();
            if (selection === 'trusted') expect(actual).toBe(instant);
            else {
              expect(actual.getTime()).toBeGreaterThanOrEqual(before);
              expect(actual.getTime()).toBeLessThanOrEqual(Date.now());
            }
          }
          expect(samples).toBe(selection === 'trusted' ? 2 : 0);
        };

        if (boundary === 'startWorker') {
          const worker = await startWorker(config, modules, env);
          try {
            expect(DBOS.isInitialized()).toBe(true);
            verify();
          } finally {
            const stopping = worker.stop();
            expect(worker.stop()).toBe(stopping);
            await stopping;
          }
          expect(contexts[0]!.pool.ended).toBe(true);
          expect(DBOS.isInitialized()).toBe(false);
        } else {
          const pool = new pg.Pool({ connectionString: databaseUrl });
          const client = await createWorkClient(databaseUrl, pool);
          let work: Awaited<ReturnType<typeof composeWork>> | undefined;
          try {
            work = await composeWork(modules, Object.assign(config, { pool, client, env }));
            expect(DBOS.isInitialized()).toBe(false);
            verify();
          } finally {
            await work?.shutdown();
            await client.close();
            await pool.end();
          }
        }
      },
      30_000,
    );
  }
}
