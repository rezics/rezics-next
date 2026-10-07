import { Elysia, t } from 'elysia';
import { CONTINUE_COST, continueQuery, continueResult, hiddenCommand, hiddenResult,
  workResumeQuery, workResumeResult, WORK_RESUME_COST }
  from '../modules/continue/contract.ts';
import { readContinue, readWorkResume } from '../modules/continue/read.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/me/continue/{work}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/me/continue': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/me/continue/{work}/hidden': { put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;

export function continueRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/me/continue', { query: continueQuery,
    response: { 200: continueResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      const principal = await work.account.verify(request, ['work:read', 'follow:read']);
      const result = await workRead(work, request, { actingSubject: query.actingSubject },
        session => readContinue(session, principal, query.actingSubject, query.limit));
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > CONTINUE_COST.responseBytes) throw new WorkReadLimit('Continue response too large');
      return new Response(body, { headers: { ...homeHeaders, 'content-type': 'application/json' } });
    } catch (error) { return homeError(error); }
  }).get('/v1/me/continue/:work', { params: t.Object({ work: readUuid }),
    query: workResumeQuery, response: { 200: workResumeResult, ...workReadProblems },
  }, async ({ request, params, query }) => {
    try {
      const principal = await work.account.verify(request, ['work:read']);
      const result = await workRead(work, request, query,
        session => readWorkResume(session, principal, query.actingSubject,
          `https://rezics.com/id/${params.work}`));
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > WORK_RESUME_COST.responseBytes) throw new WorkReadLimit('Resume response too large');
      return new Response(body, { headers: { ...homeHeaders, 'content-type': 'application/json' } });
    } catch (error) { return homeError(error); }
  }).put('/v1/me/continue/:work/hidden', { params: t.Object({ work: readUuid }),
    body: hiddenCommand, response: { 200: hiddenResult, ...workReadProblems },
  }, async ({ request, params, body }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Continue is unavailable');
      const principal = await work.account.verify(request, ['follow:write']);
      return Response.json(await work.homePersonal.exclusion(principal,
        { actingSubject: body.actingSubject, kind: 'continue',
          target: `https://rezics.com/id/${params.work}`, strength: body.hidden ? 'hide' : 'clear' },
        request.headers.get('idempotency-key') ?? ''), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  });
}
