import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ObjectUnavailable, type ImmutableObjects } from '../src/infrastructure/immutable-objects.ts';
import { adjustSubtreeAncestors, changeComposition, checkSubtreeDepth, CompositionConflict,
  compositionChangeDigest, recordTree, StructureSummaryRepairRequired, subtreeHeight, type CompositionOperation }
  from '../src/modules/structure/change.ts';
import { checkStructurePage, InvalidStructureObject, STRUCTURE_LIMITS, STRUCTURE_PAGE_FORMAT,
  STRUCTURE_RECORD_PAGE_FORMAT, STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { CompositionCorrupt, placementIri, rebuildSubtreeLevels, type CompositionHeader, type PlacementState }
  from '../src/modules/structure/graph.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable }
  from '../src/modules/structure/tree.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const levels = (...counts: number[]) => Array.from({ length: STRUCTURE_LIMITS.maxDepth }, (_, i) => counts[i] ?? 0);
const group = (n: number, counts: number[] | undefined = levels()): PlacementState => ({
  occurrence: id(n), placement: placementIri(id(2), id(n)), active: true,
  parent: id(1), role: 'group', introducedBy: id(3),
  ...(counts ? { subtreeLevels: counts } : {}),
});
const record = (n: number, parent: number, role = 'group'): OccurrenceRecord => ({
  occurrence: id(n), state: 'active', parent: id(parent), segmentKey: 'a',
  orderKey: n.toString(36).padStart(4, '0'), role, labels: [], introducedBy: id(3),
  ...(role === 'member' ? { target: id(n + 10_000) } : {}),
});

test('inserting a deeper child updates each ancestor and removing it shortens the subtree', () => {
  const parent = group(4), grandparent = group(5, levels(1));
  adjustSubtreeAncestors([parent, grandparent], [1], 1);
  expect(parent.subtreeLevels).toEqual(levels(1));
  expect(grandparent.subtreeLevels).toEqual(levels(1, 1));
  expect(subtreeHeight(grandparent.subtreeLevels)).toBe(2);

  adjustSubtreeAncestors([parent, grandparent], [1], -1);
  expect(parent.subtreeLevels).toEqual(levels());
  expect(grandparent.subtreeLevels).toEqual(levels(1));
  expect(subtreeHeight(grandparent.subtreeLevels)).toBe(1);
});

test('removing one of several deepest children keeps the remaining branch height', () => {
  const parent = group(4, levels(2)), grandparent = group(5, levels(1, 2));
  adjustSubtreeAncestors([parent, grandparent], [1], -1);
  expect(grandparent.subtreeLevels).toEqual(levels(1, 1));
  expect(subtreeHeight(grandparent.subtreeLevels)).toBe(2);
  adjustSubtreeAncestors([parent, grandparent], [1], -1);
  expect(grandparent.subtreeLevels).toEqual(levels(1));
  expect(subtreeHeight(grandparent.subtreeLevels)).toBe(1);
});

test('cross-parent movement updates both ancestries and shifts the shared ancestor contribution', () => {
  const moved = group(6, levels(3, 1));
  const oldParent = group(4, levels(1, 3, 1));
  const newParent = group(5), intermediate = group(7, levels(1));
  const shared = group(8, levels(2, 2, 3, 1));
  const before = structuredClone(moved.subtreeLevels);
  const contribution = [1, ...moved.subtreeLevels!];

  adjustSubtreeAncestors([oldParent, shared], contribution, -1);
  adjustSubtreeAncestors([newParent, intermediate, shared], contribution, 1);

  expect(oldParent.subtreeLevels).toEqual(levels());
  expect(newParent.subtreeLevels).toEqual(levels(1, 3, 1));
  expect(intermediate.subtreeLevels).toEqual(levels(1, 1, 3, 1));
  expect(shared.subtreeLevels).toEqual(levels(2, 1, 1, 3, 1));
  expect(subtreeHeight(shared.subtreeLevels)).toBe(5);
  expect(moved.subtreeLevels).toEqual(before);
});

test('summary updates depend on ancestry length and height rather than descendant count', () => {
  for (const descendants of [16, 64, 256]) {
    const oldParent = group(4, levels(1, descendants)), newParent = group(5);
    const contribution = [1, ...levels(descendants)];
    adjustSubtreeAncestors([oldParent], contribution, -1);
    adjustSubtreeAncestors([newParent], contribution, 1);
    expect(oldParent.subtreeLevels).toEqual(levels());
    expect(newParent.subtreeLevels).toEqual(levels(1, descendants));
    expect(subtreeHeight(newParent.subtreeLevels)).toBe(2);
  }
});

test('the depth check accepts level sixteen and refuses moving descendants below it', () => {
  expect(() => checkSubtreeDepth(15, 0, STRUCTURE_LIMITS.maxDepth)).not.toThrow();
  expect(() => checkSubtreeDepth(14, 1, STRUCTURE_LIMITS.maxDepth)).not.toThrow();
  expect(() => checkSubtreeDepth(15, 1, STRUCTURE_LIMITS.maxDepth)).toThrow(CompositionConflict);
  expect(() => checkSubtreeDepth(13, 3, STRUCTURE_LIMITS.maxDepth)).toThrow(CompositionConflict);
  expect(() => checkSubtreeDepth(0, 1, 2)).not.toThrow();
  expect(() => checkSubtreeDepth(1, 1, 2)).toThrow(CompositionConflict);
});

test('a legacy subtree requires staged repair and rebuilding produces exact movable summaries', () => {
  const records = [record(4, 1), record(5, 4), record(6, 5, 'member'), record(7, 4, 'member'), record(8, 1)];
  const removed: OccurrenceRecord = { ...record(9, 5, 'member'), state: 'removed', removedBy: id(10) };
  delete removed.segmentKey;
  delete removed.orderKey;
  records.push(removed);
  const legacy = records[0]!;
  expect(() => subtreeHeight(legacy.subtreeLevels)).toThrow(StructureObjectUnavailable);
  expect(() => subtreeHeight(legacy.subtreeLevels)).toThrow('stages');

  rebuildSubtreeLevels(records, id(1), 'collection-membership');
  expect(records[0]!.subtreeLevels).toEqual(levels(2, 1));
  expect(records[1]!.subtreeLevels).toEqual(levels(1));
  expect(records[4]!.subtreeLevels).toEqual(levels());
  expect(removed.subtreeLevels).toBeUndefined();
  expect(records[2]!.subtreeLevels).toBeUndefined();
  expect(subtreeHeight(legacy.subtreeLevels)).toBe(2);
  const target = group(8, [...records[4]!.subtreeLevels!]);
  adjustSubtreeAncestors([target], [1, ...legacy.subtreeLevels!], 1);
  expect(target.subtreeLevels).toEqual(levels(1, 2, 1));

  legacy.subtreeLevels = levels(100);
  rebuildSubtreeLevels(records, id(1), 'collection-membership');
  expect(legacy.subtreeLevels).toEqual(levels(2, 1));
});

test('invalid late ancestry summaries reject atomically before modifying earlier ancestors', () => {
  const first = group(4, levels(1)), missing = group(5);
  delete missing.subtreeLevels;
  const before = structuredClone(first);
  expect(() => adjustSubtreeAncestors([first, missing], [1], 1)).toThrow(StructureObjectUnavailable);
  expect(first).toEqual(before);

  const underflow = group(5);
  expect(() => adjustSubtreeAncestors([first, underflow], [1], -1)).toThrow(StructureObjectCorrupt);
  expect(first).toEqual(before);

  const overflow = group(5, levels(0, STRUCTURE_LIMITS.maxPlacements));
  expect(() => adjustSubtreeAncestors([first, overflow], [1], 1)).toThrow(StructureObjectCorrupt);
  expect(first).toEqual(before);
});

test('contributions exceeding the histogram depth reject without partially changing the ancestry', () => {
  const ancestors = Array.from({ length: STRUCTURE_LIMITS.maxDepth + 1 }, (_, i) => group(i + 4));
  const before = structuredClone(ancestors);
  expect(() => adjustSubtreeAncestors(ancestors, [1], 1)).toThrow(CompositionConflict);
  expect(ancestors).toEqual(before);
});

test('rebuilding rejects legacy cycles and unavailable parents', () => {
  expect(() => rebuildSubtreeLevels([record(4, 5), record(5, 4)], id(1), 'collection-membership'))
    .toThrow(CompositionCorrupt);
  expect(() => rebuildSubtreeLevels([record(4, 99)], id(1), 'collection-membership'))
    .toThrow(CompositionCorrupt);
});

test('summary publication copies affected pages while preserving legacy roots and untouched leaf bytes', async () => {
  const values = new Map<string, Uint8Array>();
  const objects: ImmutableObjects = {
    put: async bytes => {
      const digest = createHash('sha256').update(bytes).digest('hex');
      values.set(digest, bytes.slice());
      return digest;
    },
    get: async digest => {
      const bytes = values.get(digest);
      if (!bytes) throw new ObjectUnavailable('missing retained summary test page');
      return bytes.slice();
    },
  };
  const left = Array.from({ length: STRUCTURE_LIMITS.pageEntries }, (_, i) => record(i + 4, 1));
  const right = record(STRUCTURE_LIMITS.pageEntries + 4, 1);
  const leftBytes = encode({ format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 0, entries: left });
  const rightBytes = encode({ format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 0, entries: [right] });
  const leftPage = `sha256:${await objects.put(leftBytes)}`, rightPage = `sha256:${await objects.put(rightBytes)}`;
  const rootBytes = encode({ format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 1, entries: [
    { page: leftPage, count: left.length, first: left[0]!.occurrence },
    { page: rightPage, count: 1, first: right.occurrence },
  ] });
  const root = { page: `sha256:${await objects.put(rootBytes)}`, level: 1, count: left.length + 1 };
  const originals = new Map([...values].map(([digest, bytes]) => [digest, bytes.slice()]));
  const changed = { ...left[0]!, subtreeLevels: levels() };
  const tree = recordTree(objects);
  const next = await tree.apply(root, new Map([[changed.occurrence, changed]]), newCost());

  expect(next.page).not.toBe(root.page);
  expect(next.count).toBe(root.count);
  for (const [digest, bytes] of originals) expect(await objects.get(digest)).toEqual(bytes);
  expect((await tree.lookup(root, [changed.occurrence], newCost())).get(changed.occurrence)?.subtreeLevels)
    .toBeUndefined();
  expect((await tree.lookup(next, [changed.occurrence], newCost())).get(changed.occurrence)?.subtreeLevels)
    .toEqual(levels());
  const top = checkStructurePage(await objects.get(next.page.slice(7)));
  expect(top.level).toBe(1);
  const children = top.entries as { page: string }[];
  expect(children.some(child => child.page === rightPage)).toBe(true);
  const replacement = children.find(child => child.page !== rightPage)!;
  expect(checkStructurePage(await objects.get(replacement.page.slice(7))).format).toBe(STRUCTURE_RECORD_PAGE_FORMAT);
  expect(() => checkStructurePage(encode({ format: STRUCTURE_PAGE_FORMAT, tree: 'record', level: 0,
    entries: [changed] }))).toThrow(InvalidStructureObject);
});

test('moving a group from an actual legacy retained head refuses repair before any graph or object write', async () => {
  const values = new Map<string, Uint8Array>();
  let objectWrites = 0, graphWrites = 0, currentHead = id(20);
  const objects: ImmutableObjects = {
    put: async bytes => {
      objectWrites++;
      const digest = createHash('sha256').update(bytes).digest('hex');
      values.set(digest, bytes.slice());
      return digest;
    },
    get: async digest => {
      const bytes = values.get(digest);
      if (!bytes) throw new ObjectUnavailable('missing legacy head test page');
      return bytes.slice();
    },
  };
  const structure = id(1), generation = id(2), owner = id(30), component = id(31);
  const records = [record(4, 1), record(5, 1), record(6, 4)];
  const recordDigest = await objects.put(encode({ format: STRUCTURE_PAGE_FORMAT,
    tree: 'record', level: 0, entries: records }));
  const orderDigest = await objects.put(encode({ format: STRUCTURE_PAGE_FORMAT,
    tree: 'order', level: 0, entries: records.map(row => ({ occurrence: row.occurrence,
      parent: row.parent, segmentKey: row.segmentKey!, orderKey: row.orderKey! })) }));
  const manifest: StructureManifest = {
    format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: component,
    profile: 'work-composition', generation, pageFormat: STRUCTURE_PAGE_FORMAT,
    records: { page: `sha256:${recordDigest}`, level: 0, count: records.length },
    order: { page: `sha256:${orderDigest}`, level: 0, count: records.length },
    placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE,
  };
  const manifestDigest = await objects.put(encode(manifest));
  const header: CompositionHeader = { structure, profile: manifest.profile, owner, component,
    work: owner, mainVersion: component, head: currentHead, generation,
    placementCount: records.length, manifest: `urn:rezics:sha256:${manifestDigest}` };
  const before = new Map([...values].map(([digest, bytes]) => [digest, bytes.slice()]));
  objectWrites = 0;

  const queries: string[] = [];
  const binding = (value: string) => ({ type: 'uri', value });
  const env = {
    structureObjects: objects,
    fuseki: {
      query: async (sparql: string) => {
        queries.push(sparql);
        if (sparql.includes('SELECT ?outcome ?reason')) return { results: { bindings: [] } };
        if (sparql.includes('SELECT ?segment ?parent ?key ?count')
          && sparql.includes(`<${placementIri(generation, id(4))}> rv:orderSegment ?segment`)) {
          return { results: { bindings: [{ segment: binding(id(40)), parent: binding(structure),
            key: { type: 'literal', value: 'a' }, count: { type: 'literal', value: '2' } }] } };
        }
        throw new Error(`Unexpected query before legacy repair refusal: ${sparql}`);
      },
      commandWithReceipt: async () => {
        graphWrites++;
        currentHead = id(99);
        throw new Error('Legacy head was mutated before repair');
      },
    },
  } as unknown as WorkActivationEnvironment;
  const operations: CompositionOperation[] = [{ op: 'move', occurrence: id(4),
    parent: id(5), position: 'last' }];
  const profile = structureProfileFor(manifest.profile);
  const failure = await changeComposition(env, {
    structure, expectedHead: header.head, operations, carried: { header, manifest },
    admission: { id: id(50).slice(-36), action: profile.editAction,
      scope: `${profile.editScopePrefix}${owner}`, authorityEpoch: '1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requestDigest: compositionChangeDigest(structure, header.head, operations, manifest.profile) },
  }).then(() => undefined, (error: unknown) => error);

  expect(failure).toBeInstanceOf(StructureSummaryRepairRequired);
  expect((failure as Error).message).toContain('/stages');
  expect(graphWrites).toBe(0);
  expect(objectWrites).toBe(0);
  expect(currentHead).toBe(header.head);
  expect(queries).toHaveLength(2);
  expect(values.size).toBe(before.size);
  for (const [digest, bytes] of before) expect(await objects.get(digest)).toEqual(bytes);
  expect((await recordTree(objects).lookup(manifest.records, [id(4)], newCost()))
    .get(id(4))?.subtreeLevels).toBeUndefined();
});
