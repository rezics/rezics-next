import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Fixture, Kind, LibraryDeletionDriver, Reply, Surface, Target } from './library-deletion-driver.ts';

setDefaultTimeout(240_000);
let driver: LibraryDeletionDriver;
beforeEach(async () => {
  const location = process.env.LIBRARY_DELETION_DRIVER;
  if (!location) throw new Error('Library deletion outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('LIBRARY_DELETION_DRIVER must be absolute or a file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('LIBRARY_DELETION_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createLibraryDeletionDriver !== 'function')
    throw new Error('Expected createLibraryDeletionDriver factory');
  driver = await binding.createLibraryDeletionDriver();
});
afterEach(async () => {
  const current = driver;
  driver = undefined!;
  await current?.close();
});
const kinds: Kind[] = ['entry', 'copy', 'member', 'collection', 'label', 'assignment', 'log'];
const surfaces: Surface[] = [
  'point',
  'entries',
  'state',
  'everything',
  'continue',
  'search',
  'item-list',
  'sitemap',
  'public-pairs',
  'feed',
];
const day = 24 * 60 * 60 * 1000;
const at = (time: string, days: number) => new Date(Date.parse(time) + days * day).toISOString();
function success<T>(reply: Reply<T>): T {
  expect(reply.response.status).toBeGreaterThanOrEqual(200);
  expect(reply.response.status).toBeLessThan(300);
  expect(reply.value).toBeDefined();
  return reply.value!;
}
function denied(reply: Reply<unknown>) {
  expect([401, 403, 404]).toContain(reply.response.status);
  expect(reply.value).toBeUndefined();
}
async function hidden(f: Fixture) {
  for (const actor of ['owner', 'other', 'anonymous', 'suspended'] as const) {
    for (const surface of surfaces) {
      const reply = await driver.read(actor, surface, f);
      expect(await reply.response.clone().text()).not.toContain(f.marker);
      if (reply.response.ok) expect(success(reply).items.map((row) => row.id)).not.toContain(f.target.id);
      else expect([401, 403, 404]).toContain(reply.response.status);
    }
  }
}
async function deleted(f: Fixture, key = 'delete'): Promise<Target> {
  const row = success(await driver.delete('owner', f.target, key));
  expect(row.id).toBe(f.target.id);
  expect(row.incarnation).toBe(f.target.incarnation);
  expect(row.revision).toBeGreaterThan(f.target.revision);
  expect(row.deletedAt).not.toBeNull();
  expect(Date.parse(row.restoreUntil!) - Date.parse(row.deletedAt!)).toBe(30 * day);
  return row;
}
function sameValues(before: Target, after: Target) {
  expect(after.id).toBe(before.id);
  expect(after.incarnation).toBe(before.incarnation);
  expect(after.values).toEqual(before.values);
  expect(after.profilePin).toEqual(before.profilePin);
  expect(after.deletedAt).toBeNull();
  expect(after.restoreUntil).toBeNull();
  expect(after.revision).toBeGreaterThan(before.revision);
}

test('first-scope owned Library records hide on delete restore within thirty days and purge only through bounded authorized lifecycle', async () => {
  for (const kind of kinds) {
    const f = await driver.seed(kind, { visibility: 'public' });
    expect(success(await driver.read('owner', f.primary, f)).items.map((row) => row.id)).toContain(f.target.id);
    const tombstone = await deleted(f);
    await hidden(f); // BEFORE projection workers run
    expect(success(await driver.deletionState('owner', tombstone)).values).toEqual(f.target.values);
    const retained = await driver.inspect(f);
    expect(retained.target?.values).toEqual(f.target.values); // default delete never physically purges
    await driver.setTime(at(tombstone.deletedAt!, 29));
    sameValues(f.target, success(await driver.restore('owner', tombstone, 'undo')));
  }
});

test('other anonymous and suspended actors cannot delete restore read retained payload or use receipt replay', async () => {
  for (const kind of kinds) {
    const f = await driver.seed(kind);
    const before = await driver.inspect(f);
    for (const actor of ['other', 'anonymous', 'suspended'] as const)
      denied(await driver.delete(actor, f.target, 'delete'));
    expect(await driver.inspect(f)).toEqual(before);
    const tombstone = await deleted(f);
    const after = await driver.inspect(f);
    for (const actor of ['other', 'anonymous', 'suspended'] as const) {
      denied(await driver.delete(actor, f.target, 'delete'));
      denied(await driver.restore(actor, tombstone, 'undo'));
      denied(await driver.deletionState(actor, tombstone));
      if (kind === 'entry' || kind === 'copy' || kind === 'label' || kind === 'assignment')
        denied(await driver.reference(actor, tombstone));
    }
    expect(await driver.inspect(f)).toEqual(after);
  }
});

test('public references expose only tombstone identity and private existence stays concealed', async () => {
  for (const kind of ['collection', 'member', 'log'] as const) {
    const f = await driver.seed(kind, { visibility: 'public' });
    const tombstone = await deleted(f);
    expect(success(await driver.reference('anonymous', tombstone))).toEqual({
      id: tombstone.id,
      kind,
      state: 'deleted',
    });
  }
  const f = await driver.seed('collection', { visibility: 'private' });
  const tombstone = await deleted(f);
  denied(await driver.reference('other', tombstone));
  denied(await driver.reference('anonymous', tombstone));
});

test('authorized same-key delete and restore replay once but current revocation precedes receipt lookup', async () => {
  const f = await driver.seed('copy');
  const tombstone = await deleted(f);
  const once = await driver.inspect(f);
  expect(success(await driver.delete('owner', f.target, 'delete'))).toEqual(tombstone);
  expect(await driver.inspect(f)).toEqual(once);
  const restored = success(await driver.restore('owner', tombstone, 'undo'));
  const undone = await driver.inspect(f);
  expect(success(await driver.restore('owner', tombstone, 'undo'))).toEqual(restored);
  expect(await driver.inspect(f)).toEqual(undone);
  await driver.revokeOwner();
  denied(await driver.delete('owner', f.target, 'delete'));
  denied(await driver.restore('owner', tombstone, 'undo'));
  denied(await driver.deletionState('owner', tombstone));
  expect(await driver.inspect(f)).toEqual(undone);
});

test('exact kernel day-thirty rejects undo even when a legal hold has prevented purge', async () => {
  for (const kind of kinds) {
    const f = await driver.seed(kind);
    const tombstone = await deleted(f);
    await driver.legalHold(tombstone, true);
    await driver.setTime(tombstone.restoreUntil!);
    const before = await driver.inspect(f);
    expect((await driver.restore('owner', tombstone, 'too-late')).response.status).toBe(409);
    expect((await driver.inspect(f)).target).toEqual(before.target);
    await hidden(f);
  }
});

test('replacement ordinal name and capacity collisions and stale CAS never overwrite newer facts or allocate another identity', async () => {
  for (const [kind, collision] of [
    ['entry', 'replacement'],
    ['member', 'ordinal'],
    ['member', 'capacity'],
    ['label', 'name'],
    ['assignment', 'capacity'],
  ] as const) {
    const f = await driver.seed(kind);
    const tombstone = await deleted(f);
    const replacement = await driver.createConflict(f, collision);
    const before = await driver.inspect(f);
    expect((await driver.restore('owner', tombstone, 'conflict')).response.status).toBe(409);
    expect(
      (await driver.delete('owner', { ...replacement, revision: replacement.revision - 1 }, 'stale')).response.status,
    ).toBe(409);
    expect(await driver.inspect(f)).toEqual(before);
  }
});

test('profile absence allows clearing and exact pinned undo but rejects new profiled values', async () => {
  for (const kind of ['entry', 'copy'] as const) {
    const f = await driver.seed(kind);
    await driver.removeCurrentProfile(f);
    const newValue = await driver.writeNewProfiledValue(f);
    expect([400, 409, 422]).toContain(newValue.response.status);
    const tombstone = await deleted(f);
    sameValues(f.target, success(await driver.restore('owner', tombstone, 'pinned-undo')));
  }
});

test('automatic due purge needs no platform grant and explicit early purge cannot borrow delete authority', async () => {
  for (const kind of ['entry', 'copy', 'label', 'assignment'] as const) {
    const f = await driver.seed(kind);
    const tombstone = await deleted(f);
    denied(await driver.earlyPurge('owner', tombstone, 'early'));
    denied(await driver.earlyPurge('other', tombstone, 'early'));
    expect((await driver.inspect(f)).target?.values).toEqual(f.target.values);
    await driver.setTime(at(tombstone.restoreUntil!, -1 / day));
    await driver.drain();
    expect((await driver.inspect(f)).target).not.toBeNull();
    await driver.setTime(tombstone.restoreUntil!);
    await driver.drain(); // no purge call, platform action, or account deletion
    const purged = await driver.inspect(f);
    expect(purged.target).toBeNull();
    expect(purged.rows.filter((row) => row.id === f.target.id)).toEqual([]);
    expect(JSON.stringify([purged.rows, purged.evidence])).not.toContain(f.marker);
    const trace = await driver.trace();
    expect(trace.committed.length).toBeGreaterThan(0);
    for (const page of trace.committed) {
      expect(page.guard.earlyGrant).toBe(false);
      expect(Date.parse(page.guard.time)).toBeGreaterThanOrEqual(Date.parse(page.guard.dueAt));
    }
  }
  const f = await driver.seed('copy');
  const tombstone = await deleted(f);
  expect((await driver.earlyPurge('platform', tombstone, 'explicit')).response.ok).toBe(true);
  await driver.drain();
  expect((await driver.inspect(f)).target).toBeNull();
});

test('legal hold rechecks at destructive commit and release makes due work runnable without renewed disclosure', async () => {
  const f = await driver.seed('copy');
  const tombstone = await deleted(f);
  const pause = await driver.holdNextPurge();
  await driver.setTime(tombstone.restoreUntil!);
  await pause.reached;
  await driver.legalHold(tombstone, true);
  await pause.resume();
  await driver.drain();
  expect((await driver.inspect(f)).target?.values).toEqual(f.target.values);
  await hidden(f);
  await driver.legalHold(tombstone, false);
  await driver.drain();
  expect((await driver.inspect(f)).target).toBeNull();
});

test('purge preserves safe public skeleton references and never decrements visible aggregates twice', async () => {
  for (const kind of ['collection', 'member', 'log'] as const) {
    const f = await driver.seed(kind, { visibility: 'public' });
    const tombstone = await deleted(f);
    await driver.drain();
    const hiddenState = await driver.inspect(f);
    await driver.setTime(tombstone.restoreUntil!);
    await driver.drain();
    const purged = await driver.inspect(f);
    expect(purged.target).toBeNull();
    expect(purged.rows.some((row) => row.id === f.target.id)).toBe(true);
    expect(JSON.stringify([purged.rows, purged.evidence])).not.toContain(f.marker);
    expect(purged.publicCollectionCount).toBe(hiddenState.publicCollectionCount);
    expect(purged.pairs).toEqual(hiddenState.pairs);
    expect(success(await driver.reference('anonymous', tombstone))).toEqual({
      id: tombstone.id,
      kind,
      state: 'deleted',
    });
    await hidden(f);
  }
  const f = await driver.seed('member', { visibility: 'public', duplicateSibling: true });
  const before = await driver.inspect(f);
  await deleted(f);
  await driver.drain();
  expect((await driver.inspect(f)).publicCollectionCount).toBe(before.publicCollectionCount);
});

test('stale positive projection and old page cursor cannot resurrect deletion or replace restored generation', async () => {
  const f = await driver.seed('collection', { visibility: 'public' });
  const page = success(await driver.read('owner', 'item-list', f));
  expect(page.next).not.toBeNull();
  const positive = await driver.observe(f);
  const tombstone = await deleted(f);
  await driver.apply(positive);
  await hidden(f);
  const zero = await driver.observe(f);
  const restored = success(await driver.restore('owner', tombstone, 'undo'));
  await driver.apply(await driver.observe(f));
  const before = await driver.inspect(f);
  await driver.apply(zero);
  await driver.apply(positive);
  expect((await driver.inspect(f)).pairs).toEqual(before.pairs);
  expect((await driver.inspect(f)).target).toEqual(restored);
  const stale = await driver.read('owner', 'item-list', f, page.next!);
  expect(stale.response.status).toBe(409);
});

test('restoring a private fact fences its parked stale purge before private state reopens', async () => {
  const f = await driver.seed('copy');
  const pause = await driver.holdNextPurge('after-durable-capture');
  const tombstone = await deleted(f);
  await pause.reached;
  await hidden(f);
  await driver.setTime(at(tombstone.deletedAt!, 29));
  const restoration = success(await driver.restore('owner', tombstone, 'undo-parked-private-fact'));
  expect(restoration.id).toBe(f.target.id);
  expect(restoration.deletedAt).toBeNull();
  await driver.setTime(tombstone.restoreUntil!);
  await pause.resume();
  await driver.drain();
  expect((await driver.inspect(f)).target?.values).toEqual(f.target.values);
  expect(success(await driver.read('owner', f.primary, f)).items.map((row) => row.id)).toContain(f.target.id);
});

test('account retention freezes completed public A discards pending B and erases unlisted private deleted and log payload', async () => {
  const f = await driver.retentionFixture();
  expect(f.erased.length).toBeGreaterThanOrEqual(5);
  const deletion = await driver.accountDelete();
  for (const erased of f.erased) await hidden(erased);
  const retained = await driver.retained(f.public);
  expect(retained.subjectIds).toEqual(f.generationA);
  expect(retained.subjectIds).not.toContain(f.pendingOnlyId);
  expect(Object.keys(retained.attribution).sort()).toEqual(['id', 'kind', 'state']);
  expect(retained.attribution.state).toBe('deleted');
  await driver.setTime(at(deletion.deletedAt, 30));
  await driver.drain();
  for (const erased of f.erased) {
    const state = await driver.inspect(erased);
    expect(state.target).toBeNull();
    expect(JSON.stringify([state.rows, state.evidence])).not.toContain(erased.marker);
  }
  const after = await driver.retained(f.public);
  expect(after.subjectIds).toEqual(f.generationA);
  expect(after.generation).toBe(retained.generation);
  expect(after.privateSource).toBeNull();
  expect(JSON.stringify(after)).not.toContain(f.privateSourceMarker);
});

test('child before parent pages recover rollback and commit before enqueue without duplicate effects or broad scans', async () => {
  for (const point of ['before-commit', 'after-commit-before-enqueue'] as const) {
    const f = await driver.seed('log', { historyRows: 257 });
    const deletion = await driver.accountDelete();
    await driver.crashNext(point);
    await driver.setTime(at(deletion.deletedAt, 30));
    await driver.restart();
    await driver.drain();
    const trace = await driver.trace();
    expect(trace.committed.length).toBeGreaterThan(3);
    expect(new Set(trace.committed.map((p) => p.transactionId)).size).toBe(trace.committed.length);
    for (const page of trace.committed) {
      expect(page.sourceLimit).toBeGreaterThan(0);
      expect(page.sourceLimit).toBeLessThanOrEqual(100);
      expect(page.examinedKeys.length).toBeLessThanOrEqual(page.sourceLimit);
      expect(page.effects).toBeLessThanOrEqual(100);
      expect(page.bytes).toBeLessThanOrEqual(trace.pageByteLimit);
      expect(page.guard.generation).toBe(page.generation);
      expect(page.guard.held).toBe(false);
      if (page.examinedKeys.length) expect(page.after).toBe(page.examinedKeys.at(-1)!);
    }
    const phases = trace.committed.map((p) => p.phase);
    expect(phases.lastIndexOf('session-children')).toBeLessThan(phases.indexOf('session-parent'));
    expect(phases).toContain('session-children');
    expect(phases).toContain('session-parent');
    expect((await driver.inspect(f)).target).toBeNull();
    expect(
      (await driver.inspect(f)).rows.filter((row) => /progress_(unit|change|session|head)/.test(row.relation)),
    ).toEqual([]);
  }
});

test('real SQL examined rows blocks and statements stay bounded at three legal geometric populations', async () => {
  const samples: { rows: number; blocks: number; statements: number }[] = [];
  for (const scale of [256, 1024, 4096]) {
    const f = await driver.growthSeed(scale);
    const tombstone = await deleted(f);
    await driver.setTime(tombstone.restoreUntil!);
    await driver.drain();
    const pages = (await driver.trace()).committed;
    expect(pages.length).toBeGreaterThan(0);
    const page = pages[0]!;
    expect(page.sourceLimit).toBeLessThanOrEqual(100);
    expect(page.examinedKeys.length).toBeGreaterThan(0);
    expect(page.examinedKeys.length).toBeLessThanOrEqual(page.sourceLimit);
    expect(page.rowsExamined).toBeGreaterThanOrEqual(page.examinedKeys.length);
    expect(page.rowsExamined).toBeLessThanOrEqual(1200); // fixed page plus indexed guard/evidence work
    expect(page.sharedBlocks).toBeGreaterThan(0);
    expect(page.statements).toBeGreaterThan(0);
    expect(page.index).not.toBe('');
    expect(page.plan).not.toBeNull();
    expect(page.sourceSql).not.toMatch(/\bOFFSET\b/i);
    if (page.selection === 'partial-due-pending-index') expect(page.indexDefinition).toMatch(/\bWHERE\b/i);
    else expect(page.selection).toBe('source-page-before-filter');
    samples.push({ rows: page.rowsExamined, blocks: page.sharedBlocks, statements: page.statements });
    expect((await driver.inspect(f)).target).toBeNull(); // held predecessors cannot starve it
  }
  expect(Math.max(...samples.map((s) => s.rows))).toBeLessThanOrEqual(Math.min(...samples.map((s) => s.rows)) + 100);
  expect(new Set(samples.map((s) => s.statements)).size).toBe(1);
  expect(samples[2]!.blocks).toBeLessThanOrEqual(samples[0]!.blocks * 4); // 16x population, fixed page
});
