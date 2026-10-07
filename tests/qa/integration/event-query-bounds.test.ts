import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { EVENT_PROJECTION_COST, EventTemporalProjection } from '../../../services/main/src/modules/event/projection.ts';
import { EventQueryRestart, EventTemporalQueries, type EventQueryInput }
  from '../../../services/main/src/modules/event/queries.ts';
import { eventObservationDigest, eventObservationReceiptIri, eventTimeSlotIri, readEventObservationReceipt, setEventObservation }
  from '../../../services/main/src/modules/event/observation.ts';
import { checkedEventObservation, type EventPoint }
  from '../../../services/main/src/modules/event/time.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { DATASET, GRAPHS, ID, RV, hash, iri, lit, prepareComponent, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { cancelSemanticAdmission } from '../../../services/main/src/modules/semantic/command.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { eventEffectFence, eventIntentEffect, hasEventEffects, registerEventPublication } from '../../../services/main/src/modules/event/effects.ts';
import { EVENT_SOURCE_BATCH_SQL, EVENT_SOURCE_MEMBERS_SQL, EVENT_SOURCE_COST, readEventCollectionKeys, readEventDependencies, readEventSource, readEventSourceKeys } from '../../../services/main/src/modules/event/source.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const native = () => `${ID}${randomUUID()}`;
const PROFILE = 'https://rezics.com/definition/event-time-v1';
const point = (lexical: string): EventPoint => ({ state: 'known', value: {
  kind: 'temporal', lexical, precision: 'day', calendar: 'gregorian' } });

interface QueryPlan {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Cond'?: string;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: QueryPlan[];
}
const filteredRows = (plan: QueryPlan): number =>
  (plan['Rows Removed by Filter'] ?? 0) * plan['Actual Loops']
  + (plan.Plans ?? []).reduce((sum, child) => sum + filteredRows(child), 0);

test('Event buckets: over 2,000 slots page after interrupted bounded backfill; target failure and replay preserve counts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH) throw new Error('Run through the isolated QA integration tier');
  const directory = resolve('.temp', `event-query-bounds-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const databases = await cloneQaOwnerDatabases(Bun.env.REZICS_QA_RUN_ID, ['access', 'relay']);
  const access = new Pool({ connectionString: databases.urls.access, max: 4 });
  const relay = new Pool({ connectionString: databases.urls.relay, max: 4 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL, Bun.env.FUSEKI_MAINTENANCE_TOKEN,
    Bun.env.FUSEKI_COMMAND_TOKEN);
  const env: WorkActivationEnvironment & { eventTemporalAccess: Pool } = { fuseki, objectDirectory: join(directory, 'objects'),
    eventTemporalAccess: access, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
  const queries = new EventTemporalQueries(access, env, Buffer.alloc(32, 9));
  let projection = new EventTemporalProjection(access, relay, env);
  const consumer = `event-bounds-${randomUUID()}`;
  const actor = native(), target = native();
  const input: EventQueryInput = { interpretation: 'civil-date', match: 'possible', grain: 'day',
    start: '2077-05-15', end: '2077-05-15', pageSize: 50, timeStatus: 'actual' };
  const observed = { sourceRows: 0, sourceCalls: 0, maxBatchRows: 0, bucketRows: 0, pageRows: 0, replayRows: 0, collectionRows: 0 };
  access.on('connect', client => {
    client.query = new Proxy(client.query, { apply(query, receiver, args) {
      const response: unknown = Reflect.apply(query, receiver, args);
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (!(response instanceof Promise)) return response;
      return response.then((result: unknown) => {
        if (result && typeof result === 'object' && 'rowCount' in result
          && typeof result.rowCount === 'number') {
          if (sql.includes('access.event_temporal_bucket')) observed.bucketRows += result.rowCount;
          if (sql.includes('access.event_temporal_member') && sql.trimStart().startsWith('SELECT')) {
            observed.pageRows += result.rowCount;
          }
        }
        return result;
      });
    } });
  });
  relay.query = new Proxy(relay.query, { apply(query, receiver, args) {
      const response: unknown = Reflect.apply(query, receiver, args);
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (!(response instanceof Promise)) return response;
      return response.then((result: unknown) => {
        if (result && typeof result === 'object' && 'rowCount' in result
          && typeof result.rowCount === 'number') {
          if (sql === EVENT_SOURCE_BATCH_SQL || sql === EVENT_SOURCE_MEMBERS_SQL) observed.replayRows += result.rowCount;
          if (sql.includes('WITH cut AS MATERIALIZED')) observed.collectionRows += result.rowCount;
        }
        return result;
      });
  } });
  const sourceQuery = fuseki.query.bind(fuseki);
  fuseki.query = async (sparql, bytes) => {
    const result = await sourceQuery(sparql, bytes);
    const count = result.results?.bindings.length ?? 0;
    observed.sourceRows += count;
    observed.sourceCalls++;
    observed.maxBatchRows = Math.max(observed.maxBatchRows, count);
    return result;
  };
  const resetObserved = () => {
    observed.sourceRows = 0; observed.sourceCalls = 0; observed.maxBatchRows = 0;
    observed.bucketRows = 0; observed.pageRows = 0; observed.replayRows = 0; observed.collectionRows = 0;
  };
  const write = async (event: string, lexical: string, expectedRevisionHead: string | null,
    timeStatus: 'actual' | 'planned' = 'actual') => {
    const intent = checkedEventObservation({ event, timeStatus, temporalKind: 'instant',
      start: point(lexical), actingSubject: actor, expectedRevisionHead });
    const admission = { id: randomUUID(), principalId: randomUUID(), actingSubject: actor,
      scope: `event:observe:${event}`, action: 'event.observation.set', idempotencyKey: randomUUID(),
      requestDigest: eventObservationDigest(intent), authorityEpoch: '0',
      registeredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString(),
      state: 'claimed' as const, dispatchEligible: true, replayed: false };
    return setEventObservation(env, admission, intent);
  };
  const drain = async () => {
    for (let batch = 0; batch < 10000; batch++) {
      if (!await relayMainOutboxOnce(fuseki, relay, consumer)) return;
    }
    throw new Error('Event fixture relay exceeded its batch bound');
  };
  let sustain = false, traffic = 0, stressBoundary: string | null = null;
  const unrelatedMain = async (count: number = EVENT_PROJECTION_COST.relayBatches + 1) => {
    const before = BigInt((await readEventDependencies(env)).relaySequence);
    await Promise.all(Array.from({ length: count }, async () => {
      const id = randomUUID(), receipt = `urn:rezics:receipt:${hash(id)}`;
      await cancelSemanticAdmission(env, receipt, { id, scope: `work:edit:${actor}`,
        authorityEpoch: '0', requestDigest: hash(receipt) });
      traffic++;
    }));
    const after = BigInt((await readEventDependencies(env)).relaySequence);
    expect(after - before).toBeGreaterThanOrEqual(BigInt(count));
    await drain();
  };
  const advance = async () => {
    if (stressBoundary && !sustain) {
      const checkpoint = (await access.query<{ sequence: string }>(
        'SELECT relay_sequence::text AS sequence FROM access.event_temporal_checkpoint WHERE singleton')).rows[0];
      if (checkpoint && BigInt(checkpoint.sequence) >= BigInt(stressBoundary) - BigInt(2 * EVENT_SOURCE_COST.batches)) sustain = true;
    }
    if (sustain) await unrelatedMain();
    return projection.tick();
  };
  const ready = async (query = input) => {
    for (let tick = 0; tick < 1000; tick++) {
      const result = await queries.query(query);
      if (result.state === 'ready') return result;
      expect(result.state === 'unavailable' || result.state === 'partial').toBe(true);
      expect(result.progress).toBeDefined();
      await advance();
    }
    const pending = (await access.query(`SELECT (SELECT count(*) FROM access.event_temporal_pending) AS targets,
      (SELECT count(*) FROM access.event_temporal_window_update) AS effects,
      (SELECT count(*) FROM access.event_temporal_window WHERE state<>'ready') AS windows,
      actual_revision,planned_revision FROM access.event_temporal_checkpoint WHERE singleton`)).rows[0];
    throw new Error(`Event fixture did not become ready: ${JSON.stringify({ query, pending })}`);
  };
  const fixtures: { event: string; eventTime: string; revision: string; manifest: string }[] = [];
  const unrelated: string[] = [];
  let broken: (typeof fixtures)[number] | undefined;
  let manifestPath = '';
  let hidden = false, failed = false;
  try {
    // A genuine acknowledged native Main prefix precedes the FIRST tick.
    // Its size is sixty-four consumer batches, with zero Event members.
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    for (let group = 0; group < 64; group++) await unrelatedMain(32);
    const prefix = (await readEventDependencies(env)).relaySequence;
    expect(BigInt(prefix)).toBeGreaterThanOrEqual(2048n);
    const initial = await write(target, input.start, null);
    const coldEvents = [native(), native()]; unrelated.push(...coldEvents);
    for (const event of coldEvents) await write(event, '2076-05-15', null, 'planned');
    await drain();
    expect((await access.query('SELECT 1 FROM access.event_temporal_checkpoint')).rows).toHaveLength(0);
    const coldQuery = { ...input, start: '2076-05-15', end: '2076-05-15', timeStatus: 'planned' as const, pageSize: 1 };
    expect((await queries.query(coldQuery)).state).toBe('unavailable');
    const coldBoundary = (await readEventDependencies(env)).relaySequence;
    resetObserved();
    // Every readiness tick receives more Main batches than replay can consume.
    sustain = true;
    let coldTicks = 0;
    let coldFirst = await queries.query(coldQuery);
    while (coldFirst.state !== 'ready' && coldTicks < 3) {
      await advance(); coldTicks++;
      coldFirst = await queries.query(coldQuery);
    }
    expect(coldFirst.state).toBe('ready');
    expect(coldTicks).toBe(1);
    expect(observed.replayRows).toBe(32);
    expect(observed.collectionRows).toBe(3);
    expect(coldFirst.items).toHaveLength(1);
    expect(coldFirst.continuation).not.toBeNull();
    await advance();
    const coldNext = await queries.query({ ...coldQuery, continuation: coldFirst.continuation! });
    expect(coldNext.state).toBe('ready'); expect(coldNext.items).toHaveLength(1);
    const coldCheckpoint = (await access.query(`SELECT initial_sequence::text,relay_sequence::text,
      backfill_complete FROM access.event_temporal_checkpoint WHERE singleton`)).rows[0]!;
    // First tick captures the boundary after its new noise; it remains fixed.
    expect(BigInt(coldCheckpoint.initial_sequence)).toBeGreaterThanOrEqual(BigInt(coldBoundary));
    expect(BigInt(coldCheckpoint.relay_sequence)).toBeLessThanOrEqual(64n);
    expect(coldCheckpoint.backfill_complete).toBe(false);
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    const collectionWork = async () => {
      let touched = 0;
      for (const status of ['actual', 'planned'] as const) {
        let statement = '', parameters: unknown[] = [];
        const measured = { query: async (sql: string, values: unknown[]) => {
          statement = sql; parameters = values; return relay.query(sql, values);
        } } as unknown as Pool;
        const page = await readEventCollectionKeys(measured, { dataEpoch: env.lineage.dataEpoch,
          status, sequence: '0', eventId: null });
        expect(page.keys).toHaveLength(status === 'actual' ? 1 : 2);
        const plan = (await relay.query<{ 'QUERY PLAN': { Plan: QueryPlan }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`, parameters)).rows[0]!['QUERY PLAN'][0]!.Plan;
        const visit = (node: QueryPlan) => {
          if (!node.Plans?.length) touched += node['Actual Rows'] * node['Actual Loops'];
          touched += (node['Rows Removed by Filter'] ?? 0) * node['Actual Loops'];
          if (node['Relation Name'] === 'delivered_event') {
            // Three retained Event members fit one page; PostgreSQL may
            // choose that page over the matching status index at this size.
            expect(node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(3);
          }
          for (const child of node.Plans ?? []) visit(child);
        }; visit(plan);
      }
      expect(touched).toBeLessThanOrEqual(16);
      return touched;
    };
    await relay.query('ANALYZE relay.delivered_event');
    await relay.query('ANALYZE relay.checkpoint');
    const coldWork = await collectionWork();
    for (let group = 0; group < 16; group++) await unrelatedMain(32);
    expect(await collectionWork()).toBe(coldWork);
    await advance();
    expect((await queries.query({ ...coldQuery, continuation: coldFirst.continuation! })).state).toBe('ready');
    console.info('Cold local coverage before global replay', { acknowledgedUnrelated: 2560,
      readinessTicks: coldTicks, replaySequence: coldCheckpoint.relay_sequence, collectionTouched: coldWork });
    sustain = false;
    // Exercise a fresh, interrupted populated consumer from its durable origin.
    await access.query(`TRUNCATE access.event_temporal_window_update,access.event_temporal_bucket,
      access.event_temporal_member,access.event_temporal_window,access.event_temporal_interval,
      access.event_temporal_applied,access.event_temporal_pending,access.event_temporal_checkpoint CASCADE`);
    // Every inventory identity is admitted by the real Event owner and has a
    // retained receipt/outbox handoff; no graph-wide inventory is assumed.
    for (let offset = 0; offset < 2050; offset += 16) {
      fixtures.push(...await Promise.all(Array.from({ length: Math.min(16, 2050 - offset) }, async () => {
        const event = native(), result = await write(event, input.start, null);
        return { event, eventTime: eventTimeSlotIri(event, 'actual'), revision: result.revision!, manifest: '' };
      })));
      if (offset % 512 === 0) console.info('Owner-admitted Event fixtures', fixtures.length);
    }
    broken = fixtures[0]!;
    const manifest = (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(broken.revision)} rv:manifest ?manifest } }`)).results!.bindings[0]!.manifest!.value;
    broken.manifest = manifest.replace('urn:rezics:sha256:', '');
    manifestPath = join(env.objectDirectory, broken.manifest);
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    await drain();
    const sourceCut = (await relay.query<{ sequence: string }>(`SELECT max(sequence)::text AS sequence
      FROM relay.delivered_batch WHERE stream_scope=$1 AND data_epoch=$2`,
    ['urn:rezics:stream:main-rdf', env.lineage.dataEpoch])).rows[0]!.sequence;
    const planWork = async () => {
      const captured: { text: string; values: unknown[] }[] = [];
      const measuredRelay = { query: async (text: string, values: unknown[]) => {
        captured.push({ text, values }); return relay.query(text, values);
      } } as unknown as Pool;
      await relay.query('ANALYZE relay.delivered_batch');
      await relay.query('ANALYZE relay.delivered_event');
      const inventory = await readEventSourceKeys(measuredRelay, {
        dataEpoch: env.lineage.dataEpoch, afterSequence: (BigInt(sourceCut) - 200n).toString() });
      expect(inventory!.keys).toHaveLength(EVENT_SOURCE_COST.batches);
      let touched = 0;
      for (const query of captured) {
        const plan = (await relay.query<{ 'QUERY PLAN': { Plan: QueryPlan }[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values)).rows[0]!['QUERY PLAN'][0]!.Plan;
        const visit = (node: QueryPlan) => {
          if (node['Relation Name'] === 'delivered_batch' || node['Relation Name'] === 'delivered_event') {
            expect(node['Node Type']).toMatch(/Index (Only )?Scan|Bitmap Heap Scan/);
            touched += node['Actual Rows'] * node['Actual Loops']
              + (node['Rows Removed by Filter'] ?? 0) * node['Actual Loops'];
          }
          if (node['Node Type'] === 'Sort') expect(node['Actual Rows']).toBeLessThanOrEqual(EVENT_SOURCE_COST.members);
          for (const child of node.Plans ?? []) visit(child);
        };
        visit(plan);
        expect((plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0)).toBeLessThanOrEqual(256);
      }
      expect(touched).toBeLessThanOrEqual(EVENT_SOURCE_COST.batches + EVENT_SOURCE_COST.members);
      const collection = await readEventCollectionKeys(measuredRelay, { dataEpoch: env.lineage.dataEpoch,
        status: 'actual', sequence: (BigInt(sourceCut) - 200n).toString(), eventId: null });
      expect(collection.keys).toHaveLength(32);
      const scoped = captured.at(-1)!;
      const collectionPlan = (await relay.query<{ 'QUERY PLAN': { Plan: QueryPlan }[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scoped.text}`, scoped.values)).rows[0]!['QUERY PLAN'][0]!.Plan;
      let collectionTouched = 0;
      const visitCollection = (node: QueryPlan) => {
        if (node['Relation Name']) collectionTouched += node['Actual Rows'] * node['Actual Loops'];
        collectionTouched += (node['Rows Removed by Filter'] ?? 0) * node['Actual Loops'];
        if (node['Relation Name'] === 'delivered_event') expect(node['Node Type']).toContain('Index');
        for (const child of node.Plans ?? []) visitCollection(child);
      }; visitCollection(collectionPlan);
      expect(collectionTouched).toBeLessThanOrEqual(34);
      return { replayTouched: touched, collectionTouched };
    };
    const initialWork = await planWork();
    stressBoundary = sourceCut;
    // A missing immutable object belongs to one target; the seek checkpoint
    // still advances past it and valid targets retain their indexed rows.
    renameSync(manifestPath, `${manifestPath}.held`); hidden = true;
    const backfillInput = { ...input, start: '2066-01-01', end: '2066-01-01' };
    expect(await queries.query(backfillInput)).toMatchObject({ state: 'unavailable', progress: expect.any(Object) });
    resetObserved();
    for (let tick = 0; tick < 6; tick++) {
      await advance();
      expect(observed.maxBatchRows).toBeLessThanOrEqual(EVENT_PROJECTION_COST.sourceKeys);
      // Recreating the worker discards process state at every checkpoint.
      projection = new EventTemporalProjection(access, relay, env);
    }
    const partial = await queries.query(backfillInput);
    expect(partial).toMatchObject({ state: 'partial', progress: expect.any(Object) });
    const retained = (await access.query(`SELECT
      (SELECT count(*)::int FROM access.event_temporal_interval) AS healthy,
      (SELECT attempts FROM access.event_temporal_pending WHERE event=$1 AND time_status='actual') AS attempts,
      relay_sequence::text,processed::text FROM access.event_temporal_checkpoint WHERE singleton`, [broken.event])).rows[0]!;
    expect(retained.healthy).toBeGreaterThan(0);
    expect(retained.attempts).toBeGreaterThan(0);
    expect(BigInt(retained.relay_sequence)).toBeLessThan(BigInt(sourceCut));
    expect(Number(retained.processed)).toBeLessThanOrEqual(6 * EVENT_SOURCE_COST.members);
    const resumedAfter = retained.relay_sequence;
    renameSync(`${manifestPath}.held`, manifestPath); hidden = false;
    await access.query(`UPDATE access.event_temporal_pending SET retry_at=clock_timestamp()-interval '1 second'
      WHERE event=$1 AND time_status='actual'`, [broken.event]);
    sustain = true; stressBoundary = null;
    // Finish the local inventory, then build a populated new window while the
    // older disjoint window still has pending receiver jobs. Every tick also
    // receives more unrelated Main batches than ordinary replay can consume.
    for (let tick = 0; tick < 100; tick++) {
      const covered = (await access.query<{ covered: boolean; pending: boolean }>(`SELECT actual_prefix>=initial_sequence AS covered,
        EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE time_status='actual' LIMIT 1) AS pending
        FROM access.event_temporal_checkpoint WHERE singleton`)).rows[0]!;
      if (covered.covered && !covered.pending) break;
      await advance();
      if (tick === 99) throw new Error('Local Event inventory did not complete');
    }
    expect((await access.query(`SELECT EXISTS(SELECT 1 FROM access.event_temporal_window_update LIMIT 1) AS pending`))
      .rows[0]!.pending).toBe(true);
    const complete = await ready();
    expect(complete.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2051, possible: 2051 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    expect(BigInt((await access.query('SELECT relay_sequence::text FROM access.event_temporal_checkpoint WHERE singleton')).rows[0]!.relay_sequence))
      .toBeGreaterThan(BigInt(resumedAfter));

    const fixed = (await access.query<{ initial_sequence: string; relay_sequence: string; backfill_complete: boolean }>(
      'SELECT initial_sequence::text,relay_sequence::text,backfill_complete FROM access.event_temporal_checkpoint WHERE singleton')).rows[0]!;
    expect(fixed.initial_sequence).toBe(sourceCut);
    expect(fixed.backfill_complete).toBe(false);
    expect(BigInt(fixed.relay_sequence)).toBeLessThan(BigInt((await readEventDependencies(env)).relaySequence));
    expect(traffic).toBeGreaterThanOrEqual(2560);

    const window = (await access.query<{ id: string }>(`SELECT id::text FROM access.event_temporal_window
      WHERE interpretation='civil-date' AND grain='day' AND query_start=$1 AND query_end=$1`, [input.start])).rows;
    expect(window).toHaveLength(1);
    await access.query('ANALYZE access.event_temporal_member');
    // An absent status must seek its own index range instead of walking every
    // actual member before it can establish that the planned page is empty.
    for (const match of ['possible', 'definite'] as const) {
      const explained = (await access.query<{ 'QUERY PLAN': { Plan: QueryPlan }[] }>(`
        EXPLAIN (ANALYZE, FORMAT JSON) SELECT event,time_status,time_revision AS revision,definite
        FROM access.event_temporal_member WHERE window_id=$1 AND time_status='planned'
          ${match === 'definite' ? 'AND definite' : ''}
        ORDER BY event,time_status LIMIT 51`, [window[0]!.id])).rows[0]!['QUERY PLAN'][0]!.Plan;
      expect(explained['Actual Rows']).toBe(0);
      expect(filteredRows(explained)).toBeLessThanOrEqual(51);
    }

    const events: string[] = [];
    let continuation: string | undefined;
    let pages = 0;
    do {
      resetObserved();
      const page = await queries.query({ ...input, ...(continuation ? { continuation } : {}) });
      if (page.state !== 'ready') throw new Error('Ready Event window lost coverage while paging');
      expect(page.items.length).toBeLessThanOrEqual(50);
      // Cached queries hydrate only their page and read dependency fences.
      expect(observed.sourceRows).toBeLessThanOrEqual(page.items.length + 2);
      expect(observed.sourceCalls).toBeLessThanOrEqual(page.items.length + 2);
      expect(observed.bucketRows).toBe(1);
      expect(observed.pageRows).toBeLessThanOrEqual(51);
      events.push(...page.items.map(item => item.event));
      continuation = page.continuation ?? undefined;
      expect(++pages).toBeLessThanOrEqual(42);
    } while (continuation);
    expect(events).toHaveLength(2051);
    expect(new Set(events).size).toBe(2051);
    expect(new Set(events)).toEqual(new Set([target, ...fixtures.map(row => row.event)]));

    sustain = false; stressBoundary = null;
    let firstPage = await queries.query(input);
    if (firstPage.state !== 'ready' || !firstPage.continuation) throw new Error('Missing Event page cursor');
    // Unrelated Events have owner journal members too. Measure the same deep
    // inventory seek before and after growth, including filtered/operator work.
    for (let offset = 0; offset < 1200; offset += 16) {
      await Promise.all(Array.from({ length: Math.min(16, 1200 - offset) }, async () => {
        const event = native(); unrelated.push(event);
        await write(event, '2099-01-01', null, 'planned');
      }));
    }
    await drain();
    const growthWork = await planWork();
    expect(growthWork).toEqual(initialWork);
    console.info('Event inventory work before/after unrelated Event growth', { initialWork, growthWork,
      initialEvents: 2051, addedEvents: unrelated.length });
    const growthCut = (await relay.query<{ sequence: string }>(`SELECT max(sequence)::text AS sequence
      FROM relay.delivered_batch WHERE stream_scope=$1 AND data_epoch=$2`,
    ['urn:rezics:stream:main-rdf', env.lineage.dataEpoch])).rows[0]!.sequence;
    // Actual-only reads may already be ready while planned deltas still await
    // the consumer. Drain that independent work before measuring the next edit.
    for (let tick = 0; tick < 500; tick++) {
      const checkpoint = (await access.query<{ sequence: string; pending: boolean; updates: boolean }>(`
        SELECT relay_sequence::text AS sequence,
          EXISTS(SELECT 1 FROM access.event_temporal_pending LIMIT 1) AS pending,
          EXISTS(SELECT 1 FROM access.event_temporal_window_update LIMIT 1) AS updates
        FROM access.event_temporal_checkpoint WHERE singleton`)).rows[0]!;
      if (checkpoint.sequence === growthCut && !checkpoint.pending && !checkpoint.updates) break;
      await advance();
      if (tick === 499) throw new Error('Unrelated Event journal did not drain');
    }
    await ready();
    resetObserved();
    expect((await queries.query({ ...input, continuation: firstPage.continuation })).state).toBe('ready');
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 2);
    expect(observed.bucketRows).toBe(1);
    expect(observed.pageRows).toBeLessThanOrEqual(51);
    // Settled replay cannot recreate a receipt fence after its journal key is gone.
    expect(await registerEventPublication(access, { receipt: initial.receipt, admission: initial.admissionId,
      digest: initial.requestDigest, authorityEpoch: '0', expiresAt: new Date(Date.now() + 600000).toISOString(),
      event: target, status: 'actual', old: null, next: eventIntentEffect(checkedEventObservation({
        event: target, timeStatus: 'actual', temporalKind: 'instant', start: point(input.start),
        actingSubject: actor, expectedRevisionHead: null,
      })) }, env)).toBe(false);
    expect((await queries.query({ ...input, continuation: firstPage.continuation! })).state).toBe('ready');
    // A crash before dispatch retains a relevant pin. Expiry seals a native
    // cancellation before removing it, rather than deleting it by age.
    const abandoned = randomUUID(), abandonedEvent = native(), abandonedReceipt = eventObservationReceiptIri(abandoned);
    const abandonedDigest = hash(abandoned);
    await registerEventPublication(access, { receipt: abandonedReceipt, admission: abandoned, digest: abandonedDigest,
      authorityEpoch: '0', expiresAt: new Date(Date.now() - 1000).toISOString(), event: abandonedEvent,
      status: 'actual', old: null, next: { civil_start_min: input.start, civil_end_max: input.end,
        instant_start_min: null, instant_end_max: null, instant_supported: false } }, env);
    expect((await queries.query(input)).state).toBe('partial');
    await projection.tick();
    expect((await readEventObservationReceipt(env, abandoned))?.outcome).toBe('cancelled');
    expect((await queries.query({ ...input, continuation: firstPage.continuation! })).state).toBe('ready');
    // More same-status effects than one target budget must remain local, even
    // before relay and again with a real undelivered/unapplied remainder.
    const outside = Array.from({ length: 33 }, () => ({ event: native(), head: '' }));
    unrelated.push(...outside.map(row => row.event));
    for (const row of outside) row.head = (await write(row.event, '2099-04-01', null)).revision!;
    resetObserved();
    expect((await queries.query({ ...input, continuation: firstPage.continuation! })).state).toBe('ready');
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 2);
    await drain(); await projection.tick();
    const outsideWork = (await access.query(`SELECT
      (SELECT count(*)::int FROM access.event_temporal_applied WHERE event=ANY($1::text[]) AND time_status='actual') AS applied,
      (SELECT count(*)::int FROM access.event_temporal_window_update WHERE publication_receipt IS NOT NULL
        AND event=ANY($1::text[])) AS unapplied`, [outside.map(row => row.event)])).rows[0]!;
    expect(outsideWork.applied).toBe(32); expect(outsideWork.unapplied).toBe(1);
    expect((await queries.query({ ...input, continuation: firstPage.continuation! })).state).toBe('ready');
    const measuredWindow = (await access.query<{ id: string; scan_started_at: string }>(
      'SELECT id::text,scan_started_at::text FROM access.event_temporal_window WHERE id=$1', [window[0]!.id])).rows[0]!;
    const scopedFence = eventEffectFence({ ...measuredWindow, interpretation: 'civil-date', grain: 'day',
      bucket_start: input.start, bucket_end: input.end }, 'actual');
    await access.query('ANALYZE access.event_temporal_window_update');
    const fencePlan = (await access.query<{ 'QUERY PLAN': { Plan: QueryPlan }[] }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${scopedFence.text}`, scopedFence.values)).rows[0]!['QUERY PLAN'][0]!.Plan;
    // Count filters and relation work, not merely the returned EXISTS boolean.
    let fenceTouched = 0;
    const visitFence = (node: QueryPlan) => {
      if (node['Relation Name']) fenceTouched += node['Actual Rows'] * node['Actual Loops'];
      fenceTouched += (node['Rows Removed by Filter'] ?? 0) * node['Actual Loops'];
      for (const child of node.Plans ?? []) visitFence(child);
    }; visitFence(fencePlan);
    console.info('Scoped fence work with unapplied same-status backlog', { fenceTouched, outsideWork });
    expect(fenceTouched).toBeLessThanOrEqual(64);
    const moving = outside.at(-1)!;
    moving.head = (await write(moving.event, input.start, moving.head)).revision!;
    const affected = await queries.query({ ...input, continuation: firstPage.continuation! });
    expect(affected.state).toBe('partial'); expect(affected.items).toEqual([]); expect(affected.histogram).toEqual([]);
    await drain();
    expect((await ready()).histogram[0]!.possible).toBe(2052);
    moving.head = (await write(moving.event, '2099-04-01', moving.head)).revision!;
    await drain(); expect((await ready()).histogram[0]!.possible).toBe(2051);
    firstPage = await queries.query(input);
    if (firstPage.state !== 'ready' || !firstPage.continuation) throw new Error('Missing scoped post-edit cursor');
    console.info('Same-status out-of-window backlog remains readable', outsideWork);
    // Start several real window scopes whose first 100 consumed identities
    // lie before the high-key churn targets and contribute zero to these dates.
    const busy = Array.from({ length: 9 }, (_, index) => ({
      event: `${ID}ffffffff-ffff-4fff-8fff-${index.toString(16).padStart(12, '0')}`, head: '', planned: '' }));
    unrelated.push(...busy.map(row => row.event));
    for (const row of busy) row.head = (await write(row.event, '2099-03-01', null)).revision!;
    await drain(); await ready();
    for (let index = 2; index <= 17; index++) await queries.query({ ...input,
      start: '2099-03-01', end: `2099-03-${index.toString().padStart(2, '0')}` });
    const scanPrefix = (await access.query<{ event: string; time_status: 'actual' | 'planned' }>(
      'SELECT event,time_status FROM access.event_temporal_interval ORDER BY event,time_status LIMIT 100')).rows;
    expect(scanPrefix.every(row => row.event < busy[0]!.event)).toBe(true);
    const before = scanPrefix.at(-1)!;
    await access.query(`UPDATE access.event_temporal_window SET state='building',processed=100,
      scan_started_at=clock_timestamp(),after_event=$1,after_status=$2
      WHERE query_start='2099-03-01'`, [before.event, before.time_status]);
    const coldInput = { ...input, start: '2088-01-01', end: '2088-01-01' };
    expect((await queries.query(coldInput)).state).toBe('partial');
    const churnCursor = (await queries.query(input)).continuation!;
    sustain = true;
    let coldReady = false, delayed = false, sameWindowRefused = false;
    for (let iteration = 0; iteration < 12; iteration++) {
      for (const row of busy) row.head = (await write(row.event,
        iteration % 2 ? '2099-03-01' : '2099-03-02', row.head)).revision!;
      busy[0]!.planned = (await write(busy[0]!.event,
        input.start, busy[0]!.planned || null, 'planned')).revision!;
      await advance();
      expect((await queries.query({ ...input, continuation: churnCursor })).state).toBe('ready');
      const currentReceiver = (await access.query<{ id: string; interpretation: 'civil-date'; grain: 'day';
        bucket_start: string; bucket_end: string; scan_started_at: string }>(`SELECT id::text,interpretation,grain,
        bucket_start::text,bucket_end::text,scan_started_at::text FROM access.event_temporal_window WHERE id=$1`,
      [window[0]!.id])).rows[0]!;
      const sameWindowChecker = await access.connect();
      try {
        if (await hasEventEffects(sameWindowChecker, currentReceiver, 'planned')) {
          expect(await hasEventEffects(sameWindowChecker, currentReceiver, 'actual')).toBe(false);
          const affected = await queries.query({ ...input, timeStatus: 'planned' });
          expect(affected.state).toBe('partial'); expect(affected.items).toEqual([]);
          expect(affected.histogram).toEqual([]); sameWindowRefused = true;
        }
      } finally { sameWindowChecker.release(); }
      const cold = await queries.query(coldInput);
      coldReady ||= cold.state === 'ready';
      const windows = (await access.query<{ id: string; interpretation: 'civil-date'; grain: 'day';
        bucket_start: string; bucket_end: string; scan_started_at: string; after_event: string | null }>(`
        SELECT id::text,interpretation,grain,bucket_start::text,bucket_end::text,scan_started_at::text,after_event
        FROM access.event_temporal_window WHERE query_start='2099-03-01'`)).rows;
      const checker = await access.connect();
      try {
        for (const receiver of windows) {
          if (await hasEventEffects(checker, receiver, 'actual')) {
            // The scan cannot consume a new high-key interval and later apply
            // its old/new delta a second time. Disjoint 2088 still progresses.
            expect(receiver.after_event! < busy[0]!.event).toBe(true);
            const affected = await queries.query({ ...input, start: receiver.bucket_start, end: receiver.bucket_end });
            expect(affected.state === 'partial' || affected.state === 'unavailable').toBe(true);
            expect(affected.items).toEqual([]); expect(affected.histogram).toEqual([]);
            delayed = true;
          }
        }
      } finally { checker.release(); }
      const checkpoint = (await access.query<{ sequence: string }>(
        'SELECT relay_sequence::text AS sequence FROM access.event_temporal_checkpoint WHERE singleton')).rows[0]!;
      expect(BigInt(checkpoint.sequence)).toBeLessThan(BigInt((await readEventDependencies(env)).relaySequence));
      if (coldReady && delayed && sameWindowRefused && iteration >= 3) break;
    }
    expect(coldReady).toBe(true); expect(delayed).toBe(true); expect(sameWindowRefused).toBe(true);
    console.info('Event scopes progress under faster Main traffic and disjoint churn', { traffic, coldReady, delayed, sameWindowRefused });
    sustain = false;
    await drain();
    // Finish relevant receiver deltas and verify their old/new counts once.
    const busyResult = await ready({ ...input, start: '2099-03-01', end: '2099-03-17' });
    expect(busyResult.histogram.reduce((sum, bucket) => sum + bucket.possible, 0)).toBe(9);
    // Establish a fully prepared baseline before measuring the isolated edit.
    // Churn acceptance above deliberately exercised concurrent receiver work.
    for (let tick = 0; tick < 1000; tick++) {
      const work = (await access.query<{ pending: boolean }>(`SELECT
        EXISTS(SELECT 1 FROM access.event_temporal_window_update LIMIT 1)
        OR EXISTS(SELECT 1 FROM access.event_temporal_window WHERE state<>'ready' LIMIT 1) AS pending`)).rows[0]!;
      if (!work.pending) break;
      await advance();
      if (tick === 999) throw new Error('Event receiver baseline did not settle');
    }


    const afterGrowthPage = await queries.query(input);
    if (afterGrowthPage.state !== 'ready' || !afterGrowthPage.continuation) throw new Error('Missing post-growth cursor');
    await write(target, '2099-01-01', null, 'planned');
    expect((await queries.query({ ...input, continuation: afterGrowthPage.continuation })).state).toBe('ready');
    await write(target, '2077-06-15', initial.revision!);
    expect((await queries.query({ ...input, continuation: firstPage.continuation })).state).toBe('partial');
    await expect(relayMainOutboxOnce(fuseki, relay, consumer, {
      afterDelivery: async () => { throw new Error('interrupted Event relay acknowledgement'); },
    })).rejects.toThrow('interrupted Event relay acknowledgement');
    await drain();
    resetObserved();
    const corrected = await ready();
    await expect(queries.query({ ...input, continuation: firstPage.continuation })).rejects.toBeInstanceOf(EventQueryRestart);
    expect(corrected.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2050, possible: 2050 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 8);
    expect(observed.bucketRows).toBeLessThanOrEqual(3);
    await advance();
    const retried = await queries.query(input);
    if (retried.state !== 'ready') throw new Error('Event coverage changed after replay');
    expect(retried.histogram).toEqual(corrected.histogram);

    // A withdrawn current revision is a removal from the temporal basis. The
    // owner consumer retries the target independently of its relay ACK.
    const withdrawnRevision = native(), withdrawnAt = new Date().toISOString();
    const withdrawnManifest = prepareComponent(env.objectDirectory, broken.eventTime, {
      event: broken.event, eventTime: broken.eventTime, timeStatus: 'actual', revision: withdrawnRevision,
      timeAvailability: 'withdrawn', timeEvidence: null, recordedAt: withdrawnAt, predecessor: broken.revision,
    }, PROFILE);
    const operation = native(), suffix = hash(operation), receipt = `urn:rezics:receipt:${suffix}`;
    const batch = `urn:rezics:outbox:${suffix}`, ownerEvent = `urn:rezics:event:${suffix}`;
    const validations = await profileValidations(fuseki, 'event-time-v1', [
      { shape: `${PROFILE}/event-shape`, focus: [broken.event], graphs: [GRAPHS.current] },
        { shape: `${PROFILE}/slot-shape`, focus: [broken.eventTime], graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${PROFILE}/revision-shape`, focus: [withdrawnRevision], graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    const withdrawnAdmission = randomUUID();
    const priorSource = (await readEventSource(env, { target: { event: broken.event, status: 'actual' } })).rows[0]!;
    await registerEventPublication(access, { receipt, admission: withdrawnAdmission, digest: hash(receipt),
      expiresAt: new Date(Date.now() + 600000).toISOString(), authorityEpoch: '0',
      event: broken.event, status: 'actual', next: null, old: {
        civil_start_min: priorSource.civilStartMin, civil_end_max: priorSource.civilEndMax,
        instant_start_min: priorSource.instantStartMin, instant_end_max: priorSource.instantEndMax,
        instant_supported: priorSource.instantSupported,
      } }, env);
    const withdrawnCommand = await fuseki.commandWithReceipt({ receipt, digest: hash(receipt), validations, deadlineMs: 10_000,
      update: `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(broken.eventTime)} rv:eventTimeHead ${iri(broken.revision)} .
 } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(broken.eventTime)} rv:eventTimeHead ${iri(withdrawnRevision)} .
 }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(withdrawnRevision)} a rv:EventTimeRevision, rv:RevisionAnchor ;
            rv:component ${iri(broken.eventTime)} ; rv:eventTime ${iri(broken.eventTime)} ;
            rv:timeAvailability rv:Withdrawn ; rv:manifest ${iri(`urn:rezics:sha256:${withdrawnManifest}`)} ;
            rv:recordedAt ${lit(withdrawnAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
            rv:predecessor ${iri(broken.revision)} ; rv:operation ${iri(operation)} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} {
          ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(hash(receipt))} ;
            rv:operation ${iri(operation)} ; rv:outcome rv:Succeeded ; rv:admissionId ${lit(withdrawnAdmission)} ;
            rv:authorityEpoch "0" ; rv:admittedScope ${lit(`event:observe:${broken.event}`)} ;
            rv:event ${iri(broken.event)} ; rv:eventTime ${iri(broken.eventTime)} ; rv:timeStatus rv:ActualTime ;
            rv:observationRevision ${iri(withdrawnRevision)} ; rv:expectedHead ${iri(broken.revision)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} {
          ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
            rv:eventCount 1 ; rv:event ${iri(ownerEvent)} .
          ${iri(ownerEvent)} a rv:EventTimeChangedEvent ; rv:ordinal 0 ; rv:action "event.observation.set" ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ; rv:event ${iri(broken.event)} ;
            rv:eventTime ${iri(broken.eventTime)} . }
      } WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(broken.eventTime)} rv:eventTimeHead ${iri(broken.revision)} .
 }
        BIND(?n+1 AS ?next) }` });
    if (withdrawnCommand.status !== 'committed') throw new Error(`Withdrawal fixture rejected: ${JSON.stringify(withdrawnCommand)}`);
    await drain();
    const enqueueWithdrawn = () => access.query(`INSERT INTO access.event_temporal_pending
      (event,time_status,source_sequence,state,attempts,retry_at)
      VALUES ($1,'actual',0,'queued',0,clock_timestamp()) ON CONFLICT (event,time_status)
      DO UPDATE SET state='queued',retry_at=clock_timestamp()`, [broken.event]);
    await enqueueWithdrawn();
    resetObserved();
    await advance();
    const withdrawn = await ready();
    expect(withdrawn.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2049, possible: 2049 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 8);
    expect(observed.bucketRows).toBeLessThanOrEqual(3);
    expect((await access.query(`SELECT count(*)::int AS n FROM access.event_temporal_interval
      WHERE event=$1 AND time_status='actual'`, [broken.event])).rows[0]!.n).toBe(0);
    await enqueueWithdrawn();
    await advance();
    expect((await ready()).histogram).toEqual(withdrawn.histogram);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    fuseki.query = sourceQuery;
    if (hidden) renameSync(`${manifestPath}.held`, manifestPath);
    // QA owns the disposable graph; remove fixture current subjects so this
    // large population cannot contaminate a later file's source backfill.
    const subjects = [target, eventTimeSlotIri(target, 'actual'), eventTimeSlotIri(target, 'planned'),
      ...fixtures.flatMap(row => [row.event, row.eventTime]), ...unrelated.flatMap(event => [event, eventTimeSlotIri(event, 'actual'), eventTimeSlotIri(event, 'planned')])];
    let cleanupFailure: unknown;
    try {
      for (let offset = 0; offset < subjects.length; offset += 200) {
        await fuseki.update(`DELETE { GRAPH ${iri(GRAPHS.current)} { ?subject ?p ?o } }
          WHERE { VALUES ?subject { ${subjects.slice(offset, offset + 200).map(iri).join(' ')} }
            GRAPH ${iri(GRAPHS.current)} { ?subject ?p ?o } }`);
      }
    } catch (error) { cleanupFailure = error; }
    await Promise.all([access.end(), relay.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
    if (cleanupFailure && !failed) throw cleanupFailure;
    if (cleanupFailure) console.warn('Disposable Event fixture cleanup failed after the test failure', cleanupFailure);
  }
}, 600_000);
