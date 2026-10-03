import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectUnavailable } from '../src/infrastructure/immutable-objects.ts';
import { orderTree } from '../src/modules/structure/change.ts';
import { evenKeys, segmentKeyBetween, withinBudget } from '../src/modules/structure/order-key.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_PAGE_FORMAT, type OccurrenceRecord } from '../src/modules/structure/format.ts';
import { StructureStageStore, StructureStageUnavailable, type StructureStage } from '../src/modules/structure/stage.ts';
import { ReadingPositionTraversal } from '../src/modules/reading-position/traversal.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

test('G1014: ordinal aggregation sums prior segments once per segment rather than once per chapter', async () => {
  const work = id(), structure = id(), generation = id(), revision = id();
  const binding = (value: string) => ({ type: 'literal', value });
  const records = Array.from({ length: 101 }, (_, index) => ({ occurrence: binding(id()),
    placement: binding(`urn:placement:${index}`), parent: binding(structure),
    segmentKey: binding(Math.floor(index / 32).toString(36)), orderKey: binding((index % 32).toString(36)),
    role: binding('https://rezics.com/vocab/ChapterRole'), matches: binding('true') }));
  let ordinalQuery = '';
  const session = { checkDeadline: () => {}, query: async (query: string) => {
    if (query.includes('# reading-position:work')) return [{ work: binding(work), structure: binding(structure),
      generation: binding(generation), revision: binding(revision) }];
    if (query.includes('# reading-position:range')) return records;
    if (query.includes('# reading-position:ordinals')) {
      ordinalQuery = query;
      return records.map((record, index) => ({ occurrence: record.occurrence, ordinal: binding(String(index + 1)) }));
    }
    throw new Error(`Unexpected reading query: ${query}`);
  } } as unknown as WorkReadSession;
  const traversal = new ReadingPositionTraversal(session, work, async resources => new Set(resources));
  const page = await traversal.page({ limit: 100 });
  expect(page.items).toHaveLength(100); expect(page.complete).toBe(false);
  const prior = ordinalQuery.split('OPTIONAL { SELECT ?parent ?segmentKey (SUM(?count) AS ?prior)')[1]?.split('GRAPH')[0];
  expect(prior).toBeDefined();
  expect(prior!.match(/\(<https:\/\/rezics.com\/id\//g)).toHaveLength(4);
  expect(ordinalQuery).toContain('GROUP BY ?parent ?segmentKey');
});

const id = () => `https://rezics.com/id/${randomUUID()}`;
function memoryObjects() {
  const retained = new Map<string, Uint8Array>();
  return { put: async (bytes: Uint8Array) => {
    const digest = createHash('sha256').update(bytes).digest('hex'); retained.set(digest, bytes); return digest;
  }, get: async (digest: string) => {
    const bytes = retained.get(digest); if (!bytes) throw new ObjectUnavailable('Missing test page'); return bytes;
  } };
}

test('G1014: ordered first, last and neighboring seeks read tree paths at 100, 1000 and 10000 occurrences', async () => {
  const objects = memoryObjects(), tree = orderTree(objects);
  const parents = [id(), id(), id()].sort();
  for (const size of [100, 1000, 10000]) {
    const keys = evenKeys(size);
    const entries = parents.flatMap(parent => keys.map(orderKey => ({ parent, segmentKey: 'a', orderKey, occurrence: id() })));
    const root = await tree.apply(await tree.empty(newCost()), new Map(entries.map(entry => [orderTreeKey(entry), entry])), newCost());
    for (const parent of parents) for (const reverse of [false, true]) {
      const cost = newCost();
      const found = await tree.range(root, `${parent}\u0001`, `${parent}\u0002`, 1, cost, reverse);
      expect(found.map(entry => entry.orderKey)).toEqual([reverse ? keys.at(-1)! : keys[0]!]);
      expect(cost.pagesRead).toBeLessThanOrEqual(root.level + 1);
    }
    const cost = newCost(), emptyParent = `${parents[1]}-absent`;
    expect(await tree.range(root, `${emptyParent}\u0001`, `${emptyParent}\u0002`, 1, cost, true)).toEqual([]);
    expect(cost.pagesRead).toBeLessThanOrEqual(root.level + 1);
  }
});

test('G1014: append and prepend segment allocation keeps keys bounded without rewriting siblings', () => {
  for (const reverse of [false, true]) {
    let key = segmentKeyBetween(null, null);
    for (let segment = 0; segment < 10000; segment++) {
      const next = reverse ? segmentKeyBetween(null, key) : segmentKeyBetween(key, null);
      expect(reverse ? next < key : next > key).toBe(true);
      expect(withinBudget(next)).toBe(true);
      // Future middle inserts must still have space after boundary allocation.
      const interior = reverse ? segmentKeyBetween(next, key) : segmentKeyBetween(key, next);
      expect(withinBudget(interior)).toBe(true);
      key = next;
    }
  }
  expect(segmentKeyBetween('a', 'b') > 'a').toBe(true);
  expect(segmentKeyBetween('a', 'b') < 'b').toBe(true);
  expect(segmentKeyBetween('0000', '0001') > '0000').toBe(true);
  expect(segmentKeyBetween('0000', '0001') < '0001').toBe(true);
});

test('G1014: stage seal authorizes distinct targets once and a new request rechecks revoked authority', async () => {
  const objects = memoryObjects(), structure = id(), mainVersion = id(), revision = id();
  const targets = [id(), id()];
  const records: OccurrenceRecord[] = Array.from({ length: 1000 }, (_, at) => ({ occurrence: id(),
    state: 'active', parent: structure, segmentKey: Math.floor(at / 32).toString(36).padStart(4, '0'),
    orderKey: (at % 32).toString(36).padStart(2, '0'), role: 'chapter', target: targets[at % 2]!,
    selection: { mode: 'follow-context' }, labels: [], introducedBy: revision }));
  const pages: Array<{ ordinal: number; page_digest: string }> = [];
  for (let offset = 0; offset < records.length; offset += 256) pages.push({ ordinal: pages.length,
    page_digest: await objects.put(new TextEncoder().encode(JSON.stringify({ format: STRUCTURE_PAGE_FORMAT,
      tree: 'record', level: 0, entries: records.slice(offset, offset + 256) }))) });
  const stage: StructureStage = { id: randomUUID(), structure, generation: id(), baseHead: id(),
    kind: 'replace', sourceRef: null, sourceRevision: null, mappingPolicy: null, revision, status: 'staging',
    holder: randomUUID(), fence: '1', pages: pages.length, records: records.length, bytes: 0, manifest: null,
    graphStarted: false, projectionBatches: 0, placementCount: null, graphReceipt: null,
    graphDataEpoch: null, graphSequence: null };
  const pool = { query: async (sql: string) => {
    if (sql.includes('SELECT ordinal')) return { rows: pages };
    if (sql.includes("SET status = 'sealed'")) return { rows: [{ id: stage.id, structure,
      generation: stage.generation, base_head: stage.baseHead, kind: 'replace', status: 'sealed',
      revision, lease_holder: stage.holder, lease_fence: '1', staged_pages: pages.length,
      staged_records: records.length, staged_bytes: 0, root_manifest: null, graph_started: false,
      projection_batches: 0, placement_count: records.length, graph_receipt: null,
      graph_data_epoch: null, graph_sequence: null }] };
    throw new Error(`Unexpected stage SQL: ${sql}`);
  } } as unknown as Pool;
  const store = new StructureStageStore(pool, objects);
  store.read = async () => stage;
  const checked: string[] = [];
  const input = { id: stage.id, principalId: randomUUID(), structure, mainVersion,
    holder: stage.holder!, fence: stage.fence };
  expect((await store.seal({ ...input, canReadTarget: async target => { checked.push(target); return true; } })).status).toBe('sealed');
  expect(checked).toEqual(targets);
  await expect(store.seal({ ...input, canReadTarget: async () => false })).rejects.toBeInstanceOf(StructureStageUnavailable);
});
