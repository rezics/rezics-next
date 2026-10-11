import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool, type PoolClient } from 'pg';
import type { ExactReadResult } from '../../content/src/core.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { clearVerifiedImmutableObjectCache, ObjectIntegrityError, ObjectUnavailable,
  S3ImmutableObjects, type ImmutableObjects } from
  '../src/infrastructure/immutable-objects.ts';
import { restoredCustodyDigests, type RestoredGraphCustody } from '../src/modules/erasure/custody.ts';
import { discloseContent } from '../src/modules/disclosure/assembly.ts';
import { configureDisclosure, type DisclosureReader } from '../src/modules/disclosure/read.ts';
import { graphErasedContentRevisions, GraphErasureConflict, GraphErasureUnavailable } from
  '../src/modules/erasure/graph.ts';
import { ObjectErasureConflict, replayObjectErasure } from '../src/modules/erasure/replay-objects.ts';
import type { ErasedHistoricalReceiptSource, HistoricalReceiptSource } from '../src/modules/outbox/receipt-custody.ts';
import type { CustodiedOutbox } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { custodyModelGenerationArtifacts } from '../src/modules/semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../src/modules/semantic/schema.ts';
import { GRAPHS, hash, prepareWorkComponent } from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound } from '../src/modules/work/history.ts';

const directories: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
beforeEach(() => clearVerifiedImmutableObjectCache());
afterEach(async () => {
  clearVerifiedImmutableObjectCache();
  await Promise.all(servers.splice(0).map(server => server.stop(true)));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class MemoryObjects implements ImmutableObjects {
  readonly data = new Map<string, Uint8Array>();
  async put(bytes: Uint8Array): Promise<string> {
    const digest = hash(bytes);
    this.data.set(digest, new Uint8Array(bytes));
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    const bytes = this.data.get(digest);
    if (!bytes) throw new ObjectUnavailable('exact custody object is missing');
    if (hash(bytes) !== digest) throw new ObjectIntegrityError('exact custody object is corrupt');
    return new Uint8Array(bytes);
  }
}

function cachedObjectStore() {
  const bucket = 'custody-test';
  const prefix = 'work/custody/';
  const data = new Map<string, Uint8Array>();
  const counts = { gets: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`/${bucket}/`)) return new Response(null, { status: 404 });
    const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
    if (request.method === 'PUT') {
      data.set(key, new Uint8Array(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (request.method === 'GET') {
      counts.gets++;
      const bytes = data.get(key);
      return bytes ? new Response(Buffer.from(bytes), { status: 200,
        headers: { 'content-length': String(bytes.byteLength) } }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 405 });
  } });
  servers.push(server);
  const store = new S3ImmutableObjects({ endpoint: `http://127.0.0.1:${server.port}`, bucket,
    accessKeyId: 'custody-test-key', secretAccessKey: 'custody-test-secret', prefix });
  const keyOf = (digest: string) => `${prefix}sha256/${digest}`;
  return { store, counts,
    replace(digest: string, bytes: Uint8Array) { data.set(keyOf(digest), new Uint8Array(bytes)); },
    remove(digest: string) { data.delete(keyOf(digest)); } };
}

/** Models graph metadata only; C6 verifies the actual manifest, state and shape bytes. */
class CustodyGraph extends FusekiClient {
  readonly queries: string[] = [];
  readonly generations = new Map<string, { manifest: string; commandModule: string }>();
  readonly currentHeads = new Set<string>();
  readonly semanticPins = new Map<string, string[]>();
  unavailableInventory: 'models' | 'revisions' | null = null;
  constructor() { super('http://custody.invalid'); }
  override async query(query: string): Promise<SparqlResult> {
    this.queries.push(query);
    const uri = (value: string) => ({ type: 'uri', value });
    if (query.includes('SELECT ?graph ?subject ?manifest')) {
      return { results: { bindings: [...this.generations].map(([generation, anchor]) => ({
        graph: uri(GRAPHS.revisions), subject: uri(generation), manifest: uri(anchor.manifest),
      })) } };
    }
    if (query.includes('SELECT ?graph ?subject ?value')) {
      const value = query.includes('rv:component') ? MODEL_COMPONENT : PROFILES.generation;
      return { results: { bindings: [...this.generations.keys()].map(generation => ({
        graph: uri(GRAPHS.revisions), subject: uri(generation), value: uri(value),
      })) } };
    }
    if (query.includes('SELECT ?revision (COUNT(?generation)')) {
      if (this.unavailableInventory === 'revisions') return {};
      return { results: { bindings: [...this.semanticPins].map(([revision, pins]) => ({
        revision: uri(revision), count: { type: 'literal', value: String(pins.length) },
        ...(pins[0] ? { generation: uri(pins[0]) } : {}),
      })) } };
    }
    if (query.includes('SELECT DISTINCT ?generation WHERE')) {
      if (this.unavailableInventory === 'models') return {};
      return { results: { bindings: [...new Set([...this.generations.keys(), ...this.currentHeads])].sort().map(generation => ({
        generation: uri(generation),
      })) } };
    }
    if (query.includes('SELECT ?manifest ?commandModule')) {
      const anchor = [...this.generations].find(([generation]) => query.includes(`<${generation}>`))?.[1];
      return { results: { bindings: anchor ? [{ manifest: uri(anchor.manifest),
        commandModule: { type: 'literal', value: anchor.commandModule } }] : [] } };
    }
    throw new Error(`Unexpected custody query: ${query}`);
  }
}

interface CommandRow {
  receipt: string; request_digest: string; payload_sha256: string; revision: string;
  payload_erasure_id: string | null; payload_erasure_epoch: string | null; data_epoch: string | null;
  stream_sequence: string | null; graph_sequence: string | null;
}

interface JournalFixture {
  id: string; epoch: string; kind: 'revision' | 'resource';
  targets: { owner: string; target_kind: string; target_ref: string }[];
}

function fixture() {
  mkdirSync(resolve('.temp/erasure-custody-tests'), { recursive: true });
  const directory = mkdtempSync(resolve('.temp/erasure-custody-tests/objects-'));
  directories.push(directory);
  const fuseki = new CustodyGraph();
  const objects = new MemoryObjects();
  const commandRows: CommandRow[] = [];
  const access = new Pool({ max: 1 });
  // Unit queries use a supplied client; the integration suite proves its real PG lifecycle.
  const accessClient: PoolClient = Object.assign(new Client(), { release: () => {
    throw new Error('custody must not release a borrowed Access client');
  } });
  accessClient.query = (async (sql: string) => {
    if (!sql.includes('FROM access.command_custody')) throw new Error('unexpected borrowed custody query');
    return { rows: commandRows, rowCount: commandRows.length, command: 'SELECT', oid: 0, fields: [] };
  }) as typeof accessClient.query;
  let journal: JournalFixture | null = null;
  const relayClient: PoolClient = Object.assign(new Client(), { release: () => {
    throw new Error('custody must not release a borrowed Relay client');
  } });
  relayClient.query = (async (sql: string) => {
    if (sql.includes('FROM relay.erasure_target')) return { rows: journal?.targets.map((target, ordinal) => ({
      ordinal, owner: target.owner, target_kind: target.target_kind, target_ref: target.target_ref,
      completion_state: 'pending', completion_reason_code: null, completion_evidence_ref: null, completed_at: null,
    })) ?? [], rowCount: journal?.targets.length ?? 0, command: 'SELECT', oid: 0, fields: [] };
    if (sql.includes('FROM relay.erasure_disposition')) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] };
    if (sql.includes('FROM relay.erasure WHERE id = $1')) return { rows: journal ? [{
      id: journal.id, erasure_epoch: journal.epoch, operation_id: `operation:${journal.id}`,
      request_digest: hash('request'), kind: journal.kind, authority: 'access_admission', principal_id: null,
      admission_id: null, authority_epoch: null, stage: 'reconciling', suppression_status: 'suppressed',
      destruction_status: 'pending', blocked_reason: null, requested_at: new Date(0), suppressed_at: new Date(1),
      verified_at: null,
    }] : [], rowCount: journal ? 1 : 0, command: 'SELECT', oid: 0, fields: [] };
    throw new Error(`unexpected borrowed Relay query: ${sql}`);
  }) as typeof relayClient.query;
  const graph: RestoredGraphCustody = { fuseki, lineage: { dataEpoch: 'restored-epoch', routingEpoch: '2' } };
  const store: { directory: string; workObjects: ImmutableObjects } = { directory, workObjects: objects };
  const addModel = async (commandModule: string) => {
    const shape = Buffer.from(`@prefix sh: <http://www.w3.org/ns/shacl#> . <urn:shape:${commandModule}> a sh:NodeShape .\n`);
    const manifestBytes = Buffer.from(JSON.stringify({ commandModule, profiles: [{
      id: 'retained-profile-v1', sha256: hash(shape), file: 'shapes/retained-profile-v1.ttl',
    }] }));
    const generation = `urn:rezics:model-generation:${hash(manifestBytes)}`;
    const env = { fuseki, objectDirectory: directory, workObjects: objects, lineage: graph.lineage };
    await custodyModelGenerationArtifacts(env, generation, manifestBytes, () => shape);
    const anchor = await prepareWorkComponent(objects, generation, {
      modelManifestSha256: hash(manifestBytes), commandModule, entailment: 'none',
    }, PROFILES.generation);
    fuseki.generations.set(generation, { manifest: `urn:rezics:sha256:${anchor}`, commandModule });
    return { generation, manifestDigest: hash(manifestBytes), shapeDigest: hash(shape) };
  };
  return { access, accessClient, relayClient, graph, fuseki, objects, store, commandRows, addModel,
    setJournal: (value: JournalFixture | null) => { journal = value; },
    read: (client?: PoolClient) => restoredCustodyDigests(access, graph, store, accessClient, client) };
}

test('restored custody verifies a revision’s older pinned generation and retains every exact artifact', async () => {
  const f = fixture();
  const older = await f.addModel('retained-old-module');
  const newer = await f.addModel('retained-new-module');
  f.fuseki.currentHeads.add(newer.generation);
  f.fuseki.semanticPins.set('urn:rezics:semantic:retained-revision', [older.generation]);
  const retained = await f.read();
  for (const digest of [older.manifestDigest, older.shapeDigest, newer.manifestDigest, newer.shapeDigest]) {
    expect(retained.has(digest)).toBe(true);
    expect(await replayObjectErasure(f.store, `sha256:${digest}`, retained, true)).toBe('conflict');
  }
  expect(f.fuseki.queries.some(query => query.includes(`<${older.generation}>`)
    && query.includes('SELECT ?manifest ?commandModule'))).toBe(true);
  expect(f.fuseki.queries.filter(query => query.includes('SELECT ?manifest ?commandModule'))
    .every(query => !query.includes('generationHead'))).toBe(true);
});

test('a current model head without an exact retained anchor keeps restored custody unavailable', async () => {
  const f = fixture();
  await f.addModel('retained-module');
  f.fuseki.currentHeads.add(`urn:rezics:model-generation:${'e'.repeat(64)}`);
  await expect(f.read()).rejects.toBeInstanceOf(RevisionNotFound);
});

for (const root of ['manifestDigest', 'shapeDigest'] as const) {
  for (const state of ['missing', 'corrupt'] as const) {
    test(`a ${state} original model ${root} keeps restored custody unavailable`, async () => {
      const f = fixture();
      const model = await f.addModel('retained-old-module');
      if (state === 'missing') f.objects.data.delete(model[root]);
      else f.objects.data.set(model[root], Buffer.from('divergent original bytes'));
      await expect(f.read()).rejects.toBeInstanceOf(ObjectErasureConflict);
    });
  }
}

for (const state of ['missing', 'ambiguous', 'different-generation'] as const) {
  test(`a semantic revision with a ${state} model pin keeps restored custody unavailable`, async () => {
    const f = fixture();
    const model = await f.addModel('retained-module');
    const unavailable = `urn:rezics:model-generation:${'e'.repeat(64)}`;
    f.fuseki.semanticPins.set('urn:rezics:semantic:retained-revision',
      state === 'missing' ? [] : state === 'ambiguous' ? [model.generation, unavailable] : [unavailable]);
    if (state === 'different-generation') await expect(f.read()).rejects.toBeInstanceOf(RevisionNotFound);
    else await expect(f.read()).rejects.toThrow('retained revision model pin is unavailable');
  });
}

test('a graph command module differing from the exact retained model state refuses restored custody', async () => {
  const f = fixture();
  const model = await f.addModel('retained-module');
  const anchor = f.fuseki.generations.get(model.generation)!;
  f.fuseki.generations.set(model.generation, { ...anchor, commandModule: 'divergent-graph-module' });
  await expect(f.read()).rejects.toBeInstanceOf(RevisionCorrupt);
});

for (const inventory of ['models', 'revisions'] as const) {
  test(`an unavailable retained ${inventory} inventory fails closed`, async () => {
    const f = fixture();
    await f.addModel('retained-module');
    f.fuseki.unavailableInventory = inventory;
    await expect(f.read()).rejects.toThrow('inventory is unavailable');
  });
}

async function command(f: ReturnType<typeof fixture>) {
  const roots = {
    command: await f.objects.put(Buffer.from('retired command bytes')),
    manifest: await f.objects.put(Buffer.from('retired component manifest bytes')),
    payload: await f.objects.put(Buffer.from('retired component payload bytes')),
    selectedShape: await f.objects.put(Buffer.from('original selected validation shape bytes')),
  };
  const row: CommandRow = { receipt: `urn:rezics:receipt:${hash('retired command')}`,
    request_digest: hash('retired command request'), payload_sha256: hash('retired command bytes'),
    revision: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    payload_erasure_id: null, payload_erasure_epoch: null,
    data_epoch: 'command-epoch', stream_sequence: '4', graph_sequence: '900' };
  f.commandRows.push(row);
  const result: CustodiedOutbox = { batch: { batchId: `urn:rezics:outbox:${hash(row.receipt)}`,
    custodiedReceipt: row.receipt, streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: row.data_epoch!,
    sequence: row.stream_sequence!, graphSequence: row.graph_sequence!, routingEpoch: '1', eventIds: [] }, events: [] };
  return { row, result, roots };
}

function historicalReader(f: ReturnType<typeof fixture>, c: Awaited<ReturnType<typeof command>>,
  positions: { dataEpoch: string; streamSequence: string }[] = [], originals = f.objects) {
  return { readHistorical: async (position: { dataEpoch: string; streamSequence: string }, client: PoolClient) => {
    expect(client).toBe(f.accessClient);
    positions.push(position);
    for (const digest of Object.values(c.roots)) await originals.get(digest);
    return { kind: 'retained', outbox: c.result, objectDigests: new Set(Object.values(c.roots)),
      source: {} as HistoricalReceiptSource['source'] } satisfies HistoricalReceiptSource;
  } };
}

function erasedHistorical(c: Awaited<ReturnType<typeof command>>): ErasedHistoricalReceiptSource {
  const terminal = { outcome: 'succeeded' as const, receipt: c.row.receipt, admissionId: 'admission',
    requestDigest: c.row.request_digest, authorityEpoch: '1', scope: 'work', dataEpoch: c.row.data_epoch!,
    sequence: c.row.graph_sequence!, streamSequence: c.row.stream_sequence!,
    work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    component: 'https://rezics.com/id/00000000-0000-4000-8000-000000000003', revision: c.row.revision };
  return { kind: 'erased', receipt: c.row.receipt, requestDigest: c.row.request_digest,
    payloadSha256: c.row.payload_sha256, revision: c.row.revision,
    erasureId: c.row.payload_erasure_id!, erasureEpoch: c.row.payload_erasure_epoch!, terminal, outbox: c.result };
}

const commandErasureId = '10000000-0000-4000-8000-000000000001';
function journalForCommand(c: Awaited<ReturnType<typeof command>>, epoch = '12',
  targets = [
    { owner: 'graph', target_kind: 'work_head', target_ref: c.row.revision.slice('https://rezics.com/id/'.length) },
    { owner: 'object', target_kind: 'object', target_ref: `sha256:${c.row.payload_sha256}` },
  ]): JournalFixture {
  c.row.payload_erasure_id = commandErasureId;
  c.row.payload_erasure_epoch = epoch;
  return { id: commandErasureId, epoch, kind: 'revision', targets };
}

function erasedReader(f: ReturnType<typeof fixture>, c: Awaited<ReturnType<typeof command>>) {
  return { readHistorical: async (position: { dataEpoch: string; streamSequence: string }, client: PoolClient) => {
    expect(client).toBe(f.accessClient);
    expect(position).toEqual({ dataEpoch: c.row.data_epoch!, streamSequence: c.row.stream_sequence! });
    return erasedHistorical(c);
  } };
}

test('historical custody uses owner stream 4 and independently verifies graph position 900', async () => {
  const f = fixture();
  const c = await command(f);
  const positions: { dataEpoch: string; streamSequence: string }[] = [];
  f.graph.receiptCustody = historicalReader(f, c, positions);
  const retained = await f.read();
  expect(positions).toEqual([{ dataEpoch: 'command-epoch', streamSequence: '4' }]);
  expect(retained.has(c.row.payload_sha256)).toBe(true);
});

for (const root of ['command', 'manifest', 'payload', 'selectedShape'] as const) {
  test(`retired original ${root} absent from graph references remains protected before object replay`, async () => {
    const f = fixture();
    const c = await command(f);
    f.graph.receiptCustody = historicalReader(f, c);
    expect(f.fuseki.generations.size).toBe(0);
    const retained = await f.read();
    expect(retained.has(c.roots[root])).toBe(true);
    expect(await replayObjectErasure(f.store, `sha256:${c.roots[root]}`, retained, true)).toBe('conflict');
    expect(await f.objects.get(c.roots[root])).toBeInstanceOf(Uint8Array);
  });
  for (const state of ['missing', 'corrupt'] as const) {
    test(`a ${state} restored historical ${root} denies even when the reader has valid independent originals`, async () => {
      const f = fixture();
      const c = await command(f);
      const originals = new MemoryObjects();
      for (const digest of Object.values(c.roots)) originals.data.set(digest, await f.objects.get(digest));
      f.graph.receiptCustody = historicalReader(f, c, [], originals);
      if (state === 'missing') f.objects.data.delete(c.roots[root]);
      else f.objects.data.set(c.roots[root], Buffer.from('divergent original bytes'));
      await expect(f.read()).rejects.toBeInstanceOf(state === 'missing' ? ObjectUnavailable : ObjectIntegrityError);
    });
  }
}

for (const field of ['custodiedReceipt', 'streamScope', 'dataEpoch', 'sequence', 'graphSequence'] as const) {
  test(`command custody refuses a mismatched ${field} in the C6 owner batch`, async () => {
    const f = fixture();
    const c = await command(f);
    const reader = historicalReader(f, c).readHistorical;
    f.graph.receiptCustody = { readHistorical: async (position, client) => {
      const retained = await reader(position, client);
      return { ...retained, outbox: { ...c.result,
        batch: { ...c.result.batch, [field]: 'different' } } };
    } };
    await expect(f.read()).rejects.toThrow('retained command custody differs');
  });
}

test('missing command adapter, terminal position, owner result or exact bytes cannot release custody', async () => {
  const f = fixture();
  const c = await command(f);
  await expect(f.read()).rejects.toThrow('retained command custody is unavailable');
  f.graph.receiptCustody = { readHistorical: async () => null };
  await expect(f.read()).rejects.toThrow('retained command custody differs');
  f.graph.receiptCustody = { readHistorical: async () => { throw new ObjectUnavailable('command bytes unavailable'); } };
  await expect(f.read()).rejects.toBeInstanceOf(ObjectUnavailable);
  for (const field of ['data_epoch', 'stream_sequence', 'graph_sequence'] as const) {
    f.graph.receiptCustody = historicalReader(f, c);
    const before = c.row[field];
    c.row[field] = null;
    await expect(f.read()).rejects.toThrow('retained command custody is unavailable');
    c.row[field] = before;
  }
});

for (const state of ['changed', 'vanished'] as const) {
  test(`restored historical custody rereads the selected command object when its cached copy has ${state}`, async () => {
    const f = fixture();
    const c = await command(f);
    const remote = cachedObjectStore();
    f.store.workObjects = remote.store;
    for (const digest of Object.values(c.roots)) await remote.store.put(f.objects.data.get(digest)!);
    const getsBeforeRead = remote.counts.gets;
    f.graph.receiptCustody = historicalReader(f, c);
    if (state === 'changed') remote.replace(c.row.payload_sha256, Buffer.from('changed physical command bytes'));
    else remote.remove(c.row.payload_sha256);

    if (state === 'changed') await expect(f.read()).rejects.toBeInstanceOf(ObjectIntegrityError);
    else await expect(f.read()).rejects.toBeInstanceOf(ObjectUnavailable);
    expect(remote.counts.gets).toBe(getsBeforeRead + 1);
  });
}

test('journal-bound terminal command erasure omits only its exact raw root from restored custody', async () => {
  const f = fixture();
  const c = await command(f);
  f.setJournal(journalForCommand(c));
  f.graph.receiptCustody = erasedReader(f, c);
  const retained = await f.read(f.relayClient);
  expect(retained.has(c.row.payload_sha256)).toBe(false);
  expect(retained.has(c.roots.manifest)).toBe(false);
});

test('terminal command erasure cannot be accepted without the exact journal epoch', async () => {
  const f = fixture();
  const c = await command(f);
  f.setJournal(journalForCommand(c, '12'));
  c.row.payload_erasure_epoch = '13';
  f.graph.receiptCustody = erasedReader(f, c);
  await expect(f.read(f.relayClient)).rejects.toThrow('erasure journal');
});

test('a forged journal without the erased command object target cannot release custody', async () => {
  const f = fixture();
  const c = await command(f);
  f.setJournal(journalForCommand(c, '12', [
    { owner: 'graph', target_kind: 'work_head', target_ref: c.row.revision.slice('https://rezics.com/id/'.length) },
    { owner: 'object', target_kind: 'object', target_ref: `sha256:${hash('different command')}` },
  ]));
  f.graph.receiptCustody = erasedReader(f, c);
  await expect(f.read(f.relayClient)).rejects.toThrow('not authorized by its exact erasure journal');
});

test('erasing command custody does not release unrelated model manifests or validation shapes', async () => {
  const f = fixture();
  const c = await command(f);
  const model = await f.addModel('unrelated-retained-module');
  f.setJournal(journalForCommand(c));
  f.graph.receiptCustody = erasedReader(f, c);
  const retained = await f.read(f.relayClient);
  expect(retained.has(c.row.payload_sha256)).toBe(false);
  for (const digest of [model.manifestDigest, model.shapeDigest]) {
    expect(retained.has(digest)).toBe(true);
    expect(await replayObjectErasure(f.store, `sha256:${digest}`, retained, true)).toBe('conflict');
  }
});

const revisionId = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;

test('public Content suppression scans fail closed when the graph inventory is absent or malformed', async () => {
  const revision = revisionId(1);
  const target = `urn:rezics:content:revision:${revision}`;
  const graph = new FusekiClient('http://custody.invalid');
  const responses: SparqlResult[] = [
    {},
    { results: { bindings: [{}] } },
    { results: { bindings: [{ target: { type: 'literal', value: target } }] } },
    { results: { bindings: [{ target: { type: 'uri', value: `urn:rezics:content:revision:${revisionId(2)}` } }] } },
  ];
  for (const response of responses) {
    graph.query = async () => response;
    await expect(graphErasedContentRevisions(graph, [revision])).rejects.toBeInstanceOf(GraphErasureUnavailable);
  }
  graph.query = async () => { throw new GraphErasureUnavailable('graph is offline'); };
  await expect(graphErasedContentRevisions(graph, [revision])).rejects.toBeInstanceOf(GraphErasureUnavailable);
});

test('public Content suppression permits 64 distinct exact targets and rejects larger reads before querying', async () => {
  const revisions = Array.from({ length: 64 }, (_, index) => revisionId(index + 1));
  const graph = new FusekiClient('http://custody.invalid');
  const queries: string[] = [];
  graph.query = async query => {
    queries.push(query);
    return { results: { bindings: [{ target: { type: 'uri',
      value: `urn:rezics:content:revision:${revisions[31]}` } }] } };
  };
  expect(await graphErasedContentRevisions(graph, revisions)).toEqual(new Set([revisions[31]!]));
  expect(queries).toHaveLength(1);
  expect(queries[0]!.match(/<urn:rezics:content:revision:/g)).toHaveLength(64);
  await expect(graphErasedContentRevisions(graph, [...revisions, revisionId(65)]))
    .rejects.toBeInstanceOf(GraphErasureConflict);
  expect(queries).toHaveLength(1);
  expect(await graphErasedContentRevisions(graph, [])).toEqual(new Set());
  expect(queries).toHaveLength(1);
});

test('public Content cannot deliver bytes suppressed while its disclosure owner is still evaluating', async () => {
  const revision = revisionId(1);
  const work = `https://rezics.com/id/${revisionId(2)}`;
  const graph = new FusekiClient('http://custody.invalid');
  const tombstones = new Set<string>();
  graph.query = async query => {
    if (query.includes('SELECT ?target WHERE')) return { results: { bindings:
      tombstones.has(revision) ? [{ target: { type: 'uri', value: `urn:rezics:content:revision:${revision}` } }] : [] } };
    if (query.includes('SELECT ?work ?head')) return { results: { bindings: [{
      work: { type: 'uri', value: work }, head: { type: 'uri', value: `https://rezics.com/id/${revisionId(3)}` },
    }] } };
    throw new Error('unexpected public Content fixture query');
  };
  let enterPolicy!: () => void, releasePolicy!: () => void;
  const policyEntered = new Promise<void>(resolve => { enterPolicy = resolve; });
  const policyReleased = new Promise<void>(resolve => { releasePolicy = resolve; });
  const reader: DisclosureReader = { read: async targets => {
    enterPolicy();
    await policyReleased;
    return targets.map(() => 'visible');
  } };
  const env = { fuseki: graph, objectDirectory: '.temp/erasure-custody-tests',
    lineage: { dataEpoch: 'epoch', routingEpoch: '1' } };
  configureDisclosure(env, reader);
  const serializedJson = JSON.stringify({ body: 'original bytes retained by the retrying Content owner' });
  const original: ExactReadResult = { revisionId: revision, status: 'available', serializedJson,
    body: JSON.parse(serializedJson), reference: { owner: 'content', resourceId: work,
      variantId: `urn:rezics:variant:${revisionId(4)}`, revisionId: revision, format: 'rezics-content-json-v1',
      model: 'content-shape-v1', byteDigest: hash(serializedJson), byteLength: Buffer.byteLength(serializedJson),
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      sourceRevision: null, predecessor: null, provenance: {} } };
  const pending = discloseContent(env, [original]);
  await policyEntered;
  tombstones.add(revision);
  releasePolicy();
  expect(await pending).toEqual([{ revisionId: revision, status: 'erased' }]);
  expect(original.serializedJson).toBe(serializedJson);
  expect(original.body).toEqual({ body: 'original bytes retained by the retrying Content owner' });
});
