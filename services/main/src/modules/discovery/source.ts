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
  type ReadPosition,
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
import type { DeliveredMainEvent } from '../outbox/relay.ts';
import {
  compareRelayPositions,
  MAIN_RELAY_STREAM_SCOPE,
  type RelayHandoffPosition,
} from '../outbox/relay-position.ts';
import { FusekiQueryResponseTooLarge } from '../../infrastructure/fuseki.ts';
import { DISCOVERY_DELTA_COST, type DiscoveryChanges } from './changes.ts';
import { discoveryEventEffect, discoveryEventWorks, type DiscoveryEventInput } from './effects.ts';
import { invalidWorkReadSource } from '../work/read-source-fault.ts';

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
    coverage: RelayHandoffPosition,
    afterGraph: ReadPosition,
    basis?: OwnedDiscoveryBasis,
    session?: Pick<WorkReadSession, 'query'>,
  ): Promise<DiscoveryChanges | null> {
    if (
      coverage.streamScope !== MAIN_RELAY_STREAM_SCOPE ||
      coverage.dataEpoch !== afterGraph.dataEpoch ||
      !/^(0|[1-9][0-9]{0,99})$/.test(afterGraph.sequence)
    )
      return null;
    try {
      compareRelayPositions(coverage, {
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: afterGraph.dataEpoch,
        sequence: '0',
      });
    } catch {
      return null;
    }
    const afterGraphSequence = BigInt(afterGraph.sequence);
    // A boundary older than the delta budget already disables reuse. Bound the
    // backward header probe too, even for long runs of empty or newer cuts.
    // MATERIALIZED keeps the position and its one boundary-envelope check out
    // of the page join's per-row index condition.
    const rows = (
      await this.pool.query<{
        after_sequence: string;
        coverage_stream_scope: string;
        coverage_data_epoch: string;
        coverage_sequence: string;
        coverage_unresolved: boolean;
        boundary_valid: boolean;
        stream_scope: string | null;
        data_epoch: string | null;
        sequence: string | null;
        batch_id: string | null;
        routing_epoch: string | null;
        event_count: number | null;
        event_id: string | null;
        envelope: DeliveredMainEvent | null;
      }>(
        `WITH coverage AS MATERIALIZED (
        SELECT c.stream_scope,c.data_epoch,c.sequence::text AS sequence,
          COALESCE(boundary.sequence,0)::text AS after_sequence,
          EXISTS (SELECT 1 FROM relay.delivered_batch unresolved
            WHERE unresolved.stream_scope=c.stream_scope AND unresolved.data_epoch=c.data_epoch
              AND unresolved.sequence <= c.sequence AND unresolved.graph_sequence IS NULL) AS coverage_unresolved,
          boundary.sequence IS NULL OR EXISTS (
                SELECT 1 FROM relay.delivered_event e
                WHERE e.stream_scope=c.stream_scope AND e.data_epoch=c.data_epoch AND e.sequence=boundary.sequence
                  AND e.source='https://rezics.com/services/main'
                  AND e.envelope #>> '{data,sourcePosition,datasetId}'='product'
                  AND e.envelope #>> '{data,sourcePosition,dataEpoch}'=c.data_epoch
                  AND e.envelope #>> '{data,sourcePosition,sequence}'=boundary.graph_sequence::text
              ) AS boundary_valid
        FROM relay.checkpoint c
        LEFT JOIN LATERAL (
          SELECT b.sequence,b.graph_sequence FROM relay.delivered_batch b
          WHERE b.stream_scope=c.stream_scope AND b.data_epoch=c.data_epoch
            AND b.sequence <= c.sequence
            AND b.sequence >= GREATEST(1,c.sequence-${DISCOVERY_REFRESH_INPUT_COST.batches})
            AND b.event_count > 0 AND b.graph_sequence <= $5::numeric
          ORDER BY b.sequence DESC LIMIT 1
        ) boundary ON true
        WHERE c.consumer=$1 AND c.stream_scope=$2 AND c.data_epoch=$3 AND c.sequence >= $4::numeric
      )
      SELECT coverage.after_sequence,coverage.stream_scope AS coverage_stream_scope,
        coverage.data_epoch AS coverage_data_epoch,coverage.sequence AS coverage_sequence,
        coverage.coverage_unresolved,coverage.boundary_valid,
        b.stream_scope,b.data_epoch,b.sequence::text,b.batch_id,b.routing_epoch,b.event_count,
        e.event_id,e.envelope
      FROM coverage
      LEFT JOIN relay.delivered_batch b ON b.stream_scope=coverage.stream_scope
        AND b.data_epoch=coverage.data_epoch AND b.sequence > coverage.after_sequence::numeric
        AND b.sequence <= coverage.sequence::numeric
        AND coverage.sequence::numeric-coverage.after_sequence::numeric <= ${DISCOVERY_REFRESH_INPUT_COST.batches}
      LEFT JOIN relay.delivered_event e ON e.stream_scope=b.stream_scope
        AND e.data_epoch=b.data_epoch AND e.sequence=b.sequence
      ORDER BY b.sequence,e.event_id LIMIT $6`,
        [
          this.consumer,
          coverage.streamScope,
          coverage.dataEpoch,
          coverage.sequence,
          afterGraph.sequence,
          DISCOVERY_REFRESH_INPUT_COST.events + 1,
        ],
      )
    ).rows;
    if (!rows.length) return null;
    if (rows[0]!.coverage_unresolved) {
      throw new WorkReadUnavailable('Main discovery graph cut is unavailable; repair with task main:relay -- --repair-graph-cuts --data-epoch <epoch>');
    }
    if (rows[0]!.boundary_valid === false) return null;
    const afterSequence = rows[0]!.after_sequence;
    const count = BigInt(coverage.sequence) - BigInt(afterSequence);
    if (count < 0n || count > BigInt(DISCOVERY_REFRESH_INPUT_COST.batches)) return null;
    if (
      rows.some(
        (row) =>
          row.coverage_stream_scope !== coverage.streamScope ||
          row.coverage_data_epoch !== coverage.dataEpoch ||
          row.coverage_sequence !== coverage.sequence,
      )
    )
      return null;
    const batchRows = rows.filter((row) => row.sequence !== null);
    if (
      rows.length > DISCOVERY_REFRESH_INPUT_COST.events + 1 ||
      batchRows.filter((row) => row.event_id !== null).length > DISCOVERY_REFRESH_INPUT_COST.events
    )
      return null;
    if (count === 0n) return batchRows.length ? null : { works: [], created: [] };
    const targets = [
      ...new Set(
        batchRows.flatMap((row) => {
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
    for (const row of batchRows) {
      if (!row.sequence || !row.stream_scope || !row.data_epoch || !row.batch_id ||
          !row.routing_epoch || row.event_count === null) return null;
      batches.set(row.sequence, [...(batches.get(row.sequence) ?? []), row]);
      if (row.event_id === null) {
        if (row.envelope || row.event_count !== 0) return null;
        continue;
      }
      const event = row.envelope,
        data = event?.data,
        receipt = data?.receipt;
      const rowPosition = {
        streamScope: row.stream_scope,
        dataEpoch: row.data_epoch,
        sequence: row.sequence,
      };
      const sourcePosition = data?.sourcePosition;
      if (
        !event ||
        !data ||
        !receipt ||
        event.specversion !== '1.0' ||
        event.source !== 'https://rezics.com/services/main' ||
        event.id !== row.event_id ||
        data.batchId !== row.batch_id ||
        data.routingEpoch !== row.routing_epoch ||
        !sourcePosition ||
        sourcePosition.datasetId !== 'product' ||
        sourcePosition.dataEpoch !== afterGraph.dataEpoch ||
        !/^(0|[1-9][0-9]{0,99})$/.test(sourcePosition.sequence) ||
        BigInt(sourcePosition.sequence) <= afterGraphSequence
      )
        return null;
      if (data.relayPosition) {
        try {
          if (compareRelayPositions(data.relayPosition, rowPosition) !== 0) return null;
        } catch {
          return null;
        }
      }
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
    }
    if (batches.size !== Number(count)) return null;
    let next = BigInt(afterSequence) + 1n;
    for (const [sequence, batch] of batches) {
      const events = batch.filter((row) => row.event_id !== null);
      const first = batch[0]!;
      if (
        BigInt(sequence) !== next++ ||
        batch.some(
          (row) =>
            row.event_count !== events.length ||
            row.batch_id !== first.batch_id ||
            row.routing_epoch !== first.routing_epoch,
        ) ||
        (first.event_count === 0) !== (events.length === 0) ||
        new Set(events.map((row) => row.event_id)).size !== events.length ||
        events
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
      ?context a rv:RatingContext ; rv:realm ${iri(basis.realm!)} ; rv:ratingScaleMin ?scaleMin ; rv:ratingScaleMax ?scaleMax .`
        : `?context a rv:GlobalRatingContext ; rv:ratingPopulationOwner ${iri(GLOBAL_RATING_POPULATION_OWNER)} ;
      rv:ratingScaleMin ?scaleMin ; rv:ratingScaleMax ?scaleMax .`
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
      if (!row.work) throw invalidWorkReadSource('Discovery candidate is incomplete');
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
      BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?statement a rdf:Statement ; rdf:subject ?main ; rdf:predicate rv:classifiedAs } } AS ?classified)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?credit rv:work ${iri(work)} ; rv:creditRevision ?creditRevision } } AS ?credited)
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
    if (!row.work) throw invalidWorkReadSource('Discovery source is incomplete');
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
      throw invalidWorkReadSource('Discovery source is incomplete');
    }
    if (
      own!.length > 3 ||
      ['head', 'main', 'sequence', 'epochOrder', 'classified', 'credited'].some(
        (key) => new Set(own!.map((row) => row[key]?.value)).size !== 1,
      )
    )
      throw invalidWorkReadSource('Discovery source is ambiguous');
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
      rating?.sum ?? 0;
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
            scale: rating.scale,
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
