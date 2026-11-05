import type { Pool } from 'pg';
import { withConnection } from '../database/pool.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import { sealHistoryAccount } from './gates.ts';
import type { WorkClient } from '../work/client.ts';
import { decodeLocator } from './locator.ts';
import type { HistoryBarrier, HistoryRegistry } from './registry.ts';
import {
  AGENT_IDENTITY_SDK_RETIREMENT,
  advanceAgentIdentityConsumerMaintenance,
  currentAgentIdentityHistoryUnit,
  assertAgentIdentityHistoryUnit,
} from './agent-identity-retirement.ts';
import type { AgentIdentityWorkSource } from './agent-identity-source.ts';
import type { WorkContext } from '../work/registry.ts';
import {
  AGENT_IDENTITY_HISTORY_GUARD_COST,
  AGENT_IDENTITY_HISTORY_ABSENCE_COST,
  lockRecordedAgentIdentityHistory,
  readAgentIdentitySDKWriterState,
  readAgentIdentitySDKFence,
} from './agent-identity-sdk-fence.ts';
import canonicalize from 'canonicalize';
import { DEFAULT_REQUEST_DEADLINE_MS } from '../command/command.ts';
import { maintainSdkWorkflowOnce } from '../work/sdk-retirement-fence.ts';
import {
  identityHistoryCommand,
  identityHistoryConnection,
  accountHistoryWork,
  IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK,
  reserveIdentityHistoryWork,
  addNativeWork,
  HISTORY_WORK_INVALIDATION,
  HISTORY_WORK_WAKE,
  HISTORY_LOCATOR_INVALIDATION,
} from './agent-identity-inventory-work.ts';
import { deadlineFor } from '../request/deadline.ts';
import {
  isOperationalWorkCustodyId,
  type CommittedOperationalWork,
  type OperationalWorkTransfer,
} from './operational-work.ts';
import { inspectOperationalWorkRetirement } from './operational-work-receiving.ts';

/** Historical executions without captured native SDK creation keep this exact unresolved gap.
 * New executions use agent-identity-work's transactional mapping and two-stage source handoff.
 * A deterministic workflow name or successful SDK return cannot certify older receiving custody. */
export const AGENT_IDENTITY_DURABLE_ASSOCIATION = Object.freeze({
  state: 'pending',
  gap: 'agent-identity-sdk-recording-port-unavailable',
  enqueue: 'access/agent-verification-work.ts: context.client.enqueue (approval and reversal effects)',
  recordingOwner: '@dbos-inc/dbos-sdk: DBOSClient.enqueue / SystemDatabase.initWorkflowStatus / recordWorkflowOutput',
  steps: 'access/agent-verification-work.ts: DBOS.registerStep (original recorded step inputs/results)',
  locatorOwner: 'history/locator.ts: durable-work/v1 accepts native UUID/hex work identities only',
} as const);

export const HISTORY_WORK_BOUNDS = Object.freeze({
  operations: 64,
  eventKeys: 8,
  eventHistory: 64,
  payloadBytes: 65536,
  metadataBytes: 4096,
  rows: 139,
  bytes: 10 * 1024 * 1024,
});
const TABLES = [
  {
    name: 'workflow_status',
    key: 'workflow_uuid',
    order: 'workflow_uuid',
    limit: 1,
    payload: ['inputs', 'output', 'error'],
  },
  { name: 'workflow_input', key: 'workflow_uuid', order: 'workflow_uuid', limit: 1, payload: ['inputs'] },
  { name: 'workflow_output', key: 'workflow_uuid', order: 'workflow_uuid', limit: 1, payload: ['output', 'error'] },
  { name: 'operation_outputs', key: 'workflow_uuid', order: 'function_id', limit: 64, payload: ['output', 'error'] },
  { name: 'workflow_events', key: 'workflow_uuid', order: 'key', limit: 8, payload: ['value'] },
  { name: 'workflow_events_history', key: 'workflow_uuid', order: 'function_id,key', limit: 64, payload: ['value'] },
  { name: 'notifications', key: 'destination_uuid', order: 'topic', limit: 0, payload: ['message'] },
  { name: 'streams', key: 'workflow_uuid', order: 'key,"offset"', limit: 0, payload: ['value'] },
] as const;

/** Exact supported SDK schema, including the three non-FK payload tables. Limits apply before
 * calculating row bytes, so an uncovered old execution never produces an unbounded certificate. */
async function inspect(
  pool: Pool,
  workId: string,
  context?: HistoryReceivingContext,
): Promise<{ empty: boolean; bounded: boolean }> {
  if (context) {
    historyDeadline(context, 0);
    // Admit the complete closed inspection before checkout. The eight LIMIT+1 probes
    // and their BEGIN/settings/COMMIT/ROLLBACK envelope are all reached by this call.
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.snapshot, context);
    for (const table of TABLES)
      await reserveIdentityHistoryWork(
        pool,
        accountHistoryWork(table.limit + 1, 1, 1, (table.limit + 1) * 80, 1),
        context,
      );
  }
  const connect = context
    ? <T>(body: (tx: import('../command/command.ts').CommandTransaction) => Promise<T>) =>
        identityHistoryConnection(pool, context, body)
    : <T>(body: (tx: import('../command/command.ts').CommandTransaction) => Promise<T>) => withConnection(pool, body);
  return connect(async (tx) => {
    if (context) {
      historyDeadline(context, 0);
      await tx.query('BEGIN READ ONLY');
    }
    try {
      if (context)
        await tx.query("SELECT set_config('statement_timeout',$1,true)", [
          String(Math.max(1, Math.floor(context.deadline - Date.now()))),
        ]);
      let rows = 0;
      let bytes = 0;
      let bounded = true;
      for (const table of TABLES) {
        const payloadFields = table.payload.map((field) => `'${field}'`).join(',');
        const payloadValid = table.payload
          .map(
            (field) => `(value->'${field}' IS NULL OR
        jsonb_typeof(value->'${field}')='null' OR (jsonb_typeof(value->'${field}')='string'
        AND octet_length(value->>'${field}')<=65536))`,
          )
          .join(' AND ');
        // Only scalar lengths leave PostgreSQL. An old oversized value never becomes a new
        // private JavaScript copy just so the minimizer can reject its budget.
        if (context) historyDeadline(context, 0);
        const result = await tx.query<{ bytes: number; metadata_bytes: number; payload_valid: boolean }>(
          `SELECT octet_length(value::text) AS bytes,
          octet_length((value-ARRAY[${payloadFields}]::text[])::text) AS metadata_bytes,
          ${payloadValid} AS payload_valid FROM (
            SELECT to_jsonb(bounded_row) AS value FROM (
              SELECT * FROM dbos.${table.name} WHERE ${table.key}=$1 ORDER BY ${table.order} LIMIT $2
            ) bounded_row
          ) measured`,
          [workId, table.limit + 1],
        );
        if (result.rows.length > table.limit) bounded = false;
        rows += result.rows.length;
        for (const row of result.rows) {
          bytes += row.bytes;
          if (!row.payload_valid || row.metadata_bytes > HISTORY_WORK_BOUNDS.metadataBytes) bounded = false;
        }
      }
      if (context) {
        historyDeadline(context, 0);
        await tx.query('COMMIT');
      }
      return { empty: rows === 0, bounded: bounded && rows <= 139 && bytes < 10 * 1024 * 1024 };
    } catch (error) {
      if (context) await tx.query('ROLLBACK');
      throw error;
    }
  });
}

/** Source terminal custody and the native SDK writer receipt must both be durable before
 * the receiving work can retire. Physical deletion keeps the original byte/row budgets and
 * exact SDK probes. */
async function prepareIdentitySDKWorkRetirement(
  pool: Pool,
  client: WorkClient,
  job: { partition_no: number; account_route: number; account_id: string },
  custodyId: string,
  locator: Buffer,
  registry: HistoryRegistry,
  barrier: HistoryBarrier,
  context: HistoryReceivingContext,
): Promise<string | null> {
  const unit = currentAgentIdentityHistoryUnit();
  if (!unit?.stage) return 'identity-history-current-unit-unavailable';
  return identityHistoryCommand(pool, context, async (tx) => {
    const held = await lockRecordedAgentIdentityHistory(tx, client, unit.stage!, context);
    if (held.state === 'pending') return held.gap;
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.seal);
    await sealHistoryAccount(tx, 0, job.account_route, job.account_id);
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeWorkRead);
    const work = (
      await tx.query<{ state: string; owner_ready: boolean; owner: string }>(
        `SELECT state,owner_ready,owner FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR UPDATE`,
        [custodyId],
      )
    ).rows[0];
    if (!work) return 'work-native-custody-missing';
    if (!work.owner_ready) return 'work-owner-consumer-open';
    const owner = registry.owner('durable-work/v1', work.owner);
    if (!owner) return 'work-owner-unregistered';
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.roleScope);
    const roles = (
      await tx.query(
        `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
      WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1 ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
        [locator],
      )
    ).rows;
    if (
      roles.length > 64 ||
      roles.some((r) => r.minimizer_version !== 1) ||
      !roles.some((r) => r.account_route === job.account_route && r.account_id === job.account_id)
    )
      return 'work-role-scope-unavailable';
    const ready = await owner.readiness(
      tx,
      {
        partition: 0,
        locator: decodeLocator('durable-work/v1', locator),
        accounts: roles.map((r) => ({ accountRoute: r.account_route, accountId: r.account_id, roles: r.roles })),
      },
      barrier,
    );
    if (!ready.ready) return ready.gap;
    if (work.state !== 'retired') {
      await reserveIdentityHistoryWork(
        pool,
        addNativeWork(
          IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativePairWrite,
          AGENT_IDENTITY_HISTORY_GUARD_COST(),
          HISTORY_WORK_INVALIDATION,
        ),
      );
      await tx.query(
        `UPDATE core.history_work SET state='retired',retired_at=clock_timestamp(),request=NULL,scope=NULL
        WHERE partition_no=0 AND work_id=$1`,
        [custodyId],
      );
    }
    return null;
  });
}

async function minimizeIdentitySDKWork(
  pool: Pool,
  client: WorkClient,
  job: { partition_no: number; account_route: number; account_id: string },
  custodyId: string,
  locator: Buffer,
  registry: HistoryRegistry,
  barrier: HistoryBarrier,
  context: HistoryReceivingContext,
  maintenance?: Pick<WorkContext, 'env' | 'clock'> & { source: AgentIdentityWorkSource },
): Promise<string | null> {
  assertAgentIdentityHistoryUnit(pool, context, client);
  if (!maintenance || !currentAgentIdentityHistoryUnit()) return AGENT_IDENTITY_SDK_RETIREMENT.gap;
  const advanced = await advanceAgentIdentityConsumerMaintenance(
    { pool, client, env: maintenance.env, clock: maintenance.clock },
    {
      partition: job.partition_no,
      locator: { artifactType: 'durable-work/v1', workId: custodyId },
      accounts: maintenance.source.accounts,
    },
    barrier,
    context,
  );
  if (advanced) return advanced;
  const prepared = await prepareIdentitySDKWorkRetirement(
    pool,
    client,
    job,
    custodyId,
    locator,
    registry,
    barrier,
    context,
  );
  if (prepared) return prepared;
  const unit = currentAgentIdentityHistoryUnit();
  if (!unit?.stage) return 'identity-history-current-unit-unavailable';
  // The original observations remain independent of the current native cleanup guard.
  const bound = await identityHistoryCommand(pool, context, (tx) =>
    lockRecordedAgentIdentityHistory(tx, client, unit.stage!, context),
  );
  if (bound.state === 'pending') return bound.gap;
  const receipt = bound.receipt;
  const before = await readAgentIdentitySDKFence(pool, client, receipt, context);
  if (before.state === 'pending') return before.gap;
  const physical = await inspect(pool, receipt.binding.workflowId, context);
  if (!physical.bounded) return 'work-execution-budget-uncovered';
  const writer = await readAgentIdentitySDKWriterState(pool, client, receipt.binding.workflowId, context);
  if (writer.state === 'pending') return writer.gap;
  if (writer.writer.generation !== '2' || canonicalize(writer.writer) !== canonicalize(bound.writer))
    return 'identity-sdk-native-receipt-changed';
  // Exact original supported deletion body, children=false, one funded owner attempt.
  await maintainSdkWorkflowOnce(pool, client, writer.writer, 'delete', context.deadline, (cost) =>
    reserveIdentityHistoryWork(pool, cost, context),
  );
  const after = await readAgentIdentitySDKFence(pool, client, receipt, context);
  if (after.state === 'pending') return after.gap;
  if (!(await inspect(pool, receipt.binding.workflowId, context)).empty) return 'work-physical-copy-remains';
  return identityHistoryCommand(pool, context, async (tx) => {
    const held = await lockRecordedAgentIdentityHistory(tx, client, unit.stage!, context);
    if (held.state === 'pending') return held.gap;
    await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.seal);
    await sealHistoryAccount(tx, 0, job.account_route, job.account_id);
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativePairWrite,
        AGENT_IDENTITY_HISTORY_GUARD_COST(),
        AGENT_IDENTITY_HISTORY_ABSENCE_COST(),
        HISTORY_WORK_INVALIDATION,
        HISTORY_WORK_WAKE,
      ),
    );
    await tx.query(`UPDATE core.history_work SET absence_verified=true WHERE partition_no=0 AND work_id=$1`, [
      custodyId,
    ]);
    await reserveIdentityHistoryWork(
      pool,
      addNativeWork(
        IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.nativeLocatorWrite,
        AGENT_IDENTITY_HISTORY_GUARD_COST(),
        AGENT_IDENTITY_HISTORY_ABSENCE_COST(),
        HISTORY_LOCATOR_INVALIDATION,
      ),
    );
    await tx.query(
      `UPDATE core.history_locator SET state='minimized',proof_barrier=$3 WHERE partition_no=0
      AND account_route=$1 AND account_id=$3 AND artifact_type='durable-work/v1' AND locator=$2`,
      [job.account_route, locator, job.account_id],
    );
    return null;
  });
}

export async function minimizeHistoryWork(
  pool: Pool,
  client: WorkClient,
  job: { partition_no: number; account_route: number; account_id: string },
  locator: Buffer,
  registry: HistoryRegistry,
  barrier: HistoryBarrier,
  maintenance?: Pick<WorkContext, 'env' | 'clock'>,
  operational?: Readonly<{ origin: CommittedOperationalWork; transfer: OperationalWorkTransfer }>,
): Promise<string | null> {
  const key = decodeLocator('durable-work/v1', locator);
  if (key.artifactType !== 'durable-work/v1') throw new TypeError('Invalid durable locator');
  // Namespace is dispatch only: the branch resolves its exact durable native mapping and
  // real SDK writer barrier before using the deterministic SDK name. No generic UUID cleanup.
  if (isOperationalWorkCustodyId(key.workId))
    return inspectOperationalWorkRetirement(pool, client, key.workId, operational);
  const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
  const unit = currentAgentIdentityHistoryUnit();
  if (unit?.prepaid) {
    assertAgentIdentityHistoryUnit(pool, unit.context, client);
    const selected = unit.prepaid.parent.position;
    if (
      registry !== unit.prepaid.deps.registry ||
      job.account_id !== selected.account_id ||
      job.account_route !== selected.account_route ||
      job.partition_no !== selected.scan_partition ||
      barrier.accountId !== selected.barrier_id ||
      barrier.accountRoute !== selected.account_route ||
      barrier.version !== selected.barrier_version ||
      barrier.at !== selected.barrier_at
    )
      throw new (await import('../access/identity-original-admission.ts')).IdentityOriginalUnavailable(
        'identity-history-selected-scope-changed',
      );
  }
  await reserveIdentityHistoryWork(pool, IDENTITY_HISTORY_ACCOUNTS_LOCAL_WORK.mapping, unit?.context);
  assertAgentIdentityHistoryUnit(pool, unit?.context, client);
  const mapping = unit?.prepaid
    ? await identityHistoryConnection(pool, unit.context, (tx) => resolveAgentIdentitySDKWork(tx, key.workId))
    : await withConnection(pool, (tx) => resolveAgentIdentitySDKWork(tx, key.workId));
  assertAgentIdentityHistoryUnit(pool, unit?.context, client);
  if (unit?.prepaid && (!mapping || registry !== unit.prepaid.deps.registry))
    return 'identity-history-selected-native-mapping-unavailable';
  const sdkWorkId = mapping?.workflowId ?? key.workId;
  if (mapping?.gap) return mapping.gap;
  if (mapping)
    return minimizeIdentitySDKWork(
      pool,
      client,
      job,
      key.workId,
      locator,
      registry,
      barrier,
      unit?.context ?? { deadline: deadlineFor(DEFAULT_REQUEST_DEADLINE_MS) },
      maintenance && mapping.source ? { ...maintenance, source: mapping.source } : undefined,
    );
  const prepared = await withConnection(pool, async (tx): Promise<string | null> => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      if (!(await lockHistoryBarrier(tx, barrier))) throw new TypeError('History barrier mismatch');
      const custody = await resolveAgentIdentitySDKWork(tx, key.workId);
      if (custody?.gap) {
        await tx.query('COMMIT');
        return custody.gap;
      }
      await sealHistoryAccount(tx, job.partition_no, job.account_route, job.account_id);
      const result = await tx.query('SELECT * FROM core.history_work WHERE partition_no=$1 AND work_id=$2 FOR UPDATE', [
        job.partition_no,
        key.workId,
      ]);
      const work = result.rows[0];
      let gap: string | null = null;
      if (!work) gap = 'work-native-custody-missing';
      else if (work.state !== 'retired') {
        if (!work.owner_ready) gap = 'work-owner-consumer-open';
        const owner = registry.owner('durable-work/v1', work.owner);
        if (!owner) gap = 'work-owner-unregistered';
        if (!gap && owner) {
          const associations = await tx.query(
            `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
             WHERE partition_no=$1 AND artifact_type='durable-work/v1' AND locator=$2
             ORDER BY account_route,account_id LIMIT 65`,
            [job.partition_no, locator],
          );
          if (
            associations.rows.length > 64 ||
            associations.rows.some((ref) => ref.minimizer_version !== 1) ||
            !associations.rows.some(
              (ref) => ref.account_id === job.account_id && ref.account_route === job.account_route,
            )
          )
            gap = 'work-role-scope-unavailable';
          else {
            const readiness = await owner.readiness(
              tx,
              {
                partition: job.partition_no,
                locator: key,
                accounts: associations.rows.map((ref) => ({
                  accountRoute: ref.account_route,
                  accountId: ref.account_id,
                  roles: ref.roles,
                })),
              },
              barrier,
            );
            if (!readiness.ready) gap = readiness.gap;
          }
        }
        // The receiving home, not a source intent, owns actual DBOS retirement.
        if (!gap && job.partition_no !== 0) {
          const destination = await tx.query(
            'SELECT absence_verified FROM core.history_work WHERE partition_no=0 AND work_id=$1',
            [key.workId],
          );
          if (!destination.rows[0]?.absence_verified) gap = 'work-destination-retirement-pending';
        }
        if (!gap)
          await tx.query(
            `UPDATE core.history_work SET state='retired',retired_at=clock_timestamp(),request=NULL,scope=NULL
           WHERE partition_no=$1 AND work_id=$2`,
            [job.partition_no, key.workId],
          );
      }
      await tx.query('COMMIT');
      return gap;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  if (prepared) return prepared;
  if (job.partition_no === 0) {
    // A registration does not certify pre-existing history. Probe physical rows/serialized bytes.
    const before = await inspect(pool, sdkWorkId);
    if (!before.bounded) return 'work-execution-budget-uncovered';
    await client.cancelWorkflow(sdkWorkId, { cancelChildren: false });
    await client.deleteWorkflows([sdkWorkId], false);
    if (!(await inspect(pool, sdkWorkId)).empty) return 'work-physical-copy-remains';
  }
  await withConnection(pool, async (tx) => {
    await tx.query('BEGIN');
    try {
      if (!(await lockHistoryBarrier(tx, barrier))) throw new TypeError('History barrier mismatch');
      await sealHistoryAccount(tx, job.partition_no, job.account_route, job.account_id);
      await tx.query(
        `UPDATE core.history_work SET absence_verified=true WHERE partition_no=$1 AND work_id=$2 AND state='retired'`,
        [job.partition_no, key.workId],
      );
      await tx.query(
        `UPDATE core.history_locator SET state='minimized',proof_barrier=$3
         WHERE partition_no=$1 AND account_route=$2 AND account_id=$3 AND artifact_type='durable-work/v1' AND locator=$4
           AND EXISTS(SELECT 1 FROM core.history_work w WHERE w.partition_no=$1 AND w.work_id=$5 AND w.absence_verified)`,
        [job.partition_no, job.account_route, job.account_id, locator, key.workId],
      );
      await tx.query('COMMIT');
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
  return null;
}

/** Ordinary record cleanup can acknowledge an execution already retired by its native owner.
 * Active SDK payload mutation needs source-bound retirement custody; a released read cannot supply it. */
export async function minimizeRecordHistoryWork(
  tx: import('../command/command.ts').CommandTransaction,
  job: import('./record-source-lock.ts').RecordHistoryLocalJob,
  locator: Buffer,
): Promise<string | null> {
  const { lockRecordHistoryCopy } = await import('./record-source-lock.ts');
  if (!(await lockRecordHistoryCopy(tx, job, 'durable-work/v1', locator))) return 'record-source-stale';
  const key = decodeLocator('durable-work/v1', locator);
  if (key.artifactType !== 'durable-work/v1') throw new TypeError('Invalid durable locator');
  const rows = await tx.query(
    `SELECT state,absence_verified,request,scope FROM core.history_work
     WHERE partition_no=$1 AND work_id=$2 FOR UPDATE`,
    [job.partition_no, key.workId],
  );
  const work = rows.rows[0];
  if (!work) return 'work-native-custody-missing';
  if (work.state === 'retired' && work.absence_verified && work.request === null && work.scope === null) return null;
  return 'record-work-source-bound-retirement-unavailable';
}
