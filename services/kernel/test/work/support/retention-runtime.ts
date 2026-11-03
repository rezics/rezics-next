import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import type { WorkContext } from '../../../src/work/registry.ts';
import { workflowRetentionWorkModule } from '../../../src/work/retention.ts';

const application = process.argv[2] ?? '';
const mode = process.argv[3];
assert(application.startsWith('retention-recovery:'));
const databaseUrl = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const client = await createWorkClient(databaseUrl, pool);
let selections = 0;
const pause = async () => {
  console.log('interrupted');
  await new Promise(() => {});
};

// Run the production registration and durable steps. Only discovery's application
// and schedule installation are isolated; no fixture worker polls shared queues.
const isolated = new Proxy(client, {
  get(target, property) {
    if (property === 'applicationName') return application;
    if (property === 'applySchedules') return async () => {};
    if (property === 'deleteWorkflows')
      return async (ids: string[], children: boolean) => {
        assert.equal(children, false);
        assert(ids.every((id) => id.startsWith(`${application}:`)));
        await client.deleteWorkflows(ids, children);
        console.log(`deleted:${ids.length}`);
        if (mode === 'before') await pause();
      };
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const originalQuery = pool.query.bind(pool);
pool.query = ((query: unknown, values?: unknown) => {
  const config = typeof query === 'string' ? { text: query, values } : (query as { text?: string; values?: unknown });
  const text = String(config.text ?? '');
  if (text.includes('work:workflow-retention-select') || text.includes('ORDER BY completed_at, workflow_uuid')) {
    const params = Array.isArray(config.values) ? config.values : Array.isArray(values) ? values : [];
    const cutoff = params.find((value) => Number(value) > 1_000_000_000_000);
    console.log(`selection:${String(cutoff)}`);
    if (mode === 'after' && ++selections === 2) return pause() as never;
  }
  return values === undefined ? originalQuery(query as never) : originalQuery(query as never, values as never);
}) as typeof pool.query;

DBOS.setConfig({
  name: application,
  systemDatabaseUrl: databaseUrl,
  systemDatabaseSchemaName: 'dbos',
  runMigrations: false,
  executorID: application,
  applicationVersion: application,
  listenQueues: [application],
  logLevel: 'warn',
});
await workflowRetentionWorkModule.register({
  client: isolated,
  pool,
  queues: WORK_QUEUES,
  env: { KERNEL_WORKFLOW_RETENTION_DAYS: mode === 'recover' ? '7' : '30' },
} as unknown as WorkContext);
await DBOS.launch();
console.log('ready');
