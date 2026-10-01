import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { MainWorkDependencies } from '../src/app.ts';
import { FusekiClient, fusekiReadBudget, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { readVisibleCompositionPage } from '../src/modules/collection/visible-page.ts';
import { collectionTargetBatchReader } from '../src/modules/composition/visible-targets.ts';
import { configureDisclosure } from '../src/modules/disclosure/read.ts';
import { ReadingBoundary } from '../src/modules/reading-position/boundary.ts';
import type { ReadingPositionStore } from '../src/modules/reading-position/store.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { newCost, StructureObjectCorrupt } from '../src/modules/structure/tree.ts';
import { resolveTargets, resolveVisibleTargets, TargetUnavailable } from '../src/modules/target/resolve.ts';
import { WorkReadSession, WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';

const term = (value: string) => ({ type: 'literal' as const, value });
const uri = (value: string) => ({ type: 'uri' as const, value });

/** Real immutable trees, resolver, summary/disclosure pipeline and reading
 * boundary; only owner storage responses are simulated. Integration meters the API. */
async function fixture(count: number, options: { duplicate?: boolean; hidden?: (index: number) => boolean;
  gated?: (index: number) => boolean; missingRevision?: (index: number) => boolean; corrupt?: boolean } = {}) {
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) {
      const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes);
      return digest;
    },
    async get(digest) {
      const bytes = stored.get(digest);
      if (!bytes) throw new Error('Missing fixture object');
      return bytes;
    },
  };
  const structure = derivedId('g-908-structure'), owner = derivedId('g-908-owner');
  const revision = derivedId('g-908-revision'), generation = derivedId('g-908-generation');
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: derivedId(`g-908-member-${index}`), parent: structure, state: 'active', role: 'member',
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: revision,
    target: derivedId(`g-908-target-${options.duplicate ? 0 : index}`), selection: { mode: 'follow-context' },
  }));
  const indexes = new Map(records.map((record, index) => [record.target!, index]));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries = records.map(({ occurrence, parent, segmentKey, orderKey }) =>
    ({ occurrence, parent, segmentKey: segmentKey!, orderKey: orderKey! }) satisfies OrderEntry);
  if (options.corrupt) records.at(-1)!.parent = derivedId('foreign-parent');
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: owner,
    profile: 'collection-membership', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(row => [orderTreeKey(row), row])), cost),
    placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const header: CompositionHeader = { structure, head: revision, generation, manifest: `urn:rezics:sha256:${digest}`,
    placementCount: count, profile: 'collection-membership', owner, component: owner, work: owner, mainVersion: owner };
  const queries: string[] = [], hydrated: string[][] = [], positionBatches: string[][] = [];
  let graphSequence = '1', positionGeneration = '1', ambiguous = false;
  const graph = new FusekiClient('http://graph.invalid');
  graph.query = async query => {
    queries.push(query);
    const bindings: NonNullable<SparqlResult['results']>['bindings'] = [];
    if (query.includes('SELECT ?manifest ?predecessor')) {
      bindings.push({ manifest: term(header.manifest), count: term(String(count)), epoch: term('epoch'), sequence: term('1') });
    } else {
      const resources = [...query.matchAll(/VALUES \?r \{([^}]+)\}/g)].flatMap(match =>
        [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => iri[1]!));
      for (const resource of resources) {
        const index = indexes.get(resource)!;
        if (query.includes('SELECT ?epoch ?sequence ?hold')) {
          bindings.push({ epoch: term('epoch'), sequence: term(graphSequence), r: uri(resource), type: term('work'),
            work: uri(resource), head: uri(revision), public: term('true'), erased: term('false'),
            label: { ...term('Collection target'), 'xml:lang': 'en' } });
        } else if (query.includes('SELECT ?epoch ?sequence ?r ?revision')) {
          if (options.missingRevision?.(index)) continue;
          bindings.push({ epoch: term('epoch'), sequence: term(graphSequence), r: uri(resource),
            revision: uri(revision), type: uri('https://schema.org/CreativeWork') });
          if (ambiguous) bindings.push({ ...bindings.at(-1)!, revision: uri(derivedId('other-revision')) });
        } else throw new Error(`Unexpected graph query: ${query}`);
      }
      if (!bindings.length) bindings.push({ epoch: term('epoch'), sequence: term(graphSequence) });
    }
    return { results: { bindings } };
  };
  const environment = { fuseki: graph, structureObjects: objects, objectDirectory: '.temp/g-908-unit',
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } };
  configureDisclosure(environment, { read: async targets => targets.map(target =>
    options.hidden?.(indexes.get(target.resource)!) ? 'tombstone' : 'visible') });
  const deps = { environment, access: {}, account: {},
    media: { store: { avatarRows: async (resources: string[]) => {
      hydrated.push([...resources]);
      return { rows: new Map(), generation: { dataEpoch: 'media', sequence: '1' } };
    } } },
    readingPositions: { generation: async () => positionGeneration,
      lookup: async (resources: readonly string[]) => { positionBatches.push([...resources]); return new Map(); },
      required: async (resources: readonly string[]) => new Set(resources.filter(resource => options.gated?.(indexes.get(resource)!))),
    } as unknown as ReadingPositionStore,
  } as unknown as MainWorkDependencies;
  const session = () => new WorkReadSession(deps, new Request('http://main.test/v1/collections?position=start'),
    {}, { dataEpoch: 'epoch', sequence: '1' });
  const read = (limit: number, after?: string, occurrence?: string, onVisible?: () => void) => {
    const current = session(), boundary = new ReadingBoundary(current);
    const visible = boundary.visible.bind(boundary);
    boundary.visible = async resources => { const result = await visible(resources); onVisible?.(); return result; };
    return readVisibleCompositionPage(environment, { structure, header, limit, after, occurrence, readingBoundary: boundary,
      visible: row => row.role !== 'member' || !!row.target,
      canReadTarget: async () => { throw new Error('Scalar target hydration must not run'); },
      canReadTargets: collectionTargetBatchReader(current) });
  };
  return { records, read, queries, hydrated, positionBatches, session,
    moveGraph: () => { graphSequence = '2'; }, movePosition: () => { positionGeneration = '2'; },
    ambiguous: () => { ambiguous = true; } };
}

test('G-908: distinct 10/100-item pages share one range pass with two bounded hydration batches', async () => {
  const f = await fixture(100);
  const counts: number[] = [];
  for (const limit of [10, 100]) {
    f.queries.length = f.hydrated.length = f.positionBatches.length = 0;
    const page = await f.read(limit);
    counts.push(f.queries.length);
    expect(page.occurrences).toEqual(f.records.slice(0, limit));
    expect(page.next === null).toBe(limit === 100);
    expect(f.hydrated.map(batch => batch.length)).toEqual([64, 36]);
    expect(f.hydrated.flat()).toEqual(f.records.map(record => record.target!));
    expect(f.positionBatches.map(batch => batch.length)).toEqual([50, 50]);
  }
  expect(counts).toEqual([5, 5]);
});

test('G-908: 100 duplicate targets hydrate once and retain every occurrence', async () => {
  const f = await fixture(100, { duplicate: true });
  const page = await f.read(100);
  expect(page.occurrences).toEqual(f.records);
  expect(f.queries).toHaveLength(3);
  expect(f.hydrated).toEqual([[f.records[0]!.target!]]);
  expect(f.positionBatches).toEqual([[f.records[0]!.target!]]);
});

test('G-908: sparse disclosure crosses 1,000 candidates; private trailing targets expose no continuation', async () => {
  for (const lastVisible of [999, 0]) {
    const f = await fixture(1_000, { hidden: index => index !== 0 && index !== lastVisible });
    const first = await f.read(1);
    expect(first.occurrences).toEqual([f.records[0]!]);
    if (lastVisible === 999) {
      expect(first.next).not.toBeNull();
      const last = await f.read(1, first.next!);
      expect(last.occurrences).toEqual([f.records[999]!]);
      expect(last.next).toBeNull();
    } else expect(first.next).toBeNull();
  }
});

test('G-908: mixed hidden, position-gated and revision-missing members are withheld individually', async () => {
  const f = await fixture(6, { hidden: index => index === 1, gated: index => index === 3,
    missingRevision: index => index === 4 });
  const page = await f.read(100);
  expect(page.occurrences).toEqual([f.records[0]!, f.records[2]!, f.records[5]!]);
  expect(page.next).toBeNull();
  expect(f.hydrated.flat()).not.toContain(f.records[1]!.target!);
  const direct = await f.read(1, undefined, f.records[3]!.occurrence);
  expect(direct.occurrences).toEqual([]);
  // The inventory adapter does not weaken the command resolver's atomic result.
  await expect(resolveTargets(f.session(), f.records.map(record => record.target!), 'collection-member'))
    .rejects.toBeInstanceOf(TargetUnavailable);
});

test('G-908: batched resolution rejects graph movement and ambiguous heads; position changes fence the page', async () => {
  const moved = await fixture(2);
  moved.moveGraph();
  await expect(moved.read(100)).rejects.toBeInstanceOf(WorkReadMoved);
  const ambiguous = await fixture(2);
  ambiguous.ambiguous();
  await expect(resolveVisibleTargets(ambiguous.session(), ambiguous.records.map(record => record.target!), 'collection-member'))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  const position = await fixture(2);
  await expect(position.read(100, undefined, undefined, position.movePosition)).rejects.toBeInstanceOf(WorkReadMoved);
});

test('G-908: cancellation stops a batched page before graph or target hydration', async () => {
  const f = await fixture(100);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(fusekiReadBudget.run({ signal: controller.signal, callsLeft: 10, bytesLeft: 100_000 },
    () => f.read(100))).rejects.toThrow('cancelled');
  expect(f.queries).toEqual([]);
  expect(f.hydrated).toEqual([]);
});

test('G-908: a corrupt immutable candidate range fails before target hydration', async () => {
  const f = await fixture(100, { corrupt: true });
  await expect(f.read(10)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.queries).toHaveLength(1);
  expect(f.hydrated).toEqual([]);
});
