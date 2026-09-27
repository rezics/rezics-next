import { GRAPHS, iri, lit } from './activate.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import { queryWorkStandingRating } from '../rating/global-aggregate.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { fenceWorkBasis, readWorkBasis } from './read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

function contextPattern(scope: { kind: string; realm: string | null }) {
  return `${scope.kind === 'realm'
    ? `${iri(scope.realm!)} rv:ratingContext ?context . ?context a rv:RatingContext ; rv:contextState rv:Active .`
    : `?context a rv:GlobalRatingContext ; rv:contextState rv:Active ;
        rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .`}
    ?context rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:targetGrain rv:MainVersion .`;
}

export async function readWorkRatingContexts(session: WorkReadSession, work: string) {
  const basis = await readWorkBasis(session, work);
  const scope = await session.scope();
  const limit = session.options.limit ?? 20;
  const binding = ['rating-contexts', work, scope];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?context ?question ?min ?max WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${contextPattern(scope)}
      ?context rv:question ?question ; rv:ratingScaleMin ?min ; rv:ratingScaleMax ?max .
      FILTER(LANG(?question) = "en") }
    ${cursor ? `FILTER(STR(?context) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?context) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.context || !row.question || !row.min || !row.max)
    || new Set(rows.map(row => row.context!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Rating Context collection is ambiguous');
  }
  const page = rows.slice(0, limit);
  await fenceWorkBasis(session, basis);
  return { ...pageResult(session, page.map(row => ({ context: row.context!.value, question: row.question!.value,
    language: 'en' as const, scale: { min: Number(row.min!.value), max: Number(row.max!.value), step: 1 as const } })),
  rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.context!.value) : null), scope };
}

export async function readWorkRating(session: WorkReadSession, work: string, selectedContext?: string) {
  const basis = await readWorkBasis(session, work);
  const scope = await session.scope();
  const contextRows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(scope)}
    ${selectedContext ? `VALUES ?context { ${iri(selectedContext)} }` : ''}
  } } LIMIT 2`, 2);
  if (contextRows.length > 1) throw new WorkReadInvalid('Select a rating Context explicitly');
  if (selectedContext && !contextRows.length) throw new WorkReadMissing('Rating Context is unavailable');
  const context = contextRows[0]?.context?.value ?? null;
  if (!context) {
    await fenceWorkBasis(session, basis);
    return { profile: 'work-rating-read-v1' as const, work, mainVersion: basis.card.mainVersion, scope,
      context, status: 'no-context' as const, scale: null, count: 0, mean: null, distribution: [],
      sourcePosition: session.position };
  }
  const access = session.deps.access;
  if (!access.readRatingAggregateInventory || !access.checkRatingAggregateFence) {
    throw new WorkReadUnavailable('Rating inventory owner is unavailable');
  }
  const principal = scope.kind === 'mine' ? await access.activePrincipalId(session.principal!) : null;
  if (scope.kind === 'mine' && !principal) throw new WorkReadMissing('Reader is unavailable');
  const result = await queryWorkStandingRating(session.deps.environment, {
    readRatingAggregateInventory: (ctx, main, signal) => access.readRatingAggregateInventory!(ctx, main, signal),
    checkRatingAggregateFence: (generation, signal) => access.checkRatingAggregateFence!(generation, signal),
  }, { kind: scope.kind === 'realm' ? 'realm' : 'global', context, work, mainVersion: basis.card.mainVersion,
    ...(principal ? { onlySlot: standingRatingSlotIri(principal, context, basis.card.mainVersion) } : {}) });
  if (result.sourcePosition.sequence !== session.position.sequence
    || result.sourcePosition.dataEpoch !== session.position.dataEpoch) throw new WorkReadUnavailable('Rating basis moved');
  await fenceWorkBasis(session, basis);
  return { profile: 'work-rating-read-v1' as const, work, mainVersion: basis.card.mainVersion, scope,
    context, status: 'available' as const, scale: { ...result.scale, step: 1 as const },
    count: result.count, mean: result.mean, distribution: result.histogram.map((count, i) =>
      ({ value: result.scale.min + i, count })), sourcePosition: session.position };
}
