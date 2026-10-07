import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { EVENT_PROJECTION_COST, EventTemporalProjection } from '../../../services/main/src/modules/event/projection.ts';
import { EventQueryRestart, EventTemporalQueries, type EventQueryInput }
  from '../../../services/main/src/modules/event/queries.ts';
import { eventObservationDigest, eventTimeSlotIri, setEventObservation }
  from '../../../services/main/src/modules/event/observation.ts';
import { checkedEventObservation, eventPointRdf, type EventPoint }
  from '../../../services/main/src/modules/event/time.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { DATASET, GRAPHS, ID, RV, iri, lit, prepareComponent, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

const native = () => `${ID}${randomUUID()}`;
const PROFILE = 'https://rezics.com/definition/event-time-v1';
const point = (lexical: string): EventPoint => ({ state: 'known', value: {
  kind: 'temporal', lexical, precision: 'day', calendar: 'gregorian' } });

interface QueryPlan {
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: QueryPlan[];
}
const filteredRows = (plan: QueryPlan): number =>
  (plan['Rows Removed by Filter'] ?? 0) * plan['Actual Loops']
  + (plan.Plans ?? []).reduce((sum, child) => sum + filteredRows(child), 0);

function fixture(env: WorkActivationEnvironment, event: string, lexical: string) {
  const eventTime = eventTimeSlotIri(event, 'actual'), revision = native();
  const start = point(lexical), encoded = eventPointRdf(start, native);
  const recordedAt = '2026-10-01T00:00:00.000Z';
  const state = { event, eventTime, timeStatus: 'actual', temporalKind: 'instant', start,
    timeEvidence: null, startPoint: encoded.iri, startValue: encoded.temporalNode,
    revision, predecessor: null, recordedAt };
  const manifest = prepareComponent(env.objectDirectory, eventTime, state, PROFILE);
  return { event, eventTime, revision, manifest,
    current: `${iri(event)} a rv:Event ; rv:eventTime ${iri(eventTime)} .
      ${iri(eventTime)} a rv:EventTime ; rv:event ${iri(event)} ; rv:timeStatus rv:ActualTime ;
        rv:eventTimeHead ${iri(revision)} .`,
    revisions: `${iri(revision)} a rv:EventTimeRevision, rv:RevisionAnchor ; rv:component ${iri(eventTime)} ;
      rv:eventTime ${iri(eventTime)} ; rv:timeAvailability rv:Available ; rv:temporalKind rv:InstantTime ;
      rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:eventStart ${iri(encoded.iri)} ;
      rv:recordedAt ${lit(recordedAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
      rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
      rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 0 .
      ${iri(encoded.iri)} a rv:EventTimePoint ; rv:pointState rv:KnownPoint ;
        rv:temporalValue ${iri(encoded.temporalNode!)} . ${encoded.temporalTriples.join(' .\n')} .` };
}

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
  const env: WorkActivationEnvironment = { fuseki, objectDirectory: join(directory, 'objects'),
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH } };
  const queries = new EventTemporalQueries(access, env, Buffer.alloc(32, 9));
  let projection = new EventTemporalProjection(access, relay, env);
  const consumer = `event-bounds-${randomUUID()}`;
  const actor = native(), target = native();
  const input: EventQueryInput = { interpretation: 'civil-date', match: 'possible', grain: 'day',
    start: '2077-05-15', end: '2077-05-15', pageSize: 50, timeStatus: 'actual' };
  const observed = { sourceRows: 0, sourceCalls: 0, maxBatchRows: 0, bucketRows: 0, pageRows: 0 };
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
    observed.bucketRows = 0; observed.pageRows = 0;
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
    for (let batch = 0; batch < 1000; batch++) {
      if (!await relayMainOutboxOnce(fuseki, relay, consumer)) return;
    }
    throw new Error('Event fixture relay exceeded its batch bound');
  };
  const ready = async (query = input) => {
    for (let tick = 0; tick < 500; tick++) {
      const result = await queries.query(query);
      if (result.state === 'ready') return result;
      expect(result.state === 'unavailable' || result.state === 'partial').toBe(true);
      expect(result.progress).toBeDefined();
      await projection.tick();
    }
    throw new Error('Event fixture did not become ready within its bounded ticks');
  };
  const fixtures = Array.from({ length: 2050 }, () => fixture(env, native(), input.start))
    .sort((a, b) => a.event.localeCompare(b.event));
  const works = Array.from({ length: 5000 }, native);
  const broken = fixtures[0]!;
  const manifestPath = join(env.objectDirectory, broken.manifest);
  let hidden = false;
  try {
    const initial = await write(target, input.start, null);
    await initializeRelayCheckpoint(relay, consumer, env.lineage.dataEpoch);
    await drain();
    for (let offset = 0; offset < fixtures.length; offset += 100) {
      const batch = fixtures.slice(offset, offset + 100);
      await fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
        GRAPH ${iri(GRAPHS.current)} { ${batch.map(row => row.current).join('\n')} }
        GRAPH ${iri(GRAPHS.revisions)} { ${batch.map(row => row.revisions).join('\n')} } }`);
    }
    // A missing immutable object belongs to one target; the seek checkpoint
    // still advances past it and valid targets retain their indexed rows.
    renameSync(manifestPath, `${manifestPath}.held`); hidden = true;
    expect(await queries.query(input)).toMatchObject({ state: 'unavailable', progress: expect.any(Object) });
    resetObserved();
    for (let tick = 0; tick < 6; tick++) {
      await projection.tick();
      expect(observed.maxBatchRows).toBeLessThanOrEqual(EVENT_PROJECTION_COST.sourceKeys);
      // Recreating the worker discards process state at every checkpoint.
      projection = new EventTemporalProjection(access, relay, env);
    }
    const partial = await queries.query(input);
    expect(partial).toMatchObject({ state: 'partial', progress: expect.any(Object) });
    const retained = (await access.query(`SELECT
      (SELECT count(*)::int FROM access.event_temporal_interval) AS healthy,
      (SELECT attempts FROM access.event_temporal_pending WHERE event=$1 AND time_status='actual') AS attempts,
      backfill_event,processed::text FROM access.event_temporal_checkpoint WHERE singleton`, [broken.event])).rows[0]!;
    expect(retained.healthy).toBeGreaterThan(0);
    expect(retained.attempts).toBeGreaterThan(0);
    expect(retained.backfill_event).toBe([target, ...fixtures.map(row => row.event)].sort()[599]);
    expect(retained.processed).toBe('600');
    renameSync(`${manifestPath}.held`, manifestPath); hidden = false;
    await access.query(`UPDATE access.event_temporal_pending SET retry_at=clock_timestamp()-interval '1 second'
      WHERE event=$1 AND time_status='actual'`, [broken.event]);
    const complete = await ready();
    expect(complete.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2051, possible: 2051 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(EVENT_PROJECTION_COST.sourceKeys);

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

    const firstPage = await queries.query(input);
    if (firstPage.state !== 'ready' || !firstPage.continuation) throw new Error('Missing Event page cursor');
    // A large unrelated population changes neither this basis nor read work.
    for (let offset = 0; offset < works.length; offset += 250) {
      await fuseki.update(`INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
        ${works.slice(offset, offset + 250).map(work => `${iri(work)} a <https://schema.org/CreativeWork> .`).join('\n')}
      } }`);
    }
    resetObserved();
    expect((await queries.query({ ...input, continuation: firstPage.continuation })).state).toBe('ready');
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 2);
    expect(observed.bucketRows).toBe(1);
    expect(observed.pageRows).toBeLessThanOrEqual(51);
    await write(target, '2099-01-01', null, 'planned');
    expect((await queries.query({ ...input, continuation: firstPage.continuation })).state).toBe('ready');
    await write(target, '2077-06-15', initial.revision!);
    await expect(queries.query({ ...input, continuation: firstPage.continuation })).rejects.toBeInstanceOf(EventQueryRestart);
    await expect(relayMainOutboxOnce(fuseki, relay, consumer, {
      afterDelivery: async () => { throw new Error('interrupted Event relay acknowledgement'); },
    })).rejects.toThrow('interrupted Event relay acknowledgement');
    await drain();
    resetObserved();
    const corrected = await ready();
    expect(corrected.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2050, possible: 2050 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 8);
    expect(observed.bucketRows).toBeLessThanOrEqual(3);
    await projection.tick();
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
    const actualCollection = 'urn:rezics:event-collection:actual';
    await fuseki.update(`PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(broken.eventTime)} rv:eventTimeHead ${iri(broken.revision)} .
        ${iri(actualCollection)} rv:eventTimeCollectionHead ?collectionHead . } }
      INSERT {
        GRAPH ${iri(GRAPHS.current)} {
          ${iri(broken.eventTime)} rv:eventTimeHead ${iri(withdrawnRevision)} .
          ${iri(actualCollection)} a rv:EventTimeCollection ; rv:timeStatus rv:ActualTime ;
            rv:eventTimeCollectionHead ${iri(withdrawnRevision)} . }
        GRAPH ${iri(GRAPHS.revisions)} {
          ${iri(withdrawnRevision)} a rv:EventTimeRevision, rv:RevisionAnchor ;
            rv:component ${iri(broken.eventTime)} ; rv:eventTime ${iri(broken.eventTime)} ;
            rv:timeAvailability rv:Withdrawn ; rv:manifest ${iri(`urn:rezics:sha256:${withdrawnManifest}`)} ;
            rv:recordedAt ${lit(withdrawnAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime> ;
            rv:predecessor ${iri(broken.revision)} ; rv:operation ${iri(native())} ;
            rv:modelRevision ${iri(PROFILE)} ; rv:shapeRevision ${iri(PROFILE)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence 0 . } }
      WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(broken.eventTime)} rv:eventTimeHead ${iri(broken.revision)} .
        ${iri(actualCollection)} rv:eventTimeCollectionHead ?collectionHead . } }`);
    const enqueueWithdrawn = () => access.query(`INSERT INTO access.event_temporal_pending
      (event,time_status,source_sequence,state,attempts,retry_at)
      VALUES ($1,'actual',0,'queued',0,clock_timestamp()) ON CONFLICT (event,time_status)
      DO UPDATE SET state='queued',retry_at=clock_timestamp()`, [broken.event]);
    await enqueueWithdrawn();
    resetObserved();
    await projection.tick();
    const withdrawn = await ready();
    expect(withdrawn.histogram.find(bucket => bucket.timeStatus === 'actual'))
      .toMatchObject({ definite: 2049, possible: 2049 });
    expect(observed.maxBatchRows).toBeLessThanOrEqual(2);
    expect(observed.sourceRows).toBeLessThanOrEqual(input.pageSize + 8);
    expect(observed.bucketRows).toBeLessThanOrEqual(3);
    expect((await access.query(`SELECT count(*)::int AS n FROM access.event_temporal_interval
      WHERE event=$1 AND time_status='actual'`, [broken.event])).rows[0]!.n).toBe(0);
    await enqueueWithdrawn();
    await projection.tick();
    expect((await ready()).histogram).toEqual(withdrawn.histogram);
  } finally {
    fuseki.query = sourceQuery;
    if (hidden) renameSync(`${manifestPath}.held`, manifestPath);
    // QA owns the disposable graph; remove fixture current subjects so this
    // large population cannot contaminate a later file's source backfill.
    const subjects = [target, eventTimeSlotIri(target, 'actual'), eventTimeSlotIri(target, 'planned'),
      ...fixtures.flatMap(row => [row.event, row.eventTime]), ...works];
    for (let offset = 0; offset < subjects.length; offset += 200) {
      await fuseki.update(`DELETE { GRAPH ${iri(GRAPHS.current)} { ?subject ?p ?o } }
        WHERE { VALUES ?subject { ${subjects.slice(offset, offset + 200).map(iri).join(' ')} }
          GRAPH ${iri(GRAPHS.current)} { ?subject ?p ?o } }`);
    }
    await Promise.all([access.end(), relay.end()]);
    await databases.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 420_000);
