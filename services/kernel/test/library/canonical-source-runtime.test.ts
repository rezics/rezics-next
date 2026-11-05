import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as store from '../../src/library/canonical-source-store.ts';
import { createCollectionSource } from '../../src/library/collection-source.ts';
import { mintReadTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  canonicalFixture,
  allowance,
  ownerAllowance,
  receipt,
  type CanonicalFixture,
} from './canonical-source-fixture.ts';
let db: GrowthDatabase, f: CanonicalFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await canonicalFixture(db);
});
afterAll(async () => {
  await db?.close();
});
async function context() {
  await f.refresh();
  return {
    actor: f.reader,
    at: await withConnection(db.pool, (client) => mintReadTime(client)),
    deadline: Date.now() + 30000,
  };
}

test('actual store and factory distinguish current empty membership from missing or unfinished coverage', async () => {
  const collection = await f.collection('public');
  expect((await store.readCanonicalSourceState(db.pool, f.call(collection.id))).state).toBe('not_ready');
  const ready = await f.build(collection.id, 1);
  const current = await store.readCanonicalSourceState(db.pool, f.call(collection.id));
  expect(current).toMatchObject({ state: 'ready', generation: ready.generation });
  const api = createCollectionSource({ pool: db.pool, access: f.access }),
    ctx = await context();
  const prepared = await api.prepare({ ...ctx, collectionId: collection.id, allowance: ownerAllowance() });
  const prefix = await api.prefix({
    ...ctx,
    source: prepared.source,
    afterSubjectId: null,
    allowance: ownerAllowance(),
  });
  expect(prefix.candidates).toEqual([]);
  expect(prefix.exhausted).toBe(true);
  const absent = await api.containsSubject({
    ...ctx,
    source: prepared.source,
    subjectId: await f.subject(),
    allowance: ownerAllowance(),
  });
  expect(absent.result).toBe(false);
});

test('native canonical browsing preserves immutable x y x originals and occurrences while returning one card per subject', async () => {
  const collection = await f.collection('public'),
    x = await f.subject(),
    y = await f.subject();
  await f.add(collection.id, x, 'first x');
  await f.add(collection.id, y, 'y');
  await f.add(collection.id, x, 'last x');
  const original = await f.facts(collection.id),
    ready = await f.build(collection.id, 1);
  let afterSubjectId: string | null = null;
  const found: string[] = [];
  for (let page = 0; page < 3; page++) {
    const reserved = allowance(1),
      seek = await store.seekCanonicalSourceGroup(db.pool, {
        ...f.call(collection.id, reserved),
        ...ready,
        afterSubjectId,
      });
    receipt(seek.work, reserved);
    if (seek.state !== 'ready') throw new Error('Actual canonical successor must be ready');
    if (seek.subjectId === null) {
      expect(seek.exhausted).toBe(true);
      break;
    }
    found.push(seek.subjectId);
    afterSubjectId = seek.subjectId;
  }
  expect(found).toEqual([x, y].sort());
  const api = createCollectionSource({ pool: db.pool, access: f.access }),
    ctx = await context();
  const { source } = await api.prepare({ ...ctx, collectionId: collection.id, allowance: ownerAllowance() });
  expect((await api.containsSubject({ ...ctx, source, subjectId: x, allowance: ownerAllowance() })).result).toBe(true);
  expect(
    (await api.readRawStoredPrefix({ ...ctx, source, afterStoredSubjectId: null, allowance: ownerAllowance() }))
      .storedSubjectIds,
  ).toContain(x);
  expect(await f.facts(collection.id)).toEqual(original);
});

test('replay recovers the real native checkpoint and source mutation prevents stale publication', async () => {
  const collection = await f.collection('public');
  for (let n = 0; n < 3; n++) await f.add(collection.id, await f.subject());
  const observed = await store.observeCanonicalSource(db.pool, f.call(collection.id));
  if (observed.state !== 'admitted') throw new Error('Actual current source must be admitted');
  const started = await store.beginCanonicalSourceRepair(db.pool, { ...f.call(collection.id), basis: observed.basis });
  if (started.state !== 'working') throw new Error('Actual native build must start');
  const next = await store.repairCanonicalSourceStep(db.pool, {
    ...f.call(collection.id, allowance(1)),
    basis: observed.basis,
    repair: started.repair,
  });
  if (next.state !== 'working') throw new Error('A bounded native checkpoint must retain further input');
  const recovered = await store.beginCanonicalSourceRepair(db.pool, {
    ...f.call(collection.id),
    basis: observed.basis,
  });
  if (recovered.state !== 'working') throw new Error('Actual committed checkpoint must survive replay');
  expect(recovered.repair).toEqual(next.repair);
  await f.add(collection.id, await f.subject());
  const stale = await store.publishCanonicalSourceRepair(db.pool, {
    ...f.call(collection.id),
    basis: observed.basis,
    repair: next.repair,
  });
  expect(stale.state).toBe('basis_changed');
  await f.build(collection.id, 1);
});

test('hidden originals and redirects use current native original AND terminal disclosure without changing stored references', async () => {
  const collection = await f.collection('public'),
    original = await f.subject(),
    terminal = await f.subject();
  await f.add(collection.id, original, 'stored original');
  const stored = await f.facts(collection.id);
  await f.merge(original, terminal);
  await f.build(collection.id, 1);
  const api = createCollectionSource({ pool: db.pool, access: f.access });
  let ctx = await context(),
    prepared = await api.prepare({ ...ctx, collectionId: collection.id, allowance: ownerAllowance() });
  expect(
    (await api.containsSubject({ ...ctx, source: prepared.source, subjectId: terminal, allowance: ownerAllowance() }))
      .result,
  ).toBe(true);
  await f.hide(original);
  await f.build(collection.id, 1);
  ctx = await context();
  prepared = await api.prepare({ ...ctx, collectionId: collection.id, allowance: ownerAllowance() });
  expect(
    (await api.containsSubject({ ...ctx, source: prepared.source, subjectId: terminal, allowance: ownerAllowance() }))
      .result,
  ).toBe(false);
  expect(await f.facts(collection.id)).toEqual(stored);
});

test('current completed pointer readback matches the published generation against the live basis', async () => {
  const collection = await f.collection('public');
  await f.add(collection.id, await f.subject());
  const ready = await f.build(collection.id, 1);
  const current = await store.readCanonicalSourceState(db.pool, f.call(collection.id));
  expect(current.state).toBe('ready');
  if (current.state !== 'ready') throw new Error('Published generation must be the current completed pointer');
  expect(current.generation).toBe(ready.generation);
  expect(current.basis.digest).toBe(ready.basis.digest);
});
