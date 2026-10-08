import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { readAgentCards } from '../profiles/read.ts';
import { conceptCountBasis } from '../discovery/concepts.ts';
import { namedAuthorCredit, type DiscoveryCredit, type OwnedDiscoveryBasis } from '../discovery/contract.ts';
import { RESOURCE_WORK_CARD_COST, resourceProjectedCard, type ResourceWorkCard } from './resource-contract.ts';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { optionalPreview } from './optional-preview.ts';

/** Work-keyed projection probes plus bounded current name batches. Optional
 * previews fail independently; membership and disclosure belong to the caller. */
export async function resourceWorkCards(session: WorkReadSession, works: readonly string[]) {
  const cost = RESOURCE_WORK_CARD_COST;
  if (works.length > cost.works || new Set(works).size !== works.length)
    throw new WorkReadUnavailable('Resource Work card batch exceeds its bound');
  const result = new Map<string, ResourceWorkCard>();
  for (const work of works) result.set(work, {
    primaryCredits: [], creditCount: { value: 0, kind: 'at-least' }, rating: null,
  });
  const projection = session.deps.discovery;
  if (!works.length || !projection) return result;
  const creditsBasis = await optionalPreview(session, () => conceptCountBasis(session));
  const active = creditsBasis && !creditsBasis.active.stale ? creditsBasis.active : null;
  const contexts = await optionalPreview(session, () => session.query(`SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ; rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
  } } ORDER BY STR(?context) LIMIT 1`, 1));
  // Same first standing question as the Work page, never a mean across questions.
  const context = contexts?.[0]?.context?.value;
  const ratingBasis: OwnedDiscoveryBasis | null = context
    ? { scope: 'global', realm: null, context, owner: null } : null;
  const ratingGeneration = ratingBasis
    ? await optionalPreview(session, () => projection.active(ratingBasis, session.position)) : null;
  const rated = ratingGeneration && !ratingGeneration.stale ? ratingGeneration : null;
  const generations = [active, rated].filter(row => row !== null);
  if (!generations.length) return result;
  const rows = await optionalPreview(session, () => projection.resourceCardPayloads(generations, works));
  const credits = new Map<string, Static<typeof resourceProjectedCard>['primaryCredits']>();
  const ratings = new Map<string, ResourceWorkCard['rating']>();
  for (const work of works) {
    const preview = active ? rows?.get(active.generation_id)?.get(work)?.primaryCredits : undefined;
    if (Value.Check(resourceProjectedCard.properties.primaryCredits, preview)
      && new Set(preview.map(credit => credit.id)).size === preview.length) credits.set(work, preview);
    const rating = rated ? rows?.get(rated.generation_id)?.get(work)?.rating : undefined;
    if (Value.Check(resourceProjectedCard.properties.rating, rating)
      && (!rating || rating.context === context && rating.scale.max === 5
        && rating.sum >= rating.count && rating.sum <= rating.count * 5 && rating.mean === rating.sum / rating.count))
      ratings.set(work, rating);
  }
  const selected = [...credits.values()].flat();
  const keys = [...new Set(selected.flatMap(credit => credit.key ? [credit.key] : []))];
  const [agents, sources] = await Promise.all([
    optionalPreview(session, () => readAgentCards(session,
      selected.flatMap(credit => credit.agent ? [credit.agent] : []), 'preview')),
    optionalPreview(session, async () => keys.length ? await session.deps.sourceAuthorNames?.batch(keys) : undefined),
  ]);
  // Preview source names are fenced here, rather than registering a mandatory
  // session-wide read whose failure would discard unrelated cards at delivery.
  const currentSources = sources && keys.length
    ? await optionalPreview(session, async () => session.deps.sourceAuthorNames?.batch(keys)) : null;
  const final = active && creditsBasis
    ? await optionalPreview(session, () => projection.active(creditsBasis.basis, session.position, active.generation_id)) : null;
  const finalRated = ratingBasis && rated
    ? await optionalPreview(session, () => projection.active(ratingBasis, session.position, rated.generation_id)) : null;
  for (const work of works) {
    const preview = final && !final.stale ? credits.get(work) : undefined;
    const primaryCredits = (preview ?? []).flatMap((credit): DiscoveryCredit[] => {
      if (credit.participantKind === 'external-reference') {
        const source = sources?.get(credit.key);
        const current = currentSources?.get(credit.key);
        const name = source && JSON.stringify(source) === JSON.stringify(current) ? source : null;
        return [{ ...credit, ...name, displayName: name?.displayName ?? null }];
      }
      const agent = agents?.get(credit.agent);
      const named = agent && namedAuthorCredit(credit, { displayName: agent.displayName, handle: agent.handle });
      return named ? [named] : [];
    });
    // Missing data supplies a zero lower bound, never an exact empty inventory.
    result.set(work, { primaryCredits, creditCount: { value: preview?.length ?? 0,
      kind: preview && preview.length < cost.credits ? 'exact' : 'at-least' },
    rating: finalRated && !finalRated.stale ? ratings.get(work) ?? null : null });
  }
  return result;
}
