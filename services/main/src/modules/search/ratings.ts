import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { queryWorkStandingRatings } from '../rating/global-aggregate.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { SearchSnapshotMoved } from '../work/search-readiness.ts';
import type { ProjectedWork } from '../discovery/contract.ts';

/** One context lookup and one graph batch of existing sealed inventories per page.
 * No new aggregation policy: ratings share the Work owner's 100-slot cap and
 * debit the enclosing search's deadline/call/byte budget. Rated query matches
 * keep the exact rating that determined membership. */
export async function searchPageRatings(session: WorkReadSession,
  matches: readonly { work: string; mainVersion?: string; rating?: unknown }[],
  context?: 'main-version-default' | { kind: 'realm-local'; id: string }) {
  const ratings = new Map<string, ProjectedWork['rating']>();
  const unavailable = new Set<string>();
  const targets = [...new Map(matches.filter(match => !match.rating)
    .map(match => [match.work, match])).values()];
  if (!targets.length) return { values: ratings, unavailable, status: 'selected' as const };
  if (targets.length > 64) throw new WorkReadUnavailable('Search rating page exceeds its bound');
  const realm = typeof context === 'object' ? context.id : null;
  const rows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${realm ? `${iri(realm)} rv:ratingContext ?context . ?context a rv:RatingContext .`
    : `?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .`}
    ?context rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ;
      rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
  } } LIMIT 2`, 2);
  if (rows.length && !rows[0]?.context) {
    throw new WorkReadUnavailable('Search rating context is ambiguous');
  }
  if (rows.length > 1) return { values: ratings, unavailable, status: 'context-required' as const };
  const selected = rows[0]?.context?.value;
  if (!selected) return { values: ratings, unavailable, status: 'no-context' as const };
  const access = session.deps.access;
  if (!access.readRatingAggregateInventory || !access.checkRatingAggregateFence) {
    throw new WorkReadUnavailable('Rating inventory owner is unavailable');
  }
  const completeTargets = targets.map(target => {
    if (!target.mainVersion) throw new WorkReadUnavailable('Search rating target is incomplete');
    return { work: target.work, mainVersion: target.mainVersion };
  });
  const readBatch = () => queryWorkStandingRatings(session.deps.environment, {
      readRatingAggregateInventory: (ctx, main, signal) => access.readRatingAggregateInventory!(ctx, main, signal),
      checkRatingAggregateFence: (generation, signal, cuts) => access.checkRatingAggregateFence!(generation, signal, cuts),
    }, { targets: completeTargets, kind: realm ? 'realm' : 'global', context: selected, preview: true });
  const batch = await readBatch();
  const selectedBatch = (values: typeof batch) => completeTargets.map(target => {
    const rating = values.get(target.work);
    if (!rating) return [target.work, null];
    if (rating.sourcePosition.dataEpoch !== session.position.dataEpoch
      || !session.fencesSelectedUnits && rating.sourcePosition.sequence !== session.position.sequence) {
      throw new SearchSnapshotMoved('Search rating moved');
    }
    const { sourcePosition: { sequence: _sequence, ...sourcePosition }, ...aggregate } = rating;
    return [target.work, { ...aggregate, sourcePosition }];
  });
  // Keep absent/unavailable previews in the selected batch token, so a newly
  // available or changed aggregate cannot escape the page's delivery fence.
  session.observeDependency(`search-ratings:${JSON.stringify([realm, selected, completeTargets])}`,
    selectedBatch(batch), async () => selectedBatch(await readBatch()));
  for (const target of completeTargets) {
    const rating = batch.get(target.work);
    if (!rating) { unavailable.add(target.work); continue; }
    if (rating.count) ratings.set(target.work, { context: selected, count: rating.count,
      sum: rating.histogram.reduce((sum, count, i) => sum + count * (rating.scale.min + i), 0),
      mean: rating.mean!, scale: rating.scale as { min: 1; max: 5 | 10 } });
  }
  return { values: ratings, unavailable, status: 'selected' as const };
}
