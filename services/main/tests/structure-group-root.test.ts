import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type OrderEntry, type StructureManifest } from '../src/modules/structure/format.ts';
import { orderTreeKey } from '../src/modules/structure/graph.ts';
import { StructureGroupRootStore, type GroupRootCheckpoint } from '../src/modules/structure/group-root.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable }
  from '../src/modules/structure/tree.ts';

const groupRootId = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const groupRootBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

class CountedGroupRootObjects implements ImmutableObjects {
  readonly values = new Map<string, Uint8Array>();
  gets = 0;
  bytes = 0;
  async put(bytes: Uint8Array): Promise<string> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    this.values.set(digest, bytes.slice());
    return digest;
  }
  async get(digest: string): Promise<Uint8Array> {
    this.gets++;
    const bytes = this.values.get(digest);
    if (!bytes) throw new ObjectUnavailable('missing preparation object');
    this.bytes += bytes.byteLength;
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new ObjectIntegrityError('preparation object digest differs');
    }
    return bytes.slice();
  }
  reset() { this.gets = 0; this.bytes = 0; }
}

const groupRootRecord = (n: number, at: number, group = false): OccurrenceRecord => ({
  occurrence: groupRootId(n), state: 'active', parent: groupRootId(1),
  segmentKey: 'a', orderKey: at.toString(36).padStart(8, '0'),
  role: group ? 'group' : 'chapter', labels: [], introducedBy: groupRootId(4),
  ...(group ? { qualifier: { type: 'book-group' as const, division: 'volume' as const } }
    : { target: groupRootId(n + 100_000), selection: { mode: 'follow-context' as const } }),
});

async function groupRootFixture(chapters = 10_000) {
  const objects = new CountedGroupRootObjects();
  const chaptersPlaced = Array.from({ length: chapters }, (_, i) => groupRootRecord(i + 1000, (i + 1) * 10));
  const groups = [groupRootRecord(10, 5, true), groupRootRecord(11, Math.floor(chapters / 2) * 10 + 5, true),
    groupRootRecord(12, chapters * 10 + 5, true)];
  const records = [...chaptersPlaced, ...groups];
  const cost = newCost();
  const recordRoot = await recordTree(objects).apply(await recordTree(objects).empty(cost),
    new Map(records.map(record => [record.occurrence, record])), cost);
  const entries: OrderEntry[] = records.map(record => ({ occurrence: record.occurrence, parent: record.parent,
    segmentKey: record.segmentKey!, orderKey: record.orderKey! }));
  const orderRoot = await orderTree(objects).apply(await orderTree(objects).empty(cost),
    new Map(entries.map(entry => [orderTreeKey(entry), entry])), cost);
  const manifest: StructureManifest = { format: STRUCTURE_MANIFEST_FORMAT, structure: groupRootId(1),
    structureOf: groupRootId(2), profile: 'book-composition', generation: groupRootId(3),
    pageFormat: STRUCTURE_PAGE_FORMAT, records: recordRoot, order: orderRoot,
    placementCount: records.length, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
  const originalBytes = groupRootBytes(manifest);
  const manifestDigest = await objects.put(originalBytes);
  objects.reset();
  return { objects, records, groups, manifest, manifestDigest, originalBytes };
}

interface GroupRootRow {
  manifest_digest: string; structure: string; records: GroupRootCheckpoint['records'];
  ordering: GroupRootCheckpoint['order']; total: number; cursor: string | null;
  scanned: number; groups: GroupRootCheckpoint['groups']; version: string; complete: boolean;
}

/** Minimal committed-row visibility and compare-and-swap model. PostgreSQL
 * admission triggers, transaction races and recovery are covered in integration. */
class MemoryGroupRootRows {
  readonly checkpoints = new Map<string, GroupRootRow>();
  loseNextUpdateAcknowledgement = false;
  updateCalls = 0;
  readonly pool = { query: async (sql: string, parameters: unknown[] = []) => {
    const rows = (row: GroupRootRow | undefined) => ({ rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 });
    const digest = parameters[0] as string;
    if (sql.trimStart().startsWith('INSERT INTO structure.group_root')) {
      if (!this.checkpoints.has(digest)) this.checkpoints.set(digest, {
        manifest_digest: digest, structure: parameters[1] as string,
        records: parameters[2] as GroupRootRow['records'], ordering: parameters[3] as GroupRootRow['ordering'],
        total: parameters[4] as number, groups: parameters[5] as GroupRootRow['groups'],
        cursor: null, scanned: 0, version: '0', complete: false,
      });
      return { rows: [], rowCount: 0 };
    }
    if (sql.trimStart().startsWith('UPDATE structure.group_root')) {
      this.updateCalls++;
      const current = this.checkpoints.get(digest);
      if (!current || current.complete || current.version !== String(parameters[1])) return rows(undefined);
      const next: GroupRootRow = { ...current, groups: parameters[2] as GroupRootRow['groups'],
        cursor: parameters[3] as string | null, scanned: parameters[4] as number,
        complete: parameters[5] as boolean, version: (BigInt(current.version) + 1n).toString() };
      this.checkpoints.set(digest, structuredClone(next));
      if (this.loseNextUpdateAcknowledgement) {
        this.loseNextUpdateAcknowledgement = false;
        throw new Error('update acknowledgement lost after commit');
      }
      return rows(next);
    }
    if (sql.trimStart().startsWith('SELECT ') && sql.includes('FROM structure.group_root')) {
      if (sql.includes('ORDER BY manifest_digest')) return {
        rows: [...this.checkpoints.values()].sort((a, b) => a.manifest_digest.localeCompare(b.manifest_digest)).map(row => structuredClone(row)),
        rowCount: this.checkpoints.size,
      };
      const row = this.checkpoints.get(digest);
      return rows(sql.includes('AND complete') && !row?.complete ? undefined : row);
    }
    throw new Error(`Unexpected checkpoint operation: ${sql}`);
  } } as unknown as Pool;
}

// Checkpoint SQL is exercised by the PostgreSQL integration test. This row
// driver models committed checkpoint visibility for the immutable-I/O tests.

test('Legacy group preparation reads at most 256 placements per turn and publishes only the complete exact source', async () => {
  const f = await groupRootFixture();
  const rows = new MemoryGroupRootRows();
  let store = new StructureGroupRootStore(rows.pool, f.objects);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
  let checkpoint = await store.prepare(f.manifestDigest);
  expect(f.objects.gets).toBeLessThanOrEqual(30);
  expect(f.objects.bytes).toBeLessThan(2_000_000);
  expect(checkpoint.scanned).toBe(256);
  expect(checkpoint.total).toBe(10_003);
  expect(checkpoint.complete).toBe(false);
  expect(checkpoint.manifestDigest).toBe(f.manifestDigest);
  expect(checkpoint.records).toEqual(f.manifest.records);
  expect(checkpoint.order).toEqual(f.manifest.order);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
  expect((await store.retainedRoots()).map(root => root.manifestDigest)).toEqual([f.manifestDigest]);
  let turns = 1;
  while (!checkpoint.complete) {
    const prior = checkpoint;
    f.objects.reset();
    // A new owner instance resumes only the committed checkpoint, not a process cache.
    store = new StructureGroupRootStore(rows.pool, f.objects);
    checkpoint = await store.prepare(f.manifestDigest);
    expect(checkpoint.scanned - prior.scanned).toBeGreaterThan(0);
    expect(checkpoint.scanned - prior.scanned).toBeLessThanOrEqual(256);
    expect(f.objects.gets).toBeLessThanOrEqual(30);
    expect(f.objects.bytes).toBeLessThan(2_000_000);
    if (!checkpoint.complete) expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
    expect(++turns).toBeLessThanOrEqual(40);
  }
  expect(turns).toBe(40);
  expect(checkpoint.scanned).toBe(checkpoint.total);
  expect(checkpoint.groups.count).toBe(3);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toEqual(checkpoint.groups);
  const groups = await orderTree(f.objects).range(checkpoint.groups,
    `${f.manifest.structure}\u0001`, `${f.manifest.structure}\u0002`, 4, newCost());
  expect(groups.map(entry => entry.occurrence)).toEqual(f.groups.map(group => group.occurrence));
  expect(await f.objects.get(f.manifestDigest)).toEqual(f.originalBytes);
  expect(createHash('sha256').update(await f.objects.get(f.manifestDigest)).digest('hex')).toBe(f.manifestDigest);
  const reopened = new StructureGroupRootStore(rows.pool, f.objects);
  expect(await reopened.read(f.manifestDigest)).toEqual(checkpoint);
  expect(await reopened.prepare(f.manifestDigest)).toEqual(checkpoint);
  expect(await reopened.retainedRoots()).toEqual([checkpoint]);
});

test('Legacy group preparation refuses order/record mismatches without advancing a checkpoint', async () => {
  for (const missing of [false, true]) {
    const f = await groupRootFixture(1000);
    const first = f.groups[0]!;
    const records = await recordTree(f.objects).apply(f.manifest.records,
      new Map([[first.occurrence, missing ? null : { ...first, orderKey: 'zzzzzzzz' }]]), newCost());
    const broken = { ...f.manifest, records };
    const digest = await f.objects.put(groupRootBytes(broken));
    const rows = new MemoryGroupRootRows();
    const store = new StructureGroupRootStore(rows.pool, f.objects);
    await expect(store.prepare(digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
    const checkpoint = await store.read(digest);
    expect(checkpoint?.scanned ?? 0).toBe(0);
    expect(checkpoint?.complete ?? false).toBe(false);
    expect(await store.completedTopGroups(digest, broken)).toBeNull();
    expect(await f.objects.get(digest)).toEqual(groupRootBytes(broken));
  }
});

test('A missing preparation page and an expired deadline cannot publish an incomplete group root', async () => {
  const f = await groupRootFixture(1000);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const pending = await store.prepare(f.manifestDigest);
  expect(pending.complete).toBe(false);
  const orderDigest = f.manifest.order.page.slice(7);
  const original = f.objects.values.get(orderDigest)!;
  f.objects.values.delete(orderDigest);
  await expect(store.prepare(f.manifestDigest)).rejects.toBeInstanceOf(StructureObjectUnavailable);
  expect(await store.read(f.manifestDigest)).toEqual(pending);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
  f.objects.values.set(orderDigest, original);
  await expect(store.prepare(f.manifestDigest, { checkDeadline: () => { throw new Error('preparation deadline'); } }))
    .rejects.toThrow('preparation deadline');
  expect(await store.read(f.manifestDigest)).toEqual(pending);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
});

test('A full final preparation batch stays pending until a bounded EOF confirmation', async () => {
  const f = await groupRootFixture(253);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const full = await store.prepare(f.manifestDigest);
  expect(full.scanned).toBe(256);
  expect(full.scanned).toBe(full.total);
  expect(full.complete).toBe(false);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
  const complete = await new StructureGroupRootStore(rows.pool, f.objects).prepare(f.manifestDigest);
  expect(complete.complete).toBe(true);
  expect(complete.scanned).toBe(full.scanned);
  expect(complete.cursor).toBe(full.cursor);
  expect(complete.groups).toEqual(full.groups);
  expect(BigInt(complete.version)).toBe(BigInt(full.version) + 1n);
});

test('Preparation reloads the committed batch after a lost acknowledgement and resumes without replay', async () => {
  const f = await groupRootFixture(1000);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  rows.loseNextUpdateAcknowledgement = true;
  const acknowledged = await store.prepare(f.manifestDigest);
  expect(acknowledged.scanned).toBe(256);
  expect(acknowledged.version).toBe('1');
  expect(await store.read(f.manifestDigest)).toEqual(acknowledged);
  const resumed = await new StructureGroupRootStore(rows.pool, f.objects).prepare(f.manifestDigest);
  expect(resumed.scanned).toBe(512);
  expect(resumed.version).toBe('2');
  expect(acknowledged.groups.count).toBe(1);
  expect(resumed.groups.count).toBe(2);
});

test('Racing preparation turns return the winning CAS checkpoint and do not double-count a batch', async () => {
  const f = await groupRootFixture(1000);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const raced = await Promise.all([store.prepare(f.manifestDigest),
    new StructureGroupRootStore(rows.pool, f.objects).prepare(f.manifestDigest)]);
  expect(raced[0]).toEqual(raced[1]);
  expect(raced[0]?.scanned).toBe(256);
  expect(raced[0]?.version).toBe('1');
  expect(raced[0]?.groups.count).toBe(1);
  expect(await store.read(f.manifestDigest)).toEqual(raced[0]);
});

test('Completed and pending group roots remain bound to the exact original record and order roots', async () => {
  const f = await groupRootFixture(10);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const completed = await store.prepare(f.manifestDigest);
  expect(completed.complete).toBe(true);
  await expect(store.completedTopGroups(f.manifestDigest, { ...f.manifest, structure: groupRootId(99) }))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(store.completedTopGroups(f.manifestDigest,
    { ...f.manifest, records: { ...f.manifest.records, count: f.manifest.records.count + 1 } }))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  const pendingFixture = await groupRootFixture(1000);
  const pendingStore = new StructureGroupRootStore(rows.pool, pendingFixture.objects);
  const pending = await pendingStore.prepare(pendingFixture.manifestDigest);
  const row = rows.checkpoints.get(pendingFixture.manifestDigest)!;
  rows.checkpoints.set(pendingFixture.manifestDigest, { ...row,
    ordering: { ...row.ordering, count: row.ordering.count - 1 } });
  await expect(pendingStore.prepare(pendingFixture.manifestDigest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  await expect(pendingStore.read(pendingFixture.manifestDigest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(rows.checkpoints.get(pendingFixture.manifestDigest)?.scanned).toBe(pending.scanned);
  expect(rows.checkpoints.get(pendingFixture.manifestDigest)?.version).toBe(pending.version);
  expect(await pendingStore.completedTopGroups(pendingFixture.manifestDigest, pendingFixture.manifest)).toBeNull();
});

test('Malformed source bytes and inconsistent exact counts cannot create a preparation checkpoint', async () => {
  const f = await groupRootFixture(10);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const malformed = await f.objects.put(groupRootBytes({ format: 'unsupported' }));
  const inconsistent = await f.objects.put(groupRootBytes({ ...f.manifest,
    order: { ...f.manifest.order, count: f.manifest.order.count - 1 } }));
  for (const digest of [malformed, inconsistent]) {
    await expect(store.prepare(digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
    expect(await store.read(digest)).toBeNull();
  }
  await expect(store.prepare('invalid digest')).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(rows.checkpoints.size).toBe(0);
});

test('An empty retained Book publishes an empty root only after exact source exhaustion', async () => {
  const f = await groupRootFixture(10);
  const cost = newCost();
  const empty: StructureManifest = { ...f.manifest,
    records: await recordTree(f.objects).empty(cost),
    order: await orderTree(f.objects).empty(cost), placementCount: 0 };
  const bytes = groupRootBytes(empty);
  const digest = await f.objects.put(bytes);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  expect(await store.completedTopGroups(digest, empty)).toBeNull();
  const complete = await store.prepare(digest);
  expect(complete).toMatchObject({ scanned: 0, total: 0, complete: true, cursor: null });
  expect(complete.groups.count).toBe(0);
  expect(await store.completedTopGroups(digest, empty)).toEqual(complete.groups);
  expect(await f.objects.get(digest)).toEqual(bytes);
});

test('Resume rejects an existing source cursor whose rank disagrees with committed scanned progress', async () => {
  const f = await groupRootFixture(1000);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const pending = await store.prepare(f.manifestDigest);
  const advancedRecord = f.records[300]!;
  const advancedCursor = orderTreeKey(advancedRecord as OrderEntry);
  expect((await orderTree(f.objects).lookup(f.manifest.order, [advancedCursor], newCost()))
    .get(advancedCursor)?.occurrence).toBe(advancedRecord.occurrence);
  expect(advancedCursor).not.toBe(pending.cursor);
  const row = rows.checkpoints.get(f.manifestDigest)!;
  const damaged = { ...row, cursor: advancedCursor };
  rows.checkpoints.set(f.manifestDigest, damaged);
  const updates = rows.updateCalls;
  await expect(store.prepare(f.manifestDigest))
    .rejects.toThrow('group preparation cursor differs from its source progress');
  expect(rows.updateCalls).toBe(updates);
  expect(rows.checkpoints.get(f.manifestDigest)).toEqual(damaged);
  expect((await store.read(f.manifestDigest))?.scanned).toBe(pending.scanned);
  expect((await store.read(f.manifestDigest))?.version).toBe(pending.version);
  expect(await store.completedTopGroups(f.manifestDigest, f.manifest)).toBeNull();
});

test('Resume rejects a checkpoint total that differs from the exact source before issuing a CAS', async () => {
  const f = await groupRootFixture(1000);
  const rows = new MemoryGroupRootRows();
  const store = new StructureGroupRootStore(rows.pool, f.objects);
  const pending = await store.prepare(f.manifestDigest);
  const row = rows.checkpoints.get(f.manifestDigest)!;
  // The first total is valid checkpoint metadata but disagrees with the source;
  // the second also exceeds the immutable format's maximum placement count.
  for (const total of [row.total + 1, 1_048_577]) {
    const damaged = { ...row, total };
    rows.checkpoints.set(f.manifestDigest, damaged);
    const updates = rows.updateCalls;
    await expect(store.prepare(f.manifestDigest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
    expect(rows.updateCalls).toBe(updates);
    expect(rows.checkpoints.get(f.manifestDigest)).toEqual(damaged);
    expect(damaged.scanned).toBe(pending.scanned);
    expect(damaged.version).toBe(pending.version);
  }
});
