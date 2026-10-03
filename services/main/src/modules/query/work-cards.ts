import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { readAgentCards } from '../profiles/read.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import { conceptCountBasis } from '../discovery/concepts.ts';
import type { DiscoveryCredit, OwnedDiscoveryBasis } from '../discovery/contract.ts';
import { RESOURCE_WORK_CARD_COST, resourceProjectedCard, type ResourceWorkCard } from './resource-contract.ts';
import { Value } from 'typebox/value';

/** Work-keyed projection probes plus bounded current name batches. No scan of
 * credit edges, observation histories or rater inventories occurs in a read. */
export async function resourceWorkCards(session: WorkReadSession, works: readonly string[]) {
  const cost = RESOURCE_WORK_CARD_COST;
  if (works.length > cost.works || new Set(works).size !== works.length)
    throw new WorkReadUnavailable('Resource Work card batch exceeds its bound');
  const result = new Map<string, ResourceWorkCard>();
  if (!works.length) return result;
  const projection = session.deps.discovery;
  if (!projection) throw new WorkReadUnavailable('Discovery projection is unavailable');
  const { basis, active } = await conceptCountBasis(session);
  if (active.stale) throw new WorkReadMoved('Work card projection changed');
  const contexts = await session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
  } } ORDER BY STR(?context) LIMIT 1`, 1);
  // Same first standing question as the Work page, never a mean across questions.
  const context = contexts[0]?.context?.value;
  const ratingBasis: OwnedDiscoveryBasis | null = context
    ? { scope: 'global', realm: null, context, owner: null } : null;
  const rated = ratingBasis ? await projection.active(ratingBasis, session.position) : null;
  if (rated?.stale) throw new WorkReadMoved('Global rating card projection changed');
  const rows = await projection.resourceCardPayloads([active, ...(rated ? [rated] : [])], works);
  for (const own of rows.values()) for (const payload of own.values()) {
    if (!Value.Check(resourceProjectedCard, payload)
      || new Set(payload.primaryCredits.map(credit => credit.id)).size !== payload.primaryCredits.length)
      throw new WorkReadUnavailable('Work card projection is invalid');
  }
  const credits = rows.get(active.generation_id);
  if (!credits) throw new WorkReadUnavailable('Work card projection is unavailable');
  const selected = [...credits.values()].flatMap(payload => payload.primaryCredits);
  if (selected.length > works.length * cost.credits)
    throw new WorkReadUnavailable('Projected credit preview exceeds its bound');
  const [agents, sources] = await Promise.all([
    readAgentCards(session, selected.flatMap(credit => credit.agent ? [credit.agent] : [])),
    readAuthorNames(session, selected.flatMap(credit => credit.key ? [credit.key] : [])),
  ]);
  for (const work of works) {
    const payload = credits.get(work);
    if (!payload) throw new WorkReadUnavailable('Work card projection is incomplete');
    const primaryCredits = payload.primaryCredits.flatMap((credit): DiscoveryCredit[] => {
      if (credit.participantKind === 'external-reference') return [{ ...credit,
        ...sources.get(credit.key), displayName: sources.get(credit.key)?.displayName ?? null }];
      const agent = agents.get(credit.agent);
      return agent ? [{ ...credit, displayName: agent.displayName, handle: agent.handle }] : [];
    });
    const rating = rated ? rows.get(rated.generation_id)?.get(work)?.rating : null;
    if (rated && rating === undefined) throw new WorkReadUnavailable('Global rating projection is incomplete');
    if (rating && (rating.context !== context || rating.scale.max !== 5
      || rating.sum < rating.count || rating.sum > rating.count * 5 || rating.mean !== rating.sum / rating.count))
      throw new WorkReadUnavailable('Global rating card differs from its selected question');
    // The existing projection retains a prefix only. A full prefix supplies
    // an honest lower bound, never an invented exact total or a live COUNT.
    result.set(work, { primaryCredits, creditCount: { value: payload.primaryCredits.length,
      kind: payload.primaryCredits.length < cost.credits ? 'exact' : 'at-least' }, rating: rating ?? null });
  }
  const final = await projection.active(basis, session.position, active.generation_id);
  const finalRated = ratingBasis && rated ? await projection.active(ratingBasis, session.position, rated.generation_id) : null;
  if (final.stale || finalRated?.stale) throw new WorkReadMoved('Work card projection changed during hydration');
  return result;
}
