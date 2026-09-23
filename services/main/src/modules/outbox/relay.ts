import type { Pool } from 'pg';
import { createHash } from 'node:crypto';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';

const SOURCE = 'https://rezics.com/services/main';

export class OutboxGap extends Error {}
export class OutboxIncomplete extends Error {}
export class OutboxEpochChanged extends Error {}
export class OutboxRecoveryHold extends Error {}
export class RelayCheckpointConflict extends Error {}

export interface RelayCoverage {
  consumer: string;
  dataEpoch: string;
  sequence: string;
  batchCount: string;
  batchDigest: string;
  eventCount: string;
  eventDigest: string;
}

/** Offline coverage of the durable handoff through one acknowledged checkpoint. */
export async function relayCoverage(pool: Pool, consumer: string): Promise<RelayCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checkpoint = await client.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch, sequence FROM relay.checkpoint WHERE consumer = $1', [consumer]);
    const row = checkpoint.rows[0];
    if (!row) throw new RelayCheckpointConflict('relay checkpoint is uninitialized');
    const uncheckpointed = await client.query(
      `SELECT 1 FROM relay.delivered_event WHERE data_epoch = $1 AND sequence > $2
       UNION ALL SELECT 1 FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence > $2 LIMIT 1`,
      [row.data_epoch, row.sequence]);
    if (uncheckpointed.rowCount) {
      throw new RelayCheckpointConflict('delivered handoff exceeds relay checkpoint');
    }
    const batchDigest = createHash('sha256');
    let batchCount = 0n;
    while (true) {
      const page = await client.query<{ sequence: string; batch_id: string;
        routing_epoch: string; event_count: number; actual_count: string }>(
        `SELECT batch.sequence::text, batch.batch_id, batch.routing_epoch, batch.event_count,
           (SELECT count(*)::text FROM relay.delivered_event AS event
            WHERE event.data_epoch = batch.data_epoch AND event.sequence = batch.sequence) AS actual_count
         FROM relay.delivered_batch AS batch
         WHERE batch.data_epoch = $1 AND batch.sequence > $2 AND batch.sequence <= $3
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
    while (true) {
      const page = await client.query<{ source: string; event_id: string;
        sequence: string; body: string }>(
        `SELECT source, event_id, sequence::text, envelope::text AS body
         FROM relay.delivered_event WHERE data_epoch = $1 AND sequence <= $2
           AND (sequence, event_id) > ($3::numeric, $4)
         ORDER BY sequence, event_id LIMIT 1000`,
        [row.data_epoch, row.sequence, afterSequence, afterEventId]);
      for (const event of page.rows) {
        digest.update(JSON.stringify([event.source, event.event_id, event.sequence, event.body]));
        digest.update('\n');
        count++;
        afterSequence = event.sequence;
        afterEventId = event.event_id;
      }
      if (page.rows.length < 1000) break;
    }
    await client.query('COMMIT');
    return { consumer, dataEpoch: row.data_epoch, sequence: row.sequence,
      batchCount: batchCount.toString(), batchDigest: batchDigest.digest('hex'),
      eventCount: count.toString(), eventDigest: digest.digest('hex') };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export interface MainOutboxBatch {
  batchId: string;
  dataEpoch: string;
  sequence: string;
  routingEpoch: string;
  eventIds: string[];
}

export interface MainCloudEvent {
  specversion: '1.0';
  id: string;
  source: typeof SOURCE;
  type: 'com.rezics.work.created.v1' | 'com.rezics.work.edited.v1'
    | 'com.rezics.work.edit-rejected.v1' | 'com.rezics.work.admission-cancelled.v1'
    | 'com.rezics.contribution.draft-created.v1'
    | 'com.rezics.contribution.admission-cancelled.v1';
  datacontenttype: 'application/json';
  data: { batchId: string; sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; routingEpoch: string; ordinal: number; receipt: {
      id: string; action: 'work.create' | 'work.edit' | 'contribution.create'; outcome: 'succeeded' | 'cancelled';
      admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
      operation?: string; work?: string; mainVersion?: string; workRevision?: string;
      mainRevision?: string; expectedHead?: string; reason?: 'stale-head';
      workManifest?: string; mainManifest?: string;
      contribution?: string; draftRevision?: string; draftManifest?: string;
      author?: string; language?: string;
    } };
}

function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,99})$/.test(value)) throw new OutboxIncomplete('invalid outbox sequence');
  return BigInt(value);
}

/** One bounded source batch; each query uses the same wrapped Fuseki dataset. */
export async function readNextMainOutboxBatch(
  fuseki: FusekiClient, dataEpoch: string, afterSequence: string,
): Promise<MainOutboxBatch | null> {
  const after = decimal(afterSequence);
  const result = await fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?controlSequence ?routing ?hold ?batch ?sequence ?eventCount WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(dataEpoch)} ;
        rv:routingEpoch ?routing ; rv:sequence ?controlSequence . }
      OPTIONAL { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold ?hold } }
      OPTIONAL { GRAPH ${iri(GRAPHS.outbox)} { ?batch a rv:OutboxBatch ;
        rv:dataEpoch ${lit(dataEpoch)} ; rv:sequence ?sequence ; rv:eventCount ?eventCount . }
        FILTER(?sequence > ${afterSequence}) }
    } ORDER BY ?sequence ?batch LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0 || !rows[0]?.controlSequence || !rows[0]?.routing) {
    throw new OutboxEpochChanged('outbox source epoch is unavailable or ambiguous');
  }
  const row = rows[0]!;
  if (rows.length > 1 && rows[1]?.sequence?.value === row.sequence?.value) {
    throw new OutboxIncomplete('outbox position has multiple batch headers');
  }
  if (row.hold?.value === 'true') throw new OutboxRecoveryHold('restored source is held');
  const highWater = decimal(row.controlSequence!.value);
  if (after > highWater) throw new OutboxGap('checkpoint exceeds source position');
  if (!row.batch || !row.sequence || !row.eventCount) {
    if (highWater > after) throw new OutboxGap('retained outbox batch is missing');
    return null;
  }
  const sequence = decimal(row.sequence.value);
  if (sequence !== after + 1n || sequence > highWater) throw new OutboxGap('outbox sequence is not contiguous');
  const count = Number(decimal(row.eventCount.value));
  if (!Number.isSafeInteger(count) || count > 100) throw new OutboxIncomplete('outbox event count exceeds admitted bound');
  const batchId = row.batch.value;
  iri(batchId);
  const members = await fuseki.query(`PREFIX rv: <${RV}> SELECT ?event WHERE {
    GRAPH ${iri(GRAPHS.outbox)} { ${iri(batchId)} rv:event ?event }
  } ORDER BY ?event`);
  const eventIds = (members.results?.bindings ?? []).map(member => member.event?.value ?? '');
  if (eventIds.length !== count || new Set(eventIds).size !== count) {
    throw new OutboxIncomplete('outbox batch event count differs from retained members');
  }
  for (const eventId of eventIds) {
    iri(eventId);
    const exists = await fuseki.query(`ASK { GRAPH ${iri(GRAPHS.outbox)} { ${iri(eventId)} ?p ?o } }`);
    if (exists.boolean !== true) throw new OutboxIncomplete('outbox event object is missing');
  }
  return { batchId, dataEpoch, sequence: sequence.toString(),
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

async function envelope(fuseki: FusekiClient, batch: MainOutboxBatch, eventId: string): Promise<MainCloudEvent> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?kind ?ordinal ?action ?receipt ?eventOperation ?eventWork ?outcome ?admissionId
    ?digest ?authorityEpoch ?scope ?epoch ?sequence ?operation ?work ?main
    ?workRevision ?mainRevision ?expectedHead ?reason ?contribution ?draftRevision
    ?author ?language ?eventContribution WHERE {
    GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(eventId)} a ?kind ; rv:ordinal ?ordinal ; rv:action ?action ; rv:receipt ?receipt .
      OPTIONAL { ${iri(eventId)} rv:operation ?eventOperation }
      OPTIONAL { ${iri(eventId)} rv:work ?eventWork }
      OPTIONAL { ${iri(eventId)} rv:contribution ?eventContribution }
    }
    GRAPH ${iri(GRAPHS.receipts)} {
      ?receipt a rv:OperationReceipt ; rv:outcome ?outcome ; rv:admissionId ?admissionId ;
        rv:requestDigest ?digest ; rv:authorityEpoch ?authorityEpoch ; rv:admittedScope ?scope ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ?receipt rv:operation ?operation }
      OPTIONAL { ?receipt rv:work ?work }
      OPTIONAL { ?receipt rv:mainVersion ?main }
      OPTIONAL { ?receipt rv:workRevision ?workRevision }
      OPTIONAL { ?receipt rv:mainRevision ?mainRevision }
      OPTIONAL { ?receipt rv:expectedHead ?expectedHead }
      OPTIONAL { ?receipt rv:reason ?reason }
      OPTIONAL { ?receipt rv:contribution ?contribution }
      OPTIONAL { ?receipt rv:draftRevision ?draftRevision }
      OPTIONAL { ?receipt rv:author ?author }
      OPTIONAL { ?receipt rv:language ?language }
    }
  }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new OutboxIncomplete('event receipt is unavailable or ambiguous');
  const value = (name: string): string | undefined => row[name]?.value;
  const kind = value('kind');
  const action = value('action');
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
  if (!kind || !receiptId || !admissionId || !requestDigest || !authorityEpoch || !scope
    || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(scope)
    || !/^[0-9a-f-]{36}$/.test(admissionId)
    || value('epoch') !== batch.dataEpoch
    || value('sequence') !== batch.sequence
    || !['work.create', 'work.edit', 'contribution.create'].includes(action ?? '')
    || ![`${RV}Succeeded`, `${RV}Cancelled`].includes(outcome ?? '')) {
    throw new OutboxIncomplete('event does not match its committed source position or receipt');
  }
  iri(receiptId);
  const work = value('work');
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
  if ((value('eventOperation') && value('eventOperation') !== operation)
    || (value('eventWork') && value('eventWork') !== work)
    || (value('eventContribution') && value('eventContribution') !== contribution)) {
    throw new OutboxIncomplete('event references differ from its receipt');
  }
  const kindToType: Record<string, MainCloudEvent['type']> = {
    [`${RV}WorkCreatedEvent`]: 'com.rezics.work.created.v1',
    [`${RV}WorkEditedEvent`]: 'com.rezics.work.edited.v1',
    [`${RV}WorkEditRejectedEvent`]: 'com.rezics.work.edit-rejected.v1',
    [`${RV}AdmissionCancelledEvent`]: 'com.rezics.work.admission-cancelled.v1',
    [`${RV}ContributionDraftCreatedEvent`]: 'com.rezics.contribution.draft-created.v1',
    [`${RV}ContributionAdmissionCancelledEvent`]: 'com.rezics.contribution.admission-cancelled.v1',
  };
  const type = kindToType[kind];
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
    || (type === 'com.rezics.contribution.admission-cancelled.v1'
      && (action !== 'contribution.create' || outcome !== `${RV}Cancelled`
        || operation || work || contribution || draftRevision || author || language
        || main || workRevision || mainRevision || expectedHead || reason))) {
    throw new OutboxIncomplete('event type differs from terminal receipt');
  }
  const receipt: MainCloudEvent['data']['receipt'] = {
    id: receiptId, action: action as 'work.create' | 'work.edit' | 'contribution.create',
    outcome: outcome === `${RV}Succeeded` ? 'succeeded' : 'cancelled',
    admissionId, requestDigest, authorityEpoch, scope,
    ...(operation ? { operation } : {}), ...(work ? { work } : {}),
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
    ...(author ? { author } : {}), ...(language ? { language } : {}),
  };
  return { specversion: '1.0', id: eventId, source: SOURCE, type,
    datacontenttype: 'application/json',
    data: { batchId: batch.batchId, sourcePosition: { datasetId: 'product',
      dataEpoch: batch.dataEpoch, sequence: batch.sequence },
      routingEpoch: batch.routingEpoch, ordinal, receipt } };
}

/** Durable, idempotent first handoff. Consumers attach downstream effects later. */
async function deliver(pool: Pool, event: MainCloudEvent): Promise<void> {
  const sourcePosition = event.data.sourcePosition;
  const body = JSON.stringify(event);
  const inserted = await pool.query(
    `INSERT INTO relay.delivered_event (source, event_id, data_epoch, sequence, envelope)
     VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING`,
    [event.source, event.id, sourcePosition.dataEpoch, sourcePosition.sequence, body]);
  if (inserted.rowCount === 0) {
    const existing = await pool.query<{ same: boolean }>(
      `SELECT envelope = $3::jsonb AND data_epoch = $4 AND sequence = $5 AS same
       FROM relay.delivered_event WHERE source = $1 AND event_id = $2`,
      [event.source, event.id, body, sourcePosition.dataEpoch, sourcePosition.sequence]);
    if (existing.rows[0]?.same !== true) throw new OutboxIncomplete('event identity has a different durable envelope');
  }
}

async function retainBatch(pool: Pool, batch: MainOutboxBatch): Promise<void> {
  const inserted = await pool.query(
    `INSERT INTO relay.delivered_batch
       (data_epoch, sequence, batch_id, routing_epoch, event_count)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventIds.length]);
  if (inserted.rowCount === 0) {
    const existing = await pool.query<{ same: boolean }>(
      `SELECT batch_id = $3 AND routing_epoch = $4 AND event_count = $5 AS same
       FROM relay.delivered_batch WHERE data_epoch = $1 AND sequence = $2`,
      [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventIds.length]);
    if (existing.rows[0]?.same !== true) {
      throw new OutboxIncomplete('batch position has a different durable header');
    }
  }
}

export async function initializeRelayCheckpoint(pool: Pool, consumer: string, dataEpoch: string): Promise<void> {
  if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(consumer) || !dataEpoch) throw new RelayCheckpointConflict('invalid relay identity');
  await pool.query(`INSERT INTO relay.checkpoint (consumer, data_epoch, sequence)
    VALUES ($1, $2, 0) ON CONFLICT DO NOTHING`, [consumer, dataEpoch]);
}

/** At least once handoff: a crash after delivery repeats the batch safely. */
export async function relayMainOutboxOnce(
  fuseki: FusekiClient, pool: Pool, consumer: string,
  hooks?: { afterDelivery?: (batch: MainOutboxBatch) => Promise<void> },
): Promise<MainOutboxBatch | null> {
  const checkpoint = await pool.query<{ data_epoch: string; sequence: string }>(
    'SELECT data_epoch, sequence FROM relay.checkpoint WHERE consumer = $1', [consumer]);
  const cursor = checkpoint.rows[0];
  if (!cursor) throw new RelayCheckpointConflict('relay checkpoint is uninitialized');
  const batch = await readNextMainOutboxBatch(fuseki, cursor.data_epoch, cursor.sequence);
  if (!batch) return null;
  const events = await Promise.all(batch.eventIds.map(eventId => envelope(fuseki, batch, eventId)));
  events.sort((a, b) => a.data.ordinal - b.data.ordinal);
  if (events.some((event, index) => event.data.ordinal !== index)) {
    throw new OutboxIncomplete('outbox event ordinals are not complete');
  }
  await retainBatch(pool, batch);
  for (const event of events) await deliver(pool, event);
  await hooks?.afterDelivery?.(batch);
  const advanced = await pool.query(
    `UPDATE relay.checkpoint SET sequence = $3, updated_at = clock_timestamp()
     WHERE consumer = $1 AND data_epoch = $2 AND sequence = $4`,
    [consumer, batch.dataEpoch, batch.sequence, cursor.sequence]);
  if (advanced.rowCount !== 1) throw new RelayCheckpointConflict('relay checkpoint changed during delivery');
  return batch;
}
