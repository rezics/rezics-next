import { Elysia, t } from 'elysia';
import { AdmissionConflict, AdmissionDenied, AdmissionUnavailable } from '../modules/access/admission.ts';
import { ManagedOrgStale } from '../modules/access/managed-org-authority.ts';
import { orgRosterPolicyBody } from '../modules/access/managed-org-schemas.ts';
import { ProposalDenied, ProposalPending, ProposalStale } from '../modules/proposal/graph.ts';
import { executeProposal } from '../modules/proposal/execute.ts';
import { pendingOperation, problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

const native = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const uuid = t.String({ format: 'uuid' });
const digest = t.String({ pattern: '^[0-9a-f]{64}$' });
const body = t.Object({ profile: t.Literal('proposal-execution-v1'),
  proposal: native, proposalRevision: native, poll: native, resolution: native,
  body: native, representationId: uuid, capabilityGrantId: uuid,
  effectDigest: digest, expectedTargetState: digest, effect: orgRosterPolicyBody,
}, { additionalProperties: false });
const result = t.Object({ profile: t.Literal('proposal-execution-v1'),
  proposal: native, proposalRevision: native, resolution: native, effectDigest: digest,
  target: native, policyRevision: t.String(), receipt: t.String(), replayed: t.Boolean() });

export const openApiOperations = {
  '/v1/proposals/executions': { post: { exposure: 'platform:institutional-voting', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;

export function proposalRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/proposals/executions', {
    body, response: { 200: result, 201: result, 202: pendingOperation,
      ...writeProblems, 404: problemResult(404) },
  }, async ({ request, body: input }) => {
    try {
      if (!work.proposalExecutions || !work.managedOrganizations) {
        return problem(503, 'proposal_execution_unavailable', 'Proposal execution is unavailable');
      }
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A bounded Idempotency-Key is required');
      }
      const executed = await executeProposal({ environment: work.environment, account: work.account,
        access: work.proposalExecutions, target: work.managedOrganizations }, request,
      { ...input, effect: input.effect }, key);
      return Response.json({ profile: 'proposal-execution-v1', ...executed },
        { status: executed.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof ProposalPending) return Response.json({ operationId: error.operationId,
        status: 'reconciling', phase: 'graph-outcome', result: null,
        retry: { allowed: true, afterMs: 1000 } }, { status: 202, headers: { 'cache-control': 'no-store' } });
      if (error instanceof ProposalStale || error instanceof ManagedOrgStale) {
        return problem(409, 'stale_proposal_basis', 'Approved proposal basis changed');
      }
      if (error instanceof ProposalDenied || error instanceof AdmissionDenied) {
        return problem(403, 'proposal_execution_denied', 'Proposal execution is outside current authority');
      }
      if (error instanceof AdmissionConflict) return problem(409, 'idempotency_conflict', error.message);
      if (error instanceof AdmissionUnavailable) return problem(503, 'proposal_execution_unavailable', error.message);
      return commandError(error);
    }
  });
}
