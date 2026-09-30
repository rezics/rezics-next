import type { WorkReadSession } from '../work/read-session.ts';
import type { TargetReadSession } from '../target/resolve.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../work/read-session.ts';
import { resolveTargets, TargetNotBound } from '../target/resolve.ts';
import { GLOBAL_RATING_POPULATION_OWNER, GLOBAL_RATING_POPULATION } from '../rating/global.ts';
import { RATING_ACCOUNT_POPULATION, RATING_LATEST_MEAN_POLICY, RATING_STANDING_CADENCE } from '../rating/context.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import type { RatingLink, ReviewRow } from './store.ts';

export async function reviewTarget(session: TargetReadSession, context: string, work: string):
  Promise<{ mainVersion: string; realm: string | null }> {
  const [target] = await resolveTargets(session, [work], 'review');
  // The existing review inventory is MainVersion-only until a new grain profile owns it.
  if (target!.base !== 'work') throw new TargetNotBound();
  const rows = await session.query(`SELECT DISTINCT ?main ?realm WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(target!.resource)} rv:mainVersion ?main ;
      rv:head ${iri(target!.revision)} . ?main a rv:MainVersion ; rv:work ${iri(target!.resource)} . }
    GRAPH ${iri(GRAPHS.current)} {
      { ${iri(context)} a rv:GlobalRatingContext ; rv:contextState rv:Active ;
          rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
          rv:ratingPopulationPolicy ${iri(GLOBAL_RATING_POPULATION)} ;
          rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 5 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} . }
      UNION {
        ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ;
          rv:ratingContext ${iri(context)} .
        ?space a rv:Space ; rv:realmCapability ?realm ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ?space rv:disclosure rv:Private }
        FILTER NOT EXISTS { ?realm rv:protectionHead ?realmProtection }
        ${iri(context)} a rv:RatingContext ; rv:contextState rv:Active ; rv:realm ?realm ;
          rv:targetGrain rv:MainVersion ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 ;
          rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ;
          rv:ratingPopulationPolicy ${iri(RATING_ACCOUNT_POPULATION)} ;
          rv:ratingAggregationPolicy ${iri(RATING_LATEST_MEAN_POLICY)} .
        FILTER NOT EXISTS { ${iri(context)} rv:protectionHead ?contextProtection }
      }
    }
  } LIMIT 3`, 3);
  if (rows.length === 0) throw new WorkReadMissing('Review Work or Context is unavailable');
  if (rows.length !== 1 || !rows[0]?.main) throw new WorkReadUnavailable('Review target is ambiguous');
  return { mainVersion: rows[0].main.value, realm: rows[0].realm?.value ?? null };
}

export async function proveReviewRating(session: WorkReadSession, principalId: string,
  context: string, work: string,
  head: { mainVersion: string; observation: string; revision: string }): Promise<RatingLink> {
  const target = await reviewTarget(session, context, work);
  if (target.mainVersion !== head.mainVersion) throw new WorkReadMoved('Rating Work selection changed');
  const slot = standingRatingSlotIri(principalId, context, head.mainVersion);
  const type = target.realm ? 'RatingObservation' : 'GlobalRatingObservation';
  const revisionType = target.realm ? 'RatingObservationRevision' : 'GlobalRatingObservationRevision';
  const rows = await session.query(`SELECT ?value WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ${iri(head.observation)} a rv:${type} ; rv:ratingSlot ${iri(slot)} ;
        rv:ratingContext ${iri(context)} ; rv:targetMainVersion ${iri(head.mainVersion)} ;
        rv:observationHead ${iri(head.revision)} . }
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(head.revision)} a rv:${revisionType} ; rv:component ${iri(head.observation)} ;
        rv:ratingAvailability rv:Available ; rv:ratingValue ?value .
      FILTER NOT EXISTS { ${iri(head.revision)} a rv:ErasedRevision }
    }
  } LIMIT 2`, 2);
  const value = Number(rows[0]?.value?.value);
  if (rows.length !== 1 || !Number.isInteger(value) || value < 1 || value > (target.realm ? 10 : 5)) {
    throw new WorkReadMissing('Available rating is required for a review');
  }
  return { mainVersion: head.mainVersion, observation: head.observation,
    revision: head.revision, value, realm: target.realm };
}

export function reviewItem(row: ReviewRow, showSpoilers: boolean) {
  const withheld = row.spoiler && !showSpoilers;
  return { id: row.id, work: row.work, context: row.context, realm: row.realm,
    author: row.acting_subject, rating: row.rating,
    ratingObservation: row.rating_observation, ratingRevision: row.rating_revision,
    language: row.language, text: withheld ? null : row.body, spoiler: row.spoiler,
    spoilerWithheld: withheld, startedOn: row.started_on, finishedOn: row.finished_on,
    helpfulCount: row.helpful_count, viewerHelpful: row.viewer_helpful ?? false,
    viewerVoteRevision: row.viewer_vote_revision ?? null, revision: row.revision,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
