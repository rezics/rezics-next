import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { migrationVersion, schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { feedReferences } from '../src/modules/feed/source.ts';
import { MAIN_RELAY_STREAM_SCOPE, type RelayHandoffPosition } from '../src/modules/outbox/relay-position.ts';
import { initializeRelayCheckpoint, OutboxIncomplete, relayMainOutboxOnce } from '../src/modules/outbox/relay.ts';
import { repairRetainedBatchGraphCut } from '../src/modules/outbox/repair-graph-cut.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const root = resolve(import.meta.dir, '../../..');
const migrationDirectory = join(root, 'services/main/migrations/relay');
const GRAPH_CUT_MIGRATION = '024_batch_graph_sequence.sql';
const source = 'https://rezics.com/services/main';
let cluster: PostgresCluster | undefined;
let pool: Pool;
let legacy: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  const database = `legacy_feed_cut_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE DATABASE ${database}`);
  legacy = new Pool({ ...cluster.connection, database, max: 2 });
  for (const file of schemaFiles(root, 'relay')) {
    const sql = readFileSync(join(migrationDirectory, file), 'utf8');
    await pool.query(sql);
    if (migrationVersion(file) < migrationVersion(GRAPH_CUT_MIGRATION)) await legacy.query(sql);
  }
}, 60_000);

afterAll(async () => {
  await legacy?.end();
  await pool?.end();
  cluster?.remove();
});

function position(dataEpoch: string, sequence: string): RelayHandoffPosition {
  return { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence };
}

function header(dataEpoch: string, sequence = '1', graphSequence: string | null = '100', eventCount = 1) {
  return { dataEpoch, sequence, graphSequence, eventCount,
    batchId: `urn:rezics:outbox:${randomUUID()}`, routingEpoch: '1' };
}
type Header = ReturnType<typeof header>;

async function putHeader(db: Pool, batch: Header, beforeMigration = false) {
  const values = [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventCount];
  await db.query(`INSERT INTO relay.delivered_batch
      (data_epoch,sequence,batch_id,routing_epoch,event_count${beforeMigration ? '' : ',graph_sequence'})
    VALUES ($1,$2,$3,$4,$5${beforeMigration ? '' : ',$6'})`,
  beforeMigration ? values : [...values, batch.graphSequence]);
}

function envelope(batch: Header, ordinal = 0) {
  return { specversion: '1.0', id: `urn:rezics:event:${randomUUID()}`, source,
    type: 'com.rezics.work.created.v1', datacontenttype: 'application/json',
    data: { batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
      sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.graphSequence },
      relayPosition: position(batch.dataEpoch, batch.sequence) } };
}
type Envelope = ReturnType<typeof envelope>;

async function putEvent(db: Pool, batch: Header, body = envelope(batch)) {
  await db.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [source, body.id, batch.dataEpoch, batch.sequence, JSON.stringify(body)]);
}

function referenceSession(dataEpoch: string) {
  const queries: string[] = [];
  const session = { position: { dataEpoch, sequence: '1000' }, query: async (query: string) => {
    queries.push(query);
    const through = query.match(/FILTER\(\?sequence <= ([0-9]+)\)/)?.[1];
    const after = query.match(/FILTER\(\?sequence > ([0-9]+)/)?.[1];
    if (!through || !after) throw new Error('unexpected reference query');
    return BigInt(after) < 100n && BigInt(through) >= 100n
      ? [{ id: { value: 'https://rezics.com/id/feed-reference' }, sequence: { value: '100' }, kind: { value: 'work' } }]
      : [];
  } } as unknown as WorkReadSession;
  return { session, queries };
}

async function references(dataEpoch: string, through: string, after = '0') {
  const { session } = referenceSession(dataEpoch);
  return feedReferences(session, pool, { after: position(dataEpoch, after), through: position(dataEpoch, through),
    afterId: after === '0' ? '' : '\uffff' });
}

test('a retained zero-event batch advances the Main cut in a different graph sequence domain', async () => {
  const epoch = randomUUID();
  const first = header(epoch);
  const empty = header(epoch, '2', '101', 0);
  await putHeader(pool, first);
  await putEvent(pool, first);
  await putHeader(pool, empty);
  const firstOnly = await references(epoch, '1');
  expect(firstOnly).toEqual([{ id: 'https://rezics.com/id/feed-reference', sequence: '1', kind: 'work' }]);
  expect(await references(epoch, '2')).toEqual(firstOnly);
  expect(await references(epoch, '2', '1')).toEqual([]);
  const { session, queries } = referenceSession(epoch);
  await feedReferences(session, pool, { after: position(epoch, '1'), through: position(epoch, '2'), afterId: '\uffff' });
  expect(queries[0]).toContain('FILTER(?sequence <= 101)');
  expect(queries[0]).toContain('FILTER(?sequence > 100');
});

test('feed cuts refuse absent headers and identify the repair needed for a NULL graph cut', async () => {
  const epoch = randomUUID();
  await expect(references(epoch, '1')).rejects.toThrow('Main feed graph reference cut is unavailable');
  await putHeader(pool, header(epoch, '1', null, 0));
  await expect(references(epoch, '1')).rejects.toThrow('repair with task main:relay');
});

test('feed cuts refuse incomplete retained members and duplicate ordinals', async () => {
  const epoch = randomUUID();
  const batch = header(epoch, '1', '100', 2);
  await putHeader(pool, batch);
  await putEvent(pool, batch);
  await expect(references(epoch, '1')).rejects.toThrow('Main feed graph reference cut is unavailable');
  await putEvent(pool, batch, envelope(batch, 0));
  await expect(references(epoch, '1')).rejects.toThrow('Main feed graph reference cut is unavailable');
});

test('feed cuts refuse every envelope binding that disagrees with its retained header', async () => {
  const corruptions: ((body: Envelope) => void)[] = [
    body => { body.data.sourcePosition.sequence = '101'; },
    body => { body.data.sourcePosition.datasetId = 'another-dataset'; },
    body => { body.data.sourcePosition.dataEpoch = randomUUID(); },
    body => { body.data.batchId = 'urn:rezics:outbox:another'; },
    body => { body.data.routingEpoch = '2'; },
    body => { body.data.relayPosition.sequence = '2'; },
    body => { body.data.relayPosition.dataEpoch = randomUUID(); },
    body => { body.data.relayPosition.streamScope = 'urn:rezics:stream:other'; },
    body => { body.data.ordinal = 1; },
  ];
  for (const corrupt of corruptions) {
    const batch = header(randomUUID());
    await putHeader(pool, batch);
    const body = envelope(batch);
    corrupt(body);
    await putEvent(pool, batch, body);
    await expect(references(batch.dataEpoch, '1')).rejects.toThrow('Main feed graph reference cut is unavailable');
  }
});

/** The graph is an external boundary; the production physical-header reader
 * still validates the exact source position and its members. */
function physicalSource(batch: Header, available = true) {
  const queries: string[] = [];
  const literal = (value: string) => ({ type: 'literal', value });
  const fuseki = { query: async (query: string) => {
    queries.push(query);
    if (query.includes('SELECT ?controlSequence')) return { results: { bindings: [{
      controlSequence: literal(batch.sequence), routing: literal(batch.routingEpoch),
      ...(available ? { batch: literal(batch.batchId), eventCount: literal(String(batch.eventCount)),
        ...(batch.graphSequence === null ? {} : { graphSequence: literal(batch.graphSequence) }) } : {}),
    }] } };
    if (query.includes('SELECT ?event ?ordinal')) return { results: { bindings: [] } };
    throw new Error('unexpected physical source query');
  } } as unknown as FusekiClient;
  return { fuseki, queries };
}

test('retaining the same empty header after a crash is idempotent and a changed graph cut refuses', async () => {
  const batch = header(randomUUID(), '1', '900', 0);
  const consumer = `feed-cut-${randomUUID()}`;
  const { fuseki } = physicalSource(batch);
  await initializeRelayCheckpoint(pool, consumer, batch.dataEpoch);
  const crash = { afterDelivery: async () => { throw new Error('crash after retention'); } };
  await expect(relayMainOutboxOnce(fuseki, pool, consumer, crash)).rejects.toThrow('crash after retention');
  const retained = async () => (await pool.query(`SELECT * FROM relay.delivered_batch
    WHERE data_epoch = $1 AND sequence = 1`, [batch.dataEpoch])).rows;
  const first = await retained();
  expect(first).toHaveLength(1);
  expect(first[0].graph_sequence).toBe('900');
  await expect(relayMainOutboxOnce(fuseki, pool, consumer, crash)).rejects.toThrow('crash after retention');
  expect(await retained()).toEqual(first);
  batch.graphSequence = '901';
  await expect(relayMainOutboxOnce(fuseki, pool, consumer)).rejects.toThrow('different durable header');
  expect(await retained()).toEqual(first);
  batch.graphSequence = null;
  await expect(relayMainOutboxOnce(fuseki, pool, consumer)).rejects.toThrow('outbox graph position is missing');
  expect(await retained()).toEqual(first);
});

test('migration backfills only complete agreeing envelopes and leaves empty or unverifiable headers NULL', async () => {
  const epoch = randomUUID();
  const batches = [header(epoch, '1'), header(epoch, '2', '101', 0), header(epoch, '3', '102', 2),
    header(epoch, '4', '103', 2), header(epoch, '5', '104'), header(epoch, '6', '105', 2),
    header(epoch, '7', '106')];
  for (const batch of batches) await putHeader(legacy, batch, true);
  await putEvent(legacy, batches[0]!);
  await putEvent(legacy, batches[2]!);
  await putEvent(legacy, batches[3]!, envelope(batches[3]!, 0));
  const disagreement = envelope(batches[3]!, 1);
  disagreement.data.sourcePosition.sequence = '999';
  await putEvent(legacy, batches[3]!, disagreement);
  const invalid = envelope(batches[4]!);
  invalid.data.sourcePosition.sequence = '1.5';
  await putEvent(legacy, batches[4]!, invalid);
  await putEvent(legacy, batches[5]!, envelope(batches[5]!, 0));
  await putEvent(legacy, batches[5]!, envelope(batches[5]!, 0));
  const foreign = envelope(batches[6]!);
  foreign.data.sourcePosition.dataEpoch = randomUUID();
  await putEvent(legacy, batches[6]!, foreign);
  await legacy.query(readFileSync(join(migrationDirectory, GRAPH_CUT_MIGRATION), 'utf8'));
  const cuts = (await legacy.query(`SELECT sequence::text, graph_sequence::text FROM relay.delivered_batch
    WHERE data_epoch = $1 ORDER BY sequence`, [epoch])).rows;
  expect(cuts).toEqual(batches.map((batch, index) => ({ sequence: batch.sequence, graph_sequence: index === 0 ? '100' : null })));
  for (const cut of ['0', '-1', '1.5', 'NaN', 'Infinity', '-Infinity']) {
    await expect(legacy.query(`UPDATE relay.delivered_batch SET graph_sequence = $2
      WHERE data_epoch = $1 AND sequence = 2`, [epoch, cut])).rejects.toMatchObject({ code: '23514' });
  }
});

test('repair fills a legacy empty header from the exact retained physical source and is idempotent', async () => {
  const batch = header(randomUUID(), '7', '700', 0);
  await putHeader(pool, { ...batch, graphSequence: null });
  const { fuseki, queries } = physicalSource(batch);
  expect(await repairRetainedBatchGraphCut(fuseki, pool, batch.dataEpoch, batch.sequence)).toBe('700');
  expect(queries[0]).toContain('rv:streamSequence 7');
  expect(await repairRetainedBatchGraphCut(fuseki, pool, batch.dataEpoch, batch.sequence)).toBe('700');
  expect((await pool.query(`SELECT graph_sequence::text FROM relay.delivered_batch
    WHERE data_epoch = $1 AND sequence = 7`, [batch.dataEpoch])).rows[0]?.graph_sequence).toBe('700');
  expect(await references(batch.dataEpoch, '7', '7')).toEqual([]);
  batch.graphSequence = '701';
  await expect(repairRetainedBatchGraphCut(fuseki, pool, batch.dataEpoch, batch.sequence)).rejects.toBeInstanceOf(OutboxIncomplete);
});

test('repair refuses unavailable, incomplete or mismatched source evidence without filling the cut', async () => {
  for (const change of ['missing', 'batch', 'routing', 'count', 'graph'] as const) {
    const retained = header(randomUUID(), '3', '300', 0);
    await putHeader(pool, { ...retained, graphSequence: null });
    const physical = { ...retained };
    if (change === 'batch') physical.batchId = `urn:rezics:outbox:${randomUUID()}`;
    if (change === 'routing') physical.routingEpoch = '2';
    if (change === 'count') physical.eventCount = 1;
    if (change === 'graph') physical.graphSequence = null;
    const { fuseki } = physicalSource(physical, change !== 'missing');
    await expect(repairRetainedBatchGraphCut(fuseki, pool, retained.dataEpoch, retained.sequence)).rejects.toThrow();
    expect((await pool.query(`SELECT graph_sequence FROM relay.delivered_batch
      WHERE data_epoch = $1 AND sequence = 3`, [retained.dataEpoch])).rows[0]?.graph_sequence).toBeNull();
  }
});

test('concurrent repairs serialize the NULL fill and refuse conflicting source cuts', async () => {
  const batch = header(randomUUID(), '4', null, 0);
  await putHeader(pool, batch);
  const sources = ['400', '401'].map(graphSequence => physicalSource({ ...batch, graphSequence }).fuseki);
  const results = await Promise.allSettled(sources.map(fuseki =>
    repairRetainedBatchGraphCut(fuseki, pool, batch.dataEpoch, batch.sequence)));
  const successes = results.filter(result => result.status === 'fulfilled');
  const failures = results.filter(result => result.status === 'rejected');
  expect(successes).toHaveLength(1);
  expect(failures).toHaveLength(1);
  expect(failures[0]!.reason).toBeInstanceOf(OutboxIncomplete);
  expect((await pool.query(`SELECT graph_sequence::text FROM relay.delivered_batch
    WHERE data_epoch = $1 AND sequence = 4`, [batch.dataEpoch])).rows[0]?.graph_sequence).toBe(successes[0]!.value);
});
