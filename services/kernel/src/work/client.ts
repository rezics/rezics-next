import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient } from 'pg';
import type { KernelExecutionContract } from '../command/execution-contract.ts';
import { DBOS_SCHEMA, WORK_APPLICATION, type WorkIntent as ContractIntent } from './contract/index.ts';
import {
  assertSelectedWorkClient as assertBoundSelectedWorkClient,
  bindSelectedWorkClient,
  unbindSelectedWorkClient,
} from './adapters/client-binding.ts';
import { ensureNativeWorkApplication } from './adapters/index.ts';

export { DBOS_SCHEMA, WORK_APPLICATION };
export type WorkIntent = ContractIntent;
export type WorkClient = DBOSClient & {
  close(): Promise<void>;
  discoverLegacyLeaveChild(workflowId: string): Promise<string | null>;
  readonly executionContract?: KernelExecutionContract;
};

const legacyDiscoveryIndexSetup = new WeakMap<Pool, Promise<void>>();
const legacyDiscoveryIndexStatements = [
  `CREATE INDEX IF NOT EXISTS work_legacy_leave_parent_input_identity
     ON dbos.workflow_input (
       (inputs::jsonb #>> '{json,0,realmId}'),
       (inputs::jsonb #>> '{json,0,memberAccountId}'),
       (inputs::jsonb #>> '{json,0,reservationId}')
     ) INCLUDE (workflow_uuid)`,
  `CREATE INDEX IF NOT EXISTS work_legacy_leave_child_input_identity
     ON dbos.workflow_input (
       (inputs::jsonb #>> '{json,0,principal,id}'),
       (inputs::jsonb #>> '{json,0,memberAccountId}'),
       (inputs::jsonb #>> '{json,0,reservationId}')
     ) INCLUDE (workflow_uuid)`,
] as const;

async function ensureLegacyDiscoveryIndexes(pool: Pool): Promise<void> {
  let setup = legacyDiscoveryIndexSetup.get(pool);
  if (!setup) {
    setup = (async () => {
      const connection = await pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'rezics/work/legacy-membership-discovery/indexes',
        ]);
        for (const statement of legacyDiscoveryIndexStatements) await connection.query(statement);
        await connection.query('COMMIT');
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          // Preserve the original installation failure.
        }
        throw error;
      } finally {
        connection.release();
      }
    })();
    legacyDiscoveryIndexSetup.set(pool, setup);
    void setup.catch(() => {
      legacyDiscoveryIndexSetup.delete(pool);
    });
  }
  await setup;
}

/** Private service composition binding. Matching URLs or a structural client do not enroll. */
export function assertSelectedWorkClient(client: WorkClient, pool: Pool): void {
  if (!(client instanceof DBOSClient))
    throw new TypeError('Selected runtime requires the original shared WorkClient/Pool');
  assertBoundSelectedWorkClient(client, pool);
}

/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export async function enqueueWorkIntent(
  work: WorkClient,
  client: PoolClient,
  intent: WorkIntent,
  capture?: (created: boolean) => void,
): Promise<void> {
  return ensureNativeWorkApplication().enqueue(work, client, intent, capture);
}

/** Exact existence probes for the supported durable family. Pre-mapping orphan copies are
 * legacy too; a newly inserted SDK status row cannot retroactively cover their creation. */
export async function hasRetainedWorkCopies(client: PoolClient, workflowId: string): Promise<boolean> {
  return ensureNativeWorkApplication().hasRetainedCopies(client, workflowId);
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
  if (pool) bindSelectedWorkClient(client, pool);
  const listWorkflowSteps = client.listWorkflowSteps.bind(client);
  let ownsLookupPool = false;
  const lookupPool = pool ?? new Pool({ connectionString: databaseUrl, max: 1 });
  if (!pool) ownsLookupPool = true;
  try {
    await ensureLegacyDiscoveryIndexes(lookupPool);
  } catch (error) {
    if (ownsLookupPool) await lookupPool.end();
    await client.destroy();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return Object.assign(client, {
    async discoverLegacyLeaveChild(workflowId: string) {
      const legacyLeave = /^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(workflowId);
      if (!legacyLeave) return null;
      const result = await lookupPool.query<{ workflow_uuid: string }>(
        `/* work:legacy-membership-child-discovery */
         SELECT child.workflow_uuid
           FROM dbos.workflow_input AS parent_input
           JOIN dbos.workflow_status AS parent
             ON parent.workflow_uuid = parent_input.workflow_uuid
           CROSS JOIN LATERAL (
             SELECT child.workflow_uuid
               FROM dbos.workflow_input AS child_input
               JOIN dbos.workflow_status AS child
                 ON child.workflow_uuid = child_input.workflow_uuid
              WHERE child.name = 'accounts.membership'
                AND child_input.inputs::jsonb #>> '{json,0,principal,id}' = $1
                AND child_input.inputs::jsonb #>> '{json,0,memberAccountId}' = $2
                AND child_input.inputs::jsonb #>> '{json,0,reservationId}' =
                    parent_input.inputs::jsonb #>> '{json,0,reservationId}'
              ORDER BY child.created_at DESC, child.workflow_uuid DESC
              LIMIT 1
           ) AS child
          WHERE parent.name = 'community.leave'
            AND parent_input.inputs::jsonb #>> '{json,0,realmId}' = $1
            AND parent_input.inputs::jsonb #>> '{json,0,memberAccountId}' = $2
          ORDER BY parent.created_at DESC, parent.workflow_uuid DESC
          LIMIT 1`,
        legacyLeave.slice(1),
      );
      return result.rows[0]?.workflow_uuid ?? null;
    },
    async listWorkflowSteps(...args: Parameters<DBOSClient['listWorkflowSteps']>) {
      const [workflowId, options] = args;
      const legacyLeave = /^realm:leave:([0-9a-f-]{36}):([0-9a-f-]{36})$/.exec(workflowId);
      if (!legacyLeave || (await client.getWorkflow(workflowId))) return listWorkflowSteps(workflowId, options);
      const result = await lookupPool.query<{ workflow_uuid: string }>(
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
          unbindSelectedWorkClient(client);
          await client.destroy();
        } finally {
          if (ownsLookupPool) await lookupPool.end();
        }
      })()),
  });
}
