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
  const targets = [...new Map(matches.filter(match => !match.rating)
    .map(match => [match.work, match])).values()];
  if (!targets.length) return { values: ratings, status: 'selected' as const };
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
  if (rows.length > 1) return { values: ratings, status: 'context-required' as const };
  const selected = rows[0]?.context?.value;
  if (!selected) return { values: ratings, status: 'no-context' as const };
  const access = session.deps.access;
  if (!access.readRatingAggregateInventory || !access.checkRatingAggregateFence) {
    throw new WorkReadUnavailable('Rating inventory owner is unavailable');
  }
  const completeTargets = targets.map(target => {
    if (!target.mainVersion) throw new WorkReadUnavailable('Search rating target is incomplete');
    return { work: target.work, mainVersion: target.mainVersion };
  });
  const batch = await queryWorkStandingRatings(session.deps.environment, {
      readRatingAggregateInventory: (ctx, main, signal) => access.readRatingAggregateInventory!(ctx, main, signal),
      checkRatingAggregateFence: (generation, signal) => access.checkRatingAggregateFence!(generation, signal),
    }, { targets: completeTargets, kind: realm ? 'realm' : 'global', context: selected });
  for (const target of completeTargets) {
    const rating = batch.get(target.work);
    if (!rating) throw new WorkReadUnavailable('Search rating batch is incomplete');
    if (rating.sourcePosition.dataEpoch !== session.position.dataEpoch
      || rating.sourcePosition.sequence !== session.position.sequence) throw new SearchSnapshotMoved('Search rating moved');
    if (rating.count) ratings.set(target.work, { context: selected, count: rating.count,
      sum: rating.histogram.reduce((sum, count, i) => sum + count * (rating.scale.min + i), 0),
      mean: rating.mean!, scale: rating.scale as { min: 1; max: 5 | 10 } });
  }
  return { values: ratings, status: 'selected' as const };
}
