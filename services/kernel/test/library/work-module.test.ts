import { expect, test } from 'bun:test';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { readWorkerConfig, startWorker } from '../../src/worker.ts';
import { newId } from '../../src/route/route.ts';
import { workerTestEnv } from '../support/worker-env.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

test('the library module runs once after commerce in the single configured kernel worker', async () => {
  expect(libraryWorkModule.name).toBe('library');
  expect(KERNEL_WORK_MODULES.filter((module) => module.name === 'library')).toEqual([libraryWorkModule]);
  expect(KERNEL_WORK_MODULES.findIndex((module) => module.name === 'library')).toBeGreaterThan(
    KERNEL_WORK_MODULES.findIndex((module) => module.name === 'commerce'),
  );
  const env = workerTestEnv({
    DATABASE_URL: databaseUrl,
    STRIPE_SECRET_KEY: 'sk_test_library_worker',
    STRIPE_MANAGED_PAYMENTS: 'false',
    CHECKOUT_SUCCESS_URL: 'https://web.example.test/success',
    CHECKOUT_CANCEL_URL: 'https://web.example.test/cancel',
  });
  const worker = await startWorker(readWorkerConfig(env), undefined, env);
  const client = await createWorkClient(databaseUrl);
  try {
    const workflowID = randomId();
    const handle = await client.enqueue(
      { workflowName: 'library.collectionListing', queueName: 'workflows', workflowID },
      newId(0x6b31),
    );
    expect(await handle.getResult()).toBeUndefined();
    expect((await client.listWorkflowSteps(workflowID))?.map((step) => step.name)).toEqual([
      'library.syncCollectionPage',
    ]);
  } finally {
    await worker.stop();
    await client.close();
  }
}, 30_000);

function randomId() {
  return `library-worker:${crypto.randomUUID()}`;
}
