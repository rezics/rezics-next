import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import {
  digest, RecommendationConflict, RecommendationDenied, RecommendationMissing, RecommendationNotReady,
  RecommendationRestart, RecommendationStale, RecommendationUnavailable,
} from '../modules/recommendation/derived-generation.ts';
import { MAX_RANKING_PAGE, RANKING_PROFILE, type RankingBasis, type RankingGenerations }
  from '../modules/recommendation/ranking.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

/** Route dependencies beyond MainWorkDependencies; the composition root passes the same object. */
export interface RecommendationDependencies { recommendations?: RankingGenerations }

export const openApiOperations = {
  '/v1/recommendations/generation-builds': { post: { exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/recommendations/generations/{generation}': { get: { exposure: 'platform:platform-admin', rateLimitFamily: 'read', bearer: true } },
  '/v1/recommendations/generation-activations': { post: { exposure: 'platform:platform-admin', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/recommendations/queries': { post: { exposure: 'platform:recommendations', rateLimitFamily: 'read', bearer: true } },
  '/v1/recommendations/pages': { post: { exposure: 'platform:recommendations', rateLimitFamily: 'read', bearer: true } },
} as const;

const iri = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const decimal = t.String({ pattern: '^(0|[1-9][0-9]{0,18})$' });

const rankingBasis = t.Object({
  profile: t.Literal(RANKING_PROFILE),
  population: t.Union([
    t.Object({ kind: t.Literal('public') }, { additionalProperties: false }),
    t.Object({ kind: t.Literal('realm'), realm: iri }, { additionalProperties: false }),
    t.Object({ kind: t.Literal('personal') }, { additionalProperties: false }),
  ]),
  candidateGrain: t.Literal('work'),
  semantic: t.Nullable(t.Object({ context: iri, contextRevision: iri, selectionRevision: t.Union([iri, uuid]),
    preferenceRevision: t.Nullable(iri) }, { additionalProperties: false })),
}, { additionalProperties: false });

const generationView = t.Object({
  profile: t.Literal('ranking-generation-v1'), generation: uuid,
  state: t.Union(['building', 'ready', 'failed', 'cancelled', 'superseded', 'expired'].map(state => t.Literal(state))),
  population: t.Union([t.Literal('public'), t.Literal('realm'), t.Literal('personal')]),
  leaseEpoch: decimal,
  checkpoint: t.Object({ dataEpoch: t.String(), sequence: decimal, snapshotComplete: t.Boolean() }),
  failureReason: t.Nullable(t.String()), activeRevision: t.Nullable(decimal), replayed: t.Boolean(),
});

const rankingPage = t.Object({
  profile: t.Literal('ranking-page-v1'), generation: uuid,
  ordering: t.Literal('score-desc-candidate-asc'), disclosure: t.Literal('rechecked-at-delivery'),
  items: t.Array(t.Object({ candidate: iri }), { maxItems: MAX_RANKING_PAGE }),
  continuation: t.Nullable(t.String({ maxLength: 1024 })),
});

const noStore = { headers: { 'cache-control': 'no-store' } };
const withMissing = { ...writeProblems, 404: problemResult(404) };

function replayKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && key.length <= 128 && !key.includes('\0') ? key : null;
}

function recommendationError(error: unknown): Response {
  if (error instanceof RecommendationDenied) return problem(403, 'recommendation_denied', 'Recommendation authority or basis is not admitted');
  if (error instanceof RecommendationConflict) return problem(409, 'idempotency_conflict', 'Idempotency key conflicts with an earlier request');
  if (error instanceof RecommendationStale) return problem(409, 'recommendation_stale', 'Generation lease or state changed');
  if (error instanceof RecommendationNotReady) return problem(409, 'generation_not_ready', 'Generation is not ready');
  if (error instanceof RecommendationRestart) return problem(409, 'recommendation_restart', 'Start pagination again');
  if (error instanceof RecommendationMissing) return problem(404, 'recommendation_unavailable', 'Ranking is unavailable');
  if (error instanceof RecommendationUnavailable) return problem(503, 'recommendation_owner_unavailable', 'Ranking owner is unavailable');
  return commandError(error);
}

/** Ranking generations: builds, exact-revision activation and generation-bound pages. */
export function recommendationRoutes(work: MainWorkDependencies & RecommendationDependencies) {
  const unavailable = () => problem(503, 'recommendation_owner_unavailable', 'Ranking owner is unavailable');
  return new Elysia()
    .post('/v1/recommendations/generation-builds', {
      body: t.Object({ profile: t.Literal('ranking-generation-build-v1'), actingSubject: iri,
        basis: rankingBasis, partitionCount: t.Integer({ minimum: 1, maximum: 256 }) },
      { additionalProperties: false }),
      response: { 200: generationView, ...writeProblems },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['rating:configure']);
        if (!work.recommendations) return unavailable();
        const key = replayKey(request);
        if (!key) return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        const view = await work.recommendations.registerBuild({ principal, actingSubject: body.actingSubject },
          body.basis as RankingBasis, body.partitionCount, { idempotencyKey: key, requestDigest: digest(body) });
        return Response.json({ profile: 'ranking-generation-v1', ...view, replayed: view.replayed ?? false }, noStore);
      } catch (error) { return recommendationError(error); }
    })
    .get('/v1/recommendations/generations/:generation', {
      params: t.Object({ generation: uuid }),
      query: t.Object({ actingSubject: iri }, { additionalProperties: false }),
      response: { 200: generationView, ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const principal = await work.account.verify(request, ['rating:configure']);
        if (!work.recommendations) return unavailable();
        const view = await work.recommendations.readGeneration(
          { principal, actingSubject: query.actingSubject }, params.generation);
        return Response.json({ profile: 'ranking-generation-v1', ...view, replayed: false }, noStore);
      } catch (error) { return recommendationError(error); }
    })
    .post('/v1/recommendations/generation-activations', {
      body: t.Object({ profile: t.Literal('ranking-generation-activation-v1'), actingSubject: iri,
        generation: uuid, expectedHeadRevision: t.Nullable(decimal) }, { additionalProperties: false }),
      response: { 200: t.Object({ profile: t.Literal('ranking-generation-activation-v1'), generation: uuid,
        headRevision: decimal, predecessor: t.Nullable(uuid), replayed: t.Boolean() }), ...withMissing },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['rating:configure']);
        if (!work.recommendations) return unavailable();
        const key = replayKey(request);
        if (!key) return problem(400, 'invalid_idempotency_key', 'A bounded idempotency key is required');
        const result = await work.recommendations.activate({ principal, actingSubject: body.actingSubject },
          body.generation, body.expectedHeadRevision, { idempotencyKey: key, requestDigest: digest(body) });
        if (result.outcome === 'stale_head') return problem(409, 'stale_head', 'Active generation head changed');
        if (result.outcome === 'rejected') return problem(409, 'generation_not_ready', 'Generation is not ready');
        return Response.json({ profile: 'ranking-generation-activation-v1', generation: result.generation,
          headRevision: result.headRevision, predecessor: result.predecessor, replayed: result.replayed }, noStore);
      } catch (error) { return recommendationError(error); }
    })
    .post('/v1/recommendations/queries', {
      body: t.Object({ profile: t.Literal('ranking-page-v1'), actingSubject: iri, basis: rankingBasis,
        pageSize: t.Integer({ minimum: 1, maximum: MAX_RANKING_PAGE }) }, { additionalProperties: false }),
      response: { 200: rankingPage, ...authorizedReadProblems, 409: problemResult(409) },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['rating:read']);
        if (!work.recommendations) return unavailable();
        const page = await work.recommendations.page({ principal, actingSubject: body.actingSubject },
          body.basis as RankingBasis, body.pageSize);
        return Response.json({ profile: 'ranking-page-v1', ordering: 'score-desc-candidate-asc',
          disclosure: 'rechecked-at-delivery', ...page }, noStore);
      } catch (error) { return recommendationError(error); }
    })
    .post('/v1/recommendations/pages', {
      body: t.Object({ profile: t.Literal('ranking-page-v1'), actingSubject: iri, basis: rankingBasis,
        pageSize: t.Integer({ minimum: 1, maximum: MAX_RANKING_PAGE }),
        continuation: t.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false }),
      response: { 200: rankingPage, ...authorizedReadProblems, 409: problemResult(409) },
    }, async ({ request, body }) => {
      try {
        const principal = await work.account.verify(request, ['rating:read']);
        if (!work.recommendations) return unavailable();
        const page = await work.recommendations.page({ principal, actingSubject: body.actingSubject },
          body.basis as RankingBasis, body.pageSize, body.continuation);
        return Response.json({ profile: 'ranking-page-v1', ordering: 'score-desc-candidate-asc',
          disclosure: 'rechecked-at-delivery', ...page }, noStore);
      } catch (error) { return recommendationError(error); }
    });
}
