import { expect, test } from 'bun:test';
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../../src/http/problem.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import {
  createSearchScopeSource,
  type PreparedSearchScope,
  type ScopeNativeBudget,
} from '../../src/search/scope-source.ts';
import type { SubjectSource } from '../../src/search/source.ts';

const current: FilterRelease = {
  types: { 'schema:Book': {} },
  properties: {},
  filters: { 'books/broken': { filter: { type: { in: ['schema:Unknown'] } } } },
};
const id = '018f0000-0000-7000-8000-00a000000001';
const budget: ScopeNativeBudget = { points: 2, witnesses: 2, rows: 2, bytes: 1024, emptySeeks: 1 };
// A forged handle must never turn into evidence or an engine request.
const forged = {} as PreparedSearchScope;
function fixture(release: FilterRelease | null = current) {
  let reads = 0;
  const forbidden = () => {
    reads++;
    throw new Error('Unexpected runtime work');
  };
  const source = { read: forbidden, count: forbidden } as SubjectSource;
  const client = { request: forbidden, bulk: forbidden } as OpenSearch;
  const scope = createSearchScopeSource({
    pool: {} as Pool,
    client,
    prefix: 'scope-',
    source,
    release: async () => release,
  });
  return { scope, reads: () => reads };
}

async function problem(operation: Promise<unknown>, code: ProblemError['code']) {
  await expect(operation).rejects.toMatchObject({ code });
}

test('scope source admission and bounded raw-prefix and tri-state point contracts are explicit and fail closed before implementation', async () => {
  const { scope, reads } = fixture();
  for (const input of [
    { query: { match_all: {} } },
    { script: 'true' },
    { sort: 'id', type: { in: ['schema:Book'] } },
    { type: { in: [] } },
    { type: { in: ['schema:Book'] }, text: 'anything' },
  ])
    await problem(scope.prepare(input as unknown as FilterDocument), 'invalid_request');
  for (const input of [
    { type: { in: ['schema:Unknown'] } },
    { saved: 'books/missing' },
    { saved: 'books/broken' },
    { not: { type: { in: ['schema:Book'] } } },
  ])
    await problem(scope.prepare(input as FilterDocument), 'unsupported_query');
  expect(reads()).toBe(0);
});

test('missing active release is readiness, never an admitted empty scope', async () => {
  const { scope, reads } = fixture(null);
  await problem(scope.prepare({ type: { in: ['schema:Book'] } }), 'semantic_not_ready');
  expect(reads()).toBe(0);
});

test('missing native capability fails readiness after active saved-filter admission', async () => {
  const { scope, reads } = fixture({
    ...current,
    filters: { 'books/all': { filter: { type: { in: ['schema:Book'] } } } },
  });
  // This is a missing-capability test, not a requirement that valid native preparation always throws.
  await problem(scope.prepare({ saved: 'books/all' }), 'semantic_not_ready');
  expect(reads()).toBe(0);
});

test('raw prefix rejects invalid quotas and unreserved lookahead before runtime work', async () => {
  const { scope, reads } = fixture();
  for (const [quota, reservation] of [
    [0, 2],
    [101, 102],
    [1.5, 3],
    [1, 257],
    [1, 1],
    [100, 100],
    [1, NaN],
    [1, Infinity],
  ])
    await expect(
      scope.prefix(forged, { afterSubject: null, quota: quota!, budget: reservation! }),
    ).rejects.toBeInstanceOf(RangeError);
  await expect(scope.prefix(forged, { afterSubject: 'not-a-uuid', quota: 1, budget: 2 })).rejects.toThrow();
  expect(reads()).toBe(0);
});

test('native reservations are independent and count duplicate explicit IDs', async () => {
  const { scope, reads } = fixture();
  for (const key of Object.keys(budget)) {
    for (const value of [-1, 0.5, NaN, Infinity])
      await expect(scope.evaluate(forged, [id], { ...budget, [key]: value })).rejects.toBeInstanceOf(RangeError);
  }
  await expect(scope.evaluate(forged, [id, id], { ...budget, points: 1 })).rejects.toBeInstanceOf(RangeError);
  await expect(scope.evaluate(forged, ['not-a-uuid'], budget)).rejects.toThrow();
  // An untrusted handle cannot authorize, synthesize a hit, return false or claim EOF.
  await expect(scope.evaluate(forged, [id], budget)).rejects.toThrow();
  await expect(scope.prefix(forged, { afterSubject: null, quota: 1, budget: 2 })).rejects.toThrow();
  expect(reads()).toBe(0);
});
