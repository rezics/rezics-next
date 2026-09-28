import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { GRAPHS, iri, lit, WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import { readWorkClassifications } from '../work/read-classifications.ts';
import { queryWorkStandingRating } from '../rating/global-aggregate.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import { publicWork, WorkReadInvalid, WorkReadLimit, WorkReadMissing, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { DISCOVERY_COST, type DiscoveryBasis, type ProjectedWork } from './contract.ts';
import { readEpochOrder } from './lineage.ts';
import { primaryDiscoveryCredits } from './credits.ts';

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

/** Projection reads identities and source evidence, never titles, covers,
 * language selections, metadata or serial counts that GET hydrates itself.
 * The candidate page is bounded; expensive owner checks debit a separate
 * per-page allowance so a dense population keeps the Work read envelope. */
export async function projectDiscoveryBatch(session: WorkReadSession, basis: DiscoveryBasis, after: string,
  options: { limit?: number; works?: readonly string[]; sequence?: string } = {}) {
  await admitDiscoveryBasis(session, basis);
  const epochs = await readEpochOrder(session);
  const limit = options.limit ?? DISCOVERY_COST.buildWorks;
  const selected = options.works?.filter(work => work > after).slice(0, limit);
  const candidates = selected ?? (await session.query(`SELECT DISTINCT ?work WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork }
    FILTER(STR(?work) > ${lit(after)})
  } ORDER BY STR(?work) LIMIT ${limit + 1}`, limit + 1)).map(row => {
    if (!row.work) throw new WorkReadUnavailable('Discovery candidate is incomplete');
    return row.work.value;
  });
  if (!candidates.length) return { after, complete: true, items: [] };
  // ARQ does not push an outer VALUES binding through every GRAPH join.
  // Embed a one-Work delta's exact key in those patterns so it cannot scan the
  // public population before joining that binding (covered by the load test).
  const target = candidates.length === 1 ? iri(candidates[0]!) : '?work';
  // Explicit VALUES reaches TDB's Work-keyed lookups. A subquery under an
  // OPTIONAL made ARQ enumerate the entire public relation for every page.
  const rows = await session.query(`SELECT DISTINCT ?work ?head ?main ?sequence ?epochOrder ?type
    ?classified ?credited WHERE {
      VALUES ?work { ${candidates.slice(0, limit).map(iri).join(' ')} }
      ${publicWork(target, '?main')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${target} schema:isPartOf ?parentWork } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?legacyStructure a rv:Structure ;
          rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?legacyGeneration .
          ?legacyPlacement a rv:OccurrencePlacement ; rv:generation ?legacyGeneration ;
            rv:occurrenceRole rv:ChapterRole ; schema:item ${target} .
          FILTER NOT EXISTS { ?legacyPlacement rv:removedBy ?legacyRemoval } } }
      ${options.sequence && options.sequence !== session.position.sequence ? `GRAPH ${iri(GRAPHS.revisions)} { ?birth a rv:RevisionAnchor ; rv:component ${target} .
        FILTER NOT EXISTS { ?birth rv:predecessor ?previous }
        FILTER NOT EXISTS { ?birth rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?born .
          FILTER(?born > ${options.sequence}) } }` : ''}
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} { ${target} rv:head ?head .
      ${target} rv:mainVersion ?main .
      OPTIONAL { ${target} a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map(type => `<${type}>`).join(' ')} } }
      BIND(EXISTS { { ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main }
        UNION { ?statement a rdf:Statement ; rdf:subject ?main ; rdf:predicate rv:classifiedAs } } AS ?classified)
      BIND(EXISTS { ?credit rv:work ${target} ; rv:creditRevision ?creditRevision } AS ?credited)
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ${target} ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
  } ORDER BY STR(?work) LIMIT ${(limit + 1) * 4 + 1}`, (limit + 1) * 4);
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.work) throw new WorkReadUnavailable('Discovery source is incomplete');
    groups.set(row.work.value, [...(groups.get(row.work.value) ?? []), row]);
  }
  // Explicit deltas also advance across Works that ceased to be public.
  const items: ProjectedWork[] = [];
  let spent = 0, checkpoint = after;
  const principal = basis.scope === 'mine' ? await session.deps.access.activePrincipalId(session.principal!) : null;
  if (basis.scope === 'mine' && !principal) throw new WorkReadMissing('Reader is unavailable');
  for (const work of candidates.slice(0, limit)) {
    // The source attribution owner fences one batch of at most 64 Works.
    if (session.deps.sourceAdoptions && items.length === 64) break;
    const own = groups.get(work), first = own?.[0];
    if (!first?.head) { checkpoint = work; continue; }
    if (!first.main || !first.sequence || !first.epochOrder || !first.classified || !first.credited) {
      throw new WorkReadUnavailable('Discovery source is incomplete');
    }
    if (own!.length > 3 || ['head', 'main', 'sequence', 'epochOrder', 'classified', 'credited'].some(key =>
      new Set(own!.map(row => row[key]?.value)).size !== 1)) throw new WorkReadUnavailable('Discovery source is ambiguous');
    const classified = basis.scope !== 'mine' && first.classified!.value === 'true';
    const credited = first.credited!.value === 'true' || !!session.deps.sourceAdoptions;
    const cost = (classified ? 100 : 0) + (basis.context ? 2 : 0) + (credited ? 1 : 0);
    if (spent + cost > 120 && checkpoint !== after) break;
    spent += cost;
    checkpoint = work;
    const classifications = classified ? await readWorkClassifications(session, work).catch(error => {
      if (error instanceof WorkReadMissing) return false as const;
      throw error;
    }) : null;
    // The classification owner also checks current Work disclosure. An
    // unavailable candidate is a hole, as in the former one-Work projector.
    if (classifications === false) continue;
    if (classifications?.nextCursor || (classifications?.items.length ?? 0) > DISCOVERY_COST.termsPerWork) {
      throw new WorkReadLimit('Discovery classification fanout exceeds its build budget');
    }
    const access = session.deps.access;
    const rating = basis.context ? await queryWorkStandingRating(session.deps.environment, {
      readRatingAggregateInventory: (ctx, main, signal) => access.readRatingAggregateInventory!(ctx, main, signal),
      checkRatingAggregateFence: (generation, signal) => access.checkRatingAggregateFence!(generation, signal),
    }, { kind: basis.scope === 'realm' ? 'realm' : 'global', context: basis.context, work,
      mainVersion: first.main!.value, ...(principal ? { onlySlot: standingRatingSlotIri(principal, basis.context, first.main!.value) } : {}) }) : null;
    if (rating && (rating.sourcePosition.dataEpoch !== session.position.dataEpoch
      || rating.sourcePosition.sequence !== session.position.sequence)) throw new WorkReadUnavailable('Rating basis moved');
    if (basis.scope === 'mine' && !rating?.count) continue;
    const sum = rating?.histogram.reduce((total, count, index) => total + (index + 1) * count, 0) ?? 0;
    const item: ProjectedWork = { work, revision: first.head!.value, mainVersion: first.main!.value,
      primaryCredits: credited ? await primaryDiscoveryCredits(session, work) : [],
      types: own!.flatMap(row => row.type ? [row.type.value] : []).sort(),
      recentOrder: discoveryRecentOrder(Number(first.epochOrder!.value), first.sequence!.value),
      rating: rating?.count ? { context: basis.context!, count: rating.count, sum, mean: sum / rating.count,
        scale: { min: 1, max: basis.scope === 'realm' ? 10 : 5 } } : null,
      classifications: classifications?.items.map(({ sense, concept, decision, source }) =>
        ({ sense, concept, decision, source })) ?? [] };
    items.push(item);
  }
  const complete = selected ? checkpoint === options.works!.at(-1) : candidates.length <= limit && checkpoint === candidates.at(-1);
  return { after: checkpoint, complete: candidates.length === 0 || complete, items };
}

export async function projectDiscoveryWork(session: WorkReadSession, basis: DiscoveryBasis, after: string) {
  const result = await projectDiscoveryBatch(session, basis, after, { limit: 1 });
  return { after: result.after, complete: result.complete, item: result.items[0] ?? null };
}
