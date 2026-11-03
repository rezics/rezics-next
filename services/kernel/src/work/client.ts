import canonicalize from 'canonicalize';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import { Pool, type PoolClient, type QueryResult } from 'pg';
import { WORK_QUEUES, type WorkQueueName } from './queues.ts';

export const DBOS_SCHEMA = 'dbos';
export const WORK_APPLICATION = 'rezics-kernel';
export type WorkClient = DBOSClient & {
  close(): Promise<void>;
  discoverLegacyLeaveChild(workflowId: string): Promise<string | null>;
};
const selectedClientPools = new WeakMap<DBOSClient, Pool>();
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
  if (!(client instanceof DBOSClient) || selectedClientPools.get(client) !== pool)
    throw new TypeError('Selected runtime requires the original shared WorkClient/Pool');
}

export type WorkIntent = Readonly<{
  queue: WorkQueueName;
  workflowName: string;
  workflowId: string;
  /** Locators only; consumer modules own their input schema. */
  input: Readonly<{ accounts: readonly string[]; [locator: string]: unknown }>;
  /** Original positional SDK arguments, when the existing workflow predates scoped work. */
  arguments?: readonly unknown[];
  /** Native queue controls; deduplication spans the entire queue, including partitions. */
  queuePartitionKey?: string;
  deduplicationID?: string;
  priority?: number;
  delaySeconds?: number;
}>;

/** Executor internals. The SDK uses this very connection; no pool checkout or relay. */
export async function enqueueWorkIntent(
  work: WorkClient,
  client: PoolClient,
  intent: WorkIntent,
  capture?: (created: boolean) => void,
): Promise<void> {
  if (!Object.hasOwn(WORK_QUEUES, intent.queue) || !intent.workflowName || !intent.workflowId)
    throw new TypeError('An operational intent requires an existing queue, workflow name and deterministic id');
  // 5.4.6 checks the returned name but merely warns for a queue mismatch. Inspect
  // its upsert result and, for native identity custody, exact input on this same pg client.
  const checked = new Proxy(client, {
    get(target, property) {
      if (property !== 'query') return Reflect.get(target, property, target);
      return async (sql: string, values: unknown[]) => {
        const result: QueryResult = await target.query(sql, values);
        if (result.fields.some(({ name }) => name === 'queue_name')) {
          const row = result.rows[0];
          if (capture && row) capture(row.creator_xid === values[22]);
          if (row && (row.name !== intent.workflowName || row.queue_name !== intent.queue))
            throw new TypeError(`Conflicting workflow name or queue for ${intent.workflowId}`);
        }
        if (capture && sql.includes('.workflow_input ') && values[0] === intent.workflowId) {
          const stored = (
            await target.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [intent.workflowId])
          ).rows[0];
          if (!stored || canonicalize(JSON.parse(stored.inputs)) !== canonicalize(JSON.parse(String(values[1]))))
            throw new TypeError('Original identity SDK arguments differ from native custody');
        }
        return result;
      };
    },
  });
  await work.enqueueInTransaction(
    checked,
    {
      queueName: intent.queue,
      workflowName: intent.workflowName,
      workflowIDReusePolicy: 'return-existing',
      workflowID: intent.workflowId,
      ...(intent.queuePartitionKey === undefined ? {} : { queuePartitionKey: intent.queuePartitionKey }),
      ...(intent.deduplicationID === undefined ? {} : { deduplicationID: intent.deduplicationID }),
      ...(intent.priority === undefined ? {} : { priority: intent.priority }),
      ...(intent.delaySeconds === undefined ? {} : { delaySeconds: intent.delaySeconds }),
    },
    ...(intent.arguments ?? [intent.input]),
  );
}

/** Exact existence probes for the supported durable family. Pre-mapping orphan copies are
 * legacy too; a newly inserted SDK status row cannot retroactively cover their creation. */
export async function hasRetainedWorkCopies(client: PoolClient, workflowId: string): Promise<boolean> {
  for (const [table, key] of [
    ['workflow_status', 'workflow_uuid'],
    ['workflow_input', 'workflow_uuid'],
    ['workflow_output', 'workflow_uuid'],
    ['operation_outputs', 'workflow_uuid'],
    ['workflow_events', 'workflow_uuid'],
    ['workflow_events_history', 'workflow_uuid'],
    ['notifications', 'destination_uuid'],
    ['streams', 'workflow_uuid'],
  ] as const) {
    if ((await client.query(`SELECT 1 FROM dbos.${table} WHERE ${key}=$1 LIMIT 1`, [workflowId])).rows.length)
      return true;
  }
  return false;
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
  if (pool) selectedClientPools.set(client, pool);
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
          selectedClientPools.delete(client);
          await client.destroy();
        } finally {
          if (ownsLookupPool) await lookupPool.end();
        }
      })()),
  });
}
