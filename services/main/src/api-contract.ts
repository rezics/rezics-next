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

export const publicQueryResult = t.Union([
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
