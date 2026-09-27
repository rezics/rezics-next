import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { readWorkBasis } from '../work/read-header.ts';
import { readWorkRating } from '../work/read-rating.ts';
import { publicWork, WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { DISCOVERY_COST, type DiscoveryBasis, type ProjectedWork } from './contract.ts';
import { readEpochOrder } from './lineage.ts';

const epochWidth = 1n << 63n;
export function discoveryRecentOrder(epoch: number, sequence: string): string {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch > 32 || !/^\d+$/.test(sequence)
    || BigInt(sequence) >= epochWidth) throw new WorkReadLimit('Discovery recency exceeds its order domain');
  return (BigInt(epoch) * epochWidth + epochWidth - 1n - BigInt(sequence)).toString();
}

export async function admitDiscoveryBasis(session: WorkReadSession, basis: DiscoveryBasis) {
  if ((basis.scope === 'realm') !== !!basis.realm || (basis.scope === 'mine' && !basis.context)) {
    throw new WorkReadInvalid('Realm requires its Realm; Mine requires a standing rating Context');
  }
  await session.scope();
  if (!basis.context) return;
  const rows = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    BIND(${iri(basis.context)} AS ?context)
    ?context rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ;
      rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
    ${basis.scope === 'realm' ? `${iri(basis.realm!)} rv:ratingContext ?context .
      ?context a rv:RatingContext ; rv:realm ${iri(basis.realm!)} ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 .`
    : `?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:ratingScaleMin 1 ; rv:ratingScaleMax 5 .`}
  } } LIMIT 2`, 1);
  if (!rows.length) throw new WorkReadMissing('Rating Context is unavailable');
}

/** One exact Work per resumable step. Rating manifests/inventory are verified
 * by the same owner as Work ratings, once at build time, never on browse GETs. */
export async function projectDiscoveryWork(session: WorkReadSession, basis: DiscoveryBasis, after: string) {
  await admitDiscoveryBasis(session, basis);
  const epochs = await readEpochOrder(session);
  const rows = await session.query(`SELECT DISTINCT ?work ?sequence ?epochOrder WHERE {
    ${epochs} ${publicWork('?work', '?main')}
    GRAPH ${iri(GRAPHS.current)} { ?work rv:head ?head }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ?work ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
    FILTER(STR(?work) > ${lit(after)})
  } ORDER BY STR(?work) LIMIT 2`, 2);
  const first = rows[0];
  if (!first) return { after, complete: true, item: null };
  if (!first.work || !first.sequence || !first.epochOrder
    || (rows.length === 2 && first.work.value === rows[1]?.work?.value)) {
    throw new WorkReadUnavailable('Discovery source is ambiguous');
  }
  const work = first.work.value;
  const next = { after: work, complete: rows.length === 1 };
  try {
    const header = await readWorkBasis(session, work);
    if (header.disclosure !== 'public') return { ...next, item: null };
    const classifications = basis.scope === 'mine' ? null : await readWorkClassifications(session, work);
    if (classifications?.nextCursor || (classifications?.items.length ?? 0) > DISCOVERY_COST.termsPerWork) {
      throw new WorkReadLimit('Discovery classification fanout exceeds its build budget');
    }
    const rating = basis.context ? await readWorkRating(session, work, basis.context) : null;
    if (basis.scope === 'mine' && !rating?.count) return { ...next, item: null };
    const sum = rating?.distribution.reduce((total, bin) => total + bin.value * bin.count, 0) ?? 0;
    const item: ProjectedWork = { work, revision: header.card.revision, mainVersion: header.card.mainVersion,
      types: header.card.types, recentOrder: discoveryRecentOrder(Number(first.epochOrder.value), first.sequence.value),
      rating: rating?.count ? { context: basis.context!, count: rating.count, sum, mean: sum / rating.count,
        scale: { min: 1, max: basis.scope === 'realm' ? 10 : 5 } } : null,
      classifications: classifications?.items.map(({ sense, concept, decision, source }) =>
        ({ sense, concept, decision, source })) ?? [] };
    return { ...next, item };
  } catch (error) {
    if (error instanceof WorkReadMissing) return { ...next, item: null };
    throw error;
  }
}
