import { deliverAccountIdentity } from './agent-verification-identity.ts';
import { IdentityEpochStoreError } from '../semantic/identity-epoch-store.ts';
import { classifyUnavailability } from './unavailable.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Value } from 'typebox/value';
import { ACCESS_EVENTS } from './events.ts';
import { synchronizeAccountAgent } from './account-agent-effect.ts';
import type { WorkContext } from '../work/registry.ts';
import { AccountAgentVerificationError } from '../semantic/agents.ts';
import {
  AgentVerificationAccountError,
  AgentVerificationConflictError,
  AgentVerificationPageConflictError,
  clearPendingAgentVerification,
  completeAgentVerification,
  failAgentVerification,
  finishAgentVerification,
  mergeVerifiedAgent,
  unmergeVerifiedAgent,
  removeAgentVerificationPage,
  finishAgentVerificationReversal,
  type AgentVerificationReversal,
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
  type AgentVerificationWorkflowRequest,
} from './agent-verification.ts';

const workflowName = 'accounts.agent-verification';
const approvalEvent = 'com.rezics.access.agent-verification.approved.v1';

type WorkResult =
  | { ok: true }
  | { ok: false; pending: true; problem?: { type: string; detail: string } }
  | { ok: false; pending?: false; problem: { type: string; detail: string } };

function retryable(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (
    typeof code === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code)
  )
    return true;
  return (
    classifyUnavailability(error) !== undefined ||
    (error instanceof IdentityEpochStoreError &&
      [
        'identity_epoch_unavailable',
        'identity_epoch_busy',
        'identity_effect_stale',
        'identity_participants_incomplete',
      ].includes(error.code))
  );
}

/** Invoked by the workflow, never from inside a registered step or a held native checkout. */
async function redrive<T extends WorkResult>(attempt: () => Promise<T>): Promise<Exclude<T, { pending: true }>> {
  let backoff = 250;
  for (;;) {
    let result: T;
    try {
      result = await attempt();
    } catch (error) {
      if (!retryable(error)) throw error;
      await DBOS.sleep(backoff);
      backoff = Math.min(30_000, backoff * 2);
      continue;
    }
    if (result === undefined || !('pending' in result) || !result.pending)
      return result as Exclude<T, { pending: true }>;
    await DBOS.sleep(backoff);
    backoff = Math.min(30_000, backoff * 2);
  }
}

function problem(error: Error, type?: string): { type: string; detail: string } {
  return { type: type ?? error.name, detail: error.message.slice(0, 512) };
}

/** Keep the exact owner source report in bounded private workflow custody while retrying. */
function pending(error: unknown): WorkResult {
  return {
    ok: false,
    pending: true,
    problem: problem(
      error instanceof Error ? error : new Error(String(error)),
      error instanceof IdentityEpochStoreError ? error.code : undefined,
    ),
  };
}

/** Register the durable, receipt-bound account-agent approval workflow and its outbox effect. */
export function registerAgentVerificationWork(context: WorkContext): void {
  const reversalWorkflow = 'accounts.agent-verification-reversal';
  const publication = DBOS.registerStep(
    async (
      accountId: string,
      receiptId: string,
      direction: 'account-agent.verify' | 'account-agent.unverify',
    ): Promise<WorkResult> => {
      try {
        await deliverAccountIdentity(context.pool, { kind: direction, account: accountId, receipt: receiptId });
        return { ok: true };
      } catch (error) {
        if (retryable(error)) return pending(error);
        throw error;
      }
    },
    { name: 'accounts.agent-verification.publication', retriesAllowed: true, maxAttempts: 10 },
  );
  const unmerge = DBOS.registerStep(
    async (decision: AgentVerificationReversal): Promise<WorkResult> => {
      try {
        await unmergeVerifiedAgent(context.pool, decision);
        return { ok: true };
      } catch (error) {
        if (retryable(error)) return pending(error);
        throw error;
      }
    },
    { name: `${reversalWorkflow}.unmerge`, retriesAllowed: true, maxAttempts: 10 },
  );
  const removePage = DBOS.registerStep(
    async (decision: AgentVerificationReversal) => {
      await deliverAccountIdentity(context.pool, {
        kind: 'account-agent.unverify',
        account: decision.accountId,
        receipt: decision.receiptId,
      });
      return removeAgentVerificationPage(context.pool, decision);
    },
    { name: `${reversalWorkflow}.remove-page`, retriesAllowed: true, maxAttempts: 10 },
  );
  const finishReversal = DBOS.registerStep(
    async (decision: AgentVerificationReversal) => {
      await deliverAccountIdentity(context.pool, {
        kind: 'account-agent.unverify',
        account: decision.accountId,
        receipt: decision.receiptId,
      });
      return finishAgentVerificationReversal(context.pool, decision, context.clock);
    },
    { name: `${reversalWorkflow}.finish`, retriesAllowed: true, maxAttempts: 10 },
  );
  const synchronizeAgent = DBOS.registerStep(
    (decision: AgentVerificationReversal) => synchronizeAccountAgent(context.pool, decision.accountId),
    { name: `${reversalWorkflow}.synchronize-agent`, retriesAllowed: true, maxAttempts: 10 },
  );
  DBOS.registerWorkflow(
    async (decision: AgentVerificationReversal) => {
      await redrive(() => unmerge(decision));
      await redrive(async () => {
        await removePage(decision);
        return { ok: true as const };
      });
      await redrive(async () => {
        await finishReversal(decision);
        return { ok: true as const };
      });
      await redrive(async () => {
        await synchronizeAgent(decision);
        return { ok: true as const };
      });
      await redrive(() => publication(decision.accountId, decision.receiptId, 'account-agent.unverify'));
    },
    { name: reversalWorkflow },
  );
  context.addEffects([
    {
      name: 'agent_verification_reversal',
      types: ['com.rezics.access.agent-verification.reversing.v1'],
      async run(event) {
        if (!Value.Check(ACCESS_EVENTS['com.rezics.access.agent-verification.reversing.v1'], event.data))
          throw new TypeError('Invalid account agent verification reversal event');
        const decision = event.data as AgentVerificationReversal;
        await context.client.enqueue(
          {
            workflowName: reversalWorkflow,
            queueName: 'workflows',
            workflowID: `${reversalWorkflow}:${decision.accountId}:${decision.receiptId}`,
            workflowIDReusePolicy: 'return-existing',
          },
          decision,
        );
      },
    },
  ]);

  const readDecision = DBOS.registerStep(
    async (requestId: string, receiptId: string): Promise<AgentVerificationWorkflowRequest> => {
      const request = await readAgentVerificationWorkflowRequest(context.pool, requestId);
      if (!request || request.decisionReceiptId !== receiptId) throw new AgentVerificationConflictError();
      if (request.state !== 'approving' && request.state !== 'approved' && request.state !== 'failed')
        throw new AgentVerificationConflictError();
      return request;
    },
    { name: 'accounts.agent-verification.read-decision', retriesAllowed: true, maxAttempts: 10 },
  );

  const startVerification = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string): Promise<WorkResult> => {
      try {
        await recordPendingAgentVerification(context.pool, { ...request, receiptId }, context.clock);
        return { ok: true };
      } catch (error) {
        if (retryable(error)) return pending(error);
        if (error instanceof AgentVerificationAccountError)
          return { ok: false, problem: problem(error, error.problemType) };
        throw error;
      }
    },
    { name: 'accounts.agent-verification.record-pending', retriesAllowed: true, maxAttempts: 10 },
  );

  const merge = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string): Promise<WorkResult> => {
      try {
        await mergeVerifiedAgent(context.pool, { ...request, receiptId });
        return { ok: true };
      } catch (error) {
        if (retryable(error)) return pending(error);
        if (error instanceof AccountAgentVerificationError) return { ok: false, problem: problem(error) };
        throw error;
      }
    },
    { name: 'accounts.agent-verification.merge', retriesAllowed: true, maxAttempts: 10 },
  );

  const writePage = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string): Promise<WorkResult> => {
      try {
        // Same registered step/position also covers an original merge whose result was already journalled.
        await deliverAccountIdentity(context.pool, {
          kind: 'account-agent.verify',
          account: request.accountId,
          receipt: receiptId,
        });
        await writeAgentVerificationPage(context.pool, { ...request, receiptId });
        return { ok: true };
      } catch (error) {
        if (retryable(error)) return pending(error);
        if (error instanceof AgentVerificationPageConflictError)
          return { ok: false, problem: problem(error, error.problemType) };
        throw error;
      }
    },
    { name: 'accounts.agent-verification.write-page', retriesAllowed: true, maxAttempts: 10 },
  );

  const complete = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string) => {
      await deliverAccountIdentity(context.pool, {
        kind: 'account-agent.verify',
        account: request.accountId,
        receipt: receiptId,
      });
      return completeAgentVerification(context.pool, { ...request, receiptId }, context.clock);
    },
    { name: 'accounts.agent-verification.complete', retriesAllowed: true, maxAttempts: 10 },
  );
  const clear = DBOS.registerStep(
    (request: AgentVerificationWorkflowRequest, receiptId: string) =>
      clearPendingAgentVerification(context.pool, { ...request, receiptId }, context.clock),
    { name: 'accounts.agent-verification.clear-pending', retriesAllowed: true, maxAttempts: 10 },
  );
  const finish = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string) => {
      await deliverAccountIdentity(context.pool, {
        kind: 'account-agent.verify',
        account: request.accountId,
        receipt: receiptId,
      });
      return finishAgentVerification(context.pool, { ...request, receiptId }, context.clock);
    },
    { name: 'accounts.agent-verification.finish', retriesAllowed: true, maxAttempts: 10 },
  );
  const fail = DBOS.registerStep(
    (request: AgentVerificationWorkflowRequest, receiptId: string, failure: { type: string; detail: string }) =>
      failAgentVerification(context.pool, { ...request, receiptId, problem: failure }, context.clock),
    { name: 'accounts.agent-verification.fail', retriesAllowed: true, maxAttempts: 10 },
  );

  const enqueue = async (requestId: string, receiptId: string) => {
    await context.client.enqueue(
      {
        workflowName,
        queueName: 'workflows',
        workflowID: `${workflowName}:${requestId}:${receiptId}`,
        workflowIDReusePolicy: 'return-existing',
      },
      requestId,
      receiptId,
    );
  };

  DBOS.registerWorkflow(
    async (requestId: string, receiptId: string) => {
      const { request } = await redrive(async () => ({
        ok: true as const,
        request: await readDecision(requestId, receiptId),
      }));
      if (request.state === 'failed') return;

      const started = await redrive(() => startVerification(request, receiptId));
      if (!started.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, started.problem);
        return;
      }

      const merged = await redrive(() => merge(request, receiptId));
      if (!merged.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, merged.problem);
        return;
      }

      if (request.state === 'approved') {
        await redrive(() => publication(request.accountId, receiptId, 'account-agent.verify'));
        return;
      }

      const page = await redrive(() => writePage(request, receiptId));
      if (!page.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, page.problem);
        return;
      }

      await redrive(async () => {
        await complete(request, receiptId);
        return { ok: true as const };
      });
      await redrive(async () => {
        await finish(request, receiptId);
        return { ok: true as const };
      });
      await redrive(() => publication(request.accountId, receiptId, 'account-agent.verify'));
    },
    { name: workflowName },
  );

  context.addEffects([
    {
      name: 'agent_verification',
      types: [approvalEvent],
      async run(event) {
        const data = event.data as { requestId?: unknown; receiptId?: unknown };
        if (typeof data.requestId !== 'string' || typeof data.receiptId !== 'string')
          throw new TypeError('Invalid account agent verification approval event');
        await enqueue(data.requestId, data.receiptId);
      },
    },
  ]);
}
