import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { AgentProvisionConflict, AgentProvisionDenied, AgentProvisionInvalid,
  AgentProvisionUnavailable } from '../modules/agent/provision.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/agents': { post: { bearer: true, idempotencyKey: true } },
};

const bodySchema = t.Object({ profile: t.Literal('agent-provision-v1'),
  kind: t.Union([t.Literal('person'), t.Literal('organization'), t.Literal('service')]),
  displayName: t.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const resultSchema = t.Object({ profile: t.Literal('agent-provision-v1'),
  operationId: t.String(), agent: t.String(),
  state: t.Union([t.Literal('pending'), t.Literal('active'),
    t.Literal('compensating'), t.Literal('compensated')]),
  replayed: t.Boolean(), sourcePosition: t.Nullable(t.Object({
    dataEpoch: t.String(), sequence: t.String() })),
});

function agentError(error: unknown): Response {
  if (error instanceof AgentProvisionInvalid) {
    return problem(400, 'invalid_agent_provision', 'Agent provision input is invalid');
  }
  if (error instanceof AgentProvisionDenied) {
    return problem(403, 'agent_provision_denied', 'Agent provision is denied');
  }
  if (error instanceof AgentProvisionConflict) {
    return problem(409, 'idempotency_conflict', 'Idempotency key binds another Agent intent');
  }
  if (error instanceof AgentProvisionUnavailable) {
    return problem(503, 'agent_provision_unavailable', 'Agent provision owner is unavailable');
  }
  return commandError(error);
}

export function agentRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/agents', {
    body: bodySchema,
    response: { 200: resultSchema, 201: resultSchema, 202: resultSchema,
      ...writeProblems, 422: problemResult(422) },
  }, async ({ request, body }) => {
    try {
      if (!work.agentProvisioning) {
        return problem(503, 'agent_provision_unavailable', 'Agent provision owner is unavailable');
      }
      const result = await work.agentProvisioning.provision(work.account, request, body,
        request.headers.get('idempotency-key') ?? '');
      const status = result.state === 'active' ? (result.replayed ? 200 : 201)
        : result.state === 'compensated' ? 409 : 202;
      if (status === 409) {
        return problem(409, 'agent_provision_compensated', 'Agent provision was compensated');
      }
      return Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return agentError(error); }
  });
}
