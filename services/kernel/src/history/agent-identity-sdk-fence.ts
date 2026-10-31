import canonicalize from 'canonicalize';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import type { Pool } from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { WORK_APPLICATION, type WorkClient } from '../work/client.ts';
import type { AgentIdentityWorkSource } from './agent-identity-source.ts';
import type { AgentIdentityRetirementStage } from './agent-identity-retirement.ts';
import { encodeLocator } from './locator.ts';
import { historyDeadline, lockHistoryBarrier, type HistoryReceivingContext } from './receiving.ts';
import type { HistoryArtifact, HistoryBarrier } from './registry.ts';

/** Consumer binding vocabulary, not an SDK capability declaration. The producer has not
 * supplied a supported native API or durable receipt literal in the installed SDK. */
export const AGENT_IDENTITY_SDK_FENCE_CONSUMER = Object.freeze({
  binding: 'access.agent-identity.sdk-retirement/v1',
  nativeAPI: null,
  nativeReceipt: null,
  gap: 'identity-sdk-permanent-late-writer-fence-unavailable',
} as const);

/** Exact first-consumer request binding. This is portable metadata, never cleanup proof.
 * A native receipt must bind this whole value plus the verified source generation and
 * durable Semantic terminal/technical-undo transfer locator. Neither is inferred here. */
export type AgentIdentitySDKReceivingBinding = Readonly<{
  kind: typeof AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding;
  custodyId: string;
  workflowId: string;
  requestDigest: string;
  source: AgentIdentityWorkSource;
  receiver: Readonly<{ partition: 0; epoch: number; generation: string; writerVersion: 1 }>;
  barrier: HistoryBarrier;
}>;
type Pending = Readonly<{ state: 'pending'; gap: string }>;
export type AgentIdentitySDKReceivingObservation =
  | Pending
  | Readonly<{ state: 'observed'; binding: AgentIdentitySDKReceivingBinding }>;

const pending = (gap: string): Pending => ({ state: 'pending', gap });
const same = (a: unknown, b: unknown) => canonicalize(a) === canonicalize(b);

/** Receiver-local locks only. The caller releases its source checkout before entering.
 * Native UUID mapping, original SDK creation, restore/writer generation, physical roles
 * and the independent erasure barrier must agree before even describing the request. */
export async function readAgentIdentitySDKReceivingBinding(
  tx: CommandTransaction,
  artifact: HistoryArtifact,
  barrier: HistoryBarrier,
): Promise<AgentIdentitySDKReceivingObservation> {
  if (currentCommand(tx).partition !== 0 || currentCommand(tx).basis !== null)
    throw new TypeError('Identity SDK fence requires its SAME receiving home');
  if (artifact.partition !== 0 || artifact.locator.artifactType !== 'durable-work/v1')
    return pending('identity-sdk-receiving-home-mismatch');
  const { resolveAgentIdentitySDKWork } = await import('./agent-identity-work.ts');
  const mapping = await resolveAgentIdentitySDKWork(tx, artifact.locator.workId);
  if (!mapping || mapping.gap) return pending(mapping?.gap ?? 'identity-sdk-native-binding-unavailable');
  const row = (
    await tx.query<{
      source: AgentIdentityWorkSource | null;
      accounts: HistoryArtifact['accounts'];
      request_digest: Buffer;
      receiver_epoch: number;
      receiver_generation: string;
    }>(
      `SELECT m.source,m.accounts,m.request_digest,m.receiver_epoch,m.receiver_generation::text
       FROM core.agent_identity_work m JOIN core.history_work w
         ON w.partition_no=0 AND w.work_id=m.custody_id AND w.owner='access.agent-identity'
         AND w.request_digest=m.request_digest
       WHERE m.custody_id=$1 FOR SHARE OF m,w`,
      [artifact.locator.workId],
    )
  ).rows[0];
  const roles = (
    await tx.query(
      `SELECT account_route,account_id,roles,minimizer_version FROM core.history_locator
       WHERE partition_no=0 AND artifact_type='durable-work/v1' AND locator=$1
       ORDER BY account_route,account_id LIMIT 65 FOR SHARE`,
      [Buffer.from(encodeLocator(artifact.locator))],
    )
  ).rows;
  const accounts = roles.map((entry) => ({
    accountRoute: entry.account_route,
    accountId: entry.account_id,
    roles: entry.roles,
  }));
  if (
    !row?.source ||
    !roles.length ||
    roles.length > 64 ||
    roles.some((entry) => entry.minimizer_version !== 1) ||
    !same(row.accounts, accounts) ||
    !same(artifact.accounts, accounts) ||
    !accounts.some((entry) => entry.accountId === barrier.accountId && entry.accountRoute === barrier.accountRoute)
  )
    return pending('identity-sdk-retirement-role-scope-changed');
  if (!(await lockHistoryBarrier(tx, barrier))) return pending('identity-sdk-retirement-barrier-changed');
  return {
    state: 'observed',
    binding: {
      kind: AGENT_IDENTITY_SDK_FENCE_CONSUMER.binding,
      custodyId: artifact.locator.workId,
      workflowId: mapping.workflowId,
      requestDigest: row.request_digest.toString('hex'),
      source: row.source,
      receiver: { partition: 0, epoch: row.receiver_epoch, generation: row.receiver_generation, writerVersion: 1 },
      barrier: { ...barrier },
    },
  };
}

/** This is the Kernel consumer entry point on the configured, genuine WorkClient.
 * Source verification happens first and releases its checkout before the receiver command.
 * No optional method name, local SDK SQL, status or cancellation substitutes for the missing
 * producer API. Until its literal and durable receipt exist this port cannot retire anything. */
export async function retireAgentIdentitySDKWork(
  pool: Pool,
  client: WorkClient,
  stage: AgentIdentityRetirementStage,
  context: HistoryReceivingContext,
): Promise<Pending> {
  const fixed: AgentIdentityRetirementStage = {
    reference: structuredClone(stage.reference),
    handoff: structuredClone(stage.handoff),
    consumer: stage.consumer,
  };
  historyDeadline(context, fixed.reference.source.partition);
  const { verifyAgentIdentityRetirementStage } = await import('./agent-identity-retirement.ts');
  const source = (
    await runCommand(pool, { partition: fixed.reference.source.partition, deadline: context.deadline }, async (tx) =>
      noEffect(await verifyAgentIdentityRetirementStage(tx, fixed)),
    )
  ).value;
  if (source.state === 'pending') return source;
  historyDeadline(context, 0);
  const receiver = (
    await runCommand(pool, { partition: 0, deadline: context.deadline }, async (tx) =>
      noEffect(
        await readAgentIdentitySDKReceivingBinding(
          tx,
          {
            partition: 0,
            locator: { artifactType: 'durable-work/v1', workId: fixed.handoff.custodyId },
            accounts: fixed.handoff.source.accounts,
          },
          fixed.reference.barrier,
        ),
      ),
    )
  ).value;
  if (receiver.state === 'pending') return receiver;
  if (
    source.custodyId !== receiver.binding.custodyId ||
    source.workflowId !== receiver.binding.workflowId ||
    !same(receiver.binding.source, fixed.handoff.source)
  )
    return pending('identity-sdk-retirement-source-fence-changed');
  if (!(client instanceof DBOSClient) || client.applicationName !== WORK_APPLICATION)
    return pending('identity-sdk-native-client-unavailable');
  historyDeadline(context, 0);
  return pending(AGENT_IDENTITY_SDK_FENCE_CONSUMER.gap);
}
