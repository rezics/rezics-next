import { afterAll, expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createScopePreparationStore } from '../../src/search/scope-preparation-store.ts';
import { cleanupConceptBrowses, createConceptBrowseStore } from '../../src/search/concept-browse-store.ts';
import {
  advanceConceptBrowse, currentConceptMembership, startConceptBrowse,
  type ConceptBrowseSource, type ConceptBrowseState,
} from '../../src/search/concept-browse.ts';

// Real retained storage under the landing runner's isolated, migrated database.
// The graph port is deliberately local: this suite does not certify native source completeness or cost.
const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());
const binding = {
  release: 'release', graph: 'graph', scheme: 'scheme', membership: 'membership', principal: 'reader', request: 'request',
};
const selection = { property: 'schema:keywords', concept: 'root', scheme: 'scheme', includeChildren: true } as const;
async function fixture() {
  const prefix = `concept-${randomUUID().slice(0, 8)}-`, id = randomBytes(32).toString('hex');
  let clock = Date.now();
  const expiresAt = clock + 60000, deadline = clock + 30000;
  const options = { expiresAt, clock: () => clock };
  const reader = createConceptBrowseStore(pool, prefix, id, options);
  const initial = (await startConceptBrowse(selection, binding, reader))!;
  const plans = createScopePreparationStore(pool, prefix);
  const claim = await plans.claim(id, initial.retained.revision, deadline);
  expect(claim).not.toBeNull();
  const writer = createConceptBrowseStore(pool, prefix, id, { ...options, leaseUntil: deadline });
  return {
    prefix, id, reader, writer, plans, deadline, expiresAt,
    state: { ...initial, retained: { id, revision: claim!.revision } } as ConceptBrowseState,
    expire: () => { clock = expiresAt + 1; },
  };
}

test('root seeding owns the definition before awaiting storage', async () => {
  const id = randomBytes(32).toString('hex');
  const store = createConceptBrowseStore(pool, `concept-${randomUUID().slice(0, 8)}-`, id, {
    expiresAt: Date.now() + 60000,
  });
  const mutable = { ...selection, concept: String(selection.concept) };
  const creating = store.create(mutable, binding);
  mutable.concept = 'changed';
  const retained = await creating;
  expect(await store.read({ version: 2, selection, binding, retained })).toEqual({
    status: 'building', next: { parent: 'root', after: null },
  });
});

test('complete closure above 64 survives interruption, cycles and replay without reenqueuing visited vertices', async () => {
  const f = await fixture();
  const children = Array.from({ length: 140 }, (_, n) => `child-${String(n).padStart(3, '0')}`);
  const sought = new Map<string, number>();
  const source: ConceptBrowseSource = {
    observe: async () => ({ status: 'current', binding }),
    children: async ({ parent, after, limit }) => {
      sought.set(parent, (sought.get(parent) ?? 0) + 1);
      const edges = parent === 'root' ? children : ['root', 'child-000'];
      const start = after === null ? 0 : Number(after), end = Math.min(start + limit, edges.length);
      return { status: 'current', page: {
        binding, children: edges.slice(start, end), examined: end - start,
        after: end === start ? after : String(end).padStart(6, '0'), hasMore: end < edges.length,
      } };
    },
  };
  let state = f.state;
  expect(await f.reader.contains(state, 'root')).toBeNull();
  expect(await f.writer.seal(state)).toBeNull();
  const first = await advanceConceptBrowse(source, f.writer, state, { pages: 1, edges: 64, pageSize: 64 });
  expect(first.status).toBe('preparing');
  if (first.status !== 'preparing') throw new Error('Expected retained preparation');
  expect(await f.writer.advance(state, { parent: 'root', after: null }, {
    children: ['uncommitted'], after: null, exhausted: true,
  })).toBeNull();
  state = first.state;
  await f.writer.checkpoint(state, 0);
  const interrupted = await f.plans.read(f.id);
  const resumed = await f.plans.claim(f.id, interrupted!.revision, f.deadline);
  state = { ...state, retained: { id: f.id, revision: resumed!.revision } };
  for (let step = 0; step < 40; step++) {
    const result = await advanceConceptBrowse(source, f.writer, state, { pages: 4, edges: 256, pageSize: 64 });
    if (result.status !== 'complete' && result.status !== 'preparing') throw new Error(result.status);
    state = result.state;
    if (result.status === 'complete') break;
  }
  expect(await f.reader.read(state)).toEqual({ status: 'complete' });
  for (const key of ['root', children[0]!, children.at(-1)!])
    expect(await currentConceptMembership(source, f.reader, state, key)).toBe(true);
  expect(await currentConceptMembership(source, f.reader, state, 'absent')).toBe(false);
  expect(await f.reader.contains(state, 'uncommitted')).toBe(false);
  expect(sought.get('root')).toBe(3);
  expect([...sought.entries()].filter(([key]) => key !== 'root').every(([, count]) => count === 1)).toBe(true);
  expect(await f.reader.contains({ ...state, binding: { ...binding, release: 'changed' } }, 'root')).toBeNull();
  expect(await currentConceptMembership({ ...source, observe: async () => ({ status: 'unavailable' }) }, f.reader, state, 'absent'))
    .toBe('not_proven');
  expect(await f.reader.contains(state, 'root')).toBeNull();
});

test('one worker CAS wins; a stale retirement or checkpoint cannot change its successor', async () => {
  const f = await fixture();
  const delta = { children: ['a', 'a', 'root'], after: '001', exhausted: false };
  const results = await Promise.all([
    f.writer.advance(f.state, { parent: 'root', after: null }, delta),
    f.writer.advance(f.state, { parent: 'root', after: null }, delta),
  ]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const state = { ...f.state, retained: results.find((value) => value !== null)! };
  await f.writer.retire(f.state);
  await f.writer.checkpoint(f.state, 30000);
  expect((await f.reader.read(state)).status).toBe('building');
  expect(await f.writer.advance({ ...state, selection: { ...selection, concept: 'foreign' } }, {
    parent: 'root', after: '001',
  }, { children: ['foreign'], after: null, exhausted: true })).toBeNull();
  await expect(f.reader.advance(state, { parent: 'root', after: '001' }, delta)).rejects.toThrow('lease');
  f.expire();
  await expect(f.writer.seal(state)).rejects.toThrow('lease');
  expect(await f.reader.read(state)).toEqual({ status: 'retired' });
});

test('expiry immediately disables evidence; retirement cleanup is bounded and tombstones reject locator reuse', async () => {
  const f = await fixture();
  const children = Array.from({ length: 256 }, (_, n) => `key-${n}`);
  const next = await f.writer.advance(f.state, { parent: 'root', after: null }, {
    children, after: '256', exhausted: true,
  });
  const state = { ...f.state, retained: next! };
  f.expire();
  expect(await f.reader.contains(state, 'root')).toBeNull();
  expect(await cleanupConceptBrowses(pool, f.prefix, f.expiresAt + 1)).toBe(256);
  expect(await cleanupConceptBrowses(pool, f.prefix, f.expiresAt + 1)).toBe(256);
  expect(await cleanupConceptBrowses(pool, f.prefix, f.expiresAt + 1)).toBe(1);
  expect(await cleanupConceptBrowses(pool, f.prefix, f.expiresAt + 1)).toBe(0);
  const tombstone = await f.plans.read(f.id);
  expect(tombstone).toMatchObject({ state: 'retained', frontier: { kind: 'concept', cleaned: true } });
  await expect(createConceptBrowseStore(pool, f.prefix, f.id, { expiresAt: Date.now() + 60000 })
    .create(selection, binding)).rejects.toThrow('changed or expired');
});
