import type { Pool } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { Temporal } from '@js-temporal/polyfill';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { contentEvidenceIri, eventTimeSlotIri, verifyEventObservationManifest } from './observation.ts';
import { eventEndpointBounds, UnsupportedEventTime, type EventTimePrecision } from './time.ts';

export class EventSourceUnavailable extends Error {}
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface EventSourceKey { event: string; status: 'actual' | 'planned' }

/** Fixed owner lineage; the moving Main sequence never qualifies a window. */
export async function readEventDependencies(env: WorkActivationEnvironment) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?epoch ?sequence ?relaySequence WHERE {
      GRAPH ${iri(GRAPHS.control)} {
        ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?sequence .
        OPTIONAL { ${iri(MAIN_RELAY_STREAM_SCOPE)} rv:dataEpoch ?epoch ; rv:streamSequence ?relaySequence }
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
    } LIMIT 2`)).results?.bindings ?? [];
  const row = rows[0];
  if (rows.length !== 1 || !row?.epoch || !row.sequence || !row.relaySequence
    || !/^(0|[1-9][0-9]{0,99})$/.test(row.relaySequence.value) || !/^(0|[1-9][0-9]*)$/.test(row.sequence.value)) {
    throw new EventSourceUnavailable('event owner lineage is unavailable or held');
  }
  return { dataEpoch: row.epoch.value, sequence: row.sequence.value,
    relaySequence: row.relaySequence.value };
}

/** Replay the retained owner journal, never a sorted graph inventory. Each tick
 * reads at most 32 indexed batch headers and 100 admitted members, including
 * unrelated members. Empty/non-Event batches still advance the durable seek. */
export const EVENT_SOURCE_COST = { batches: 32, members: 100 } as const;
export const EVENT_SOURCE_BATCH_SQL = `SELECT sequence::text,event_count FROM relay.delivered_batch
  WHERE stream_scope=$1 AND data_epoch=$2 AND sequence>$3::numeric
  ORDER BY relay.delivered_batch.sequence LIMIT $4`;
export const EVENT_SOURCE_MEMBERS_SQL = `SELECT sequence::text,envelope FROM relay.delivered_event
  WHERE stream_scope=$1 AND data_epoch=$2 AND sequence=ANY($3::numeric[])
  LIMIT $4`;

export async function readEventSourceKeys(relay: Pick<Pool, 'query'>,
  options: { dataEpoch: string; afterSequence: string }) {
  if (!/^(0|[1-9][0-9]{0,99})$/.test(options.afterSequence)) {
    throw new EventSourceUnavailable('event source seek is invalid');
  }
  const headers = (await relay.query<{ sequence: string; event_count: number }>(
    EVENT_SOURCE_BATCH_SQL, [MAIN_RELAY_STREAM_SCOPE, options.dataEpoch,
      options.afterSequence, EVENT_SOURCE_COST.batches])).rows;
  let sequence = BigInt(options.afterSequence), members = 0;
  const batches: typeof headers = [];
  for (const header of headers) {
    if (!/^(0|[1-9][0-9]{0,99})$/.test(header.sequence)
      || BigInt(header.sequence) !== sequence + 1n) {
      throw new EventSourceUnavailable('Event retained journal has a batch gap');
    }
    if (!Number.isInteger(header.event_count) || header.event_count < 0
      || header.event_count > EVENT_SOURCE_COST.members) {
      throw new EventSourceUnavailable('Event retained batch exceeds its admitted member bound');
    }
    if (members + header.event_count > EVENT_SOURCE_COST.members) break;
    batches.push(header); members += header.event_count; sequence++;
  }
  if (!batches.length) return null;
  const rows = (await relay.query<{ sequence: string; envelope: { type?: string;
    data?: { receipt?: { id?: string; outcome?: string; event?: string; timeStatus?: 'actual' | 'planned'; observationRevision?: string } } } }>(
    EVENT_SOURCE_MEMBERS_SQL, [MAIN_RELAY_STREAM_SCOPE, options.dataEpoch,
      batches.map(batch => batch.sequence), EVENT_SOURCE_COST.members + 1])).rows;
  const counts = new Map(batches.map(batch => [batch.sequence, 0]));
  const keys: (EventSourceKey & { revision: string; sequence: string; receipt?: string })[] = [];
  for (const row of rows) {
    if (!counts.has(row.sequence)) throw new EventSourceUnavailable('Event journal member is outside its batch');
    counts.set(row.sequence, counts.get(row.sequence)! + 1);
    if (row.envelope.type !== 'com.rezics.event.time-changed.v1') continue;
    const receipt = row.envelope.data?.receipt;
    if (receipt?.outcome !== 'succeeded' || !nativeId.test(receipt.event ?? '')
      || !['actual', 'planned'].includes(receipt.timeStatus ?? '') || !nativeId.test(receipt.observationRevision ?? '')) {
      throw new EventSourceUnavailable('Event relay proof is incomplete');
    }
    keys.push({ event: receipt.event!, status: receipt.timeStatus!, revision: receipt.observationRevision!, sequence: row.sequence, ...(receipt.id ? { receipt: receipt.id } : {}) });
  }
  if (rows.length !== members || batches.some(batch => counts.get(batch.sequence) !== batch.event_count)) {
    throw new EventSourceUnavailable('Event retained batch members are incomplete');
  }
  return { sequence: sequence.toString(), keys, members, batches: batches.length };
}
export const EVENT_COLLECTION_BATCH = 32;
/** A status-specific index walks only admitted Event effects within one
 * acknowledged immutable prefix. A partial batch retains its exact event key. */
export async function readEventCollectionKeys(relay: Pick<Pool, 'query'>,
  options: { dataEpoch: string; status: 'actual' | 'planned'; sequence: string; eventId: string | null }) {
  if (!['actual', 'planned'].includes(options.status) || !/^(0|[1-9][0-9]{0,99})$/.test(options.sequence)) {
    throw new EventSourceUnavailable('Event collection seek is invalid');
  }
  const result = (await relay.query<{ cut: string; sequence: string | null; event_id: string | null;
    envelope: { data?: { receipt?: { id?: string; event?: string; timeStatus?: string; observationRevision?: string; outcome?: string } } } | null }>(`
    WITH cut AS MATERIALIZED (
      SELECT sequence FROM relay.checkpoint WHERE stream_scope=$1 AND data_epoch=$2
      ORDER BY sequence DESC LIMIT 1
    ), page AS MATERIALIZED (
      SELECT sequence,event_id,envelope FROM relay.delivered_event
      WHERE ($4::text IS NULL OR $4::text IS NOT NULL) AND stream_scope=$1 AND data_epoch=$2 AND sequence<=(SELECT sequence FROM cut)
        AND ${options.eventId === null ? 'sequence>$3::numeric' : '(sequence,event_id)>($3::numeric,$4::text)'}
        AND envelope->>'type'='com.rezics.event.time-changed.v1'
        AND envelope#>>'{data,receipt,timeStatus}'='${options.status}'
      ORDER BY sequence,event_id LIMIT ${EVENT_COLLECTION_BATCH + 1}
    ) SELECT cut.sequence::text AS cut,page.sequence::text,page.event_id,page.envelope
      FROM cut LEFT JOIN page ON true ORDER BY page.sequence,page.event_id`,
  [MAIN_RELAY_STREAM_SCOPE, options.dataEpoch, options.sequence, options.eventId])).rows;
  const cut = result[0]?.cut;
  if (!cut || BigInt(cut) < BigInt(options.sequence)) {
    if (options.eventId !== null) throw new EventSourceUnavailable('Event acknowledged prefix regressed');
    // The primary replay already verified this whole batch prefix, including
    // a fully delivered batch whose relay ACK is delayed. Do not invent more.
    return { keys: [], sequence: options.sequence, eventId: null, prefix: options.sequence };
  }
  const page = result.filter(row => row.sequence !== null);
  const keys = page.slice(0, EVENT_COLLECTION_BATCH).map(row => {
    const receipt = row.envelope?.data?.receipt;
    if (!receipt || receipt.outcome !== 'succeeded' || receipt.timeStatus !== options.status
      || !nativeId.test(receipt.event ?? '') || !nativeId.test(receipt.observationRevision ?? '')) {
      throw new EventSourceUnavailable('Event collection receipt is incomplete');
    }
    return { event: receipt.event!, status: options.status, revision: receipt.observationRevision!, sequence: row.sequence!, ...(receipt.id ? { receipt: receipt.id } : {}) };
  });
  if (page.length <= EVENT_COLLECTION_BATCH) return { keys, sequence: cut, eventId: null, prefix: cut };
  const last = page[EVENT_COLLECTION_BATCH - 1]!, next = page[EVENT_COLLECTION_BATCH]!;
  return { keys, sequence: last.sequence!, eventId: last.event_id!,
    prefix: (BigInt(next.sequence!) - 1n).toString() };
}

interface GraphRow {
  slotPresent?: { value: string };
  eventPresent?: { value: string };
  eventIsEvent?: { value: string };
  availability?: { value: string };
  revisionEventTime?: { value: string };
  event?: { value: string };
  eventTime?: { value: string };
  status?: { value: string };
  head?: { value: string };
  manifest?: { value: string };
  evidence?: { value: string };
  recordedAt?: { value: string };
  kind?: { value: string };
  start?: { value: string };
  startState?: { value: string };
  startValue?: { value: string };
  startLexical?: { value: string };
  startUnit?: { value: string };
  startOffset?: { value: string };
  startZone?: { value: string };
  startUnknown?: { value: string };
  end?: { value: string };
  endState?: { value: string };
  endValue?: { value: string };
  endLexical?: { value: string };
  endUnit?: { value: string };
  endOffset?: { value: string };
  endZone?: { value: string };
  endUnknown?: { value: string };
  epoch: { value: string };
  sequence: { value: string };
}

interface SourcePosition { dataEpoch: string; sequence: string }
export interface StoredInterval {
  event: string; timeRevision: string; manifest: string; instantSupported: boolean; timeStatus: 'actual' | 'planned'; temporalKind: 'instant' | 'interval';
  startState: 'known' | 'unknown' | 'open'; startPrecision: EventTimePrecision | null;
  endState: 'known' | 'unknown' | 'open'; endPrecision: EventTimePrecision | null;
  civilStartMin: string | null; civilStartMax: string | null; civilEndMin: string | null; civilEndMax: string | null;
  instantStartMin: string | null; instantStartMax: string | null; instantEndMin: string | null; instantEndMax: string | null;
}

const unitPrecision: Record<string, EventTimePrecision> = {
  'http://www.w3.org/2006/time#unitYear': 'year', 'http://www.w3.org/2006/time#unitMonth': 'month',
  'http://www.w3.org/2006/time#unitDay': 'day', 'http://www.w3.org/2006/time#unitMinute': 'minute',
  'http://www.w3.org/2006/time#unitSecond': 'second',
};
const statusValue = (value: string): 'actual' | 'planned' => value === `${RV}ActualTime` ? 'actual'
  : value === `${RV}PlannedTime` ? 'planned' : fail('event time status is invalid');
const pointState = (value: string): 'known' | 'unknown' | 'open' => value === `${RV}KnownPoint` ? 'known'
  : value === `${RV}UnknownPoint` ? 'unknown' : value === `${RV}OpenPoint` ? 'open' : fail('event point state is invalid');
function fail(message: string): never { throw new EventSourceUnavailable(message); }

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try { return Temporal.Instant.compare(a, b) === 0; }
  catch { return false; }
}

function sourceQuery(env: WorkActivationEnvironment, target: EventSourceKey) {
  const slot = iri(eventTimeSlotIri(target.event, target.status));
  const event = iri(target.event);
  const status = `<${RV}${target.status === 'actual' ? 'ActualTime' : 'PlannedTime'}>`;
  return env.fuseki.query(`PREFIX rv: <${RV}> PREFIX time: <http://www.w3.org/2006/time#>
    SELECT ?epoch ?sequence ?event ?eventTime ?status ?head ?manifest ?evidence ?recordedAt ?kind
      ?slotPresent ?eventPresent ?eventIsEvent
      ?availability ?revisionEventTime ?start ?startState ?startValue ?startLexical ?startUnit ?startOffset ?startZone ?startUnknown
      ?end ?endState ?endValue ?endLexical ?endUnit ?endOffset ?endZone ?endUnknown WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      VALUES (?event ?status) { (${event} ${status}) }
      BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${slot} ?slotPredicate ?slotObject
      } } AS ?slotPresent)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ${event} ?eventPredicate ?eventObject } } AS ?eventPresent)
      BIND(EXISTS { GRAPH ${iri(GRAPHS.current)} { ${event} a rv:Event } } AS ?eventIsEvent)
      OPTIONAL {
        GRAPH ${iri(GRAPHS.current)} {
          ${event} a rv:Event .
          ${slot} a rv:EventTime ; rv:event ${event} ; rv:timeStatus ${status} ; rv:eventTimeHead ?head .
        }
        BIND(${slot} AS ?eventTime)
        OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
          ?head a rv:EventTimeRevision ; rv:eventTime ?revisionEventTime ; rv:timeAvailability ?availability .
          OPTIONAL { ?head rv:manifest ?manifest }
          OPTIONAL { ?head rv:recordedAt ?recordedAt }
          OPTIONAL { ?head rv:temporalKind ?kind }
          OPTIONAL { ?head rv:timeEvidence ?evidence }
          OPTIONAL { ?head rv:eventStart ?start .
            OPTIONAL { ?start rv:pointState ?startState }
            OPTIONAL { ?start rv:temporalValue ?startValue .
              OPTIONAL { ?startValue rv:lexicalForm ?startLexical }
              OPTIONAL { ?startValue time:unitType ?startUnit }
              OPTIONAL { ?startValue rv:utcOffset ?startOffset }
              OPTIONAL { ?startValue rv:timeZoneName ?startZone } }
            OPTIONAL { ?start rv:unknownLexical ?startUnknown }
          }
          OPTIONAL { ?head rv:eventEnd ?end .
            OPTIONAL { ?end rv:pointState ?endState }
            OPTIONAL { ?end rv:temporalValue ?endValue .
              OPTIONAL { ?endValue rv:lexicalForm ?endLexical }
              OPTIONAL { ?endValue time:unitType ?endUnit }
              OPTIONAL { ?endValue rv:utcOffset ?endOffset }
              OPTIONAL { ?endValue rv:timeZoneName ?endZone } }
            OPTIONAL { ?end rv:unknownLexical ?endUnknown }
          }
        } }
      }
    } LIMIT 2`);
}

function verifyGraphPoint(row: GraphRow, prefix: 'start' | 'end', point: any,
  pointIri: string | undefined, valueIri: string | undefined) {
  const graphPoint = prefix === 'start' ? row.start?.value : row.end?.value;
  if (!pointIri || graphPoint !== pointIri) fail('event point identity is incomplete');
  const graphState = row[`${prefix}State`]?.value;
  if (point.state !== pointState(graphState ?? '')) fail('event point state differs from source manifest');
  if (point.state !== 'known') {
    if (row[`${prefix}Unknown`]?.value !== point.lexical || valueIri || row[`${prefix}Value`]) {
      fail('unknown/open event point differs from source manifest');
    }
    return;
  }
  const value = point.value as { lexical: string; precision: EventTimePrecision; timeZone?: string };
  const precision = unitPrecision[row[`${prefix}Unit`]?.value ?? ''];
  if (!valueIri || row[`${prefix}Value`]?.value !== valueIri || row[`${prefix}Lexical`]?.value !== value.lexical
    || precision !== value.precision || row[`${prefix}Zone`]?.value !== value.timeZone) {
    fail('known event point differs from source manifest');
  }
  const offset = /(?:Z|[+-]\d{2}:\d{2})$/.exec(value.lexical)?.[0];
  if ((row[`${prefix}Offset`]?.value ?? undefined) !== offset) fail('event UTC offset differs from source manifest');
}

export async function readEventSource(env: WorkActivationEnvironment, options: { target: EventSourceKey }): Promise<{ head: string | null; position: SourcePosition; rows: StoredInterval[]; states: Map<string, Record<string, unknown>> }> {
  if (!nativeId.test(options.target.event) || !['actual', 'planned'].includes(options.target.status)) {
    throw new EventSourceUnavailable('event source target is invalid');
  }
  const result = await sourceQuery(env, options.target);
  const source = (result.results?.bindings ?? []) as unknown as GraphRow[];
  if (source.length !== 1) throw new EventSourceUnavailable('event source target is ambiguous or held');
  const position = { dataEpoch: source[0]!.epoch.value, sequence: source[0]!.sequence.value };
  if (position.dataEpoch !== env.lineage.dataEpoch || !/^(0|[1-9][0-9]*)$/.test(position.sequence)) {
    throw new EventSourceUnavailable('event source lineage is unavailable');
  }
  const rows: StoredInterval[] = [];
  const states = new Map<string, Record<string, unknown>>();
  for (const row of source) {
    if (row.epoch.value !== position.dataEpoch || row.sequence.value !== position.sequence) {
      throw new EventSourceUnavailable('event source position changed during snapshot read');
    }
    // A damaged slot is not a withdrawal or an absent observation. Retain its
    // prior projection until exact source integrity can be restored.
    if (!row.head && row.slotPresent?.value === 'false') continue;
    if (row.slotPresent?.value !== 'true' || row.eventPresent?.value !== 'true'
      || row.eventIsEvent?.value !== 'true' || !row.head) {
      throw new EventSourceUnavailable('event time slot or owning Event is incomplete');
    }
    if (!row.event || !row.eventTime || !row.status || !row.manifest || !row.recordedAt
      || row.revisionEventTime?.value !== row.eventTime.value) {
      throw new EventSourceUnavailable('event time source is incomplete');
    }
    const state = await verifyEventObservationManifest(env, row.head.value, row.manifest.value, row.eventTime.value);
    if (state.event !== row.event.value || state.timeStatus !== statusValue(row.status.value)
      || !sameInstant(state.recordedAt as string, row.recordedAt.value)) {
      throw new EventSourceUnavailable('event time graph differs from its immutable source');
    }
    const expectedEvidence = state.timeEvidence ? contentEvidenceIri(state.timeEvidence as string) : undefined;
    if ((row.evidence?.value ?? undefined) !== expectedEvidence) {
      throw new EventSourceUnavailable('Content evidence reference differs from its immutable source');
    }
    if (row.eventTime.value !== eventTimeSlotIri(row.event.value, statusValue(row.status.value))) {
      throw new EventSourceUnavailable('event time slot identity differs from its source');
    }
    if (row.availability?.value === `${RV}Withdrawn`) {
      if (state.timeAvailability !== 'withdrawn' || state.temporalKind || state.start || state.end
        || row.kind || row.start || row.end) throw new EventSourceUnavailable('withdrawn event differs from its immutable source');
      continue;
    }
    if (row.availability?.value !== `${RV}Available` || (state.timeAvailability && state.timeAvailability !== 'available')
      || !row.kind || !row.start || state.temporalKind !== (row.kind.value === `${RV}InstantTime` ? 'instant'
        : row.kind.value === `${RV}IntervalTime` ? 'interval' : null) || state.startPoint !== row.start.value) {
      throw new EventSourceUnavailable('event time graph differs from its immutable source');
    }
    const stateStart = state.start as any;
    verifyGraphPoint(row, 'start', stateStart, state.startPoint as string, state.startValue as string | undefined);
    if (state.end) {
      if (!row.end || state.endPoint !== row.end.value) throw new EventSourceUnavailable('event end point differs from source manifest');
      verifyGraphPoint(row, 'end', state.end, state.endPoint as string, state.endValue as string | undefined);
    } else if (row.end) throw new EventSourceUnavailable('event graph has an unrecorded end point');
    const start = eventEndpointBounds(stateStart, 'civil-date');
    const end = state.end ? eventEndpointBounds(state.end as any, 'civil-date')
      : state.temporalKind === 'instant' ? start : undefined;
    if (!end) throw new EventSourceUnavailable('event interval is incomplete');
    if (start.civilMin && end.civilMax && start.civilMin > end.civilMax) {
      throw new EventSourceUnavailable('event interval endpoints are reversed');
    }
    let instantStart, instantEnd;
    try {
      instantStart = eventEndpointBounds(stateStart, 'instant');
      instantEnd = state.end ? eventEndpointBounds(state.end as any, 'instant')
        : state.temporalKind === 'instant' ? instantStart : undefined;
    } catch (error) {
      if (!(error instanceof UnsupportedEventTime)) throw error;
      instantStart = undefined; instantEnd = undefined;
    }
    if (instantStart && instantEnd && instantStart.instantMin && instantEnd.instantMax
      && Temporal.Instant.compare(instantStart.instantMin, instantEnd.instantMax) > 0) {
      throw new EventSourceUnavailable('event instant interval endpoints are reversed');
    }
    const record = { event: row.event.value, timeRevision: row.head.value, manifest: row.manifest.value,
      instantSupported: Boolean(instantStart && instantEnd),
      timeStatus: statusValue(row.status.value), temporalKind: state.temporalKind as 'instant' | 'interval',
      startState: start.state, startPrecision: start.precision,
      endState: end.state, endPrecision: end.precision,
      civilStartMin: start.civilMin, civilStartMax: start.civilMax,
      civilEndMin: end.civilMin, civilEndMax: end.civilMax,
      instantStartMin: instantStart?.instantMin ?? null, instantStartMax: instantStart?.instantMax ?? null,
      instantEndMin: instantEnd?.instantMin ?? null, instantEndMax: instantEnd?.instantMax ?? null };
    rows.push(record);
    states.set(row.head.value, state);
  }
  return { head: source[0]!.head?.value ?? null, position, rows, states };
}
