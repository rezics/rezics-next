import assert from 'node:assert/strict';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { createWorkClient } from '../../../src/work/client.ts';
import { WORK_QUEUES } from '../../../src/work/queues.ts';
import type { WorkContext } from '../../../src/work/registry.ts';
import { workflowRetentionWorkModule } from '../../../src/work/retention.ts';

const [application, mode] = process.argv.slice(2);
assert(application?.startsWith('retention-recovery:'));
const databaseUrl = process.env.DATABASE_URL!;
const client = await createWorkClient(databaseUrl);
let selections = 0;
const pause = async () => {
  console.log('interrupted');
  await new Promise(() => {});
};

// Run the production registration and durable steps. Only discovery's application
// and schedule installation are isolated; no fixture worker polls shared queues.
const isolated = new Proxy(client, {
  get(target, property) {
    if (property === 'applySchedules') return async () => {};
    if (property === 'listWorkflows')
      return async (input: Parameters<typeof client.listWorkflows>[0]) => {
        console.log(`selection:${input.completedBefore}`);
        if (mode === 'after' && ++selections === 2) await pause();
        return client.listWorkflows({ ...input, applicationName: application });
      };
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
  queues: WORK_QUEUES,
  env: { KERNEL_WORKFLOW_RETENTION_DAYS: mode === 'recover' ? '7' : '30' },
} as WorkContext);
await DBOS.launch();
console.log('ready');
