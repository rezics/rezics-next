import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { WORK_QUEUES, type WorkQueueName } from './queues.ts';

export const DBOS_SCHEMA = 'dbos';
export const WORK_APPLICATION = 'rezics-kernel';
export type WorkClient = DBOSClient & { close(): Promise<void> };

export type WorkIntent = Readonly<{
  queue: WorkQueueName;
  workflowName: string;
  workflowId: string;
  /** Locators only; consumer modules own their input schema. */
  input: Readonly<{ accounts: readonly string[]; [locator: string]: unknown }>;
}>;

/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export async function enqueueWorkIntent(work: WorkClient, client: PoolClient, intent: WorkIntent): Promise<void> {
  if (!Object.hasOwn(WORK_QUEUES, intent.queue) || !intent.workflowName || !intent.workflowId)
    throw new TypeError('An operational intent requires an existing queue, workflow name and deterministic id');
  // 5.4.6 checks the returned name but merely warns for a queue mismatch. Inspect
  // its upsert result on the same pg client, adding no statement or connection.
  const checked = new Proxy(client, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target);
      return async (sql: string, values: unknown[]) => {
        const result: QueryResult = await target.query(sql, values);
        if (result.fields.some(({ name }) => name === 'queue_name')) {
          const row = result.rows[0];
          if (row && (row.name !== intent.workflowName || row.queue_name !== intent.queue))
            throw new TypeError(`Conflicting workflow name or queue for ${intent.workflowId}`);
        }
        return result;
      };
    },
  });
  await work.enqueueInTransaction(
    checked,
    { queueName: intent.queue, workflowName: intent.workflowName, workflowID: intent.workflowId },
    intent.input,
  );
}

/** Enqueue without launching an executor. A supplied pool remains the caller's responsibility. */
export async function createWorkClient(databaseUrl: string, pool?: Pool): Promise<WorkClient> {
  const client = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: DBOS_SCHEMA,
    applicationName: WORK_APPLICATION,
    systemDatabasePoolSize: 10,
    ...(pool === undefined ? {} : { systemDatabasePool: pool }),
    logger: { info() {}, debug() {}, warn: console.warn, error: console.error },
  });
  const listWorkflowSteps = client.listWorkflowSteps.bind(client);
  let lookupPool: Pool | undefined;
  let closing: Promise<void> | undefined;
  return Object.assign(client, {
    async listWorkflowSteps(...args: Parameters<DBOSClient['listWorkflowSteps']>) {
      const [workflowId, options] = args;
      const legacyLeave = /^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(workflowId);
      if (!legacyLeave || (await client.getWorkflow(workflowId))) return listWorkflowSteps(workflowId, options);
      const lookup = pool ?? (lookupPool ??= new Pool({ connectionString: databaseUrl, max: 1 }));
      const result = await lookup.query<{ workflow_uuid: string }>(
        `SELECT child.workflow_uuid
           FROM dbos.workflow_status AS parent
           JOIN dbos.workflow_input AS parent_input
             ON parent_input.workflow_uuid = parent.workflow_uuid
           JOIN dbos.workflow_status AS child
             ON child.name = 'accounts.membership'
           JOIN dbos.workflow_input AS child_input
             ON child_input.workflow_uuid = child.workflow_uuid
          WHERE parent.name = 'community.leave'
            AND parent_input.inputs::jsonb #>> '{json,0,realmId}' = $1
            AND parent_input.inputs::jsonb #>> '{json,0,memberAccountId}' = $2
            AND child_input.inputs::jsonb #>> '{json,0,principal,id}' = $1
            AND child_input.inputs::jsonb #>> '{json,0,memberAccountId}' = $2
            AND child_input.inputs::jsonb #>> '{json,0,reservationId}' =
                parent_input.inputs::jsonb #>> '{json,0,reservationId}'
          ORDER BY parent.created_at DESC
          LIMIT 1`,
        legacyLeave.slice(1),
      );
      return listWorkflowSteps(result.rows[0]?.workflow_uuid ?? workflowId, options);
    },
    close: () =>
      (closing ??= (async () => {
        try {
          await client.destroy();
        } finally {
          await lookupPool?.end();
        }
      })()),
  });
}
