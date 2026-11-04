import { expect, test } from 'bun:test';
import type { WorkModule } from '../../src/work/registry.ts';
import { KERNEL_WORK_MODULES } from './default-work-modules.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { workerTestEnv } from './worker-env.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('the worker test env starts the kernel worker with every kernel work module registered', async () => {
  const env = { ...workerTestEnv(), DATABASE_URL: databaseUrl };
  const registered: string[] = [];
  const modules: WorkModule[] = KERNEL_WORK_MODULES.map((module) => ({
    name: module.name,
    async register(context) {
      await module.register(context);
      registered.push(module.name);
    },
  }));

  const worker = await startWorker(readWorkerConfig(env), modules, env);
  try {
    expect(registered).toEqual(KERNEL_WORK_MODULES.map(({ name }) => name));
  } finally {
    await worker.stop();
  }
}, 30_000);
