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
import { repairRetainedBatchGraphCuts } from '../src/modules/outbox/repair-graph-cut.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const root = resolve(import.meta.dir, '../../..');
const migrationDirectory = join(root, 'services/main/migrations/relay');
const migration = '025_legacy_batch_graph_sequence.sql';
const source = 'https://rezics.com/services/main';
let cluster: PostgresCluster | undefined;
let pool: Pool;
let legacy: Pool;
let mixed: Pool;

beforeAll(async () => {
  cluster = await startPostgresCluster();
  pool = new Pool({ ...cluster.connection, max: 4 });
  const databases = ['legacy', 'mixed'].map(name => `feed_cut_${name}_${randomUUID().replaceAll('-', '')}`);
  for (const database of databases) await pool.query(`CREATE DATABASE ${database}`);
  legacy = new Pool({ ...cluster.connection, database: databases[0], max: 2 });
  mixed = new Pool({ ...cluster.connection, database: databases[1], max: 2 });
  for (const file of schemaFiles(root, 'relay')) {
    const sql = readFileSync(join(migrationDirectory, file), 'utf8');
    await pool.query(sql);
    if (migrationVersion(file) < migrationVersion(migration)) {
      await legacy.query(sql);
      await mixed.query(sql);
    }
  }
}, 60_000);

afterAll(async () => {
  await mixed?.end();
  await legacy?.end();
  await pool?.end();
  cluster?.remove();
});

function position(dataEpoch: string, sequence: string): RelayHandoffPosition {
  return { streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch, sequence };
}

function header(dataEpoch: string, sequence: string, graphSequence: string | null = sequence, eventCount = 1) {
  return { dataEpoch, sequence, graphSequence, eventCount,
    batchId: `urn:rezics:outbox:${randomUUID()}`, routingEpoch: '1' };
}
type Header = ReturnType<typeof header>;

async function putHeader(db: Pool, batch: Header) {
  await db.query(`INSERT INTO relay.delivered_batch
    (data_epoch, sequence, batch_id, routing_epoch, event_count, graph_sequence) VALUES ($1,$2,$3,$4,$5,$6)`,
  [batch.dataEpoch, batch.sequence, batch.batchId, batch.routingEpoch, batch.eventCount, batch.graphSequence]);
}

function envelope(batch: Header, ordinal = 0, explicit = false) {
  const data: { batchId: string; routingEpoch: string; ordinal: number;
    sourcePosition: { datasetId: string; dataEpoch: string; sequence: string };
    relayPosition?: RelayHandoffPosition | null } = {
      batchId: batch.batchId, routingEpoch: batch.routingEpoch, ordinal,
      sourcePosition: { datasetId: 'product', dataEpoch: batch.dataEpoch, sequence: batch.graphSequence ?? batch.sequence },
      ...(explicit ? { relayPosition: position(batch.dataEpoch, batch.sequence) } : {}),
    };
  return { specversion: '1.0', id: `urn:rezics:event:${randomUUID()}`, source,
    type: 'com.rezics.work.created.v1', datacontenttype: 'application/json', data };
}
type Envelope = ReturnType<typeof envelope>;

async function putEvent(db: Pool, batch: Header, body = envelope(batch)) {
  await db.query(`INSERT INTO relay.delivered_event (source,event_id,data_epoch,sequence,envelope)
    VALUES ($1,$2,$3,$4,$5::jsonb)`, [source, body.id, batch.dataEpoch, batch.sequence, JSON.stringify(body)]);
}

async function cuts(db: Pool, epoch: string) {
  return (await db.query<{ sequence: string; graph_sequence: string | null }>(`SELECT sequence::text, graph_sequence::text
    FROM relay.delivered_batch WHERE data_epoch = $1 ORDER BY relay.delivered_batch.sequence`, [epoch])).rows;
}

async function bytes(db: Pool, epoch: string) {
  return (await db.query(`SELECT event_id, envelope::text FROM relay.delivered_event
    WHERE data_epoch = $1 ORDER BY event_id`, [epoch])).rows;
}

function referenceSession(epoch: string, graphSequences: readonly string[], obeyCut = true) {
  const queries: string[] = [];
  const session = { position: { dataEpoch: epoch, sequence: '10000' }, query: async (query: string) => {
    queries.push(query);
    const through = query.match(/FILTER\(\?sequence <= ([0-9]+)\)/)?.[1];
    const after = query.match(/FILTER\(\?sequence > ([0-9]+)/)?.[1];
    if (!through || !after) throw new Error('unexpected reference query');
    return graphSequences.filter(sequence => !obeyCut || BigInt(sequence) > BigInt(after) && BigInt(sequence) <= BigInt(through))
      .map(sequence => ({ id: { value: `https://rezics.com/id/feed-reference-${sequence}` },
        sequence: { value: sequence }, kind: { value: 'work' } }));
  } } as unknown as WorkReadSession;
  return { session, queries };
}

async function references(db: Pool, epoch: string, through: string, sequences: readonly string[], after = '0', obeyCut = true) {
  const { session } = referenceSession(epoch, sequences, obeyCut);
  return feedReferences(session, db, { after: position(epoch, after), through: position(epoch, through),
    afterId: after === '0' ? '' : '\uffff' });
}

test('025 proves only complete legacy bindings and preserves every retained envelope byte', async () => {
  const epoch = randomUUID();
  const batches: Header[] = [];
  const accepted = new Set<string>();
  async function add(eventCount = 1, graphSequence?: string) {
    const sequence = String(batches.length + 1);
    const batch = header(epoch, sequence, graphSequence ?? sequence, eventCount);
    batches.push(batch);
    await putHeader(legacy, { ...batch, graphSequence: null });
    return batch;
  }
  const complete = await add(2);
  await putEvent(legacy, complete, envelope(complete, 0));
  await putEvent(legacy, complete, envelope(complete, 1));
  accepted.add(complete.sequence);
  const partial = await add(2);
  await putEvent(legacy, partial);
  const disagree = await add(2);
  await putEvent(legacy, disagree);
  const disagreement = envelope(disagree, 1);
  disagreement.data.sourcePosition.sequence = '999';
  await putEvent(legacy, disagree, disagreement);
  const duplicate = await add(2);
  await putEvent(legacy, duplicate, envelope(duplicate, 0));
  await putEvent(legacy, duplicate, envelope(duplicate, 0));
  const incompleteOrdinals = await add(2);
  await putEvent(legacy, incompleteOrdinals, envelope(incompleteOrdinals, 0));
  await putEvent(legacy, incompleteOrdinals, envelope(incompleteOrdinals, 2));
  const corruptions: ((body: Envelope) => void)[] = [
    body => { body.data.sourcePosition.datasetId = 'other'; },
    body => { body.data.sourcePosition.dataEpoch = randomUUID(); },
    ...['0', '01', '-1', '1.5', 'NaN', '1'.repeat(101)].map(sequence => (body: Envelope) => {
      body.data.sourcePosition.sequence = sequence;
    }),
    body => { body.data.sourcePosition.sequence = '999'; },
    body => { body.data.batchId = `urn:rezics:outbox:${randomUUID()}`; },
    body => { body.data.routingEpoch = '2'; },
    body => { body.data.relayPosition = position(epoch, '999'); },
    body => { body.data.relayPosition = position(randomUUID(), body.data.sourcePosition.sequence); },
    body => { body.data.relayPosition = { ...position(epoch, body.data.sourcePosition.sequence), streamScope: 'other' }; },
    body => { body.data.relayPosition = null; },
    body => { body.data.ordinal = -1; },
  ];
  for (const corrupt of corruptions) {
    const batch = await add();
    const body = envelope(batch);
    corrupt(body);
    await putEvent(legacy, batch, body);
  }
  const mixedMembers = await add(2);
  await putEvent(legacy, mixedMembers, envelope(mixedMembers, 0));
  await putEvent(legacy, mixedMembers, envelope(mixedMembers, 1, true));
  accepted.add(mixedMembers.sequence);
  const explicit = await add(1, '900');
  await putEvent(legacy, explicit, envelope(explicit, 0, true));
  accepted.add(explicit.sequence);
  const empty = await add(0);
  const sealed = await bytes(legacy, epoch);
  await legacy.query(readFileSync(join(migrationDirectory, migration), 'utf8'));
  expect(await cuts(legacy, epoch)).toEqual(batches.map(batch => ({ sequence: batch.sequence,
    graph_sequence: accepted.has(batch.sequence) ? batch.graphSequence : null })));
  expect(await bytes(legacy, epoch)).toEqual(sealed);
  expect(await references(legacy, epoch, complete.sequence, [complete.sequence])).toEqual([
    { id: `https://rezics.com/id/feed-reference-${complete.sequence}`, sequence: complete.sequence, kind: 'work' },
  ]);
  expect(await references(legacy, epoch, mixedMembers.sequence, [complete.sequence, mixedMembers.sequence])).toEqual([
    { id: `https://rezics.com/id/feed-reference-${complete.sequence}`, sequence: complete.sequence, kind: 'work' },
    { id: `https://rezics.com/id/feed-reference-${mixedMembers.sequence}`, sequence: mixedMembers.sequence, kind: 'work' },
  ]);
  await expect(references(legacy, epoch, empty.sequence, [])).rejects.toThrow('--repair-graph-cuts');
});

/** Stub only the external graph. Production readNextMainOutboxBatch still
 * checks the exact requested stream position and the source header identity. */
function physicalSource(batches: readonly Header[], missing: ReadonlySet<string> = new Set()) {
  const queries: string[] = [];
  const bySequence = new Map(batches.map(batch => [batch.sequence, batch]));
  const literal = (value: string) => ({ type: 'literal', value });
  const highWater = batches.reduce((high, batch) => BigInt(batch.sequence) > high ? BigInt(batch.sequence) : high, 0n).toString();
  const fuseki = { query: async (query: string) => {
    queries.push(query);
    if (query.includes('SELECT ?controlSequence')) {
      const sequence = query.match(/rv:streamSequence ([0-9]+)\s*\./)?.[1];
      const batch = sequence ? bySequence.get(sequence) : undefined;
      if (!batch) throw new Error('unexpected physical source position');
      return { results: { bindings: [{ controlSequence: literal(highWater), routing: literal(batch.routingEpoch),
        ...(missing.has(batch.sequence) ? {} : { batch: literal(batch.batchId), eventCount: literal(String(batch.eventCount)),
          ...(batch.graphSequence === null ? {} : { graphSequence: literal(batch.graphSequence) }) }),
      }] } };
    }
    if (query.includes('SELECT ?event ?ordinal')) return { results: { bindings: [] } };
    throw new Error('unexpected physical source query');
  } } as unknown as FusekiClient;
  return { fuseki, queries };
}

test('bulk repair resumes across pages, lists missing evidence, and leaves only its refusals unresolved', async () => {
  const epoch = randomUUID();
  const retained = header(epoch, '1');
  const batches = [header(epoch, '2', '100', 0), header(epoch, '9', '101', 0),
    header(epoch, '10', '102', 0), header(epoch, '11', '103', 0), header(epoch, '12', '104', 0)];
  await putHeader(mixed, { ...retained, graphSequence: null });
  await putEvent(mixed, retained);
  for (const batch of batches) await putHeader(mixed, { ...batch, graphSequence: null });
  const sealed = await bytes(mixed, epoch);
  await mixed.query(readFileSync(join(migrationDirectory, migration), 'utf8'));
  const { fuseki, queries } = physicalSource(batches, new Set(['9']));
  const first = await repairRetainedBatchGraphCuts(fuseki, mixed, epoch, '0', 3);
  expect(first.repaired).toBe(2);
  expect(first.refused).toHaveLength(1);
  expect(first.refused[0]?.sequence).toBe('9');
  expect(first.refused[0]?.reason).toContain('missing');
  expect(first.next).toBe('10');
  const second = await repairRetainedBatchGraphCuts(fuseki, mixed, epoch, first.next!, 3);
  expect(second).toEqual({ repaired: 2, refused: [], next: null });
  expect(queries.filter(query => query.includes('SELECT ?controlSequence')).map(query =>
    query.match(/rv:streamSequence ([0-9]+)\s*\./)?.[1])).toEqual(['2', '9', '10', '11', '12']);
  expect(await cuts(mixed, epoch)).toEqual([{ sequence: '1', graph_sequence: '1' },
    ...batches.map(batch => ({ sequence: batch.sequence, graph_sequence: batch.sequence === '9' ? null : batch.graphSequence }))]);
  const again = await repairRetainedBatchGraphCuts(fuseki, mixed, epoch);
  expect(again).toEqual({ repaired: 0, refused: first.refused, next: null });
  expect(await bytes(mixed, epoch)).toEqual(sealed);
  for (const batch of [retained, ...batches.filter(batch => batch.sequence !== '9')]) {
    expect(await references(mixed, epoch, batch.sequence, [], batch.sequence)).toEqual([]);
  }
  expect(await references(mixed, epoch, '12', ['1', '100', '102', '103', '104'])).toEqual([
    { id: 'https://rezics.com/id/feed-reference-1', sequence: '1', kind: 'work' },
    { id: 'https://rezics.com/id/feed-reference-100', sequence: '2', kind: 'work' },
    { id: 'https://rezics.com/id/feed-reference-102', sequence: '10', kind: 'work' },
    { id: 'https://rezics.com/id/feed-reference-103', sequence: '11', kind: 'work' },
    { id: 'https://rezics.com/id/feed-reference-104', sequence: '12', kind: 'work' },
  ]);
  await expect(references(mixed, epoch, '9', [])).rejects.toThrow('--repair-graph-cut');
});

test('reverse mapping refuses missing or NULL headers with the named repair', async () => {
  for (const nullHeader of [false, true]) {
    const epoch = randomUUID();
    await putHeader(pool, header(epoch, '3', '300', 0));
    if (nullHeader) await putHeader(pool, header(epoch, '2', null, 0));
    await expect(references(pool, epoch, '3', ['200'])).rejects.toThrow('--repair-graph-cuts');
    await expect(references(pool, epoch, '3', ['200'])).rejects.toThrow('--repair-graph-cut');
  }
});

test('reverse mapping refuses two matching headers even when one is beyond through', async () => {
  const epoch = randomUUID();
  await putHeader(pool, header(epoch, '1', '100', 0));
  await putHeader(pool, header(epoch, '2', '200', 0));
  await putHeader(pool, header(epoch, '3', '100', 0));
  await expect(references(pool, epoch, '2', ['100'])).rejects.toThrow('Ambiguous feed reference relay position');
});

test('reverse mapping refuses a matching header beyond the requested Main cut', async () => {
  const epoch = randomUUID();
  await putHeader(pool, header(epoch, '2', '200', 0));
  await putHeader(pool, header(epoch, '3', '100', 0));
  await expect(references(pool, epoch, '2', ['100'])).rejects.toThrow('Feed reference relay position is unavailable');
});

test('bulk repair accepts the default and maximum page bounds and rejects invalid arguments before reading', async () => {
  const epoch = randomUUID();
  const { fuseki, queries } = physicalSource([]);
  expect(await repairRetainedBatchGraphCuts(fuseki, pool, epoch)).toEqual({ repaired: 0, refused: [], next: null });
  expect(await repairRetainedBatchGraphCuts(fuseki, pool, epoch, '0', 1000)).toEqual({ repaired: 0, refused: [], next: null });
  for (const limit of [0, -1, 1001, 1.5, NaN, Infinity]) {
    await expect(repairRetainedBatchGraphCuts(fuseki, pool, epoch, '0', limit)).rejects.toThrow('invalid retained batch repair page');
  }
  for (const after of ['', '-1', '01', '1.5', '1'.repeat(101)]) {
    await expect(repairRetainedBatchGraphCuts(fuseki, pool, epoch, after)).rejects.toThrow('invalid retained batch repair page');
  }
  await expect(repairRetainedBatchGraphCuts(fuseki, pool, '')).rejects.toThrow('invalid retained batch repair page');
  expect(queries).toEqual([]);
});

test('bulk relay entry prints one repair JSON object and a repeat repairs nothing', async () => {
  const batch = header(randomUUID(), '10', '100', 0);
  await putHeader(pool, { ...batch, graphSequence: null });
  const { fuseki } = physicalSource([batch]);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request =>
    Response.json(await fuseki.query(await request.text())) });
  const databaseUrl = `postgres://${cluster!.user}@127.0.0.1:${cluster!.port}/postgres`;
  try {
    async function run() {
      const child = Bun.spawn([process.execPath, 'services/main/src/relay.ts', '--repair-graph-cuts',
        '--data-epoch', batch.dataEpoch, '--limit', '1'], { cwd: root,
        env: { ...process.env, FUSEKI_URL: server.url.toString(), FUSEKI_MAINTENANCE_TOKEN: 'a'.repeat(64),
          FUSEKI_COMMAND_TOKEN: 'a'.repeat(64), FUSEKI_TITLE_ADMISSION_KEY: 'a'.repeat(64), MAIN_S3_ENDPOINT: server.url.toString(),
          MAIN_S3_BUCKET: 'semantic', MAIN_S3_REGION: 'us-east-1', MAIN_S3_ACCESS_KEY: 'test', MAIN_S3_SECRET_KEY: 'test',
          MAIN_RELAY_DATABASE_URL: databaseUrl, ACCESS_DATABASE_URL: databaseUrl,
          MAIN_RELAY_CONSUMER: 'graph-cut-repair', OTEL_SDK_DISABLED: 'true' },
        stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' });
      expect(stdout.trim().split('\n')).toHaveLength(1);
      return JSON.parse(stdout);
    }
    expect(await run()).toEqual({ repaired: 1, refused: [], next: null });
    expect(await run()).toEqual({ repaired: 0, refused: [], next: null });
  } finally { await server.stop(true); }
});
