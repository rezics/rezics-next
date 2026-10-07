import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import type { ExactReadResult } from '../../content/src/core.ts';
import { FusekiClient, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from
  '../src/infrastructure/immutable-objects.ts';
import { restoredCustodyDigests, type RestoredGraphCustody } from '../src/modules/erasure/custody.ts';
import { discloseContent } from '../src/modules/disclosure/assembly.ts';
import { configureDisclosure, type DisclosureReader } from '../src/modules/disclosure/read.ts';
import { graphErasedContentRevisions, GraphErasureConflict, GraphErasureUnavailable } from
  '../src/modules/erasure/graph.ts';
import { replayObjectErasure } from '../src/modules/erasure/replay-objects.ts';
import type { CustodiedOutbox } from '../src/modules/outbox/relay.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../src/modules/outbox/relay-position.ts';
import { custodyModelGenerationArtifacts } from '../src/modules/semantic/model-custody.ts';
import { MODEL_COMPONENT, PROFILES } from '../src/modules/semantic/schema.ts';
import { GRAPHS, hash, prepareWorkComponent } from '../src/modules/work/activate.ts';
import { RevisionCorrupt, RevisionNotFound } from '../src/modules/work/history.ts';

const directories: string[] = [];
afterEach(() => {
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
  receipt: string; payload_sha256: string; data_epoch: string | null;
  stream_sequence: string | null; graph_sequence: string | null;
}

function fixture() {
  mkdirSync(resolve('.temp/erasure-custody-tests'), { recursive: true });
  const directory = mkdtempSync(resolve('.temp/erasure-custody-tests/objects-'));
  directories.push(directory);
  const fuseki = new CustodyGraph();
  const objects = new MemoryObjects();
  const commandRows: CommandRow[] = [];
  const access = { query: async () => ({ rows: commandRows }) } as unknown as Pool;
  const graph: RestoredGraphCustody = { fuseki, lineage: { dataEpoch: 'restored-epoch', routingEpoch: '2' } };
  const store = { directory, workObjects: objects };
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
  return { access, graph, fuseki, objects, store, commandRows, addModel,
    read: () => restoredCustodyDigests(access, graph, store) };
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

function command(f: ReturnType<typeof fixture>): { row: CommandRow; result: CustodiedOutbox } {
  const row = { receipt: `urn:rezics:receipt:${hash('retired command')}`, payload_sha256: hash('retired command bytes'),
    data_epoch: 'command-epoch', stream_sequence: '4', graph_sequence: '900' };
  f.commandRows.push(row);
  const result: CustodiedOutbox = { batch: { batchId: `urn:rezics:outbox:${hash(row.receipt)}`,
    custodiedReceipt: row.receipt, streamScope: MAIN_RELAY_STREAM_SCOPE, dataEpoch: row.data_epoch,
    sequence: row.stream_sequence, graphSequence: row.graph_sequence, routingEpoch: '1', eventIds: [] }, events: [] };
  return { row, result };
}

test('retired command bytes remain protected through the exact C6 owner stream reader', async () => {
  const f = fixture();
  const c = command(f);
  expect(await f.objects.put(Buffer.from('retired command bytes'))).toBe(c.row.payload_sha256);
  const positions: string[][] = [];
  f.graph.receiptCustody = { read: async (epoch, sequence) => {
    positions.push([epoch, sequence]);
    await f.objects.get(c.row.payload_sha256);
    return c.result;
  } };
  const retained = await f.read();
  expect(positions).toEqual([['command-epoch', '4']]);
  expect(retained.has(c.row.payload_sha256)).toBe(true);
  expect(await replayObjectErasure(f.store, `sha256:${c.row.payload_sha256}`, retained, true)).toBe('conflict');
  f.objects.data.delete(c.row.payload_sha256);
  await expect(f.read()).rejects.toBeInstanceOf(ObjectUnavailable);
});

for (const field of ['custodiedReceipt', 'streamScope', 'dataEpoch', 'sequence', 'graphSequence'] as const) {
  test(`command custody refuses a mismatched ${field} in the C6 owner batch`, async () => {
    const f = fixture();
    const c = command(f);
    f.graph.receiptCustody = { read: async () => ({ ...c.result,
      batch: { ...c.result.batch, [field]: 'different' } }) };
    await expect(f.read()).rejects.toThrow('retained command custody differs');
  });
}

test('missing command adapter, terminal position, owner result or exact bytes cannot release custody', async () => {
  const f = fixture();
  const c = command(f);
  await expect(f.read()).rejects.toThrow('retained command custody is unavailable');
  f.graph.receiptCustody = { read: async () => null };
  await expect(f.read()).rejects.toThrow('retained command custody differs');
  f.graph.receiptCustody = { read: async () => { throw new ObjectUnavailable('command bytes unavailable'); } };
  await expect(f.read()).rejects.toBeInstanceOf(ObjectUnavailable);
  for (const field of ['data_epoch', 'stream_sequence', 'graph_sequence'] as const) {
    f.graph.receiptCustody = { read: async () => c.result };
    const before = c.row[field];
    c.row[field] = null;
    await expect(f.read()).rejects.toThrow('retained command custody is unavailable');
    c.row[field] = before;
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
