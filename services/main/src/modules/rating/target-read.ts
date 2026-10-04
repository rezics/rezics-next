import { parseLanguage } from '../display-language/tag.ts';
import { t } from 'elysia';
import { readScope, readId, readPosition, ratingRead } from '../work/read-contract.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { readWorkRating, readWorkRatingContexts } from '../work/read-rating.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { RATING_STANDING_CADENCE } from './context.ts';
import { TARGET_GRAINS, type TargetGrain } from './target.ts';
import { queryTargetRatingAggregate } from './target-aggregate.ts';
import { targetGrain, targetAggregateResult, meanDisplay } from './target-api.ts';

export const targetRatingRead = t.Object({ profile: t.Literal('target-rating-read-v1'), target: readId,
  targetGrain, scope: readScope, context: t.Nullable(readId),
  status: t.Union([t.Literal('available'), t.Literal('no-context')]),
  aggregationScope: t.Nullable(targetAggregateResult.properties.scope),
  scale: t.Nullable(t.Object({ min: t.Integer(), max: t.Integer(), step: t.Literal(1) })),
  count: t.Integer({ minimum: 0 }), mean: t.Nullable(t.Number()),
  displayThreshold: t.Nullable(t.Integer({ minimum: 1 })), meanDisplay: t.Nullable(meanDisplay),
  distribution: t.Array(t.Object({ value: t.Integer(), count: t.Integer({ minimum: 0 }) }), { maxItems: 10 }),
  sourcePosition: readPosition });

export const resourceRatingRead = t.Union([ratingRead, targetRatingRead]);

/** Same exact target resolver as writes. Context pages use an IRI seek and P+1. */
function contextPattern(grain: TargetGrain, scope: { kind: string; realm: string | null }) {
  if (scope.kind !== 'realm' || !scope.realm) return 'FILTER(false)';
  return `${iri(scope.realm)} a rv:Realm ; rv:ratingContext ?context ; rv:realmState rv:Active ; rv:space ?space .
    ?space a rv:Space ; rv:realmCapability ${iri(scope.realm)} ; rv:disclosure rv:Public .
    FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
    FILTER NOT EXISTS { ${iri(scope.realm)} rv:protectionHead ?realmProtection }
    ?context a rv:TargetRatingContext ; rv:realm ${iri(scope.realm)} ; rv:contextState rv:Active ;
      rv:question ?question ; rv:targetGrain rv:${TARGET_GRAINS[grain]} ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
      rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 .
    FILTER NOT EXISTS { ?context rv:protectionHead ?contextProtection }`;
}
export async function readResourceRatingContexts(session: WorkReadSession, target: string) {
  const [resolved] = await resolveTargets(session, [target], 'rating');
  if (resolved!.base === 'work') return readWorkRatingContexts(session, target);
  const grain = resolved!.base as TargetGrain, scope = await session.scope(), limit = session.options.limit ?? 20;
  const binding = ['target-rating-contexts-v1', target, grain, scope];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?context ?question WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(grain, scope)} }
    ${cursor ? `FILTER(STR(?context) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?context) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.context || !row.question || !parseLanguage(row.question['xml:lang'] ?? '')) || new Set(rows.map(row => row.context!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Target Context inventory ambiguous');
  }
  const page = rows.slice(0, limit);
  return { scope, ...pageResult(session, page.map(row => ({ context: row.context!.value, question: row.question!.value,
    language: row.question!['xml:lang']!, targetGrain: grain, scale: { min: 1, max: 10, step: 1 as const } })),
  rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.context!.value) : null) };
}
export async function readResourceRating(session: WorkReadSession, target: string, selectedContext?: string) {
  const [resolved] = await resolveTargets(session, [target], 'rating');
  if (resolved!.base === 'work') return readWorkRating(session, target, selectedContext);
  const grain = resolved!.base as TargetGrain, scope = await session.scope();
  const rows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(grain, scope)} ${selectedContext ? `VALUES ?context { ${iri(selectedContext)} }` : ''}
  } } LIMIT 2`, 2);
  if (rows.length > 1) throw new WorkReadInvalid('Select a rating Context explicitly');
  if (!rows.length && selectedContext) throw new WorkReadMissing('Target Context unavailable');
  const context = rows[0]?.context?.value ?? null;
  if (!context) return { profile: 'target-rating-read-v1' as const, target, targetGrain: grain, scope, context,
    status: 'no-context' as const, aggregationScope: null, scale: null, count: 0, mean: null,
    displayThreshold: null, meanDisplay: null, distribution: [], sourcePosition: session.position };
  if (!session.deps.targetRatingInventory) throw new WorkReadUnavailable('Target inventory unavailable');
  const aggregate = await queryTargetRatingAggregate(session.deps.environment, session.deps.targetRatingInventory, { context, target });
  return { profile: 'target-rating-read-v1' as const, target, targetGrain: grain, scope, context, status: 'available' as const,
    aggregationScope: aggregate.scope, scale: aggregate.scale, count: aggregate.count, mean: aggregate.mean,
    displayThreshold: aggregate.displayThreshold, meanDisplay: aggregate.meanDisplay,
    distribution: aggregate.histogram.map((count, index) => ({ value: index + 1, count })), sourcePosition: session.position };
}
