import type { Pool, PoolClient } from 'pg';
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

interface CoverageScan {
  coverage: RelayCoverage;
  batch?: { batchId: string; routingEpoch: string; eventCount: number };
  events: { eventId: string; body: string }[];
}

async function scanRelayCoverage(client: PoolClient, consumer: string,
  targetSequence?: string): Promise<CoverageScan> {
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
  let selectedBatch: CoverageScan['batch'];
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
      `SELECT source, event_id, sequence::text, envelope::text AS body
       FROM relay.delivered_event WHERE data_epoch = $1 AND sequence <= $2
         AND (sequence, event_id) > ($3::numeric, $4)
       ORDER BY sequence, event_id LIMIT 1000`,
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
  return { coverage: { consumer, dataEpoch: row.data_epoch, sequence: row.sequence,
    batchCount: batchCount.toString(), batchDigest: batchDigest.digest('hex'),
    eventCount: count.toString(), eventDigest: digest.digest('hex') },
    batch: selectedBatch, events: selectedEvents };
}

/** Offline coverage of the durable handoff through one acknowledged checkpoint. */
export async function relayCoverage(pool: Pool, consumer: string): Promise<RelayCoverage> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { coverage } = await scanRelayCoverage(client, consumer);
    await client.query('COMMIT');
    return coverage;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* retain original error */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Verify the full captured handoff and take one event/header from those same rows. */
export async function relayRetainedEventAt(pool: Pool, expected: RelayCoverage,
  sequence: string): Promise<{ eventId: string; envelope: MainCloudEvent;
    batch: { batchId: string; routingEpoch: string; eventCount: number } }> {
  if (!/^[1-9][0-9]*$/.test(sequence) || !/^[0-9]+$/.test(expected.sequence)
    || BigInt(sequence) > BigInt(expected.sequence)) {
    throw new RelayCheckpointConflict('invalid retained event position');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { coverage, batch, events } = await scanRelayCoverage(client, expected.consumer, sequence);
    if (coverage.consumer !== expected.consumer || coverage.dataEpoch !== expected.dataEpoch
      || coverage.sequence !== expected.sequence || coverage.batchCount !== expected.batchCount
      || coverage.batchDigest !== expected.batchDigest || coverage.eventCount !== expected.eventCount
      || coverage.eventDigest !== expected.eventDigest || !batch || events.length !== 1
      || batch.eventCount !== 1) {
      throw new RelayCheckpointConflict('retained event coverage or batch differs');
    }
    const event = events[0]!;
    const envelope = JSON.parse(event.body) as MainCloudEvent;
    await client.query('COMMIT');
    return { eventId: event.eventId, envelope, batch };
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
    | 'com.rezics.rating.observation-changed.v1'
    | 'com.rezics.rating.observation-stale.v1'
    | 'com.rezics.rating.observation-cancelled.v1'
    | 'com.rezics.translation.linked.v1'
    | 'com.rezics.work.derived.v1';
  datacontenttype: 'application/json';
  data: { batchId: string; sourcePosition: { datasetId: 'product'; dataEpoch: string;
    sequence: string }; routingEpoch: string; ordinal: number; receipt: {
      id: string; action: 'work.create' | 'work.edit' | 'work.derive' | 'contribution.create' | 'contribution.edit' | 'contribution.publish' | 'publication.select' | 'space.create' | 'publication.adopt' | 'publication.reject' | 'classification.context.configure' | 'classification.proposition.define' | 'classification.decision.set' | 'rating.context.create' | 'rating.observation.set' | 'translation.link' | 'translation.authorize';
      outcome: 'succeeded' | 'cancelled';
      admissionId: string; requestDigest: string; authorityEpoch: string; scope: string;
      operation?: string; work?: string; mainVersion?: string; workRevision?: string;
      mainRevision?: string; expectedHead?: string; reason?: 'stale-head';
      workManifest?: string; mainManifest?: string;
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
      ratingSlot?: string; ratingObservation?: string; observationRevision?: string;
      observationManifest?: string; ratingAvailability?: 'available' | 'withdrawn';
      ratingValue?: number;
      translationLink?: string; targetWork?: string; targetMainVersion?: string;
      targetMainRevision?: string; sourceWork?: string; sourceMainVersion?: string;
      sourceMainRevision?: string | null; sourceVersionStatus?: 'exact' | 'unresolved';
      translationStatus?: 'official' | 'third-party'; contentLanguage?: string;
      translator?: string; publisher?: string; evidence?: string; linkedBy?: string;
      authorizingParty?: string | null; authorizationScope?: string | null;
      authorizationEpoch?: string | null;
      workDerivation?: string; derivationKind?: 'adaptation' | 'new-recording' | 'software-fork';
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

type DeliveredMainEvent = MainCloudEvent | ContentBoundaryCloudEvent;

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
      || value('scope') !== `${action === 'content.publish' ? 'content:publish:' : 'content:search-eligibility:'}${variant}`))
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
          || value('rightsBasis') !== `${RV}OriginalContribution`
          || value('disclosure') !== `${RV}Public` || reason
          || value('eventVariant') !== variant
          || value('eventPublicationDecision') !== publicationDecision
        : type === 'com.rezics.content.search-eligibility-rejected.v1'
          ? action !== 'content.search-eligibility' || outcome !== `${RV}Cancelled`
            || reason !== `${RV}StaleHead` || !publicationDecision || eligibilityDecision
            || !value('actingSubject')
            || value('rightsBasis') !== `${RV}OriginalContribution`
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
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?targetWork ?targetMain ?targetRevision ?sourceWork ?sourceMain ?sourceRevision
    ?kind ?evidence ?linkedBy ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(derivation)} a rv:WorkDerivation ; rv:targetWork ?targetWork ;
        rv:targetMainVersion ?targetMain ; rv:targetMainRevision ?targetRevision ;
        rv:sourceWork ?sourceWork ; rv:sourceMainVersion ?sourceMain ;
        rv:sourceMainRevision ?sourceRevision ; rv:derivationKind ?kind ;
        rv:evidence ?evidence ; rv:linkedBy ?linkedBy ;
        rv:modelRevision <https://rezics.com/definition/work-derivation-v1> ;
        rv:shapeRevision <https://rezics.com/definition/work-derivation-v1> ;
        rv:dataEpoch ?epoch ; rv:sequence ?sequence .
    }
  }`);
  const rows = result.results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row) throw new OutboxIncomplete('work derivation is unavailable or ambiguous');
  const value = (name: string) => row[name]?.value;
  const kind = value('kind') === `${RV}Adaptation` ? 'adaptation'
    : value('kind') === `${RV}NewRecording` ? 'new-recording'
    : value('kind') === `${RV}SoftwareFork` ? 'software-fork' : null;
  const targetWork = value('targetWork');
  if (!kind || !targetWork || !value('targetMain') || !value('targetRevision')
    || !value('sourceWork') || !value('sourceMain') || !value('sourceRevision')
    || !value('evidence') || !value('linkedBy')
    || scope !== `derivation:link:${targetWork}`
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
        sourceMainVersion: value('sourceMain')!, sourceMainRevision: value('sourceRevision')!,
        derivationKind: kind, evidence: value('evidence')!, linkedBy: value('linkedBy')! } } };
}

async function envelope(fuseki: FusekiClient, batch: MainOutboxBatch, eventId: string): Promise<DeliveredMainEvent> {
  const result = await fuseki.query(`PREFIX rv: <${RV}> SELECT
    ?kind ?ordinal ?action ?receipt ?eventOperation ?eventWork ?outcome ?admissionId
    ?digest ?authorityEpoch ?scope ?epoch ?sequence ?operation ?work ?main
    ?workRevision ?mainRevision ?expectedHead ?reason ?contribution ?draftRevision
    ?author ?language ?eventContribution ?publicationDecision ?selectedDraft
    ?selection ?matchUnit ?eventSpace ?eventRealm ?space ?realm ?slot ?rejection ?reasonCode
    ?spaceRevision ?realmRevision ?owner ?classificationContext ?contextRevision
    ?scheme ?concept ?path ?expression ?sense ?definitionRevision
    ?application ?decision ?decisionOutcome ?eventApplication
    ?ratingContext ?ratingContextRevision ?ratingSlot ?ratingObservation
    ?observationRevision ?ratingAvailability ?ratingValue
    ?eventRatingContext ?eventRatingObservation
    ?eventVariant ?eventContentRevision ?eventPublicationDecision
    ?resource ?variant ?contentRevision ?ownerDataEpoch ?ownerSequence
    ?eligibilityDecision ?eligibility ?projection ?actingSubject ?rightsBasis ?disclosure
    ?eventTranslationLink ?translationLink ?eventWorkDerivation ?workDerivation WHERE {
    GRAPH ${iri(GRAPHS.outbox)} {
      ${iri(eventId)} a ?kind ; rv:ordinal ?ordinal ; rv:action ?action ; rv:receipt ?receipt .
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
      OPTIONAL { ?receipt rv:mainVersion ?main }
      OPTIONAL { ?receipt rv:workRevision ?workRevision }
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
  if (contentEventTypes[kind ?? '']) {
    return mapContentOutboxEvent(batch, eventId, value, ordinal);
  }
  if (kind === `${RV}TranslationLinkedEvent`) {
    return translationLinkedEnvelope(fuseki, batch, eventId, value, ordinal);
  }
  if (kind === `${RV}WorkDerivedEvent`) {
    return workDerivedEnvelope(fuseki, batch, eventId, value, ordinal);
  }
  if (!kind || !receiptId || !admissionId || !requestDigest || !authorityEpoch || !scope
    || !/^[0-9a-f]{64}$/.test(requestDigest) || !/^[0-9]+$/.test(authorityEpoch)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(scope)
    || !/^[0-9a-f-]{36}$/.test(admissionId)
    || value('epoch') !== batch.dataEpoch
    || value('sequence') !== batch.sequence
    || !['work.create', 'work.edit', 'contribution.create', 'contribution.edit', 'contribution.publish', 'publication.select', 'space.create', 'publication.adopt', 'publication.reject', 'classification.context.configure', 'classification.proposition.define', 'classification.decision.set', 'rating.context.create', 'rating.observation.set'].includes(action ?? '')
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
    [`${RV}RatingObservationChangedEvent`]: 'com.rezics.rating.observation-changed.v1',
    [`${RV}RatingObservationStaleEvent`]: 'com.rezics.rating.observation-stale.v1',
    [`${RV}RatingObservationCancelledEvent`]: 'com.rezics.rating.observation-cancelled.v1',
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
      && (action !== 'publication.reject' || outcome !== `${RV}Succeeded`
        || !operation || !work || !main || !realm || !slot || !rejection
        || reasonCode !== `${RV}NotApproved` || reason || selection || matchUnit
        || contribution || publicationDecision || selectedDraft || language
        || value('eventOperation') !== operation || value('eventWork') !== work
        || value('eventRealm') !== realm))
    || (type === 'com.rezics.realm.suppression-rejected.v1'
      && (action !== 'publication.reject' || outcome !== `${RV}Cancelled`
        || reason !== `${RV}StaleHead` || operation || work || main || realm || slot
        || rejection || reasonCode || selection || matchUnit))
    || (type === 'com.rezics.realm.suppression-cancelled.v1'
      && (action !== 'publication.reject' || outcome !== `${RV}Cancelled`
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
        || scope !== `rating:context:${realm}`
        || value('eventOperation') !== operation || value('eventRealm') !== realm
        || work || main || space || contribution || classificationContext
        || contextRevision || sense || application || decision || reason))
    || (type === 'com.rezics.rating.context-cancelled.v1'
      && (action !== 'rating.context.create' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:context:') || operation || realm || ratingContext
        || ratingContextRevision || reason || work || main || space || contribution
        || classificationContext || contextRevision || sense || application || decision))
    || (type === 'com.rezics.rating.observation-changed.v1'
      && (action !== 'rating.observation.set' || outcome !== `${RV}Succeeded`
        || !operation || !realm || !ratingContext || !contextRevision || !work || !main
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
        || observationRevision || ratingAvailability || ratingValue || work || main))
    || (type === 'com.rezics.rating.observation-cancelled.v1'
      && (action !== 'rating.observation.set' || outcome !== `${RV}Cancelled`
        || !scope.startsWith('rating:observe:') || reason
        || operation || realm || ratingContext || ratingSlot || ratingObservation
        || observationRevision || ratingAvailability || ratingValue || work || main))) {
    throw new OutboxIncomplete('event type differs from terminal receipt');
  }
  const receipt: MainCloudEvent['data']['receipt'] = {
    id: receiptId, action: action as MainCloudEvent['data']['receipt']['action'],
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
