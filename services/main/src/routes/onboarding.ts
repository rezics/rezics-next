import { Elysia, t } from 'elysia';
import { writeProblems } from '../api-responses.ts';
import { problemResult } from '../api-contract.ts';
import { ensurePersonOnboarding, PublicNameRequired } from '../modules/onboarding/ensure.ts';
import { AgentProvisionConflict, AgentProvisionDenied, AgentProvisionInvalid,
  AgentProvisionUnavailable } from '../modules/agent/provision.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/me/onboarding': { post: { exposure: 'public', bearer: true } },
} as const;
const result = t.Object({ profile: t.Literal('person-onboarding-v1'), agent: t.String(),
  state: t.Union([t.Literal('pending'), t.Literal('active'), t.Literal('compensating'),
    t.Literal('compensated')]), suggestedHandle: t.String(),
  sessionAgent: t.Nullable(t.String()), replayed: t.Boolean() });

export function onboardingRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/me/onboarding', {
    headers: t.Object({ 'x-session-key': t.String({ pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }),
    body: t.Object({ profile: t.Literal('person-onboarding-v1'),
      displayName: t.Optional(t.String({ minLength: 1, maxLength: 200,
        pattern: '^[^\\u0000-\\u001f\\u007f]+$' })) }, { additionalProperties: false }),
    response: { 200: result, 201: result, 202: result, ...writeProblems,
      409: t.Object({ ...problemResult(409).properties, code: t.Union([
        t.Literal('public_name_required'), t.Literal('person_onboarding_compensated'),
        t.Literal('idempotency_conflict'), t.Literal('stale_context'),
      ]) }) },
  }, async ({ request, body }) => {
    try {
      const state = await ensurePersonOnboarding(work, request,
        request.headers.get('x-session-key') ?? '', body.displayName);
      if (state.state === 'compensated') {
        return problem(409, 'person_onboarding_compensated', 'Person Agent could not be created');
      }
      return Response.json(state, { status: state.state !== 'active' ? 202
        : state.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (error instanceof PublicNameRequired) return problem(409, error.code, error.message);
      if (error instanceof AgentProvisionInvalid) return problem(400, 'invalid_public_name', error.message);
      if (error instanceof AgentProvisionDenied) return problem(403, 'agent_provision_denied', 'Agent provision is denied');
      if (error instanceof AgentProvisionConflict) return problem(409, 'idempotency_conflict', 'Agent provision intent conflicts');
      if (error instanceof AgentProvisionUnavailable) return problem(503, 'agent_provision_unavailable', 'Agent provision owner is unavailable');
      return commandError(error);
    }
  });
}
