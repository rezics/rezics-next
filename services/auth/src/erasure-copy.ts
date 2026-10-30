import { createHash } from 'node:crypto';
import { DBOS, type DBOSClient, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';

export type CopyRole = {
  accountId: string;
  role: 'subject' | 'human' | 'operator' | 'member' | 'previous-operator' | 'initiator' | 'delegate' | 'client-owner';
};
export const COPY_TABLES = [
  'workflow_status',
  'workflow_input',
  'workflow_output',
  'operation_outputs',
  'workflow_events',
  'workflow_events_history',
  'notifications',
] as const;
const names = ['accounts.registration', 'accounts.operation', 'accounts.client-reduction'] as const;
type Name = (typeof names)[number];
export async function copyTransaction<T>(pool: Pool, action: (connection: PoolClient) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const value = await action(connection);
    await connection.query('COMMIT');
    return value;
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}
/** Startup-only compatibility/coverage cut. Existing unmapped history remains unknown. */
export async function installCopyRecorder(database: Pool): Promise<void> {
  await copyTransaction(database, async (client) => {
    const coverage = (
      await client.query<{ covered: boolean }>(
        'SELECT covered FROM auth_copy_coverage WHERE singleton AND version=1 FOR UPDATE',
      )
    ).rows[0];
    if (!coverage) throw new Error('Auth copy schema unavailable');
    for (const table of COPY_TABLES) {
      await client.query(
        `SELECT ${table === 'notifications' ? 'destination_uuid,message_uuid' : 'workflow_uuid'} FROM auth_dbos.${table} LIMIT 0`,
      );
      await client.query(
        `CREATE OR REPLACE TRIGGER auth_copy_record BEFORE INSERT OR UPDATE ON auth_dbos.${table} FOR EACH ROW EXECUTE FUNCTION public.auth_copy_record()`,
      );
    }
    await client.query(
      'CREATE OR REPLACE TRIGGER auth_copy_record BEFORE INSERT OR UPDATE ON auth_dbos.streams FOR EACH ROW EXECUTE FUNCTION public.auth_copy_record()',
    );
    if (!coverage.covered)
      await client.query(`UPDATE auth_copy_coverage SET covered=true WHERE singleton
      AND NOT EXISTS (SELECT 1 FROM auth_dbos.workflow_status LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM auth_workflow_request LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM auth_registration_stage LIMIT 1)`);
  });
}
/** Same Auth database transaction as the SDK's real input/status creation. */
export function createCopyWriter(database: Pool, sdk: DBOSClient) {
  return {
    async enqueue<R>(
      name: Name,
      id: string,
      input: unknown,
      roles: readonly CopyRole[],
      parent?: string,
    ): Promise<WorkflowHandle<R>> {
      if (!names.includes(name) || roles.length > 16 || !roles.length || Buffer.byteLength(id) > 256)
        throw new Error('Auth copy scope refused');
      const sourceKey =
        name === 'accounts.registration'
          ? (input as { registrationId?: unknown })?.registrationId
          : name === 'accounts.client-reduction'
            ? ((input as { operationId?: unknown })?.operationId ?? id)
            : id;
      if (typeof sourceKey !== 'string' || !sourceKey || Buffer.byteLength(sourceKey) > 256)
        throw new Error('Auth native source identity refused');
      const digest = createHash('sha256')
        .update(JSON.stringify([name, input, roles]))
        .digest();
      return copyTransaction(database, async (client) => {
        if (parent) {
          const current = (
            await client.query<{ retired: boolean }>(
              'SELECT retired FROM auth_copy_work WHERE workflow_id=$1 FOR UPDATE',
              [parent],
            )
          ).rows[0];
          if (!current || current.retired) throw new Error('Auth copy parent retired');
        }
        for (const role of [...roles].sort((a, b) => a.accountId.localeCompare(b.accountId))) {
          if (parent && name === 'accounts.client-reduction') {
            const accepted = await client.query(
              'SELECT 1 FROM auth_client_reduction_progress WHERE operation_id=$1 AND NOT completed',
              [(input as { operationId?: string }).operationId],
            );
            if (!accepted.rowCount) throw new Error('Auth native reduction continuation missing');
            const inherited = await client.query(
              'SELECT 1 FROM auth_copy_role WHERE workflow_id=$1 AND account_id=$2 AND role=$3',
              [parent, role.accountId, role.role],
            );
            if (!inherited.rowCount) throw new Error('Auth native reduction scope mismatch');
          } else await client.query('SELECT auth_erasure_admit($1)', [role.accountId]);
        }
        const existing = (
          await client.query<{ digest: Buffer; retired: boolean }>(
            `INSERT INTO auth_copy_work(workflow_id,name,digest,parent_workflow_id,scope_count,source_key) VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(workflow_id) DO UPDATE SET workflow_id=EXCLUDED.workflow_id RETURNING digest,retired`,
            [id, name, digest, parent ?? null, new Set(roles.map((r) => `${r.accountId}:${r.role}`)).size, sourceKey],
          )
        ).rows[0]!;
        if (existing.retired || !existing.digest.equals(digest)) throw new Error('Auth copy identity refused');
        for (const role of roles)
          await client.query(
            'INSERT INTO auth_copy_role(account_id,workflow_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
            [role.accountId, id, role.role],
          );
        const handle = await sdk.enqueueInTransaction<(...args: unknown[]) => Promise<R>>(
          client,
          {
            workflowName: name,
            workflowID: id,
            queueName: 'auth.account-copies',
            workflowIDReusePolicy: 'return-existing',
          },
          input,
        );
        if (parent)
          await client.query(
            'UPDATE auth_client_reduction_progress SET current_workflow_id=$2 WHERE operation_id=$1 AND NOT completed',
            [(input as { operationId: string }).operationId, id],
          );
        return handle;
      });
    },
    async send(
      id: string,
      message: 'install' | 'activate' | 'expire',
      topic: 'credential' | 'activation',
      key: string,
    ) {
      await copyTransaction(database, async (client) => {
        const row = (
          await client.query<{ retired: boolean }>(
            'SELECT retired FROM auth_copy_work WHERE workflow_id=$1 FOR UPDATE',
            [id],
          )
        ).rows[0];
        if (!row || row.retired) throw new Error('Auth copy work retired');
        const roles = (
          await client.query<{ account_id: string }>(
            'SELECT account_id FROM auth_copy_role WHERE workflow_id=$1 ORDER BY account_id,role LIMIT 16',
            [id],
          )
        ).rows;
        for (const role of roles) await client.query('SELECT auth_erasure_admit($1)', [role.account_id]);
        await sdk.sendInTransaction(client, id, message, topic, key);
      });
    },
  };
}
/** A native return has one closed shape. No exception, credential, approval or
 * arbitrary JSON becomes a retirement record. Field order is not significant. */
function resultDigest(value: unknown): Buffer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Auth native result refused');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  const fields = entries.map(([key]) => key).join(',');
  if (
    ![
      'accountId',
      'accountId,expired',
      'accountId,error',
      'accountId,minimumAuthnEpoch,receiptId,state',
      'clientId',
      'clientId,nextWorkflowId',
    ].includes(fields) ||
    entries.some(([key, item]) =>
      key === 'expired'
        ? item !== true
        : typeof item !== 'string' || !item || Buffer.byteLength(item) > (key === 'clientId' ? 1024 : 256),
    ) ||
    ('error' in value && !['handle_unavailable', 'registration_denied'].includes(String(value.error))) ||
    ('state' in value && value.state !== 'suspended')
  )
    throw new Error('Auth native result refused');
  return createHash('sha256').update(JSON.stringify(entries)).digest();
}

/** The executor calls this AFTER its last actual native consumer. Its native
 * terminal marker and exact result commitment commit together, outside DBOS.
 * An HTTP result/disclosure is never used to establish producer completion. */
export async function finishCopyResult(database: Pool, id: string, value: unknown, sourceKey?: string): Promise<void> {
  if (DBOS.workflowID !== id) throw new Error('Auth native result source missing');
  const digest = resultDigest(value);
  await copyTransaction(database, async (client) => {
    const work = (
      await client.query<{ name: Name; source_key: string | null; result_digest: Buffer | null }>(
        'SELECT name,source_key,result_digest FROM auth_copy_work WHERE workflow_id=$1 AND NOT retired FOR UPDATE',
        [id],
      )
    ).rows[0];
    // Explicit historical hosts in a different store have no local coverage.
    if (!work) return;
    if (work.result_digest) {
      if (!work.result_digest.equals(digest)) throw new Error('Auth native result mismatch');
      return;
    }
    if (!work.source_key || work.source_key !== (sourceKey ?? id)) throw new Error('Auth native result source missing');
    // Identity is anchored at actual transactional SDK creation. This read is
    // an identity check, never terminal-status evidence. Only the final native
    // producer step can transfer its exact remaining return to this consumer.
    const native = await client.query('SELECT 1 FROM auth_dbos.workflow_status WHERE workflow_uuid=$1 AND name=$2', [
      id,
      work.name,
    ]);
    if (!native.rowCount) throw new Error('Auth native result source missing');
    if (work.name === 'accounts.operation')
      await client.query(
        'UPDATE auth_workflow_request SET terminal_at=COALESCE(terminal_at,clock_timestamp()) WHERE workflow_id=$1',
        [id],
      );
    await client.query(
      'UPDATE auth_copy_work SET result_digest=$2,result_finished_at=clock_timestamp() WHERE workflow_id=$1',
      [id, digest],
    );
  });
}

/** The same bounded native result consumer serves the caller and default
 * recovery. It consumes the real return, checked against its native producer's
 * committed result. SUCCESS is only a nonblocking SDK-read guard, never proof.
 * Unknown/failed/live producers and missing returns remain pending. */
export async function completeCopy(database: Pool, id: string, value?: unknown): Promise<boolean> {
  const work = (
    await database.query<{ ready: boolean; retired: boolean; source_key: string | null; result_digest: Buffer | null }>(
      'SELECT ready,retired,source_key,result_digest FROM auth_copy_work WHERE workflow_id=$1',
      [id],
    )
  ).rows[0];
  if (!work || work.retired) return false;
  if (!work.source_key || !work.result_digest) return false;
  if (work.ready) return true;
  if (value === undefined) {
    const status = await DBOS.getWorkflowStatus(id);
    if (status?.status !== 'SUCCESS') return false;
    value = await DBOS.retrieveWorkflow(id).getResult();
  }
  const digest = resultDigest(value);
  if (!work.result_digest.equals(digest)) return false;
  return !!(
    await database.query(
      `UPDATE auth_copy_work SET ready=true WHERE workflow_id=$1 AND NOT retired
     AND result_digest=$2 AND result_finished_at IS NOT NULL RETURNING workflow_id`,
      [id, digest],
    )
  ).rowCount;
}
/** Raw-key probes use the deployed native schema. No payloads or history listing. */
export async function copiesAbsent(database: Pool, id: string): Promise<boolean> {
  for (const table of COPY_TABLES)
    if (
      (
        await database.query(
          `SELECT 1 FROM auth_dbos.${table} WHERE ${table === 'notifications' ? 'destination_uuid' : 'workflow_uuid'}=$1 LIMIT 1`,
          [id],
        )
      ).rowCount
    )
      return false;
  if ((await database.query('SELECT 1 FROM auth_dbos.streams WHERE workflow_uuid=$1 LIMIT 1', [id])).rowCount)
    return false;
  return true;
}
/** One exact bounded execution, never descendants or unrelated work. */
export async function eraseCopy(database: Pool, id: string): Promise<boolean> {
  const ready = await copyTransaction(database, async (client) => {
    const row = (
      await client.query<{
        ready: boolean;
        absent: boolean;
        source_key: string | null;
        result_finished_at: Date | null;
        rows: number;
        bytes: number;
        version: number;
      }>(
        'SELECT ready,absent,source_key,result_finished_at,rows,bytes,version FROM auth_copy_work WHERE workflow_id=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
    if (
      !row ||
      !row.ready ||
      !row.result_finished_at ||
      (!row.source_key && !row.absent) ||
      row.version !== 1 ||
      row.rows > 139 ||
      row.bytes > 10485760
    )
      return false;
    const ledger = (
      await client.query<{ kind: string; key: string; bytes: number }>(
        'SELECT kind,key,bytes FROM auth_copy_artifact WHERE workflow_id=$1 ORDER BY kind,key LIMIT 140',
        [id],
      )
    ).rows;
    if (ledger.length !== row.rows) return false;
    for (const table of COPY_TABLES) {
      const key =
        table === 'notifications'
          ? 'message_uuid'
          : table === 'operation_outputs'
            ? 'function_id::text'
            : table === 'workflow_events'
              ? 'key'
              : table === 'workflow_events_history'
                ? "function_id::text||':'||key"
                : "''::text";
      const actual = (
        await client.query<{ key: string; bytes: number }>(
          `SELECT ${key} AS key,octet_length(row_to_json(t)::text) AS bytes FROM auth_dbos.${table} t WHERE ${table === 'notifications' ? 'destination_uuid' : 'workflow_uuid'}=$1 LIMIT 140`,
          [id],
        )
      ).rows;
      if (
        actual.length > 139 ||
        actual.some((a) => !ledger.some((l) => l.kind === table && l.key === a.key && l.bytes >= a.bytes))
      )
        return false;
    }
    const status = (
      await client.query<{ status: string }>('SELECT status FROM auth_dbos.workflow_status WHERE workflow_uuid=$1', [
        id,
      ])
    ).rows[0];
    if (status && status.status !== 'SUCCESS') return false;
    await client.query('UPDATE auth_copy_work SET retired=true WHERE workflow_id=$1', [id]);
    return true;
  });
  if (!ready) return false;
  await DBOS.cancelWorkflow(id);
  await DBOS.deleteWorkflows([id], false);
  if (!(await copiesAbsent(database, id))) return false;
  await database.query(
    "UPDATE auth_copy_work SET absent=true,digest=decode(repeat('00',32),'hex'),source_key=NULL,result_digest=CASE WHEN result_digest IS NOT NULL THEN decode(repeat('00',32),'hex') END WHERE workflow_id=$1 AND retired",
    [id],
  );
  return true;
}
