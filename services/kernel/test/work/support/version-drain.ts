import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import type { WorkModule } from '../../../src/work/registry.ts';

const [phase, prefix, historical] = process.argv.slice(2);
assert(prefix && /^[a-z0-9-]+$/.test(prefix));
const current = phase === 'current' || phase === 'finish' || phase === 'reject-active';
const config = readWorkerConfig(process.env);
const pool = new pg.Pool({ connectionString: config.databaseUrl });
const client = await createWorkClient(config.databaseUrl, pool);
const parentID = prefix + ':parent';
const childID = prefix + ':child';
const blockerID = prefix + ':blocker';
const freshID = prefix + ':fresh';
const schedule = prefix + ':schedule';
const admitted = Promise.withResolvers<void>();
let originalService = false;
let producerStarts = 0;
async function until(read: () => Promise<boolean>) {
  const expires = performance.now() + 15_000;
  while (!(await read())) {
    assert(performance.now() < expires, 'Native work did not reach its expected state');
    await Bun.sleep(30);
  }
}
const workerModule: WorkModule = {
  name: 'version-drain',
  async register(context) {
    const probe =
      phase === 'reject-unknown'
        ? async () => 'unregistered'
        : current
          ? async () => 'current'
          : async () => 'historical';
    DBOS.registerWorkflow(probe, { name: prefix + '.identity' });
    DBOS.registerWorkflow(
      async () => {
        return DBOS.runStep(
          async () => {
            if (phase === 'current') {
              admitted.resolve();
              await new Promise<void>(() => {});
            }
            return DBOS.applicationVersion;
          },
          { name: 'held-locator-effect' },
        );
      },
      { name: prefix + '.blocker' },
    );
    const child = DBOS.registerWorkflow(
      async () => {
        return DBOS.runStep(
          async () => {
            assert(originalService);
            return DBOS.applicationVersion;
          },
          { name: 'original-locator-effect' },
        );
      },
      { name: prefix + '.child' },
    );
    DBOS.registerWorkflow(
      async () => {
        await DBOS.runStep(async () => 'recorded', { name: 'admitted-parent' });
        await DBOS.runStep(
          async () => {
            if (phase === 'seed') {
              admitted.resolve();
              await new Promise<void>(() => {});
            }
          },
          { name: 'recovered-parent' },
        );
        const handle = await DBOS.startWorkflow(child, {
          workflowID: childID,
          queueName: 'locator-effects',
          enqueueOptions: { queuePartitionKey: prefix },
        })();
        return handle.getResult();
      },
      { name: prefix + '.parent' },
    );
    context.addService(() => {
      producerStarts++;
      return { async stop() {} };
    });
    context.addService(
      () => {
        originalService = true;
        return {
          async stopAdmission() {},
          async stop() {
            originalService = false;
          },
        };
      },
      { servesOriginals: true },
    );
    await context.client.applySchedules([
      {
        scheduleName: schedule,
        workflowName: prefix + '.identity',
        queueName: 'maintenance',
        schedule: current ? '* * * * * *' : '0 1 1 1 *',
        cronTimezone: 'UTC',
        automaticBackfill: false,
      },
    ]);
  },
};
const status = (id: string) => client.getWorkflow(id);
const workflow = await startWorker(
  { ...config, executorId: prefix + (current ? '-current' : '-old'), effectsRelay: false },
  [workerModule],
);
try {
  if (phase === 'seed') {
    await client.enqueue({
      queueName: 'maintenance',
      workflowID: parentID,
      workflowName: prefix + '.parent',
      appVersion: DBOS.applicationVersion,
    });
    await admitted.promise;
    assert.equal((await status(parentID))?.status, 'PENDING');
    assert.deepEqual(
      (await client.listWorkflowSteps(parentID))?.map((s) => s.name),
      ['admitted-parent'],
    );
    console.log('version ' + DBOS.applicationVersion);
    // The next process must recover the original SDK claim from its durable step.
    process.exit(0);
  }
  if (phase === 'current') {
    assert.notEqual(DBOS.applicationVersion, historical);
    await client.setLatestApplicationVersion(DBOS.applicationVersion);
    await until(async () => Boolean((await client.getSchedule(schedule))?.lastFiredAt));
    assert.equal((await status(parentID))?.status, 'PENDING');
    await client.enqueue({
      queueName: 'locator-effects',
      queuePartitionKey: prefix,
      workflowID: blockerID,
      workflowName: prefix + '.blocker',
      appVersion: DBOS.applicationVersion,
    });
    await admitted.promise;
    assert.equal((await status(blockerID))?.status, 'PENDING');
    console.log('version ' + DBOS.applicationVersion);
    process.exit(0);
  } else if (phase === 'drain') {
    assert.equal(DBOS.applicationVersion, historical);
    assert.equal(producerStarts, 0);
    assert.equal(originalService, true);
    assert.equal((await client.getSchedule(schedule))?.schedule, '* * * * * *');
    const lastTick = (await client.getSchedule(schedule))?.lastFiredAt;
    assert(lastTick);
    await client.enqueue({ queueName: 'maintenance', workflowID: freshID, workflowName: prefix + '.identity' });
    await until(async () => (await status(childID))?.status === 'ENQUEUED');
    assert.equal((await status(blockerID))?.status, 'PENDING');
    await Bun.sleep(2300);
    assert.equal((await client.getSchedule(schedule))?.lastFiredAt, lastTick);
    assert.equal((await status(freshID))?.status, 'ENQUEUED');
    assert.equal((await status(childID))?.status, 'ENQUEUED');
    const successor = Bun.spawn([process.execPath, import.meta.path, 'finish', prefix, historical!], {
      env: { ...process.env, KERNEL_WORKER_MODE: 'active' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const [exit, errors] = await Promise.all([successor.exited, new Response(successor.stderr).text()]);
      assert.equal(exit, 0, errors);
    } finally {
      successor.kill();
    }
    await until(async () => (await status(parentID))?.status === 'SUCCESS');
    const completed = await status(childID);
    assert.equal(completed?.applicationVersion, historical);
    assert.equal(completed?.parentWorkflowID, parentID);
    assert.equal(completed?.queuePartitionKey, prefix);
    assert.equal(completed?.output, historical);
    assert.equal((await status(parentID))?.output, historical);
    assert.deepEqual(
      (await client.listWorkflowSteps(parentID))?.slice(0, 2).map((s) => s.name),
      ['admitted-parent', 'recovered-parent'],
    );
    assert.deepEqual(
      (await client.listWorkflowSteps(childID))?.map((s) => s.name),
      ['original-locator-effect'],
    );
  } else if (phase === 'finish') {
    await until(async () => (await status(blockerID))?.status === 'SUCCESS');
    assert.equal((await status(blockerID))?.output, DBOS.applicationVersion);
    await until(async () => (await status(freshID))?.status === 'SUCCESS');
    assert.equal((await status(freshID))?.output, 'current');
    await client.deleteSchedule(schedule);
  } else throw new Error('Unknown test phase');
  if (phase !== 'drain') assert.equal(producerStarts, 1);
  console.log('version ' + DBOS.applicationVersion);
} finally {
  await workflow.stop();
  await client.close();
  await pool.end();
}
