import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../work/activate.ts';
import { resolveStatementAcceptance } from '../statement/read.ts';
import { contentEvidenceIri, eventTimeSlotIri, verifyEventObservationManifest } from './observation.ts';
import { checkedDateRange, checkedInstantRange, eventEndpointBounds, UnsupportedEventTime,
  type EventTimePrecision } from './time.ts';

const PROFILE = 'event-interval-v1';
/** Synchronous admission and response ceilings. They do not measure Jena or SQL engine work. */
export const EVENT_QUERY_COST_CONTRACT = {
  maxEventTimeSlots: 2000,
  maxPageSize: 50,
  maxTopicStatements: 8,
  maxHistogramBuckets: 732,
  maxSourceBindings: 2001,
} as const;
const MAX_SOURCE_ROWS = EVENT_QUERY_COST_CONTRACT.maxEventTimeSlots;
const MAX_TOPICS = EVENT_QUERY_COST_CONTRACT.maxTopicStatements;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class EventQueryUnavailable extends Error {}
export class EventQueryRestart extends Error {}
export class EventQueryDenied extends Error {}
export class EventQueryTooLarge extends Error {}

export interface EventQueryInput {
  interpretation: 'civil-date' | 'instant';
  match: 'possible' | 'definite';
  timeStatus?: 'actual' | 'planned';
  grain: 'year' | 'month' | 'day';
  start: string;
  end: string;
  pageSize: number;
  topics?: string[];
  acceptance?: { kind: 'global' } | { kind: 'realm'; realm: string };
  continuation?: string;
}

interface GraphRow {
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
interface StoredInterval {
  event: string; timeRevision: string; timeStatus: 'actual' | 'planned'; temporalKind: 'instant' | 'interval';
  startState: 'known' | 'unknown' | 'open'; startPrecision: EventTimePrecision | null;
  endState: 'known' | 'unknown' | 'open'; endPrecision: EventTimePrecision | null;
  civilStartMin: string | null; civilStartMax: string | null; civilEndMin: string | null; civilEndMax: string | null;
  instantStartMin: string | null; instantStartMax: string | null; instantEndMin: string | null; instantEndMax: string | null;
}

interface Cursor {
  v: 1; digest: string; generation: string; last: { event: string; status: 'actual' | 'planned'; revision: string };
  expiresAt: number;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unitPrecision: Record<string, EventTimePrecision> = {
  'http://www.w3.org/2006/time#unitYear': 'year', 'http://www.w3.org/2006/time#unitMonth': 'month',
  'http://www.w3.org/2006/time#unitDay': 'day', 'http://www.w3.org/2006/time#unitMinute': 'minute',
  'http://www.w3.org/2006/time#unitSecond': 'second',
};
const statusValue = (value: string): 'actual' | 'planned' => value === `${RV}ActualTime` ? 'actual'
  : value === `${RV}PlannedTime` ? 'planned' : fail('event time status is invalid');
const pointState = (value: string): 'known' | 'unknown' | 'open' => value === `${RV}KnownPoint` ? 'known'
  : value === `${RV}UnknownPoint` ? 'unknown' : value === `${RV}OpenPoint` ? 'open' : fail('event point state is invalid');
function fail(message: string): never { throw new EventQueryUnavailable(message); }

function sameInstant(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b))
    && Date.parse(a) === Date.parse(b));
}

function cursorToken(value: Cursor, key: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url');
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readCursor(token: string, key: Uint8Array, requestDigest: string): Cursor {
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) throw new EventQueryRestart('cursor is invalid');
  const expected = createHmac('sha256', key).update(body).digest();
  let actual: Buffer;
  try { actual = Buffer.from(signature, 'base64url'); }
  catch { throw new EventQueryRestart('cursor is invalid'); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new EventQueryRestart('cursor is invalid');
  let value: Cursor;
  try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Cursor; }
  catch { throw new EventQueryRestart('cursor is invalid'); }
  if (value.v !== 1 || value.digest !== requestDigest || !/^[0-9a-f-]{36}$/.test(value.generation)
    || value.expiresAt <= Date.now() || !value.last || !nativeId.test(value.last.event)
    || !['actual', 'planned'].includes(value.last.status) || !nativeId.test(value.last.revision)) {
    throw new EventQueryRestart('cursor expired or belongs to another query');
  }
  return value;
}

function normalizedQuery(input: EventQueryInput) {
  if (input.interpretation !== 'civil-date' && input.interpretation !== 'instant') throw new EventQueryDenied('unsupported interpretation');
  if (input.match !== 'possible' && input.match !== 'definite') throw new EventQueryDenied('unsupported match mode');
  if (!['year', 'month', 'day'].includes(input.grain) || !Number.isInteger(input.pageSize)
    || input.pageSize < 1 || input.pageSize > EVENT_QUERY_COST_CONTRACT.maxPageSize
    || (input.timeStatus && !['actual', 'planned'].includes(input.timeStatus))) throw new EventQueryDenied('query bounds are invalid');
  if (input.topics && (input.topics.length > MAX_TOPICS || input.topics.some(topic => !nativeId.test(topic))
    || new Set(input.topics).size !== input.topics.length || !input.acceptance
    || (input.acceptance.kind === 'realm' && !nativeId.test(input.acceptance.realm)))) {
    throw new EventQueryDenied('topic selection is invalid');
  }
  const queryRange = input.interpretation === 'civil-date'
    ? checkedDateRange(input.start, input.end, input.grain)
    : checkedInstantRange(input.start, input.end);
  const grainInput = (date: string) => input.grain === 'year' ? date.slice(0, 4)
    : input.grain === 'month' ? date.slice(0, 7) : date.slice(0, 10);
  let bucketRange: { start: string; end: string; buckets: number };
  if (input.interpretation === 'civil-date') {
    bucketRange = checkedDateRange(input.start, input.end, input.grain);
  } else {
    const bucketStart = new Date(Date.parse(queryRange.start)).toISOString().slice(0, 10);
    const bucketEnd = new Date(Date.parse(queryRange.end)).toISOString().slice(0, 10);
    bucketRange = checkedDateRange(grainInput(bucketStart), grainInput(bucketEnd), input.grain);
  }
  const query = { interpretation: input.interpretation, match: input.match, timeStatus: input.timeStatus ?? null,
    grain: input.grain, start: queryRange.start, end: queryRange.end, pageSize: input.pageSize,
    topics: input.topics ?? [], acceptance: input.topics ? input.acceptance : null };
  const bucketStart = bucketRange.start;
  const bucketEnd = input.grain === 'day' ? bucketRange.end
    : input.grain === 'month' ? `${bucketRange.end.slice(0, 7)}-01` : `${bucketRange.end.slice(0, 4)}-01-01`;
  return { query, queryRange, bucketStart, bucketEnd, bucketCount: bucketRange.buckets, requestDigest: digest(query),
    scopeKey: digest({ family: PROFILE, interpretation: query.interpretation, grain: query.grain,
      bucketStart, bucketEnd }) };
}

function sourceQuery(env: WorkActivationEnvironment) {
  return env.fuseki.query(`PREFIX rv: <${RV}> PREFIX time: <http://www.w3.org/2006/time#>
    SELECT ?epoch ?sequence ?event ?eventTime ?status ?head ?manifest ?evidence ?recordedAt ?kind
      ?start ?startState ?startValue ?startLexical ?startUnit ?startOffset ?startZone ?startUnknown
      ?end ?endState ?endValue ?endLexical ?endUnit ?endOffset ?endZone ?endUnknown WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
      FILTER(?epoch = ${lit(env.lineage.dataEpoch)})
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ?event a rv:Event .
        ?eventTime a rv:EventTime ; rv:event ?event ; rv:timeStatus ?status ; rv:eventTimeHead ?head .
      }
      GRAPH ${iri(GRAPHS.revisions)} {
        ?head a rv:EventTimeRevision ; rv:eventTime ?eventTime ; rv:timeAvailability rv:Available ;
          rv:temporalKind ?kind ; rv:manifest ?manifest ; rv:recordedAt ?recordedAt ; rv:eventStart ?start .
        OPTIONAL { ?head rv:timeEvidence ?evidence }
        ?start rv:pointState ?startState .
        OPTIONAL { ?start rv:temporalValue ?startValue . ?startValue rv:lexicalForm ?startLexical ;
          time:unitType ?startUnit . OPTIONAL { ?startValue rv:utcOffset ?startOffset }
          OPTIONAL { ?startValue rv:timeZoneName ?startZone } }
        OPTIONAL { ?start rv:unknownLexical ?startUnknown }
        OPTIONAL { ?head rv:eventEnd ?end . ?end rv:pointState ?endState .
          OPTIONAL { ?end rv:temporalValue ?endValue . ?endValue rv:lexicalForm ?endLexical ;
            time:unitType ?endUnit . OPTIONAL { ?endValue rv:utcOffset ?endOffset }
            OPTIONAL { ?endValue rv:timeZoneName ?endZone } }
          OPTIONAL { ?end rv:unknownLexical ?endUnknown } }
      } }
    } ORDER BY ?event ?status LIMIT ${MAX_SOURCE_ROWS + 1}`);
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

async function readSource(env: WorkActivationEnvironment): Promise<{ position: SourcePosition; rows: StoredInterval[]; states: Map<string, Record<string, unknown>> }> {
  const result = await sourceQuery(env);
  const source = (result.results?.bindings ?? []) as unknown as GraphRow[];
  if (!source.length || source.length > EVENT_QUERY_COST_CONTRACT.maxSourceBindings) {
    if (source.length > MAX_SOURCE_ROWS) throw new EventQueryTooLarge('event index source exceeds the 2,000-slot synchronous bound');
    throw new EventQueryUnavailable('event source position is unavailable');
  }
  const position = { dataEpoch: source[0]!.epoch.value, sequence: source[0]!.sequence.value };
  if (position.dataEpoch !== env.lineage.dataEpoch || !/^(0|[1-9][0-9]*)$/.test(position.sequence)) {
    throw new EventQueryUnavailable('event source lineage is unavailable');
  }
  const rows: StoredInterval[] = [];
  const states = new Map<string, Record<string, unknown>>();
  for (const row of source) {
    if (row.epoch.value !== position.dataEpoch || row.sequence.value !== position.sequence) {
      throw new EventQueryUnavailable('event source position changed during snapshot read');
    }
    if (!row.event) continue;
    if (!row.eventTime || !row.status || !row.head || !row.manifest || !row.recordedAt || !row.kind || !row.start) {
      throw new EventQueryUnavailable('event time source is incomplete');
    }
    const state = await verifyEventObservationManifest(env, row.head.value, row.manifest.value, row.eventTime.value);
    if (state.event !== row.event.value || state.timeStatus !== statusValue(row.status.value)
      || state.temporalKind !== (row.kind.value === `${RV}InstantTime` ? 'instant'
        : row.kind.value === `${RV}IntervalTime` ? 'interval' : null)
      || state.startPoint !== row.start.value || !sameInstant(state.recordedAt as string, row.recordedAt.value)) {
      throw new EventQueryUnavailable('event time graph differs from its immutable source');
    }
    const expectedEvidence = state.timeEvidence ? contentEvidenceIri(state.timeEvidence as string) : undefined;
    if ((row.evidence?.value ?? undefined) !== expectedEvidence) {
      throw new EventQueryUnavailable('Content evidence reference differs from its immutable source');
    }
    const stateStart = state.start as any;
    verifyGraphPoint(row, 'start', stateStart, state.startPoint as string, state.startValue as string | undefined);
    if (state.end) {
      if (!row.end || state.endPoint !== row.end.value) throw new EventQueryUnavailable('event end point differs from source manifest');
      verifyGraphPoint(row, 'end', state.end, state.endPoint as string, state.endValue as string | undefined);
    } else if (row.end) throw new EventQueryUnavailable('event graph has an unrecorded end point');
    const start = eventEndpointBounds(stateStart, 'civil-date');
    const end = state.end ? eventEndpointBounds(state.end as any, 'civil-date')
      : state.temporalKind === 'instant' ? start : undefined;
    if (!end) throw new EventQueryUnavailable('event interval is incomplete');
    if (start.civilMin && end.civilMax && start.civilMin > end.civilMax) {
      throw new EventQueryUnavailable('event interval endpoints are reversed');
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
      && instantStart.instantMin > instantEnd.instantMax) throw new EventQueryUnavailable('event instant interval endpoints are reversed');
    const record = { event: row.event.value, timeRevision: row.head.value,
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
  if (rows.length > MAX_SOURCE_ROWS) throw new EventQueryTooLarge('event index source exceeds the 2,000-slot synchronous bound');
  return { position, rows, states };
}

async function readGraphPosition(env: WorkActivationEnvironment): Promise<SourcePosition> {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
    FILTER(?epoch = ${lit(env.lineage.dataEpoch)}) }`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.epoch || !rows[0]?.sequence) throw new EventQueryUnavailable('event source position is unavailable');
  return { dataEpoch: rows[0].epoch.value, sequence: rows[0].sequence.value };
}

async function recoveryOpen(client: PoolClient) {
  const row = (await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (row?.open !== true) throw new EventQueryUnavailable('Access is held for recovery');
}

function histogramSql(interpretation: 'civil-date' | 'instant', grain: 'year' | 'month' | 'day') {
  if (interpretation === 'civil-date') return `INSERT INTO access.event_histogram_bucket
    (generation_id, family, time_status, grain, bucket_start, definite_count, possible_count)
    SELECT $1, 'event-interval', statuses.time_status, $4, bucket.bucket_start::date,
      count(*) FILTER (WHERE k.civil_definite && daterange(bucket.bucket_start::date,
        (bucket.bucket_start + $5::interval)::date, '[)')),
      count(*) FILTER (WHERE k.civil_possible && daterange(bucket.bucket_start::date,
        (bucket.bucket_start + $5::interval)::date, '[)'))
    FROM generate_series($2::date, $3::date, $5::interval) AS bucket(bucket_start)
    CROSS JOIN (VALUES ('actual'), ('planned')) AS statuses(time_status)
    LEFT JOIN access.event_interval_key k ON k.generation_id = $1 AND k.time_status = statuses.time_status
    GROUP BY statuses.time_status, bucket.bucket_start
    HAVING count(*) FILTER (WHERE k.civil_possible && daterange(bucket.bucket_start::date,
      (bucket.bucket_start + $5::interval)::date, '[)')) > 0`;
  return `INSERT INTO access.event_histogram_bucket
    (generation_id, family, time_status, grain, bucket_start, definite_count, possible_count)
    SELECT $1, 'event-interval', statuses.time_status, $4, bucket.bucket_start::date,
      count(*) FILTER (WHERE k.instant_definite && tstzrange(bucket.bucket_start::timestamp AT TIME ZONE 'UTC',
        (bucket.bucket_start + $5::interval)::timestamp AT TIME ZONE 'UTC', '[)')),
      count(*) FILTER (WHERE k.instant_possible && tstzrange(bucket.bucket_start::timestamp AT TIME ZONE 'UTC',
        (bucket.bucket_start + $5::interval)::timestamp AT TIME ZONE 'UTC', '[)'))
    FROM generate_series($2::date, $3::date, $5::interval) AS bucket(bucket_start)
    CROSS JOIN (VALUES ('actual'), ('planned')) AS statuses(time_status)
    LEFT JOIN access.event_interval_key k ON k.generation_id = $1 AND k.time_status = statuses.time_status
    GROUP BY statuses.time_status, bucket.bucket_start
    HAVING count(*) FILTER (WHERE k.instant_possible && tstzrange(bucket.bucket_start::timestamp AT TIME ZONE 'UTC',
      (bucket.bucket_start + $5::interval)::timestamp AT TIME ZONE 'UTC', '[)')) > 0`;
}

function intervalInsertSql(records: StoredInterval[], generation: string, interpretation: 'civil-date' | 'instant') {
  const columns = ['generation_id', 'family', 'event', 'time_revision', 'time_status', 'temporal_kind', 'interpretation',
    'conversion_profile', 'start_state', 'start_precision', 'end_state', 'end_precision',
    'civil_start_min', 'civil_start_max', 'civil_end_min', 'civil_end_max',
    'instant_start_min', 'instant_start_max', 'instant_end_min', 'instant_end_max'];
  const values: unknown[] = [];
  const tuples = records.map(record => {
    const row = [generation, 'event-interval', record.event, record.timeRevision, record.timeStatus,
      record.temporalKind, interpretation, 'https://rezics.com/definition/event-time-v1',
      record.startState, record.startPrecision, record.endState, record.endPrecision,
      interpretation === 'civil-date' ? record.civilStartMin : null,
      interpretation === 'civil-date' ? record.civilStartMax : null,
      interpretation === 'civil-date' ? record.civilEndMin : null,
      interpretation === 'civil-date' ? record.civilEndMax : null,
      interpretation === 'instant' ? record.instantStartMin : null,
      interpretation === 'instant' ? record.instantStartMax : null,
      interpretation === 'instant' ? record.instantEndMin : null,
      interpretation === 'instant' ? record.instantEndMax : null];
    const index = values.length;
    values.push(...row);
    return `(${row.map((_, offset) => `$${index + offset + 1}`).join(',')})`;
  });
  return { text: `INSERT INTO access.event_interval_key (${columns.join(',')}) VALUES ${tuples.join(',')}`, values };
}

async function activeGeneration(db: Pool | PoolClient, scopeKey: string) {
  const result = await db.query<{ generation: string; revision: string; state: string; sequence: string; data_epoch: string }>(
    `SELECT h.active_generation::text AS generation, h.revision::text,
      g.state, i.pinned_sequence::text AS sequence, i.data_epoch
     FROM access.derived_generation_head h JOIN access.derived_generation g ON g.id = h.active_generation
     JOIN access.derived_generation_input i ON i.generation_id = g.id AND i.source = 'main-graph'
     WHERE h.family = 'event-interval' AND h.scope_key = $1`, [scopeKey]);
  return result.rows[0];
}

async function buildGeneration(pool: Pool, env: WorkActivationEnvironment, scopeKey: string,
  snapshot: Awaited<ReturnType<typeof readSource>>, input: ReturnType<typeof normalizedQuery>) {
  if (input.query.interpretation === 'instant' && snapshot.rows.some(row =>
    (row.startState === 'known' && !row.instantStartMin)
    || (row.endState === 'known' && !row.instantEndMin))) {
    throw new UnsupportedEventTime('one or more known event points have no exact indexed instant');
  }
  const client = await pool.connect();
  const generation = randomUUID();
  const manifest = { profile: PROFILE, source: 'main-graph', position: snapshot.position,
    interpretation: input.query.interpretation, grain: input.query.grain,
    bucketStart: input.bucketStart, bucketEnd: input.bucketEnd, rowCount: snapshot.rows.length };
  const inputDigest = digest(manifest);
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '8s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [scopeKey]);
    await recoveryOpen(client);
    const current = await activeGeneration(client, scopeKey);
    if (current?.state === 'ready' && current.data_epoch === snapshot.position.dataEpoch
      && current.sequence === snapshot.position.sequence) {
      await client.query('COMMIT');
      return { generation: current.generation, revision: current.revision };
    }
    await client.query(`INSERT INTO access.derived_generation
      (id, family, scope_key, input_digest, input_manifest, lease_expires_at)
      VALUES ($1, 'event-interval', $2, $3, $4::jsonb, clock_timestamp() + interval '30 seconds')`,
    [generation, scopeKey, inputDigest, manifest]);
    await client.query(`INSERT INTO access.derived_generation_input
      (generation_id, source, data_epoch, pinned_sequence, checkpoint_sequence, snapshot_complete)
      VALUES ($1, 'main-graph', $2, $3::numeric, $3::numeric, false)`,
    [generation, snapshot.position.dataEpoch, snapshot.position.sequence]);
    const insert = intervalInsertSql(snapshot.rows, generation, input.query.interpretation);
    if (snapshot.rows.length) await client.query(insert.text, insert.values);
    const step = input.query.grain === 'day' ? '1 day' : input.query.grain === 'month' ? '1 month' : '1 year';
    await client.query(histogramSql(input.query.interpretation, input.query.grain),
      [generation, input.bucketStart, input.bucketEnd, input.query.grain, step]);
    await client.query(`UPDATE access.derived_generation_input SET snapshot_complete = true
      WHERE generation_id = $1 AND source = 'main-graph'`, [generation]);
    const live = await readGraphPosition(env);
    if (live.dataEpoch !== snapshot.position.dataEpoch || live.sequence !== snapshot.position.sequence) {
      throw new EventQueryRestart('event source changed during histogram rebuild');
    }
    const validationDigest = digest({ generation, inputDigest, keyRows: snapshot.rows.length,
      histogramRows: (await client.query<{ count: string }>(`SELECT count(*)::text AS count
        FROM access.event_histogram_bucket WHERE generation_id = $1`, [generation])).rows[0]!.count });
    await client.query(`UPDATE access.derived_generation SET state = 'ready', lease_expires_at = NULL,
      validation_digest = $2, ready_at = clock_timestamp() WHERE id = $1 AND state = 'building'`,
    [generation, validationDigest]);
    const head = await client.query<{ active_generation: string; revision: string }>(`SELECT active_generation::text,
      revision::text FROM access.derived_generation_head WHERE family = 'event-interval' AND scope_key = $1 FOR UPDATE`, [scopeKey]);
    const predecessor = head.rows[0]?.active_generation ?? null;
    const revision = head.rows[0] ? (BigInt(head.rows[0].revision) + 1n).toString() : '1';
    if (head.rows[0]) {
      await client.query(`UPDATE access.derived_generation_head SET active_generation = $3,
        revision = $4, activated_at = clock_timestamp() WHERE family = 'event-interval' AND scope_key = $1
          AND revision = $2::numeric`, [scopeKey, head.rows[0].revision, generation, revision]);
    } else {
      await client.query(`INSERT INTO access.derived_generation_head (family, scope_key, active_generation, revision)
        VALUES ('event-interval', $1, $2, 1)`, [scopeKey, generation]);
    }
    await client.query(`INSERT INTO access.derived_generation_activation
      (family, scope_key, revision, generation_id, predecessor, lease_epoch, input_positions)
      VALUES ('event-interval', $1, $2::numeric, $3, $4, 1, $5::jsonb)`,
    [scopeKey, revision, generation, predecessor,
      JSON.stringify([{ source: 'main-graph', dataEpoch: snapshot.position.dataEpoch,
        sequence: snapshot.position.sequence }])]);
    if (predecessor) await client.query(`UPDATE access.derived_generation
      SET state = 'superseded', finished_at = clock_timestamp()
      WHERE id = $1 AND state = 'ready'`, [predecessor]);
    const after = await readGraphPosition(env);
    if (after.dataEpoch !== snapshot.position.dataEpoch || after.sequence !== snapshot.position.sequence) {
      throw new EventQueryRestart('event source changed during histogram activation');
    }
    await recoveryOpen(client);
    await client.query('COMMIT');
    return { generation, revision };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve source failure */ }
    if (error instanceof EventQueryRestart || error instanceof EventQueryUnavailable) throw error;
    throw new EventQueryUnavailable('event interval generation could not be activated');
  } finally { client.release(); }
}

async function acceptedTopics(env: WorkActivationEnvironment, input: EventQueryInput) {
  const byEvent = new Map<string, string[]>();
  if (!input.topics?.length) return byEvent;
  for (const statement of input.topics) {
    const rows = (await env.fuseki.query(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX rv: <${RV}>
      SELECT ?topic ?event WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(statement)} a rdf:Statement ; rv:statementState rv:Active ; rv:head ?head ;
          rdf:subject ?topic ; rdf:predicate rv:denotesEvent ; rdf:object ?event . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ${iri(statement)} . }
      } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length > 1) throw new EventQueryUnavailable('topic Statement is ambiguous');
    if (!rows.length || !rows[0]?.event) continue;
    const decision = await resolveStatementAcceptance(env, { kind: 'statement', statement },
      input.acceptance ?? { kind: 'global' });
    if (decision.result.state === 'unavailable') throw new EventQueryUnavailable('topic acceptance is unavailable');
    if (decision.result.state !== 'accepted') continue;
    const event = rows[0].event.value;
    const current = byEvent.get(event) ?? [];
    current.push(statement);
    byEvent.set(event, current);
  }
  return byEvent;
}

export class EventTemporalQueries {
  constructor(private readonly access: Pool, private readonly env: WorkActivationEnvironment,
    private readonly cursorKey: Uint8Array) {
    if (cursorKey.length < 32) throw new Error('event query cursor key must be at least 32 bytes');
  }

  async query(input: EventQueryInput) {
    let normalized: ReturnType<typeof normalizedQuery>;
    try { normalized = normalizedQuery(input); }
    catch (error) {
      if (error instanceof UnsupportedEventTime) throw error;
      if (error instanceof EventQueryDenied) throw error;
      throw new EventQueryDenied('event query is invalid');
    }
    const topics = await acceptedTopics(this.env, input);
    const cursor = input.continuation ? readCursor(input.continuation, this.cursorKey, normalized.requestDigest) : undefined;
    let selectedGeneration: { generation: string; revision: string };
    if (cursor) {
      selectedGeneration = { generation: cursor.generation, revision: '0' };
    } else {
      const source = await readSource(this.env);
      const current = await activeGeneration(this.access, normalized.scopeKey);
      if (current?.state === 'ready' && current.data_epoch === source.position.dataEpoch
        && current.sequence === source.position.sequence) {
        selectedGeneration = { generation: current.generation, revision: current.revision };
      } else selectedGeneration = await buildGeneration(this.access, this.env, normalized.scopeKey, source, normalized);
    }
    const live = await readGraphPosition(this.env);
    const client = await this.access.connect();
    let rows: any[] = [], histogram: any[] = [], generationPosition: SourcePosition;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await recoveryOpen(client);
      const generation = (await client.query<{ state: string; scope_key: string; manifest: any;
        data_epoch: string; sequence: string }>(`SELECT g.state, g.scope_key, g.input_manifest,
          i.data_epoch, i.pinned_sequence::text AS sequence FROM access.derived_generation g
        JOIN access.derived_generation_input i ON i.generation_id = g.id AND i.source = 'main-graph'
        WHERE g.id = $1`, [selectedGeneration.generation])).rows[0];
      if (!generation || !['ready', 'superseded'].includes(generation.state)
        || generation.scope_key !== normalized.scopeKey
        || generation.data_epoch !== live.dataEpoch || generation.sequence !== live.sequence) {
        throw new EventQueryRestart('event query generation or source position changed; restart without the cursor');
      }
      generationPosition = { dataEpoch: generation.data_epoch, sequence: generation.sequence };
      const dateColumn = normalized.query.interpretation === 'civil-date' ? 'civil' : 'instant';
      const rangeSql = normalized.query.interpretation === 'civil-date'
        ? `daterange($2::date, $3::date, '[]')`
        : `tstzrange($2::timestamptz, $3::timestamptz, '[]')`;
      const dateLast = normalized.query.interpretation === 'civil-date'
        ? [normalized.query.start, normalized.query.end]
        : [normalized.query.start, normalized.query.end];
      const matchRange = normalized.query.match === 'possible' ? `${dateColumn}_possible` : `${dateColumn}_definite`;
      const params: unknown[] = [selectedGeneration.generation, ...dateLast];
      let nextParameter = 4;
      const statusFilter = normalized.query.timeStatus ? `AND time_status = $${nextParameter++}` : '';
      if (normalized.query.timeStatus) params.push(normalized.query.timeStatus);
      const topicFilter = input.topics?.length ? `AND event = ANY($${nextParameter++}::text[])` : '';
      if (input.topics?.length) {
        const allowed = [...topics.keys()];
        params.push(allowed);
      }
      const after = cursor ? `AND (event, time_status, time_revision) > ($${params.length + 1}, $${params.length + 2}, $${params.length + 3})` : '';
      if (cursor) params.push(cursor.last.event, cursor.last.status, cursor.last.revision);
      const page = await client.query(`SELECT event, time_revision AS revision, time_status, temporal_kind,
          start_state, start_precision, end_state, end_precision,
          ${dateColumn}_possible && ${rangeSql} AS possible,
          ${dateColumn}_definite && ${rangeSql} AS definite
        FROM access.event_interval_key WHERE generation_id = $1 AND ${matchRange} && ${rangeSql}
          ${statusFilter} ${topicFilter} ${after}
        ORDER BY event, time_status, time_revision LIMIT ${normalized.query.pageSize + 1}`,
      [...params]);
      rows = page.rows;
      histogram = (await client.query(`SELECT time_status, bucket_start::text AS bucket_start,
        definite_count::text, possible_count::text FROM access.event_histogram_bucket
        WHERE generation_id = $1 AND grain = $2 ORDER BY time_status, bucket_start`,
      [selectedGeneration.generation, normalized.query.grain])).rows;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* keep query outcome */ }
      if (error instanceof EventQueryRestart || error instanceof EventQueryUnavailable) throw error;
      throw new EventQueryUnavailable('event query owner is unavailable');
    } finally { client.release(); }
    if (generationPosition!.dataEpoch !== live.dataEpoch || generationPosition!.sequence !== live.sequence) {
      throw new EventQueryRestart('event source changed during query; restart without the cursor');
    }
    const more = rows.length > normalized.query.pageSize;
    rows = rows.slice(0, normalized.query.pageSize);
    const revisionIds = rows.map(row => iri(row.revision)).join(' ');
    const manifests = rows.length ? (await this.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?revision ?manifest WHERE {
      VALUES ?revision { ${revisionIds} }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision rv:manifest ?manifest }
    }`)).results?.bindings ?? [] : [];
    const manifestByRevision = new Map(manifests.map(row => [row.revision!.value, row.manifest!.value]));
    const results = [];
    for (const row of rows) {
      const eventTime = eventTimeSlotIri(row.event, row.time_status);
      const state = await verifyEventObservationManifest(this.env, row.revision,
        manifestByRevision.get(row.revision) ?? '', eventTime);
      if (state.event !== row.event || state.timeStatus !== row.time_status) {
        throw new EventQueryUnavailable('event result differs from its immutable source');
      }
      results.push({ event: row.event, eventTime,
        timeRevision: row.revision, timeStatus: row.time_status, temporalKind: row.temporal_kind,
        certainty: row.definite ? 'definite' : 'possible', start: state.start,
        ...(state.end ? { end: state.end } : {}), topicStatements: topics.get(row.event) ?? [] });
    }
    const histogramRows = new Map<string, { definite: number; possible: number }>();
    for (const row of histogram) histogramRows.set(`${row.time_status}/${row.bucket_start}`,
      { definite: Number(row.definite_count), possible: Number(row.possible_count) });
    const outputHistogram: { timeStatus: 'actual' | 'planned'; bucketStart: string; definite: number; possible: number }[] = [];
    // The generated SQL rows are sparse because empty buckets cannot be stored under migration 112.
    for (const status of input.timeStatus ? [input.timeStatus] : ['actual', 'planned'] as const) {
      for (let index = 0; index < normalized.bucketCount; index++) {
        const start = bucketAt(normalized.bucketStart, normalized.query.grain, index);
        const counts = histogramRows.get(`${status}/${start}`) ?? { definite: 0, possible: 0 };
        outputHistogram.push({ timeStatus: status, bucketStart: start, ...counts });
      }
    }
    const next = more && rows.length ? cursorToken({ v: 1, digest: normalized.requestDigest,
      generation: selectedGeneration.generation, expiresAt: Date.now() + 5 * 60_000,
      last: { event: rows.at(-1)!.event, status: rows.at(-1)!.time_status, revision: rows.at(-1)!.revision } }, this.cursorKey) : null;
    const after = await readGraphPosition(this.env);
    if (after.dataEpoch !== generationPosition!.dataEpoch || after.sequence !== generationPosition!.sequence) {
      throw new EventQueryRestart('event source changed during query; restart without the cursor');
    }
    return { profile: 'event-query-v1', interpretation: normalized.query.interpretation,
      match: normalized.query.match, timeStatus: normalized.query.timeStatus,
      sourcePosition: { datasetId: 'product', ...generationPosition! },
      generation: selectedGeneration.generation, generationRevision: selectedGeneration.revision,
      items: results, histogram: outputHistogram, continuation: next };
  }
}

function bucketAt(start: string, grain: 'year' | 'month' | 'day', index: number): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (grain === 'day') date.setUTCDate(date.getUTCDate() + index);
  else if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + index);
  else date.setUTCFullYear(date.getUTCFullYear() + index);
  return date.toISOString().slice(0, 10);
}
