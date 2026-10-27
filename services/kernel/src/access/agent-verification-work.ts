import { DBOS } from '@dbos-inc/dbos-sdk';
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
  readAgentVerificationWorkflowRequest,
  recordPendingAgentVerification,
  writeAgentVerificationPage,
  type AgentVerificationWorkflowRequest,
} from './agent-verification.ts';

const workflowName = 'accounts.agent-verification';
const approvalEvent = 'com.rezics.access.agent-verification.approved.v1';

type WorkResult = { ok: true } | { ok: false; problem: { type: string; detail: string } };

function problem(error: Error, type?: string): { type: string; detail: string } {
  return { type: type ?? error.name, detail: error.message.slice(0, 512) };
}

/** Register the durable, receipt-bound account-agent approval workflow and its outbox effect. */
export function registerAgentVerificationWork(context: WorkContext): void {
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
        if (error instanceof AccountAgentVerificationError) return { ok: false, problem: problem(error) };
        throw error;
      }
    },
    { name: 'accounts.agent-verification.merge', retriesAllowed: true, maxAttempts: 10 },
  );

  const writePage = DBOS.registerStep(
    async (request: AgentVerificationWorkflowRequest, receiptId: string): Promise<WorkResult> => {
      try {
        await writeAgentVerificationPage(context.pool, { ...request, receiptId });
        return { ok: true };
      } catch (error) {
        if (error instanceof AgentVerificationPageConflictError)
          return { ok: false, problem: problem(error, error.problemType) };
        throw error;
      }
    },
    { name: 'accounts.agent-verification.write-page', retriesAllowed: true, maxAttempts: 10 },
  );

  const complete = DBOS.registerStep(
    (request: AgentVerificationWorkflowRequest, receiptId: string) =>
      completeAgentVerification(context.pool, { ...request, receiptId }, context.clock),
    { name: 'accounts.agent-verification.complete', retriesAllowed: true, maxAttempts: 10 },
  );
  const clear = DBOS.registerStep(
    (request: AgentVerificationWorkflowRequest, receiptId: string) =>
      clearPendingAgentVerification(context.pool, { ...request, receiptId }, context.clock),
    { name: 'accounts.agent-verification.clear-pending', retriesAllowed: true, maxAttempts: 10 },
  );
  const finish = DBOS.registerStep(
    (request: AgentVerificationWorkflowRequest, receiptId: string) =>
      finishAgentVerification(context.pool, { ...request, receiptId }, context.clock),
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
      const request = await readDecision(requestId, receiptId);
      if (request.state === 'approved' || request.state === 'failed') return;

      const started = await startVerification(request, receiptId);
      if (!started.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, started.problem);
        return;
      }

      const merged = await merge(request, receiptId);
      if (!merged.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, merged.problem);
        return;
      }

      const page = await writePage(request, receiptId);
      if (!page.ok) {
        await clear(request, receiptId);
        await fail(request, receiptId, page.problem);
        return;
      }

      await complete(request, receiptId);
      await finish(request, receiptId);
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
