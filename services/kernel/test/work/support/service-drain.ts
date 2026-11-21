// Run in separate native SDK processes so the original pending step really has to recover.
import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createSearchServiceGate, registerPublicPreparationWork } from '../../../src/search/work.ts';
import { createWorkClient } from '../../../src/work/client.ts';
import type { WorkModule } from '../../../src/work/registry.ts';
import { readWorkerConfig, startWorker } from '../../../src/worker.ts';

const [phase, prefix] = process.argv.slice(2);
assert(phase === 'drain' || phase === 'recover');
assert(prefix && /^[0-9a-f-]{36}$/.test(prefix));
const databaseUrl = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await createWorkClient(databaseUrl, pool);
const ids = ['short', 'interrupted', 'queued'].map((kind) => prefix + ':' + kind);
const [short, interrupted, queued] = ids as [string, string, string];
const table = 'public.drain_' + prefix.replaceAll('-', '');
const entered = new Set<string>();
const admitted = Promise.withResolvers<void>();
const sealed = Promise.withResolvers<void>();
const enqueue = (id: string) =>
  client.enqueue(
    { workflowID: id, workflowName: 'search.publicPreparation', queueName: 'maintenance' },
    {
      id,
      revision: '1',
      notBefore: 0,
    },
  );

const module: WorkModule = {
  name: 'search-drain-fixture',
  register(context) {
    const gate = createSearchServiceGate<{ run(id: string, revision: string): Promise<void> }>(
      () => new Error('Search preparation service is not running'),
    );
    registerPublicPreparationWork(async () => {
      if (phase === 'drain') {
        entered.add(DBOS.workflowID!);
        if (entered.size === 2) admitted.resolve();
        await sealed.promise;
      }
      return gate.ready();
    }, context.client);
    context.addService(() => {
      gate.offer({
        async run(id, revision) {
          assert.equal(revision, '1');
          if (id === interrupted && phase === 'drain') {
            // Hold this original installed step past the process grace period.
            await new Promise<void>(() => {});
          }
          await context.pool.query('INSERT INTO ' + table + ' VALUES ($1)', [id]);
        },
      });
      return {
        async stopAdmission() {
          if (phase === 'drain') {
            await enqueue(queued);
            sealed.resolve();
          }
        },
        async stop() {
          gate.stop();
          sealed.resolve();
        },
      };
    });
  },
};

if (phase === 'drain') await pool.query('CREATE TABLE ' + table + ' (id text PRIMARY KEY)');
const worker = await startWorker({ ...readWorkerConfig(process.env), executorId: prefix, effectsRelay: false }, [
  module,
]);
try {
  if (phase === 'drain') {
    await Promise.all([enqueue(short), enqueue(interrupted)]);
    await admitted.promise;
    const started = performance.now();
    process.kill(process.pid, 'SIGTERM');
    await sealed.promise;
    await worker.stop();
    assert(performance.now() - started < 20_000);
    assert.equal((await client.getWorkflow(short))?.status, 'SUCCESS');
    assert.equal((await client.getWorkflow(interrupted))?.status, 'PENDING');
    assert.equal((await client.getWorkflow(queued))?.status, 'ENQUEUED');
    assert.equal((await client.listWorkflowSteps(interrupted))?.length, 0);
  } else {
    const limit = Date.now() + 15_000;
    for (const id of ids) {
      while ((await client.getWorkflow(id))?.status !== 'SUCCESS') {
        assert(Date.now() < limit, 'Original Search preparation has not recovered');
        await Bun.sleep(25);
      }
      const steps = await client.listWorkflowSteps(id);
      assert.deepEqual(
        steps?.map((entry) => [entry.functionID, entry.name, entry.error]),
        [[0, 'search.publicPreparationStep', null]],
      );
    }
    assert.deepEqual(
      (await pool.query('SELECT id FROM ' + table + ' ORDER BY id')).rows.map((row) => row.id),
      [...ids].sort(),
    );
    await pool.query('DROP TABLE ' + table);
  }
  console.log('Search service ' + phase + ' verified');
} finally {
  await worker.stop();
  await client.close();
  await pool.end();
}
