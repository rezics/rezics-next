import { expect, test } from 'bun:test';
import { admitDiscoveryFilter, parseDiscoveryFilter, parseFilter, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { compileCurrentRealmFilter } from '../../src/search/current-filter-plan.ts';
import {
  createRealmScopeSource,
  type RealmSubjectSource,
  type RealmSubjectMembership,
} from '../../src/search/realm-scope.ts';
import { scopeAllowance, zeroScopeWork } from '../../src/search/scope-execution.ts';
import { createSearchService } from '../../src/search/service.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';
import { createRealmSubjectSource, type RealmSubjectDisclosure } from '../../src/content/realm-subject-source.ts';

const realm = '018f0000-0000-7000-8000-00a000000001';
const other = '018f0000-0000-7000-8000-00a000000002';
const leaf = { realm: { id: realm } };
const release: FilterRelease = { types: { 'schema:Book': {} }, properties: {} };
const allowance = () => scopeAllowance(100, 'realm-test');

// Owner-port protocol tests; these do not certify an installed Content producer,
// native grants, native continuation or successful public Search activation.
function fixture(overrides: Partial<RealmSubjectSource> = {}) {
  let authority: 'current' | 'changed' | 'concealed' = 'current';
  let resolution: 'ready' | 'concealed' | 'unavailable' = 'ready';
  let meaning = 1;
  let memberships: readonly RealmSubjectMembership[] = ['discussed'];
  const resolved: string[] = [];
  const handles = new WeakSet<object>();
  const batches: number[] = [];
  let prefixes = 0;
  const source: RealmSubjectSource = {
    async resolve(id) {
      resolved.push(id);
      const observation = Object.freeze({ realm: id, revision: '1' });
      handles.add(observation);
      return resolution === 'ready' ? { state: 'ready', observation } : { state: resolution };
    },
    async current(observation) {
      return handles.has(observation) ? authority : 'changed';
    },
    async prefix() {
      prefixes++;
      return { subjects: [other], after: other, exhausted: true };
    },
    async match(_observation, subjects) {
      batches.push(subjects.length);
      return subjects.map((_, index) => memberships[index % memberships.length]!);
    },
    ...overrides,
  };
  const scope = createRealmScopeSource({
    pool: {} as Pool,
    reader: { deadline: Date.now() + 60_000 } as LeafOptions,
    source,
    async release() {
      return { digest: String(meaning), release };
    },
  });
  return {
    scope,
    resolved,
    batches,
    prefixes: () => prefixes,
    authority: (value: typeof authority) => {
      authority = value;
    },
    resolution: (value: typeof resolution) => {
      resolution = value;
    },
    meaning: () => {
      meaning++;
    },
    memberships: (value: typeof memberships) => {
      memberships = value;
    },
  };
}

test('Realm is closed and request-only; full tree and expanded saved leaves share admission limits', () => {
  expect(parseDiscoveryFilter(leaf)).toEqual(leaf);
  for (const input of [{ realm: { id: realm, board: other } }, { realm: { id: 'not-a-uuid' } }])
    expect(() => parseDiscoveryFilter(input)).toThrow();
  expect(() => parseFilter(leaf)).toThrow();
  expect(() => parseDiscoveryFilter({ and: Array(33).fill(leaf) })).toThrow();
  expect(() =>
    admitDiscoveryFilter(
      { saved: 'private' },
      {
        ...release,
        filters: { private: { filter: leaf } },
      },
      new Set(),
    ),
  ).toThrow();
  const plan = compileCurrentRealmFilter(parseDiscoveryFilter({ and: [leaf, { not: leaf }] }));
  expect(plan.leaves).toHaveLength(1);
  expect(plan.evaluate(['not_proven'])).toBe('not_proven');
});

test('all Realm resources resolve under NOT and a true catalogue OR before any population read', async () => {
  for (const filter of [{ not: leaf }, { or: [{ type: { in: ['schema:Book'] } }, leaf, { realm: { id: other } }] }]) {
    const f = fixture();
    f.resolution('concealed');
    await expect(f.scope.prepare(parseDiscoveryFilter(filter), allowance())).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(f.resolved).toEqual('or' in filter ? [realm, other] : [realm]);
    expect(f.prefixes()).toBe(0);
  }
  const f = fixture();
  f.resolution('unavailable');
  await expect(f.scope.prepare(leaf, allowance())).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  expect(f.prefixes()).toBe(0);
});

test('native discussed, absent and withheld evidence differ; changed authority or meaning refuses old scope', async () => {
  const f = fixture();
  const { scope } = await f.scope.prepare({ not: leaf }, allowance());
  // A producer may grant a protected board and later withhold its opening post,
  // board or subject reference. Neither withdrawal nor unknown proves complement.
  for (const [membership, expected] of [
    ['discussed', false],
    ['not_published', true],
    ['withheld', 'not_proven'],
    ['unknown', 'not_proven'],
  ] as const) {
    f.memberships([membership]);
    expect((await f.scope.evaluate(scope, [other], allowance())).values).toEqual([expected]);
  }
  f.authority('concealed');
  await expect(f.scope.sourcePrefix(scope, realm, null, 10, allowance())).rejects.toMatchObject({ code: 'not_found' });
  expect(f.prefixes()).toBe(0);
  f.authority('changed');
  await expect(f.scope.evaluate(scope, [other], allowance())).rejects.toMatchObject({ code: 'semantic_not_ready' });
  f.authority('current');
  f.meaning();
  await expect(f.scope.evaluate(scope, [other], allowance())).rejects.toMatchObject({ code: 'semantic_not_ready' });
});

test('Content observation handles survive preparation; opaque raw prefixes retain the native cap', async () => {
  const f = fixture();
  const { scope } = await f.scope.prepare(leaf, allowance());
  expect(scope.readiness).toBe('population_ready');
  const subjects = Array.from({ length: 100 }, () => other);
  expect((await f.scope.evaluate(scope, subjects, allowance())).values).toEqual(subjects.map(() => true));
  expect(f.batches).toEqual([32, 32, 32, 4]);
  await expect(f.scope.sourcePrefix(scope, realm, null, 33, allowance())).rejects.toBeInstanceOf(RangeError);
  expect(f.prefixes()).toBe(0);
  expect((await f.scope.sourcePrefix(scope, realm, null, 32, allowance())).subjects).toEqual([other]);
});

test('unknown and withheld membership cannot establish a tautological Realm OR', async () => {
  const f = fixture();
  const { scope } = await f.scope.prepare({ or: [leaf, { not: leaf }] }, allowance());
  for (const membership of ['unknown', 'withheld'] as const) {
    f.memberships([membership]);
    expect((await f.scope.evaluate(scope, [other], allowance())).values).toEqual(['not_proven']);
  }
});

test('public Search routes a Realm request through its registered service scope and request reader', async () => {
  const reader = { deadline: Date.now() + 60_000 } as LeafOptions;
  const resolved: string[] = [];
  const readers: LeafOptions[] = [];
  const realmSubjects: RealmSubjectSource = {
    async resolve(id, options) {
      resolved.push(id);
      readers.push(options);
      return { state: 'unavailable' };
    },
    async current() {
      return 'current';
    },
    async prefix() {
      return { subjects: [], after: null, exhausted: true };
    },
    async match(_observation, subjects) {
      return subjects.map(() => 'unknown');
    },
  };
  const service = createSearchService({
    pool: {} as Pool,
    client: {} as never,
    prefix: 'realm-reader',
    source: {} as never,
    realmSubjects,
    cursors: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) },
    release: async () => release,
  });
  await expect(
    service.search(
      'anonymous',
      { filter: leaf },
      Date.now(),
      { digest: '1', release },
      { deadline: reader.deadline, scope: reader, complete: async () => {} },
    ),
  ).rejects.toMatchObject({ code: 'semantic_not_ready' });
  expect(resolved).toEqual([realm]);
  expect(readers).toHaveLength(1);
  expect(readers[0]).toBe(reader);
});

test('the Content factory without live composition stays unavailable, including under OR', async () => {
  const reader = { deadline: Date.now() + 60_000 } as LeafOptions;
  const pool = {} as Pool;
  const resolved: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error('Unready native population read');
  };
  const disclosure: RealmSubjectDisclosure = {
    bounds: {
      resolve: zeroScopeWork(),
      current: zeroScopeWork(),
      candidate: zeroScopeWork(),
      subject: zeroScopeWork(),
    },
    async resolve(id) {
      resolved.push(id);
      return { state: 'ready', dependency: id };
    },
    current: unexpected,
    candidate: unexpected,
    subject: unexpected,
  };
  for (const source of [undefined, createRealmSubjectSource({ pool, disclosure })]) {
    const scope = createRealmScopeSource({
      pool,
      reader,
      ...(source ? { source } : {}),
      release: async () => ({ digest: '1', release }),
    });
    await expect(scope.prepare({ or: [leaf, { realm: { id: other } }] }, allowance())).rejects.toMatchObject({
      code: 'semantic_not_ready',
    });
  }
  expect(resolved).toEqual([realm, other]);
});

test('finite refinement advances sparse native input once per step and covers every Realm OR branch', async () => {
  const reads: unknown[] = [];
  const f = fixture({
    async prefix(observation, after, limit, _reader, work) {
      reads.push([observation.realm, after, limit, work.remaining().reservationId]);
      if (observation.realm === realm && after === null)
        return {
          subjects: [],
          after: 'sparse-native-position',
          exhausted: false,
        };
      return { subjects: [other, other], after: null, exhausted: true };
    },
  });
  const { scope } = await f.scope.prepare({ or: [leaf, { realm: { id: other } }] }, allowance());
  const sparse = await f.scope.refinePrefix(scope, null, allowance());
  expect(sparse).toMatchObject({
    readiness: 'refined_input',
    subjects: [],
    exhausted: false,
  });
  const first = await f.scope.refinePrefix(scope, sparse.frontier, allowance());
  expect(first.subjects).toEqual([other]);
  expect(first.exhausted).toBe(false);
  const final = await f.scope.refinePrefix(scope, first.frontier, allowance());
  expect(final).toMatchObject({
    subjects: [other],
    frontier: null,
    exhausted: true,
  });
  expect(reads).toEqual([
    [realm, null, 32, 'realm-test'],
    [realm, 'sparse-native-position', 32, 'realm-test'],
    [other, null, 32, 'realm-test'],
  ]);
  f.meaning();
  await expect(f.scope.revalidate(scope, allowance())).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
});

test('finite Realm covers preserve NOT and OR populations instead of dropping unanchored branches', async () => {
  for (const filter of [{ not: leaf }, { or: [leaf, { type: { in: ['schema:Book'] } }] }]) {
    const f = fixture();
    const { scope } = await f.scope.prepare(parseDiscoveryFilter(filter), allowance());
    await expect(f.scope.refinePrefix(scope, null, allowance())).rejects.toMatchObject({ code: 'semantic_not_ready' });
    expect(f.prefixes()).toBe(0);
  }
  for (const filter of [{ not: { not: leaf } }, { and: [leaf, { not: { realm: { id: other } } }] }]) {
    const f = fixture({
      async match(observation, subjects) {
        return subjects.map(() => (observation.realm === realm ? 'discussed' : 'not_published'));
      },
    });
    const { scope } = await f.scope.prepare(parseDiscoveryFilter(filter), allowance());
    expect(await f.scope.refinePrefix(scope, null, allowance())).toMatchObject({
      subjects: [other],
      exhausted: true,
    });
    expect(f.prefixes()).toBe(1);
  }
});

test('uncertain refinement refuses a successor; malformed or foreign input never advances', async () => {
  const f = fixture();
  const { scope } = await f.scope.prepare(leaf, allowance());
  for (const membership of ['unknown', 'withheld'] as const) {
    f.memberships([membership]);
    await expect(f.scope.refinePrefix(scope, null, allowance())).rejects.toMatchObject({ code: 'semantic_not_ready' });
  }
  f.memberships(['discussed']);
  expect((await f.scope.refinePrefix(scope, null, allowance())).exhausted).toBe(true);
  const sparse = fixture({
    prefix: async () => ({ subjects: [], after: 'next', exhausted: false }),
  });
  const prepared = await sparse.scope.prepare(leaf, allowance());
  const page = await sparse.scope.refinePrefix(prepared.scope, null, allowance());
  await expect(f.scope.refinePrefix(scope, page.frontier, allowance())).rejects.toBeInstanceOf(TypeError);
  await expect(sparse.scope.refinePrefix(prepared.scope, page.frontier, allowance())).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  f.authority('concealed');
  await expect(f.scope.revalidate(scope, allowance())).rejects.toMatchObject({
    code: 'not_found',
  });
});
