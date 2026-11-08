import { createHash } from 'node:crypto';
import type { AuthRetentionInvocation } from './contract/index.ts';
import { DBOS, type DBOSClient, type WorkflowHandle } from '@dbos-inc/dbos-sdk';
import type { Pool, PoolClient } from 'pg';
import { retireNativeWorkflowRequest } from './request-retention.ts';
import {
  AUTH_SDK_RETIREMENT,
  authSdkFundedReadiness,
  closeAuthSdkWriters,
  createAuthSdkRetirementInvocation,
  deleteAuthSdkPayload,
  nativeFence,
  readAuthSdkFence,
  sameNativeFence,
  type WorkflowWriterFence,
} from './sdk-retirement-fence.ts';

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
export async function copyTransaction<T>(
  pool: Pool,
  action: (connection: PoolClient) => Promise<T>,
  invocation?: AuthRetentionInvocation,
): Promise<T> {
  const connection = await pool.connect();
  try {
    invocation?.check();
    await connection.query('BEGIN');
    if (invocation)
      await connection.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)", [
        Math.max(1, invocation.deadline - Date.now()) + 'ms',
      ]);
    // Cleanup retains the raw connection so expiry cannot suppress ROLLBACK.
    const checked = invocation
      ? new Proxy(connection, {
          get(target, key) {
            if (key === 'query')
              return (...args: Parameters<PoolClient['query']>) => {
                invocation.check();
                return Reflect.apply(target.query, target, args);
              };
            return Reflect.get(target, key, target);
          },
        })
      : connection;
    const value = await action(checked);
    invocation?.check();
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
      roles: readonly CopyRole[] | ((connection: PoolClient) => Promise<readonly CopyRole[]>),
      parent?: string,
    ): Promise<WorkflowHandle<R>> {
      if (!names.includes(name) || Buffer.byteLength(id) > 256) throw new Error('Auth copy scope refused');
      const sourceKey =
        name === 'accounts.registration'
          ? (input as { registrationId?: unknown })?.registrationId
          : name === 'accounts.client-reduction'
            ? ((input as { operationId?: unknown })?.operationId ?? id)
            : id;
      if (typeof sourceKey !== 'string' || !sourceKey || Buffer.byteLength(sourceKey) > 256)
        throw new Error('Auth native source identity refused');
      return copyTransaction(database, async (client) => {
        const scope = typeof roles === 'function' ? await roles(client) : roles;
        if (scope.length > 16 || !scope.length) throw new Error('Auth copy scope refused');
        const digest = createHash('sha256')
          .update(JSON.stringify([name, input, scope]))
          .digest();
        if (parent) {
          const current = (
            await client.query<{ retired: boolean }>(
              'SELECT retired FROM auth_copy_work WHERE workflow_id=$1 FOR UPDATE',
              [parent],
            )
          ).rows[0];
          if (!current || current.retired) throw new Error('Auth copy parent retired');
        }
        for (const role of [...scope].sort((a, b) => a.accountId.localeCompare(b.accountId))) {
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
            [id, name, digest, parent ?? null, new Set(scope.map((r) => `${r.accountId}:${r.role}`)).size, sourceKey],
          )
        ).rows[0]!;
        if (existing.retired || !existing.digest.equals(digest)) throw new Error('Auth copy identity refused');
        for (const role of scope)
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
export async function completeCopy(
  database: Pool,
  id: string,
  value?: unknown,
  invocation?: AuthRetentionInvocation,
): Promise<boolean> {
  if (invocation) await invocation.charge('consumer');
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
    invocation?.check();
    const status = await DBOS.getWorkflowStatus(id);
    if (status?.status !== 'SUCCESS') return false;
    invocation?.check();
    value = invocation
      ? await DBOS.getResult(id, { deadlineEpochMS: invocation.deadline })
      : await DBOS.retrieveWorkflow(id).getResult();
  }
  invocation?.check();
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
export async function copiesAbsent(database: Pool, id: string, invocation?: AuthRetentionInvocation): Promise<boolean> {
  if (invocation) await invocation.charge('absence');
  for (const table of COPY_TABLES) {
    invocation?.check();
    if (
      (
        await database.query(
          `SELECT 1 FROM auth_dbos.${table} WHERE ${table === 'notifications' ? 'destination_uuid' : 'workflow_uuid'}=$1 LIMIT 1`,
          [id],
        )
      ).rowCount
    )
      return false;
  }
  invocation?.check();
  if ((await database.query('SELECT 1 FROM auth_dbos.streams WHERE workflow_uuid=$1 LIMIT 1', [id])).rowCount)
    return false;
  return true;
}
type RetirementWork = {
  workflow_id: string;
  name: Name;
  digest: Buffer;
  parent_workflow_id: string | null;
  ready: boolean;
  retired: boolean;
  absent: boolean;
  source_key: string | null;
  result_digest: Buffer | null;
  result_finished_at: Date | null;
  scope_count: number;
  rows: number;
  bytes: number;
  version: number;
  sdk_fence_generation: string | null;
  sdk_fence_closure_id: string | null;
  sdk_fence_closed_at: string | null;
};
async function retirementWork(client: PoolClient, id: string): Promise<RetirementWork | undefined> {
  return (await client.query<RetirementWork>('SELECT * FROM auth_copy_work WHERE workflow_id=$1 FOR UPDATE', [id]))
    .rows[0];
}
function storedFence(work: RetirementWork): WorkflowWriterFence | null {
  return nativeFence(
    {
      workflowID: work.workflow_id,
      generation: work.sdk_fence_generation,
      closureID: work.sdk_fence_closure_id,
      closedAt: Number(work.sdk_fence_closed_at),
    },
    work.workflow_id,
  );
}
async function pending(database: Pool | PoolClient, id: string, code: string): Promise<false> {
  await database.query('UPDATE auth_copy_work SET sdk_fence_pending=$2 WHERE workflow_id=$1', [id, code]);
  return false;
}

/** Reuse original creation/result custody. Neither a deadline nor the SDK's
 * terminal status can stand in for the producer's committed last-consumer return. */
async function retirementPreconditions(client: PoolClient, work: RetirementWork): Promise<boolean> {
  const id = work.workflow_id;
  if (!work.source_key || work.version !== 1) return pending(client, id, 'auth-sdk-original-copy-mapping-unavailable');
  if (!work.ready || !work.result_finished_at || !work.result_digest || work.rows > 139 || work.bytes > 10485760)
    return pending(client, id, 'auth-sdk-original-result-pending');
  const roles = (
    await client.query<{ account_id: string }>(
      'SELECT account_id FROM auth_copy_role WHERE workflow_id=$1 ORDER BY account_id,role LIMIT 17',
      [id],
    )
  ).rows;
  if (!roles.length || roles.length !== work.scope_count || roles.length > 16)
    return pending(client, id, 'auth-sdk-original-copy-mapping-unavailable');
  // Exact account keys use the existing unique native obligation index. Preserve
  // its floor, applicability, continuation and accepted/published source facts.
  const liveSource = await client.query(
    `SELECT 1 FROM auth_erasure WHERE account_id=ANY($1::text[]) AND source_workflow_id=$2
     AND NOT (applicable AND kernel_version>0 AND kernel_at IS NOT NULL
       AND source_continuation_id IS NOT NULL AND source_receipt_id IS NOT NULL
       AND source_accepted_at IS NOT NULL AND source_discharged_at IS NOT NULL
       AND source_published_at IS NOT NULL) LIMIT 1`,
    [roles.map((r) => r.account_id), id],
  );
  if (liveSource.rowCount) return pending(client, id, 'auth-sdk-original-source-pending');
  const request = (
    await client.query<{ terminal_at: Date | null; request_party_version: number; request_context_version: number }>(
      'SELECT terminal_at,request_party_version,request_context_version FROM auth_workflow_request WHERE workflow_id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (request && (!request.terminal_at || request.request_party_version !== 1 || request.request_context_version !== 1))
    return pending(client, id, 'auth-sdk-original-consumer-pending');
  const status = (
    await client.query<{ name: string; status: string }>(
      'SELECT name,status FROM auth_dbos.workflow_status WHERE workflow_uuid=$1',
      [id],
    )
  ).rows[0];
  // Missing original mapping is not physical completion. Only a persisted native
  // receipt permits recovery after supported deletion has removed this row.
  if ((!status && !storedFence(work)) || (status && status.name !== work.name))
    return pending(client, id, 'auth-sdk-original-copy-mapping-unavailable');
  if (status && status.status !== 'SUCCESS') return pending(client, id, 'auth-sdk-original-consumer-pending');
  const ledger = (
    await client.query<{ kind: string; key: string; bytes: number }>(
      'SELECT kind,key,bytes FROM auth_copy_artifact WHERE workflow_id=$1 ORDER BY kind,key LIMIT 140',
      [id],
    )
  ).rows;
  if (ledger.length !== work.rows || ledger.reduce((sum, item) => sum + item.bytes, 0) !== work.bytes)
    return pending(client, id, 'auth-sdk-native-copy-coverage-pending');
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
      return pending(client, id, 'auth-sdk-native-copy-coverage-pending');
  }
  if ((await client.query('SELECT 1 FROM auth_dbos.streams WHERE workflow_uuid=$1 LIMIT 1', [id])).rowCount)
    return pending(client, id, 'auth-sdk-native-copy-coverage-pending');
  return true;
}

/** One exact bounded execution, never descendants or unrelated work. The SDK
 * retirement transaction itself touches the Auth recorder: release our copy lock
 * before calling it, then revalidate under that same copy-generation/role lock. */
export async function eraseCopy(
  database: Pool,
  id: string,
  invocation: AuthRetentionInvocation = createAuthSdkRetirementInvocation(),
): Promise<boolean> {
  await invocation.charge('custody');
  const before = await copyTransaction(
    database,
    async (client) => {
      const work = await retirementWork(client, id);
      if (!work) return null;
      if (work.retired && !storedFence(work)) {
        await pending(client, id, 'auth-sdk-original-copy-mapping-unavailable');
        return null;
      }
      if (work.absent) return work;
      return (await retirementPreconditions(client, work)) ? work : null;
    },
    invocation,
  );
  if (!before) return false;
  const funded = authSdkFundedReadiness();
  if (!funded.ready) return pending(database, id, funded.gap);
  const saved = storedFence(before);
  const receipt = saved ? await readAuthSdkFence(id, invocation) : await closeAuthSdkWriters(id, invocation);
  if (!receipt) return pending(database, id, AUTH_SDK_RETIREMENT.gap);
  if (saved && !sameNativeFence(saved, receipt)) return pending(database, id, 'auth-sdk-native-fence-receipt-mismatch');
  await invocation.charge('custody');
  const retired = await copyTransaction(
    database,
    async (client) => {
      const work = await retirementWork(client, id);
      if (!work) return false;
      const current = storedFence(work);
      if (current && !sameNativeFence(current, receipt))
        return pending(client, id, 'auth-sdk-native-fence-receipt-mismatch');
      if (work.absent) return !!current;
      if (
        work.name !== before.name ||
        work.version !== before.version ||
        work.parent_workflow_id !== before.parent_workflow_id ||
        work.scope_count !== before.scope_count ||
        !work.digest.equals(before.digest) ||
        work.source_key !== before.source_key ||
        !work.result_digest?.equals(before.result_digest ?? Buffer.alloc(0)) ||
        work.result_finished_at?.getTime() !== before.result_finished_at?.getTime() ||
        !(await retirementPreconditions(client, work))
      )
        return false;
      // The permanent receipt contains only native technical identity. It commits
      // in the existing receiving progress before any request or SDK deletion.
      await invocation.charge('receipt');
      await client.query(
        `UPDATE auth_copy_work SET sdk_fence_generation=$2,sdk_fence_closure_id=$3,
       sdk_fence_closed_at=$4,sdk_fence_pending=NULL,retired=true WHERE workflow_id=$1`,
        [id, receipt.generation, receipt.closureID, receipt.closedAt],
      );
      await retireNativeWorkflowRequest(client, id);
      return true;
    },
    invocation,
  );
  if (!retired) return false;
  // Retirement revoked native writers already. Cancellation would itself be a
  // forbidden post-fence SDK write, and supplies no original consumer authority.
  await invocation.charge('deletion-custody');
  await deleteAuthSdkPayload(id, receipt, invocation);
  const after = await readAuthSdkFence(id, invocation);
  if (!after || !sameNativeFence(receipt, after))
    return pending(database, id, 'auth-sdk-native-fence-receipt-mismatch');
  if (!(await copiesAbsent(database, id, invocation))) return pending(database, id, 'auth-sdk-physical-copies-pending');
  await invocation.charge('absent-write');
  await copyTransaction(
    database,
    async (client) => {
      // Coverage described the now-absent bytes. Keep the native fence and original
      // consumer commitment, and retire the exact physical artifact inventory.
      await client.query('DELETE FROM auth_copy_artifact WHERE workflow_id=$1', [id]);
      await client.query(
        "UPDATE auth_copy_work SET absent=true,rows=0,bytes=0,sdk_fence_pending=NULL,digest=decode(repeat('00',32),'hex') WHERE workflow_id=$1 AND retired",
        [id],
      );
    },
    invocation,
  );
  return true;
}
