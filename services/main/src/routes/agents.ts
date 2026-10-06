import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { AgentProvisionConflict, AgentProvisionDenied, AgentProvisionInvalid,
  AgentProvisionUnavailable } from '../modules/agent/provision.ts';
import { AgentProfileConflict, AgentProfileDenied, AgentProfileInvalid, AgentProfileStale,
  AgentProfileValidationFailed,
  AgentProfileUnavailable } from '../modules/agent/profile.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/agents': { post: { exposure: 'public', bearer: true, idempotencyKey: true } },
  '/v1/agents/{id}/profile': { put: { exposure: 'public', bearer: true, idempotencyKey: true } },
} as const;

const bodySchema = t.Object({ profile: t.Literal('agent-provision-v1'),
  kind: t.Union([t.Literal('person'), t.Literal('organization'), t.Literal('service')]),
  displayName: t.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const profileChangeFields = {
  expectedHead: t.String(), displayName: t.String({ minLength: 1, maxLength: 200 }),
  avatarSelection: t.Nullable(t.String()), bio: t.Nullable(t.Object({
    text: t.String({ minLength: 1, maxLength: 500 }), language: t.String({ minLength: 2, maxLength: 35 }),
  }, { additionalProperties: false })) };
const localizedName = t.Object({ original: t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' }),
  labels: t.Record(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$' }),
    t.String({ minLength: 1, maxLength: 200 })) }, { additionalProperties: false });
const profileChangeBody = t.Union([
  t.Object({ profile: t.Literal('agent-public-profile-v1'), ...profileChangeFields }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('agent-public-profile-v2'), ...profileChangeFields,
    localizedName }, { additionalProperties: false }),
]);
const profileChangeResult = t.Object({ profile: t.Union([
  t.Literal('agent-public-profile-v1'), t.Literal('agent-public-profile-v2')]),
  agent: t.String(), revision: t.String(), receipt: t.String(), replayed: t.Boolean(),
  sourcePosition: t.Object({ dataEpoch: t.String(), sequence: t.String() }) });
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
      if ((request.headers.get('idempotency-key') ?? '').startsWith('system:')) {
        return problem(400, 'invalid_idempotency_key', 'Reserved idempotency key');
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
  })
    .put('/v1/agents/:id/profile', {
      params: t.Object({ id: t.String({ pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }),
      body: profileChangeBody,
      response: { 200: profileChangeResult, 201: profileChangeResult, ...writeProblems,
        422: problemResult(422) },
    }, async ({ request, params, body }) => {
      try {
        if (!work.agentProfiles) return problem(503, 'agent_profile_unavailable', 'Agent profiles are unavailable');
        const principal = await work.account.verify(request, ['agent:create']);
        const result = await work.agentProfiles.change(principal, {
          agent: `https://rezics.com/id/${params.id}`, expectedHead: body.expectedHead,
          displayName: body.displayName, avatarSelection: body.avatarSelection,
          bio: body.bio, idempotencyKey: request.headers.get('idempotency-key') ?? '',
          ...(body.profile === 'agent-public-profile-v2' ? { localizedName: body.localizedName } : {}),
        });
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof AgentProfileInvalid) return problem(400, 'invalid_agent_profile', error.message);
        if (error instanceof AgentProfileDenied) return problem(403, 'agent_profile_denied', error.message);
        if (error instanceof AgentProfileStale) return Response.json({
          type: 'https://rezics.com/problems/stale_agent_profile', title: error.message,
          status: 409, code: 'stale_agent_profile', currentHead: error.currentHead,
        }, { status: 409, headers: { 'content-type': 'application/problem+json',
          'cache-control': 'no-store' } });
        if (error instanceof AgentProfileConflict) return problem(409, 'agent_profile_conflict', error.message);
        if (error instanceof AgentProfileValidationFailed) return problem(422,
          'agent_profile_validation_failed', error.message);
        if (error instanceof AgentProfileUnavailable) return problem(503, 'agent_profile_unavailable', error.message);
        return commandError(error);
      }
    })
;
}
