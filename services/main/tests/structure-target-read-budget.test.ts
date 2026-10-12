import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { orderTreeKey, type CompositionHeader } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { readCompositionPage, type CompositionSnapshot } from '../src/modules/structure/read.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
async function navigation(count: number, distinct = false) {
  const values = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    async put(bytes) { const hash = createHash('sha256').update(bytes).digest('hex'); values.set(hash, bytes.slice()); return hash; },
    async get(hash) { const bytes = values.get(hash); if (!bytes) throw new Error('missing immutable fixture'); return bytes.slice(); },
  };
  const records: OccurrenceRecord[] = Array.from({ length: count }, (_, index) => ({
    occurrence: id(10 + index), state: 'active', parent: id(1), segmentKey: 'a',
    orderKey: index.toString(36).padStart(8, '0'), role: 'mount', target: id(distinct ? 10_000 + index : 10_000),
    labels: [], introducedBy: id(4), qualifier: { type: 'zone-mount', zone: id(2),
      routeSegment: `mount-${index}`, key: 'id', disclosure: 'public' },
  }));
  const cost = newCost();
  const stored = await recordTree(objects).apply(await recordTree(objects).empty(cost),
    new Map(records.map(record => [record.occurrence, record])), cost);
  const ordered = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(records.map(record => [orderTreeKey(record as Required<Pick<OccurrenceRecord, 'parent' | 'segmentKey' | 'orderKey'>>),
      { occurrence: record.occurrence, parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey! }])), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: id(1), structureOf: id(2),
    profile: 'zone-navigation', generation: id(3), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: stored, order: ordered, placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const hash = await objects.put(new TextEncoder().encode(JSON.stringify(manifest)));
  const header: CompositionHeader = { structure: id(1), component: id(2), owner: id(2), profile: 'zone-navigation',
    head: id(4), mainVersion: id(2), work: id(2), generation: id(3), placementCount: count,
    manifest: `urn:rezics:sha256:${hash}` };
  const snapshot: CompositionSnapshot = { header, revision: header.head, predecessor: null, manifest,
    objects, sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '7' }, cost: newCost() };
  const env = { objectDirectory: '.temp/structure-target-read', lineage: { dataEpoch: 'fixture', routingEpoch: 'fixture' } } as WorkActivationEnvironment;
  return { records, read: (limit: number, canReadTarget: (target: string) => Promise<boolean>) =>
    readCompositionPage(env, { structure: id(1), snapshot, limit, canReadTarget, visible: record => !!record.target }) };
}

test('duplicate mounts consume one current target decision per immutable range', async () => {
  const fixture = await navigation(64);
  let calls = 0;
  const page = await fixture.read(100, async () => {
    if (++calls > 1) throw new Error('target authority read budget exceeded');
    return true;
  });
  expect(page.occurrences.map(record => record.occurrence)).toEqual(fixture.records.map(record => record.occurrence));
  expect(calls).toBe(1);
});

test('short pages do not hydrate targets beyond their visible lookahead', async () => {
  const fixture = await navigation(64, true);
  const checked: string[] = [];
  const page = await fixture.read(1, async target => { checked.push(target); return true; });
  expect(page.occurrences).toHaveLength(1);
  expect(page.next).not.toBeNull();
  expect(checked).toEqual(fixture.records.slice(0, 2).map(record => record.target!));
});

test('target decisions are refreshed for the next immutable range', async () => {
  const fixture = await navigation(202);
  let calls = 0;
  const page = await fixture.read(1, async () => ++calls > 1);
  expect(page.occurrences[0]?.occurrence).toBe(fixture.records[101]!.occurrence);
  expect(calls).toBe(2);
});
