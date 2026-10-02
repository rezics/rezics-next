import { resolveTargets } from '../modules/target/resolve.ts';
import { Elysia, t } from 'elysia';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, ControlUnavailable } from '../modules/access/topology-control.ts';
import { batchFollowCommand, batchFollowResult, followCommand, followKind, followTargetId, followedAuthorsPage, followedAuthorsQuery,
  followResult, followsPage, followsQuery, followState, type FollowKind } from '../modules/follows/contract.ts';
import { readFollowedAuthors, readFollows, readFollowTarget } from '../modules/follows/read.ts';
import { resolveFollowIdentity } from '../modules/follows/targets.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadMissing, WorkReadUnavailable } from '../modules/work/read-session.ts';
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
  '/v1/me/follows/authors': { get: { bearer: true } },
  '/v1/me/follow-state': { get: { bearer: true } },
  '/v1/authors/open-library/{author}/follow': { get: { bearer: false } },
} as const;

const stateQuery = { language: t.Optional(readLanguage), actingSubject: t.Optional(readId) };

export function followsRoutes(work: MainWorkDependencies) {
  const describe = (request: Request, principal: import('../modules/access/admission.ts').VerifiedPrincipal, agent: string) =>
    (target: string, hint?: string) => workRead(work,new Request(request.url),{},async session => {
      const identity = await resolveFollowIdentity(session,target);
      if (identity.kind === 'work') identity.target = (await resolveTargets(session,[identity.target],'discussion'))[0]!.resource;
      const described = await readFollowTarget(session,identity.target,identity.kind,undefined,{ principal,agent });
      identity.nameKey = described.name.value.normalize('NFKC').toLowerCase();
      if (hint && hint!==identity.kind && !(identity.kind==='space' && ['realm','zone'].includes(hint))) throw new WorkReadMissing('Follow target is unavailable for this kind');
      return identity;
    });
  /** Followers of a target, and with a bearer whether the reader follows it. Only the count is public. */
  const state = async (request: Request, target: string, kind: FollowKind,
    query: { language?: string; actingSubject?: string }) => {
    try {
      if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
      const principal = request.headers.has('authorization') ? await work.account.verify(request, ['follow:read']) : null;
      if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
      return Response.json(await workRead(work, new Request(request.url), { language: query.language }, async session => {
        const identity = await resolveFollowIdentity(session,target);
        const canonical = identity.kind === 'work' ? (await resolveTargets(session,[identity.target],'discussion'))[0]!.resource : identity.target;
        const reader = principal ? { principal,agent: query.actingSubject! } : undefined;
        const described = await readFollowTarget(session, canonical, identity.kind,undefined,reader);
        if (kind!==identity.kind && !(identity.kind==='space' && ['realm','zone'].includes(kind))) throw new ControlInvalid('Follow kind does not match target');
        const current = await work.follows!.state(described.id, principal ? { principal, agent: query.actingSubject! } : undefined);
        await readFollowTarget(session, described.id, identity.kind,undefined,reader);
        return { profile: 'follow-state-v1' as const, target: described, ...current };
      }), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  };
  return new Elysia()
    .get('/v1/me/follows', { query: followsQuery, response: { 200: followsPage, ...workReadProblems } },
      async ({ request, query }) => {
        try {
          if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
          const principal = await work.account.verify(request, ['follow:read']);
          return Response.json(await workRead(work, new Request(request.url), { ...query, actingSubject: undefined, movingGraph: true },
            session => readFollows(session, work.follows!, principal, query.actingSubject, query.kind,
              query.include === 'newSince', query)), { headers: homeHeaders });
        } catch (error) { return homeError(error); }
      })
    .get('/v1/me/follows/authors', { query: followedAuthorsQuery,
      response: { 200: followedAuthorsPage, ...workReadProblems } },
    async ({ request, query }) => {
      try {
        if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
        const principal = await work.account.verify(request, ['follow:read']);
        return Response.json(await workRead(work, new Request(request.url), { ...query, actingSubject: undefined },
          session => readFollowedAuthors(session, work.follows!, principal, query.actingSubject)), { headers: homeHeaders });
      } catch (error) { return homeError(error); }
    })
    .get('/v1/follows/:id', { params: t.Object({ id: readUuid }),
      query: t.Object({ kind: followKind,
        ...stateQuery }, { additionalProperties: false }), detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: followState, ...workReadProblems },
    }, ({ request, params, query }) => state(request, `https://rezics.com/id/${params.id}`, query.kind, query))
    .get('/v1/me/follow-state', { query: t.Object({ target: followTargetId, kind: followKind,
      language: t.Optional(readLanguage), actingSubject: readId }, { additionalProperties: false }),
    response: { 200: followState, ...workReadProblems } }, ({ request,query }) => state(request,query.target,query.kind,query))
    .get('/v1/authors/open-library/:author/follow', {
      params: t.Object({ author: t.String({ pattern: '^OL[1-9][0-9]{0,11}A$' }) }),
      query: t.Object(stateQuery, { additionalProperties: false }), detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: followState, ...workReadProblems },
    }, ({ request, params, query }) => state(request, `open-library:${params.author}`, 'external-author', query))
    .post('/v1/follows', { body: followCommand, response: { 200: followResult, ...workReadProblems } },
      async ({ request, body }) => {
        try {
          if (!work.follows) throw new WorkReadUnavailable('Follows are unavailable');
          const principal = await work.account.verify(request, ['follow:write']);
          const result = await work.follows.set(principal, body, request.headers.get('idempotency-key') ?? '',
            describe(request,principal,body.actingSubject));
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
          request.headers.get('idempotency-key') ?? '', describe(request,principal,body.actingSubject)),
        { headers: homeHeaders });
      } catch (error) { return homeError(error); }
    });
}
