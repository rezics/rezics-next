import { parseLanguage } from '../display-language/tag.ts';
import { t } from 'elysia';
import { readScope, readId, readPosition, ratingRead } from '../work/read-contract.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadUnavailable, type ReadRow, type WorkReadSession } from '../work/read-session.ts';
import { readWorkRating, readWorkRatingContexts } from '../work/read-rating.ts';
import { resolveTargets } from '../target/resolve.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { RATING_STANDING_CADENCE } from './context.ts';
import { TARGET_GRAINS, targetContextOwnerPattern, targetContextPattern, targetRatingSlotIri, assertRatingContextTarget, type TargetGrain } from './target.ts';
import { contextAcceptanceFilter, ratingAcceptanceTarget, assertRatingTargetAccepted, readContextAcceptance, type AcceptanceTarget } from './acceptance.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from './global.ts';
import { queryTargetRatingAggregate } from './target-aggregate.ts';
import { targetGrain, targetAggregateResult, meanDisplay } from './target-api.ts';
import { presentRatingQuestions } from './question-presentation-read.ts';

/** The caller's own current observation of a target, read with `scope=mine` and a Context. */
export const ownTargetRating = t.Object({ observation: readId, revisionHead: readId,
  availability: t.Union([t.Literal('available'), t.Literal('withdrawn')]),
  value: t.Nullable(t.Integer({ minimum: 1, maximum: 10 })) });

export const targetRatingRead = t.Object({ profile: t.Literal('target-rating-read-v1'), target: readId,
  targetGrain, scope: readScope, context: t.Nullable(readId),
  status: t.Union([t.Literal('available'), t.Literal('no-context')]),
  aggregationScope: t.Nullable(targetAggregateResult.properties.scope),
  scale: t.Nullable(t.Object({ min: t.Integer(), max: t.Integer(), step: t.Literal(1) })),
  count: t.Integer({ minimum: 0 }), mean: t.Nullable(t.Number()),
  displayThreshold: t.Nullable(t.Integer({ minimum: 1 })), meanDisplay: t.Nullable(meanDisplay),
  distribution: t.Array(t.Object({ value: t.Integer(), count: t.Integer({ minimum: 0 }) }), { maxItems: 10 }),
  /** Only for `scope=mine` with a Context: the caller's own observation, or null before their first rating. */
  own: t.Optional(t.Nullable(ownTargetRating)),
  sourcePosition: readPosition });

export const resourceRatingRead = t.Union([ratingRead, targetRatingRead]);

/** One slot, one current head: the same slot a write derives, so a read and a write always name the same observation. */
export async function readOwnTargetObservation(query: (sparql: string, limit: number) => Promise<ReadRow[]>,
  principalId: string, context: string, target: string) {
  const rows = await query(`PREFIX rv: <${RV}> SELECT ?observation ?head ?availability ?value WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?observation a rv:TargetRatingObservation ; rv:ratingContext ${iri(context)} ;
      rv:target ${iri(target)} ; rv:ratingSlot ${iri(targetRatingSlotIri(principalId, context, target))} ; rv:observationHead ?head }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:TargetRatingObservationRevision ; rv:ratingAvailability ?availability .
      OPTIONAL { ?head rv:ratingValue ?value }
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } } } } LIMIT 2`, 2);
  if (!rows.length) return null;
  const row = rows[0]!, availability = row.availability?.value === `${RV}Available` ? 'available' as const
    : row.availability?.value === `${RV}Withdrawn` ? 'withdrawn' as const : null;
  const value = row.value ? Number(row.value.value) : null;
  // A head whose revision cannot be read must not look like "no rating": the caller would write with a null head and be refused again.
  if (rows.length !== 1 || !row.observation || !row.head || !availability
    || availability === 'available' && !(Number.isInteger(value) && value! >= 1 && value! <= 10)
    || availability === 'withdrawn' && value !== null) throw new WorkReadUnavailable('Own target rating unavailable');
  return { observation: row.observation.value, revisionHead: row.head.value, availability, value };
}

/** Same exact target resolver as writes. Context pages use an IRI seek and P+1. */
function contextPattern(grain: TargetGrain, scope: { kind: string; realm: string | null }, target: AcceptanceTarget) {
  const owner = scope.kind === 'global' ? GLOBAL_RATING_POPULATION_OWNER : scope.kind === 'realm' ? scope.realm : null;
  if (!owner) return 'FILTER(false)';
  return `{ ${targetContextOwnerPattern(iri(owner), '?context')} }
    ?context a rv:TargetRatingContext ; rv:realm ${iri(owner)} ; rv:contextState rv:Active ;
      rv:question ?question ; rv:targetGrain rv:${TARGET_GRAINS[grain]} ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
      rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 .
    FILTER NOT EXISTS { ?context rv:protectionHead ?contextProtection }
    ${contextAcceptanceFilter('?context', target)}`;
}
/** Projection discovery reads the subject's types without minting a place. Each
 * page adds at most 20 bounded acceptance reads to the shared session budget. */
export const PROJECTION_QUESTION_DISCOVERY_COST = { pageSize: 20, acceptanceQueries: 20, contextQueries: 1 } as const;
export async function readResourceRatingContexts(session: WorkReadSession, target: string, forProjection = false) {
  const [resolved] = await resolveTargets(session, [target], 'rating');
  if (resolved!.base === 'work' && !forProjection) {
    const page = await readWorkRatingContexts(session, target);
    return { ...page, items: await presentRatingQuestions(session.deps.environment, page.items, session.displayLanguages) };
  }
  if (forProjection && resolved!.base === 'projection') throw new WorkReadInvalid('Projection discovery needs a subject');
  const grain = forProjection ? 'projection' : resolved!.base as TargetGrain, scope = await session.scope();
  const limit = forProjection ? Math.min(session.options.limit ?? 20, PROJECTION_QUESTION_DISCOVERY_COST.pageSize) : session.options.limit ?? 20;
  const acceptance = await ratingAcceptanceTarget(session, resolved!);
  const binding = ['target-rating-contexts-v1', target, grain, scope];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?context ?question WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(grain, scope, acceptance)} }
    ${cursor ? `FILTER(STR(?context) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?context) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.context || !row.question || !parseLanguage(row.question['xml:lang'] ?? '')) || new Set(rows.map(row => row.context!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Target Context inventory ambiguous');
  }
  const page = rows.slice(0, limit);
  const policies = forProjection ? await Promise.all(page.map(row => readContextAcceptance(session, row.context!.value))) : [];
  const items = await presentRatingQuestions(session.deps.environment, page.map((row, index) => ({ context: row.context!.value, question: row.question!.value,
    language: row.question!['xml:lang']!, targetGrain: grain,
    ...(forProjection ? { acceptedFrameDimensions: policies[index]!.acceptedFrameDimensions ?? null } : {}),
    owner: { kind: scope.kind === 'global' ? 'global' as const : 'realm' as const,
      id: scope.kind === 'global' ? GLOBAL_RATING_POPULATION_OWNER : scope.realm! },
    scale: { min: 1, max: 10, step: 1 as const } })), session.displayLanguages);
  return { scope, ...pageResult(session, items,
  rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.context!.value) : null) };
}
/** A Context the caller cannot see answers like a missing one before its acceptance policy or grain is read. */
async function assertRatingContextVisible(session: WorkReadSession, context: string) {
  const rows = await session.query(`SELECT ?grain WHERE { ${targetContextPattern(context)} } LIMIT 2`, 2);
  if (rows.length !== 1) throw new WorkReadMissing('Target Context unavailable');
}
export async function readResourceRating(session: WorkReadSession, target: string, selectedContext?: string) {
  const [resolved] = await resolveTargets(session, [target], 'rating');
  if (resolved!.base === 'work') return readWorkRating(session, target, selectedContext);
  const grain = resolved!.base as TargetGrain, scope = await session.scope();
  if (selectedContext) await assertRatingContextVisible(session, selectedContext);
  if (scope.kind === 'mine' && selectedContext) {
    // Mine counts only the caller's own observation: private to the principal, so the figures are theirs alone.
    await assertRatingContextTarget(session, selectedContext, resolved!);
    const principalId = await session.deps.access.activePrincipalId(session.principal!);
    if (!principalId) throw new WorkReadMissing('Reader is unavailable');
    const own = await readOwnTargetObservation((sparql, limit) => session.query(sparql, limit), principalId, selectedContext, target);
    const value = own?.value ?? null;
    return { profile: 'target-rating-read-v1' as const, target, targetGrain: grain, scope, context: selectedContext,
      status: 'available' as const, aggregationScope: null, scale: { min: 1, max: 10, step: 1 as const },
      count: value === null ? 0 : 1, mean: value, displayThreshold: null,
      meanDisplay: value === null ? 'no-data' as const : 'shown' as const,
      distribution: Array.from({ length: 10 }, (_, index) => ({ value: index + 1, count: value === index + 1 ? 1 : 0 })),
      own, sourcePosition: session.position };
  }
  if (selectedContext) await assertRatingTargetAccepted(session, selectedContext, resolved!);
  const acceptance = await ratingAcceptanceTarget(session, resolved!);
  const rows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(grain, scope, acceptance)} ${selectedContext ? `VALUES ?context { ${iri(selectedContext)} }` : ''}
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
