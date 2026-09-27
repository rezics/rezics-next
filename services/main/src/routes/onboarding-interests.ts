import { Elysia } from 'elysia';
import { ControlInvalid } from '../modules/access/topology-control.ts';
import { interestsQuery, interestsResult, suggestionsQuery, suggestionsResult }
  from '../modules/onboarding-interests/contract.ts';
import { readInterests, readSuggestedFollows } from '../modules/onboarding-interests/read.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/onboarding/interests': { get: { bearer: false } },
  '/v1/onboarding/suggested-follows': { get: { bearer: false } },
} as const;

export function onboardingInterestsRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/onboarding/interests', { query: interestsQuery,
    response: { 200: interestsResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try { return Response.json(await workRead(work, new Request(request.url), { language: query.locale },
      readInterests), { headers: homeHeaders }); }
    catch (error) { return homeError(error); }
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
