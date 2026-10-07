import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { fusekiReadBudget, type FusekiClient } from '../src/infrastructure/fuseki.ts';
import {
  ObjectIntegrityError,
  ObjectReadBudgetExceeded,
  ObjectUnavailable,
  type ImmutableObjects,
} from '../src/infrastructure/immutable-objects.ts';
import {
  captureObjectRecoveryCoverage,
  ObjectRecoveryConflict,
} from '../src/modules/owner/object-coverage.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import {
  STRUCTURE_LIMITS,
  STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_PAGE_FORMAT,
  STRUCTURE_PROFILE,
  type OccurrenceRecord,
  type StructureManifest,
} from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const defaultGraph = 'urn:x-arq:DefaultGraphNode';
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uri = (value: string) => ({ type: 'uri', value });
const integer = (value: number) => ({
  type: 'literal',
  value: String(value),
  datatype: 'http://www.w3.org/2001/XMLSchema#integer',
});
type Term = { type: string; value: string; datatype?: string };
type Descriptor = Record<string, Term>;
interface Anchor {
  graph: string;
  subject: string;
  digest: string;
  component: string;
  model: string;
  shape: string;
}

/** Actual owner bytes; the graph mock implements the four scans and same-graph point read. */
async function retainedFixture(active = 2, removed = 0) {
  const values = new Map<string, Uint8Array>();
  const reads: Array<{ digest: string; maxBytes?: number; signal?: AbortSignal }> = [];
  let afterGet: (() => void) | undefined;
  const objects: ImmutableObjects = {
    put: async (bytes) => {
      const digest = sha(bytes);
      values.set(digest, bytes.slice());
      return digest;
    },
    get: async (digest, maxBytes, signal) => {
      reads.push({ digest, maxBytes, signal });
      signal?.throwIfAborted();
      const bytes = values.get(digest);
      if (!bytes) throw new ObjectUnavailable('missing original owner bytes');
      if (maxBytes !== undefined && bytes.length > maxBytes)
        throw new ObjectReadBudgetExceeded('original owner byte limit');
      if (sha(bytes) !== digest) throw new ObjectIntegrityError('original owner digest');
      afterGet?.();
      return bytes.slice();
    },
  };
  const records: OccurrenceRecord[] = Array.from({ length: active + removed }, (_, index) => ({
    occurrence: id(100 + index),
    state: index < active ? 'active' : 'removed',
    parent: id(1),
    ...(index < active ? { segmentKey: 'a', orderKey: index.toString(36).padStart(8, '0') } : {}),
    role: 'chapter',
    target: id(10000),
    selection: { mode: 'follow-context' },
    labels: [],
    introducedBy: id(4),
    ...(index < active ? {} : { removedBy: id(5) }),
  }));
  const cost = newCost(),
    indexed = recordTree(objects),
    ordered = orderTree(objects);
  const entries = records
    .filter((record) => record.state === 'active')
    .map((record) => ({
      occurrence: record.occurrence,
      parent: record.parent,
      segmentKey: record.segmentKey!,
      orderKey: record.orderKey!,
    }));
  let source: StructureManifest = {
    format: STRUCTURE_MANIFEST_FORMAT,
    structure: id(1),
    structureOf: id(2),
    profile: 'book-composition',
    generation: id(3),
    pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await indexed.apply(
      await indexed.empty(cost),
      new Map(records.map((record) => [record.occurrence, record])),
      cost,
    ),
    order: await ordered.apply(
      await ordered.empty(cost),
      new Map(entries.map((entry) => [orderTreeKey(entry), entry])),
      cost,
    ),
    placementCount: active,
    measures: [],
    model: STRUCTURE_PROFILE,
    shape: STRUCTURE_PROFILE,
  };
  let digest = await objects.put(encode(source));
  const anchors: Anchor[] = [];
  const descriptors = new Map<string, Descriptor[]>();
  const key = (graph: string, subject: string) => JSON.stringify([graph, subject]);
  const addAnchor = (graph: string = GRAPHS.revisions, subject = id(4)): Anchor => {
    const anchor = {
      graph,
      subject,
      digest,
      component: source.structure,
      model: source.model,
      shape: source.shape,
    };
    anchors.push(anchor);
    descriptors.set(key(graph, subject), [
      {
        manifest: uri(`urn:rezics:sha256:${digest}`),
        component: uri(source.structure),
        generation: uri(source.generation),
        count: integer(source.placementCount),
      },
    ]);
    return anchor;
  };
  addAnchor();
  const queries: string[] = [];
  const graph = {
    query: async (query: string) => {
      queries.push(query);
      if (query.includes('SELECT ?manifest ?component ?generation ?count')) {
        // BIND literals are read in source order: subject, then optional graph.
        const bindings = [
          ...query.matchAll(/BIND\(IRI\(("(?:[^"\\]|\\.)*")\) AS \?(subject|graph)\)/g),
        ];
        const subject = bindings.find((match) => match[2] === 'subject');
        const scope = bindings.find((match) => match[2] === 'graph');
        if (!subject) throw new Error('descriptor point read must bind its exact subject');
        const selectedGraph = scope ? (JSON.parse(scope[1]!) as string) : defaultGraph;
        expect(query).toContain('LIMIT 2');
        return {
          results: { bindings: descriptors.get(key(selectedGraph, JSON.parse(subject[1]!))) ?? [] },
        };
      }
      const base = (anchor: Anchor) => ({ graph: uri(anchor.graph), subject: uri(anchor.subject) });
      if (query.includes('SELECT ?graph ?subject ?manifest'))
        return {
          results: {
            bindings: anchors.map((anchor) => ({
              ...base(anchor),
              manifest: uri(`urn:rezics:sha256:${anchor.digest}`),
            })),
          },
        };
      const field = query.includes('rv:component')
        ? 'component'
        : query.includes('rv:modelRevision')
          ? 'model'
          : 'shape';
      return {
        results: {
          bindings: anchors.map((anchor) => ({ ...base(anchor), value: uri(anchor[field]) })),
        },
      };
    },
  } as unknown as FusekiClient;
  const store = {
    directory: '.temp/structure-native-object-coverage',
    structureObjects: objects,
    structureGroupRoots: { retainedRoots: async () => [] },
    structureQualifierRoots: { retainedRoots: async () => [] },
  };
  reads.length = 0;
  return {
    values,
    reads,
    objects,
    anchors,
    descriptors,
    key,
    addAnchor,
    graph,
    queries,
    store,
    records,
    get source() {
      return source;
    },
    get digest() {
      return digest;
    },
    setAfterGet: (callback: () => void) => {
      afterGet = callback;
    },
    replaceSource: async (next: StructureManifest) => {
      source = next;
      digest = await objects.put(encode(next));
      for (const anchor of anchors) {
        anchor.digest = digest;
        descriptors.set(key(anchor.graph, anchor.subject), [
          {
            manifest: uri(`urn:rezics:sha256:${digest}`),
            component: uri(next.structure),
            generation: uri(next.generation),
            count: integer(next.placementCount),
          },
        ]);
      }
    },
  };
}

test('Native retained descriptor binds original generation and count rather than a current header', async () => {
  const f = await retainedFixture();
  // Another generation may be current; this exact historical anchor is sufficient.
  f.addAnchor('urn:rezics:retained:historical', id(6));
  const retained = new Set<string>();
  const coverage = await captureObjectRecoveryCoverage(f.graph, f.store, retained);
  expect(coverage.referenceCount).toBe('2');
  expect(retained.has(f.digest)).toBe(true);
  const rows = f.descriptors.get(f.key(GRAPHS.revisions, id(4)))!;
  rows[0]!.generation = uri(id(99));
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
  rows[0]!.generation = uri(f.source.generation);
  rows[0]!.count = integer(f.source.placementCount + 1);
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
});

test('Native descriptor rejects missing, ambiguous, wrong owner, manifest, and profile coordinates', async () => {
  const f = await retainedFixture();
  const key = f.key(GRAPHS.revisions, id(4)),
    original = f.descriptors.get(key)![0]!;
  for (const field of ['manifest', 'component', 'generation', 'count']) {
    const missing = { ...original };
    delete missing[field];
    f.descriptors.set(key, [missing]);
    await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
      ObjectRecoveryConflict,
    );
  }
  for (const row of [
    { ...original, manifest: uri(`urn:rezics:sha256:${'a'.repeat(64)}`) },
    { ...original, component: uri(id(88)) },
    { ...original, count: uri('2') },
    { ...original, count: { type: 'literal', value: '-1' } },
    { ...original, count: { type: 'literal', value: '2.0' } },
  ]) {
    f.descriptors.set(key, [row]);
    await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
      ObjectRecoveryConflict,
    );
  }
  f.descriptors.set(key, [original, { ...original, generation: uri(id(88)) }]);
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
  f.descriptors.set(key, [original]);
  f.anchors[0]!.shape = `${STRUCTURE_PROFILE}/different`;
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
});

test('Native descriptor cannot borrow another named graph and handles physical default aliases locally', async () => {
  const f = await retainedFixture();
  const named = f.descriptors.get(f.key(GRAPHS.revisions, id(4)))!;
  f.descriptors.delete(f.key(GRAPHS.revisions, id(4)));
  f.descriptors.set(f.key('urn:rezics:another-graph', id(4)), named);
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
  f.anchors.length = 0;
  f.addAnchor(defaultGraph);
  const coverage = await captureObjectRecoveryCoverage(f.graph, f.store);
  expect(coverage.referenceCount).toBe('1');
  expect(coverage.anchorCount).toBe('0');
  const point = f.queries.at(-1)!;
  expect(point).toContain('SELECT ?manifest ?component ?generation ?count');
  expect(point).not.toContain('GRAPH ?graph');
});

test('Native owner rejects an internally valid order root with a different placement count', async () => {
  const f = await retainedFixture(2, 1);
  const emptyOrder = await orderTree(f.objects).empty(newCost());
  await f.replaceSource({ ...f.source, order: emptyOrder });
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toThrow('order count');
});

test('Native owner pins all historical, cancelled, removed and shared original multileaf bytes', async () => {
  const f = await retainedFixture(257, 2);
  expect(f.source.records.level).toBeGreaterThan(0);
  expect(f.source.order.level).toBeGreaterThan(0);
  f.addAnchor('urn:rezics:retained:cancelled', id(7));
  const retained = new Set<string>();
  const coverage = await captureObjectRecoveryCoverage(f.graph, f.store, retained);
  // Both anchors share original immutable bytes, including the removed-use leaves.
  expect(coverage.referenceCount).toBe('2');
  expect(Number(coverage.objectCount)).toBe(retained.size);
  const expected = new Set([f.digest]);
  const visit = (reference: string) => {
    const digest = reference.slice(7);
    if (expected.has(digest)) return;
    expected.add(digest);
    const page = JSON.parse(new TextDecoder().decode(f.values.get(digest)!)) as {
      level: number;
      entries: Array<{ page: string }>;
    };
    if (page.level > 0) for (const child of page.entries) visit(child.page);
  };
  visit(f.source.records.page);
  visit(f.source.order.page);
  expect(retained).toEqual(expected);
  // Initial empty pages are unpublished scratch, outside this retained closure.
  expect(retained.size).toBeLessThan(f.values.size);
  expect(f.records.filter((record) => record.state === 'removed')).toHaveLength(2);
  const secondKey = f.key('urn:rezics:retained:cancelled', id(7));
  f.descriptors.get(secondKey)![0]!.generation = uri(id(98));
  // A closure cache must never skip validation of the second original anchor.
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
});

test('Native owner accepts an exact empty original and refuses an absent descriptor', async () => {
  const f = await retainedFixture(0);
  const retained = new Set<string>();
  const coverage = await captureObjectRecoveryCoverage(f.graph, f.store, retained);
  expect(coverage.referenceCount).toBe('1');
  expect(coverage.objectCount).toBe('3');
  expect(retained.has(f.digest)).toBe(true);
  f.descriptors.delete(f.key(GRAPHS.revisions, id(4)));
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
});

test('Native owner reads each original root once per reference and every closure page with its byte cap', async () => {
  const f = await retainedFixture(257, 1);
  const retained = new Set<string>();
  await captureObjectRecoveryCoverage(f.graph, f.store, retained);
  expect(f.reads.filter((read) => read.digest === f.digest)).toHaveLength(1);
  expect(f.reads.length).toBeGreaterThan(3);
  expect(f.reads.length).toBe(retained.size);
  const measuredCost = {
    references: 1,
    activeRecords: 257,
    removedRecords: 1,
    graphQueries: f.queries.length,
    gets: f.reads.length,
    uniqueObjects: retained.size,
    bytes: f.reads.reduce((sum, read) => sum + f.values.get(read.digest)!.length, 0),
    objectByteCap: STRUCTURE_LIMITS.pageBytes,
  };
  console.info('Structure original capture cost', JSON.stringify(measuredCost));
  await Bun.write('.temp/structure-native-object-coverage-cost.json', JSON.stringify(measuredCost));
  for (const read of f.reads) {
    expect(read.maxBytes).toBe(STRUCTURE_LIMITS.pageBytes);
    expect(read.signal).toBeUndefined();
  }
  const recordRoot = JSON.parse(
    new TextDecoder().decode(f.values.get(f.source.records.page.slice(7))!),
  ) as { entries: Array<{ page: string }> };
  const childDigest = recordRoot.entries[0]!.page.slice(7),
    childBytes = f.values.get(childDigest)!;
  f.values.delete(childDigest);
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toThrow('unavailable');
  f.values.set(childDigest, childBytes);
  f.values.delete(f.source.records.page.slice(7));
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toThrow('unavailable');
  f.values.delete(f.digest);
  await expect(captureObjectRecoveryCoverage(f.graph, f.store)).rejects.toThrow('unavailable');
});

test('Native owner rejects oversized roots and propagates cancellation before and after reads', async () => {
  const oversized = await retainedFixture();
  oversized.values.set(oversized.digest, new Uint8Array(STRUCTURE_LIMITS.pageBytes + 1));
  await expect(captureObjectRecoveryCoverage(oversized.graph, oversized.store)).rejects.toThrow(
    'byte bound',
  );
  const f = await retainedFixture();
  const controller = new AbortController(),
    reason = new Error('caller deadline');
  controller.abort(reason);
  await expect(
    fusekiReadBudget.run({ signal: controller.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      captureObjectRecoveryCoverage(f.graph, f.store),
    ),
  ).rejects.toBe(reason);
  expect(f.reads).toHaveLength(0);
  const during = new AbortController();
  f.setAfterGet(() => during.abort(reason));
  await expect(
    fusekiReadBudget.run({ signal: during.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      captureObjectRecoveryCoverage(f.graph, f.store),
    ),
  ).rejects.toBe(reason);
  expect(f.reads).toHaveLength(1);
  expect(f.reads[0]!.signal).toBe(during.signal);
  const empty = await retainedFixture(0);
  empty.anchors.length = 0;
  await expect(
    fusekiReadBudget.run({ signal: controller.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      captureObjectRecoveryCoverage(empty.graph, empty.store),
    ),
  ).rejects.toBe(reason);
  const finalQuery = new AbortController();
  empty.store.structureQualifierRoots.retainedRoots = async () => {
    finalQuery.abort(reason);
    return [];
  };
  await expect(
    fusekiReadBudget.run({ signal: finalQuery.signal, callsLeft: 100, bytesLeft: 1_048_576 }, () =>
      captureObjectRecoveryCoverage(empty.graph, empty.store),
    ),
  ).rejects.toBe(reason);
  expect(empty.reads).toHaveLength(0);
});
