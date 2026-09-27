import type { Pool } from 'pg';
import { GLOBAL_OBSERVATION_PROFILE, GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { STANDING_RATING_OBSERVATION_PROFILE } from '../rating/observation.ts';
import { readComponentState } from '../work/history.ts';
import { GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

export interface OwnRating { context: string; value: number | null;
  availability: 'available' | 'withdrawn'; revision: string }
interface RatingHead { context: string; work: string; main_version: string; observation: string;
  revision: string; slot: string; receipt: string; digest: string; valid: boolean }

/** One principal-leading indexed inventory read for at most two standing contexts
 * and 24 Works. Graph confirmation is O(heads), at most 48 bounded queries. */
export class ReaderLibraryRatings {
  constructor(private readonly pool: Pool) {}

  private async heads(principalId: string, contexts: string[], works: string[]): Promise<RatingHead[]> {
    if (!contexts.length || !works.length) return [];
    const rows = await this.pool.query<RatingHead>(`SELECT h.context, h.work, h.main_version,
      h.observation, h.revision, h.slot, a.graph_receipt AS receipt,
      a.request_digest AS digest,
      (a.state = 'sealed' AND a.graph_outcome = 'succeeded'
        AND a.action = 'rating.observation.set' AND a.principal_id = h.principal_id) AS valid
      FROM access.rating_aggregate_head h JOIN access.admission a ON a.id = h.admission_id
      WHERE h.principal_id = $1 AND h.context = ANY($2::text[]) AND h.work = ANY($3::text[])
        AND h.target_release IS NULL LIMIT 49`, [principalId, contexts, works]);
    if (rows.rows.length > 48 || rows.rows.some(row => !row.valid || !row.receipt)) {
      throw new WorkReadUnavailable('Rating inventory is incomplete');
    }
    return rows.rows;
  }

  async read(session: WorkReadSession, works: { work: string; main: string }[], realm?: string) {
    const contexts = await session.query(`SELECT ?kind ?context WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        { ?context a rv:GlobalRatingContext ; rv:contextState rv:Active ;
            rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} .
          BIND("global" AS ?kind) }
        ${realm ? `UNION { ${iri(realm)} a rv:Realm ; rv:realmState rv:Active ; rv:space ?space ;
            rv:ratingContext ?context .
          ?space a rv:Space ; rv:realmCapability ${iri(realm)} ; rv:disclosure rv:Public .
          ?context a rv:RatingContext ; rv:contextState rv:Active .
          BIND("realm" AS ?kind) }` : ''}
        ?context rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} ; rv:targetGrain rv:MainVersion .
      }
    } LIMIT 3`, 3);
    if (contexts.length > (realm ? 2 : 1)) throw new WorkReadUnavailable('Rating Context is ambiguous');
    const global = contexts.find(row => row.kind?.value === 'global')?.context?.value;
    const selectedRealm = contexts.find(row => row.kind?.value === 'realm')?.context?.value;
    const actor = session.options.actingSubject;
    if (!actor) throw new WorkReadUnavailable('Reader Agent is unavailable');
    const principalId = await session.deps.access.activePrincipalId(session.principal!);
    if (!principalId) throw new WorkReadUnavailable('Reader principal is unavailable');
    const heads = await this.heads(principalId, [global, selectedRealm].filter((x): x is string => !!x),
      works.map(item => item.work));
    if (heads.length) {
      const ratingPrincipal = await session.deps.account.verify(session.request, ['rating:read']);
      if (ratingPrincipal.issuer !== session.principal!.issuer
        || ratingPrincipal.subject !== session.principal!.subject) {
        throw new WorkReadUnavailable('Reader principal changed');
      }
    }
    const currentMain = new Map(works.map(item => [item.work, item.main]));
    const result = new Map<string, { global: OwnRating | null; realm: OwnRating | null }>();
    const budget = { bytesLeft: 512 * 1024, signal: AbortSignal.timeout(5_000) };
    for (const head of heads) {
      if (!await session.deps.access.canReadStandingRating(session.principal!, actor, head.context)) {
        throw new WorkReadUnavailable('Rating authority is unavailable');
      }
      if (head.main_version !== currentMain.get(head.work)) continue;
      const kind = head.context === global ? 'global' : head.context === selectedRealm ? 'realm' : null;
      if (!kind) throw new WorkReadUnavailable('Rating inventory context changed');
      const rows = await session.query(`SELECT ?availability ?value ?manifest WHERE {
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(head.observation)} a rv:${kind === 'global' ? 'GlobalRatingObservation' : 'RatingObservation'} ;
            rv:ratingContext ${iri(head.context)} ; rv:targetMainVersion ${iri(head.main_version)} ;
            rv:ratingSlot ${iri(head.slot)} ; rv:observationHead ${iri(head.revision)} .
        }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(head.revision)} a rv:${kind === 'global' ? 'GlobalRatingObservationRevision' : 'RatingObservationRevision'} ;
            rv:component ${iri(head.observation)} ; rv:ratingAvailability ?availability ; rv:manifest ?manifest .
          OPTIONAL { ${iri(head.revision)} rv:ratingValue ?value }
          FILTER NOT EXISTS { ${iri(head.revision)} a rv:ErasedRevision }
        }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(head.receipt)} rv:outcome rv:Succeeded ; rv:ratingObservation ${iri(head.observation)} ;
            rv:observationRevision ${iri(head.revision)} ; rv:requestDigest ${lit(head.digest)} .
        }
      } LIMIT 2`, 2);
      if (rows.length !== 1) throw new WorkReadUnavailable('Rating graph differs from inventory');
      const row = rows[0]!;
      const availability = row.availability?.value === `${RV}Available` ? 'available'
        : row.availability?.value === `${RV}Withdrawn` ? 'withdrawn' : null;
      const value = row.value ? Number(row.value.value) : null;
      if (!availability || (availability === 'available' && (!Number.isInteger(value) || value! < 1
        || value! > (kind === 'global' ? 5 : 10)))
        || (availability === 'withdrawn' && value !== null)) {
        throw new WorkReadUnavailable('Rating value is invalid');
      }
      try {
        const state = readComponentState(session.deps.environment.objectDirectory,
          row.manifest!.value, head.observation,
          kind === 'global' ? GLOBAL_OBSERVATION_PROFILE : STANDING_RATING_OBSERVATION_PROFILE,
          budget);
        if (state.revision !== head.revision || state.work !== head.work
          || state.mainVersion !== head.main_version || state.context !== head.context
          || state.slot !== head.slot || state.availability !== availability || state.value !== value) {
          throw new WorkReadUnavailable('Rating manifest differs from inventory');
        }
      } catch { throw new WorkReadUnavailable('Rating manifest is unavailable'); }
      const owned = result.get(head.work) ?? { global: null, realm: null };
      if (owned[kind]) throw new WorkReadUnavailable('Multiple own ratings for one Work');
      owned[kind] = { context: head.context, value, availability, revision: head.revision };
      result.set(head.work, owned);
    }
    for (const context of new Set(heads.map(head => head.context))) {
      if (!await session.deps.access.canReadStandingRating(session.principal!, actor, context)) {
        throw new WorkReadUnavailable('Rating authority changed');
      }
    }
    return result;
  }
}
