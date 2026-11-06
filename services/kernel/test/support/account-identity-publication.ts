import type { Pool } from 'pg';
import { deliverAccountIdentity } from '../../src/access/agent-verification-identity.ts';
import type { AgentVerificationReversal } from '../../src/access/agent-verification.ts';
import { classifyUnavailability } from '../../src/access/unavailable.ts';
import {
  enqueueAgentIdentityReversal,
  enqueueAgentIdentityVerification,
} from '../../src/history/application/index.ts';
import { IdentityEpochStoreError } from '../../src/semantic/identity-adapters/index.ts';
import type { WorkClient } from '../../src/work/client.ts';

export type AccountIdentityPublicationReceipt = {
  kind: 'account-agent.verify' | 'account-agent.unverify';
  account: string;
  receipt: string;
};

const RETRYABLE_STORE_CODES = new Set([
  'identity_epoch_unavailable',
  'identity_epoch_busy',
  'identity_effect_stale',
  'identity_participants_incomplete',
]);

function retryable(error: unknown): boolean {
  if (error instanceof IdentityEpochStoreError) return RETRYABLE_STORE_CODES.has(error.code);
  return classifyUnavailability(error) !== undefined;
}

function verificationWorkflowId(requestId: string, receiptId: string): string {
  return `accounts.agent-verification:${requestId}:${receiptId}`;
}

function reversalWorkflowId(decision: AgentVerificationReversal): string {
  return `accounts.agent-verification-reversal:${decision.accountId}:${decision.receiptId}`;
}

/** The durable workflow runs each success stage only after one bounded publication delivery, and redrives retryable
 * unavailability with a sleep. Direct test calls mirror that order and redrive the same way; a publication that
 * never completes fails with its actual unavailability after the timeout.
 */
export async function publishAccountIdentity(
  pool: Pool,
  receipt: AccountIdentityPublicationReceipt,
  timeoutMs = 120_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await deliverAccountIdentity(pool, receipt);
      return;
    } catch (error) {
      if (Date.now() >= until || !retryable(error)) throw error;
    }
    await Bun.sleep(250);
  }
}

async function waitForWorkflow(client: WorkClient, workflowId: string): Promise<void> {
  await client.retrieveWorkflow(workflowId).getResult({ pollingIntervalMs: 50 });
}

async function admitOrJoin(
  client: WorkClient,
  workflowId: string,
  enqueue: () => Promise<'admitted' | 'retired'>,
): Promise<void> {
  // A launched identity executor may already have admitted this workflow from the approval/reversal effect.
  // A second enqueue with a fresh custody UUID is not a retry of that admission.
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await client.getWorkflow(workflowId)) {
      await waitForWorkflow(client, workflowId);
      return;
    }
    await Bun.sleep(50);
  }
  const admitted = await enqueue();
  if (admitted !== 'admitted' && admitted !== 'retired') throw new Error(`identity SDK admission was ${admitted}`);
  await waitForWorkflow(client, workflowId);
}

/** Approval's production cut: join the live identity executor's SDK workflow (record-pending, associate, merge,
 * page write, completion and original publication). Enqueue only when the approval effect has not yet admitted it.
 */
export async function runAccountIdentityVerification(
  pool: Pool,
  client: WorkClient,
  requestId: string,
  receiptId: string,
): Promise<void> {
  await admitOrJoin(client, verificationWorkflowId(requestId, receiptId), () =>
    enqueueAgentIdentityVerification(pool, client, requestId, receiptId),
  );
}

/** Reversal's production cut: join the live executor, or enqueue onto the existing Source when the effect has not. */
export async function runAccountIdentityReversal(
  pool: Pool,
  client: WorkClient,
  decision: AgentVerificationReversal,
): Promise<void> {
  await admitOrJoin(client, reversalWorkflowId(decision), () =>
    enqueueAgentIdentityReversal(pool, client, decision),
  );
}
