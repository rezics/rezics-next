import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

export const DBOS_SCHEMA = 'dbos';
export const WORK_APPLICATION = 'rezics-kernel';
export type WorkClient = DBOSClient & { close(): Promise<void> };

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
