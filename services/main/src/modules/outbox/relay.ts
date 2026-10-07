import { hash } from '../work/activate.ts';
import { readTitleControlReceipt } from '../work/title-control.ts';
import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { ownerOutboxEventHandler, type OwnerCloudEvent,
  type OwnerOutboxEventHandler } from './event-handlers.ts';
import { GLOBAL_RATING_POPULATION_OWNER } from '../rating/global.ts';
import { GLOBAL_TARGET_CONTEXT_SCOPE, GLOBAL_TARGET_CONTEXT_PROFILE } from '../rating/target-context-authority.ts';
import { MAIN_RELAY_STREAM_SCOPE } from './relay-position.ts';

const SOURCE = 'https://rezics.com/services/main';

export class OutboxGap extends Error {}
export class OutboxIncomplete extends Error {}

/** Search eligibility is recorded for original contributions (v1) and assessed public-domain texts (v2). */
export const eligibleRightsBasis = (basis: string | undefined) =>
  basis === `${RV}OriginalContribution` || basis === `${RV}PublicDomain`;
export class OutboxEpochChanged extends Error {}
export class OutboxRecoveryHold extends Error {}
export class RelayCheckpointConflict extends Error {}
export class RelayEventBlocked extends OutboxIncomplete {
  constructor(readonly batch: MainOutboxBatch, readonly eventId: string,
    readonly reason: string) {
    super(`outbox event ${eventId} at ${batch.dataEpoch}/${batch.sequence} blocks ordered relay: ${reason}`);
    this.name = 'RelayEventBlocked';
  }
}

/** Transport failures cannot decide whether an event is malformed. */
export function isRelayTransientFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (code && (/^08/.test(code) || ['57P01', '57P02', '57P03', '40001', '40P01',
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE'].includes(code))) return true;
  if (/timed out|timeout|network|fetch failed|connection|socket|ECONN|EPIPE|Fuseki query returned 5\d\d/i.test(error.message)) {
    return true;
  }
  return error.cause !== undefined && isRelayTransientFailure(error.cause);
}

export interface RelayCoverage {
  streamScope: string;
  consumer: string;
  dataEpoch: string;
  sequence: string;
  batchCount: string;
  batchDigest: string;
  eventCount: string;
  eventDigest: string;
}

interface CoverageScan {
  coverage: RelayCoverage;
  batch?: { batchId: string; routingEpoch: string; eventCount: number };
  events: { eventId: string; body: string }[];
}

async function scanRelayCoverage(client: PoolClient, consumer: string,
  targetSequence?: string): Promise<CoverageScan> {
  const checkpoint = await client.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
    'SELECT stream_scope, data_epoch, sequence FROM relay.checkpoint WHERE consumer = $1', [consumer]);
  const row = checkpoint.rows[0];
  if (!row) throw new RelayCheckpointConflict('relay checkpoint is uninitialized');
  if (row.stream_scope !== MAIN_RELAY_STREAM_SCOPE) throw new RelayCheckpointConflict('relay checkpoint stream differs');
  const uncheckpointed = await client.query(
    `SELECT 1 FROM relay.delivered_event WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $1 AND sequence > $2
     UNION ALL SELECT 1 FROM relay.delivered_batch WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $1 AND sequence > $2 LIMIT 1`,
    [row.data_epoch, row.sequence]);
  if (uncheckpointed.rowCount) {
    throw new RelayCheckpointConflict('delivered handoff exceeds relay checkpoint');
  }
  const batchDigest = createHash('sha256');
  let batchCount = 0n;
  let selectedBatch: CoverageScan['batch'];
  while (true) {
    const page = await client.query<{ sequence: string; batch_id: string;
      routing_epoch: string; event_count: number; actual_count: string }>(
      `SELECT batch.sequence::text, batch.batch_id, batch.routing_epoch, batch.event_count,
         (SELECT count(*)::text FROM relay.delivered_event AS event
          WHERE event.stream_scope = batch.stream_scope AND event.data_epoch = batch.data_epoch AND event.sequence = batch.sequence) AS actual_count
       FROM relay.delivered_batch AS batch
       WHERE batch.stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND batch.data_epoch = $1 AND batch.sequence > $2 AND batch.sequence <= $3
       ORDER BY batch.sequence LIMIT 1000`,
      [row.data_epoch, batchCount.toString(), row.sequence]);
    for (const batch of page.rows) {
      if (BigInt(batch.sequence) !== batchCount + 1n
        || batch.actual_count !== String(batch.event_count)) {
        throw new RelayCheckpointConflict('retained batch or event coverage is incomplete');
      }
      batchDigest.update(JSON.stringify([batch.sequence, batch.batch_id,
        batch.routing_epoch, batch.event_count]));
      batchDigest.update('\n');
      if (batch.sequence === targetSequence) {
        selectedBatch = { batchId: batch.batch_id, routingEpoch: batch.routing_epoch,
          eventCount: batch.event_count };
      }
      batchCount++;
    }
    if (page.rows.length < 1000) break;
  }
  if (batchCount !== BigInt(row.sequence)) {
    throw new RelayCheckpointConflict('retained batch coverage is incomplete');
  }
  const digest = createHash('sha256');
  let count = 0n;
  let afterSequence = '-1';
  let afterEventId = '';
  const selectedEvents: CoverageScan['events'] = [];
  while (true) {
    const page = await client.query<{ source: string; event_id: string;
      sequence: string; body: string }>(
      `SELECT event.source, event.event_id, event.sequence::text, event.envelope::text AS body
       FROM relay.delivered_event AS event WHERE event.stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND event.data_epoch = $1 AND event.sequence <= $2
         AND (event.sequence, event.event_id) > ($3::numeric, $4)
       ORDER BY event.sequence, event.event_id LIMIT 1000`,
      [row.data_epoch, row.sequence, afterSequence, afterEventId]);
    for (const event of page.rows) {
      digest.update(JSON.stringify([event.source, event.event_id, event.sequence, event.body]));
      digest.update('\n');
      if (event.sequence === targetSequence) {
        selectedEvents.push({ eventId: event.event_id, body: event.body });
      }
      count++;
      afterSequence = event.sequence;
      afterEventId = event.event_id;
    }
    if (page.rows.length < 1000) break;
  }
  return { coverage: { consumer, streamScope: row.stream_scope, dataEpoch: row.data_epoch, sequence: row.sequence,
    batchCount: batchCount.toString(), batchDigest: batchDigest.digest('hex'),
    eventCount: count.toString(), eventDigest: digest.digest('hex') },
    batch: selectedBatch, events: selectedEvents };
}

/**
 * Offline coverage of the durable handoff through one acknowledged checkpoint.
 * A passed client must be idle. This opens and commits its own snapshot and
 * leaves that checkout held; a session advisory lock survives the commit.
 */
export async function relayCoverage(pool: Pool, consumer: string, client?: PoolClient): Promise<RelayCoverage> {
  const held = client ?? await pool.connect();
  try {
    await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { coverage } = await scanRelayCoverage(held, consumer);
    await held.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await held.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    if (!client) held.release();
  }
}

/** Verify the full captured handoff and take one event/header from those same rows. */
export async function relayRetainedEventAt(pool: Pool, expected: RelayCoverage,
  sequence: string): Promise<{ eventId: string; envelope: MainCloudEvent;
    batch: { batchId: string; routingEpoch: string; eventCount: number } }> {
  // Pre-stream recovery cuts came exclusively from this Main handoff. Their
  // stored envelope digests survive the column-only migration unchanged.
  const expectedScope = expected.streamScope ?? MAIN_RELAY_STREAM_SCOPE;
  if (expectedScope !== MAIN_RELAY_STREAM_SCOPE || !/^[1-9][0-9]*$/.test(sequence) || !/^[0-9]+$/.test(expected.sequence)
    || BigInt(sequence) > BigInt(expected.sequence)) {
    throw new RelayCheckpointConflict('invalid retained event position');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { coverage, batch, events } = await scanRelayCoverage(client, expected.consumer, sequence);
    if (coverage.consumer !== expected.consumer || coverage.streamScope !== expectedScope || coverage.dataEpoch !== expected.dataEpoch
      || coverage.sequence !== expected.sequence || coverage.batchCount !== expected.batchCount
      || coverage.batchDigest !== expected.batchDigest || coverage.eventCount !== expected.eventCount
      || coverage.eventDigest !== expected.eventDigest || !batch || events.length !== 1
      || batch.eventCount !== 1) {
      throw new RelayCheckpointConflict('retained event coverage or batch differs');
    }
    const event = events[0]!;
    const envelope = retainedEnvelopePosition(JSON.parse(event.body) as MainCloudEvent,
      coverage.streamScope, coverage.dataEpoch, sequence);
    await client.query('COMMIT');
    return { eventId: event.eventId, envelope, batch };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export interface RetainedRelayBatch {
  streamScope: string;
  sequence: string;
  batchId: string;
  routingEpoch: string;
  events: MainCloudEvent[];
}

function retainedEnvelopePosition(event: MainCloudEvent, streamScope: string, dataEpoch: string,
  sequence: string): MainCloudEvent {
  const position = event.data.relayPosition ?? { streamScope, dataEpoch: event.data.sourcePosition.dataEpoch,
    sequence: event.data.sourcePosition.sequence };
  if (position.streamScope !== streamScope || position.dataEpoch !== dataEpoch || position.sequence !== sequence) {
    throw new RelayCheckpointConflict('retained envelope stream position differs from its row');
  }
  return { ...event, data: { ...event.data, relayPosition: position } };
}

/**
 * One complete, verified page from the product-owned handoff after a broker gap.
 * A passed client must be idle. This opens and commits its own snapshot and
 * leaves that checkout held; a session advisory lock survives the commit.
 */
export async function verifiedRetainedRelayRange(pool: Pool, consumer: string,
  afterSequence: string, limit = 100, client?: PoolClient): Promise<{ coverage: RelayCoverage;
    batches: RetainedRelayBatch[] }> {
  if (!/^(0|[1-9][0-9]*)$/.test(afterSequence)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RelayCheckpointConflict('invalid retained relay range');
  }
  const held = client ?? await pool.connect();
  try {
    await held.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { coverage } = await scanRelayCoverage(held, consumer);
    if (BigInt(coverage.sequence) < BigInt(afterSequence)) {
      throw new RelayCheckpointConflict('consumer checkpoint exceeds retained relay');
    }
    const rows = await held.query<{ sequence: string; batch_id: string;
      routing_epoch: string; event_count: number }>(
      `SELECT batch.sequence::text, batch_id, routing_epoch, event_count
       FROM relay.delivered_batch AS batch WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $1 AND batch.sequence > $2
       ORDER BY batch.sequence LIMIT $3`, [coverage.dataEpoch, afterSequence, limit]);
    const batches: RetainedRelayBatch[] = [];
    let next = BigInt(afterSequence) + 1n;
    for (const row of rows.rows) {
      if (BigInt(row.sequence) !== next++) {
        throw new RelayCheckpointConflict('retained relay batch range is not contiguous');
      }
      const events = await held.query<{ envelope: MainCloudEvent }>(
        `SELECT envelope FROM relay.delivered_event
         WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $1 AND sequence = $2 ORDER BY event_id`,
        [coverage.dataEpoch, row.sequence]);
      const ordered = events.rows.map(event => retainedEnvelopePosition(event.envelope,
        coverage.streamScope, coverage.dataEpoch, row.sequence))
        .sort((left, right) => left.data.ordinal - right.data.ordinal);
      if (ordered.length !== row.event_count || ordered.some((event, ordinal) =>
        event.data.ordinal !== ordinal || event.data.batchId !== row.batch_id
        || event.data.routingEpoch !== row.routing_epoch
        || event.data.relayPosition?.streamScope !== coverage.streamScope
        || event.data.relayPosition.dataEpoch !== coverage.dataEpoch
        || event.data.relayPosition.sequence !== row.sequence)) {
        throw new RelayCheckpointConflict('retained event envelope differs from batch header');
      }
      batches.push({ streamScope: MAIN_RELAY_STREAM_SCOPE, sequence: row.sequence, batchId: row.batch_id,
        routingEpoch: row.routing_epoch, events: ordered });
    }
    if (BigInt(coverage.sequence) > BigInt(afterSequence) && batches.length === 0) {
      throw new RelayCheckpointConflict('retained relay batch range is missing');
    }
    await held.query('COMMIT');
    return { coverage, batches };
  } catch (error) {
    try { await held.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally { if (!client) held.release(); }
}

export interface MainOutboxBatch {
  streamScope?: typeof MAIN_RELAY_STREAM_SCOPE;
  /** Legacy graph position used to verify receipt and revision anchors. */
  graphSequence?: string;
  batchId: string;
  dataEpoch: string;
  sequence: string;
  routingEpoch: string;
  eventIds: string[];
  /** Full receipt/event custody replaces the graph batch for this native position. */
  custodiedReceipt?: string;
}

export interface CustodiedOutbox { batch: MainOutboxBatch; events: DeliveredMainEvent[] }
export interface CustodiedOutboxSource {
  read(dataEpoch: string, streamSequence: string): Promise<CustodiedOutbox | null>;
}

export interface MainCloudEvent {
  specversion: '1.0';
  id: string;
  source: typeof SOURCE;
  type: 'com.rezics.work.title-control.v1' | 'com.rezics.work.created.v1' | 'com.rezics.work.edited.v1' | 'com.rezics.work.author-credit-adopted.v1'
    | 'com.rezics.work.metadata-changed.v1' | 'com.rezics.work.metadata-revised.v1'
    | 'com.rezics.work.author-credit-retired.v1'
    | 'com.rezics.work.edit-rejected.v1' | 'com.rezics.work.admission-cancelled.v1'
    | 'com.rezics.contribution.draft-created.v1'
    | 'com.rezics.contribution.draft-edited.v1'
    | 'com.rezics.contribution.draft-edit-rejected.v1'
    | 'com.rezics.contribution.admission-cancelled.v1'
    | 'com.rezics.contribution.eligibility-recorded.v1'
    | 'com.rezics.contribution.publication-rejected.v1'
    | 'com.rezics.contribution.publication-cancelled.v1'
    | 'com.rezics.publication.selection-changed.v1'
    | 'com.rezics.publication.selection-rejected.v1'
    | 'com.rezics.publication.selection-cancelled.v1'
    | 'com.rezics.space.created.v1' | 'com.rezics.space.creation-cancelled.v1'
    | 'com.rezics.realm.selection-changed.v1'
    | 'com.rezics.realm.selection-rejected.v1'
    | 'com.rezics.realm.selection-cancelled.v1'
    | 'com.rezics.realm.publication-suppressed.v1'
    | 'com.rezics.realm.suppression-rejected.v1'
    | 'com.rezics.realm.suppression-cancelled.v1'
    | 'com.rezics.classification.context-created.v1'
    | 'com.rezics.classification.context-cancelled.v1'
    | 'com.rezics.classification.proposition-defined.v1'
    | 'com.rezics.classification.proposition-cancelled.v1'
    | 'com.rezics.classification.decision-changed.v1'
    | 'com.rezics.classification.decision-stale.v1'
    | 'com.rezics.classification.decision-cancelled.v1'
    | 'com.rezics.rating.context-created.v1'
    | 'com.rezics.rating.context-cancelled.v1'
    | 'com.rezics.rating.policy-changed.v1'
    | 'com.rezics.rating.policy-stale.v1'
    | 'com.rezics.rating.policy-cancelled.v1'
    | 'com.rezics.rating.observation-changed.v1'
    | 'com.rezics.rating.observation-stale.v1'
    | 'com.rezics.rating.observation-cancelled.v1'
    | 'com.rezics.translation.linked.v1'
    | 'com.rezics.work.derived.v1' | 'com.rezics.release.sealed.v1'
    | 'com.rezics.address.claimed.v1' | 'com.rezics.address.renamed.v1'
    | 'com.rezics.address.merged.v1' | 'com.rezics.address.retired.v1';
  datacontenttype: 'application/json';
  data: { batchId: string; relayPosition?: { streamScope: string; dataEpoch: string; sequence: string };
    sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; routingEpoch: string; ordinal: number; receipt: {
      id: string; action: 'work.title.apply' | 'work.title.return' | 'work.create' | 'work.edit' | 'work.derive' | 'release.seal' | 'address.claim' | 'address.rename' | 'address.dispose' | 'contribution.create' | 'contribution.edit' | 'contribution.publish' | 'publication.select' | 'space.create' | 'publication.adopt' | 'publication.reject' | 'publication.reject.organization' | 'classification.context.configure' | 'classification.proposition.define' | 'classification.decision.set' | 'rating.context.create' | 'rating.context.policy.set' | 'rating.observation.set' | 'translation.link' | 'translation.authorize';
      outcome: 'succeeded' | 'cancelled';
      admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
      operation?: string; work?: string; mainVersion?: string; target?: string; workRevision?: string;
      mainRevision?: string; expectedHead?: string; reason?: 'stale-head';
      workManifest?: string; mainManifest?: string;
      metadata?: { work: string; component: string; revision: string; manifest: string };
      component?: string; revision?: string; contentLanguages?: string[];
      titleControl?: import('../work/title-control.ts').TitleControlReceipt;
      authorCredit?: string; creditRevision?: string; sourceIntent?: string;
      contribution?: string; draftRevision?: string; draftManifest?: string;
      publicationDecision?: string; publicationManifest?: string; selectedDraft?: string;
      selection?: string; selectionManifest?: string; matchUnit?: string;
      author?: string; language?: string;
      space?: string; realm?: string; spaceRevision?: string; realmRevision?: string;
      spaceManifest?: string; realmManifest?: string; owner?: string;
      slot?: string; rejection?: string; rejectionManifest?: string;
      reasonCode?: 'not-approved';
      classificationContext?: string; contextRevision?: string; contextManifest?: string;
      scheme?: string; concept?: string; path?: string; expression?: string; sense?: string;
      definitionRevision?: string; definitionManifest?: string;
      application?: string; decision?: string; decisionManifest?: string;
      decisionOutcome?: 'accepted' | 'rejected';
      ratingContext?: string; ratingContextRevision?: string; ratingContextManifest?: string;
      ratingPolicyRevision?: string; ratingPolicyManifest?: string;
      ratingPolicyPredecessor?: string; ratingPolicy?: string;
      ratingSlot?: string; ratingObservation?: string; observationRevision?: string;
      observationManifest?: string; ratingAvailability?: 'available' | 'withdrawn';
      ratingValue?: number;
      translationLink?: string; targetWork?: string; targetMainVersion?: string;
      targetMainRevision?: string; sourceWork?: string; sourceMainVersion?: string | null;
      sourceMainRevision?: string | null; sourceVersionStatus?: 'exact' | 'unresolved';
      translationStatus?: 'official' | 'third-party'; contentLanguage?: string;
      translator?: string; publisher?: string; evidence?: string; linkedBy?: string;
      authorizingParty?: string | null; authorizationScope?: string | null;
      authorizationEpoch?: string | null;
      workDerivation?: string; derivationKind?: string;
      corrects?: string | null;
      fixedRelease?: string; releaseManifest?: string; bodyDigest?: string; sealedBy?: string;
      routeBinding?: string; routeRevision?: string; normalizedSlug?: string;
      sourceAddress?: string; sourceRevision?: string; newAddress?: string;
      newRevision?: string; oldSlug?: string;
      redirectWork?: string;
    } };
}

export interface ContentBoundaryCloudEvent {
  specversion: '1.0';
  id: string;
  source: typeof SOURCE;
  type: 'com.rezics.content.published.v1' | 'com.rezics.content.publication-rejected.v1'
    | 'com.rezics.content.search-eligible.v1' | 'com.rezics.content.search-eligibility-rejected.v1'
    | 'com.rezics.content.projected.v1';
  datacontenttype: 'application/json';
  data: { batchId: string; sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; routingEpoch: string; ordinal: number; receipt: {
      id: string; action: 'content.publish' | 'content.search-eligibility' | 'content.project';
      outcome: 'succeeded' | 'cancelled'; requestDigest: string;
      admission?: { id: string; authorityEpoch: string; scope: string; actingSubject?: string };
      resource: string; variant: string; publicationDecision?: string;
      contentRevision?: string; eligibilityDecision?: string; eligibility?: string;
      projection?: string; matchUnit?: string; ownerDataEpoch?: string;
      ownerSequence?: string; rightsBasis?: 'original-contribution';
      disclosure?: 'public'; reason?: 'stale-head';
    } };
}

export interface SourceBoundaryCloudEvent {
  specversion: '1.0';
  id: string;
  source: typeof SOURCE;
  type: 'com.rezics.source.projected.v1';
  datacontenttype: 'application/json';
  data: { batchId: string; sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; routingEpoch: string; ordinal: number; receipt: {
      id: string; action: 'source.project'; outcome: 'succeeded';
      requestDigest: string; record: string; observation: string;
      conversion: string; byteDigest: string; mappingRevision: 'open-library-work-map-v1';
    } };
}

export type DeliveredMainEvent = (MainCloudEvent | ContentBoundaryCloudEvent | SourceBoundaryCloudEvent | OwnerCloudEvent)
  & { data: { relayPosition?: { streamScope: string; dataEpoch: string; sequence: string } } };

function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,99})$/.test(value)) throw new OutboxIncomplete('invalid outbox sequence');
  return BigInt(value);
}

/** One bounded source batch; each query uses the same wrapped Fuseki dataset. */
export async function readNextMainOutboxBatch(
  fuseki: FusekiClient, dataEpoch: string, afterSequence: string,
  ownerOutbox?: CustodiedOutboxSource,
): Promise<MainOutboxBatch | null> {
  const after = decimal(afterSequence);
  const next = after + 1n;
  // The exact numeric position uses TDB2's POSG quad index. Keeping control
  // and header in one query gives both facts the same graph read snapshot.
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?controlSequence ?routing ?hold ?batch ?eventCount ?graphSequence WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(dataEpoch)} ;
        rv:routingEpoch ?routing .
        ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ${lit(dataEpoch)} ; rv:streamSequence ?controlSequence ;
          rv:legacyThroughSequence ?legacyThrough . }
      OPTIONAL { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?hold } }
      OPTIONAL {
        { GRAPH ${iri(GRAPHS.outbox)} {
          ?batch rv:streamScope ${lit(MAIN_RELAY_STREAM_SCOPE)} ; rv:streamSequence ${next} . } }
        UNION {
          GRAPH ${iri(GRAPHS.control)} { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:legacyThroughSequence ?legacyCut }
          FILTER(${next} <= ?legacyCut)
          GRAPH ${iri(GRAPHS.outbox)} { ?batch rv:sequence ${next} .
            FILTER NOT EXISTS { ?batch rv:streamScope ?scope } } }
        GRAPH ${iri(GRAPHS.outbox)} {
        ?batch a rv:OutboxBatch ; rv:dataEpoch ${lit(dataEpoch)} ; rv:eventCount ?eventCount ;
          rv:sequence ?graphSequence . } }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0 || !rows[0]?.controlSequence || !rows[0]?.routing) {
    throw new OutboxEpochChanged('outbox source epoch is unavailable or ambiguous');
  }
  if (rows.length > 1) {
    if (rows[0]?.batch && rows[1]?.batch) {
      throw new OutboxIncomplete('outbox position has multiple batch headers');
    }
    throw new OutboxEpochChanged('outbox source epoch is ambiguous');
  }
  const row = rows[0]!;
  if (row.hold?.value === 'true') throw new OutboxRecoveryHold('restored source is held');
  const highWater = decimal(row.controlSequence!.value);
  if (after > highWater) throw new OutboxGap('checkpoint exceeds source position');
  if (!row.batch || !row.eventCount) {
    if (highWater > after) {
      const retained = await ownerOutbox?.read(dataEpoch, next.toString());
      if (retained) {
        const batch = retained.batch;
        if (batch.streamScope !== MAIN_RELAY_STREAM_SCOPE || batch.dataEpoch !== dataEpoch
          || batch.sequence !== next.toString() || batch.routingEpoch !== row.routing!.value
          || !batch.custodiedReceipt || batch.eventIds.length !== 1
          || retained.events.length !== 1 || retained.events[0]?.id !== batch.eventIds[0]) {
          throw new OutboxIncomplete('custodied outbox differs from the native stream position');
        }
        return batch;
      }
      throw new OutboxGap('retained outbox batch is missing');
    }
    return null;
  }
  if (highWater < next) throw new OutboxGap('outbox batch exceeds source position');
  const count = Number(decimal(row.eventCount.value));
  if (!Number.isSafeInteger(count) || count > 100) throw new OutboxIncomplete('outbox event count exceeds admitted bound');
  const batchId = row.batch.value;
  iri(batchId);
  const members = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?event ?ordinal WHERE {
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batchId)} rv:event ?event .
      ?event rv:ordinal ?ordinal . }
  }`);
  const ordered = (members.results?.bindings ?? []).map(member => ({
    eventId: member.event?.value ?? '', ordinal: decimal(member.ordinal?.value ?? ''),
  })).sort((a, b) => a.ordinal < b.ordinal ? -1 : a.ordinal > b.ordinal ? 1 : 0);
  if (ordered.length !== count || new Set(ordered.map(member => member.eventId)).size !== count
    || ordered.some((member, index) => member.ordinal !== BigInt(index))) {
    throw new OutboxIncomplete('outbox batch members differ from their ordinals');
  }
  const eventIds = ordered.map(member => member.eventId);
  for (const eventId of eventIds) {
    iri(eventId);
    const exists = await fuseki.query(`ASK { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }`);
    if (exists.boolean !== true) throw new OutboxIncomplete('outbox event object is missing');
  }
  if (!row.graphSequence) throw new OutboxIncomplete('outbox graph position is missing');
  return { streamScope: MAIN_RELAY_STREAM_SCOPE, batchId, dataEpoch, sequence: next.toString(),
    graphSequence: row.graphSequence.value,
    routingEpoch: row.routing.value, eventIds };
}

async function revisionManifest(fuseki: FusekiClient, revision: string): Promise<string> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} rv:manifest ?manifest }
  }`);
  const rows = result.results?.bindings ?? [];
  const manifest = rows[0]?.manifest?.value;
  if (rows.length !== 1 || !manifest || !/^urn:rezics:sha256:[0-9a-f]{64}$/.test(manifest)) {
    throw new OutboxIncomplete('event revision manifest is unavailable or ambiguous');
  }
  return manifest;
}

const contentEventTypes: Record<string, ContentBoundaryCloudEvent['type']> = {
  [`${RV}ContentPublicationEvent`]: 'com.rezics.content.published.v1',
  [`${RV}ContentPublicationRejectedEvent`]: 'com.rezics.content.publication-rejected.v1',
  [`${RV}ContentSearchEligibilityEvent`]: 'com.rezics.content.search-eligible.v1',
  [`${RV}ContentSearchEligibilityRejectedEvent`]: 'com.rezics.content.search-eligibility-rejected.v1',
  [`${RV}ContentProjectionEvent`]: 'com.rezics.content.projected.v1',
};

export function mapContentOutboxEvent(batch: MainOutboxBatch, eventId: string,
  value: (name: string) => string | undefined, ordinal: number,
): ContentBoundaryCloudEvent {
  const kind = value('kind') ?? '';
  const type = contentEventTypes[kind];
  const action = value('action');
  const outcome = value('outcome');
  const resource = value('resource');
  const variant = value('variant');
  const publicationDecision = value('publicationDecision');
  const contentRevision = value('contentRevision');
  const eligibilityDecision = value('eligibilityDecision');
  const eligibility = value('eligibility');
  const projection = value('projection');
  const matchUnit = value('matchUnit');
  const reason = value('reason');
  const admitted = type !== 'com.rezics.content.projected.v1';
  if (!type || !resource || !variant || !value('receipt')
    || !/^[0-9a-f]{64}$/.test(value('digest') ?? '')
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
    || !['content.publish', 'content.search-eligibility', 'content.project'].includes(action ?? '')
    || ![`${RV}Succeeded`, `${RV}Cancelled`].includes(outcome ?? '')
    || (admitted && (!/^[0-9a-f-]{36}$/.test(value('admissionId') ?? '')
      || !/^[0-9]+$/.test(value('authorityEpoch') ?? '')
      || ![resource, variant].some(target => value('scope')
        === `${action === 'content.publish' ? 'content:publish:' : 'content:search-eligibility:'}${target}`)))
    || (!admitted && (value('admissionId') || value('authorityEpoch') || value('scope')))
    || (value('eventVariant') && value('eventVariant') !== variant)
    || (value('eventContentRevision') && value('eventContentRevision') !== contentRevision)
    || (value('eventPublicationDecision') && value('eventPublicationDecision') !== publicationDecision)) {
    throw new OutboxIncomplete('Content event source or receipt is incomplete');
  }
  for (const term of [value('receipt')!, resource, variant,
    ...(value('actingSubject') ? [value('actingSubject')!] : []),
    ...(publicationDecision ? [publicationDecision] : []),
    ...(contentRevision ? [contentRevision] : []), ...(eligibilityDecision ? [eligibilityDecision] : []),
    ...(eligibility ? [eligibility] : []), ...(projection ? [projection] : []),
    ...(matchUnit ? [matchUnit] : [])]) iri(term);
  if (type === 'com.rezics.content.published.v1'
    ? action !== 'content.publish' || outcome !== `${RV}Succeeded`
      || !publicationDecision || !contentRevision || reason
      || value('eventVariant') !== variant || value('eventContentRevision') !== contentRevision
    : type === 'com.rezics.content.publication-rejected.v1'
      ? action !== 'content.publish' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || publicationDecision || !contentRevision
        || value('eventContentRevision') !== contentRevision
      : type === 'com.rezics.content.search-eligible.v1'
        ? action !== 'content.search-eligibility' || outcome !== `${RV}Succeeded`
          || !publicationDecision || !eligibilityDecision || !value('actingSubject')
          || !eligibleRightsBasis(value('rightsBasis'))
          || value('disclosure') !== `${RV}Public` || reason
          || value('eventVariant') !== variant
          || value('eventPublicationDecision') !== publicationDecision
        : type === 'com.rezics.content.search-eligibility-rejected.v1'
          ? action !== 'content.search-eligibility' || outcome !== `${RV}Cancelled`
            || reason !== `${RV}StaleHead` || !publicationDecision || eligibilityDecision
            || !value('actingSubject')
            || !eligibleRightsBasis(value('rightsBasis'))
            || value('disclosure') !== `${RV}Public`
            || value('eventVariant') !== variant
          : action !== 'content.project' || outcome !== `${RV}Succeeded`
            || !publicationDecision || !contentRevision || !eligibility || !projection
            || !matchUnit || !/^[0-9a-f-]{36}$/.test(value('ownerDataEpoch') ?? '')
            || !/^[0-9]+$/.test(value('ownerSequence') ?? '') || reason
            || value('eventVariant') !== variant
            || value('eventContentRevision') !== contentRevision) {
    throw new OutboxIncomplete('Content event type differs from its exact receipt');
  }
  return { specversion: '1.0', id: eventId, source: SOURCE, type,
    datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: value('receipt')!, action: action as ContentBoundaryCloudEvent['data']['receipt']['action'],
        outcome: outcome === `${RV}Succeeded` ? 'succeeded' : 'cancelled',
        requestDigest: value('digest')!, resource, variant,
        ...(admitted ? { admission: { id: value('admissionId')!,
          authorityEpoch: value('authorityEpoch')!, scope: value('scope')!,
          ...(value('actingSubject') ? { actingSubject: value('actingSubject')! } : {}) } } : {}),
        ...(publicationDecision ? { publicationDecision } : {}),
        ...(contentRevision ? { contentRevision } : {}),
        ...(eligibilityDecision ? { eligibilityDecision } : {}),
        ...(eligibility ? { eligibility } : {}),
        ...(projection ? { projection } : {}), ...(matchUnit ? { matchUnit } : {}),
        ...(value('ownerDataEpoch') ? { ownerDataEpoch: value('ownerDataEpoch')! } : {}),
        ...(value('ownerSequence') ? { ownerSequence: value('ownerSequence')! } : {}),
        ...(value('rightsBasis') === `${RV}OriginalContribution`
          ? { rightsBasis: 'original-contribution' as const } : {}),
        ...(value('disclosure') === `${RV}Public` ? { disclosure: 'public' as const } : {}),
        ...(reason ? { reason: 'stale-head' as const } : {}),
      } } };
}

async function translationLinkedEnvelope(fuseki: FusekiClient, batch: MainOutboxBatch,
  eventId: string, eventValue: (name: string) => string | undefined,
  ordinal: number): Promise<MainCloudEvent> {
  const link = eventValue('translationLink');
  const receiptId = eventValue('receipt');
  const action = eventValue('action');
  const scope = eventValue('scope');
  const authorityEpoch = eventValue('authorityEpoch');
  const admissionId = eventValue('admissionId');
  const requestDigest = eventValue('digest');
  if (!link || eventValue('eventTranslationLink') !== link || !receiptId
    || !['translation.link', 'translation.authorize'].includes(action ?? '')
    || !scope || !/^[0-9]+$/.test(authorityEpoch ?? '')
    || !/^[0-9a-f-]{36}$/.test(admissionId ?? '')
    || !/^[0-9a-f]{64}$/.test(requestDigest ?? '')
    || eventValue('outcome') !== `${RV}Succeeded`
    || eventValue('epoch') !== batch.dataEpoch
    || eventValue('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('translation event differs from its receipt');
  }
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?targetWork ?targetMain ?targetRevision ?sourceWork ?sourceMain ?sourceRevision
    ?sourceStatus ?status ?language ?translator ?publisher ?evidence ?linkedBy
    ?authorizer ?authorizationScope ?authorizationEpoch ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(link)} a rv:TranslationLink ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ?targetMain ; rv:targetMainRevision ?targetRevision ;
        rv:sourceWork ?sourceWork ; rv:sourceMainVersion ?sourceMain ;
        rv:sourceVersionStatus ?sourceStatus ; rv:translationStatus ?status ;
        rv:contentLanguage ?language ; rv:translator ?translator ;
        rv:publisher ?publisher ; rv:evidence ?evidence ; rv:linkedBy ?linkedBy ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(link)} rv:sourceMainRevision ?sourceRevision }
      OPTIONAL { ${iri(link)} rv:authorizingParty ?authorizer }
      OPTIONAL { ${iri(link)} rv:authorizationScope ?authorizationScope }
      OPTIONAL { ${iri(link)} rv:authorizationEpoch ?authorizationEpoch }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new OutboxIncomplete('translation link is unavailable or ambiguous');
  const value = (name: string) => row[name]?.value;
  const sourceStatus = value('sourceStatus') === `${RV}Exact` ? 'exact'
    : value('sourceStatus') === `${RV}Unresolved` ? 'unresolved' : null;
  const status = value('status') === `${RV}Official` ? 'official'
    : value('status') === `${RV}ThirdParty` ? 'third-party' : null;
  const sourceRevision = value('sourceRevision') ?? null;
  const authorizer = value('authorizer') ?? null;
  const authorizationScope = value('authorizationScope') ?? null;
  const authorizationEpoch = value('authorizationEpoch') ?? null;
  const sourceWork = value('sourceWork');
  const targetWork = value('targetWork');
  if (!sourceStatus || !status || !sourceWork || !targetWork
    || !value('targetMain') || !value('targetRevision') || !value('sourceMain')
    || !value('language') || !value('translator') || !value('publisher')
    || !value('evidence') || !value('linkedBy')
    || (sourceStatus === 'exact') !== !!sourceRevision
    || (status === 'official') !== (action === 'translation.authorize')
    || (status === 'official'
      ? !sourceRevision || authorizer !== value('linkedBy')
        || authorizationScope !== scope || authorizationEpoch !== authorityEpoch
        || scope !== `translation:authorize:${sourceWork}:${sourceRevision}`
      : authorizer !== null || authorizationScope !== null || authorizationEpoch !== null
        || scope !== `translation:link:${targetWork}`)
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('translation provenance differs from source position or authority');
  }
  return { specversion: '1.0', id: eventId, source: SOURCE,
    type: 'com.rezics.translation.linked.v1', datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: action as 'translation.link' | 'translation.authorize',
        outcome: 'succeeded', admissionId: admissionId!, requestDigest: requestDigest!,
        authorityEpoch: authorityEpoch!, scope: scope!, translationLink: link,
        targetWork, targetMainVersion: value('targetMain')!,
        targetMainRevision: value('targetRevision')!, sourceWork,
        sourceMainVersion: value('sourceMain')!, sourceMainRevision: sourceRevision,
        sourceVersionStatus: sourceStatus, translationStatus: status,
        contentLanguage: value('language')!, translator: value('translator')!,
        publisher: value('publisher')!, evidence: value('evidence')!,
        linkedBy: value('linkedBy')!, authorizingParty: authorizer,
        authorizationScope, authorizationEpoch } } };
}

async function workDerivedEnvelope(fuseki: FusekiClient, batch: MainOutboxBatch,
  eventId: string, eventValue: (name: string) => string | undefined,
  ordinal: number): Promise<MainCloudEvent> {
  const derivation = eventValue('workDerivation');
  const receiptId = eventValue('receipt');
  const admissionId = eventValue('admissionId');
  const scope = eventValue('scope');
  const authorityEpoch = eventValue('authorityEpoch');
  const requestDigest = eventValue('digest');
  if (!derivation || eventValue('eventWorkDerivation') !== derivation || !receiptId
    || eventValue('action') !== 'work.derive' || !scope
    || !/^[0-9]+$/.test(authorityEpoch ?? '')
    || !/^[0-9a-f-]{36}$/.test(admissionId ?? '')
    || !/^[0-9a-f]{64}$/.test(requestDigest ?? '')
    || eventValue('outcome') !== `${RV}Succeeded`
    || eventValue('epoch') !== batch.dataEpoch
    || eventValue('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('work derivation event differs from its receipt');
  }
  // An unresolved declaration can name the source Work alone or its Main Version.
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?targetWork ?targetMain ?targetRevision ?sourceWork ?sourceMain ?sourceRevision
    ?sourceStatus ?class ?kind ?evidence ?linkedBy ?corrects ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(derivation)} a ?class ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ?targetMain ; rv:targetMainRevision ?targetRevision ;
        rv:sourceWork ?sourceWork ;
        rv:derivationKind ?kind ; rv:evidence ?evidence ; rv:linkedBy ?linkedBy ;
        rv:modelRevision ?model ; rv:shapeRevision ?model ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      FILTER(?class = rv:WorkDerivation
          && ?model = <https://rezics.com/definition/work-derivation-v1>
        || ?class = rv:UnresolvedWorkDerivation
          && ?model = <https://rezics.com/definition/work-derivation-unresolved-v1>
        || ?class = rv:LexiconWorkDerivation && ?model = <https://rezics.com/definition/work-derivation-v2>)
      OPTIONAL { ${iri(derivation)} rv:sourceMainRevision ?sourceRevision }
      OPTIONAL { ${iri(derivation)} rv:sourceMainVersion ?sourceMain }
      OPTIONAL { ${iri(derivation)} rv:sourceVersionStatus ?sourceStatus }
      OPTIONAL { ${iri(derivation)} rv:corrects ?corrects }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new OutboxIncomplete('work derivation is unavailable or ambiguous');
  const value = (name: string) => row[name]?.value;
  const kind = value('kind') === `${RV}Adaptation` ? 'adaptation'
    : value('kind') === `${RV}NewRecording` ? 'new-recording'
    : value('kind') === `${RV}SoftwareFork` ? 'software-fork'
      : /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(value('kind') ?? '') ? value('kind')! : null;
  const targetWork = value('targetWork');
  const v2 = value('class') === `${RV}LexiconWorkDerivation`;
  const unresolved = value('class') === `${RV}UnresolvedWorkDerivation` || v2 && value('sourceStatus') === `${RV}Unresolved`;
  const sourceRevision = value('sourceRevision') ?? null;
  if (!kind || !targetWork || !value('targetMain') || !value('targetRevision')
    || !value('sourceWork')
    || (unresolved ? sourceRevision !== null || value('sourceStatus') !== `${RV}Unresolved`
      : !value('sourceMain') || sourceRevision === null || (v2 ? value('sourceStatus') !== `${RV}Exact` : value('sourceStatus') !== undefined))
    || !value('evidence') || !value('linkedBy')
    || scope !== (v2 ? `work:edit:${targetWork}` : `derivation:link:${targetWork}`)
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('work derivation differs from source position or authority');
  }
  return { specversion: '1.0', id: eventId, source: SOURCE,
    type: 'com.rezics.work.derived.v1', datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: 'work.derive', outcome: 'succeeded',
        admissionId: admissionId!, requestDigest: requestDigest!,
        authorityEpoch: authorityEpoch!, scope, workDerivation: derivation,
        targetWork, targetMainVersion: value('targetMain')!,
        targetMainRevision: value('targetRevision')!, sourceWork: value('sourceWork')!,
        sourceMainVersion: value('sourceMain') ?? null, sourceMainRevision: sourceRevision,
        sourceVersionStatus: unresolved ? 'unresolved' : 'exact',
        derivationKind: kind, evidence: value('evidence')!, linkedBy: value('linkedBy')!,
        corrects: value('corrects') ?? null } } };
}

async function fixedReleaseEnvelope(fuseki: FusekiClient, batch: MainOutboxBatch,
  eventId: string, eventValue: (name: string) => string | undefined,
  ordinal: number): Promise<MainCloudEvent> {
  const release = eventValue('fixedRelease');
  const receiptId = eventValue('receipt');
  const admissionId = eventValue('admissionId');
  const scope = eventValue('scope');
  const authorityEpoch = eventValue('authorityEpoch');
  const requestDigest = eventValue('digest');
  if (!release || eventValue('eventFixedRelease') !== release || !receiptId
    || eventValue('action') !== 'release.seal' || !scope
    || !/^[0-9]+$/.test(authorityEpoch ?? '')
    || !/^[0-9a-f-]{36}$/.test(admissionId ?? '')
    || !/^[0-9a-f]{64}$/.test(requestDigest ?? '')
    || eventValue('outcome') !== `${RV}Succeeded`
    || eventValue('epoch') !== batch.dataEpoch
    || eventValue('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('fixed release event differs from its receipt');
  }
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?work ?main ?revision ?selection ?contribution ?decision ?draft ?language
    ?digest ?manifest ?actor ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(release)} a rv:FixedRelease ; rv:work ?work ; rv:mainVersion ?main ;
        rv:mainRevision ?revision ; rv:selection ?selection ; rv:contribution ?contribution ;
        rv:publicationDecision ?decision ; rv:selectedDraft ?draft ; rv:language ?language ;
        rv:bodyDigest ?digest ; rv:manifest ?manifest ; rv:sealedBy ?actor ;
        rv:modelRevision <https://rezics.com/definition/fixed-native-text-release-v1> ;
        rv:shapeRevision <https://rezics.com/definition/fixed-native-text-release-v1> ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  const value = (name: string) => row?.[name]?.value;
  const work = value('work');
  if (rows.length !== 1 || !work || !value('main') || !value('revision')
    || !value('selection') || !value('contribution') || !value('decision')
    || !value('draft') || !value('language') || !value('manifest') || !value('actor')
    || !/^[0-9a-f]{64}$/.test(value('digest') ?? '')
    || scope !== `release:seal:${value('main')}`
    || eventValue('eventWork') !== work
    || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
    throw new OutboxIncomplete('fixed release differs from source position or authority');
  }
  return { specversion: '1.0', id: eventId, source: SOURCE,
    type: 'com.rezics.release.sealed.v1', datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: 'release.seal', outcome: 'succeeded',
        admissionId: admissionId!, requestDigest: requestDigest!, authorityEpoch: authorityEpoch!,
        scope, fixedRelease: release, work, mainVersion: value('main')!,
        mainRevision: value('revision')!, selection: value('selection')!,
        contribution: value('contribution')!, publicationDecision: value('decision')!,
        selectedDraft: value('draft')!, language: value('language')!,
        bodyDigest: value('digest')!, releaseManifest: value('manifest')!,
        sealedBy: value('actor')! } } };
}

export async function readMainOutboxEnvelope(fuseki: FusekiClient, batch: MainOutboxBatch,
  eventId: string,
  handlerFor: (kind: string) => OwnerOutboxEventHandler | undefined = ownerOutboxEventHandler,
  ownerOutbox?: CustodiedOutboxSource,
): Promise<DeliveredMainEvent> {
  if (batch.streamScope !== undefined && batch.streamScope !== MAIN_RELAY_STREAM_SCOPE) {
    throw new OutboxIncomplete('outbox batch stream differs');
  }
  if (batch.custodiedReceipt) {
    const retained = await ownerOutbox?.read(batch.dataEpoch, batch.sequence);
    const event = retained?.events.find(event => event.id === eventId);
    if (!retained || !event || retained.batch.custodiedReceipt !== batch.custodiedReceipt
      || retained.batch.batchId !== batch.batchId || retained.batch.routingEpoch !== batch.routingEpoch
      || retained.batch.graphSequence !== batch.graphSequence
      || JSON.stringify(retained.batch.eventIds) !== JSON.stringify(batch.eventIds)
      || event.data.batchId !== batch.batchId || event.data.routingEpoch !== batch.routingEpoch
      || event.data.receipt.id !== batch.custodiedReceipt
      || event.data.sourcePosition.datasetId !== 'product'
      || event.data.sourcePosition.dataEpoch !== batch.dataEpoch
      || event.data.sourcePosition.sequence !== batch.graphSequence
      || event.data.relayPosition?.streamScope !== MAIN_RELAY_STREAM_SCOPE
      || event.data.relayPosition.dataEpoch !== batch.dataEpoch || event.data.relayPosition.sequence !== batch.sequence) {
      throw new OutboxIncomplete('custodied event differs from its retained native batch');
    }
    return event;
  }
  const event = await readMainOutboxGraphEnvelope(fuseki,
    { ...batch, sequence: batch.graphSequence ?? batch.sequence }, eventId, handlerFor);
  // Graph-based owners still consume receipt/revision positions. The relay's
  // own ordering belongs to a separate position and never rewrites that basis.
  return { ...event, data: { ...event.data, relayPosition: {
    streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: batch.dataEpoch, sequence: batch.sequence } } } as DeliveredMainEvent;
}

async function readMainOutboxGraphEnvelope(fuseki: FusekiClient, batch: MainOutboxBatch,
  eventId: string, handlerFor: (kind: string) => OwnerOutboxEventHandler | undefined,
): Promise<DeliveredMainEvent> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?kind ?ordinal ?action ?receipt ?eventOperation ?eventWork ?outcome ?admissionId
    ?digest ?authorityEpoch ?scope ?epoch ?sequence ?operation ?work ?main ?target
    ?workRevision ?mainRevision ?expectedHead ?reason ?contribution ?draftRevision
    ?author ?language ?eventContribution ?publicationDecision ?selectedDraft
    ?selection ?matchUnit ?eventSpace ?eventRealm ?space ?realm ?slot ?rejection ?reasonCode
    ?spaceRevision ?realmRevision ?owner ?classificationContext ?contextRevision
    ?scheme ?concept ?path ?expression ?sense ?definitionRevision
    ?application ?decision ?decisionOutcome ?eventApplication
    ?ratingContext ?ratingContextRevision ?ratingPolicyRevision ?ratingPolicyPredecessor
    ?ratingPolicy ?ratingSlot ?ratingObservation
    ?observationRevision ?ratingAvailability ?ratingValue
    ?eventRatingContext ?eventRatingObservation
    ?eventVariant ?eventContentRevision ?eventPublicationDecision
    ?resource ?variant ?contentRevision ?ownerDataEpoch ?ownerSequence
    ?eligibilityDecision ?eligibility ?projection ?actingSubject ?rightsBasis ?disclosure
    ?eventTranslationLink ?translationLink ?eventWorkDerivation ?workDerivation
    ?eventFixedRelease ?fixedRelease ?eventRouteBinding ?routeBinding
    ?routeRevision ?normalizedSlug ?eventSourceAddress ?eventNewAddress
    ?sourceAddress ?sourceRevision ?newAddress ?newRevision ?oldSlug
    ?eventRedirectWork ?redirectWork ?eventSourceConversion
    ?sourceRecord ?sourceObservation ?sourceConversion ?sourceByteDigest
    ?sourceMappingRevision ?authorCredit ?creditRevision ?sourceIntent ?retirementReason WHERE {
    GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(eventId)} a ?kind ; rv:ordinal ?ordinal ; rv:receipt ?receipt .
      OPTIONAL { ${iri(eventId)} rv:action ?action }
      OPTIONAL { ${iri(eventId)} rv:operation ?eventOperation }
      OPTIONAL { ${iri(eventId)} rv:work ?eventWork }
      OPTIONAL { ${iri(eventId)} rv:contribution ?eventContribution }
      OPTIONAL { ${iri(eventId)} rv:space ?eventSpace }
      OPTIONAL { ${iri(eventId)} rv:realm ?eventRealm }
      OPTIONAL { ${iri(eventId)} rv:application ?eventApplication }
      OPTIONAL { ${iri(eventId)} rv:ratingContext ?eventRatingContext }
      OPTIONAL { ${iri(eventId)} rv:ratingObservation ?eventRatingObservation }
      OPTIONAL { ${iri(eventId)} rv:variant ?eventVariant }
      OPTIONAL { ${iri(eventId)} rv:contentRevision ?eventContentRevision }
      OPTIONAL { ${iri(eventId)} rv:publicationDecision ?eventPublicationDecision }
      OPTIONAL { ${iri(eventId)} rv:translationLink ?eventTranslationLink }
      OPTIONAL { ${iri(eventId)} rv:workDerivation ?eventWorkDerivation }
      OPTIONAL { ${iri(eventId)} rv:fixedRelease ?eventFixedRelease }
      OPTIONAL { ${iri(eventId)} rv:routeBinding ?eventRouteBinding }
      OPTIONAL { ${iri(eventId)} rv:sourceAddress ?eventSourceAddress }
      OPTIONAL { ${iri(eventId)} rv:newAddress ?eventNewAddress }
      OPTIONAL { ${iri(eventId)} rv:redirectWork ?eventRedirectWork }
      OPTIONAL { ${iri(eventId)} rv:sourceConversion ?eventSourceConversion }
    }
    GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt a rv:OperationReceipt ; rv:outcome ?outcome ;
        rv:requestDigest ?digest ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ?receipt rv:admissionId ?admissionId }
      OPTIONAL { ?receipt rv:authorityEpoch ?authorityEpoch }
      OPTIONAL { ?receipt rv:admittedScope ?scope }
      OPTIONAL { ?receipt rv:operation ?operation }
      OPTIONAL { ?receipt rv:work ?work }
      OPTIONAL { ?receipt rv:target ?target }
      OPTIONAL { ?receipt rv:mainVersion ?main }
      OPTIONAL { ?receipt rv:workRevision ?workRevision }
      OPTIONAL { ?receipt rv:authorCredit ?authorCredit }
      OPTIONAL { ?receipt rv:creditRevision ?creditRevision }
      OPTIONAL { ?receipt rv:sourceIntent ?sourceIntent }
      OPTIONAL { ?receipt rv:retirementReason ?retirementReason }
      OPTIONAL { ?receipt rv:mainRevision ?mainRevision }
      OPTIONAL { ?receipt rv:expectedHead ?expectedHead }
      OPTIONAL { ?receipt rv:reason ?reason }
      OPTIONAL { ?receipt rv:contribution ?contribution }
      OPTIONAL { ?receipt rv:draftRevision ?draftRevision }
      OPTIONAL { ?receipt rv:publicationDecision ?publicationDecision }
      OPTIONAL { ?receipt rv:selectedDraft ?selectedDraft }
      OPTIONAL { ?receipt rv:selection ?selection }
      OPTIONAL { ?receipt rv:matchUnit ?matchUnit }
      OPTIONAL { ?receipt rv:author ?author }
      OPTIONAL { ?receipt rv:language ?language }
      OPTIONAL { ?receipt rv:space ?space }
      OPTIONAL { ?receipt rv:realm ?realm }
      OPTIONAL { ?receipt rv:slot ?slot }
      OPTIONAL { ?receipt rv:rejection ?rejection }
      OPTIONAL { ?receipt rv:reasonCode ?reasonCode }
      OPTIONAL { ?receipt rv:spaceRevision ?spaceRevision }
      OPTIONAL { ?receipt rv:realmRevision ?realmRevision }
      OPTIONAL { ?receipt rv:owner ?owner }
      OPTIONAL { ?receipt rv:classificationContext ?classificationContext }
      OPTIONAL { ?receipt rv:contextRevision ?contextRevision }
      OPTIONAL { ?receipt rv:scheme ?scheme }
      OPTIONAL { ?receipt rv:concept ?concept }
      OPTIONAL { ?receipt rv:path ?path }
      OPTIONAL { ?receipt rv:expression ?expression }
      OPTIONAL { ?receipt rv:sense ?sense }
      OPTIONAL { ?receipt rv:definitionRevision ?definitionRevision }
      OPTIONAL { ?receipt rv:application ?application }
      OPTIONAL { ?receipt rv:decision ?decision }
      OPTIONAL { ?receipt rv:decisionOutcome ?decisionOutcome }
      OPTIONAL { ?receipt rv:ratingContext ?ratingContext }
      OPTIONAL { ?receipt rv:ratingContextRevision ?ratingContextRevision }
      OPTIONAL { ?receipt rv:ratingPolicyRevision ?ratingPolicyRevision }
      OPTIONAL { ?receipt rv:predecessor ?ratingPolicyPredecessor }
      OPTIONAL { ?receipt rv:ratingAggregationPolicy ?ratingPolicy }
      OPTIONAL { ?receipt rv:ratingSlot ?ratingSlot }
      OPTIONAL { ?receipt rv:ratingObservation ?ratingObservation }
      OPTIONAL { ?receipt rv:observationRevision ?observationRevision }
      OPTIONAL { ?receipt rv:ratingAvailability ?ratingAvailability }
      OPTIONAL { ?receipt rv:ratingValue ?ratingValue }
      OPTIONAL { ?receipt rv:resource ?resource }
      OPTIONAL { ?receipt rv:variant ?variant }
      OPTIONAL { ?receipt rv:contentRevision ?contentRevision }
      OPTIONAL { ?receipt rv:ownerDataEpoch ?ownerDataEpoch }
      OPTIONAL { ?receipt rv:ownerSequence ?ownerSequence }
      OPTIONAL { ?receipt rv:eligibilityDecision ?eligibilityDecision }
      OPTIONAL { ?receipt rv:eligibility ?eligibility }
      OPTIONAL { ?receipt rv:projection ?projection }
      OPTIONAL { ?receipt rv:actingSubject ?actingSubject }
      OPTIONAL { ?receipt rv:rightsBasis ?rightsBasis }
      OPTIONAL { ?receipt rv:disclosure ?disclosure }
      OPTIONAL { ?receipt rv:translationLink ?translationLink }
      OPTIONAL { ?receipt rv:workDerivation ?workDerivation }
      OPTIONAL { ?receipt rv:fixedRelease ?fixedRelease }
      OPTIONAL { ?receipt rv:routeBinding ?routeBinding }
      OPTIONAL { ?receipt rv:routeRevision ?routeRevision }
      OPTIONAL { ?receipt rv:normalizedSlug ?normalizedSlug }
      OPTIONAL { ?receipt rv:sourceAddress ?sourceAddress }
      OPTIONAL { ?receipt rv:sourceRevision ?sourceRevision }
      OPTIONAL { ?receipt rv:newAddress ?newAddress }
      OPTIONAL { ?receipt rv:newRevision ?newRevision }
      OPTIONAL { ?receipt rv:oldSlug ?oldSlug }
      OPTIONAL { ?receipt rv:redirectWork ?redirectWork }
      OPTIONAL { ?receipt rv:sourceRecord ?sourceRecord }
      OPTIONAL { ?receipt rv:sourceObservation ?sourceObservation }
      OPTIONAL { ?receipt rv:sourceConversion ?sourceConversion }
      OPTIONAL { ?receipt rv:sourceByteDigest ?sourceByteDigest }
      OPTIONAL { ?receipt rv:sourceMappingRevision ?sourceMappingRevision }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new OutboxIncomplete('event receipt is unavailable or ambiguous');
  const value = (name: string): string | undefined => row[name]?.value;
  const kind = value('kind');
  const ownerHandler = kind ? handlerFor(kind) : undefined;
  // The original system Agent events did not carry an action. Their exact RDF
  // kind and immutable receipt establish the action in the owner handler.
  const action = value('action') ?? (ownerHandler?.authority === 'system'
    ? ownerHandler.action : undefined);
  const ownerValue = (name: string) => name === 'action' ? action : value(name);
  const outcome = value('outcome');
  const receiptId = value('receipt');
  const admissionId = value('admissionId');
  const requestDigest = value('digest');
  const authorityEpoch = value('authorityEpoch');
  const scope = value('scope');
  const ordinalValue = decimal(value('ordinal') ?? '');
  if (ordinalValue >= BigInt(batch.eventIds.length)) {
    throw new OutboxIncomplete('event ordinal exceeds batch member count');
  }
  const ordinal = Number(ordinalValue);
  if (kind === `${RV}WorkTitleControlEvent`) {
    const terminal = admissionId && await readTitleControlReceipt({ fuseki }, admissionId);
    if (!terminal || terminal.receipt !== receiptId || terminal.requestDigest !== requestDigest
      || terminal.action !== action || terminal.authorityEpoch !== authorityEpoch || terminal.scope !== scope
      || terminal.dataEpoch !== batch.dataEpoch || terminal.sequence !== batch.sequence
      || eventId !== `urn:rezics:event:${hash(terminal.receipt)}`
      || batch.batchId !== `urn:rezics:outbox:${hash(terminal.receipt)}`) throw new OutboxIncomplete('title control event differs');
    return { specversion: '1.0', id: eventId, source: SOURCE, type: 'com.rezics.work.title-control.v1',
      datacontenttype: 'application/json', data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal, receipt: { id: terminal.receipt, action: terminal.action,
          outcome: terminal.outcome, admissionId: terminal.admissionId, requestDigest: terminal.requestDigest,
          authorityEpoch: terminal.authorityEpoch, scope: terminal.scope, titleControl: terminal } } };
  }
  if (kind === `${RV}AuthorCreditAdoptedEvent`) {
    const credit = value('authorCredit'), revision = value('creditRevision'), intent = value('sourceIntent');
    const work = value('work'), head = value('expectedHead');
    if (action !== 'work.edit' || outcome !== `${RV}Succeeded` || !receiptId || !requestDigest
      || !admissionId || !authorityEpoch || !scope || !credit || !revision || !intent || !work || !head
      || scope !== `work:edit:${work}` || value('workRevision') !== head || value('eventWork') !== work
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
      || !/^[0-9a-f-]{36}$/.test(admissionId)) throw new OutboxIncomplete('author credit event differs from receipt');
    for (const subject of [receiptId, credit, revision, intent, work, head]) iri(subject);
    const graph = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:AuthorCredit ; rv:work ${iri(work)} ; rv:creditRevision ${iri(revision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:AuthorCreditRevision ; rv:component ${iri(credit)} ;
        rv:work ${iri(work)} ; rv:workRevision ${iri(head)} ; rv:dataEpoch ${lit(batch.dataEpoch)} ; rv:sequence ${batch.sequence} . }
    }`);
    if (!graph.boolean) throw new OutboxIncomplete('native author credit event effect is missing');
    return { specversion: '1.0', id: eventId, source: SOURCE, type: 'com.rezics.work.author-credit-adopted.v1',
      datacontenttype: 'application/json', data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal, receipt: { id: receiptId, action: 'work.edit', outcome: 'succeeded',
          admissionId, requestDigest, authorityEpoch, scope, work, workRevision: head, expectedHead: head,
          authorCredit: credit, creditRevision: revision, sourceIntent: intent } } };
  }
  if (kind === `${RV}AuthorCreditRetiredEvent`) {
    const credit = value('authorCredit'), revision = value('creditRevision');
    const work = value('work'), head = value('expectedHead'), reason = value('retirementReason');
    if (action !== 'work.edit' || outcome !== `${RV}Succeeded` || !receiptId || !requestDigest
      || !admissionId || !authorityEpoch || !scope || !credit || !revision || !work || !head || !reason
      || scope !== `work:edit:${work}` || value('workRevision') !== head || value('eventWork') !== work
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || eventId !== `urn:rezics:event:${hash(`${receiptId}\0author-credit-retired`)}`
      || batch.batchId !== `urn:rezics:outbox:${hash(receiptId)}`) {
      throw new OutboxIncomplete('author credit retirement event differs from receipt');
    }
    const graph = await fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:AuthorCredit ; rv:work ${iri(work)} ;
        rv:creditRevision ${iri(revision)} ; rv:retiredBy ${iri(receiptId)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:AuthorCreditRevision ;
        rv:component ${iri(credit)} . }
    }`);
    if (!graph.boolean) throw new OutboxIncomplete('native author credit retirement is missing');
    return { specversion: '1.0', id: eventId, source: SOURCE,
      type: 'com.rezics.work.author-credit-retired.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.sequence },
        routingEpoch: batch.routingEpoch, ordinal, receipt: { id: receiptId, action: 'work.edit', outcome: 'succeeded',
          admissionId, requestDigest, authorityEpoch, scope, work, workRevision: head, expectedHead: head,
          authorCredit: credit, creditRevision: revision, retirementReason: reason } } };
  }
  if (kind === `${RV}SourceProjectedEvent`) {
    const record = value('sourceRecord');
    const observation = value('sourceObservation');
    const conversion = value('sourceConversion');
    const byteDigest = value('sourceByteDigest');
    const mappingRevision = value('sourceMappingRevision');
    if (action !== 'source.project' || outcome !== `${RV}Succeeded`
      || !receiptId || !requestDigest || !record || !observation || !conversion
      || !byteDigest || mappingRevision !== 'open-library-work-map-v1'
      || value('eventSourceConversion') !== conversion
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence
      || admissionId || authorityEpoch || scope
      || !/^[0-9a-f]{64}$/.test(requestDigest)
      || !/^[0-9a-f]{64}$/.test(byteDigest)) {
      throw new OutboxIncomplete('source projection event differs from its receipt');
    }
    for (const subject of [receiptId, record, observation, conversion]) iri(subject);
    const graph = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH <urn:rezics:graph:source> {
      ${iri(conversion)} a rv:SourceConversion ; rv:sourceObservation ${iri(observation)} ;
        rv:sourceByteDigest ${lit(byteDigest)} ;
        rv:sourceMappingRevision "open-library-work-map-v1" .
      ${iri(observation)} a rv:SourceObservation ; rv:sourceRecord ${iri(record)} ;
        rv:sourceByteDigest ${lit(byteDigest)} .
    } }`);
    if (graph.boolean !== true) throw new OutboxIncomplete('source graph event projection is missing');
    return { specversion: '1.0', id: eventId, source: SOURCE,
      type: 'com.rezics.source.projected.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId,
        sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch,
          sequence: batch.sequence }, routingEpoch: batch.routingEpoch, ordinal,
        receipt: { id: receiptId, action: 'source.project', outcome: 'succeeded',
          requestDigest, record, observation, conversion, byteDigest,
          mappingRevision } } };
  }
  if (contentEventTypes[kind ?? '']) {
    return mapContentOutboxEvent(batch, eventId, value, ordinal);
  }
  if (kind === `${RV}TranslationLinkedEvent`) {
    return translationLinkedEnvelope(fuseki, batch, eventId, value, ordinal);
  }
  if (kind === `${RV}WorkDerivedEvent`) {
    return workDerivedEnvelope(fuseki, batch, eventId, value, ordinal);
  }
  if (kind === `${RV}FixedReleaseSealedEvent`) {
    return fixedReleaseEnvelope(fuseki, batch, eventId, value, ordinal);
  }
  if (kind === `${RV}AddressClaimedEvent`) {
    const work = value('work');
    const routeBinding = value('routeBinding');
    const routeRevision = value('routeRevision');
    const normalizedSlug = value('normalizedSlug');
    if (action !== 'address.claim' || outcome !== `${RV}Succeeded`
      || !receiptId || !admissionId || !requestDigest || !authorityEpoch || !scope
      || !work || !routeBinding || !routeRevision || !normalizedSlug
      || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
      || !/^[0-9a-f-]{36}$/.test(admissionId)
      || scope !== `address:claim:${work}`
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)
      || normalizedSlug.length > 64
      || value('eventWork') !== work || value('eventRouteBinding') !== routeBinding
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
      throw new OutboxIncomplete('address event differs from its terminal receipt');
    }
    for (const subject of [receiptId, work, routeBinding, routeRevision]) iri(subject);
    return { specversion: '1.0', id: eventId, source: SOURCE,
      type: 'com.rezics.address.claimed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
        dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: 'address.claim', outcome: 'succeeded',
        admissionId, requestDigest, authorityEpoch, scope, work,
        routeBinding, routeRevision, normalizedSlug } } };
  }
  if (kind === `${RV}AddressRenamedEvent`) {
    const work = value('work');
    const sourceAddress = value('sourceAddress');
    const sourceRevision = value('sourceRevision');
    const newAddress = value('newAddress');
    const newRevision = value('newRevision');
    const oldSlug = value('oldSlug');
    const normalizedSlug = value('normalizedSlug');
    if (action !== 'address.rename' || outcome !== `${RV}Succeeded`
      || !receiptId || !admissionId || !requestDigest || !authorityEpoch || !scope
      || !work || !sourceAddress || !sourceRevision || !newAddress || !newRevision
      || !oldSlug || !normalizedSlug
      || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
      || !/^[0-9a-f-]{36}$/.test(admissionId)
      || scope !== `address:rename:${work}`
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(oldSlug)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)
      || oldSlug.length > 64 || normalizedSlug.length > 64
      || value('eventWork') !== work
      || value('eventSourceAddress') !== sourceAddress
      || value('eventNewAddress') !== newAddress
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
      throw new OutboxIncomplete('address rename event differs from its terminal receipt');
    }
    for (const subject of [receiptId, work, sourceAddress, sourceRevision,
      newAddress, newRevision]) iri(subject);
    return { specversion: '1.0', id: eventId, source: SOURCE,
      type: 'com.rezics.address.renamed.v1', datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
        dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: 'address.rename', outcome: 'succeeded',
        admissionId, requestDigest, authorityEpoch, scope, work,
        sourceAddress, sourceRevision, newAddress, newRevision,
        oldSlug, normalizedSlug } } };
  }
  if (kind === `${RV}AddressMergedEvent` || kind === `${RV}AddressRetiredEvent`) {
    const merged = kind === `${RV}AddressMergedEvent`;
    const work = value('work');
    const sourceAddress = value('sourceAddress');
    const sourceRevision = value('sourceRevision');
    const normalizedSlug = value('normalizedSlug');
    const redirectWork = value('redirectWork');
    if (action !== 'address.dispose' || outcome !== `${RV}Succeeded`
      || value('operation') !== (merged ? 'merge' : 'retire')
      || value('eventOperation') !== value('operation')
      || !receiptId || !admissionId || !requestDigest || !authorityEpoch || !scope
      || !work || !sourceAddress || !sourceRevision || !normalizedSlug
      || (merged && (!redirectWork || value('eventRedirectWork') !== redirectWork))
      || (!merged && (redirectWork || value('eventRedirectWork')))
      || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
      || !/^[0-9a-f-]{36}$/.test(admissionId)
      || scope !== `address:dispose:${work}`
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug)
      || normalizedSlug.length > 64 || value('eventWork') !== work
      || value('eventSourceAddress') !== sourceAddress
      || value('epoch') !== batch.dataEpoch || value('sequence') !== batch.sequence) {
      throw new OutboxIncomplete('address disposition event differs from its terminal receipt');
    }
    for (const subject of [receiptId, work, sourceAddress, sourceRevision,
      ...(redirectWork ? [redirectWork] : [])]) iri(subject);
    return { specversion: '1.0', id: eventId, source: SOURCE,
      type: merged ? 'com.rezics.address.merged.v1' : 'com.rezics.address.retired.v1',
      datacontenttype: 'application/json',
      data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
        dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal,
      receipt: { id: receiptId, action: 'address.dispose', outcome: 'succeeded',
        admissionId, requestDigest, authorityEpoch, scope, work,
        operation: value('operation'), sourceAddress, sourceRevision,
        normalizedSlug, ...(redirectWork ? { redirectWork } : {}) } } };
  }
  const systemEvent = ownerHandler?.authority === 'system';
  if (!kind || !receiptId || !requestDigest || !/^[0-9a-f]{64}$/.test(requestDigest)
    || (systemEvent
      ? admissionId !== undefined || authorityEpoch !== undefined || scope !== undefined
      : !admissionId || !authorityEpoch || !scope || !/^[0-9]+$/.test(authorityEpoch)
        || !/^[A-Za-z0-9:_./-]{1,128}$/.test(scope) || !/^[0-9a-f-]{36}$/.test(admissionId))
    || value('epoch') !== batch.dataEpoch
    || value('sequence') !== batch.sequence
    || ![`${RV}Succeeded`, `${RV}Cancelled`].includes(outcome ?? '')) {
    throw new OutboxIncomplete('event does not match its committed source position or receipt');
  }
  iri(receiptId);
  const work = value('work');
  const target = value('target');
  const main = value('main');
  const workRevision = value('workRevision');
  const mainRevision = value('mainRevision');
  const expectedHead = value('expectedHead');
  const operation = value('operation');
  const reason = value('reason');
  const contribution = value('contribution');
  const draftRevision = value('draftRevision');
  const author = value('author');
  const language = value('language');
  const publicationDecision = value('publicationDecision');
  const selectedDraft = value('selectedDraft');
  const selection = value('selection');
  const matchUnit = value('matchUnit');
  const space = value('space');
  const realm = value('realm');
  const slot = value('slot');
  const rejection = value('rejection');
  const reasonCode = value('reasonCode');
  const spaceRevision = value('spaceRevision');
  const realmRevision = value('realmRevision');
  const owner = value('owner');
  const classificationContext = value('classificationContext');
  const contextRevision = value('contextRevision');
  const scheme = value('scheme');
  const concept = value('concept');
  const path = value('path');
  const expression = value('expression');
  const sense = value('sense');
  const definitionRevision = value('definitionRevision');
  const application = value('application');
  const decision = value('decision');
  const decisionOutcome = value('decisionOutcome');
  const ratingContext = value('ratingContext');
  const ratingContextRevision = value('ratingContextRevision');
  const ratingPolicyRevision = value('ratingPolicyRevision');
  const ratingPolicyPredecessor = value('ratingPolicyPredecessor');
  const ratingPolicy = value('ratingPolicy');
  const ratingSlot = value('ratingSlot');
  const ratingObservation = value('ratingObservation');
  const observationRevision = value('observationRevision');
  const ratingAvailability = value('ratingAvailability');
  const ratingValue = value('ratingValue');
  if ((value('eventOperation') && value('eventOperation') !== operation)
    || (value('eventWork') && value('eventWork') !== work)
    || (value('eventContribution') && value('eventContribution') !== contribution)
    || (value('eventSpace') && value('eventSpace') !== space)
    || (value('eventRealm') && value('eventRealm') !== realm)
    || (value('eventApplication') && value('eventApplication') !== application)
    || (value('eventRatingContext') && value('eventRatingContext') !== ratingContext)
    || (value('eventRatingObservation') && value('eventRatingObservation') !== ratingObservation)) {
    throw new OutboxIncomplete('event references differ from its receipt');
  }
  const kindToType: Record<string, MainCloudEvent['type']> = {
    [`${RV}WorkCreatedEvent`]: 'com.rezics.work.created.v1',
    [`${RV}WorkEditedEvent`]: 'com.rezics.work.edited.v1',
    [`${RV}WorkEditRejectedEvent`]: 'com.rezics.work.edit-rejected.v1',
    [`${RV}AdmissionCancelledEvent`]: 'com.rezics.work.admission-cancelled.v1',
    [`${RV}ContributionDraftCreatedEvent`]: 'com.rezics.contribution.draft-created.v1',
    [`${RV}ContributionDraftEditedEvent`]: 'com.rezics.contribution.draft-edited.v1',
    [`${RV}ContributionDraftEditRejectedEvent`]: 'com.rezics.contribution.draft-edit-rejected.v1',
    [`${RV}ContributionAdmissionCancelledEvent`]: 'com.rezics.contribution.admission-cancelled.v1',
    [`${RV}ContributionEligibilityRecordedEvent`]: 'com.rezics.contribution.eligibility-recorded.v1',
    [`${RV}ContributionPublicationRejectedEvent`]: 'com.rezics.contribution.publication-rejected.v1',
    [`${RV}ContributionPublicationCancelledEvent`]: 'com.rezics.contribution.publication-cancelled.v1',
    [`${RV}PublicationSelectionChangedEvent`]: 'com.rezics.publication.selection-changed.v1',
    [`${RV}PublicationSelectionRejectedEvent`]: 'com.rezics.publication.selection-rejected.v1',
    [`${RV}PublicationSelectionCancelledEvent`]: 'com.rezics.publication.selection-cancelled.v1',
    [`${RV}SpaceCreatedEvent`]: 'com.rezics.space.created.v1',
    [`${RV}SpaceCreationCancelledEvent`]: 'com.rezics.space.creation-cancelled.v1',
    [`${RV}RealmSelectionChangedEvent`]: 'com.rezics.realm.selection-changed.v1',
    [`${RV}RealmSelectionRejectedEvent`]: 'com.rezics.realm.selection-rejected.v1',
    [`${RV}RealmSelectionCancelledEvent`]: 'com.rezics.realm.selection-cancelled.v1',
    [`${RV}RealmPublicationSuppressedEvent`]: 'com.rezics.realm.publication-suppressed.v1',
    [`${RV}RealmPublicationSuppressionRejectedEvent`]: 'com.rezics.realm.suppression-rejected.v1',
    [`${RV}RealmPublicationSuppressionCancelledEvent`]: 'com.rezics.realm.suppression-cancelled.v1',
    [`${RV}ClassificationContextCreatedEvent`]: 'com.rezics.classification.context-created.v1',
    [`${RV}ClassificationContextCancelledEvent`]: 'com.rezics.classification.context-cancelled.v1',
    [`${RV}ClassificationPropositionDefinedEvent`]: 'com.rezics.classification.proposition-defined.v1',
    [`${RV}ClassificationPropositionCancelledEvent`]: 'com.rezics.classification.proposition-cancelled.v1',
    [`${RV}ClassificationDecisionChangedEvent`]: 'com.rezics.classification.decision-changed.v1',
    [`${RV}ClassificationDecisionStaleEvent`]: 'com.rezics.classification.decision-stale.v1',
    [`${RV}ClassificationDecisionCancelledEvent`]: 'com.rezics.classification.decision-cancelled.v1',
    [`${RV}RatingContextCreatedEvent`]: 'com.rezics.rating.context-created.v1',
    [`${RV}RatingContextCancelledEvent`]: 'com.rezics.rating.context-cancelled.v1',
    [`${RV}RatingPolicyChangedEvent`]: 'com.rezics.rating.policy-changed.v1',
    [`${RV}RatingPolicyStaleEvent`]: 'com.rezics.rating.policy-stale.v1',
    [`${RV}RatingPolicyCancelledEvent`]: 'com.rezics.rating.policy-cancelled.v1',
    [`${RV}RatingObservationChangedEvent`]: 'com.rezics.rating.observation-changed.v1',
    [`${RV}RatingObservationStaleEvent`]: 'com.rezics.rating.observation-stale.v1',
    [`${RV}RatingObservationCancelledEvent`]: 'com.rezics.rating.observation-cancelled.v1',
  };
  const type = kindToType[kind];
  // Legacy kinds always use their unchanged validation below. New owner kinds
  // are selected by exact RDF class, then their own reader proves domain facts.
  if (!type) {
    const handler = ownerHandler;
    if (handler) {
      if (action !== handler.action && !handler.actions?.includes(action ?? '')) {
        throw new OutboxIncomplete('owner event action differs from handler');
      }
      const envelope = await handler.read({ fuseki, batch, eventId, value: ownerValue, ordinal });
      if (!envelope?.data?.receipt
        || envelope.specversion !== '1.0' || envelope.id !== eventId || envelope.source !== SOURCE
        || envelope.type !== handler.type || envelope.datacontenttype !== 'application/json'
        || envelope.data.batchId !== batch.batchId
        || envelope.data.sourcePosition.datasetId !== 'product'
        || envelope.data.sourcePosition.dataEpoch !== batch.dataEpoch
        || envelope.data.sourcePosition.sequence !== batch.sequence
        || envelope.data.routingEpoch !== batch.routingEpoch || envelope.data.ordinal !== ordinal
        || envelope.data.receipt.id !== receiptId || envelope.data.receipt.action !== action
        || envelope.data.receipt.outcome !== (outcome === `${RV}Succeeded` ? 'succeeded' : 'cancelled')
        || envelope.data.receipt.admissionId !== admissionId
        || envelope.data.receipt.requestDigest !== requestDigest
        || envelope.data.receipt.authorityEpoch !== authorityEpoch
        || envelope.data.receipt.scope !== scope
        || (systemEvent ? !envelope.data.receipt.systemProof
          : envelope.data.receipt.systemProof !== undefined)) {
        throw new OutboxIncomplete('owner event envelope differs from terminal receipt');
      }
      return envelope;
    }
    throw new OutboxIncomplete(`unsupported outbox event kind ${kind}`);
  }
  if (!admissionId || !authorityEpoch || !scope) {
    throw new OutboxIncomplete('legacy event has no Access admission');
  }
  if (!['work.create', 'work.edit', 'contribution.create', 'contribution.edit', 'contribution.publish', 'publication.select', 'space.create', 'publication.adopt', 'publication.reject', 'publication.reject.organization', 'classification.context.configure', 'classification.proposition.define', 'classification.decision.set', 'rating.context.create', 'rating.context.policy.set', 'rating.observation.set'].includes(action ?? '')) {
    throw new OutboxIncomplete('event action is not registered');
  }
  if (!type || (type === 'com.rezics.work.created.v1' && (action !== 'work.create'
    || outcome !== `${RV}Succeeded` || !work || !main || !workRevision || !mainRevision
    || !operation || expectedHead || reason))
    || (type === 'com.rezics.work.edited.v1' && (action !== 'work.edit'
      || outcome !== `${RV}Succeeded` || !work || !workRevision || !expectedHead
      || !operation || main || mainRevision || reason))
    || (type === 'com.rezics.work.edit-rejected.v1' && (action !== 'work.edit'
      || outcome !== `${RV}Cancelled` || reason !== `${RV}StaleHead` || work || workRevision))
    || (type === 'com.rezics.work.admission-cancelled.v1' && (outcome !== `${RV}Cancelled`
      || !['work.create', 'work.edit'].includes(action ?? '')
      || reason || work || workRevision || contribution || draftRevision))
    || (type === 'com.rezics.contribution.draft-created.v1'
      && (action !== 'contribution.create' || outcome !== `${RV}Succeeded`
        || !work || !contribution || !draftRevision || !author || !language
        || !operation || value('eventOperation') !== operation
        || value('eventWork') !== work || value('eventContribution') !== contribution
        || main || workRevision || mainRevision || expectedHead || reason))
    || (type === 'com.rezics.contribution.draft-edited.v1'
      && (action !== 'contribution.edit' || outcome !== `${RV}Succeeded`
        || !work || !contribution || !draftRevision || !expectedHead || !author || !language
        || !operation || value('eventOperation') !== operation
        || value('eventWork') !== work || value('eventContribution') !== contribution
        || main || workRevision || mainRevision || reason))
    || (type === 'com.rezics.contribution.draft-edit-rejected.v1'
      && (action !== 'contribution.edit' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || contribution
        || draftRevision || expectedHead || author || language))
    || (type === 'com.rezics.contribution.admission-cancelled.v1'
      && (!['contribution.create', 'contribution.edit'].includes(action ?? '')
        || outcome !== `${RV}Cancelled`
        || operation || work || contribution || draftRevision || author || language
        || main || workRevision || mainRevision || expectedHead || reason))
    || (type === 'com.rezics.contribution.eligibility-recorded.v1'
      && (action !== 'contribution.publish' || outcome !== `${RV}Succeeded`
        || !operation || !work || !contribution || !publicationDecision || !selectedDraft
        || !author || !language || reason || draftRevision || main || workRevision || mainRevision
        || value('eventOperation') !== operation || value('eventWork') !== work
        || value('eventContribution') !== contribution))
    || (type === 'com.rezics.contribution.publication-rejected.v1'
      && (action !== 'contribution.publish' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || contribution
        || publicationDecision || selectedDraft || expectedHead || author || language))
    || (type === 'com.rezics.contribution.publication-cancelled.v1'
      && (action !== 'contribution.publish' || outcome !== `${RV}Cancelled`
        || reason || operation || work || contribution || publicationDecision
        || selectedDraft || expectedHead || author || language))
    || (type === 'com.rezics.publication.selection-changed.v1'
      && (action !== 'publication.select' || outcome !== `${RV}Succeeded`
        || !operation || !work || !main || !mainRevision
        || !contribution || !publicationDecision
        || !selectedDraft || !selection || !matchUnit || !language || reason
        || draftRevision || workRevision || author
        || value('eventOperation') !== operation || value('eventWork') !== work))
    || (type === 'com.rezics.publication.selection-rejected.v1'
      && (action !== 'publication.select' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || main || contribution
        || publicationDecision || selectedDraft || selection || matchUnit || expectedHead))
    || (type === 'com.rezics.publication.selection-cancelled.v1'
      && (action !== 'publication.select' || outcome !== `${RV}Cancelled`
        || reason || operation || work || main || contribution
        || publicationDecision || selectedDraft || selection || matchUnit || expectedHead))
    || (type === 'com.rezics.space.created.v1'
      && (action !== 'space.create' || outcome !== `${RV}Succeeded`
        || !operation || !space || !realm || !spaceRevision || !realmRevision || !owner
        || value('eventOperation') !== operation || value('eventSpace') !== space
        || work || main || contribution || selection || reason))
    || (type === 'com.rezics.space.creation-cancelled.v1'
      && (action !== 'space.create' || outcome !== `${RV}Cancelled`
        || operation || space || realm || spaceRevision || realmRevision || owner || reason))
    || (type === 'com.rezics.realm.selection-changed.v1'
      && (action !== 'publication.adopt' || outcome !== `${RV}Succeeded`
        || !operation || !work || !main || !realm || !slot || !contribution
        || !publicationDecision || !selectedDraft || !selection || !matchUnit || !language
        || reason || space || spaceRevision || realmRevision || owner
        || value('eventOperation') !== operation || value('eventWork') !== work
        || value('eventRealm') !== realm))
    || (type === 'com.rezics.realm.selection-rejected.v1'
      && (action !== 'publication.adopt' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || main || realm || slot
        || contribution || publicationDecision || selectedDraft || selection || matchUnit))
    || (type === 'com.rezics.realm.selection-cancelled.v1'
      && (action !== 'publication.adopt' || outcome !== `${RV}Cancelled`
        || reason || operation || work || main || realm || slot
        || contribution || publicationDecision || selectedDraft || selection || matchUnit))
    || (type === 'com.rezics.realm.publication-suppressed.v1'
      && (!['publication.reject', 'publication.reject.organization'].includes(action!) || outcome !== `${RV}Succeeded`
        || !operation || !work || !main || !realm || !slot || !rejection
        || reasonCode !== `${RV}NotApproved` || reason || selection || matchUnit
        || contribution || publicationDecision || selectedDraft || language
        || value('eventOperation') !== operation || value('eventWork') !== work
        || value('eventRealm') !== realm))
    || (type === 'com.rezics.realm.suppression-rejected.v1'
      && (!['publication.reject', 'publication.reject.organization'].includes(action!) || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || main || realm || slot
        || rejection || reasonCode || selection || matchUnit))
    || (type === 'com.rezics.realm.suppression-cancelled.v1'
      && (!['publication.reject', 'publication.reject.organization'].includes(action!) || outcome !== `${RV}Cancelled`
        || reason || operation || work || main || realm || slot
        || rejection || reasonCode || selection || matchUnit))
    || (type === 'com.rezics.classification.context-created.v1'
      && (action !== 'classification.context.configure' || outcome !== `${RV}Succeeded`
        || !operation || !realm || !classificationContext || !contextRevision
        || scope !== `classification:context:${realm}`
        || value('eventOperation') !== operation || value('eventRealm') !== realm
        || work || main || space || contribution || selection || reason || owner
        || spaceRevision || realmRevision || slot || rejection || matchUnit
        || expectedHead || author || language))
    || (type === 'com.rezics.classification.context-cancelled.v1'
      && (action !== 'classification.context.configure' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('classification:context:')
        || operation || realm || classificationContext || contextRevision || reason
        || work || main || space || contribution || selection || owner || slot
        || rejection || matchUnit || expectedHead || author || language))
    || (type === 'com.rezics.classification.proposition-defined.v1'
      && (action !== 'classification.proposition.define' || outcome !== `${RV}Succeeded`
        || scope !== 'classification:define:global' || !operation || !scheme || !concept
        || !path || !expression || !sense || !definitionRevision
        || value('eventOperation') !== operation || reason || work || main || realm
        || classificationContext || contextRevision || space || contribution || selection))
    || (type === 'com.rezics.classification.proposition-cancelled.v1'
      && (action !== 'classification.proposition.define' || outcome !== `${RV}Cancelled`
        || scope !== 'classification:define:global' || operation || scheme || concept
        || path || expression || sense || definitionRevision || reason || work || main
        || realm || classificationContext || contextRevision || space || contribution))
    || (type === 'com.rezics.classification.decision-changed.v1'
      && (action !== 'classification.decision.set' || outcome !== `${RV}Succeeded`
        || !operation || !work || !main || !sense || !classificationContext
        || !slot || !application || !decision
        || ![`${RV}Accepted`, `${RV}Rejected`].includes(decisionOutcome ?? '')
        || (realm ? scope !== `classification:decide:${realm}` || !contextRevision
          : scope !== 'classification:decide:global' || contextRevision)
        || value('eventOperation') !== operation || value('eventWork') !== work
        || value('eventRealm') !== realm || value('eventApplication') !== application
        || contribution || selection || space || reason))
    || (type === 'com.rezics.classification.decision-stale.v1'
      && (action !== 'classification.decision.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('classification:decide:') || reason !== `${RV}StaleHead`
        || operation || work || main || sense || classificationContext || slot
        || application || decision || decisionOutcome || realm || contextRevision))
    || (type === 'com.rezics.classification.decision-cancelled.v1'
      && (action !== 'classification.decision.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('classification:decide:') || reason
        || operation || work || main || sense || classificationContext || slot
        || application || decision || decisionOutcome || realm || contextRevision))
    || (type === 'com.rezics.rating.context-created.v1'
      && (action !== 'rating.context.create' || outcome !== `${RV}Succeeded`
        || !operation || !realm || !ratingContext || !ratingContextRevision
        || (scope !== `rating:context:${realm}`
          && !(realm === GLOBAL_RATING_POPULATION_OWNER && scope === GLOBAL_TARGET_CONTEXT_SCOPE))
        || value('eventOperation') !== operation || value('eventRealm') !== realm
        || work || main || space || contribution || classificationContext
        || contextRevision || sense || application || decision || reason))
    || (type === 'com.rezics.rating.context-cancelled.v1'
      && (action !== 'rating.context.create' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:context:') || operation || realm || ratingContext
        || ratingContextRevision || reason || work || main || space || contribution
        || classificationContext || contextRevision || sense || application || decision))
    || (type === 'com.rezics.rating.policy-changed.v1'
      && (action !== 'rating.context.policy.set' || outcome !== `${RV}Succeeded`
        || !operation || !realm || !ratingContext || !ratingContextRevision
        || !ratingPolicyRevision || !ratingPolicyPredecessor
        || !['https://rezics.com/definition/rating-latest-per-rater-mean-v1',
          'https://rezics.com/definition/rating-mean-per-rater-v1',
          'https://rezics.com/definition/rating-pooled-observation-mean-v1'].includes(ratingPolicy ?? '')
        || scope !== `rating:policy:${ratingContext}` || reason
        || value('eventOperation') !== operation || value('eventRatingContext') !== ratingContext))
    || (type === 'com.rezics.rating.policy-stale.v1'
      && (action !== 'rating.context.policy.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:policy:') || reason !== `${RV}StaleHead`
        || operation || ratingContext || ratingPolicyRevision))
    || (type === 'com.rezics.rating.policy-cancelled.v1'
      && (action !== 'rating.context.policy.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:policy:') || reason
        || operation || ratingContext || ratingPolicyRevision))
    || (type === 'com.rezics.rating.observation-changed.v1'
      && (action !== 'rating.observation.set' || outcome !== `${RV}Succeeded`
        || !operation || !realm || !ratingContext || !contextRevision
        || (target ? !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(target) || !!work || !!main : !work || !main)
        || !ratingSlot || !ratingObservation || !observationRevision
        || scope !== `rating:observe:${ratingContext}` || reason
        || ![`${RV}Available`, `${RV}Withdrawn`].includes(ratingAvailability ?? '')
        || (ratingAvailability === `${RV}Available`
          && !/^(?:[1-9]|10)$/.test(ratingValue ?? ''))
        || (ratingAvailability === `${RV}Withdrawn` && ratingValue)
        || value('eventOperation') !== operation
        || value('eventRatingContext') !== ratingContext
        || value('eventRatingObservation') !== ratingObservation
        || classificationContext || ratingContextRevision || decision || application))
    || (type === 'com.rezics.rating.observation-stale.v1'
      && (action !== 'rating.observation.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:observe:') || reason !== `${RV}StaleHead`
        || operation || realm || ratingContext || ratingSlot || ratingObservation
        || observationRevision || ratingAvailability || ratingValue || work || main || target))
    || (type === 'com.rezics.rating.observation-cancelled.v1'
      && (action !== 'rating.observation.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:observe:') || reason
        || operation || realm || ratingContext || ratingSlot || ratingObservation
        || observationRevision || ratingAvailability || ratingValue || work || main || target))) {
    throw new OutboxIncomplete('event type differs from terminal receipt');
  }
  if (type === 'com.rezics.rating.context-created.v1' && scope === GLOBAL_TARGET_CONTEXT_SCOPE) {
    // The specialized administrator scope cannot relay a legacy standing
    // creation: its retained anchor must prove the v4 target owner profile.
    const proof = await fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(ratingContextRevision!)} a rv:RevisionAnchor ; rv:component ${iri(ratingContext!)} ;
        rv:modelRevision ${iri(GLOBAL_TARGET_CONTEXT_PROFILE)} ; rv:shapeRevision ${iri(GLOBAL_TARGET_CONTEXT_PROFILE)} .
    } }`, 1024);
    if (proof.boolean !== true) throw new OutboxIncomplete('Global target creation has no retained v4 profile proof');
  }
  const receipt: MainCloudEvent['data']['receipt'] = {
    id: receiptId, action: action as MainCloudEvent['data']['receipt']['action'],
    outcome: outcome === `${RV}Succeeded` ? 'succeeded' : 'cancelled',
    admissionId, requestDigest, authorityEpoch, scope,
    ...(operation ? { operation } : {}), ...(work ? { work } : {}),
    ...(target ? { target } : {}),
    ...(main ? { mainVersion: main } : {}),
    ...(workRevision ? { workRevision,
      workManifest: await revisionManifest(fuseki, workRevision) } : {}),
    ...(mainRevision ? { mainRevision,
      mainManifest: await revisionManifest(fuseki, mainRevision) } : {}),
    ...(expectedHead ? { expectedHead } : {}),
    ...(reason ? { reason: 'stale-head' as const } : {}),
    ...(contribution ? { contribution } : {}),
    ...(draftRevision ? { draftRevision,
      draftManifest: await revisionManifest(fuseki, draftRevision) } : {}),
    ...(publicationDecision ? { publicationDecision,
      publicationManifest: await revisionManifest(fuseki, publicationDecision) } : {}),
    ...(selectedDraft ? { selectedDraft } : {}),
    ...(selection ? { selection,
      selectionManifest: await revisionManifest(fuseki, selection) } : {}),
    ...(matchUnit ? { matchUnit } : {}),
    ...(author ? { author } : {}), ...(language ? { language } : {}),
    ...(space ? { space } : {}), ...(realm ? { realm } : {}),
    ...(spaceRevision ? { spaceRevision,
      spaceManifest: await revisionManifest(fuseki, spaceRevision) } : {}),
    ...(realmRevision ? { realmRevision,
      realmManifest: await revisionManifest(fuseki, realmRevision) } : {}),
    ...(owner ? { owner } : {}),
    ...(slot ? { slot } : {}),
    ...(rejection ? { rejection,
      rejectionManifest: await revisionManifest(fuseki, rejection) } : {}),
    ...(reasonCode ? { reasonCode: 'not-approved' as const } : {}),
    ...(classificationContext ? { classificationContext } : {}),
    ...(contextRevision ? { contextRevision,
      contextManifest: await revisionManifest(fuseki, contextRevision) } : {}),
    ...(scheme ? { scheme } : {}), ...(concept ? { concept } : {}),
    ...(path ? { path } : {}), ...(expression ? { expression } : {}),
    ...(sense ? { sense } : {}),
    ...(definitionRevision ? { definitionRevision,
      definitionManifest: await revisionManifest(fuseki, definitionRevision) } : {}),
    ...(application ? { application } : {}),
    ...(decision ? { decision, decisionManifest: await revisionManifest(fuseki, decision) } : {}),
    ...(decisionOutcome ? { decisionOutcome: decisionOutcome === `${RV}Accepted`
      ? 'accepted' as const : 'rejected' as const } : {}),
    ...(ratingContext ? { ratingContext } : {}),
    ...(ratingContextRevision ? { ratingContextRevision,
      ratingContextManifest: await revisionManifest(fuseki, ratingContextRevision) } : {}),
    ...(ratingPolicyRevision ? { ratingPolicyRevision,
      ratingPolicyManifest: await revisionManifest(fuseki, ratingPolicyRevision) } : {}),
    ...(ratingPolicyPredecessor ? { ratingPolicyPredecessor } : {}),
    ...(ratingPolicy ? { ratingPolicy } : {}),
    ...(ratingSlot ? { ratingSlot } : {}),
    ...(ratingObservation ? { ratingObservation } : {}),
    ...(observationRevision ? { observationRevision,
      observationManifest: await revisionManifest(fuseki, observationRevision) } : {}),
    ...(ratingAvailability ? { ratingAvailability: ratingAvailability === `${RV}Available`
      ? 'available' as const : 'withdrawn' as const } : {}),
    ...(ratingValue ? { ratingValue: Number(ratingValue) } : {}),
  };
  return { specversion: '1.0', id: eventId, source: SOURCE, type,
    datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal, receipt } };
}

/** Durable, idempotent first handoff. Consumers attach downstream effects later. */
async function deliver(pool: Pool, event: DeliveredMainEvent): Promise<void> {
  const sourcePosition = event.data.relayPosition;
  if (!sourcePosition || sourcePosition.streamScope !== MAIN_RELAY_STREAM_SCOPE) {
    throw new OutboxIncomplete('durable handoff requires the Main relay stream position');
  }
  const body = JSON.stringify(event);
  const inserted = await pool.query(
    `INSERT INTO relay.delivered_event (source, event_id, data_epoch, sequence, envelope, stream_scope)
     VALUES ($1, $2, $3, $4, $5::jsonb, '${MAIN_RELAY_STREAM_SCOPE}') ON CONFLICT DO NOTHING`,
    [event.source, event.id, sourcePosition.dataEpoch, sourcePosition.sequence, body]);
  if (inserted.rowCount === 0) {
    const existing = await pool.query<{ same: boolean }>(
      `SELECT (envelope = $3::jsonb OR
         NOT (envelope->'data' ? 'relayPosition') AND
         jsonb_set(envelope, '{data,relayPosition}', $6::jsonb) = $3::jsonb)
         AND data_epoch = $4 AND sequence = $5 AS same
       FROM relay.delivered_event WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND source = $1 AND event_id = $2`,
      [event.source, event.id, body, sourcePosition.dataEpoch, sourcePosition.sequence, JSON.stringify(sourcePosition)]);
    if (existing.rows[0]?.same !== true) throw new OutboxIncomplete('event identity has a different durable envelope');
  }
}

async function retainBatch(pool: Pool, batch: MainOutboxBatch): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO relay.delivered_batch
       (data_epoch, sequence, batch_id, routing_epoch, event_count, stream_scope)
     VALUES ($1, $2, $3, $4, $5, '${MAIN_RELAY_STREAM_SCOPE}') ON CONFLICT DO NOTHING`,
    [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventIds.length]);
  if (inserted.rowCount === 0) {
    const existing = await pool.query<{ same: boolean }>(
      `SELECT batch_id = $3 AND routing_epoch = $4 AND event_count = $5 AS same
       FROM relay.delivered_batch WHERE stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $1 AND sequence = $2`,
      [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventIds.length]);
    if (existing.rows[0]?.same !== true) {
      throw new OutboxIncomplete('batch position has a different durable header');
    }
  }
}

export async function initializeRelayCheckpoint(pool: Pool, consumer: string, dataEpoch: string): Promise<void> {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(consumer) || !dataEpoch) throw new RelayCheckpointConflict('invalid relay identity');
  await pool.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence, stream_scope)
    VALUES ($1, $2, 0, '${MAIN_RELAY_STREAM_SCOPE}') ON CONFLICT DO NOTHING`, [consumer, dataEpoch]);
}

/** At least once handoff: a crash after delivery repeats the batch safely. */
export async function relayMainOutboxOnce(
  fuseki: FusekiClient, pool: Pool, consumer: string,
  hooks?: { afterDelivery?: (batch: MainOutboxBatch) => Promise<void>; ownerOutbox?: CustodiedOutboxSource },
): Promise<MainOutboxBatch | null> {
  const checkpoint = await pool.query<{ stream_scope: string; data_epoch: string; sequence: string }>(
    'SELECT stream_scope, data_epoch, sequence FROM relay.checkpoint WHERE consumer = $1', [consumer]);
  const cursor = checkpoint.rows[0];
  if (!cursor) throw new RelayCheckpointConflict('relay checkpoint is uninitialized');
  if (cursor.stream_scope !== MAIN_RELAY_STREAM_SCOPE) throw new RelayCheckpointConflict('relay checkpoint stream differs');
  const batch = await readNextMainOutboxBatch(fuseki, cursor.data_epoch, cursor.sequence, hooks?.ownerOutbox);
  if (!batch) return null;
  const events = await Promise.all(batch.eventIds.map(async eventId => {
    try { return await readMainOutboxEnvelope(fuseki, batch, eventId, undefined, hooks?.ownerOutbox); }
    catch (error) {
      if (isRelayTransientFailure(error)) throw error;
      throw new RelayEventBlocked(batch, eventId,
        error instanceof Error ? error.message : String(error));
    }
  }));
  events.sort((a, b) => a.data.ordinal - b.data.ordinal);
  if (events.some((event, index) => event.data.ordinal !== index)) {
    throw new OutboxIncomplete('outbox event ordinals are not complete');
  }
  await retainBatch(pool, batch);
  for (const event of events) await deliver(pool, event);
  await hooks?.afterDelivery?.(batch);
  const advanced = await pool.query(
    `UPDATE relay.checkpoint SET sequence = $3, updated_at = clock_timestamp()
     WHERE consumer = $1 AND stream_scope = '${MAIN_RELAY_STREAM_SCOPE}' AND data_epoch = $2 AND sequence = $4`,
    [consumer, batch.dataEpoch, batch.sequence, cursor.sequence]);
  if (advanced.rowCount !== 1) throw new RelayCheckpointConflict('relay checkpoint changed during delivery');
  return batch;
}
