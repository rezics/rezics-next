import { Elysia, t } from 'elysia';
import { writeProblems } from '../api-responses.ts';
import { ensurePersonOnboarding } from '../modules/onboarding/ensure.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

export const openApiOperations = {
  '/v1/me/onboarding': { post: { bearer: true } },
} as const;
const result = t.Object({ profile: t.Literal('person-onboarding-v1'), agent: t.String(),
  state: t.Union([t.Literal('pending'), t.Literal('active'), t.Literal('compensating'),
    t.Literal('compensated')]), suggestedHandle: t.String(),
  sessionAgent: t.Nullable(t.String()), replayed: t.Boolean() });

export function onboardingRoutes(work: MainWorkDependencies) {
  return new Elysia().post('/v1/me/onboarding', {
    headers: t.Object({ 'x-session-key': t.String({ pattern:
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' }) }),
    body: t.Object({ profile: t.Literal('person-onboarding-v1') }, { additionalProperties: false }),
    response: { 200: result, 201: result, 202: result, ...writeProblems },
  }, async ({ request }) => {
    try {
      const state = await ensurePersonOnboarding(work, request,
        request.headers.get('x-session-key') ?? '');
      if (state.state === 'compensated') {
        return problem(409, 'person_onboarding_compensated', 'Person Agent could not be created');
      }
      return Response.json(state, { status: state.state !== 'active' ? 202
        : state.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return commandError(error); }
  });
}
