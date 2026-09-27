import { Elysia, t } from 'elysia';
import { ControlInvalid } from '../modules/access/topology-control.ts';
import { FEED_COST, feedPage, feedQuery, feedVoteCommand, feedVoteResult } from '../modules/feed/contract.ts';
import { exclusionCommand, exclusionKind, homePreferences, preferencesCommand, watermarkCommand }
  from '../modules/feed/personal.ts';
import { HOME_COST } from '../modules/feed/personal.ts';
import { admitFeedVote, readFeed } from '../modules/feed/read.ts';
import { readNewSince } from '../modules/feed/new-since.ts';
import { TRENDING_COST, trendingQuery, trendingResult } from '../modules/feed/trending.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { workRead, WorkReadLimit, WorkReadUnavailable } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/feed': { get: { bearer: false } },
  '/v1/feed/head': { get: { bearer: false } },
  '/v1/feed/{id}/vote': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/feed-preferences': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
  '/v1/me/feed-feedback': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/mutes': { get: { bearer: true }, put: { bearer: true, idempotencyKey: true } },
  '/v1/me/feed-watermarks/{scope}': { put: { bearer: true, idempotencyKey: true } },
  '/v1/me/feed-watermarks': { get: { bearer: true } },
  '/v1/trending': { get: { bearer: false } },
} as const;

const privateQuery = t.Object({ actingSubject: readId }, { additionalProperties: false });
const preferencesResult = t.Object({ profile: t.Literal('home-preferences-v1'),
  revision: t.Nullable(readUuid), preferences: homePreferences, replayed: t.Optional(t.Boolean()) });
const exclusionResult = t.Object({ profile: t.Literal('home-exclusion-v1'),
  actingSubject: readId, kind: exclusionKind, target: t.String(),
  strength: t.Union([t.Literal('hide'), t.Literal('fewer'), t.Literal('mute'),
    t.Literal('not-interested'), t.Literal('clear')]),
  revision: readUuid, replayed: t.Boolean() });
const mutesResult = t.Object({ profile: t.Literal('home-mutes-v1'), revision: t.Nullable(readUuid),
  items: t.Array(t.Object({ kind: exclusionKind, target: t.String(), strength: t.Literal('mute') }),
    { maxItems: 1000 }) });
const watermarkResult = t.Object({ profile: t.Literal('home-watermark-v1'), scope: t.String(),
  dataEpoch: t.String(), sequence: t.String(), replayed: t.Boolean() });
const watermarksResult = t.Object({ profile: t.Literal('home-watermarks-v1'),
  items: t.Array(t.Object({ scope: t.String(), dataEpoch: t.String(), sequence: t.String(),
    updatedAt: t.String() }), { maxItems: HOME_COST.watermarks }) });
const headQuery = t.Object({ after: t.String({ pattern: '^\\d{1,30}$' }),
  afterReview: t.Optional(t.String({ pattern: '^\\d{1,30}$' })),
  scope: t.Optional(t.String({ maxLength: 100 })), actingSubject: t.Optional(readId) },
{ additionalProperties: false });
const headResult = t.Object({ profile: t.Literal('home-feed-head-v1'), scope: t.String(),
  afterSequence: t.String(), newPosts: t.Object({ value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }),
  state: t.Union([t.Literal('current'), t.Literal('more'), t.Literal('projecting')]),
  projection: t.Object({ sequence: t.String(), reviewSequence: t.String(), dataEpoch: t.String() }) });

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
  }).get('/v1/feed/head', { query: headQuery,
    detail: { security: [{}, { bearerAuth: [] }] }, response: { 200: headResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      const principal = request.headers.has('authorization')
        ? await work.account.verify(request, ['follow:read']) : null;
      if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
      const scope = query.scope ?? (principal ? 'following' : 'all');
      if (scope !== 'all' && scope !== 'following'
        && !/^realm:https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(scope)) {
        throw new ControlInvalid('Invalid feed head scope');
      }
      return Response.json(await workRead(work, new Request(request.url), {},
        session => readNewSince(session, query.after, scope as 'all' | 'following' | `realm:${string}`,
          principal ? { principal, agent: query.actingSubject! } : undefined, query.afterReview)), { headers: homeHeaders });
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
  }).get('/v1/me/feed-preferences', { query: privateQuery,
    response: { 200: preferencesResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home preferences are unavailable');
      const principal = await work.account.verify(request, ['follow:read']);
      const state = await work.homePersonal.read(principal, query.actingSubject);
      return Response.json({ profile: 'home-preferences-v1', revision: state.revision,
        preferences: state.preferences }, { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).put('/v1/me/feed-preferences', { body: preferencesCommand,
    response: { 200: preferencesResult, ...workReadProblems },
  }, async ({ request, body }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home preferences are unavailable');
      const principal = await work.account.verify(request, ['follow:write']);
      return Response.json(await work.homePersonal.preferences(principal, body,
        request.headers.get('idempotency-key') ?? ''), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).post('/v1/me/feed-feedback', { body: exclusionCommand,
    response: { 200: exclusionResult, ...workReadProblems },
  }, async ({ request, body }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home feedback is unavailable');
      if (body.kind === 'continue') throw new ControlInvalid('Use Continue to hide a resume item');
      const principal = await work.account.verify(request, ['follow:write']);
      return Response.json(await work.homePersonal.exclusion(principal, body,
        request.headers.get('idempotency-key') ?? ''), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).get('/v1/me/mutes', { query: privateQuery,
    response: { 200: mutesResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home mutes are unavailable');
      const principal = await work.account.verify(request, ['follow:read']);
      const state = await work.homePersonal.read(principal, query.actingSubject);
      return Response.json({ profile: 'home-mutes-v1', revision: state.revision,
        items: state.exclusions.filter(item => item.strength === 'mute') }, { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).put('/v1/me/mutes', { body: exclusionCommand,
    response: { 200: exclusionResult, ...workReadProblems },
  }, async ({ request, body }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home mutes are unavailable');
      if (!['realm', 'tag', 'person'].includes(body.kind) || !['mute', 'clear'].includes(body.strength)) {
        throw new ControlInvalid('Invalid mute command');
      }
      const principal = await work.account.verify(request, ['follow:write']);
      return Response.json(await work.homePersonal.exclusion(principal, body,
        request.headers.get('idempotency-key') ?? ''), { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).get('/v1/trending', { query: trendingQuery,
    detail: { security: [{}, { bearerAuth: [] }] }, response: { 200: trendingResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      const principal = request.headers.has('authorization')
        ? await work.account.verify(request, ['follow:read']) : null;
      if (!!principal !== !!query.actingSubject) throw new ControlInvalid('Authentication and actingSubject are required together');
      const scope = query.scope ?? (principal ? 'followed' : 'global');
      if (!['followed', 'global'].includes(scope)
        && !/^(realm|zone):https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(scope)) {
        throw new ControlInvalid('Invalid trending scope');
      }
      if (scope === 'followed' && !principal) throw new ControlInvalid('Following requires authentication');
      if (!work.homeTrending) throw new WorkReadUnavailable('Trending projection is unavailable');
      const result = await workRead(work, new Request(request.url, { headers: request.headers }),
        { actingSubject: query.actingSubject }, session => work.homeTrending!.read(session,
          { query, principal, agent: query.actingSubject ?? null }));
      const body = JSON.stringify(result);
      if (Buffer.byteLength(body) > TRENDING_COST.responseBytes) {
        throw new WorkReadLimit('Trending response budget exceeded');
      }
      return new Response(body, { headers: { ...homeHeaders, 'content-type': 'application/json' } });
    } catch (error) { return homeError(error); }
  }).get('/v1/me/feed-watermarks', { query: privateQuery,
    response: { 200: watermarksResult, ...workReadProblems },
  }, async ({ request, query }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home watermarks are unavailable');
      const principal = await work.account.verify(request, ['follow:read']);
      const rows = await work.homePersonal.watermarks(principal, query.actingSubject);
      return Response.json({ profile: 'home-watermarks-v1', items: rows.map(row => ({
        scope: row.scope, dataEpoch: row.data_epoch, sequence: row.sequence,
        updatedAt: row.updated_at.toISOString() })) }, { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  }).put('/v1/me/feed-watermarks/:scope', { params: t.Object({ scope: t.String() }),
    body: watermarkCommand, response: { 200: watermarkResult, ...workReadProblems },
  }, async ({ request, params, body }) => {
    try {
      if (!work.homePersonal) throw new WorkReadUnavailable('Home watermarks are unavailable');
      if (params.scope !== body.scope) throw new ControlInvalid('Watermark scope differs');
      const principal = await work.account.verify(request, ['follow:write']);
      return Response.json(await work.homePersonal.watermark(principal, body,
        request.headers.get('idempotency-key') ?? '', work.environment.lineage.dataEpoch),
      { headers: homeHeaders });
    } catch (error) { return homeError(error); }
  });
}
