import { Elysia } from 'elysia';
import { ControlInvalid } from '../modules/access/topology-control.ts';
import { readChoices } from '../modules/onboarding/choices.ts';
import { choicesQuery, onboardingChoices, suggestionsQuery, suggestionsResult } from '../modules/onboarding/contract.ts';
import { readSuggestedFollows } from '../modules/onboarding/suggestions.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/onboarding/choices': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/onboarding/suggested-follows': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
} as const;

/**
 * A new reader's first minute: languages and Concepts to choose, then Realms
 * to follow for them. Registered in app.ts under this module's former name,
 * `onboardingInterestsRoutes`; the composition root keeps its lines.
 */
export function onboardingInterestsRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/onboarding/choices', { query: choicesQuery,
    response: { 200: onboardingChoices, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      return Response.json(await workRead(work, new Request(request.url), { language: query.locale }, readChoices),
        { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).get('/v1/onboarding/suggested-follows', { query: suggestionsQuery,
    response: { 200: suggestionsResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      const principal = request.headers.has('authorization') ? await work.account.verify(request, ['follow:read']) : null;
      if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
      return Response.json(await workRead(work, new Request(request.url), { language: query.locale },
        session => readSuggestedFollows(session, query,
          principal ? { principal, agent: query.actingSubject! } : undefined)), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  });
}
