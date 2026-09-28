import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { alsoEnjoyedPage, alsoEnjoyedQuery } from '../modules/also-enjoyed/contract.ts';
import { readAlsoEnjoyed } from '../modules/also-enjoyed/read.ts';
import { digest, RecommendationConflict, RecommendationDenied, RecommendationMissing,
  RecommendationRestart, RecommendationStale, RecommendationUnavailable }
  from '../modules/recommendation/derived-generation.ts';
import { readId, readUuid } from '../modules/work/read-contract.ts';
import { WorkReadUnavailable, workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError, workReadProblems } from './work-reads.ts';

export const openApiOperations = {
  '/v1/works/{id}/also-enjoyed': { get: { bearer: false } },
  '/v1/also-enjoyed/generation-builds': { post: { bearer: true, idempotencyKey: true } },
  '/v1/also-enjoyed/generations/{generation}': { get: { bearer: true } },
  '/v1/also-enjoyed/generations/{generation}/advance': { post: { bearer: true } },
  '/v1/also-enjoyed/generation-activations': { post: { bearer: true, idempotencyKey: true } },
} as const;

const noStore = { headers: { 'cache-control': 'private, no-store' } };
const uuid = t.Object({ id: readUuid });
const generation = t.Object({ generation: readUuid });
const managed = t.Object({ actingSubject: readId });
const genView = t.Object({ generation: readUuid, state: t.String(), phase: t.String(),
  signalCount: t.Number(), pairCount: t.Number() });
const buildView = t.Object({ generation: readUuid, replayed: t.Boolean() });
const activationView = t.Object({ generation: readUuid, headRevision: t.String(),
  predecessor: t.Nullable(readUuid), replayed: t.Boolean() });
const manageProblems = { ...workReadProblems, 403: problemResult(403) };
function key(request: Request) {
  const value = request.headers.get('idempotency-key');
  if (!value || !/^[A-Za-z0-9:_./-]{1,128}$/.test(value)) {
    throw new RecommendationConflict('A bounded idempotency key is required');
  }
  return value;
}
function readError(error: unknown) {
  if (error instanceof RecommendationDenied) return problem(403, 'recommendation_denied', 'Recommendation management is denied');
  if (error instanceof RecommendationMissing) return problem(404, 'recommendation_missing', 'Generation is unavailable');
  if (error instanceof RecommendationConflict) return problem(409, 'recommendation_conflict', error.message);
  if (error instanceof RecommendationRestart || error instanceof RecommendationStale) {
    return problem(409, 'recommendation_basis_changed', 'Restart the recommendation read or build');
  }
  if (error instanceof RecommendationUnavailable) {
    return problem(503, 'recommendation_unavailable', 'Recommendation owner is unavailable');
  }
  return workReadError(error);
}

export function alsoEnjoyedRoutes(work: MainWorkDependencies) {
  return new Elysia()
    .get('/v1/works/:id/also-enjoyed', {
      params: uuid, query: alsoEnjoyedQuery,
      detail: { security: [{}, { bearerAuth: [] }] },
      response: { 200: alsoEnjoyedPage, ...workReadProblems },
    }, async ({ request, params, query }) => {
      try {
        if (!work.alsoEnjoyed) throw new WorkReadUnavailable('Co-reader owner is unavailable');
        return Response.json(await workRead(work, request, { ...query, movingGraph: true },
          session => readAlsoEnjoyed(session, `https://rezics.com/id/${params.id}`, work.alsoEnjoyed!),
          (page, session) => ({ ...page, stale: page.stale || session.stale })), noStore);
      } catch (error) { return readError(error); }
    })
    .post('/v1/also-enjoyed/generation-builds', {
      body: managed, response: { 200: buildView, ...manageProblems },
    }, async ({ request, body }) => {
      try {
        if (!work.alsoEnjoyed) throw new WorkReadUnavailable('Co-reader owner is unavailable');
        const principal = await work.account.verify(request, ['rating:configure']);
        const receipt = { idempotencyKey: key(request), requestDigest: digest(body) };
        return Response.json(await workRead(work, new Request(request.url, { method: 'POST' }), {},
          session => work.alsoEnjoyed!.register({ principal, actingSubject: body.actingSubject },
            session.position, receipt)), noStore);
      } catch (error) { return readError(error); }
    })
    .get('/v1/also-enjoyed/generations/:generation', {
      params: generation, query: managed, response: { 200: genView, ...manageProblems },
    }, async ({ request, params, query }) => {
      try {
        if (!work.alsoEnjoyed) throw new WorkReadUnavailable('Co-reader owner is unavailable');
        const principal = await work.account.verify(request, ['rating:configure']);
        await work.alsoEnjoyed.authorize({ principal, actingSubject: query.actingSubject });
        const row = await work.alsoEnjoyed.generation(params.generation);
        return Response.json({ generation: params.generation, state: row.state, phase: row.phase,
          signalCount: Number(row.signal_count), pairCount: Number(row.pair_count) }, noStore);
      } catch (error) { return readError(error); }
    })
    .post('/v1/also-enjoyed/generations/:generation/advance', {
      params: generation, body: managed, response: { 200: genView, ...manageProblems },
    }, async ({ request, params, body }) => {
      try {
        if (!work.alsoEnjoyed) throw new WorkReadUnavailable('Co-reader owner is unavailable');
        const principal = await work.account.verify(request, ['rating:configure']);
        const result = await work.alsoEnjoyed.advance(params.generation,
          { principal, actingSubject: body.actingSubject }, work, request);
        return Response.json({ ...result, state: result.phase === 'complete' ? 'ready' : 'building' }, noStore);
      } catch (error) { return readError(error); }
    })
    .post('/v1/also-enjoyed/generation-activations', {
      body: t.Object({ actingSubject: readId, generation: readUuid,
        expectedHeadRevision: t.Nullable(t.String({ pattern: '^[0-9]+$' })) }),
      response: { 200: activationView, ...manageProblems },
    }, async ({ request, body }) => {
      try {
        if (!work.alsoEnjoyed) throw new WorkReadUnavailable('Co-reader owner is unavailable');
        const principal = await work.account.verify(request, ['rating:configure']);
        const result = await workRead(work, new Request(request.url, { method: 'POST' }), {},
          session => work.alsoEnjoyed!.activate({ principal, actingSubject: body.actingSubject },
            body.generation, body.expectedHeadRevision,
            { idempotencyKey: key(request), requestDigest: digest(body) }, session.position));
        if (result.outcome !== 'succeeded') return problem(409, 'recommendation_not_ready', 'Generation is not ready');
        return Response.json({ generation: result.generation, headRevision: result.headRevision,
          predecessor: result.predecessor, replayed: result.replayed }, noStore);
      } catch (error) { return readError(error); }
    });
}
