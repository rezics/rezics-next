import { Elysia, t } from 'elysia';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { queryPublicMainClassifiedPhrase, queryPublicMainPhrase, queryPublicRealmClassifiedPhrase,
  queryPublicRealmPhrase } from '../modules/work/search-public.ts';
import { InvalidSearchContinuation, pageCompletePublicRelation, SearchContinuationRestart }
  from '../modules/work/search-continuation.ts';
import { queryPublicRealmClassifiedRatedPhrase } from '../modules/work/search-joined.ts';
import { withStableSearchSnapshot, SearchIndexUnavailable, type SearchAttemptDiagnostic }
  from '../modules/work/search-readiness.ts';
import { ContentProjectionUnavailable } from '../modules/content-publication/relay.ts';
import { queryPublicContentPhrase } from '../modules/content-publication/search.ts';
import { pageCompleteContentRelation } from '../modules/content-publication/search-continuation.ts';
import { problemResult, publicPhrasePageRequest, publicPhrasePageResult, publicQueryResult,
  unsupportedPublicSearchSelectors } from '../api-contract.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';

function logLoadSearchFailure(profile: string, error: unknown,
  diagnostics: SearchAttemptDiagnostic[] | undefined): void {
  if (!process.env.REZICS_LOAD_RUN_ID || !(error instanceof SearchIndexUnavailable)) return;
  console.error(JSON.stringify({ event: 'load-search-failure', profile,
    error: error.constructor.name, message: error.message,
    cause: error.cause instanceof Error ? { error: error.cause.constructor.name,
      message: error.cause.message } : undefined,
    attempts: diagnostics }));
}

function unsupportedSearchSelection(body: { sourcePolicy?: unknown; asOf?: unknown }) {
  if (body.sourcePolicy !== undefined) {
    return problem(422, 'search_source_policy_unsupported',
      'Multi-dataset public search is unsupported');
  }
  if (body.asOf !== undefined) {
    return problem(422, 'historical_search_unsupported',
      'Historical public search is unsupported');
  }
  return null;
}

export function searchRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  return new Elysia()
    .post('/v1/private-queries', {
      body: t.Object({ profile: t.Literal('private-contribution-phrase-v1'),
        contribution: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        actingSubject: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
      }, { additionalProperties: false }),
      response: { 400: problemResult(400), 503: problemResult(503) },
    }, () => problem(503, 'private_search_unavailable',
      'Private phrase delivery is unavailable'))
    .post('/v1/queries', {
      body: t.Union([t.Object({ profile: t.Literal('public-content-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]) }, { additionalProperties: false }), t.Object({ profile: t.Literal('public-main-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]), author: t.Optional(t.String({
          pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$',
        })) }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-main-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
      }, { additionalProperties: false }), t.Object({
        profile: t.Literal('public-realm-classified-rated-phrase-v1'),
        ...unsupportedPublicSearchSelectors,
        context: t.Object({ kind: t.Literal('realm-local'),
          id: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }) },
        { additionalProperties: false }),
        phrase: t.String({ minLength: 2, maxLength: 80 }),
        language: t.Union([
          t.String({ minLength: 2, maxLength: 35,
            pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null(),
        ]),
        author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
        sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        ratingContext: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
        minimumMeanTimes10: t.Integer({ minimum: 10, maximum: 100 }),
      }, { additionalProperties: false })]),
      response: { 200: publicQueryResult, 400: problemResult(400),
        404: problemResult(404), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        if (body.profile === 'public-content-phrase-v1' && !work.contentProjection) {
          return problem(503, 'content_projection_unavailable', 'Public Content projection is unavailable');
        }
        const result = await withStableSearchSnapshot(fuseki, async () => body.profile === 'public-content-phrase-v1'
          ? queryPublicContentPhrase(work.environment, work.contentProjection!.content,
            work.contentProjection!.cursor, work.contentProjection!.consumer, body)
          : body.profile === 'public-realm-classified-rated-phrase-v1'
          ? await queryPublicRealmClassifiedRatedPhrase(work.environment, body)
          : body.profile === 'public-realm-phrase-v1'
          ? await queryPublicRealmPhrase(work.environment, body)
          : body.profile === 'public-main-phrase-v1'
            ? await queryPublicMainPhrase(work.environment, body)
            : body.profile === 'public-realm-classified-phrase-v1'
              ? await queryPublicRealmClassifiedPhrase(work.environment, body)
              : await queryPublicMainClassifiedPhrase(work.environment, body), undefined, diagnostics);
        return Response.json(result, {
          headers: { 'cache-control': 'no-store' },
        });
      } catch (error) {
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    })
    .post('/v1/queries/page', {
      body: publicPhrasePageRequest,
      response: { 200: publicPhrasePageResult, 400: problemResult(400),
        404: problemResult(404), 409: problemResult(409), 422: problemResult(422),
        500: problemResult(500), 503: problemResult(503) },
    }, async ({ body }) => {
      const diagnostics: SearchAttemptDiagnostic[] | undefined = process.env.REZICS_LOAD_RUN_ID ? [] : undefined;
      try {
        const unsupported = unsupportedSearchSelection(body);
        if (unsupported) return unsupported;
        const page = await withStableSearchSnapshot(fuseki, async () => {
          if (body.profile === 'public-content-phrase-page-v1') {
            if (!work.contentProjection) {
              throw new ContentProjectionUnavailable('Public Content projection is unavailable');
            }
            const relation = await queryPublicContentPhrase(work.environment,
              work.contentProjection.content, work.contentProjection.cursor,
              work.contentProjection.consumer, body);
            return pageCompleteContentRelation(body, relation);
          }
          if (body.profile === 'public-main-phrase-page-v1') {
            const relation = await queryPublicMainPhrase(work.environment, body);
            return pageCompletePublicRelation(body, relation);
          }
          if (body.profile === 'public-realm-phrase-page-v1') {
            const relation = await queryPublicRealmPhrase(work.environment, body);
            return pageCompletePublicRelation(body, relation);
          }
          if (body.profile === 'public-main-classified-phrase-page-v1') {
            const relation = await queryPublicMainClassifiedPhrase(work.environment, body);
            return { ...pageCompletePublicRelation(body, relation),
              classificationSense: relation.classificationSense };
          }
          if (body.profile === 'public-realm-classified-phrase-page-v1') {
            const relation = await queryPublicRealmClassifiedPhrase(work.environment, body);
            return { ...pageCompletePublicRelation(body, relation),
              classificationSense: relation.classificationSense };
          }
          const relation = await queryPublicRealmClassifiedRatedPhrase(work.environment, body);
          return { ...pageCompletePublicRelation(body, relation),
            classificationSense: relation.classificationSense,
            ratingCriterion: relation.ratingCriterion,
            ratingPopulation: relation.ratingPopulation };
        }, undefined, diagnostics);
        return Response.json(page, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof SearchContinuationRestart) {
          return problem(409, 'search_restart_required', 'Public search changed; restart at page one');
        }
        if (error instanceof InvalidSearchContinuation) {
          return problem(422, 'invalid_search_continuation', 'Public search continuation is invalid');
        }
        logLoadSearchFailure(body.profile, error, diagnostics);
        return commandError(error);
      }
    });
}
