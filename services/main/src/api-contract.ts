import { t } from 'elysia';

export const sourcePosition = t.Object({ datasetId: t.Literal('product'), dataEpoch: t.String(),
  sequence: t.String({ pattern: '^[0-9]+$' }) });

export const workResult = t.Object({
  work: t.String(), mainVersion: t.String(), workRevision: t.String(),
  mainRevision: t.String(), sourcePosition, replayed: t.Boolean(),
});

export const exactWorkRevision = t.Object({
  revision: t.String(), work: t.String(), predecessor: t.Optional(t.String()),
  operation: t.String(), mainVersion: t.String(), title: t.String(),
  language: t.Literal('en'), sourcePosition,
});

export const pendingOperation = t.Object({
  operationId: t.String(), status: t.Literal('reconciling'), phase: t.String(),
  result: t.Null(), retry: t.Object({ allowed: t.Literal(true), afterMs: t.Number() }),
});

export function problemResult<const Status extends number>(status: Status) {
  return t.Object({ type: t.String(), title: t.String(), status: t.Literal(status),
    code: t.String() });
}

const phraseMatch = t.Object({
  matchUnit: t.String(), work: t.String(), mainVersion: t.String(),
  contribution: t.String(), revision: t.String(), selection: t.String(),
  language: t.String(), score: t.Number(),
});
const realmPhraseMatch = t.Object({ ...phraseMatch.properties, reason: t.String() });
const classification = t.Object({ sense: t.String(), decision: t.String(),
  application: t.String(), source: t.String(), sourceContext: t.String() });
const classifiedMainMatch = t.Object({ ...phraseMatch.properties, classification });
const classifiedRealmMatch = t.Object({ ...realmPhraseMatch.properties, classification });
const ratedRealmMatch = t.Object({ ...classifiedRealmMatch.properties,
  rating: t.Object({ context: t.String(), count: t.Number(), sum: t.Number(),
    mean: t.Number(), precision: t.Object({ kind: t.Literal('exact-rational'),
      numerator: t.Number(), denominator: t.Number() }) }) });
const baseQuery = { contractVersion: t.Literal('1'), resultGrain: t.Literal('mainVersion'),
  complete: t.Literal(true), population: t.Number(), indexGeneration: t.String(),
  total: t.Number(), sourcePosition };
const realmContext = t.Object({ kind: t.Literal('realm-local'), id: t.String() });
const contentPosition = t.Object({ owner: t.Literal('content'), dataEpoch: t.String(),
  sequence: t.String({ pattern: '^[0-9]+$' }) });
const contentPhraseMatch = t.Object({ matchUnit: t.String(), resource: t.String(),
  variant: t.String(), revision: t.String(), publicationDecision: t.String(),
  language: t.String(), score: t.Number() });

export const publicQueryResult = t.Union([
  t.Object({ contractVersion: t.Literal('1'), profile: t.Literal('public-content-phrase-v1'),
    resultGrain: t.Literal('content-variant'), complete: t.Literal(true),
    population: t.Number(), total: t.Number(), results: t.Array(contentPhraseMatch),
    graphPosition: t.Object({ dataEpoch: t.String(), sequence: t.String({ pattern: '^[0-9]+$' }) }),
    contentPosition, indexGeneration: t.String() }, { additionalProperties: false }),
  t.Object({ ...baseQuery, context: t.Literal('main-version-default'),
    results: t.Array(phraseMatch) }, { additionalProperties: false }),
  t.Object({ ...baseQuery, context: realmContext,
    results: t.Array(realmPhraseMatch) }, { additionalProperties: false }),
  t.Object({ ...baseQuery, profile: t.Literal('public-main-classified-phrase-v1'),
    context: t.Literal('main-version-default'), classificationSense: t.String(),
    results: t.Array(classifiedMainMatch) }, { additionalProperties: false }),
  t.Object({ ...baseQuery, profile: t.Literal('public-realm-classified-phrase-v1'),
    context: realmContext, classificationSense: t.String(),
    results: t.Array(classifiedRealmMatch) }, { additionalProperties: false }),
  t.Object({ ...baseQuery, profile: t.Literal('public-realm-classified-rated-phrase-v1'),
    context: realmContext, classificationSense: t.String(),
    ratingCriterion: t.Object({ context: t.String(), minimumMeanTimes10: t.Number(),
      policy: t.Literal('latest-per-rater-mean') }),
    ratingPopulation: t.Number(), results: t.Array(ratedRealmMatch) },
  { additionalProperties: false }),
]);

const pageContinuation = t.Object({
  queryDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  resultDigest: t.String({ pattern: '^[0-9a-f]{64}$' }),
  sourcePosition, indexGeneration: t.String(),
  nextOffset: t.Integer({ minimum: 1, maximum: 512 }),
  expiresAt: t.Integer({ minimum: 0 }),
}, { additionalProperties: false });
const pageRequest = {
  phrase: t.String({ minLength: 2, maxLength: 80 }),
  language: t.Union([t.String({ minLength: 2, maxLength: 35,
    pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$' }), t.Null()]),
  author: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
  pageSize: t.Integer({ minimum: 1, maximum: 64 }),
  continuation: t.Optional(pageContinuation),
};
const classifiedPageRequest = {
  ...pageRequest,
  sense: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
};
export const publicPhrasePageRequest = t.Union([
  t.Object({ profile: t.Literal('public-main-phrase-page-v1'), ...pageRequest },
    { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-phrase-page-v1'),
    context: realmContext, ...pageRequest }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-main-classified-phrase-page-v1'),
    ...classifiedPageRequest }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-classified-phrase-page-v1'),
    context: realmContext, ...classifiedPageRequest }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-classified-rated-phrase-page-v1'),
    context: realmContext, ...classifiedPageRequest,
    ratingContext: t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' }),
    minimumMeanTimes10: t.Integer({ minimum: 10, maximum: 100 }) },
  { additionalProperties: false }),
]);
const pageResult = { resultGrain: t.Literal('mainVersion'),
  relationComplete: t.Literal(true), population: t.Integer(), total: t.Integer(),
  sourcePosition, indexGeneration: t.String(), next: t.Nullable(pageContinuation) };
export const publicPhrasePageResult = t.Union([
  t.Object({ profile: t.Literal('public-main-phrase-page-v1'), ...pageResult,
    context: t.Literal('main-version-default'), results: t.Array(phraseMatch) },
  { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-phrase-page-v1'), ...pageResult,
    context: realmContext, results: t.Array(realmPhraseMatch) },
  { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-main-classified-phrase-page-v1'), ...pageResult,
    context: t.Literal('main-version-default'), classificationSense: t.String(),
    results: t.Array(classifiedMainMatch) }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-classified-phrase-page-v1'), ...pageResult,
    context: realmContext, classificationSense: t.String(),
    results: t.Array(classifiedRealmMatch) }, { additionalProperties: false }),
  t.Object({ profile: t.Literal('public-realm-classified-rated-phrase-page-v1'), ...pageResult,
    context: realmContext, classificationSense: t.String(),
    ratingCriterion: t.Object({ context: t.String(), minimumMeanTimes10: t.Number(),
      policy: t.Literal('latest-per-rater-mean') }), ratingPopulation: t.Number(),
    results: t.Array(ratedRealmMatch) }, { additionalProperties: false }),
]);
