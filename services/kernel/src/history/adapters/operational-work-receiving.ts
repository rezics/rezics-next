import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import { withConnection } from '../../database/pool.ts';
import type { WorkClient } from '../../work/client.ts';
import { guardHistoryAccounts } from './gates.ts';
import {
  OPERATIONAL_WORK_OWNER,
  insertOperationalWorkInventory,
  operationalWorkSource,
  type OperationalWorkSource,
} from './operational-work.ts';
import { consumeOperationalWorkTransfer, operationalWorkDeadlineClient } from './operational-work-budget.ts';
import {
  type CommittedOperationalWork,
  type OperationalWorkTransfer,
  OperationalWorkUnavailable,
  encodeLocator,
} from '../contract/index.ts';

export async function lockOperationalSDKInventory(
  tx: Pick<PoolClient, 'query'>,
  pool: Pool,
  work: WorkClient,
  source: OperationalWorkSource,
): Promise<void> {
  // The real SDK checks Pool identity and holds its restore-domain and native writer locks
  // on THIS receiving client through COMMIT. No released SDK observation is a writer fence.
  await work.checkWorkflowWriterStateInTransaction(tx, pool, source.sdkWriter);
  const status = (
    await tx.query(`SELECT name,queue_name,creator_xid FROM dbos.workflow_status WHERE workflow_uuid=$1 FOR SHARE`, [
      source.workflowId,
    ])
  ).rows[0];
  const input = (
    await tx.query(
      `SELECT CASE WHEN octet_length(inputs)<=8192 THEN inputs END AS inputs
     FROM dbos.workflow_input WHERE workflow_uuid=$1 FOR SHARE`,
      [source.workflowId],
    )
  ).rows[0];
  if (
    !status ||
    status.name !== source.intent.workflowName ||
    status.queue_name !== source.intent.queue ||
    status.creator_xid !== source.sdkCreator ||
    typeof input?.inputs !== 'string' ||
    createHash('sha256').update(input.inputs).digest('hex') !== source.sdkInputDigest
  )
    throw new OperationalWorkUnavailable('operational-work-sdk-original-recreated-or-changed');
}

/** Native columns and JSON carry the same discriminated stamp, including legacy absence. */
function sameMappedStamp(mapping: Record<string, unknown>, source: OperationalWorkSource): boolean {
  return (
    mapping.source_domain === (source.stamp?.domain ?? 'legacy-unpositioned') &&
    mapping.source_epoch === source.epoch &&
    mapping.source_position === source.position &&
    mapping.source_generation === source.generation &&
    mapping.workflow_id === source.workflowId
  );
}

const roles = (value: readonly { accountRoute: number; accountId: string; roles: number }[]) =>
  [...value].sort((a, b) => a.accountRoute - b.accountRoute || a.accountId.localeCompare(b.accountId));
export async function readbackOperationalInventory(
  tx: Pick<PoolClient, 'query'>,
  source: OperationalWorkSource,
): Promise<void> {
  const work = (
    await tx.query(
      `SELECT request_digest,owner,request,scope,source_partition,source_transaction,admitted,state
     FROM core.history_work WHERE partition_no=0 AND work_id=$1 FOR SHARE`,
      [source.custodyId],
    )
  ).rows[0];
  if (
    !work ||
    !Buffer.from(work.request_digest).equals(Buffer.from(source.digest, 'hex')) ||
    work.owner !== OPERATIONAL_WORK_OWNER ||
    work.source_partition !== source.partition ||
    work.source_transaction !== source.transactionId ||
    !work.admitted ||
    work.state === 'retired' ||
    canonicalize(work.request) !== canonicalize(source.intent) ||
    canonicalize(work.scope) !== canonicalize(source.scope)
  )
    throw new OperationalWorkUnavailable('operational-work-native-inventory-changed');
  const associations = (
    await tx.query(
      `SELECT account_route,account_id,roles,minimizer_version,state FROM core.history_locator
     WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1
     ORDER BY account_route,account_id LIMIT 9 FOR SHARE`,
      [Buffer.from(encodeLocator({ artifactType: 'durable-work/v1', workId: source.custodyId }))],
    )
  ).rows;
  if (
    associations.length > 8 ||
    associations.some((row) => row.minimizer_version !== 1 || row.state !== 'pending') ||
    canonicalize(
      roles(
        associations.map((row) => ({ accountRoute: row.account_route, accountId: row.account_id, roles: row.roles })),
      ),
    ) !== canonicalize(roles(source.scope.accounts))
  )
    throw new OperationalWorkUnavailable('operational-work-original-role-union-changed');
}

/** Already issued by receiveCommittedOperationalWork. Never call while holding the source
 * client. It registers the actual original SDK execution; it performs NO second enqueue. */
export async function receiveOperationalWorkDestination(
  pool: Pool,
  work: WorkClient,
  origin: CommittedOperationalWork,
  transfer: OperationalWorkTransfer,
): Promise<'registered-pending-source-currentness' | 'registered-pending-position' | 'uncaptured'> {
  const source = operationalWorkSource(pool, origin);
  const { deadline: transferDeadline } = consumeOperationalWorkTransfer(pool, transfer, 'receive', source.custodyId);
  const deadline = Math.min(transferDeadline, source.deadline);
  return withConnection(pool, async (client) => {
    const tx = operationalWorkDeadlineClient(client, deadline);
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','200ms',true)", [
        String(Math.max(1, deadline - Date.now())),
      ]);
      const receiver = (
        await tx.query("SELECT epoch FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE")
      ).rows[0];
      const domain = (
        await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE')
      ).rows[0];
      if (!receiver || !domain) throw new OperationalWorkUnavailable('operational-work-receiving-home-unavailable');
      await guardHistoryAccounts(tx, 0, source.scope.accounts);
      await lockOperationalSDKInventory(tx, pool, work, source);
      await tx.query(
        `INSERT INTO core.operational_work_mapping(partition_no,custody_id,workflow_id,source_partition,source_transaction,
         source_epoch,source_position,source_generation,request_digest,source,receiver_epoch,receiver_generation,sdk_writer,source_domain,log_gap)
         VALUES(0,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [
          source.custodyId,
          source.workflowId,
          source.partition,
          source.transactionId,
          source.epoch,
          source.position,
          source.generation,
          Buffer.from(source.digest, 'hex'),
          source,
          receiver.epoch,
          domain.generation,
          source.sdkWriter,
          source.stamp?.domain ?? 'legacy-unpositioned',
          source.stamp ? null : source.gap,
        ],
      );
      const mapping = (
        await tx.query(
          `SELECT source,receiver_epoch,receiver_generation::text,workflow_id,source_domain,source_epoch,source_position::text,source_generation::text FROM core.operational_work_mapping
         WHERE partition_no=0 AND custody_id=$1 FOR SHARE`,
          [source.custodyId],
        )
      ).rows[0];
      if (
        !mapping ||
        !sameMappedStamp(mapping, source) ||
        mapping.workflow_id !== source.workflowId ||
        canonicalize(mapping.source) !== canonicalize(source) ||
        mapping.receiver_epoch !== receiver.epoch ||
        mapping.receiver_generation !== domain.generation
      )
        throw new OperationalWorkUnavailable('operational-work-receiving-restore-or-binding-changed');
      await insertOperationalWorkInventory(
        tx,
        0,
        source.custodyId,
        Buffer.from(source.digest, 'hex'),
        source.scope,
        source.intent,
        source.partition,
        source.transactionId,
      );
      await readbackOperationalInventory(tx, source);
      if (Date.now() >= deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
      await tx.query('COMMIT');
      return !source.creationCaptured
        ? 'uncaptured'
        : source.stamp
          ? 'registered-pending-source-currentness'
          : 'registered-pending-position';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** One independently funded current receiver check. There is no source client here; the
 * original was resolved and released before checkout. Every SDK key is the immutable mapped
 * workflow name, never the native custody UUID. The writer barrier survives this COMMIT. */
async function checkMappedOperationalWork(
  pool: Pool,
  work: WorkClient,
  origin: CommittedOperationalWork,
  transfer: OperationalWorkTransfer,
  phase: 'replay' | 'retirement',
  custodyId?: string,
): Promise<string | null> {
  const source = operationalWorkSource(pool, origin);
  const { deadline: transferDeadline } = consumeOperationalWorkTransfer(pool, transfer, phase, source.custodyId);
  const deadline = Math.min(transferDeadline, source.deadline);
  if (custodyId !== undefined && custodyId !== source.custodyId)
    throw new TypeError('Foreign operational History retirement locator');
  return withConnection(pool, async (client) => {
    const tx = operationalWorkDeadlineClient(client, deadline);
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await tx.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','200ms',true)", [
        String(Math.max(1, deadline - Date.now())),
      ]);
      const receiver = (
        await tx.query("SELECT epoch FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE")
      ).rows[0];
      const domain = (
        await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE')
      ).rows[0];
      const mapping = (
        await tx.query(
          `SELECT source,receiver_epoch,receiver_generation::text,workflow_id,source_domain,source_epoch,source_position::text,source_generation::text FROM core.operational_work_mapping
         WHERE partition_no=0 AND custody_id=$1 FOR SHARE`,
          [source.custodyId],
        )
      ).rows[0];
      if (
        !mapping ||
        !sameMappedStamp(mapping, source) ||
        !receiver ||
        mapping.receiver_epoch !== receiver.epoch ||
        mapping.receiver_generation !== domain?.generation ||
        canonicalize(mapping.source) !== canonicalize(source)
      )
        throw new OperationalWorkUnavailable('operational-work-receiving-restore-or-binding-changed');
      for (const account of source.scope.accounts) {
        const seal = (
          await tx.query(
            `SELECT phase FROM core.history_seal WHERE partition_no=0 AND account_route=$1 AND account_id=$2 FOR SHARE`,
            [account.accountRoute, account.accountId],
          )
        ).rows[0];
        if (phase === 'replay' && seal?.phase !== 'open')
          throw new OperationalWorkUnavailable('operational-work-account-history-sealed');
      }
      await lockOperationalSDKInventory(tx, pool, work, source);
      await readbackOperationalInventory(tx, source);
      if (Date.now() >= deadline) throw new OperationalWorkUnavailable('operational-work-deadline');
      await tx.query("SELECT set_config('statement_timeout',$1,true)", [String(Math.max(1, deadline - Date.now()))]);
      await tx.query('COMMIT');
      return source.creationCaptured ? source.gap : 'operational-work-uncaptured-older-execution';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export async function verifyOperationalWorkReplay(
  pool: Pool,
  work: WorkClient,
  origin: CommittedOperationalWork,
  transfer: OperationalWorkTransfer,
): Promise<void> {
  const gap = await checkMappedOperationalWork(pool, work, origin, transfer, 'replay');
  if (gap) throw new OperationalWorkUnavailable(gap);
}

/** Independent real producer/receiving bodies remain callable. Only the final destructive
 * branch is held for the missing released Source currentness and physical-home owner operands.
 * No SDK status, registration, local cleanup or ACK substitutes for those native operands. */
export async function inspectOperationalWorkRetirement(
  pool: Pool,
  work: WorkClient,
  custodyId: string,
  funding?: Readonly<{ origin: CommittedOperationalWork; transfer: OperationalWorkTransfer }>,
): Promise<string> {
  if (!funding) return 'operational-work-native-transfer-unavailable';
  const gap = await checkMappedOperationalWork(pool, work, funding.origin, funding.transfer, 'retirement', custodyId);
  return gap ?? 'operational-work-source-currentness-unavailable';
}
