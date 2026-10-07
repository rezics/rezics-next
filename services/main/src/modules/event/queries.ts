import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { GRAPHS, RV, iri } from '../work/activate.ts';
import { resolveStatementAcceptance } from '../statement/read.ts';
import { eventTimeSlotIri } from './observation.ts';
import { checkedDateRange, checkedInstantRange, UnsupportedEventTime } from './time.ts';
import { readEventDependencies, readEventSource, EventSourceUnavailable } from './source.ts';
import { hasEventEffects, type EventEffectWindow } from './effects.ts';

const PROFILE = 'event-interval-v2';
/** Per-request index and response work; inventory size is not a product limit. */
export const EVENT_QUERY_COST_CONTRACT = {
  maxPageSize: 50,
  maxIndexedPageRows: 51,
  maxTopicStatements: 8,
  maxHistogramBuckets: 732,
} as const;
const MAX_TOPICS = EVENT_QUERY_COST_CONTRACT.maxTopicStatements;
const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class EventQueryUnavailable extends Error {}
export class EventQueryRestart extends Error {}
export class EventQueryDenied extends Error {}

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

interface Cursor {
  v: 2; basis: string; digest: string; generation: string; last: { event: string; status: 'actual' | 'planned'; revision: string };
  expiresAt: number;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  if (value.v !== 2 || value.digest !== requestDigest || !/^[0-9a-f-]{36}$/.test(value.generation)
    || typeof value.basis !== 'string' || !/^[0-9a-f]{64}$/.test(value.basis)
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
      bucketStart, bucketEnd, start: query.start, end: query.end }) };
}

async function recoveryOpen(client: PoolClient) {
  const row = (await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (row?.open !== true) throw new EventQueryUnavailable('Access is held for recovery');
}

async function acceptedTopics(env: WorkActivationEnvironment, input: EventQueryInput) {
  const basis: unknown[] = [];
  const byEvent = new Map<string, string[]>();
  if (!input.topics?.length) return { byEvent, basis };
  for (const statement of input.topics) {
    const rows = (await env.fuseki.query(`PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> PREFIX rv: <${RV}>
      SELECT ?topic ?event ?head WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(statement)} a rdf:Statement ; rv:statementState rv:Active ; rv:head ?head ;
          rdf:subject ?topic ; rdf:predicate rv:denotesEvent ; rdf:object ?event . }
        GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:StatementRevision ; rv:component ${iri(statement)} . }
      } LIMIT 2`)).results?.bindings ?? [];
    if (rows.length > 1) throw new EventQueryUnavailable('topic Statement is ambiguous');
    if (!rows.length || !rows[0]?.event) { basis.push({ statement, state: 'absent' }); continue; }
    const decision = await resolveStatementAcceptance(env, { kind: 'statement', statement },
      input.acceptance ?? { kind: 'global' });
    basis.push({ statement, head: rows[0].head?.value, event: rows[0].event.value,
      acceptanceContext: decision.acceptanceContext, policy: decision.policy, result: decision.result });
    if (decision.result.state === 'unavailable') throw new EventQueryUnavailable('topic acceptance is unavailable');
    if (decision.result.state !== 'accepted') continue;
    const event = rows[0].event.value;
    const current = byEvent.get(event) ?? [];
    current.push(statement);
    byEvent.set(event, current);
  }
  return { byEvent, basis };
}

interface Checkpoint {
  generation: string; data_epoch: string; relay_sequence: string; backfill_complete: boolean;
  processed: string; actual_revision: string; planned_revision: string; actual_prefix: string; planned_prefix: string;
  initial_sequence: string | null;
}
interface Window extends EventEffectWindow {
  state: string; processed: string; revision: string; created_at: string;
  actual_revision: string; planned_revision: string;
  unsupported_actual_count: string; unsupported_planned_count: string;
}

async function topicHeads(env: WorkActivationEnvironment, events: string[], status?: 'actual' | 'planned') {
  if (!events.length) return [];
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?event ?status ?head WHERE {
      VALUES ?event { ${events.map(iri).join(' ')} }
      VALUES ?status { ${status ? `<${RV}${status === 'actual' ? 'ActualTime' : 'PlannedTime'}>`
        : `<${RV}ActualTime> <${RV}PlannedTime>`} }
      OPTIONAL { GRAPH ${iri(GRAPHS.current)} {
        ?slot a rv:EventTime ; rv:event ?event ; rv:timeStatus ?status ; rv:eventTimeHead ?head . } }
    } ORDER BY ?event ?status LIMIT 17`)).results?.bindings ?? [];
  if (rows.length > 16) throw new EventQueryUnavailable('selected Event heads are ambiguous');
  return rows.map(row => ({ event: row.event!.value,
    status: row.status!.value === `${RV}ActualTime` ? 'actual' as const : 'planned' as const,
    head: row.head?.value ?? null }));
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
      if (error instanceof UnsupportedEventTime || error instanceof EventQueryDenied) throw error;
      throw new EventQueryDenied('event query is invalid');
    }
    try { return await this.read(input, normalized); }
    catch (error) {
      if (error instanceof EventSourceUnavailable) throw new EventQueryUnavailable(error.message);
      throw error;
    }
  }

  private async read(input: EventQueryInput, normalized: ReturnType<typeof normalizedQuery>) {
    const dependencies = await readEventDependencies(this.env);
    const topics = await acceptedTopics(this.env, input);
    const selectedTopics = Boolean(input.topics?.length);
    const heads = selectedTopics ? await topicHeads(this.env, [...topics.byEvent.keys()], input.timeStatus) : [];
    const basisOf = (current: typeof dependencies, topicBasis: unknown[], eventHeads: typeof heads,
      currentWindow: Window) => digest({
      epoch: current.dataEpoch, topics: topicBasis,
      events: selectedTopics ? eventHeads : {
        window: currentWindow.id,
        ...(input.timeStatus !== 'planned' ? { actual: currentWindow.actual_revision } : {}),
        ...(input.timeStatus !== 'actual' ? { planned: currentWindow.planned_revision } : {}),
      },
    });
    const cursor = input.continuation ? readCursor(input.continuation, this.cursorKey, normalized.requestDigest) : undefined;
    const client = await this.access.connect();
    let checkpoint: Checkpoint | undefined, window: Window;
    let basis: string;
    let rows: { event: string; time_status: 'actual' | 'planned'; revision: string; definite: boolean }[];
    let histogram: { time_status: 'actual' | 'planned'; bucket_start: string; definite_count: string; possible_count: string }[];
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await recoveryOpen(client);
      checkpoint = (await client.query<Checkpoint>(`SELECT generation::text,data_epoch,relay_sequence::text,
        backfill_complete,processed::text,actual_revision,planned_revision,actual_prefix::text,planned_prefix::text,initial_sequence::text
        FROM access.event_temporal_checkpoint WHERE singleton`)).rows[0];
      if (checkpoint && checkpoint.data_epoch !== dependencies.dataEpoch) {
        throw new EventQueryUnavailable('Event projection lineage requires recovery');
      }
      if (cursor && cursor.generation !== checkpoint?.generation) throw new EventQueryRestart('Event projection was replaced');
      await client.query(`INSERT INTO access.event_temporal_window
        (id,scope_key,interpretation,grain,bucket_start,bucket_end,query_start,query_end)
        VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8) ON CONFLICT (scope_key) DO NOTHING`,
      [randomUUID(), normalized.scopeKey, input.interpretation, input.grain, normalized.bucketStart,
        normalized.bucketEnd, normalized.query.start, normalized.query.end]);
      window = (await client.query<Window>(`SELECT id::text,state,processed::text,revision::text,created_at::text,
        interpretation,grain,bucket_start::text,bucket_end::text,scan_started_at::text,
        actual_revision::text,planned_revision::text,unsupported_actual_count::text,unsupported_planned_count::text
        FROM access.event_temporal_window WHERE scope_key=$1`, [normalized.scopeKey])).rows[0]!;
      basis = basisOf(dependencies, topics.basis, heads, window);
      if (cursor && cursor.basis !== basis) throw new EventQueryRestart('Event query dependencies changed');
      // Unresolved targets can move into this window, so their unknown effects
      // remain conservative. Known deltas fence only their affected windows.
      const pending = (await client.query<{ pending: boolean; failed: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM access.event_temporal_pending
          WHERE ($1::text IS NULL OR time_status=$1) AND ($2::text[] IS NULL OR event=ANY($2)) LIMIT 1) AS pending,
        EXISTS(SELECT 1 FROM access.event_temporal_pending
          WHERE state='failed' AND ($1::text IS NULL OR time_status=$1)
            AND ($2::text[] IS NULL OR event=ANY($2)) LIMIT 1) AS failed`,
      [input.timeStatus ?? null, selectedTopics ? [...topics.byEvent.keys()] : null])).rows[0]!;
      const updates = await hasEventEffects(client, window, input.timeStatus,
        selectedTopics ? [...topics.byEvent.keys()] : undefined);
      let covered = Boolean(checkpoint);
      if (selectedTopics && covered) {
        const indexed = heads.length ? (await client.query<{ event: string; time_status: string; time_revision: string | null; journal_sequence: string | null }>(
          `SELECT event,time_status,time_revision,journal_sequence::text FROM access.event_temporal_applied WHERE event=ANY($1::text[])
          AND ($2::text IS NULL OR time_status=$2)`, [[...topics.byEvent.keys()], input.timeStatus ?? null])).rows : [];
        covered = heads.every(head => head.head === null
          ? !indexed.some(row => row.event === head.event && row.time_status === head.status && row.time_revision !== null)
          : indexed.some(row => row.event === head.event && row.time_status === head.status && row.time_revision === head.head
            && row.journal_sequence !== null && BigInt(row.journal_sequence) <= BigInt(checkpoint![`${head.status}_prefix`])));
      } else if (covered) {
        covered = (input.timeStatus === 'planned' || checkpoint!.actual_revision === dependencies.actual)
          && (input.timeStatus === 'actual' || checkpoint!.planned_revision === dependencies.planned);
        // Older admitted slots predate collection heads. An absent head only
        // proves coverage after the local index closes the captured prefix.
        for (const status of input.timeStatus ? [input.timeStatus] : ['actual', 'planned'] as const) {
          if (dependencies[status] === 'none') covered &&= checkpoint!.initial_sequence !== null
            && BigInt(checkpoint![`${status}_prefix`]) >= BigInt(checkpoint!.initial_sequence!);
        }
      }
      if (!covered || pending.pending || updates || window.state !== 'ready') {
        await client.query('COMMIT');
        return { profile: 'event-query-v1' as const,
          state: checkpoint ? 'partial' as const : 'unavailable' as const,
          progress: { phase: !checkpoint || (!covered && (input.timeStatus !== 'planned' && checkpoint.actual_revision === ''
            || input.timeStatus !== 'actual' && checkpoint.planned_revision === '')) ? 'backfill' as const
            : !covered || pending.pending || updates ? 'targets' as const : 'buckets' as const,
          processed: checkpoint?.processed ?? '0', windowProcessed: window.processed, failed: pending.failed },
          items: [], histogram: [], continuation: null };
      }
      if (input.interpretation === 'instant') {
        const unsupported = selectedTopics ? (await client.query<{ unsupported: boolean }>(`SELECT EXISTS(
          SELECT 1 FROM access.event_temporal_interval WHERE event=ANY($1::text[])
          AND ($2::text IS NULL OR time_status=$2) AND NOT instant_supported
          AND civil_possible && daterange($3::date,($4::date+$5::interval)::date,'[)') LIMIT 1) AS unsupported`,
        [[...topics.byEvent.keys()], input.timeStatus ?? null, normalized.bucketStart, normalized.bucketEnd,
          input.grain === 'year' ? '1 year' : input.grain === 'month' ? '1 month' : '1 day'])).rows[0]!.unsupported
          : (input.timeStatus !== 'planned' && BigInt(window.unsupported_actual_count) > 0n)
            || (input.timeStatus !== 'actual' && BigInt(window.unsupported_planned_count) > 0n);
        if (unsupported) throw new UnsupportedEventTime('Selected Event points do not support exact instant comparison');
      }
      const params: unknown[] = [window.id];
      const status = input.timeStatus ? `AND time_status=$${params.push(input.timeStatus)}` : '';
      const topic = selectedTopics ? `AND event=ANY($${params.push([...topics.byEvent.keys()])}::text[])` : '';
      const after = cursor ? `AND (event,time_status)>($${params.length + 1},$${params.length + 2})` : '';
      if (cursor) params.push(cursor.last.event, cursor.last.status);
      rows = (await client.query<(typeof rows)[number]>(`SELECT event,time_status,time_revision AS revision,definite
        FROM access.event_temporal_member WHERE window_id=$1 ${input.match === 'definite' ? 'AND definite' : ''}
        ${status} ${topic} ${after} ORDER BY event,time_status LIMIT ${input.pageSize + 1}`, params)).rows;
      histogram = selectedTopics ? await this.topicHistogram(client, normalized, [...topics.byEvent.keys()])
        : (await client.query<(typeof histogram)[number]>(`SELECT time_status,bucket_start::text,
          definite_count::text,possible_count::text FROM access.event_temporal_bucket
          WHERE window_id=$1 AND bucket_start >= $2::date AND bucket_start <= $3::date
            AND ($4::text IS NULL OR time_status=$4) ORDER BY time_status,bucket_start`,
        [window.id, normalized.bucketStart, normalized.bucketEnd, input.timeStatus ?? null])).rows;
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the read outcome */ }
      if (error instanceof EventQueryRestart || error instanceof EventQueryUnavailable || error instanceof UnsupportedEventTime) throw error;
      throw new EventQueryUnavailable('Event temporal index is unavailable');
    } finally { client.release(); }
    const more = rows.length > input.pageSize;
    rows = rows.slice(0, input.pageSize);
    const items = [];
    // Exact graph/manifest checks touch only this page and recheck current heads.
    for (const row of rows) {
      const source = await readEventSource(this.env, { target: { event: row.event, status: row.time_status } });
      const interval = source.rows[0];
      if (!interval || interval.timeRevision !== row.revision) throw new EventQueryRestart('Event page changed during hydration');
      const state = source.states.get(row.revision)!;
      items.push({ event: row.event, eventTime: eventTimeSlotIri(row.event, row.time_status),
        timeRevision: row.revision, timeStatus: row.time_status, temporalKind: interval.temporalKind,
        certainty: row.definite ? 'definite' as const : 'possible' as const,
        start: state.start, ...(state.end ? { end: state.end } : {}),
        topicStatements: topics.byEvent.get(row.event) ?? [] });
    }
    const counts = new Map(histogram.map(row => [`${row.time_status}/${row.bucket_start}`,
      { definite: Number(row.definite_count), possible: Number(row.possible_count) }]));
    const outputHistogram = [];
    for (const status of input.timeStatus ? [input.timeStatus] : ['actual', 'planned'] as const) {
      for (let index = 0; index < normalized.bucketCount; index++) {
        const start = bucketAt(normalized.bucketStart, input.grain, index);
        outputHistogram.push({ timeStatus: status, bucketStart: start,
          ...(counts.get(`${status}/${start}`) ?? { definite: 0, possible: 0 }) });
      }
    }
    const live = await readEventDependencies(this.env);
    const liveTopics = selectedTopics ? await acceptedTopics(this.env, input) : topics;
    const liveHeads = selectedTopics ? await topicHeads(this.env, [...liveTopics.byEvent.keys()], input.timeStatus) : [];
    if (basisOf(live, liveTopics.basis, liveHeads, window) !== basis
      || !selectedTopics && ((input.timeStatus !== 'planned' && live.actual !== dependencies.actual)
        || (input.timeStatus !== 'actual' && live.planned !== dependencies.planned))) {
      throw new EventQueryRestart('Event dependencies changed during query');
    }
    const last = rows.at(-1);
    const continuation = more && last ? cursorToken({ v: 2, basis, digest: normalized.requestDigest,
      generation: checkpoint!.generation, expiresAt: Date.now() + 5 * 60_000,
      last: { event: last.event, status: last.time_status, revision: last.revision } }, this.cursorKey) : null;
    return { profile: 'event-query-v1' as const, state: 'ready' as const, interpretation: input.interpretation,
      match: input.match, timeStatus: input.timeStatus,
      sourcePosition: { datasetId: 'product' as const, dataEpoch: dependencies.dataEpoch, sequence: dependencies.sequence },
      generation: checkpoint!.generation, generationRevision: window.revision,
      items, histogram: outputHistogram, continuation };
  }

  private async topicHistogram(client: PoolClient, normalized: ReturnType<typeof normalizedQuery>, events: string[]) {
    const civil = normalized.query.interpretation === 'civil-date';
    const prefix = civil ? 'civil' : 'instant';
    const range = civil ? 'daterange' : 'tstzrange';
    const start = civil ? 'b::date' : "b::timestamp AT TIME ZONE 'UTC'";
    const end = civil ? '(b+$4::interval)::date' : "(b+$4::interval)::timestamp AT TIME ZONE 'UTC'";
    // At most eight accepted aliases select sixteen slots; this is independent of inventory size.
    return (await client.query<{ time_status: 'actual' | 'planned'; bucket_start: string;
      definite_count: string; possible_count: string }>(`SELECT k.time_status,b::date::text AS bucket_start,
      count(*) FILTER(WHERE k.${prefix}_definite && ${range}(${start},${end},'[)'))::text AS definite_count,
      count(*)::text AS possible_count FROM access.event_temporal_interval k
      CROSS JOIN generate_series($2::date,$3::date,$4::interval) AS bucket(b)
      WHERE k.event=ANY($1::text[]) AND ($5::text IS NULL OR k.time_status=$5)
        AND k.${prefix}_possible && ${range}(${start},${end},'[)')
      GROUP BY k.time_status,b ORDER BY k.time_status,b`,
    [events, normalized.bucketStart, normalized.bucketEnd,
      normalized.query.grain === 'year' ? '1 year' : normalized.query.grain === 'month' ? '1 month' : '1 day',
      normalized.query.timeStatus])).rows;
  }
}

function bucketAt(start: string, grain: 'year' | 'month' | 'day', index: number): string {
  const date = new Date(`${start}T00:00:00.000Z`);
  if (grain === 'day') date.setUTCDate(date.getUTCDate() + index);
  else if (grain === 'month') date.setUTCMonth(date.getUTCMonth() + index);
  else date.setUTCFullYear(date.getUTCFullYear() + index);
  return date.toISOString().slice(0, 10);
}
