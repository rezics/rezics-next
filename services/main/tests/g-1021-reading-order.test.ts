import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { ObjectUnavailable } from '../src/infrastructure/immutable-objects.ts';
import { ReadingOrderIndex, READING_ORDER_COST, readingOrderRead } from '../src/modules/reading-position/immutable-order.ts';
import { ReadingPositionTraversal, type ReadingWork } from '../src/modules/reading-position/traversal.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { COMPOSITION_PROFILE, orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, type OccurrenceRecord, type OrderEntry } from '../src/modules/structure/format.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
async function fixture(count: number) {
  const stored = new Map<string, Uint8Array>();
  let reads = 0, bytes = 0, queries = 0, hydratedRows = 0;
  const objects: ImmutableObjects = { put: async body => {
    const digest = createHash('sha256').update(body).digest('hex'); stored.set(digest, body); return digest;
  }, get: async digest => {
    const body = stored.get(digest);
    if (!body) throw new ObjectUnavailable('missing object');
    reads++; bytes += body.length; return body;
  } };
  const structure = id(), generation = id(), revision = id(), work = id(), cost = newCost();
  const target = id();
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({ occurrence: id(),
    state: 'active', parent: structure, segmentKey: Math.floor(index / 32).toString(36).padStart(4, '0'),
    orderKey: (index % 32).toString(36).padStart(2, '0'), role: 'chapter', target, selection: { mode: 'follow-context' },
    introducedBy: revision, labels: [{ value: `Chapter ${index + 1}`, language: 'en' }] }));
  const order = records.map(record => ({ parent: record.parent, segmentKey: record.segmentKey!,
    orderKey: record.orderKey!, occurrence: record.occurrence }));
  const manifest = { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: id(), profile: 'book-composition' as const,
    generation, pageFormat: STRUCTURE_PAGE_FORMAT, records: await recordTree(objects).apply(await recordTree(objects).empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await orderTree(objects).apply(await orderTree(objects).empty(cost), new Map(order.map(entry => [orderTreeKey(entry), entry])), cost),
    placementCount: count, measures: [], model: COMPOSITION_PROFILE, shape: COMPOSITION_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const session = { deps: { structureObjects: objects }, checkDeadline: () => {}, query: async (query: string) => {
    queries++;
    const binding = (value: string) => ({ value });
    if (query.includes('# reading-position:work\n')) return [{ work: binding(work), structure: binding(structure),
      revision: binding(revision), generation: binding(generation) }];
    if (query.includes('# reading-position:records') || query.includes('# reading-position:hydrate')) {
      const hydrate = query.includes('# reading-position:hydrate');
      if (hydrate) expect(query).toMatch(/GRAPH <[^>]+> \{\s*VALUES \(\?placement \?occurrence\)/);
      else expect(query).toContain('?occurrence rv:structure ?structure');
      const wanted = query.match(/VALUES [^{]+\{([^}]+)}/)![1]!;
      const selected = records.filter(record => wanted.includes(record.occurrence));
      if (hydrate) hydratedRows += selected.length;
      return selected.map(record => ({ work: binding(work),
        structure: binding(structure), revision: binding(revision), occurrence: binding(record.occurrence),
        parent: binding(structure), segmentKey: binding(record.segmentKey!), orderKey: binding(record.orderKey!),
        role: binding('https://rezics.com/vocab/ChapterRole'), target: binding(target),
        label: { ...binding(record.labels[0]!.value), 'xml:lang': record.labels[0]!.language } }));
    }
    expect(query).toContain('# reading-position:manifest');
    return [{ manifest: { value: `urn:rezics:sha256:${digest}` } }];
  } } as unknown as WorkReadSession;
  const meta: ReadingWork = { work, structure, revision, generation };
  const index = new ReadingOrderIndex(session, objects);
  const measure = () => ({ reads, bytes, queries });
  reads = 0; bytes = 0; queries = 0;
  return { index, session, meta, records, order, stored, objects, manifest, measure, hydrated: () => hydratedRows };
}

test('G1021: distant order pages and numeric ranks visit bounded immutable paths at 100, 1000 and 10000 chapters', async () => {
  const observations = [];
  for (const count of [100, 1000, 10000]) {
    const f = await fixture(count);
    expect(await f.index.numbered(f.meta, f.meta.structure!, count)).toBe(f.records.at(-1)!.occurrence);
    const first = count - 100;
    const after = first ? { ...f.records[first - 1]!, work: f.meta.work, structure: f.meta.structure!, revision: f.meta.revision!,
      target: f.records[first - 1]!.target!, role: 'chapter' as const, segmentKey: f.records[first - 1]!.segmentKey!,
      orderKey: f.records[first - 1]!.orderKey! } : undefined;
    const page = await f.index.range(f.meta, f.meta.structure!, after, false, 101);
    expect(page.map(item => item.occurrence)).toEqual(f.records.slice(first).map(item => item.occurrence));
    expect(page.map(item => item.ordinal)).toEqual(Array.from({ length: 100 }, (_, offset) => first + offset + 1));
    expect(await f.index.numbered(f.meta, f.meta.structure!, count + 1)).toBeNull();
    expect(await f.index.ordinal(f.meta, page.at(-1)!)).toBe(count);
    // UUID distribution cannot scatter hydration across the entire record tree.
    // Only counted order paths and exact bounded graph identities are read.
    expect(f.measure().reads).toBeLessThanOrEqual(8);
    expect(f.measure().queries).toBe(2);
    const before = f.measure();
    expect((await f.index.range(f.meta, f.meta.structure!, after, false, 101)).map(item => item.occurrence))
      .toEqual(page.map(item => item.occurrence));
    expect(f.measure()).toEqual({ ...before, queries: before.queries + 1 });
    observations.push({ count, ...f.measure() });
  }
  console.log('G1021 immutable work', JSON.stringify(observations));
});

test('G1021: reverse pages preserve sibling ordinals and stop at their parent boundary', async () => {
  const f = await fixture(1000);
  const page = await f.index.range(f.meta, f.meta.structure!, undefined, true, 3);
  expect(page.map(item => item.ordinal)).toEqual([1000, 999, 998]);
  const previous = await f.index.range(f.meta, f.meta.structure!, page.at(-1), true, 3);
  expect(previous.map(item => item.ordinal)).toEqual([997, 996, 995]);
  const missing = id();
  expect(await f.index.numbered(f.meta, missing, 1)).toBeNull();
  expect(await f.index.range(f.meta, missing, undefined, false, 101)).toEqual([]);
});

test('G1021: missing, corrupt and different-generation objects fail closed without graph fallback', async () => {
  const f = await fixture(100);
  await expect(f.index.manifest({ ...f.meta, generation: id() })).rejects.toBeInstanceOf(WorkReadUnavailable);
  const missing = new ReadingOrderIndex(f.session, { ...f.objects, get: async () => { throw new ObjectUnavailable('missing'); } });
  await expect(readingOrderRead(() => missing.range(f.meta, f.meta.structure!, undefined, false, 101)))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  const corrupt = new ReadingOrderIndex(f.session, { ...f.objects, get: async () => new TextEncoder().encode('{}') });
  await expect(readingOrderRead(() => corrupt.range(f.meta, f.meta.structure!, undefined, false, 101)))
    .rejects.toBeInstanceOf(WorkReadUnavailable);
  const manifest = await new ReadingOrderIndex(f.session, f.objects).manifest(f.meta);
  const leaf = JSON.parse(new TextDecoder().decode(f.stored.get(manifest.order.page.slice(7))!)) as { entries: OrderEntry[] };
  leaf.entries[0]!.orderKey = 'zz';
  f.stored.set(manifest.order.page.slice(7), new TextEncoder().encode(JSON.stringify(leaf)));
  const inconsistent = new ReadingOrderIndex(f.session, f.objects);
  await expect(inconsistent.range(f.meta, f.meta.structure!, undefined, false, 101)).rejects.toBeInstanceOf(WorkReadUnavailable);
});

test('G1021: request-local object budget and cancellation reject before further store reads', async () => {
  const f = await fixture(0);
  const index = new ReadingOrderIndex(f.session, { ...f.objects, get: async () => new Uint8Array(1) });
  for (let at = 0; at < READING_ORDER_COST.pages; at++) await index.objects.get(String(at));
  await expect(index.objects.get('overflow')).rejects.toBeInstanceOf(WorkReadUnavailable);
  const byteBound = new ReadingOrderIndex(f.session, { ...f.objects, get: async () => new Uint8Array(READING_ORDER_COST.bytes + 1) });
  await expect(byteBound.objects.get('big')).rejects.toBeInstanceOf(WorkReadUnavailable);
  const before = f.measure();
  f.session.checkDeadline = () => { throw new WorkReadUnavailable('cancelled'); };
  await expect(f.index.objects.get('cancelled')).rejects.toBeInstanceOf(WorkReadUnavailable);
  expect(f.measure()).toEqual(before);
});

test('G1021: configured chooser continuation never asks the graph for a range, OFFSET or ordinal aggregation', async () => {
  const f = await fixture(10000);
  const traversal = new ReadingPositionTraversal(f.session, f.meta.work, async resources => new Set(resources));
  const page = await traversal.page({ limit: 100, after: f.records[9899]!.occurrence });
  expect(page.items.map(item => item.occurrence)).toEqual(f.records.slice(9900).map(item => item.occurrence));
  expect(page.items[0]!.ordinal).toBe(9901); expect(page.items.at(-1)!.ordinal).toBe(10000);
  expect(page.complete).toBe(true); expect(page.next).toBeNull();
  expect(f.measure().queries).toBe(4);
  expect(f.measure().reads).toBeLessThanOrEqual(8);
});

test('G1021: a one-item page hydrates its item and lookahead, and resumes without skipping the smaller probe', async () => {
  const f = await fixture(10000);
  const traversal = new ReadingPositionTraversal(f.session, f.meta.work, async resources => new Set(resources));
  const first = await traversal.page({ limit: 1 });
  expect(first.items.map(item => item.occurrence)).toEqual([f.records[0]!.occurrence]);
  expect(first.complete).toBe(false); expect(first.next).toBe(f.records[0]!.occurrence);
  expect(f.hydrated()).toBe(2);
  const next = await traversal.page({ limit: 1, after: first.next! });
  expect(next.items.map(item => item.occurrence)).toEqual([f.records[1]!.occurrence]);
  expect(next.complete).toBe(false); expect(f.hydrated()).toBe(4);
});
