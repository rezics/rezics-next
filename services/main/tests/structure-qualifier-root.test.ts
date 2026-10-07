import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects }
  from '../src/infrastructure/immutable-objects.ts';
import { orderTree, recordTree } from '../src/modules/structure/change.ts';
import { derivedId, orderTreeKey } from '../src/modules/structure/graph.ts';
import { STRUCTURE_MANIFEST_FORMAT, STRUCTURE_PAGE_FORMAT, STRUCTURE_PROFILE,
  type OccurrenceRecord, type StructureManifest } from '../src/modules/structure/format.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable, newCost }
  from '../src/modules/structure/tree.ts';
import { StructureQualifierRootStore, qualifierKeyPrefix, qualifierKeyTree, qualifierSourceRoot,
  resolvePreparedQualifierKeys } from '../src/modules/structure/qualifier-index.ts';

const id = (name: string) => derivedId(`qualifier-root:${name}`);
const structure = id('structure'), zone = id('zone'), revision = id('revision');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function memoryObjects() {
  const retained = new Map<string, Uint8Array>();
  const reads: Array<{ digest: string; bytes: number; tree?: string }> = [];
  const objects: ImmutableObjects = {
    put: async bytes => { const digest = sha(bytes); retained.set(digest, bytes.slice()); return digest; },
    get: async digest => {
      const bytes = retained.get(digest);
      if (!bytes) throw new ObjectUnavailable('Missing retained fixture object');
      if (sha(bytes) !== digest) throw new ObjectIntegrityError('Fixture digest differs');
      reads.push({ digest, bytes: bytes.length, tree: JSON.parse(new TextDecoder().decode(bytes)).tree });
      return bytes.slice();
    },
  };
  return { objects, retained, reads };
}

function mount(index: number): OccurrenceRecord {
  return { occurrence: id(`occurrence:${index}`), state: 'active', parent: structure,
    segmentKey: 'a', orderKey: index.toString(36), role: 'mount', target: id(`target:${index}`),
    labels: [], introducedBy: revision,
    qualifier: { type: 'zone-mount', zone, routeSegment: `route-${index}`, disclosure: 'public' } };
}

async function retainedManifest(objects: ImmutableObjects, count: number): Promise<StructureManifest> {
  const records = Array.from({ length: count }, (_, index) => mount(index));
  const cost = newCost(), recordsTree = recordTree(objects), ordered = orderTree(objects);
  return { format: STRUCTURE_MANIFEST_FORMAT, structure, structureOf: zone, profile: 'zone-navigation',
    generation: id('generation'), pageFormat: STRUCTURE_PAGE_FORMAT,
    records: await recordsTree.apply(await recordsTree.empty(cost),
      new Map(records.map(record => [record.occurrence, record])), cost),
    order: await ordered.apply(await ordered.empty(cost), new Map(records.map(record => {
      const entry = { parent: record.parent, segmentKey: record.segmentKey!, orderKey: record.orderKey!,
        occurrence: record.occurrence };
      return [orderTreeKey(entry), entry];
    })), cost), placementCount: count, measures: [], model: STRUCTURE_PROFILE, shape: STRUCTURE_PROFILE };
}

type Row = {
  manifest_digest: string; source_root: string; source: Record<string, unknown>;
  progress: { sourceRoot: string; after: string | null; visited: number;
    root: { page: string; level: number; count: number } };
  version: string; complete: boolean; batch_limit: number;
};
const copy = <T>(value: T): T => structuredClone(value);

/** Models the private table's primary key and compare-and-swap predicates,
 * including acknowledgement failures before and after the write. */
function checkpointPool() {
  const rows = new Map<string, Row>(), queries: Array<{ sql: string; values: unknown[] }> = [];
  let failUpdate: 'before' | 'after' | undefined;
  let failRefinementAck = false, lostRefinementAcks = 0;
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values: copy(values) });
    if (sql.startsWith('SELECT')) {
      const selected = sql.includes('WHERE manifest_digest = $1')
        ? [rows.get(String(values[0]))].filter((row): row is Row => row !== undefined)
        : [...rows.values()].sort((left, right) => left.manifest_digest.localeCompare(right.manifest_digest));
      return { rows: copy(selected), rowCount: selected.length };
    }
    if (sql.startsWith('INSERT')) {
      expect(sql).toContain('ON CONFLICT (manifest_digest) DO NOTHING');
      const key = String(values[0]);
      if (!rows.has(key)) rows.set(key, { manifest_digest: key, source_root: String(values[1]),
        source: copy(values[2]) as Row['source'], progress: copy(values[3]) as Row['progress'],
        version: '0', complete: false, batch_limit: 256 });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE')) {
      expect(sql).toContain('version = $2 AND NOT complete AND source_root = $5');
      expect(sql).toContain('batch_limit = $6');
      let failure = failUpdate; failUpdate = undefined;
      if (failure === 'before') throw new Error('Checkpoint transaction rolled back');
      const key = String(values[0]), row = rows.get(key);
      if (!row || row.version !== String(values[1]) || row.complete || row.source_root !== values[4]) {
        return { rows: [], rowCount: 0 };
      }
      if (failRefinementAck && Number(values[5]) < row.batch_limit) {
        failure = 'after'; failRefinementAck = false; lostRefinementAcks++;
      }
      row.progress = copy(values[2]) as Row['progress']; row.complete = values[3] as boolean;
      row.batch_limit = values[5] as number;
      row.version = String(BigInt(row.version) + 1n);
      if (failure === 'after') throw new Error('Committed acknowledgement was lost');
      return { rows: [copy(row)], rowCount: 1 };
    }
    throw new Error(`Unexpected qualifier checkpoint SQL: ${sql}`);
  } } as unknown as Pool;
  return { pool, rows, queries, failNextUpdate: (failure: 'before' | 'after') => { failUpdate = failure; },
    loseNextRefinementAcknowledgement: () => { failRefinementAck = true; },
    lostRefinementAcknowledgements: () => lostRefinementAcks };
}

async function fixture(count: number) {
  const retained = memoryObjects(), database = checkpointPool();
  const manifest = await retainedManifest(retained.objects, count), original = encode(manifest);
  const digest = await retained.objects.put(original);
  const store = new StructureQualifierRootStore(database.pool, retained.objects);
  retained.reads.length = 0;
  return { ...retained, ...database, manifest, original, digest, store };
}

test('legacy lookup requires the exact completed private checkpoint and never guesses empty coverage', async () => {
  const f = await fixture(257), environment = { structureQualifierRoots: f.store };
  expect(await f.store.read(f.digest)).toBeNull();
  await expect(resolvePreparedQualifierKeys(undefined, f.digest, f.manifest))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
  await expect(resolvePreparedQualifierKeys(environment, f.digest, f.manifest))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
  const partial = await f.store.prepare(f.digest);
  expect(partial.complete).toBe(false); expect(partial.progress.visited).toBe(256);
  await expect(resolvePreparedQualifierKeys(environment, f.digest, f.manifest))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
  const complete = await f.store.prepare(f.digest);
  expect(complete.complete).toBe(true); expect(complete.progress.visited).toBe(257);
  f.queries.length = 0;
  const refined = await resolvePreparedQualifierKeys(environment, f.digest, f.manifest);
  expect(refined.format).toBe('rezics-structure-manifest-v2');
  expect(refined).toMatchObject({ qualifierKeys: { sourceRoot: qualifierSourceRoot(f.manifest) } });
  expect(f.queries).toHaveLength(1);
  expect(f.queries[0]!.sql).toContain('WHERE manifest_digest = $1');
  expect(f.queries[0]!.values).toEqual([f.digest]);
  expect(encode(f.manifest)).toEqual(f.original);
  expect(f.retained.get(f.digest)).toEqual(f.original);
  expect(f.manifest).not.toHaveProperty('qualifierKeys');
  await expect(resolvePreparedQualifierKeys(environment, '0'.repeat(64), f.manifest))
    .rejects.toBeInstanceOf(StructureObjectUnavailable);
});

test('authenticated empty and 256-record EOF complete while 257-record lookahead stays partial', async () => {
  for (const count of [0, 256, 257]) {
    const f = await fixture(count), checkpoint = await f.store.prepare(f.digest);
    expect(checkpoint.batchLimit).toBe(256);
    expect(checkpoint.complete).toBe(count <= 256);
    expect(checkpoint.progress.visited).toBe(Math.min(count, 256));
    expect(checkpoint.progress.root.count).toBe(Math.min(count, 256));
    expect(checkpoint.progress.after === null).toBe(count === 0);
    expect(f.reads.some(read => read.tree === 'order')).toBe(false);
    if (count === 257) expect(await f.store.completedQualifierKeys(f.digest, f.manifest)).toBeNull();
    else expect(await f.store.completedQualifierKeys(f.digest, f.manifest))
      .toMatchObject({ root: { count } });
  }
});

test('trusted turns resume after restart with at most 256 new records and bounded object cost', async () => {
  const f = await fixture(1025);
  let priorVisited = 0, turns = 0, checkpoint;
  do {
    f.reads.length = 0;
    const reopened = new StructureQualifierRootStore(f.pool, f.objects);
    checkpoint = await reopened.prepare(f.digest); turns++;
    expect(checkpoint.progress.visited - priorVisited).toBeLessThanOrEqual(256);
    expect(checkpoint.progress.visited).toBeGreaterThan(priorVisited);
    expect(f.reads.some(read => read.tree === 'order')).toBe(false);
    expect(f.reads.length).toBeLessThanOrEqual(160);
    expect(f.reads.reduce((bytes, read) => bytes + read.bytes, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
    priorVisited = checkpoint.progress.visited;
  } while (!checkpoint.complete);
  expect(turns).toBe(5); expect(checkpoint.progress.visited).toBe(1025);
  expect(checkpoint.progress.root.count).toBe(1025);
  const prefix = qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'route-1024' });
  expect((await qualifierKeyTree(f.objects).range(checkpoint.progress.root,
    prefix, `${prefix}\uffff`, 2, newCost())).map(entry => entry.occurrence)).toEqual([mount(1024).occurrence]);
  const retainedVersion = checkpoint.version;
  expect((await f.store.prepare(f.digest)).version).toBe(retainedVersion);
});

test('trusted preparation refines oversized turns and completes a growing distributed-key index', async () => {
  const started = Date.now(), f = await fixture(25_001);
  f.loseNextRefinementAcknowledgement();
  let prior = await f.store.prepare(f.digest), refinements = 0, turns = 1, racedRefinement = false;
  expect(prior.progress.visited).toBe(256); expect(prior.batchLimit).toBe(256);
  expect(f.reads.length).toBeLessThanOrEqual(160);
  expect(f.reads.reduce((bytes, read) => bytes + read.bytes, 0)).toBeLessThanOrEqual(4 * 1024 * 1024);
  while (!prior.complete) {
    f.reads.length = 0;
    const resume = async () => {
      let pages = 0, bytes = 0;
      const objects: ImmutableObjects = { put: f.objects.put, get: async digest => {
        const value = await f.objects.get(digest); pages++; bytes += value.length; return value;
      } };
      const next = await new StructureQualifierRootStore(f.pool, objects).prepare(f.digest);
      expect(pages).toBeLessThanOrEqual(160);
      expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      return next;
    };
    const race = prior.progress.visited >= 10_000 && prior.batchLimit === 256;
    const attempts = race ? await Promise.all([resume(), resume()]) : [await resume()];
    const next = attempts[0]!; turns++;
    if (race) expect(attempts[1]).toEqual(next);
    const delta = next.progress.visited - prior.progress.visited;
    expect(next.version).toBe(String(BigInt(prior.version) + 1n));
    expect(delta).toBeGreaterThanOrEqual(0);
    expect(delta).toBeLessThanOrEqual(prior.batchLimit);
    expect(next.batchLimit).toBeLessThanOrEqual(prior.batchLimit);
    if (delta === 0) {
      refinements++;
      if (race) racedRefinement = true;
      expect(next.batchLimit).toBe(Math.max(1, Math.floor(prior.batchLimit / 2)));
      expect(next.batchLimit).toBeLessThan(prior.batchLimit);
      expect(next.progress).toEqual(prior.progress);
      expect(next.complete).toBe(false);
      expect(await f.store.completedQualifierKeys(f.digest, f.manifest)).toBeNull();
    } else expect(next.batchLimit).toBe(prior.batchLimit);
    expect(f.reads.some(read => read.tree === 'order')).toBe(false);
    expect(turns).toBeLessThanOrEqual(25_010);
    prior = next;
  }
  expect(refinements).toBeGreaterThan(0);
  expect(racedRefinement).toBe(true);
  expect(f.lostRefinementAcknowledgements()).toBe(1);
  expect(prior.progress.visited).toBe(25_001); expect(prior.progress.root.count).toBe(25_001);
  expect(await f.store.completedQualifierKeys(f.digest, f.manifest)).toMatchObject({ root: { count: 25_001 } });
  const prefix = qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'route-25000' });
  expect((await qualifierKeyTree(f.objects).range(prior.progress.root,
    prefix, `${prefix}\uffff`, 2, newCost())).map(entry => entry.occurrence)).toEqual([mount(25_000).occurrence]);
  const absent = qualifierKeyPrefix({ type: 'zone-mount', zone, routeSegment: 'absent' });
  expect(await qualifierKeyTree(f.objects).range(prior.progress.root, absent, `${absent}\uffff`, 2, newCost()))
    .toEqual([]);
  expect(f.retained.get(f.digest)).toEqual(f.original);
  expect(Date.now() - started).toBeLessThan(600_000);
}, 120_000);

test('concurrent turns use one CAS winner and a lost acknowledgement resumes the committed checkpoint', async () => {
  const f = await fixture(513);
  const attempts = await Promise.all([f.store.prepare(f.digest), f.store.prepare(f.digest)]);
  expect(attempts.map(checkpoint => checkpoint.version)).toEqual(['1', '1']);
  expect(attempts.map(checkpoint => checkpoint.progress.visited)).toEqual([256, 256]);
  f.failNextUpdate('after');
  const acknowledged = await f.store.prepare(f.digest);
  expect(acknowledged.version).toBe('2'); expect(acknowledged.progress.visited).toBe(512);
  expect(acknowledged.complete).toBe(false);
  const complete = await new StructureQualifierRootStore(f.pool, f.objects).prepare(f.digest);
  expect(complete.version).toBe('3'); expect(complete.progress.visited).toBe(513);
  expect(complete.complete).toBe(true);
  expect(f.rows.size).toBe(1);
});

test('a rolled back checkpoint leaves its old trusted cursor and retries the same turn', async () => {
  const f = await fixture(257), before = await f.store.prepare(f.digest);
  f.failNextUpdate('before');
  await expect(f.store.prepare(f.digest)).rejects.toThrow('Checkpoint transaction rolled back');
  expect(await f.store.read(f.digest)).toEqual(before);
  const completed = await f.store.prepare(f.digest);
  expect(completed.progress.visited).toBe(257); expect(completed.version).toBe('2');
  expect(completed.complete).toBe(true);
});

test('preparation authenticates original SHA independently of an object adapter and rejects unavailable sources', async () => {
  const f = await fixture(1);
  const falseAdapter: ImmutableObjects = { put: f.objects.put, get: async () => f.original };
  await expect(new StructureQualifierRootStore(f.pool, falseAdapter).prepare('0'.repeat(64)))
    .rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.rows.size).toBe(0);
  f.retained.delete(f.digest);
  await expect(f.store.prepare(f.digest)).rejects.toBeInstanceOf(StructureObjectUnavailable);
  expect(f.rows.size).toBe(0);
  await expect(f.store.prepare(`sha256:${f.digest}`)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.queries).toHaveLength(0);
});

test('checkpoint source roots and cursor counts remain bound to the authenticated source', async () => {
  const f = await fixture(257), before = await f.store.prepare(f.digest);
  const row = f.rows.get(f.digest)!;
  row.batch_limit = 0;
  await expect(f.store.read(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.batch_limit = before.batchLimit;
  row.progress.visited = 257;
  await expect(f.store.prepare(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.progress = copy(before.progress);
  row.progress.after = id('absent-record');
  await expect(f.store.prepare(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.progress = copy(before.progress);
  row.progress.root.count--;
  await expect(f.store.prepare(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.progress = copy(before.progress);
  row.progress.root.count = row.progress.visited + 1;
  await expect(f.store.read(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.progress = copy(before.progress);
  row.source_root = `sha256:${'0'.repeat(64)}`;
  await expect(f.store.read(f.digest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  row.source_root = before.sourceRoot;
  await expect(f.store.completedQualifierKeys(f.digest,
    { ...f.manifest, generation: id('other-generation') })).rejects.toBeInstanceOf(StructureObjectCorrupt);
  const badSource = { ...f.manifest, records: { ...f.manifest.records, count: 256 } };
  const badDigest = await f.objects.put(encode(badSource));
  await expect(f.store.prepare(badDigest)).rejects.toBeInstanceOf(StructureObjectCorrupt);
  expect(f.rows.has(badDigest)).toBe(false);
});

test('missing and corrupt retained checkpoint pages fail closed without publishing complete coverage', async () => {
  for (const failure of ['missing', 'corrupt'] as const) {
    const f = await fixture(257), before = await f.store.prepare(f.digest);
    const page = before.progress.root.page.slice(7), original = f.retained.get(page)!;
    if (failure === 'missing') f.retained.delete(page);
    else f.retained.set(page, encode({ corrupt: true }));
    await expect(f.store.prepare(f.digest)).rejects.toBeInstanceOf(failure === 'missing'
      ? StructureObjectUnavailable : StructureObjectCorrupt);
    expect(await f.store.read(f.digest)).toEqual(before);
    expect(await f.store.completedQualifierKeys(f.digest, f.manifest)).toBeNull();
    f.retained.set(page, original);
    expect((await f.store.prepare(f.digest)).complete).toBe(true);
  }
});

test('custody captures both partial and completed mappings under original manifest identity', async () => {
  const f = await fixture(257), partial = await f.store.prepare(f.digest);
  const empty = await retainedManifest(f.objects, 0), emptyDigest = await f.objects.put(encode(empty));
  const complete = await f.store.prepare(emptyDigest);
  const retained = await f.store.retainedRoots();
  expect(retained).toHaveLength(2);
  expect(retained).toEqual([partial, complete].sort((left, right) => left.manifestDigest.localeCompare(right.manifestDigest)));
  expect(retained.map(root => root.manifestDigest).sort()).toEqual([f.digest, emptyDigest].sort());
  expect(retained.find(root => root.manifestDigest === f.digest)!.progress.root).toEqual(partial.progress.root);
});

test('private custody outages keep legacy refinement unavailable', async () => {
  const f = await fixture(0);
  await expect(resolvePreparedQualifierKeys({ structureQualifierRoots: {
    completedQualifierKeys: async () => { throw new Error('Content owner unavailable'); },
  } }, f.digest, f.manifest)).rejects.toBeInstanceOf(StructureObjectUnavailable);
});
