import { randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import {
  accountIdentityUnavailable,
  assertOriginalAgentIdentityDecision,
  readOriginalAgentIdentityDecision,
  type OriginalAgentIdentityDecision,
} from '../access/agent-verification-identity.ts';
import type { AgentVerificationReversal } from '../access/agent-verification.ts';
import { withConnection } from '../database/pool.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import { receiveMappedHistoryWork, type ScopedWorkRequest } from '../work/history-enqueue.ts';
import { guardHistoryAccounts } from './gates.ts';
import {
  agentIdentityAccounts,
  agentIdentityWorkSourceKey,
  assertAgentIdentitySourceHandoff,
  readAgentIdentitySourceHandoff,
  type AgentIdentityReceipt,
  type AgentIdentitySourceHandoff,
  type AgentIdentityWorkSource,
} from './agent-identity-source.ts';

export const AGENT_IDENTITY_WORK_OWNER = 'access.agent-identity';
export {
  AGENT_IDENTITY_SDK_FENCE_CONSUMER,
  readAgentIdentitySDKReceivingBinding,
  retireAgentIdentitySDKWork,
  readAgentIdentitySDKFence,
  type AgentIdentitySDKRetirementReceipt,
  type AgentIdentitySDKFenceObservation,
  type AgentIdentitySDKReceivingBinding,
  type AgentIdentitySDKReceivingObservation,
} from './agent-identity-sdk-fence.ts';
export {
  AGENT_IDENTITY_SDK_RETIREMENT,
  agentIdentityRetirementReadiness,
  readAgentIdentityRetirementStage,
  verifyAgentIdentityRetirementStage,
  type AgentIdentityRetirementStage,
  type AgentIdentityRetirementResult,
} from './agent-identity-retirement.ts';
export type AgentIdentityApprovalCopy = Readonly<{
  requestId: string;
  accountId: string;
  requester: string;
  decider: string;
  catalogueId: string;
  accountKind: string;
  epoch: number;
  position: string;
  transactionId: string;
  receiptKey: string;
  receiptDigest: string;
}>;
export type AgentIdentityWorkAdmission = 'admitted' | 'retired';

/** The native tombstone outlives source payload and SDK deduplication. Check it before
 * reconstructing arguments or entering the SDK, including delayed original outbox delivery. */
async function retiredWorkflow(pool: Pool, workflowId: string): Promise<boolean> {
  return withConnection(pool, async (tx) => {
    const row = (
      await tx.query(
        `SELECT w.state,m.sdk_retirement_receipt IS NOT NULL AS writers_fenced FROM core.agent_identity_work m
         JOIN core.history_work w ON w.partition_no=0 AND w.work_id=m.custody_id
           AND w.owner=$2 AND w.request_digest=m.request_digest
         WHERE m.workflow_id=$1`,
        [workflowId, AGENT_IDENTITY_WORK_OWNER],
      )
    ).rows[0];
    return row?.state === 'retired' || row?.writers_fenced === true;
  });
}

function approvalCopy(decision: OriginalAgentIdentityDecision): AgentIdentityApprovalCopy {
  assertOriginalAgentIdentityDecision(decision);
  return {
    requestId: decision.request_id,
    accountId: decision.account_id,
    requester: decision.requested_by,
    decider: decision.decided_by,
    catalogueId: decision.catalogue_subject_id,
    accountKind: decision.account_kind,
    epoch: decision.epoch,
    position: decision.position,
    transactionId: decision.transaction_id,
    receiptKey: decision.native_receipt_key,
    receiptDigest: decision.request_digest,
  };
}

/** Exact current Global owner, request, approval receipt AND its native write basis. All are
 * in home zero. No account-home checkout is held while this receiver is locked. */
async function lockApproval(tx: PoolClient, approval: AgentIdentityApprovalCopy, replay = false): Promise<void> {
  const row = (
    await tx.query(
      `SELECT r.request_id FROM access.agent_verification_request r
     JOIN editorial.write_basis b ON b.partition_no=0 AND b.transaction_id=r.decision_receipt_id
       AND b.principal_kind='account' AND b.principal_id=r.decided_by
     JOIN core.receipt c ON c.partition_no=0 AND c.transaction_id=b.transaction_id
       AND c.principal_kind='account' AND c.principal_id=r.decided_by
       AND c.command_kind='access.agent-verification.approve' AND c.epoch=b.epoch AND c.position=b.position
     JOIN core.partition p ON p.partition_no=0 AND p.write_state='active'
       AND p.epoch=b.epoch AND p.position>=b.position
     WHERE r.route=0 AND r.request_id=$1 AND r.decision_receipt_id=$2
       AND r.account_id=$3 AND r.requested_by=$4 AND r.decided_by=$5
       AND r.catalogue_subject_id=$6 AND r.account_kind=$7
       AND b.epoch=$8 AND b.position=$9 AND c.idempotency_key=$10 AND c.request_digest=decode($11,'hex')
       AND (r.state IN ('approving','approved') OR ($12 AND r.state='failed'))
     FOR SHARE OF r,b,c,p`,
      [
        approval.requestId,
        approval.transactionId,
        approval.accountId,
        approval.requester,
        approval.decider,
        approval.catalogueId,
        approval.accountKind,
        approval.epoch,
        approval.position,
        approval.receiptKey,
        approval.receiptDigest,
        replay,
      ],
    )
  ).rows[0];
  if (!row) throw accountIdentityUnavailable('original Global approval custody changed');
}

async function receiving<T>(
  pool: Pool,
  run: (tx: PoolClient, epoch: number, generation: string) => Promise<T>,
): Promise<T> {
  return withConnection(pool, async (tx) => {
    await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      const owner = (
        await tx.query("SELECT epoch FROM core.partition WHERE partition_no=0 AND write_state='active' FOR SHARE")
      ).rows[0];
      if (!owner) throw accountIdentityUnavailable('SDK receiving home is unavailable');
      const domain = (
        await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE')
      ).rows[0];
      if (!domain) throw accountIdentityUnavailable('SDK receiving generation unavailable');
      const value = await run(tx, owner.epoch, domain.generation);
      await tx.query('COMMIT');
      return value;
    } catch (error) {
      await tx.query('ROLLBACK');
      throw error;
    }
  });
}

async function bindSource(
  tx: PoolClient,
  handoff: AgentIdentitySourceHandoff,
  receiverEpoch: number,
  generation: string,
): Promise<void> {
  assertAgentIdentitySourceHandoff(handoff);
  const row = (
    await tx.query<{
      source: AgentIdentityWorkSource | null;
      workflow_id: string;
      source_key: string;
      accounts: AgentIdentityWorkSource['accounts'];
      receiver_epoch: number;
      receiver_generation: string;
      writer_version: number;
    }>(
      `SELECT source,workflow_id,source_key,accounts,receiver_epoch,receiver_generation::text,writer_version FROM core.agent_identity_work
     WHERE custody_id=$1 FOR UPDATE`,
      [handoff.custodyId],
    )
  ).rows[0];
  if (
    !row ||
    row.workflow_id !== handoff.source.workflowId ||
    row.source_key !== handoff.source.key ||
    row.receiver_epoch !== receiverEpoch ||
    row.receiver_generation !== generation ||
    handoff.generation !== generation ||
    row.writer_version !== 1 ||
    canonicalize(row.accounts) !== canonicalize(handoff.source.accounts) ||
    (row.source !== null && canonicalize(row.source) !== canonicalize(handoff.source))
  )
    throw accountIdentityUnavailable('SDK source/receiver native binding mismatch');
  if (row.source === null)
    await tx.query('UPDATE core.agent_identity_work SET source=$2 WHERE custody_id=$1 AND source IS NULL', [
      handoff.custodyId,
      handoff.source,
    ]);
}

/** Initial approval custody and SDK creation commit together. There is deliberately no chosen
 * release or accepted AccountIdentitySource here: record-pending remains its original producer. */
export async function enqueueAgentIdentityVerification(
  pool: Pool,
  client: WorkClient,
  requestId: string,
  receiptId: string,
): Promise<AgentIdentityWorkAdmission> {
  const workflowId = `accounts.agent-verification:${requestId}:${receiptId}`;
  if (await retiredWorkflow(pool, workflowId)) return 'retired';
  const decision = await readOriginalAgentIdentityDecision(pool, requestId, receiptId);
  const approval = approvalCopy(decision);
  const receipt: AgentIdentityReceipt = {
    kind: 'account-agent.verify',
    account: decision.account_id,
    receipt: receiptId,
  };
  // An original source can predate effect delivery. Discover only its exact keyed intent.
  const sourceExists = await withConnection(
    pool,
    async (tx) =>
      (
        await tx.query('SELECT 1 FROM core.agent_identity_work_source WHERE partition_no=$1 AND source_key=$2', [
          partitionOf(routeOf(decision.account_id)!),
          agentIdentityWorkSourceKey(receipt),
        ])
      ).rows.length === 1,
  );
  const handoff = sourceExists ? await readAgentIdentitySourceHandoff(pool, receipt) : null;
  const custodyId = decision.custody_id ?? handoff?.custodyId ?? randomUUID();
  if (handoff && handoff.custodyId !== custodyId) throw accountIdentityUnavailable('conflicting original SDK custody');
  const accounts = agentIdentityAccounts(decision.account_id, decision.requested_by, decision.decided_by);
  const request: ScopedWorkRequest = {
    owner: AGENT_IDENTITY_WORK_OWNER,
    intent: {
      queue: 'workflows',
      workflowName: 'accounts.agent-verification',
      workflowId,
      input: { accounts: accounts.map((account) => account.accountId) },
      arguments: [requestId, receiptId],
    },
    scope: { artifactType: 'durable-work/v1', accounts },
  };
  return receiving(pool, async (tx, epoch, generation) => {
    await lockApproval(tx, approval);
    await tx.query(
      `INSERT INTO core.agent_identity_work(custody_id,workflow_id,source_key,approval,accounts,receiver_epoch,receiver_generation)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workflow_id) DO NOTHING`,
      [
        custodyId,
        workflowId,
        agentIdentityWorkSourceKey(receipt),
        approval,
        JSON.stringify(accounts),
        epoch,
        generation,
      ],
    );
    const stored = (
      await tx.query(
        'SELECT custody_id,approval,receiver_epoch,receiver_generation::text,writer_version FROM core.agent_identity_work WHERE workflow_id=$1 FOR UPDATE',
        [workflowId],
      )
    ).rows[0];
    // Concurrent first deliveries converge through a retry and the persisted opaque UUID.
    if (
      !stored ||
      stored.custody_id !== custodyId ||
      stored.receiver_epoch !== epoch ||
      stored.receiver_generation !== generation ||
      stored.writer_version !== 1 ||
      canonicalize(stored.approval) !== canonicalize(approval)
    )
      throw accountIdentityUnavailable('initial SDK approval association changed; retry original delivery');
    if (handoff) await bindSource(tx, handoff, epoch, generation);
    return receiveMappedHistoryWork(tx, client, custodyId, { partition: 0, transactionId: receiptId }, request);
  });
}

/** An existing real reversal Source precedes this enqueue. Compare the actual original native
 * receipt response so no event/caller payload can introduce another retained role or reason. */
export async function enqueueAgentIdentityReversal(
  pool: Pool,
  client: WorkClient,
  decision: AgentVerificationReversal,
): Promise<AgentIdentityWorkAdmission> {
  if (await retiredWorkflow(pool, `accounts.agent-verification-reversal:${decision.accountId}:${decision.receiptId}`))
    return 'retired';
  const receipt: AgentIdentityReceipt = {
    kind: 'account-agent.unverify',
    account: decision.accountId,
    receipt: decision.receiptId,
  };
  const handoff = await readAgentIdentitySourceHandoff(pool, receipt);
  if (!handoff) throw accountIdentityUnavailable('original reversal SDK source association unavailable');
  const original = await withConnection(
    pool,
    async (tx) =>
      (
        await tx.query(
          `SELECT response FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2
       AND principal_kind='account' AND command_kind IN
       ('access.agent-verification.released','access.agent-verification.revoked','access.agent-verification.deleted')
       AND epoch=$3 AND position=$4`,
          [handoff.source.partition, handoff.source.transactionId, handoff.source.epoch, handoff.source.position],
        )
      ).rows[0],
  );
  if (!original || canonicalize(original.response) !== canonicalize(decision))
    throw accountIdentityUnavailable('original reversal SDK arguments unavailable or mismatched');
  const request: ScopedWorkRequest = {
    owner: AGENT_IDENTITY_WORK_OWNER,
    intent: {
      queue: 'workflows',
      workflowName: 'accounts.agent-verification-reversal',
      workflowId: handoff.source.workflowId,
      input: { accounts: handoff.source.accounts.map((account) => account.accountId) },
      arguments: [decision],
    },
    scope: { artifactType: 'durable-work/v1', accounts: handoff.source.accounts },
  };
  return receiving(pool, async (tx, epoch, generation) => {
    assertAgentIdentitySourceHandoff(handoff);
    await tx.query(
      `INSERT INTO core.agent_identity_work(custody_id,workflow_id,source_key,accounts,receiver_epoch,source,receiver_generation)
       VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workflow_id) DO NOTHING`,
      [
        handoff.custodyId,
        handoff.source.workflowId,
        handoff.source.key,
        JSON.stringify(handoff.source.accounts),
        epoch,
        handoff.source,
        generation,
      ],
    );
    await bindSource(tx, handoff, epoch, generation);
    return receiveMappedHistoryWork(
      tx,
      client,
      handoff.custodyId,
      { partition: handoff.source.partition, transactionId: handoff.source.transactionId },
      request,
    );
  });
}

/** The unchanged record-pending step calls after its source command commits and before its SDK
 * result is recorded. A crash at this cut retries the original command receipt and this handoff. */
export async function associateAgentIdentityWorkSource(pool: Pool, receipt: AgentIdentityReceipt): Promise<void> {
  const handoff = await readAgentIdentitySourceHandoff(pool, receipt);
  if (!handoff) throw accountIdentityUnavailable('original SDK source association unavailable');
  await receiving(pool, async (tx, epoch, generation) => {
    await guardHistoryAccounts(tx, 0, handoff.source.accounts);
    await bindSource(tx, handoff, epoch, generation);
  });
}

/** Replays check this outside the registered step, including cached SDK results. It creates no
 * new workflow/step and never infers custody from the status table or an ID parsed as a locator. */
export async function verifyAgentIdentityWorkReplay(pool: Pool, workflowId: string): Promise<void> {
  if (await retiredWorkflow(pool, workflowId)) throw accountIdentityUnavailable('SDK execution permanently retired');
  const mapping = await withConnection(
    pool,
    async (tx) =>
      (
        await tx.query<{
          custody_id: string;
          source_key: string;
          source: AgentIdentityWorkSource | null;
          approval: AgentIdentityApprovalCopy | null;
        }>('SELECT custody_id,source_key,source,approval FROM core.agent_identity_work WHERE workflow_id=$1', [
          workflowId,
        ])
      ).rows[0],
  );
  if (!mapping) throw accountIdentityUnavailable('legacy SDK execution lacks native receiving custody');
  if (mapping.source) {
    // source_key is the closed native receipt tuple, never parsed workflow naming text.
    const [kind, account, receipt] = JSON.parse(mapping.source_key) as [AgentIdentityReceipt['kind'], string, string];
    await associateAgentIdentityWorkSource(pool, { kind, account, receipt });
  } else {
    if (!mapping.approval) throw accountIdentityUnavailable('initial SDK approval custody unavailable');
    await receiving(pool, async (tx, epoch, generation) => {
      const row = (
        await tx.query(
          'SELECT receiver_epoch,receiver_generation::text,writer_version FROM core.agent_identity_work WHERE custody_id=$1 FOR SHARE',
          [mapping.custody_id],
        )
      ).rows[0];
      if (row?.receiver_epoch !== epoch || row.receiver_generation !== generation || row.writer_version !== 1)
        throw accountIdentityUnavailable('SDK receiver restore or writer fence changed');
      await lockApproval(tx, mapping.approval!, true);
      await guardHistoryAccounts(
        tx,
        0,
        agentIdentityAccounts(mapping.approval!.accountId, mapping.approval!.requester, mapping.approval!.decider),
      );
    });
  }
  const retired = await withConnection(
    pool,
    async (tx) =>
      (await tx.query('SELECT state FROM core.history_work WHERE partition_no=0 AND work_id=$1', [mapping.custody_id]))
        .rows[0],
  );
  if (!retired || retired.state === 'retired')
    throw accountIdentityUnavailable('SDK execution retired or custody absent');
}

/** Physical SDK cleanup resolves only a genuine immutable mapping. An unassociated initial
 * approval is still a copy obligation, and cannot unlock retirement or receiving closure. */
export async function resolveAgentIdentitySDKWork(
  tx: import('../command/command.ts').CommandTransaction,
  custodyId: string,
): Promise<{ workflowId: string; source: AgentIdentityWorkSource | null; gap: string | null } | null> {
  const row = (
    await tx.query<{
      workflow_id: string;
      source: AgentIdentityWorkSource | null;
      creation_captured: boolean;
      bound: boolean;
      receiver_epoch: number;
      receiver_generation: string;
      writer_version: number;
      source_key: string;
      accounts: AgentIdentityWorkSource['accounts'];
    }>(
      `SELECT m.workflow_id,m.source,m.source_key,CASE WHEN octet_length(m.accounts::text)<=8192 THEN m.accounts END AS accounts,m.creation_captured,m.receiver_epoch,m.receiver_generation::text,m.writer_version,
       w.request_digest=m.request_digest AND w.owner=$2 AS bound
     FROM core.agent_identity_work m LEFT JOIN core.history_work w ON w.partition_no=0 AND w.work_id=m.custody_id
     WHERE m.custody_id=$1 FOR SHARE OF m`,
      [custodyId, AGENT_IDENTITY_WORK_OWNER],
    )
  ).rows[0];
  if (!row) return null;
  const receiver = (await tx.query('SELECT epoch,write_state FROM core.partition WHERE partition_no=0 FOR SHARE'))
    .rows[0];
  const domain = (await tx.query('SELECT generation::text FROM core.history_family_domain WHERE singleton FOR SHARE'))
    .rows[0];
  return {
    workflowId: row.workflow_id,
    source: row.source,
    gap: !row.bound
      ? 'identity-sdk-native-binding-unavailable'
      : receiver?.write_state !== 'active' || receiver.epoch !== row.receiver_epoch
        ? 'identity-sdk-receiver-restore-fence-changed'
        : domain?.generation !== row.receiver_generation || row.writer_version !== 1
          ? 'identity-sdk-receiver-generation-or-writer-changed'
          : !row.creation_captured
            ? 'identity-sdk-legacy-creation-uncovered'
            : !row.source
              ? 'identity-sdk-source-association-pending'
              : row.source.workflowId !== row.workflow_id ||
                  row.source.key !== row.source_key ||
                  canonicalize(row.source.accounts) !== canonicalize(row.accounts)
                ? 'identity-sdk-source-native-binding-changed'
                : null,
  };
}
