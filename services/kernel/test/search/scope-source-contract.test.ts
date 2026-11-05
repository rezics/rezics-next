import { expect, expectTypeOf, test } from 'bun:test';
import type { FilterDocument, FilterRelease } from '@rezics/filter';
import type { Pool } from 'pg';
import { ProblemError } from '../../src/http/problem.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import {
  createSearchScopeSource,
  type PreparedSearchScope,
  type ScopeNativeBudget,
  type ScopeEvaluationProgress,
  type ScopeEvaluationReservation,
  type SearchScopeEvaluation,
} from '../../src/search/scope-source.ts';
import type { LeafOptions, LeafProgress, LeafWork } from '../../src/semantic/scope-leaf-evidence.ts';
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

test('native reservations reject malformed axes independently before runtime work', async () => {
  const { scope, reads } = fixture();
  for (const key of Object.keys(budget)) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        scope.evaluate(forged, [id], { rawKeys: 2, native: { ...budget, [key]: value } }),
      ).rejects.toBeInstanceOf(RangeError);
  }
  await expect(scope.evaluate(forged, ['not-a-uuid'], { rawKeys: 2, native: budget })).rejects.toThrow();
  // An untrusted handle cannot authorize, synthesize a hit, return false or claim EOF.
  await expect(scope.evaluate(forged, [id], { rawKeys: 2, native: budget })).rejects.toThrow();
  await expect(scope.prefix(forged, { afterSubject: null, quota: 1, budget: 2 })).rejects.toThrow();
  expect(reads()).toBe(0);
});

test('scope evaluation explicitly reserves shared raw keys and carries one pending native leaf progress without truth caching', async () => {
  expectTypeOf<ScopeNativeBudget>().toEqualTypeOf<Omit<LeafWork, 'keys'>>();
  expectTypeOf<ScopeEvaluationProgress['phase']>().toEqualTypeOf<LeafProgress['phase']>();
  expectTypeOf<keyof ScopeEvaluationProgress>().toEqualTypeOf<
    'subject' | 'basis' | 'leafOrdinal' | 'phase' | 'valueOrdinal' | 'after'
  >();
  expectTypeOf<keyof SearchScopeEvaluation>().toEqualTypeOf<'values' | 'basis' | 'usage' | 'evidence' | 'progress'>();
  expectTypeOf<SearchScopeEvaluation['usage']>().toEqualTypeOf<{ keys: number; native: ScopeNativeBudget }>();
  expectTypeOf<
    Parameters<ReturnType<typeof createSearchScopeSource>['evaluate']>[2]
  >().toEqualTypeOf<ScopeEvaluationReservation>();
  expectTypeOf<Parameters<typeof createSearchScopeSource>[0]['evidence']>().toEqualTypeOf<LeafOptions | undefined>();
  const { scope, reads } = fixture();
  for (const malformed of [undefined, null, []])
    await expect(
      scope.evaluate(forged, [id], malformed as unknown as ScopeEvaluationReservation),
    ).rejects.toBeInstanceOf(RangeError);
  for (const rawKeys of [undefined, null, -1, 0.5, NaN, Infinity, 257, Number.MAX_SAFE_INTEGER + 1])
    await expect(
      scope.evaluate(forged, [id], { rawKeys, native: budget } as ScopeEvaluationReservation),
    ).rejects.toBeInstanceOf(RangeError);
  for (const native of [undefined, null, [], {}])
    await expect(
      scope.evaluate(forged, [id], { rawKeys: 0, native } as ScopeEvaluationReservation),
    ).rejects.toBeInstanceOf(RangeError);
  // These are valid reservations even with duplicate IDs and fewer points than IDs. A forged handle
  // cannot execute; this checks reservation admission without freezing valid native requests as unavailable.
  const progress: ScopeEvaluationProgress = {
    subject: id,
    basis: 'a'.repeat(64),
    leafOrdinal: 0,
    phase: 'witness',
    valueOrdinal: 0,
    after: null,
  };
  await expect(scope.evaluate(forged, [], { rawKeys: 0, native: budget, progress })).rejects.toBeInstanceOf(RangeError);
  for (const rawKeys of [0, 1, 101, 256]) {
    const outcome = await scope
      .evaluate(forged, [id, id], {
        rawKeys,
        native: { ...budget, points: 0 },
        progress,
      })
      .catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(RangeError);
  }
  expect(reads()).toBe(0);
});
