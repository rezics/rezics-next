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
import { orderTreeKey, placementIri } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { GRAPHS, RV } from '../src/modules/work/activate.ts';

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

/** Add exact CURRENT predicate points without changing the original custody fixture. */
async function associationFixture(active = 2, removed = 0) {
  const f = await retainedFixture(active, removed);
  const projections = new Map<string, Descriptor[]>();
  const batches: string[][] = [];
  const probes: Array<[string, string, string]> = [];
  let afterQuery: (() => void | Promise<void>) | undefined;
  const project = (source = f.source, records = f.records) => {
    for (const entry of records)
      projections.set(placementIri(source.generation, entry.occurrence), [
        { field: { type: 'literal', value: 'generation' }, value: uri(source.generation) },
        { field: { type: 'literal', value: 'occurrence' }, value: uri(entry.occurrence) },
        ...(entry.target
          ? [{ field: { type: 'literal', value: 'target' }, value: uri(entry.target) }]
          : []),
      ]);
  };
  project();
  const graph = {
    query: async (query: string, maxBytes?: number) => {
      if (!query.includes('SELECT ?placement ?field ?value')) return f.graph.query(query, maxBytes);
      const signal = fusekiReadBudget.getStore()!.signal;
      signal.throwIfAborted();
      expect(maxBytes).toBeGreaterThan(0);
      expect(maxBytes).toBeLessThanOrEqual(256 * 1024);
      expect(query).toContain(`GRAPH <${GRAPHS.current}>`);
      expect(query).not.toMatch(/generationState|selectedGeneration|structureHead|DISTINCT|FILTER/);
      const selected = [
        ...query.matchAll(/BIND\(<(urn:rezics:placement:[a-f0-9]{64})> AS \?placement\)/g),
      ].map((match) => match[1]!);
      expect(query).not.toContain('VALUES');
      expect(Buffer.byteLength(query)).toBeLessThanOrEqual(256 * 1024);
      for (const placement of selected) {
        expect(query).toContain(`<${placement}> rv:generation ?value`);
        expect(query).toContain(`<${placement}> rv:occurrence ?value`);
        expect(query).toContain(`<${placement}> schema:item ?value`);
      }
      expect(selected.length).toBeGreaterThan(0);
      expect(selected.length).toBeLessThanOrEqual(256);
      expect(query).toContain(`LIMIT ${selected.length * 3 + 1}`);
      batches.push(selected);
      const rows = selected.flatMap((placement) => {
        for (const predicate of [`${RV}generation`, `${RV}occurrence`, 'https://schema.org/item'])
          probes.push([GRAPHS.current, placement, predicate]);
        return (projections.get(placement) ?? []).map((row) => ({
          placement: uri(placement),
          ...row,
        }));
      });
      await afterQuery?.();
      return { results: { bindings: rows.slice(0, selected.length * 3 + 1) } };
    },
  } as unknown as FusekiClient;
  const qualification = () => ({
    signal: new AbortController().signal,
    deadline: Date.now() + 30_000,
    maxProbes: 100_000,
    maxBytes: 16 * 1024 * 1024,
  });
  const capture = (options = qualification()) =>
    captureObjectRecoveryCoverage(graph, {
      ...f.store,
      originalStructureAssociations: options,
    });
  return {
    ...f,
    graph,
    projections,
    probes,
    batches,
    project,
    qualification,
    capture,
    setAfterQuery: (callback: () => void | Promise<void>) => {
      afterQuery = callback;
    },
  };
}

test('Opt-in original associations refuse partial64/24 stages and restored Active/Retired skew', async () => {
  for (const state of ['Staging', 'Cancelled', 'Active', 'Retired']) {
    const f = await associationFixture(64);
    for (const entry of f.records.slice(24))
      f.projections.delete(placementIri(f.source.generation, entry.occurrence));
    // A stage checkpoint ahead of the restored graph can have Active/Retired
    // state and the full descriptor count while forty projections are missing.
    const descriptor = f.descriptors.get(f.key(GRAPHS.revisions, id(4)))![0]!;
    descriptor.state = uri(`${RV}${state}`);
    descriptor.checkpoint = integer(4);
    const ordinary = await captureObjectRecoveryCoverage(f.graph, f.store);
    expect(ordinary.referenceCount).toBe('1');
    await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(f.batches.flat()).toHaveLength(64);
    expect(f.projections.size).toBe(24);
    expect(await captureObjectRecoveryCoverage(f.graph, f.store)).toEqual(ordinary);
  }
});

test('Opt-in associates retired originals and removed records without changing signed coverage hashes', async () => {
  const f = await associationFixture(257, 2);
  f.addAnchor('urn:rezics:retained:retired', id(6));
  f.descriptors.get(f.key('urn:rezics:retained:retired', id(6)))![0]!.state = uri(`${RV}Retired`);
  const ordinary = await captureObjectRecoveryCoverage(f.graph, f.store);
  f.reads.length = 0;
  const qualified = await f.capture();
  expect(qualified).toEqual(ordinary);
  expect(f.batches.flat()).toHaveLength(259);
  expect(f.probes).toHaveLength(777);
  expect(new Set(f.reads.map((read) => read.digest)).size).toBe(Number(ordinary.objectCount));
  expect(f.reads.filter((read) => read.digest !== f.digest)).toHaveLength(
    Number(ordinary.objectCount) - 1,
  );
  expect(ordinary).toEqual({
    version: 1,
    referenceCount: '2',
    anchorCount: '1',
    objectCount: '7',
    referenceDigest: '4038fd70cda897011a9a675ffee6d32ccaab8f06afee9e1c37523bd8a05b63f0',
    anchorDigest: '5d6d232712ad2921b64a3a28e9c9bb69799c8528970313abfd7947509cc60619',
    objectDigest: '8a3f8fe1270e7246185103729e7c3a0502998b35cf98ecb6766ba37d903eebf5',
  });
  const measured = {
    coverage: ordinary,
    records: 259,
    removedRecords: 2,
    batches: f.batches.map((batch) => batch.length),
    pointProbes: f.probes.length,
    gets: f.reads.length,
    uniqueObjects: new Set(f.reads.map((read) => read.digest)).size,
    bytes: f.reads.reduce((sum, read) => sum + f.values.get(read.digest)!.length, 0),
  };
  console.info('Structure original association cost', JSON.stringify(measured));
  await Bun.write('.temp/structure-original-association-cost.json', JSON.stringify(measured));
  const removed = f.records.at(-1)!;
  f.projections.get(placementIri(f.source.generation, removed.occurrence))![2]!.value = uri(
    id(999),
  );
  await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
});

test('Opt-in refuses missing or ambiguous legacy item and exact generation/occurrence mismatches', async () => {
  const f = await associationFixture(1, 1);
  const placement = placementIri(f.source.generation, f.records[1]!.occurrence);
  const original = f.projections.get(placement)!;
  for (const invalid of [
    original.slice(0, 2),
    [...original, { ...original[2]!, value: uri(id(888)) }],
    [
      original[0]!,
      original[1]!,
      { ...original[2]!, value: { type: 'literal', value: f.records[1]!.target! } },
    ],
    [{ ...original[0]!, value: uri(id(88)) }, ...original.slice(1)],
    [original[0]!, { ...original[1]!, value: uri(id(89)) }, original[2]!],
    [...original, { ...original[0]!, value: uri(id(90)) }],
    [...original, { ...original[1]!, value: uri(id(91)) }],
  ]) {
    f.projections.set(placement, invalid);
    await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
    await captureObjectRecoveryCoverage(f.graph, f.store);
  }
  f.projections.set(placement, original);
  // Another placement (even one with the right occurrence and target) cannot
  // supply the missing deterministic original identity.
  f.projections.set(placementIri(id(90), f.records[1]!.occurrence), original);
  f.projections.delete(placement);
  await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
});

test('Opt-in validates both refreshed retarget generations and shared pages across two generations', async () => {
  for (const retarget of [false, true]) {
    const f = await associationFixture(257, 1);
    const previous = f.source;
    const historical = f.addAnchor('urn:rezics:retained:retired', id(6));
    const oldAnchor = { ...historical };
    const oldDescriptor = f.descriptors.get(f.key(historical.graph, historical.subject))!;
    const records = f.records.map((entry) => ({
      ...entry,
      ...(retarget ? { target: id(10001) } : {}),
    }));
    const next = {
      ...previous,
      generation: id(9),
      ...(retarget
        ? {
            records: await recordTree(f.objects).apply(
              previous.records,
              new Map(records.map((entry) => [entry.occurrence, entry])),
              newCost(),
            ),
          }
        : {}),
    };
    await f.replaceSource(next);
    Object.assign(historical, oldAnchor);
    f.descriptors.set(f.key(historical.graph, historical.subject), oldDescriptor);
    f.project(next, records);
    const ordinary = await captureObjectRecoveryCoverage(f.graph, f.store);
    f.reads.length = 0;
    expect(await f.capture()).toEqual(ordinary);
    expect(f.probes).toHaveLength(258 * 3 * 2);
    expect(f.batches.flat()).toHaveLength(258 * 2);
    if (!retarget) {
      expect(next.records).toEqual(previous.records);
      const pages = f.reads.filter(
        (read) => read.digest !== oldAnchor.digest && read.digest !== f.anchors[0]!.digest,
      );
      expect(pages.length).toBe(Number(ordinary.objectCount) - 2);
      expect(new Set(pages.map((read) => read.digest)).size).toBe(pages.length);
    }
    // The second generation must still be checked after its shared pages/root.
    const oldPlacement = placementIri(previous.generation, f.records[0]!.occurrence);
    f.projections.get(oldPlacement)![2]!.value = uri(id(10001));
    await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
  }
});

test('Opt-in original association bounds probes, bytes, whole deadline and caller cancellation', async () => {
  const f = await associationFixture(64);
  await expect(f.capture({ ...f.qualification(), maxProbes: 64 * 3 - 1 })).rejects.toThrow(
    'probe budget',
  );
  expect(f.probes).toHaveLength(0);
  const tinyGet = f.objects.get;
  f.objects.get = async (digest, maxBytes, signal) => {
    const left = fusekiReadBudget.getStore()?.bytesLeft;
    expect(maxBytes).toBe(Math.min(STRUCTURE_LIMITS.pageBytes, left ?? -1));
    return tinyGet(digest, maxBytes, signal);
  };
  await expect(f.capture({ ...f.qualification(), maxBytes: 1 })).rejects.toThrow('byte budget');
  expect(f.probes).toHaveLength(0);
  expect(f.reads.at(-1)!.maxBytes).toBe(1);
  f.objects.get = tinyGet;
  const exhausted = await associationFixture(2);
  const manifestBytes = exhausted.values.get(exhausted.digest)!.length;
  expect(manifestBytes).toBeGreaterThan(1);
  expect(manifestBytes).toBeLessThan(STRUCTURE_LIMITS.pageBytes);
  const exhaustedGet = exhausted.objects.get;
  const exhaustedCaps: number[] = [];
  exhausted.objects.get = async (digest, maxBytes, signal) => {
    const left = fusekiReadBudget.getStore()!.bytesLeft;
    expect(maxBytes).toBe(Math.min(STRUCTURE_LIMITS.pageBytes, left));
    exhaustedCaps.push(maxBytes!);
    return exhaustedGet(digest, maxBytes, signal);
  };
  await expect(
    exhausted.capture({ ...exhausted.qualification(), maxBytes: manifestBytes }),
  ).rejects.toThrow('byte budget');
  expect(exhaustedCaps).toEqual([manifestBytes]);
  expect(exhausted.reads.map((read) => read.digest)).toEqual([exhausted.digest]);
  expect(exhausted.probes).toHaveLength(0);
  expect(
    exhausted.reads.some((read) => read.digest === exhausted.source.records.page.slice(7)),
  ).toBe(false);
  const shared = await associationFixture(2);
  const previous = shared.source;
  const historical = shared.addAnchor('urn:rezics:retained:retired', id(8));
  const oldAnchor = { ...historical };
  const oldDescriptor = shared.descriptors.get(shared.key(historical.graph, historical.subject))!;
  const next = { ...previous, generation: id(11) };
  await shared.replaceSource(next);
  Object.assign(historical, oldAnchor);
  shared.descriptors.set(shared.key(historical.graph, historical.subject), oldDescriptor);
  shared.project(next, shared.records);
  const ordinaryShared = await captureObjectRecoveryCoverage(shared.graph, shared.store);
  const meter = {
    signal: new AbortController().signal,
    callsLeft: 1_000_000,
    bytesLeft: 16 * 1024 * 1024,
  };
  await fusekiReadBudget.run(meter, () => shared.capture());
  const spent = 16 * 1024 * 1024 - meter.bytesLeft;
  expect(spent).toBeGreaterThan(manifestBytes);
  expect(spent).toBeLessThan(STRUCTURE_LIMITS.pageBytes);
  const sharedGet = shared.objects.get;
  const requested: Array<{ digest: string; maxBytes?: number; bytesLeft: number }> = [];
  shared.objects.get = async (digest, maxBytes, signal) => {
    const bytesLeft = fusekiReadBudget.getStore()!.bytesLeft;
    requested.push({ digest, maxBytes, bytesLeft });
    return sharedGet(digest, maxBytes, signal);
  };
  shared.probes.length = 0;
  expect(await shared.capture({ ...shared.qualification(), maxBytes: spent })).toEqual(
    ordinaryShared,
  );
  expect(requested.length).toBeGreaterThan(2);
  expect(requested[0]!.maxBytes).toBe(spent);
  expect(requested[0]!.maxBytes).toBeGreaterThan(requested.at(-1)!.maxBytes!);
  for (const read of requested) {
    expect(read.maxBytes).toBe(Math.min(STRUCTURE_LIMITS.pageBytes, read.bytesLeft));
    expect(read.maxBytes).toBeLessThan(STRUCTURE_LIMITS.pageBytes);
  }
  const manifests = new Set([shared.digest, oldAnchor.digest]);
  const pages = requested.filter((read) => !manifests.has(read.digest));
  expect(pages.length).toBeGreaterThan(1);
  expect(new Set(pages.map((read) => read.digest)).size).toBe(pages.length);
  expect(shared.probes).toHaveLength(shared.records.length * 3 * 2);
  shared.objects.get = sharedGet;
  await expect(f.capture({ ...f.qualification(), deadline: Date.now() - 1 })).rejects.toThrow(
    'deadline',
  );
  const caller = new AbortController(),
    reason = new Error('held owner cancelled');
  caller.abort(reason);
  const reads = f.reads.length;
  await expect(f.capture({ ...f.qualification(), signal: caller.signal })).rejects.toBe(reason);
  expect(f.reads).toHaveLength(reads);
  const during = new AbortController();
  f.setAfterQuery(() => during.abort(reason));
  await expect(f.capture({ ...f.qualification(), signal: during.signal })).rejects.toBe(reason);
  const empty = await associationFixture(0);
  const final = new AbortController();
  empty.store.structureQualifierRoots.retainedRoots = async () => {
    final.abort(reason);
    return [];
  };
  await expect(empty.capture({ ...empty.qualification(), signal: final.signal })).rejects.toBe(
    reason,
  );
  const outer = new AbortController();
  const inherited = await associationFixture();
  inherited.setAfterGet(() => outer.abort(reason));
  const budget = { signal: outer.signal, callsLeft: 20, bytesLeft: 100_000 };
  await expect(fusekiReadBudget.run(budget, () => inherited.capture())).rejects.toBe(reason);
  expect(budget.signal).toBe(outer.signal);
  const expired = await associationFixture();
  const options = expired.qualification();
  expired.setAfterQuery(() => {
    options.deadline = Date.now() - 1;
  });
  await expect(expired.capture(options)).rejects.toThrow('deadline');
  const timed = await associationFixture();
  timed.setAfterQuery(() => new Promise((resolve) => setTimeout(resolve, 40)));
  await expect(
    timed.capture({ ...timed.qualification(), deadline: Date.now() + 20 }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
});

test('Opt-in checks targetless record identities, empty originals and default-graph anchors in CURRENT', async () => {
  const empty = await associationFixture(0);
  expect(await empty.capture()).toEqual(
    await captureObjectRecoveryCoverage(empty.graph, empty.store),
  );
  expect(empty.batches).toHaveLength(0);
  const f = await associationFixture(1);
  f.anchors.length = 0;
  f.addAnchor(defaultGraph);
  expect(await f.capture()).toEqual(await captureObjectRecoveryCoverage(f.graph, f.store));
  const targetless = { ...f.records[0]! };
  targetless.role = 'group';
  delete targetless.target;
  delete targetless.selection;
  await f.replaceSource({
    ...f.source,
    records: await recordTree(f.objects).apply(
      f.source.records,
      new Map([[targetless.occurrence, targetless]]),
      newCost(),
    ),
  });
  f.project(f.source, [targetless]);
  expect(await f.capture()).toEqual(await captureObjectRecoveryCoverage(f.graph, f.store));
  f.projections.delete(placementIri(f.source.generation, targetless.occurrence));
  await expect(f.capture()).rejects.toMatchObject({ kind: 'unavailable' });
});

test('Opt-in refuses duplicate original placement identities before checking only the last target', async () => {
  const f = await associationFixture(2);
  const original = f.records[0]!;
  const digest = await f.objects.put(
    encode({
      format: STRUCTURE_PAGE_FORMAT,
      tree: 'record',
      level: 0,
      entries: [{ ...original, target: id(10001) }, original],
    }),
  );
  await f.replaceSource({ ...f.source, records: { page: `sha256:${digest}`, level: 0, count: 2 } });
  // Existing recursive object custody remains unchanged. Association must not
  // turn two conflicting original records into the Map's last expected target.
  await captureObjectRecoveryCoverage(f.graph, f.store);
  await expect(f.capture()).rejects.toThrow('repeats a placement');
  expect(f.probes).toHaveLength(0);
});

test('Ordinary malformed owner refusal and opt-in caller byte counters remain intact', async () => {
  const f = await associationFixture();
  await expect(captureObjectRecoveryCoverage(f.graph, undefined as never)).rejects.toBeInstanceOf(
    ObjectRecoveryConflict,
  );
  const outer = { signal: new AbortController().signal, callsLeft: 100, bytesLeft: 100_000 };
  const ordinary = await captureObjectRecoveryCoverage(f.graph, f.store);
  expect(await fusekiReadBudget.run(outer, () => f.capture())).toEqual(ordinary);
  expect(outer.bytesLeft).toBeLessThan(100_000);
  const tight = { ...outer, bytesLeft: 1 };
  await expect(fusekiReadBudget.run(tight, () => f.capture())).rejects.toThrow('byte budget');
});
