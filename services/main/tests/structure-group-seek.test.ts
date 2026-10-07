import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { captureObjectRecoveryCoverage, ObjectRecoveryConflict }
  from '../src/modules/owner/object-coverage.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { checkStructureManifest, InvalidStructureObject, STRUCTURE_MANIFEST_FORMAT,
  STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE, type OccurrenceRecord, type StructureManifest }
  from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { newCost } from '../src/modules/structure/tree.ts';
import { GRAPHS } from '../src/modules/work/activate.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function retainedGroupFixture() {
  const values = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = { put: async bytes => {
    const digest = createHash('sha256').update(bytes).digest('hex');
    values.set(digest, bytes.slice());
    return digest;
  }, get: async digest => {
    const bytes = values.get(digest);
    if (!bytes) throw new ObjectUnavailable('missing retained object');
    return bytes.slice();
  } };
  const cost = newCost();
  const group: OccurrenceRecord = { occurrence: id(10), state: 'active', parent: id(1),
    segmentKey: 'a', orderKey: 'a', role: 'group', labels: [], introducedBy: id(4) };
  const chapter: OccurrenceRecord = { occurrence: id(11), state: 'active', parent: id(1),
    segmentKey: 'a', orderKey: 'b', role: 'chapter', target: id(12),
    selection: { mode: 'fixed-revision', revision: 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000013' },
    labels: [], introducedBy: id(4) };
  const entry = (record: OccurrenceRecord) => ({ parent: record.parent, segmentKey: record.segmentKey!,
    orderKey: record.orderKey!, occurrence: record.occurrence });
  const tree = orderTree(objects);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: id(1),
    structureOf: id(2), profile: 'book-composition', generation: id(3), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordTree(objects).apply(await recordTree(objects).empty(cost),
      new Map([group, chapter].map(record => [record.occurrence, record])), cost),
    order: await tree.apply(await tree.empty(cost),
      new Map([group, chapter].map(record => [orderTreeKey(entry(record)), entry(record)])), cost),
    topGroups: await tree.apply(await tree.empty(cost),
      new Map([[orderTreeKey(entry(group)), entry(group)]]), cost), placementCount: 2,
    measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const digest = await objects.put(encode(manifest));
  const graph = { query: async (query: string) => {
    const uri = (value: string) => ({ type: 'uri', value });
    if (query.includes('SELECT ?graph ?subject ?manifest')) return { results: { bindings: [{
      graph: uri(GRAPHS.revisions), subject: uri(id(4)), manifest: uri(`urn:rezics:sha256:${digest}`),
    }] } };
    const field = query.includes('rv:component') ? manifest.structure : STRUCTURE_PROFILE;
    return { results: { bindings: [{ graph: uri(GRAPHS.revisions), subject: uri(id(4)), value: uri(field) }] } };
  } } as unknown as FusekiClient;
  return { manifest, digest, values, objects, graph };
}

test('Retained group-only pages are included in recovery closure and missing pages hold recovery', async () => {
  const f = await retainedGroupFixture();
  // The group-only leaf differs from the all-role leaf: omitting it from
  // custody traversal would silently produce a backup that cannot number.
  expect(f.manifest.topGroups!.page).not.toBe(f.manifest.order.page);
  const retained = new Set<string>();
  const store = { directory: '.temp/group-recovery', structureObjects: f.objects,
    // This in-memory inline-root fixture has no supplemental Content rows.
    structureGroupRoots: { retainedRoots: async () => [] },
    structureQualifierRoots: { retainedRoots: async () => [] } };
  await expect(captureObjectRecoveryCoverage(f.graph, { ...store, structureQualifierRoots: undefined }))
    .rejects.toThrow('Structure supplemental custody owner is unavailable');
  const coverage = await captureObjectRecoveryCoverage(f.graph,
    store, retained);
  expect(retained.has(f.manifest.topGroups!.page.slice(7))).toBe(true);
  expect(coverage.objectCount).toBe('4');
  f.values.delete(f.manifest.topGroups!.page.slice(7));
  await expect(captureObjectRecoveryCoverage(f.graph,
    store)).rejects.toBeInstanceOf(ObjectRecoveryConflict);
});

test('Optional group roots preserve legacy manifest bytes and reject impossible counts', async () => {
  const f = await retainedGroupFixture();
  const { topGroups, ...legacy } = f.manifest;
  const bytes = encode(legacy), digest = await f.objects.put(bytes);
  expect(checkStructureManifest(await f.objects.get(digest))).toEqual(legacy);
  expect(checkStructureManifest(await f.objects.get(digest)).topGroups).toBeUndefined();
  expect(await f.objects.get(digest)).toEqual(bytes);
  expect(() => checkStructureManifest(encode({ ...f.manifest,
    topGroups: { ...topGroups, count: f.manifest.order.count + 1 } }))).toThrow(InvalidStructureObject);
});
