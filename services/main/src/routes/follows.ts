import { Elysia, t } from 'elysia';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable } from '../modules/access/topology-control.ts';
import { batchFollowCommand, batchFollowResult, followCommand, followKind, followResult,
  followsPage, followsQuery, followState } from '../modules/follows/contract.ts';
import { readFollows, readFollowTarget } from '../modules/follows/read.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const homeHeaders = { 'cache-control': 'private, no-store' };
export function homeError(error: unknown) {
  const result = error instanceof ControlDenied ? problem(403, 'home_denied', error.message)
    : error instanceof ControlInvalid ? problem(400, 'invalid_home_command', error.message)
    : error instanceof ControlConflict || error instanceof ControlStale ? problem(409, 'home_conflict', error.message)
    : error instanceof ControlUnavailable ? problem(503, 'home_unavailable', error.message) : workReadError(error);
  result.headers.set('cache-control', homeHeaders['cache-control']);
  return result;
}
export const openApiOperations = {
  '/v1/me/follows': { get: { bearer: true } },
  '/v1/follows': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/follows/batch': { post: { bearer: true, idempotencyKey: true } },
  '/v1/follows/{id}': { get: { bearer: false } },
} as const;

export function followsRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/me/follows', { query: followsQuery, response: { 200: followsPage, ...workReadProblems } },
      async ({ request, query }) => {
        try {
          if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
          const principal = await work.account.verify(request, ['follow:read']);
          return Response.json(await workRead(work, new Request(request.url), { ...query, actingSubject: undefined },
            session => readFollows(session, work.follows!, principal, query.actingSubject, query.kind,
              query.include === 'newSince')), { headers: homeHeaders });
        } catch (error) { return homeError(error); }
      })
    .get('/v1/follows/:id', { params: t.Object({ id: readUuid }),
      query: t.Object({ kind: followKind, language: t.Optional(readLanguage), actingSubject: t.Optional(readId) },
        { additionalProperties: false }), detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: followState, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
        const principal = request.headers.has('authorization') ? await work.account.verify(request, ['follow:read']) : null;
        if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
        return Response.json(await workRead(work, new Request(request.url), { language: query.language }, async session => {
          const target = await readFollowTarget(session, `https://rezics.com/id/${params.id}`, query.kind);
          const state = await work.follows!.state(target.id, principal ? { principal, agent: query.actingSubject! } : undefined);
          await readFollowTarget(session, target.id, query.kind);
          return { profile: 'follow-state-v1' as const, target, ...state };
        }), { headers: homeHeaders });
      } catch (error) { return homeError(error); }
    })
    .post('/v1/follows', { body: followCommand, response: { 200: followResult, ...workReadProblems } },
      async ({ request, body }) => {
        try {
          if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
          const principal = await work.account.verify(request, ['follow:write']);
          const result = await work.follows.set(principal, body, request.headers.get('idempotency-key') ?? '',
            () => workRead(work, new Request(request.url), {}, async session => {
              await readFollowTarget(session, body.target, body.kind);
            }));
          return Response.json(result, { headers: homeHeaders });
        } catch (error) { return homeError(error); }
      })
    .post('/v1/me/follows/batch', { body: batchFollowCommand,
      response: { 200: batchFollowResult, ...workReadProblems },
    }, async ({ request, body }) => {
      try {
        if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
        const principal = await work.account.verify(request, ['follow:write']);
        return Response.json(await work.follows.batch(principal, body,
          request.headers.get('idempotency-key') ?? '', (target, kind) => workRead(work,
            new Request(request.url), {}, async session => { await readFollowTarget(session, target, kind); })),
        { headers: homeHeaders });
      } catch (error) { return homeError(error); }
    });
}
