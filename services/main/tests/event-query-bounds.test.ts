import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Pool } from 'pg';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { contentEvidenceIri, eventTimeSlotIri, EventObservationUnavailable } from '../src/modules/event/observation.ts';
import { EventTemporalQueries, EventQueryDenied, EventQueryRestart, EventQueryUnavailable,
  type EventQueryInput } from '../src/modules/event/queries.ts';
import { readEventDependencies, readEventSource, readEventSourceKeys,
  EventSourceUnavailable } from '../src/modules/event/source.ts';
import { UnsupportedEventTime, type EventPoint } from '../src/modules/event/time.ts';

type Binding = NonNullable<SparqlResult['results']>['bindings'][number];
const value = (text: string) => ({ type: 'literal', value: text });
const id = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString().padStart(12, '0')}`;
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

class EventSourceFuseki extends FusekiClient {
  queries: string[] = [];
  sequence = '10';
  actual = id(101);
  planned = id(102);
  dependencies?: Binding[];
  inventory?: Binding[];
  targets = new Map<string, Binding[]>();
  afterTarget?: () => void;
  constructor() { super('http://localhost:1/rezics'); }
  override async query(sparql: string): Promise<SparqlResult> {
    this.queries.push(sparql);
    if (sparql.includes('SELECT ?epoch ?sequence ?actual')) {
      return { results: { bindings: this.dependencies ?? [{ epoch: value('epoch-event'), sequence: value(this.sequence),
        actual: value(this.actual), planned: value(this.planned), relaySequence: value('3') }] } };
    }
    if (sparql.includes('SELECT ?epoch ?sequence ?event ?status')) {
      if (!this.inventory) throw new Error('request attempted an Event inventory scan');
      return { results: { bindings: this.inventory } };
    }
    const target = /VALUES \(\?event \?status\) \{ \(<([^>]+)> <[^>]+\/(ActualTime|PlannedTime)>\)/.exec(sparql);
    if (!target) throw new Error('unexpected Event source query');
    const bindings = this.targets.get(`${target[1]}/${target[2] === 'ActualTime' ? 'actual' : 'planned'}`)
      ?? [{ epoch: value('epoch-event'), sequence: value(this.sequence), slotPresent: value('false'),
        eventPresent: value('false'), eventIsEvent: value('false') }];
    this.afterTarget?.();
    return { results: { bindings } };
  }
}

function sourceFixture() {
  const root = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'event-source-'));
  temporary.push(directory);
  const fuseki = new EventSourceFuseki();
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: directory,
    lineage: { dataEpoch: 'epoch-event', routingEpoch: '1' } };
  return { env, fuseki };
}

const day = (lexical = '2026-05-15'): EventPoint => ({ state: 'known',
  value: { kind: 'temporal', lexical, precision: 'day', calendar: 'gregorian' } });

function retainedSource(env: WorkActivationEnvironment, options: {
  event?: string; status?: 'actual' | 'planned'; start?: EventPoint; end?: EventPoint; evidence?: string;
} = {}) {
  const event = options.event ?? id(1), status = options.status ?? 'actual';
  const eventTime = eventTimeSlotIri(event, status);
  const revision = id(Number(event.slice(-12)) + 1000);
  const start = options.start ?? day(), end = options.end;
  const state = { event, eventTime, revision, timeStatus: status, temporalKind: end ? 'interval' : 'instant',
    start, ...(end ? { end, endPoint: `${revision}/end`, endValue: end.state === 'known' ? `${revision}/end/value` : null } : {}),
    startPoint: `${revision}/start`, startValue: start.state === 'known' ? `${revision}/start/value` : null,
    timeEvidence: options.evidence ?? null, recordedAt: '2026-05-01T00:00:00.000Z' };
  const manifest = `urn:rezics:sha256:${prepareComponent(env.objectDirectory, eventTime, state,
    'https://rezics.com/definition/event-time-v1')}`;
  const row: Binding = { epoch: value('epoch-event'), sequence: value('10'), event: value(event),
    slotPresent: value('true'), eventPresent: value('true'), eventIsEvent: value('true'),
    eventTime: value(eventTime), revisionEventTime: value(eventTime),
    status: value(`${RV}${status === 'actual' ? 'ActualTime' : 'PlannedTime'}`),
    head: value(revision), availability: value(`${RV}Available`), manifest: value(manifest),
    recordedAt: value(state.recordedAt), kind: value(`${RV}${end ? 'IntervalTime' : 'InstantTime'}`) };
  if (options.evidence) row.evidence = value(contentEvidenceIri(options.evidence));
  for (const [prefix, point] of [['start', start], ['end', end]] as const) {
    if (!point) continue;
    row[prefix] = value(`${revision}/${prefix}`);
    row[`${prefix}State`] = value(`${RV}${point.state === 'known' ? 'KnownPoint' : point.state === 'unknown' ? 'UnknownPoint' : 'OpenPoint'}`);
    if (point.state !== 'known') { row[`${prefix}Unknown`] = value(point.lexical); continue; }
    row[`${prefix}Value`] = value(`${revision}/${prefix}/value`);
    row[`${prefix}Lexical`] = value(point.value.lexical);
    row[`${prefix}Unit`] = value(`http://www.w3.org/2006/time#unit${point.value.precision[0]!.toUpperCase()}${point.value.precision.slice(1)}`);
    const offset = /(?:Z|[+-]\d{2}:\d{2})$/.exec(point.value.lexical)?.[0];
    if (offset) row[`${prefix}Offset`] = value(offset);
    if (point.value.timeZone) row[`${prefix}Zone`] = value(point.value.timeZone);
  }
  return { event, status, revision, manifest, row, state };
}

function retainedWithdrawal(env: WorkActivationEnvironment, event = id(1)) {
  const eventTime = eventTimeSlotIri(event, 'actual'), revision = id(Number(event.slice(-12)) + 1000);
  const state = { event, eventTime, timeStatus: 'actual', revision, timeAvailability: 'withdrawn',
    timeEvidence: null, recordedAt: '2026-05-01T00:00:00.000Z' };
  const manifest = `urn:rezics:sha256:${prepareComponent(env.objectDirectory, eventTime, state,
    'https://rezics.com/definition/event-time-v1')}`;
  const row: Binding = { epoch: value('epoch-event'), sequence: value('10'), event: value(event),
    slotPresent: value('true'), eventPresent: value('true'), eventIsEvent: value('true'),
    eventTime: value(eventTime), revisionEventTime: value(eventTime), status: value(`${RV}ActualTime`),
    head: value(revision), availability: value(`${RV}Withdrawn`), manifest: value(manifest),
    recordedAt: value(state.recordedAt) };
  return { event, revision, manifest, row };
}

test('RATE07/RATE09: exact graph and retained manifest must agree for each source target', async () => {
  const { env, fuseki } = sourceFixture();
  const retained = retainedSource(env, { evidence: '00000000-0000-4000-8000-000000000077' });
  fuseki.targets.set(`${retained.event}/actual`, [retained.row]);
  const source = await readEventSource(env, { target: { event: retained.event, status: 'actual' } });
  expect(source.rows[0]).toMatchObject({ event: retained.event, timeRevision: retained.revision,
    startPrecision: 'day', civilStartMin: '2026-05-15', civilEndMax: '2026-05-15', instantSupported: false });
  expect(source.states.get(retained.revision)).toEqual(retained.state);
  for (const [field, replacement] of Object.entries({ startLexical: '2026-05-16',
    startUnit: 'http://www.w3.org/2006/time#unitMonth', start: id(55), startValue: id(56),
    recordedAt: '2026-05-02T00:00:00Z', evidence: contentEvidenceIri('00000000-0000-4000-8000-000000000078'),
    kind: `${RV}IntervalTime`, status: `${RV}PlannedTime`, revisionEventTime: id(55) })) {
    fuseki.targets.set(`${retained.event}/actual`, [{ ...retained.row, [field]: value(replacement) }]);
    await expect(readEventSource(env, { target: { event: retained.event, status: 'actual' } }))
      .rejects.toBeInstanceOf(EventSourceUnavailable);
  }
  const otherSlot = value(eventTimeSlotIri(retained.event, 'planned'));
  fuseki.targets.set(`${retained.event}/actual`, [{ ...retained.row, eventTime: otherSlot, revisionEventTime: otherSlot }]);
  await expect(readEventSource(env, { target: { event: retained.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventObservationUnavailable);
  expect(fuseki.queries.every(query => query.includes('VALUES (?event ?status)') && query.includes('LIMIT 2'))).toBe(true);
  const query = fuseki.queries[0]!;
  expect(query).toContain(`<${retained.event}> a rv:Event`);
  expect(query).toContain(`<${eventTimeSlotIri(retained.event, 'actual')}> a rv:EventTime ; rv:event <${retained.event}>`);
  expect(query).toContain(`BIND(<${eventTimeSlotIri(retained.event, 'actual')}> AS ?eventTime)`);
  expect(query).not.toContain('?eventTime a rv:EventTime');
  expect(query).not.toContain('FILTER(BOUND(?head))');
});

test('RATE09: recorded times compare exact instants without hiding sub-millisecond graph changes', async () => {
  const { env, fuseki } = sourceFixture();
  const retained = retainedSource(env);
  fuseki.targets.set(`${retained.event}/actual`, [{ ...retained.row, recordedAt: value('2026-04-30T20:00:00-04:00') }]);
  expect((await readEventSource(env, { target: { event: retained.event, status: 'actual' } })).rows[0]?.timeRevision)
    .toBe(retained.revision);
  fuseki.targets.set(`${retained.event}/actual`, [{ ...retained.row, recordedAt: value('2026-05-01T00:00:00.000001Z') }]);
  await expect(readEventSource(env, { target: { event: retained.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventSourceUnavailable);
});

test('RATE09: missing and withdrawn slots are absent, malformed or corrupt targets do not poison peers', async () => {
  const { env, fuseki } = sourceFixture();
  const missing = await readEventSource(env, { target: { event: id(1), status: 'actual' } });
  expect(missing.head).toBeNull();
  expect(missing.rows).toEqual([]);
  const withdrawn = retainedWithdrawal(env);
  fuseki.targets.set(`${withdrawn.event}/actual`, [withdrawn.row]);
  expect((await readEventSource(env, { target: { event: id(1), status: 'actual' } })).rows).toEqual([]);
  const broken = retainedSource(env), healthy = retainedSource(env, { event: id(2) });
  fuseki.targets.set(`${withdrawn.event}/actual`, [{ ...withdrawn.row, manifest: value(broken.manifest) }]);
  await expect(readEventSource(env, { target: { event: withdrawn.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventSourceUnavailable);
  rmSync(join(env.objectDirectory, withdrawn.manifest.slice(-64)));
  fuseki.targets.set(`${withdrawn.event}/actual`, [withdrawn.row]);
  await expect(readEventSource(env, { target: { event: withdrawn.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventObservationUnavailable);
  fuseki.targets.set(`${broken.event}/actual`, [{ ...broken.row, startLexical: value('2026-05-16') }]);
  fuseki.targets.set(`${healthy.event}/actual`, [healthy.row]);
  await expect(readEventSource(env, { target: { event: broken.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventSourceUnavailable);
  writeFileSync(join(env.objectDirectory, broken.manifest.slice(-64)), '{}');
  fuseki.targets.set(`${broken.event}/actual`, [broken.row]);
  await expect(readEventSource(env, { target: { event: broken.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventObservationUnavailable);
  expect((await readEventSource(env, { target: { event: healthy.event, status: 'actual' } })).rows[0]?.event).toBe(healthy.event);
});

test('RATE09: damaged existing slots and missing Event identity cannot impersonate absent observations', async () => {
  const { env, fuseki } = sourceFixture();
  const healthy = retainedSource(env, { event: id(2) });
  fuseki.targets.set(`${healthy.event}/actual`, [healthy.row]);
  const missingHead: Binding = { epoch: value('epoch-event'), sequence: value('10'),
    slotPresent: value('true'), eventPresent: value('true'), eventIsEvent: value('true') };
  for (const damaged of [missingHead,
    { ...missingHead, eventIsEvent: value('false') },
    { ...missingHead, eventPresent: value('false'), eventIsEvent: value('false') },
    { ...healthy.row, slotPresent: value('false') }]) {
    fuseki.targets.set(`${id(1)}/actual`, [damaged]);
    await expect(readEventSource(env, { target: { event: id(1), status: 'actual' } }))
      .rejects.toBeInstanceOf(EventSourceUnavailable);
    expect((await readEventSource(env, { target: { event: healthy.event, status: 'actual' } })).rows[0]?.event)
      .toBe(healthy.event);
  }
  fuseki.targets.set(`${id(1)}/actual`, [{ ...missingHead, slotPresent: value('false') }]);
  const absent = await readEventSource(env, { target: { event: id(1), status: 'actual' } });
  expect(absent.head).toBeNull();
  expect(absent.rows).toEqual([]);
  const query = fuseki.queries[0]!;
  expect(query).toContain(`${eventTimeSlotIri(id(1), 'actual')}> ?slotPredicate ?slotObject`);
  expect(query).toContain('AS ?slotPresent');
  expect(query).toContain('AS ?eventPresent');
  expect(query).toContain('AS ?eventIsEvent');
  expect(query).toContain('LIMIT 2');
});

test('RATE09: unknown and open preserve explanations; coarse precision cannot poison exact instant sources', async () => {
  const { env, fuseki } = sourceFixture();
  const unknown = retainedSource(env, { start: { state: 'unknown', lexical: 'not recorded' },
    end: { state: 'open', lexical: 'ongoing' } });
  const coarse = retainedSource(env, { event: id(2), start: { state: 'known',
    value: { kind: 'temporal', lexical: '2026-05', precision: 'month', calendar: 'gregorian' } } });
  const exact = retainedSource(env, { event: id(3), start: { state: 'known',
    value: { kind: 'temporal', lexical: '2026-05-15T12:30:00+02:00', precision: 'second', calendar: 'gregorian' } } });
  for (const source of [unknown, coarse, exact]) fuseki.targets.set(`${source.event}/actual`, [source.row]);
  const unbounded = await readEventSource(env, { target: { event: unknown.event, status: 'actual' } });
  expect(unbounded.rows[0]).toMatchObject({ startState: 'unknown', endState: 'open', startPrecision: null,
    endPrecision: null, civilStartMin: null, civilEndMax: null, instantSupported: true });
  expect(unbounded.states.get(unknown.revision)?.start).toEqual(unknown.state.start);
  for (const row of [{ ...unknown.row, endUnknown: value('source never said ongoing') },
    { ...unknown.row, startValue: value(id(55)) }]) {
    fuseki.targets.set(`${unknown.event}/actual`, [row]);
    await expect(readEventSource(env, { target: { event: unknown.event, status: 'actual' } }))
      .rejects.toBeInstanceOf(EventSourceUnavailable);
  }
  expect((await readEventSource(env, { target: { event: coarse.event, status: 'actual' } })).rows[0])
    .toMatchObject({ startPrecision: 'month', civilStartMin: '2026-05-01', civilStartMax: '2026-05-31', instantSupported: false });
  expect((await readEventSource(env, { target: { event: exact.event, status: 'actual' } })).rows[0])
    .toMatchObject({ instantSupported: true, instantStartMin: '2026-05-15T10:30:00Z',
      instantEndMax: '2026-05-15T10:30:00.999999Z' });
  fuseki.targets.set(`${exact.event}/actual`, [{ ...exact.row, startOffset: value('Z') }]);
  await expect(readEventSource(env, { target: { event: exact.event, status: 'actual' } }))
    .rejects.toBeInstanceOf(EventSourceUnavailable);
});

test('RATE07: backfill key reads seek by event and status with a bounded batch', async () => {
  const { env, fuseki } = sourceFixture();
  fuseki.inventory = [{ epoch: value('epoch-event'), sequence: value('10'), event: value(id(2)), status: value(`${RV}PlannedTime`) }];
  expect(await readEventSourceKeys(env, { after: { event: id(2), status: 'actual' }, limit: 32 }))
    .toEqual({ position: { dataEpoch: 'epoch-event', sequence: '10' }, keys: [{ event: id(2), status: 'planned' }] });
  expect(fuseki.queries[0]).toContain('LIMIT 32');
  expect(fuseki.queries[0]).toContain('ORDER BY ?event ?status');
  expect(fuseki.queries[0]).toContain(`STR(?event) > "${id(2)}"`);
  expect(fuseki.queries[0]).toContain(`STR(?status) > "${RV}ActualTime"`);
  for (const limit of [0, 101, 1.5]) await expect(readEventSourceKeys(env, { limit })).rejects.toBeInstanceOf(EventSourceUnavailable);
  await expect(readEventSourceKeys(env, { after: { event: 'bad', status: 'actual' } })).rejects.toBeInstanceOf(EventSourceUnavailable);
  expect(fuseki.queries).toHaveLength(1);
  fuseki.inventory = [{ epoch: value('epoch-event'), sequence: value('11') }];
  expect((await readEventSourceKeys(env)).keys).toEqual([]);
});

test('RATE07: dependencies read only local collection revisions and enforce owner availability', async () => {
  const { env, fuseki } = sourceFixture();
  expect(await readEventDependencies(env)).toEqual({ dataEpoch: 'epoch-event', sequence: '10',
    actual: id(101), planned: id(102), relaySequence: '3' });
  expect(fuseki.queries[0]).toContain('LIMIT 2');
  expect(fuseki.queries[0]).toContain('rv:restoreHold true');
  expect(fuseki.queries[0]).not.toContain('rv:EventTime');
  for (const dependencies of [[], [{ epoch: value('epoch-event'), sequence: value('-1') }],
    [{ epoch: value('epoch-event'), sequence: value('1') }, { epoch: value('epoch-event'), sequence: value('1') }]]) {
    fuseki.dependencies = dependencies;
    await expect(readEventDependencies(env)).rejects.toBeInstanceOf(EventSourceUnavailable);
  }
});

const queryInput: EventQueryInput = { interpretation: 'civil-date', match: 'possible',
  timeStatus: 'actual', grain: 'day', start: '2026-05-15', end: '2026-05-15', pageSize: 1 };

function indexedFixture() {
  const { env, fuseki } = sourceFixture();
  const sql: { text: string; values: unknown[] }[] = [];
  const checkpoint = { generation: '11111111-1111-4111-8111-111111111111', data_epoch: 'epoch-event',
    relay_sequence: '3', backfill_complete: true, processed: '2', actual_revision: id(101), planned_revision: id(102) };
  const window = { id: '22222222-2222-4222-8222-222222222222', state: 'ready', processed: '2',
    revision: '1', created_at: '2026-05-01T00:00:00Z', unsupported_actual_count: '0', unsupported_planned_count: '0' };
  const pending = { pending: false, failed: false, updates: false };
  const members = [1, 2].map(number => {
    const retained = retainedSource(env, { event: id(number) });
    fuseki.targets.set(`${retained.event}/actual`, [retained.row]);
    return { event: retained.event, time_status: 'actual' as const, revision: retained.revision, definite: true };
  });
  let connects = 0, released = 0;
  let recovery = true;
  const client = {
    async query(text: string, values: unknown[] = []) {
      sql.push({ text, values });
      if (text.includes('SELECT open FROM')) return { rows: [{ open: recovery }] };
      if (text.includes('FROM access.event_temporal_checkpoint')) return { rows: [checkpoint] };
      if (text.includes('SELECT id::text,state')) return { rows: [window] };
      if (text.includes('AS pending')) return { rows: [pending] };
      if (text.includes('FROM access.event_temporal_member')) {
        const after = text.includes('AND (event,time_status)>') ? String(values.at(-2)) : '';
        const limit = Number(/LIMIT (\d+)/.exec(text)?.[1]);
        return { rows: members.filter(member => member.event > after).slice(0, limit) };
      }
      if (text.includes('FROM access.event_temporal_bucket')) return { rows: [{ time_status: 'actual',
        bucket_start: '2026-05-15', definite_count: '2', possible_count: '2' }] };
      if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK' || text.includes('INSERT INTO access.event_temporal_window')) {
        return { rows: [] };
      }
      throw new Error(`unexpected index SQL: ${text}`);
    },
    release() { released++; },
  };
  const pool = { async connect() { connects++; return client; } } as unknown as Pool;
  const facade = new EventTemporalQueries(pool, env, new Uint8Array(32).fill(7));
  return { facade, fuseki, checkpoint, window, pending, sql, members,
    connects: () => connects, released: () => released, hold: () => { recovery = false; } };
}

test('RATE07: cold, interrupted, failed and bucket-building coverage report progress without a source scan', async () => {
  for (const state of ['cold', 'interrupted', 'failed', 'buckets'] as const) {
    const fixture = indexedFixture();
    fixture.checkpoint.backfill_complete = state === 'failed' || state === 'buckets';
    fixture.checkpoint.processed = state === 'cold' ? '0' : '2';
    fixture.pending.pending = state === 'failed';
    fixture.pending.failed = state === 'failed';
    fixture.window.state = state === 'buckets' ? 'building' : 'ready';
    const result = await fixture.facade.query(queryInput);
    expect(result).toMatchObject({ state: state === 'cold' ? 'unavailable' : 'partial',
      items: [], histogram: [], continuation: null, progress: { processed: fixture.checkpoint.processed,
        phase: state === 'failed' ? 'targets' : state === 'buckets' ? 'buckets' : 'backfill', failed: state === 'failed' } });
    expect(fixture.fuseki.queries).toHaveLength(1);
    expect(fixture.fuseki.queries[0]).toContain('SELECT ?epoch ?sequence ?actual');
    expect(fixture.sql.some(call => call.text.includes('FROM access.event_temporal_member'))).toBe(false);
    expect(fixture.sql.some(call => call.text.includes('FROM access.event_temporal_bucket'))).toBe(false);
    expect(fixture.released()).toBe(1);
  }
});

test('RATE07/RATE09: invalid range, page, precision and topic selections fail before storage access', async () => {
  const fixture = indexedFixture();
  const invalid: Partial<EventQueryInput>[] = [{ pageSize: 0 }, { pageSize: 51 }, { pageSize: 1.5 },
    { interpretation: 'other' as EventQueryInput['interpretation'] }, { match: 'other' as EventQueryInput['match'] },
    { timeStatus: 'other' as EventQueryInput['timeStatus'] }, { topics: [id(1)] },
    { topics: [id(1), id(1)], acceptance: { kind: 'global' } },
    { topics: Array.from({ length: 9 }, (_, index) => id(index + 1)), acceptance: { kind: 'global' } }];
  for (const input of invalid) await expect(fixture.facade.query({ ...queryInput, ...input })).rejects.toBeInstanceOf(EventQueryDenied);
  await expect(fixture.facade.query({ ...queryInput, start: '2026-05', end: '2026-05' })).rejects.toBeInstanceOf(EventQueryDenied);
  await expect(fixture.facade.query({ ...queryInput, start: '2028-01-01', end: '2029-01-01' })).rejects.toBeInstanceOf(UnsupportedEventTime);
  expect(fixture.connects()).toBe(0);
  expect(fixture.fuseki.queries).toEqual([]);
});

test('RATE09: exact instant coverage ignores unsupported points outside the selected time status', async () => {
  const fixture = indexedFixture();
  fixture.members.splice(0);
  fixture.window.unsupported_planned_count = '1';
  const result = await fixture.facade.query({ ...queryInput, interpretation: 'instant',
    start: '2026-05-15T00:00:00Z', end: '2026-05-15T23:59:59Z' });
  expect(result).toMatchObject({ state: 'ready', interpretation: 'instant', timeStatus: 'actual', items: [] });
  expect(fixture.sql.some(call => call.text.includes('FROM access.event_temporal_member'))).toBe(true);
  expect(fixture.fuseki.queries.every(query => query.includes('SELECT ?epoch ?sequence ?actual'))).toBe(true);
});

test('RATE09: unsupported selected instant points fail explicitly before page and histogram reads', async () => {
  const fixture = indexedFixture();
  fixture.window.unsupported_actual_count = '1';
  await expect(fixture.facade.query({ ...queryInput, interpretation: 'instant',
    start: '2026-05-15T00:00:00Z', end: '2026-05-15T23:59:59Z' })).rejects.toBeInstanceOf(UnsupportedEventTime);
  expect(fixture.sql.some(call => call.text.includes('FROM access.event_temporal_member'))).toBe(false);
  expect(fixture.sql.some(call => call.text.includes('FROM access.event_temporal_bucket'))).toBe(false);
  expect(fixture.fuseki.queries).toHaveLength(1);
  expect(fixture.released()).toBe(1);
});

test('RATE07/RATE08: pages seek the bounded index, hydrate only returned rows and read one bucket window', async () => {
  const fixture = indexedFixture();
  const first = await fixture.facade.query(queryInput);
  expect(first.state).toBe('ready');
  expect(first.items.map(item => item.event)).toEqual([id(1)]);
  expect(first.histogram).toEqual([{ timeStatus: 'actual', bucketStart: '2026-05-15', definite: 2, possible: 2 }]);
  expect(first.continuation).toBeString();
  expect(fixture.fuseki.queries.filter(query => query.includes('VALUES (?event ?status)'))).toHaveLength(1);
  const pageSql = fixture.sql.find(call => call.text.includes('FROM access.event_temporal_member'))!;
  expect(pageSql.text).toContain('ORDER BY event,time_status LIMIT 2');
  const bucketSql = fixture.sql.find(call => call.text.includes('FROM access.event_temporal_bucket'))!;
  expect(bucketSql.values).toEqual([fixture.window.id, '2026-05-15', '2026-05-15', 'actual']);
  fixture.fuseki.sequence = '9000';
  fixture.fuseki.planned = id(999);
  const second = await fixture.facade.query({ ...queryInput, continuation: first.continuation! });
  expect(second.items.map(item => item.event)).toEqual([id(2)]);
  expect(second.continuation).toBeNull();
  const seek = fixture.sql.find(call => call.text.includes('AND (event,time_status)>'))!;
  expect(seek.values.slice(-2)).toEqual([id(1), 'actual']);
});

test('RATE07: signed continuations reject tampering, changed queries and relevant collection revisions', async () => {
  const fixture = indexedFixture();
  const first = await fixture.facade.query(queryInput);
  const token = first.continuation!;
  const [body, signature] = token.split('.');
  const forgedSignature = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
  const connects = fixture.connects();
  await expect(fixture.facade.query({ ...queryInput, continuation: `${body}.${forgedSignature}` })).rejects.toBeInstanceOf(EventQueryRestart);
  await expect(fixture.facade.query({ ...queryInput, pageSize: 2, continuation: token })).rejects.toBeInstanceOf(EventQueryRestart);
  fixture.fuseki.actual = id(999);
  await expect(fixture.facade.query({ ...queryInput, continuation: token })).rejects.toBeInstanceOf(EventQueryRestart);
  expect(fixture.connects()).toBe(connects);
});

test('RATE07: recovery holds and stale hydrated heads cannot return a cached ready basis', async () => {
  const held = indexedFixture();
  held.hold();
  await expect(held.facade.query(queryInput)).rejects.toBeInstanceOf(EventQueryUnavailable);
  expect(held.released()).toBe(1);
  expect(held.fuseki.queries).toHaveLength(1);
  const stale = indexedFixture();
  stale.fuseki.targets.delete(`${id(1)}/actual`);
  await expect(stale.facade.query(queryInput)).rejects.toBeInstanceOf(EventQueryRestart);
  const changed = indexedFixture();
  changed.fuseki.afterTarget = () => { changed.fuseki.actual = id(999); };
  await expect(changed.facade.query(queryInput)).rejects.toBeInstanceOf(EventQueryRestart);
});
