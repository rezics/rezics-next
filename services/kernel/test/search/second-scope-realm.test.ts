import { expect, test } from 'bun:test';
import { admitDiscoveryFilter, parseDiscoveryFilter, parseFilter, type FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { compileCurrentRealmFilter } from '../../src/search/current-filter-plan.ts';
import {
  createRealmScopeSource,
  type RealmSubjectSource,
  type RealmSubjectMembership,
} from '../../src/search/realm-scope.ts';
import { scopeAllowance } from '../../src/search/scope-execution.ts';
import type { LeafOptions } from '../../src/semantic/scope-leaf-evidence.ts';

const realm = '018f0000-0000-7000-8000-00a000000001';
const other = '018f0000-0000-7000-8000-00a000000002';
const leaf = { realm: { id: realm } };
const release: FilterRelease = { types: { 'schema:Book': {} }, properties: {} };
const allowance = () => scopeAllowance(100, 'realm-test');

// Owner-port protocol tests; these do not certify an installed Content producer,
// native grants, native continuation or successful public Search activation.
function fixture() {
  let authority: 'current' | 'changed' | 'concealed' = 'current';
  let resolution: 'ready' | 'concealed' | 'unavailable' = 'ready';
  let meaning = 1;
  let memberships: readonly RealmSubjectMembership[] = ['discussed'];
  const resolved: string[] = [];
  let prefixes = 0;
  const source: RealmSubjectSource = {
    async resolve(id) {
      resolved.push(id);
      return resolution === 'ready'
        ? { state: 'ready', observation: { realm: id, revision: '1' } }
        : { state: resolution };
    },
    async current() {
      return authority;
    },
    async prefix() {
      prefixes++;
      return { subjects: [other], after: other, exhausted: true };
    },
    async match() {
      return memberships;
    },
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
  await expect(f.scope.prepare(leaf, allowance())).rejects.toMatchObject({ code: 'semantic_not_ready' });
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
