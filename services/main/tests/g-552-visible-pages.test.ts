import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { fusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { readVisibleCompositionPage } from '../src/modules/collection/visible-page.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { derivedId, orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

/** Real immutable B+trees; only the graph's exact revision anchor is simulated. */
async function fixture(count: number, disclosed: (index: number) => boolean, onTarget?: () => void) {
  const stored = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) { const digest = createHash('sha256').update(bytes).digest('hex');
      stored.set(digest, bytes); return digest; },
    async get(digest) { const bytes = stored.get(digest); if (!bytes) throw new Error('Missing fixture object');
      return bytes; },
  };
  const structure = derivedId('g-552-collection'), revision = derivedId('g-552-revision');
  const generation = derivedId('g-552-generation'), owner = derivedId('g-552-owner');
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: derivedId(`g-552-member-${index}`), state: 'active', role: 'member', parent: structure,
    segmentKey: 'i', orderKey: String(index).padStart(8, '0'), labels: [], introducedBy: revision,
    target: derivedId(`g-552-target-${index}`), selection: { mode: 'follow-context' },
  }));
  const readable = new Set(records.filter((_, index) => disclosed(index)).map(row => row.target!));
  const cost = newCost(), recordIndex = recordTree(objects), orderIndex = orderTree(objects);
  const entries = records.map(({ occurrence, parent, segmentKey, orderKey }) =>
    ({ occurrence, parent, segmentKey: segmentKey!, orderKey: orderKey! }) satisfies OrderEntry);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure,
    structureOf: owner, profile: 'collection-membership', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordIndex.apply(await recordIndex.empty(cost), new Map(records.map(row => [row.occurrence, row])), cost),
    order: await orderIndex.apply(await orderIndex.empty(cost), new Map(entries.map(row => [orderTreeKey(row), row])), cost),
    placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const header: CompositionHeader = { structure, head: revision, generation, manifest: `urn:rezics:sha256:${digest}`,
    placementCount: count, profile: 'collection-membership', owner, component: owner, work: owner, mainVersion: owner };
  let graphCalls = 0, targetChecks = 0;
  const env = { structureObjects: objects, fuseki: { query: async () => {
    graphCalls++;
    const term = (value: string) => ({ type: 'literal', value });
    return { results: { bindings: [{ manifest: term(header.manifest), count: term(String(count)),
      epoch: term('g-552-epoch'), sequence: term('1') }] } };
  } } } as unknown as WorkActivationEnvironment;
  const read = (limit: number, after?: string, occurrence?: string) => readVisibleCompositionPage(env, { structure, header,
    limit, after, occurrence, visible: row => row.role !== 'member' || !!row.target,
    canReadTarget: async target => { targetChecks++; onTarget?.(); return readable.has(target); } });
  return { records, read, graphCalls: () => graphCalls, targetChecks: () => targetChecks };
}

test('G-552: Collection continuation traverses 1,000 members in bounded pages without gaps or duplicates', async () => {
  const f = await fixture(1_000, () => true);
  const actual: string[] = [];
  let after: string | undefined;
  do {
    const page = await f.read(100, after);
    expect(page.occurrences.length).toBeLessThanOrEqual(100);
    actual.push(...page.occurrences.map(row => row.occurrence));
    after = page.next ?? undefined;
  } while (after);
  expect(actual).toEqual(f.records.map(row => row.occurrence));
  expect(new Set(actual).size).toBe(1_000);
  expect(f.graphCalls()).toBe(10);
});

test('G-552: more than 8×100 hidden members cannot truncate visible lookahead or the next page', async () => {
  const f = await fixture(1_000, index => index === 0 || index === 999);
  const first = await f.read(1);
  expect(first.occurrences.map(row => row.occurrence)).toEqual([f.records[0]!.occurrence]);
  expect(first.next).not.toBeNull();
  expect(f.graphCalls()).toBe(1);
  const last = await f.read(1, first.next!);
  expect(last.occurrences.map(row => row.occurrence)).toEqual([f.records[999]!.occurrence]);
  expect(last.next).toBeNull();
  expect(f.graphCalls()).toBe(2);
  // One disclosure check per scanned placement; no repeated header read per hidden row.
  expect(f.targetChecks()).toBeLessThanOrEqual(2_000);
});

test('G-552: private trailing members reveal neither a continuation nor an extra result', async () => {
  const f = await fixture(1_000, index => index === 0);
  const page = await f.read(1);
  expect(page.occurrences.map(row => row.occurrence)).toEqual([f.records[0]!.occurrence]);
  expect(page.next).toBeNull();
  expect(f.graphCalls()).toBe(1);
});

test('G-552: a sparse traversal respects its request cancellation before reading storage', async () => {
  const f = await fixture(1_000, () => false);
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await expect(fusekiReadBudget.run({ signal: controller.signal, callsLeft: 10, bytesLeft: 100_000 },
    () => f.read(20))).rejects.toThrow('cancelled');
  expect(f.graphCalls()).toBe(0);
});

test('G-552: a direct hidden occurrence stays absent from the owner disclosure projection', async () => {
  const f = await fixture(1_000, () => false);
  const page = await f.read(1, undefined, f.records[0]!.occurrence);
  expect(page.occurrences).toEqual([]);
  expect(page.next).toBeNull();
});

test('G-552: cancellation within a sparse immutable range stops further target checks', async () => {
  const controller = new AbortController();
  const f = await fixture(1_000, () => false, () => controller.abort(new Error('cancelled during scan')));
  await expect(fusekiReadBudget.run({ signal: controller.signal, callsLeft: 10, bytesLeft: 100_000 },
    () => f.read(20))).rejects.toThrow('cancelled during scan');
  expect(f.targetChecks()).toBe(1);
});
