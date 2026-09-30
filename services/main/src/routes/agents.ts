import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { writeProblems } from '../api-responses.ts';
import { AgentProvisionConflict, AgentProvisionDenied, AgentProvisionInvalid,
  AgentProvisionUnavailable } from '../modules/agent/provision.ts';
import { AgentProfileConflict, AgentProfileDenied, AgentProfileInvalid, AgentProfileStale,
  AgentProfileValidationFailed,
  AgentProfileUnavailable } from '../modules/agent/profile.ts';
import { VanityConflict, VanityCooldown, VanityDenied, VanityInvalid, VanityUnavailable,
  VANITY_HANDLE_PATTERN } from '../modules/agent/vanity.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/agents': { post: { bearer: true, idempotencyKey: true } },
  '/v1/agents/{id}/handle': { put: { bearer: true, idempotencyKey: true } },
  '/v1/agents/{id}/profile': { put: { bearer: true, idempotencyKey: true } },
  '/v1/handles/{handle}/availability': { get: { bearer: false } },
};

const bodySchema = t.Object({ profile: t.Literal('agent-provision-v1'),
  kind: t.Union([t.Literal('person'), t.Literal('organization'), t.Literal('service')]),
  displayName: t.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
const handleChangeBody = t.Object({ profile: t.Literal('agent-handle-v1'),
  handle: t.String({ minLength: 3, maxLength: 30, pattern: '^[A-Za-z0-9_]{3,30}$' }),
  expectedHandle: t.Nullable(t.String({ pattern: VANITY_HANDLE_PATTERN })) },
{ additionalProperties: false });
const handleChangeResult = t.Object({ profile: t.Literal('agent-handle-v1'),
  agent: t.String(), handle: t.String(), previousHandle: t.Nullable(t.String()),
  changedAt: t.String(), replayed: t.Boolean() });
const availabilityResult = t.Object({ profile: t.Literal('agent-handle-availability-v1'),
  handle: t.String(), available: t.Boolean(), reason: t.Union([t.Literal('available'),
    t.Literal('invalid'), t.Literal('reserved'), t.Literal('claimed'), t.Literal('retained'),
    t.Literal('confusable')]) });
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
    .put('/v1/agents/:id/handle', {
      params: t.Object({ id: t.String({ pattern:
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }),
      body: handleChangeBody,
      response: { 200: handleChangeResult, 201: handleChangeResult, ...writeProblems },
    }, async ({ request, params, body }) => {
      try {
        if (!work.agentHandles) return problem(503, 'agent_handle_unavailable', 'Agent handles are unavailable');
        const principal = await work.account.verify(request, ['agent:create']);
        const result = await work.agentHandles.change(principal,
          `https://rezics.com/id/${params.id}`, body.handle, body.expectedHandle,
          request.headers.get('idempotency-key') ?? '');
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof VanityInvalid) return problem(400, 'invalid_agent_handle', error.message);
        if (error instanceof VanityDenied) return problem(403, 'agent_handle_denied', error.message);
        if (error instanceof VanityCooldown) return problem(409, 'agent_handle_cooldown',
          `Handle can change after ${error.availableAt}`);
        if (error instanceof VanityConflict) return problem(409, 'agent_handle_conflict', error.message);
        if (error instanceof VanityUnavailable) return problem(503, 'agent_handle_unavailable', error.message);
        return commandError(error);
      }
    })
    .get('/v1/handles/:handle/availability', {
      params: t.Object({ handle: t.String({ minLength: 1, maxLength: 64 }) }),
      response: { 200: availabilityResult, ...writeProblems },
    }, async ({ params }) => {
      try {
        if (!work.agentHandles) return problem(503, 'agent_handle_unavailable', 'Agent handles are unavailable');
        return Response.json(await work.agentHandles.availability(params.handle),
          { headers: { 'cache-control': 'no-store' } });
      } catch (error) { return commandError(error); }
    });
}
