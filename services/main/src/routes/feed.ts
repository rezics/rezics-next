import { Elysia, t } from 'elysia';
import { ControlInvalid } from '../modules/access/topology-control.ts';
import { FEED_COST, feedPage, feedQuery, feedVoteCommand, feedVoteResult } from '../modules/feed/contract.ts';
import { admitFeedVote, readFeed } from '../modules/feed/read.ts';
import { readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/feed': { get: { bearer: false } },
  '/v1/feed/{id}/vote': { post: { bearer: true, idempotencyKey: true } },
} as const;

export function feedRoutes(work: MainWorkDependencies) {
  return new Elysia().get('/v1/feed', { query: feedQuery,
    detail: { security: [{}, { bearerAuth: [] }] }, response: { 200: feedPage, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      const principal = request.headers.has('authorization') ? await work.account.verify(request, ['work:read', 'follow:read']) : null;
      if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
      const result = await workRead(work, new Request(request.url), { language: query.language }, session => readFeed(session,
        query, principal ? { principal, agent: query.actingSubject! } : undefined));
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > FEED_COST.responseBytes) throw new WorkReadLimit('Feed response budget exceeded');
      return new Response(body, { headers: { ...homeHeaders, 'content-type': 'application/json' } });
    } catch (error) { return homeError(error); }
  }).post('/v1/feed/:id/vote', { params: t.Object({ id: readUuid }), body: feedVoteCommand,
    response: { 200: feedVoteResult, ...workReadProblems },
  }, async ({ request, params, body }) => {
    try {
      if (!work.feed) throw new WorkReadUnavailable('Feed owner is unavailable');
      const principal = await work.account.verify(request, ['feed:vote']);
      const target = `https://rezics.com/id/${params.id}`;
      const result = await work.feed.vote(principal, target, work.environment.lineage.dataEpoch, body,
        request.headers.get('idempotency-key') ?? '', () => workRead(work, new Request(request.url), {},
          session => admitFeedVote(session, target)));
      return Response.json(result, { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  });
}
