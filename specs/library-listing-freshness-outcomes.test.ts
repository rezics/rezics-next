import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LibraryListingFreshnessDriver } from './library-listing-freshness-driver.ts';

setDefaultTimeout(240_000);
let driver: LibraryListingFreshnessDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_LISTING_FRESHNESS_DRIVER;
  if (!location) throw new Error('Library listing freshness outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_LISTING_FRESHNESS_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_LISTING_FRESHNESS_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryListingFreshnessDriver !== 'function')
    throw new Error('Expected createLibraryListingFreshnessDriver factory');
  driver = await binding.createLibraryListingFreshnessDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});

async function fixture(visibility: 'public' | 'private' | 'unlisted' = 'public', copies = 1) {
  const subjectId = await driver.provisionSubject();
  const collection = await driver.provisionCollection({ subjectId, visibility, copies, note: 'PRIVATE MEMBER NOTE' });
  return { subjectId, collectionId: collection.id, memberIds: collection.memberIds };
}
async function count(subjectId: string, value: number) {
  const state = await driver.inspect(subjectId);
  expect(state.listings[0]?.publicCollectionCount ?? 0).toBe(value);
  expect(state.pairs).toHaveLength(value);
  for (const event of state.events) {
    expect(event.type).toBe('com.rezics.library.subject.listed.v1');
    expect(event.subject).toBe(subjectId);
    expect(event.data).toEqual({ subjectId });
  }
  expect(JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(
    'PRIVATE MEMBER NOTE',
  );
  return state;
}

test('a paused old positive first application cannot restore a pair after a newer private zero', async () => {
  const key = await fixture();
  await driver.sync(key);
  await driver.appendMember(key.collectionId, key.subjectId);
  const pause = await driver.pauseNextObservation(key);
  const old = driver.sync(key);
  try {
    await pause.reached;
    await driver.setVisibility(key.collectionId, 'private');
    await driver.sync(key);
    const withdrawn = await count(key.subjectId, 0);
    expect(withdrawn.versions[0]?.multiplicity).toBe(0);
    await pause.resume();
    expect((await old).status).toBe('stale');
    expect(await driver.inspect(key.subjectId)).toEqual(withdrawn);
  } finally {
    await pause.resume();
    await old;
  }
});

test('first publication followed by private withdrawal fences a positive that never reached the target', async () => {
  const key = await fixture('private');
  await driver.setVisibility(key.collectionId, 'public');
  const pause = await driver.pauseNextObservation(key);
  const first = driver.sync(key);
  try {
    const observed = await pause.reached;
    expect(observed.everPublic).toBe(true);
    expect((await driver.inspect(key.subjectId)).targetRows).toEqual([]);
    await driver.setVisibility(key.collectionId, 'private');
    await driver.sync(key);
    const zero = await count(key.subjectId, 0);
    expect(zero.versions[0]?.multiplicity).toBe(0);
    expect(zero.events).toEqual([]);
    await pause.resume();
    expect((await first).status).toBe('stale');
    expect(await driver.inspect(key.subjectId)).toEqual(zero);
  } finally {
    await pause.resume();
    await first;
  }
});

test('a newer delete zero fences an unknown target pair before an old positive first application', async () => {
  const key = await fixture();
  const old = await driver.observe(key);
  await driver.deleteCollection(key.collectionId);
  const zero = await driver.observe(key);
  expect(zero.everPublic).toBe(true);
  expect(zero.multiplicity).toBe(0);
  await driver.apply(zero);
  expect((await driver.apply(old)).status).toBe('stale');
  expect((await count(key.subjectId, 0)).versions[0]?.stamp).toEqual(zero.stamp);
});

test('duplicate delivery is inert while public private public cycles advance native versions', async () => {
  const key = await fixture('public', 2);
  const first = await driver.observe(key);
  await driver.apply(first);
  const one = await count(key.subjectId, 1);
  expect(one.pairs[0]?.multiplicity).toBe(2);
  await driver.apply(first);
  expect(await driver.inspect(key.subjectId)).toEqual(one);
  await driver.removeMember(key.collectionId, key.memberIds[0]!);
  await driver.sync(key);
  expect((await count(key.subjectId, 1)).pairs[0]?.multiplicity).toBe(1);
  await driver.setVisibility(key.collectionId, 'private');
  const zero = await driver.observe(key);
  await driver.apply(zero);
  await count(key.subjectId, 0);
  await driver.setVisibility(key.collectionId, 'public');
  const newest = await driver.observe(key);
  await driver.apply(newest);
  const final = await count(key.subjectId, 1);
  expect(final.events).toHaveLength(4);
  expect(final.versions[0]?.stamp).toEqual(newest.stamp);
  await driver.apply(zero);
  await driver.apply(first);
  expect(await driver.inspect(key.subjectId)).toEqual(final);
});

test('arbitrary same-source delay and reverse arrivals preserve distinct counts and zero tombstones', async () => {
  const a = await fixture();
  const b = await driver.provisionCollection({ subjectId: a.subjectId, visibility: 'public', copies: 3 });
  const keyB = { subjectId: a.subjectId, collectionId: b.id };
  const oldA = await driver.observe(a);
  const oldB = await driver.observe(keyB);
  await driver.advanceSource(64);
  await driver.setVisibility(a.collectionId, 'unlisted');
  const newA = await driver.observe(a);
  await driver.removeMember(b.id, b.memberIds[0]!);
  const newB = await driver.observe(keyB);
  await driver.apply(newB);
  await driver.apply(newA);
  const final = await count(a.subjectId, 1);
  expect(final.pairs[0]?.multiplicity).toBe(2);
  expect(final.versions).toHaveLength(2);
  await driver.apply(oldB);
  await driver.apply(oldA);
  expect(await driver.inspect(a.subjectId)).toEqual(final);
});

test('partition epoch and Collection member truth share one released authoritative RR client', async () => {
  const key = await fixture();
  await driver.sync(key);
  const trace = await driver.sourceTrace();
  expect(trace.partitionClient).toBe(trace.truthClient);
  expect(trace.isolation).toBe('repeatable read');
  expect(trace.sourceReleasedBeforeTarget).toBe(true);
  expect((await driver.observe(key)).stamp.position).toBe(trace.sourceCommittedPosition);
});

test('moved and unavailable source ownership never becomes a successful withdrawal', async () => {
  const key = await fixture();
  await driver.sync(key);
  const before = await driver.inspect(key.subjectId);
  for (const fault of ['moved', 'unavailable'] as const) {
    await driver.sourceFault(key.collectionId, fault);
    await expect(driver.sync(key)).rejects.toThrow();
    expect(await driver.inspect(key.subjectId)).toEqual(before);
    await driver.sourceFault(key.collectionId, 'clear');
  }
  await driver.setVisibility(key.collectionId, 'private');
  await driver.sync(key);
  await count(key.subjectId, 0);
});

test('equal stamps with different projected payload or source binding abort without partial effects', async () => {
  const key = await fixture();
  const observation = await driver.observe(key);
  await driver.apply(observation);
  const before = await driver.inspect(key.subjectId);
  await expect(driver.apply({ ...observation, multiplicity: 2 })).rejects.toThrow();
  await expect(
    driver.apply({ ...observation, stamp: { ...observation.stamp, partition: observation.stamp.partition ^ 1 } }),
  ).rejects.toThrow();
  expect(await driver.inspect(key.subjectId)).toEqual(before);
});

test('real source commands order bigint positions beyond the safe integer boundary', async () => {
  await driver.initializeSourcePosition(9007199254740992n);
  const key = await fixture();
  const positive = await driver.observe(key);
  await driver.setVisibility(key.collectionId, 'private');
  const zero = await driver.observe(key);
  expect(positive.stamp.position).toBeGreaterThan(9007199254740992n);
  expect(zero.stamp.position).toBe(positive.stamp.position + 1n);
  await driver.apply(zero);
  await driver.apply(positive);
  expect((await count(key.subjectId, 0)).versions[0]?.stamp).toEqual(zero.stamp);
});

test('never-public private and unlisted zeros leave no target holder version receipt or outbox', async () => {
  for (const visibility of ['private', 'unlisted'] as const) {
    const key = await fixture(visibility);
    const observation = await driver.observe(key);
    expect(observation.everPublic).toBe(false);
    expect(observation.multiplicity).toBe(0);
    expect((await driver.sync(key)).status).toBe('unretained');
    const state = await count(key.subjectId, 0);
    expect(state.targetRows).toEqual([]);
    expect(state.versions).toEqual([]);
    expect(state.fences).toEqual([]);
    expect(state.listings).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(state.events).toEqual([]);
  }
});

test('target failure rolls back version pair count and outbox together', async () => {
  const key = await fixture();
  await driver.sync(key);
  await driver.setVisibility(key.collectionId, 'private');
  const zero = await driver.observe(key);
  const before = await driver.inspect(key.subjectId);
  await driver.failNextTargetCommit();
  await expect(driver.apply(zero)).rejects.toThrow();
  expect(await driver.inspect(key.subjectId)).toEqual(before);
  await driver.apply(zero);
  expect((await count(key.subjectId, 0)).versions[0]?.stamp).toEqual(zero.stamp);
});

test('legacy bootstrap learns public evidence without marking private rows and rejects old prepared writers', async () => {
  const legacy = await driver.legacyFixture();
  await driver.activateFreshness();
  expect((await driver.observe(legacy.public)).everPublic).toBe(true);
  for (const key of [legacy.private, legacy.unlisted]) {
    expect((await driver.observe(key)).everPublic).toBe(false);
    await driver.sync(key);
    expect((await driver.inspect(key.subjectId)).targetRows).toEqual([]);
  }
  const before = await driver.inspect(legacy.public.subjectId);
  // Existing positive has multiplicity one: old changed UPDATE and DELETE must both fail.
  await expect(driver.applyUnversioned(legacy.public, 2)).rejects.toThrow();
  await expect(driver.applyUnversioned(legacy.public, 0)).rejects.toThrow();
  expect(await driver.inspect(legacy.public.subjectId)).toEqual(before);
  await driver.setVisibility(legacy.public.collectionId, 'private');
  await driver.sync(legacy.public);
  const zero = await count(legacy.public.subjectId, 0);
  await expect(driver.applyUnversioned(legacy.public, 1)).rejects.toThrow();
  expect(await driver.inspect(legacy.public.subjectId)).toEqual(zero);
});

test('public pages omit tombstones and reverse history pages cover many current and obsolete public pairs', async () => {
  const key = await fixture();
  await driver.sync(key);
  const subjects = [key.subjectId];
  for (let i = 0; i < 30; i++) {
    const subjectId = await driver.provisionSubject();
    subjects.push(subjectId);
    const member = await driver.appendMember(key.collectionId, subjectId);
    await driver.sync({ subjectId, collectionId: key.collectionId });
    if (i % 2 === 0) {
      await driver.removeMember(key.collectionId, member);
      await driver.sync({ subjectId, collectionId: key.collectionId });
      expect(await driver.publicPage(subjectId, null, 7)).toEqual([]);
    }
  }
  const found: string[] = [];
  let after: string | null = null;
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(10);
    const page = await driver.reverseHistoryPage(key.collectionId, after, 7);
    expect(page.examined).toBeLessThanOrEqual(7);
    expect(page.rows.length).toBeLessThanOrEqual(7);
    found.push(...page.rows.map((row) => row.subjectId));
    if (page.next === null) break;
    expect(page.next).not.toBe(after);
    after = page.next;
  }
  expect(found.sort()).toEqual(subjects.sort());
  expect(new Set(found).size).toBe(31);
});

test('native apply and bounded public pages keep fixed work as unrelated current and obsolete histories grow', async () => {
  const key = await fixture();
  for (const axis of ['unrelated', 'current_public_pairs', 'obsolete_public_pairs'] as const) {
    const samples = [];
    for (const scale of [1, 4, 16]) {
      await driver.seed(key.subjectId, scale, axis);
      await driver.appendMember(key.collectionId, key.subjectId);
      const measured = await driver.measure(async () => {
        await driver.sync(key);
        return driver.publicPage(key.subjectId, null, 7);
      });
      expect(measured.value.length).toBeLessThanOrEqual(7);
      expect(measured.sequentialRelations).toEqual([]);
      samples.push(measured);
    }
    const base = samples[0]!;
    expect(base.statements).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(sample.statements).toBe(base.statements);
      expect(sample.rows).toBeLessThanOrEqual(base.rows + 8);
      expect(sample.buffers).toBeLessThanOrEqual(base.buffers * 4 + 128);
    }
  }
});
