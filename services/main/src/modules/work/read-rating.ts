import { GRAPHS, iri, lit } from './activate.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import { queryWorkStandingRating } from '../rating/global-aggregate.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { resolveTargets, TargetNotBound } from '../target/resolve.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadMissing,
  WorkReadUnavailable, type WorkReadSession } from './read-session.ts';

/** Existing aggregate inventory remains MainVersion-grained. Two bounded
 * target probes and one exact Work/MainVersion link replace published text selection. */
async function ratingTarget(session: WorkReadSession, work: string) {
  const [target] = await resolveTargets(session, [work], 'rating');
  if (target!.base !== 'work') throw new TargetNotBound();
  const rows = await session.query(`SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(target!.resource)} rv:mainVersion ?main ; rv:head ${iri(target!.revision)} .
    ?main a rv:MainVersion ; rv:work ${iri(target!.resource)} .
  } } LIMIT 2`, 2);
  if (rows.length !== 1 || !rows[0]?.main) throw new WorkReadUnavailable('Rating target is ambiguous');
  return { work: target!.resource, mainVersion: rows[0].main.value, revision: target!.revision };
}

async function fenceRatingTarget(session: WorkReadSession, work: string, revision: string) {
  const [target] = await resolveTargets(session, [work], 'rating');
  if (target!.revision !== revision) throw new WorkReadUnavailable('Rating target changed');
}

function contextPattern(scope: { kind: string; realm: string | null }) {
  return `${scope.kind === 'realm'
    ? `${iri(scope.realm!)} rv:ratingContext ?context . ?context a rv:RatingContext ; rv:contextState rv:Active .`
    : `?context a rv:GlobalRatingContext ; rv:contextState rv:Active ;
        rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .`}
    ?context rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:targetGrain rv:MainVersion .`;
}

export async function readWorkRatingContexts(session: WorkReadSession, work: string) {
  const basis = await ratingTarget(session, work);
  const scope = await session.scope();
  const limit = session.options.limit ?? 20;
  const binding = ['rating-contexts', work, scope];
  const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
  const rows = await session.query(`SELECT ?context ?question ?min ?max ?step WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${contextPattern(scope)}
      ?context rv:question ?question ; rv:ratingScaleMin ?min ; rv:ratingScaleMax ?max .
      OPTIONAL { ?context rv:ratingScaleStep ?step }
      FILTER(LANG(?question) = "en") }
    ${cursor ? `FILTER(STR(?context) > ${lit(cursor.after)})` : ''}
  } ORDER BY STR(?context) LIMIT ${limit + 1}`, limit + 1);
  if (rows.some(row => !row.context || !row.question || !row.min || !row.max)
    || new Set(rows.map(row => row.context!.value)).size !== rows.length) {
    throw new WorkReadUnavailable('Rating Context collection is ambiguous');
  }
  const page = rows.slice(0, limit);
  await fenceRatingTarget(session, work, basis.revision);
  return { ...pageResult(session, page.map(row => ({ context: row.context!.value, question: row.question!.value,
    language: 'en' as const, scale: { min: Number(row.min!.value), max: Number(row.max!.value), step: Number(row.step?.value ?? 1) } })),
  rows.length > limit ? encodeReadCursor(binding, session.position, page.at(-1)!.context!.value) : null), scope };
}

export async function readWorkRating(session: WorkReadSession, work: string, selectedContext?: string) {
  const basis = await ratingTarget(session, work);
  const scope = await session.scope();
  const contextRows = await session.query(`SELECT ?context ?question WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${contextPattern(scope)}
    ?context rv:question ?question . FILTER(LANG(?question) = "en")
    ${selectedContext ? `VALUES ?context { ${iri(selectedContext)} }` : ''}
  } } LIMIT 2`, 2);
  if (contextRows.length > 1) throw new WorkReadInvalid('Select a rating Context explicitly');
  if (selectedContext && !contextRows.length) throw new WorkReadMissing('Rating Context is unavailable');
  const context = contextRows[0]?.context?.value ?? null;
  if (!context) {
    await fenceRatingTarget(session, work, basis.revision);
    return { profile: 'work-rating-read-v1' as const, work, mainVersion: basis.mainVersion, scope,
      context, status: 'no-context' as const, aggregationScope: null, scale: null, count: 0, mean: null, distribution: [],
      sourcePosition: session.position };
  }
  const access = session.deps.access;
  if (!access.readRatingAggregateInventory || !access.checkRatingAggregateFence) {
    throw new WorkReadUnavailable('Rating inventory owner is unavailable');
  }
  const principal = scope.kind === 'mine' ? await access.activePrincipalId(session.principal!) : null;
  if (scope.kind === 'mine' && !principal) throw new WorkReadMissing('Reader is unavailable');
  const readAggregate = () => queryWorkStandingRating(session.deps.environment, {
    readRatingAggregateInventory: (ctx, main, signal, slot) => access.readRatingAggregateInventory!(ctx, main, signal, slot),
    checkRatingAggregateFence: (generation, signal, cuts) => access.checkRatingAggregateFence!(generation, signal, cuts),
  }, { kind: scope.kind === 'realm' ? 'realm' : 'global', context, work: basis.work, mainVersion: basis.mainVersion,
    ...(principal ? { onlySlot: standingRatingSlotIri(principal, context, basis.mainVersion) } : {}) });
  const result = await readAggregate();
  if (result.sourcePosition.dataEpoch !== session.position.dataEpoch
    || !session.fencesSelectedUnits && result.sourcePosition.sequence !== session.position.sequence) {
    throw new WorkReadUnavailable('Rating basis moved');
  }
  const selected = ({ sourcePosition: { sequence: _sequence, ...sourcePosition }, ...aggregate }: typeof result) =>
    ({ ...aggregate, sourcePosition });
  // The aggregate owner still verifies sealed evidence and recovery on every
  // read. Only the unrelated dataset diagnostic is absent from this page token.
  session.observeDependency(`work-rating:${context}:${basis.mainVersion}:${principal ?? 'all'}`,
    selected(result), async () => selected(await readAggregate()));
  await fenceRatingTarget(session, work, basis.revision);
  return { profile: 'work-rating-read-v1' as const, work, mainVersion: basis.mainVersion, scope,
    context, status: 'available' as const, scale: result.scale,
    aggregationScope: { question: contextRows[0]!.question!.value, grain: 'main-version' as const,
      population: scope.kind === 'mine' ? 'reader-account-principal' as const : result.populationPolicy,
      countedTarget: basis.mainVersion },
    count: result.count, mean: result.mean, distribution: result.histogram.map((count, i) =>
      ({ value: Number((result.scale.min + i * result.scale.step).toFixed(6)), count })), sourcePosition: session.position };
}
