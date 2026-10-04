import { t } from 'elysia';
import { pageFields, pageQuery, readId } from '../work/read-contract.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE } from './context.ts';
import { GLOBAL_RATING_POPULATION, GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { questionLanguagesQuery, questionReadFields } from './question-presentation-schema.ts';
import { presentRatingQuestions } from './question-presentation-read.ts';

/** P+1 Context rows, no Work enumeration or rating aggregation. Native graph
 * selection may sort the Context population; the shared read deadline applies. */
export const RATING_CONTEXTS_COST = { pageSize: 20, graphRows: 21, graphCalls: 84 } as const;
export const ratingContextsQuery = t.Object({ limit: pageQuery.limit, cursor: pageQuery.cursor,
  ...questionLanguagesQuery,
  scope: t.Optional(t.Union([t.Literal('global'), t.Literal('realm')])), realm: t.Optional(readId),
}, { additionalProperties: false });
export const standingContextItem = t.Object({ context: readId, revision: readId,
  question: t.String({ minLength: 3, maxLength: 120 }), ...questionReadFields,
  targetGrain: t.Literal('main-version'), cadence: t.Literal('standing'),
  scale: t.Object({ min: t.Literal(1), max: t.Union([t.Literal(5), t.Literal(10)]), step: t.Literal(1) }) });
export const ratingContextsPage = t.Object({ profile: t.Literal('standing-rating-contexts-v1'),
  scope: t.Object({ kind: t.Union([t.Literal('global'), t.Literal('realm')]), realm: t.Nullable(readId) }),
  items: t.Array(standingContextItem, { maxItems: RATING_CONTEXTS_COST.pageSize }), ...pageFields });

/** Shared with automatic discovery enrollment so a listed Context can acquire
 * a ranking generation without an operator or a read-side write. */
export function standingContextPattern(): string {
  return `?context rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ;
    rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:ratingScaleMin 1 ;
    rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
    { ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
        rv:ratingScaleMax 5 ; rv:ratingPopulationPolicy ${iri(GLOBAL_RATING_POPULATION)} .
      BIND("global" AS ?scope) BIND(5 AS ?max)
    } UNION {
      ?realm a rv:Realm ; rv:realmState rv:Active ; rv:ratingContext ?context ; rv:space ?space .
      ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
      ?context a rv:RatingContext ; rv:realm ?realm ; rv:ratingScaleMax 10 ;
        rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} .
      BIND("realm" AS ?scope) BIND(10 AS ?max)
    }`;
}

export async function readStandingRatingContexts(session: WorkReadSession) {
  const scope = await session.scope();
  const binding = ['standing-rating-contexts-v1', scope];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const limit = session.options.limit ?? RATING_CONTEXTS_COST.pageSize;
  const rows = await session.query(`SELECT ?context ?revision ?question ?max WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${standingContextPattern()}
      ?context rv:head ?revision ; rv:question ?question . FILTER(LANG(?question) = "en")
      FILTER(?scope = ${lit(scope.kind)}) ${scope.realm ? `FILTER(?realm = ${iri(scope.realm)})` : ''} }
    ${cursor ? `FILTER(STR(?context) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?context) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.context || !row.revision || !row.question || !row.max)
    || new Set(rows.map(row => row.context!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Standing rating Contexts are ambiguous');
  }
  const page = rows.slice(0, limit);
  const items = await presentRatingQuestions(session.deps.environment, page.map(row => ({ context: row.context!.value, revision: row.revision!.value,
    question: row.question!.value, language: row.question!['xml:lang']!, targetGrain: 'main-version' as const,
    cadence: 'standing' as const, scale: { min: 1 as const, max: Number(row.max!.value) as 5 | 10, step: 1 as const } })), session.displayLanguages);
  return { profile: 'standing-rating-contexts-v1' as const,
    scope: { kind: scope.kind as 'global' | 'realm', realm: scope.realm },
    ...pageResult(session, items,
    rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.context!.value) : null) };
}
