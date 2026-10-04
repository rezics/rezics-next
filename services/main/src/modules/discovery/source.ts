import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { RATING_STANDING_CADENCE } from '../rating/context.ts';
import { GRAPHS, iri, lit, WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import {
  readPublicWorkClassifications,
  WORK_CLASSIFICATION_BATCH_COST,
} from '../work/read-classifications.ts';
import { queryWorkStandingRating, queryWorkStandingRatings } from '../rating/global-aggregate.ts';
import { standingRatingSlotIri } from '../rating/observation.ts';
import {
  publicWork,
  WorkReadInvalid,
  WorkReadLimit,
  WorkReadMissing,
  WorkReadUnavailable,
  type WorkReadSession,
} from '../work/read-session.ts';
import {
  DISCOVERY_COST,
  type DiscoveryBasis,
  type OwnedDiscoveryBasis,
  type ProjectedWork,
} from './contract.ts';
import { readEpochOrder } from './lineage.ts';
import { primaryDiscoveryCreditBatch, DISCOVERY_CREDIT_BATCH_COST } from './credits.ts';
import type { Pool } from 'pg';
import type { MainCloudEvent } from '../outbox/relay.ts';
import { FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';
import { DISCOVERY_DELTA_COST, type DiscoveryChanges } from './changes.ts';
import { discoveryEventEffect, discoveryEventWorks, type DiscoveryEventInput } from './effects.ts';

export const DISCOVERY_REFRESH_INPUT_COST = {
  queries: 1,
  batches: DISCOVERY_DELTA_COST.batches,
  events: DISCOVERY_DELTA_COST.events,
  birthQueries: 1,
  birthRows: DISCOVERY_DELTA_COST.events,
  targetQueries: 1,
  targetRows: DISCOVERY_DELTA_COST.events,
} as const;

/** One statement sees batch headers and their events at the same SQL snapshot:
 * https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED
 * (reviewed 2026-10-03). Never scan relay coverage from sequence zero per tick. */
export class DiscoveryRefreshInputs {
  constructor(
    private readonly pool: Pick<Pool, 'query'>,
    private readonly consumer: string,
  ) {}

  async read(
    position: { dataEpoch: string; sequence: string },
    after: string,
    basis?: OwnedDiscoveryBasis,
    session?: Pick<WorkReadSession, 'query'>,
  ): Promise<DiscoveryChanges | null> {
    const count = BigInt(position.sequence) - BigInt(after);
    if (count === 0n) return { works: [], created: [] };
    if (count < 0n || count > BigInt(DISCOVERY_REFRESH_INPUT_COST.batches)) return null;
    const rows = (
      await this.pool.query<{
        sequence: string;
        batch_id: string;
        routing_epoch: string;
        event_count: number;
        event_id: string | null;
        envelope: MainCloudEvent | null;
      }>(
        `SELECT b.sequence::text,
        b.batch_id,b.routing_epoch,b.event_count,e.event_id,e.envelope
      FROM relay.checkpoint c JOIN relay.delivered_batch b ON b.data_epoch=c.data_epoch
      LEFT JOIN relay.delivered_event e ON e.data_epoch=b.data_epoch AND e.sequence=b.sequence
      WHERE c.consumer=$1 AND c.data_epoch=$2 AND c.sequence >= $4::numeric
        AND b.sequence > $3::numeric AND b.sequence <= $4::numeric
      ORDER BY b.sequence,e.event_id LIMIT $5`,
        [
          this.consumer,
          position.dataEpoch,
          after,
          position.sequence,
          DISCOVERY_REFRESH_INPUT_COST.events + 1,
        ],
      )
    ).rows;
    if (rows.length > DISCOVERY_REFRESH_INPUT_COST.events) return null;
    const targets = [
      ...new Set(
        rows.flatMap((row) => {
          const input = row.envelope?.data?.receipt as DiscoveryEventInput | undefined;
          return input?.action === 'rating.observation.set' &&
            input.outcome === 'succeeded' &&
            input.target &&
            !input.mainVersion &&
            (!basis || basis.context === input.ratingContext)
            ? [input.target]
            : [];
        }),
      ),
    ];
    const targetWorks = new Map<string, string>();
    if (targets.length) {
      if (
        !session ||
        targets.some((target) => !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target))
      )
        return null;
      const resolved = await session
        .query(
          `SELECT ?target ?work WHERE {
        VALUES ?target { ${targets.map(iri).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?target a rv:MainVersion ; rv:work ?work .
          ?work rv:mainVersion ?target }
      } LIMIT ${targets.length + 1}`,
          targets.length,
        )
        .catch((error) => {
          if (error instanceof WorkReadLimit || error instanceof FusekiQueryResponseTooLarge)
            return null;
          throw error;
        });
      if (!resolved) return null;
      for (const row of resolved) {
        if (
          !row.target ||
          !row.work ||
          !targets.includes(row.target.value) ||
          targetWorks.has(row.target.value)
        )
          return null;
        targetWorks.set(row.target.value, row.work.value);
      }
    }
    const batches = new Map<string, typeof rows>();
    const works = new Set<string>(),
      created = new Set<string>();
    for (const row of rows) {
      const event = row.envelope,
        data = event?.data,
        receipt = data?.receipt;
      if (
        !event ||
        !data ||
        !receipt ||
        event.specversion !== '1.0' ||
        event.source !== 'https://rezics.com/services/main' ||
        event.id !== row.event_id ||
        data.batchId !== row.batch_id ||
        data.routingEpoch !== row.routing_epoch ||
        data.sourcePosition?.dataEpoch !== position.dataEpoch ||
        data.sourcePosition.sequence !== row.sequence
      )
        return null;
      const input = { ...receipt } as DiscoveryEventInput;
      if (input.target && !input.mainVersion && targetWorks.has(input.target)) {
        if (input.work && input.work !== targetWorks.get(input.target)) return null;
        input.work = targetWorks.get(input.target);
        input.mainVersion = input.target;
      }
      const effect = discoveryEventEffect(input, basis);
      if (!effect || effect === 'scope') return null;
      if (effect === 'work') {
        const local = discoveryEventWorks(input);
        if (!local) return null;
        for (const work of local) works.add(work);
        if (receipt.action === 'work.create' && receipt.outcome === 'succeeded')
          for (const work of local) created.add(work);
      }
      batches.set(row.sequence, [...(batches.get(row.sequence) ?? []), row]);
    }
    if (batches.size !== Number(count)) return null;
    let next = BigInt(after) + 1n;
    for (const [sequence, batch] of batches) {
      if (
        BigInt(sequence) !== next++ ||
        batch.some(
          (row) =>
            row.event_count !== batch.length ||
            row.batch_id !== batch[0]!.batch_id ||
            row.routing_epoch !== batch[0]!.routing_epoch,
        ) ||
        new Set(batch.map((row) => row.event_id)).size !== batch.length ||
        batch
          .map((row) => row.envelope!.data.ordinal)
          .sort((a, b) => a - b)
          .some((ordinal, index) => ordinal !== index)
      )
        return null;
    }
    return { works: [...works].sort(), created: [...created].sort() };
  }
}

/** Exact birth proof for callers retaining a population-only pin. Automatic
 * refresh additionally journals/reconciles edits instead of cancelling scans. */
export async function discoveryAppendOnly(
  session: WorkReadSession,
  changes: DiscoveryChanges,
  sequence: string,
) {
  const check = changes.works.filter((work) => !changes.created.includes(work));
  if (check.length > DISCOVERY_REFRESH_INPUT_COST.birthRows) return false;
  if (!check.length) return true;
  const rows = await session.query(
    `SELECT DISTINCT ?work WHERE {
    VALUES ?work { ${check.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.revisions)} { ?birth a rv:RevisionAnchor ; rv:component ?work ;
      rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?born .
      FILTER(?born > ${sequence}) FILTER NOT EXISTS { ?birth rv:predecessor ?previous } }
  } LIMIT ${check.length + 1}`,
    check.length,
  );
  return (
    new Set(rows.flatMap((row) => (row.work ? [row.work.value] : []))).size === check.length &&
    rows.every((row) => !!row.work && check.includes(row.work.value))
  );
}

const epochWidth = 1n << 63n;
export function discoveryRecentOrder(epoch: number, sequence: string): string {
  if (
    !Number.isInteger(epoch) ||
    epoch < 0 ||
    epoch > 32 ||
    !/^\d+$/.test(sequence) ||
    BigInt(sequence) >= epochWidth
  )
    throw new WorkReadLimit('Discovery recency exceeds its order domain');
  return (BigInt(epoch) * epochWidth + epochWidth - 1n - BigInt(sequence)).toString();
}

export async function admitDiscoveryBasis(session: WorkReadSession, basis: DiscoveryBasis) {
  if ((basis.scope === 'realm') !== !!basis.realm || (basis.scope === 'mine' && !basis.context)) {
    throw new WorkReadInvalid('Realm requires its Realm; Mine requires a standing rating Context');
  }
  await session.scope();
  if (!basis.context) return;
  const rows = await session.query(
    `SELECT ?context WHERE { GRAPH ${iri(GRAPHS.current)} {
    BIND(${iri(basis.context)} AS ?context)
    ?context rv:contextState rv:Active ; rv:targetGrain rv:MainVersion ;
      rv:ratingCadence ${iri(RATING_STANDING_CADENCE)} .
    ${
      basis.scope === 'realm'
        ? `${iri(basis.realm!)} rv:ratingContext ?context .
      ?context a rv:RatingContext ; rv:realm ${iri(basis.realm!)} ; rv:ratingScaleMin 1 ; rv:ratingScaleMax 10 .`
        : `?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:ratingScaleMin 1 ; rv:ratingScaleMax 5 .`
    }
  } } LIMIT 2`,
    1,
  );
  if (!rows.length) throw new WorkReadMissing('Rating Context is unavailable');
}

/** Projection reads identities and source evidence, never titles, covers,
 * language selections, metadata or serial counts that GET hydrates itself.
 * The candidate page is bounded; expensive owner checks debit a separate
 * per-page allowance so a dense population keeps the Work read envelope. */
export async function projectDiscoveryBatch(
  session: WorkReadSession,
  basis: DiscoveryBasis,
  after: string,
  options: { limit?: number; works?: readonly string[]; sequence?: string } = {},
) {
  await admitDiscoveryBasis(session, basis);
  const epochs = await readEpochOrder(session);
  const limit = Math.min(
    options.limit ?? DISCOVERY_COST.buildWorks,
    basis.context ? DISCOVERY_CREDIT_BATCH_COST.works : DISCOVERY_COST.buildWorks,
  );
  const selected = options.works?.filter((work) => work > after).slice(0, limit);
  const candidates =
    selected ??
    (
      await session.query(
        `SELECT DISTINCT ?work WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork }
    FILTER(STR(?work) > ${lit(after)})
  } ORDER BY STR(?work) LIMIT ${limit + 1}`,
        limit + 1,
      )
    ).map((row) => {
      if (!row.work) throw new WorkReadUnavailable('Discovery candidate is incomplete');
      return row.work.value;
    });
  if (!candidates.length) return { after, complete: true, items: [] };
  // Literal keys in every GRAPH join prevent ARQ from enumerating the
  // catalogue before joining an outer VALUES relation to the bounded page.
  const patterns = candidates
    .slice(0, limit)
    .map(
      (work) => `{ BIND(${iri(work)} AS ?work)
      ${publicWork(iri(work), '?main')}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(work)} schema:isPartOf ?parentWork } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ?legacyStructure a rv:Structure ;
          rv:structureProfile rv:BookComposition ; rv:selectedGeneration ?legacyGeneration .
          ?legacyPlacement a rv:OccurrencePlacement ; rv:generation ?legacyGeneration ;
            rv:occurrenceRole rv:ChapterRole ; schema:item ${iri(work)} .
          FILTER NOT EXISTS { ?legacyPlacement rv:removedBy ?legacyRemoval } } }
      ${
        options.sequence && options.sequence !== session.position.sequence
          ? `GRAPH ${iri(GRAPHS.revisions)} { ?birth a rv:RevisionAnchor ; rv:component ${iri(work)} .
        FILTER NOT EXISTS { ?birth rv:predecessor ?previous }
        FILTER NOT EXISTS { ?birth rv:dataEpoch ${lit(session.position.dataEpoch)} ; rv:sequence ?born .
          FILTER(?born > ${options.sequence}) } }`
          : ''
      }
    ${epochs}
    GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head .
      ${iri(work)} rv:mainVersion ?main .
      OPTIONAL { ${iri(work)} a ?type . VALUES ?type { ${WORK_SEMANTIC_TYPES.map((type) => `<${type}>`).join(' ')} } }
      BIND(EXISTS { { ?application a rv:ClassificationApplication ; rv:targetMainVersion ?main }
        UNION { ?statement a rdf:Statement ; rdf:subject ?main ; rdf:predicate rv:classifiedAs } } AS ?classified)
      BIND(EXISTS { ?credit rv:work ${iri(work)} ; rv:creditRevision ?creditRevision } AS ?credited)
    }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ; rv:component ${iri(work)} ;
      rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence }
  }`,
    )
    .join(' UNION ');
  const rows = await session.query(
    `SELECT DISTINCT ?work ?head ?main ?sequence ?epochOrder ?type
    ?classified ?credited WHERE { ${patterns} }
    ORDER BY STR(?work) LIMIT ${(limit + 1) * 4 + 1}`,
    (limit + 1) * 4,
  );
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.work) throw new WorkReadUnavailable('Discovery source is incomplete');
    groups.set(row.work.value, [...(groups.get(row.work.value) ?? []), row]);
  }
  // Explicit deltas also advance across Works that ceased to be public.
  const items: ProjectedWork[] = [];
  const classifiedWorks =
    basis.scope === 'mine'
      ? []
      : candidates
          .slice(0, limit)
          .filter((work) => groups.get(work)?.[0]?.classified?.value === 'true');
  const classificationsByWork = new Map<
    string,
    Awaited<ReturnType<typeof readPublicWorkClassifications>> extends Map<string, infer V>
      ? V
      : never
  >();
  for (
    let offset = 0;
    offset < classifiedWorks.length;
    offset += WORK_CLASSIFICATION_BATCH_COST.works
  ) {
    for (const [work, value] of await readPublicWorkClassifications(
      session,
      classifiedWorks.slice(offset, offset + WORK_CLASSIFICATION_BATCH_COST.works),
    ))
      classificationsByWork.set(work, value);
  }
  const creditedWorks = candidates
    .slice(0, limit)
    .filter(
      (work) => groups.get(work)?.[0]?.credited?.value === 'true' || !!session.deps.sourceAdoptions,
    );
  const creditsByWork = new Map<string, ProjectedWork['primaryCredits']>();
  for (let offset = 0; offset < creditedWorks.length; offset += DISCOVERY_CREDIT_BATCH_COST.works) {
    for (const [work, value] of await primaryDiscoveryCreditBatch(
      session,
      creditedWorks.slice(offset, offset + DISCOVERY_CREDIT_BATCH_COST.works),
    ))
      creditsByWork.set(work, value);
  }
  let checkpoint = after;
  const principal =
    basis.scope === 'mine' ? await session.deps.access.activePrincipalId(session.principal!) : null;
  if (basis.scope === 'mine' && !principal) throw new WorkReadMissing('Reader is unavailable');
  const access = session.deps.access;
  const ratingAccess = {
    readRatingAggregateInventory: (ctx: string, main: string, signal: AbortSignal) =>
      access.readRatingAggregateInventory!(ctx, main, signal),
    checkRatingAggregateFence: (generation: string, signal: AbortSignal) =>
      access.checkRatingAggregateFence!(generation, signal),
  };
  const ratings =
    basis.context && basis.scope !== 'mine'
      ? await queryWorkStandingRatings(session.deps.environment, ratingAccess, {
          kind: basis.scope === 'realm' ? 'realm' : 'global',
          context: basis.context,
          targets: candidates
            .slice(0, limit)
            .flatMap((work) =>
              groups.get(work)?.[0]?.main
                ? [{ work, mainVersion: groups.get(work)![0]!.main!.value }]
                : [],
            ),
        })
      : null;
  for (const work of candidates.slice(0, limit)) {
    const own = groups.get(work),
      first = own?.[0];
    if (!first?.head) {
      checkpoint = work;
      continue;
    }
    if (
      !first.main ||
      !first.sequence ||
      !first.epochOrder ||
      !first.classified ||
      !first.credited
    ) {
      throw new WorkReadUnavailable('Discovery source is incomplete');
    }
    if (
      own!.length > 3 ||
      ['head', 'main', 'sequence', 'epochOrder', 'classified', 'credited'].some(
        (key) => new Set(own!.map((row) => row[key]?.value)).size !== 1,
      )
    )
      throw new WorkReadUnavailable('Discovery source is ambiguous');
    const classified = basis.scope !== 'mine' && first.classified!.value === 'true';
    const credited = first.credited!.value === 'true' || !!session.deps.sourceAdoptions;
    checkpoint = work;
    const classifications = classified ? classificationsByWork.get(work) : null;
    // The classification owner also checks current Work disclosure. An
    // unavailable candidate is a hole, as in the former one-Work projector.
    if (classified && !classifications) continue;
    if (
      classifications?.after ||
      (classifications?.items.length ?? 0) > DISCOVERY_COST.termsPerWork
    ) {
      throw new WorkReadLimit('Discovery classification fanout exceeds its build budget');
    }
    const rating = ratings
      ? ratings.get(work)
      : basis.context
        ? await queryWorkStandingRating(session.deps.environment, ratingAccess, {
            kind: basis.scope === 'realm' ? 'realm' : 'global',
            context: basis.context,
            work,
            mainVersion: first.main!.value,
            ...(principal
              ? { onlySlot: standingRatingSlotIri(principal, basis.context, first.main!.value) }
              : {}),
          })
        : null;
    if (
      rating &&
      (rating.sourcePosition.dataEpoch !== session.position.dataEpoch ||
        rating.sourcePosition.sequence !== session.position.sequence)
    )
      throw new WorkReadUnavailable('Rating basis moved');
    if (basis.scope === 'mine' && !rating?.count) continue;
    const sum =
      rating?.histogram.reduce((total, count, index) => total + (index + 1) * count, 0) ?? 0;
    const item: ProjectedWork = {
      work,
      revision: first.head!.value,
      mainVersion: first.main!.value,
      primaryCredits: credited ? (creditsByWork.get(work) ?? []) : [],
      types: own!.flatMap((row) => (row.type ? [row.type.value] : [])).sort(),
      recentOrder: discoveryRecentOrder(Number(first.epochOrder!.value), first.sequence!.value),
      rating: rating?.count
        ? {
            context: basis.context!,
            count: rating.count,
            sum,
            mean: sum / rating.count,
            scale: { min: 1, max: basis.scope === 'realm' ? 10 : 5 },
          }
        : null,
      classifications:
        classifications?.items.map(({ sense, concept, decision, source }) => ({
          sense,
          concept,
          decision,
          source,
        })) ?? [],
    };
    items.push(item);
  }
  const complete = selected
    ? checkpoint === options.works!.at(-1)
    : candidates.length <= limit && checkpoint === candidates.at(-1);
  return { after: checkpoint, complete: candidates.length === 0 || complete, items };
}

export async function projectDiscoveryWork(
  session: WorkReadSession,
  basis: DiscoveryBasis,
  after: string,
) {
  const result = await projectDiscoveryBatch(session, basis, after, { limit: 1 });
  return { after: result.after, complete: result.complete, item: result.items[0] ?? null };
}
