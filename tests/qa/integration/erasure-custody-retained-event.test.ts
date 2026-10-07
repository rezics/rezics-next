import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { readRetainedNativeGraphSuppressionProof } from '../../../services/main/src/modules/erasure/custody.ts';
import { graphErasureReceipt, GraphErasureUnavailable, readGraphErasureProof, suppressGraphContentRevisions,
  type GraphSuppressionProof } from '../../../services/main/src/modules/erasure/graph.ts';
import { journalErasure, markErasureSuppressed } from '../../../services/main/src/modules/erasure/journal.ts';
import { initializeRelayCheckpoint, relayMainOutboxOnce } from '../../../services/main/src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../../../services/main/src/modules/outbox/relay-position.ts';
import { hash, initializeFreshGraph } from '../../../services/main/src/modules/work/activate.ts';
import { fusekiSecrets, pinnedImage, qaStack, standaloneFuseki } from '../fault-recovery/search-ops-support.ts';
import { cloneQaOwnerDatabases } from '../support/fake-delivery.ts';

let databases: Awaited<ReturnType<typeof cloneQaOwnerDatabases>>;
let graph: Awaited<ReturnType<typeof standaloneFuseki>>;
let qa: ReturnType<typeof qaStack>, relay: Pool, writer: Pool;
let erasureId: string, epoch: string, revisions: string[], eventId: string;
let original: GraphSuppressionProof, evidenceDigest: string;
const source = 'https://rezics.com/services/main';
const volume = `rezics-retained-erasure-${randomUUID()}`;
const eventWhere = 'stream_scope = $1 AND source = $2 AND event_id = $3';
const batchWhere = 'stream_scope = $1 AND data_epoch = $2 AND sequence = 4';
let dataEpoch: string;

beforeAll(async () => {
  const started = Date.now(), runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  qa = qaStack(runId);
  databases = await cloneQaOwnerDatabases(runId, ['relay']);
  const pool = () => new Pool({ connectionString: databases.urls.relay, max: 1, connectionTimeoutMillis: 1500 });
  relay = pool(); writer = pool();
  graph = await standaloneFuseki(qa.dockerEnv, { name: volume, volume,
    image: pinnedImage(), secrets: fusekiSecrets(qa.composeEnv) });
  const fuseki = new FusekiClient(graph.url, qa.composeEnv.FUSEKI_MAINTENANCE_TOKEN, qa.composeEnv.FUSEKI_COMMAND_TOKEN);
  dataEpoch = randomUUID();
  const lineage = { dataEpoch, routingEpoch: '7' }, consumer = `retained-erasure:${randomUUID()}`;
  await initializeFreshGraph(fuseki, lineage);
  await initializeRelayCheckpoint(relay, consumer, dataEpoch);
  for (let position = 1; position <= 4; position++) {
    if (position === 4) {
      // Only the disposable stopped copy's diagnostic counter is seeded. The
      // real fourth native command produces both terminal and relay envelopes.
      graph.runner.stop();
      graph.runner.offline(`exec 9>>/fuseki/databases/rezics/owner.lock
flock -n 9
cat > /tmp/retained-erasure-position.ru <<'RETAINED_ERASURE_POSITION'
PREFIX rv: <https://rezics.com/vocab/>
DELETE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?before } }
INSERT { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence 899 } }
WHERE { GRAPH <urn:rezics:graph:control> { <urn:rezics:dataset:product> rv:sequence ?before } }
RETAINED_ERASURE_POSITION
java -Xmx512m -cp /opt/apache-jena-fuseki-6.2.0/fuseki-server.jar \\
  tdb2.tdbupdate --loc=/fuseki/databases/rezics/tdb2 --update=/tmp/retained-erasure-position.ru`);
      await graph.runner.start();
    }
    const targets = Array.from({ length: position === 4 ? 2 : 1 }, () => randomUUID());
    const entry = await journalErasure(relay, { operationId: randomUUID(), requestDigest: hash(randomUUID()),
      kind: 'revision', principalId: randomUUID(), admissionId: randomUUID(), authorityEpoch: '0',
      targets: targets.map(id => ({ kind: 'content_revision', ref: id })) });
    await suppressGraphContentRevisions(fuseki, lineage, entry.erasureId, entry.erasureEpoch, targets);
    await markErasureSuppressed(relay, entry.erasureId);
    const batch = await relayMainOutboxOnce(fuseki, relay, consumer);
    expect(batch?.sequence).toBe(String(position));
    if (position === 4) {
      erasureId = entry.erasureId; epoch = entry.erasureEpoch; revisions = targets;
      eventId = batch!.eventIds[0]!;
      expect(batch!.graphSequence).toBe('900');
      original = await readGraphErasureProof(fuseki, lineage, erasureId, epoch, revisions);
    }
  }
  expect(await relayMainOutboxOnce(fuseki, relay, consumer)).toBeNull();
  expect(original).toEqual({ receipt: graphErasureReceipt(erasureId), dataEpoch, sequence: '900' });
  await borrowed(async client => { evidenceDigest = (await read(client)).evidenceDigest; });
  // The independently retained original is usable while the native source is offline.
  graph.runner.stop();
  expect(Date.now() - started).toBeLessThan(600_000);
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([relay?.end(), writer?.end()]);
  if (qa) {
    spawnSync('docker', ['rm', '-f', volume], { env: qa.dockerEnv, timeout: 60_000 });
    spawnSync('docker', ['volume', 'rm', '-f', volume], { env: qa.dockerEnv, timeout: 60_000 });
  }
  await databases?.close();
}, 120_000);

function read(client: PoolClient) {
  return readRetainedNativeGraphSuppressionProof(client, erasureId, epoch, revisions);
}

async function identity(client: PoolClient) {
  return (await client.query<{ transaction: string }>('SELECT txid_current()::text AS transaction')).rows[0]!.transaction;
}

async function borrowed<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await relay.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout = '11s'");
    await client.query("SET LOCAL statement_timeout = '13s'");
    return await work(client);
  } finally { await client.query('ROLLBACK'); client.release(); }
}

test('the actual native retained event proves diagnostic graph900 independently of Main stream4 with its source offline', async () => {
  await borrowed(async client => {
    const transaction = await identity(client);
    expect(await read(client)).toEqual({ original, evidenceDigest });
    expect(await readRetainedNativeGraphSuppressionProof(client, erasureId, epoch, [...revisions].reverse()))
      .toEqual({ original, evidenceDigest });
    const row = (await client.query(`SELECT sequence::text AS sequence,
      envelope->'data'->'sourcePosition'->>'sequence' AS graph_sequence,
      envelope->'data'->'relayPosition'->>'sequence' AS main_sequence
      FROM relay.delivered_event WHERE ${eventWhere}`, [MAIN_RELAY_STREAM_SCOPE, source, eventId])).rows[0];
    expect(row).toEqual({ sequence: '4', graph_sequence: '900', main_sequence: '4' });
    expect(await identity(client)).toBe(transaction);
    expect((await client.query('SHOW lock_timeout')).rows[0].lock_timeout).toBe('11s');
    expect((await client.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('13s');
    expect(relay.totalCount).toBe(1);
  });
});

interface Corruption { name: string; sql: string; values: () => unknown[] }

function envelopeCorruption(name: string, path: string[], value: unknown): Corruption {
  return { name, sql: `UPDATE relay.delivered_event SET envelope = jsonb_set(envelope, $4::text[], $5::jsonb, true)
    WHERE ${eventWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, source, eventId, path, JSON.stringify(value)] };
}

const corruptions: Corruption[] = [
  { name: 'missing original event', sql: `UPDATE relay.delivered_event SET event_id = event_id || ':missing'
      WHERE ${eventWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, source, eventId] },
  { name: 'missing original batch header', sql: `UPDATE relay.delivered_batch SET data_epoch = $3
      WHERE ${batchWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, dataEpoch, randomUUID()] },
  { name: 'header batch identity', sql: `UPDATE relay.delivered_batch SET batch_id = batch_id || ':different'
      WHERE ${batchWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, dataEpoch] },
  { name: 'header routing epoch', sql: `UPDATE relay.delivered_batch SET routing_epoch = '8'
      WHERE ${batchWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, dataEpoch] },
  { name: 'header event count', sql: `UPDATE relay.delivered_batch SET event_count = 2
      WHERE ${batchWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, dataEpoch] },
  { name: 'header stream scope', sql: `UPDATE relay.delivered_batch SET stream_scope = 'urn:rezics:stream:other'
      WHERE ${batchWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, dataEpoch] },
  envelopeCorruption('event identity', ['id'], 'urn:rezics:event:different'),
  envelopeCorruption('event source', ['source'], 'https://rezics.com/services/other'),
  envelopeCorruption('event type', ['type'], 'com.rezics.erasure.other.v1'),
  envelopeCorruption('request digest', ['data', 'receipt', 'requestDigest'], '0'.repeat(64)),
  envelopeCorruption('original receipt identity', ['data', 'receipt', 'id'], 'urn:rezics:receipt:different'),
  envelopeCorruption('terminal outcome', ['data', 'receipt', 'outcome'], 'cancelled'),
  envelopeCorruption('terminal action', ['data', 'receipt', 'action'], 'work.edit'),
  envelopeCorruption('system proof kind', ['data', 'receipt', 'systemProof', 'kind'], 'other'),
  envelopeCorruption('system proof erasure', ['data', 'receipt', 'systemProof', 'erasureId'], randomUUID()),
  envelopeCorruption('system proof epoch', ['data', 'receipt', 'systemProof', 'erasureEpoch'], '999'),
  envelopeCorruption('diagnostic dataset', ['data', 'sourcePosition', 'datasetId'], 'other'),
  envelopeCorruption('diagnostic epoch', ['data', 'sourcePosition', 'dataEpoch'], randomUUID()),
  envelopeCorruption('diagnostic zero sequence', ['data', 'sourcePosition', 'sequence'], '0'),
  envelopeCorruption('diagnostic noninteger sequence', ['data', 'sourcePosition', 'sequence'], '900.5'),
  envelopeCorruption('Main stream scope', ['data', 'relayPosition', 'streamScope'], 'urn:rezics:stream:other'),
  envelopeCorruption('Main position replaced by diagnostic sequence', ['data', 'relayPosition', 'sequence'], '900'),
  envelopeCorruption('Main epoch', ['data', 'relayPosition', 'dataEpoch'], randomUUID()),
  envelopeCorruption('event batch identity', ['data', 'batchId'], 'urn:rezics:outbox:different'),
  envelopeCorruption('event ordinal', ['data', 'ordinal'], 1),
  envelopeCorruption('extra event field', ['extra'], true),
  envelopeCorruption('extra event data field', ['data', 'extra'], true),
  envelopeCorruption('extra diagnostic field', ['data', 'sourcePosition', 'extra'], true),
  envelopeCorruption('extra Main position field', ['data', 'relayPosition', 'extra'], true),
  envelopeCorruption('fabricated Access receipt field', ['data', 'receipt', 'admissionId'], randomUUID()),
  envelopeCorruption('extra system proof field', ['data', 'receipt', 'systemProof', 'extra'], true),
  envelopeCorruption('oversized retained envelope', ['type'], 'x'.repeat(16_384)),
  { name: 'missing terminal field', sql: `UPDATE relay.delivered_event SET envelope = envelope #- '{data,receipt,outcome}'
      WHERE ${eventWhere}`, values: () => [MAIN_RELAY_STREAM_SCOPE, source, eventId] },
];

for (const corruption of corruptions) {
  test(`retained native proof denies ${corruption.name} and caller savepoint restores exact original`, async () => {
    await borrowed(async client => {
      const transaction = await identity(client);
      await client.query('SAVEPOINT original_source');
      expect((await client.query(corruption.sql, corruption.values())).rowCount).toBe(1);
      await expect(read(client)).rejects.toBeInstanceOf(GraphErasureUnavailable);
      expect(await identity(client)).toBe(transaction);
      await client.query('ROLLBACK TO SAVEPOINT original_source');
      expect(await read(client)).toEqual({ original, evidenceDigest });
    });
  });
}

test('a contradictory retained sibling event cannot fit the native one-event batch header', async () => {
  await borrowed(async client => {
    await client.query('SAVEPOINT original_source');
    expect((await client.query(`INSERT INTO relay.delivered_event
      (stream_scope, source, event_id, data_epoch, sequence, envelope)
      SELECT stream_scope, source || '/contradiction', event_id || ':contradiction', data_epoch, sequence, envelope
      FROM relay.delivered_event WHERE ${eventWhere}`, [MAIN_RELAY_STREAM_SCOPE, source, eventId])).rowCount).toBe(1);
    await expect(read(client)).rejects.toBeInstanceOf(GraphErasureUnavailable);
    await client.query('ROLLBACK TO SAVEPOINT original_source');
    expect(await read(client)).toEqual({ original, evidenceDigest });
  });
});

test('valid matched routing/header changes alter retained evidence while preserving the actual original graph proof', async () => {
  await borrowed(async client => {
    await client.query('SAVEPOINT original_source');
    await client.query(`UPDATE relay.delivered_batch SET routing_epoch = '8' WHERE ${batchWhere}`,
      [MAIN_RELAY_STREAM_SCOPE, dataEpoch]);
    await client.query(`UPDATE relay.delivered_event
      SET envelope = jsonb_set(envelope, '{data,routingEpoch}', '"8"'::jsonb) WHERE ${eventWhere}`,
    [MAIN_RELAY_STREAM_SCOPE, source, eventId]);
    const changed = await read(client);
    expect(changed.original).toEqual(original);
    expect(changed.evidenceDigest).not.toBe(evidenceDigest);
    await client.query('ROLLBACK TO SAVEPOINT original_source');
    expect(await read(client)).toEqual({ original, evidenceDigest });
  });
});

for (const table of ['event', 'batch'] as const) {
  test(`retained ${table} SHARE lock lasts until caller savepoint rollback and blocks independent row mutation`, async () => {
    await borrowed(async client => {
      const transaction = await identity(client), writerClient = await writer.connect();
      const sql = table === 'event'
        ? `UPDATE relay.delivered_event SET envelope = envelope WHERE ${eventWhere}`
        : `UPDATE relay.delivered_batch SET routing_epoch = routing_epoch WHERE ${batchWhere}`;
      const values = table === 'event' ? [MAIN_RELAY_STREAM_SCOPE, source, eventId] : [MAIN_RELAY_STREAM_SCOPE, dataEpoch];
      try {
        await client.query('SAVEPOINT source_read');
        expect(await read(client)).toEqual({ original, evidenceDigest });
        await writerClient.query('BEGIN');
        await writerClient.query("SET LOCAL lock_timeout = '200ms'");
        await expect(writerClient.query(sql, values)).rejects.toMatchObject({ code: '55P03' });
        await writerClient.query('ROLLBACK');
        await client.query('ROLLBACK TO SAVEPOINT source_read');
        expect(await identity(client)).toBe(transaction);
        await writerClient.query('BEGIN');
        await writerClient.query("SET LOCAL lock_timeout = '200ms'");
        expect((await writerClient.query(sql, values)).rowCount).toBe(1);
        await writerClient.query('ROLLBACK');
        expect(await read(client)).toEqual({ original, evidenceDigest });
      } finally { await writerClient.query('ROLLBACK'); writerClient.release(); }
    });
  }, 10_000);
}

test('invalid retained proof bounds fail closed inside the caller transaction', async () => {
  await borrowed(async client => {
    const transaction = await identity(client);
    const invalid = [
      { erasure: 'not-an-erasure', epoch, revisions },
      { erasure: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', epoch, revisions },
      ...['0', '01', '-1', '1.5', '9'.repeat(20)].map(value => ({ erasure: erasureId, epoch: value, revisions })),
      { erasure: erasureId, epoch, revisions: [] },
      { erasure: erasureId, epoch, revisions: [revisions[0]!, revisions[0]!] },
      { erasure: erasureId, epoch, revisions: Array.from({ length: 65 }, () => randomUUID()) },
      { erasure: erasureId, epoch, revisions: [`urn:rezics:content:revision:${revisions[0]}`] },
    ];
    for (const value of invalid) {
      await expect(readRetainedNativeGraphSuppressionProof(client, value.erasure, value.epoch, value.revisions))
        .rejects.toBeInstanceOf(GraphErasureUnavailable);
    }
    await expect(readRetainedNativeGraphSuppressionProof(client, erasureId, epoch, [randomUUID()]))
      .rejects.toBeInstanceOf(GraphErasureUnavailable);
    expect(await identity(client)).toBe(transaction);
    expect(await read(client)).toEqual({ original, evidenceDigest });
  });
});
