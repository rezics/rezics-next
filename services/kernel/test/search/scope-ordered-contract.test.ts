import { expect, expectTypeOf, test } from 'bun:test';
import type { Pool } from 'pg';
import type { WorkAllowance, WorkReceipt } from '../../src/library/collection-source.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { SearchHit } from '../../src/search/query.ts';
import {
  validateScopeOrderedPrefix,
  validateScopeOrderedPrepare,
  type ScopeNativeOrder,
  type ScopeNameSortTuple,
  type ScopeCollectionsSortTuple,
  type ScopeOrderedPrefixRequest,
  type SearchScopeOrderedPrefix,
} from '../../src/search/scope-ordered.ts';
import {
  createSearchScopeSource,
  type PreparedSearchScope,
  type ScopeBasis,
  type ScopePrepareOptions,
  type ScopeOrderedPrefixRequest as ReexportedRequest,
  type SearchScopeOrderedPrefix as ReexportedPrefix,
} from '../../src/search/scope-source.ts';
import type { createSearchScopeForService } from '../../src/search/service-scope.ts';
import type { SearchScopeOrder } from '../../src/search/service-scope-order.ts';
import type { SubjectSource } from '../../src/search/source.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const allowance: WorkAllowance = {
  reservationId: 'ordered-scope-caller-root',
  remaining: {
    candidateKeys: 100,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  },
};
const request: ScopeOrderedPrefixRequest = { order: 'name', after: null, quota: 99, budget: 100, allowance };

test('the same service Scope exports exact native tuple, hit and caller-root work contracts', () => {
  type Scope = ReturnType<typeof createSearchScopeSource>;
  type Name = Extract<SearchScopeOrderedPrefix, { order: 'name' }>;
  type Collections = Extract<SearchScopeOrderedPrefix, { order: 'collections' }>;
  expectTypeOf<ScopeNativeOrder>().toEqualTypeOf<'name' | 'collections'>();
  expectTypeOf<ScopeNameSortTuple>().toEqualTypeOf<readonly [name: string | null, id: string]>();
  expectTypeOf<ScopeCollectionsSortTuple>().toEqualTypeOf<readonly [count: number, name: string | null, id: string]>();
  expectTypeOf<ReexportedRequest>().toEqualTypeOf<ScopeOrderedPrefixRequest>();
  expectTypeOf<ReexportedPrefix>().toEqualTypeOf<SearchScopeOrderedPrefix>();
  expectTypeOf<ReturnType<typeof createSearchScopeForService>>().toEqualTypeOf<Scope>();
  expectTypeOf<Parameters<Scope['orderedPrefix']>>().toEqualTypeOf<[PreparedSearchScope, ScopeOrderedPrefixRequest]>();
  expectTypeOf<ReturnType<Scope['orderedPrefix']>>().toEqualTypeOf<Promise<SearchScopeOrderedPrefix>>();
  expectTypeOf<Name['hits'][number]['sort']>().toEqualTypeOf<ScopeNameSortTuple>();
  expectTypeOf<Collections['hits'][number]['sort']>().toEqualTypeOf<ScopeCollectionsSortTuple>();
  expectTypeOf<Omit<Name['hits'][number], 'sort'>>().toEqualTypeOf<Omit<SearchHit, 'sort'>>();
  expectTypeOf<Name['coveredThrough']>().toEqualTypeOf<ScopeNameSortTuple | null>();
  expectTypeOf<Collections['coveredThrough']>().toEqualTypeOf<ScopeCollectionsSortTuple | null>();
  expectTypeOf<SearchScopeOrderedPrefix['basis']>().toEqualTypeOf<ScopeBasis>();
  expectTypeOf<SearchScopeOrderedPrefix['usage']>().toEqualTypeOf<{
    candidates: number;
    work: WorkReceipt;
    public: PublicFilterCost;
  }>();
  expectTypeOf<ScopeOrderedPrefixRequest['allowance']>().toEqualTypeOf<WorkAllowance>();
  expectTypeOf<ScopePrepareOptions['order']>().toEqualTypeOf<SearchScopeOrder | undefined>();
  expectTypeOf<ScopePrepareOptions['nativeOrder']>().toEqualTypeOf<ScopeNativeOrder | undefined>();
  expectTypeOf<ScopePrepareOptions['pageSize']>().toEqualTypeOf<number | undefined>();
  expectTypeOf<Parameters<Scope['prepare']>[1]>().toEqualTypeOf<ScopePrepareOptions | undefined>();
  expectTypeOf<Parameters<Scope['prefix']>[1]>().toEqualTypeOf<{
    afterSubject: string | null;
    quota: number;
    budget: number;
    allowance?: WorkAllowance;
  }>();
  expectTypeOf<ReturnType<Scope['work']>>().toEqualTypeOf<WorkReceipt>();
});

test('native tuple admission preserves missing, empty and maximum normalized names without coercing counts', () => {
  for (const name of [null, '', 'z', 's', '界'.repeat(512), '😀'.repeat(256), '\u0000'.repeat(512)]) {
    const tuple: ScopeNameSortTuple = Object.freeze([name, id]);
    validateScopeOrderedPrefix({ ...request, after: tuple });
    expect(tuple).toEqual([name, id]);
    for (const count of [0, 2147483647])
      validateScopeOrderedPrefix({ ...request, order: 'collections', after: [count, name, id] });
  }
  for (const after of [
    [],
    [null],
    [null, id, id],
    ['x'.repeat(513), id],
    ['界'.repeat(513), id],
    ['\ud800', id],
    [undefined, id],
    [0, id],
    ['', id.toUpperCase()],
    ['', 'invalid'],
  ])
    expect(() => validateScopeOrderedPrefix({ ...request, after } as unknown as ScopeOrderedPrefixRequest)).toThrow(
      RangeError,
    );
  for (const count of [-1, 2147483648, 0.5, NaN, Infinity, '0', null, undefined])
    expect(() =>
      validateScopeOrderedPrefix({
        ...request,
        order: 'collections',
        after: [count, '', id],
      } as ScopeOrderedPrefixRequest),
    ).toThrow(RangeError);
});

test('ordered steps reserve at most 100 total keys including lookahead and validate independent native axes', () => {
  validateScopeOrderedPrefix(request);
  validateScopeOrderedPrefix({ ...request, quota: 1, budget: 2 });
  for (const [quota, budget] of [
    [0, 2],
    [100, 101],
    [99, 99],
    [1, 101],
    [1, 1],
    [1.5, 3],
    [1, NaN],
  ])
    expect(() => validateScopeOrderedPrefix({ ...request, quota: quota!, budget: budget! })).toThrow(RangeError);
  expect(() =>
    validateScopeOrderedPrefix({
      ...request,
      allowance: { ...allowance, remaining: { ...allowance.remaining, candidateKeys: 99 } },
    }),
  ).toThrow(RangeError);
  for (const axis of Object.keys(allowance.remaining)) {
    for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = { ...allowance, remaining: { ...allowance.remaining, [axis]: value } };
      expect(() => validateScopeOrderedPrefix({ ...request, allowance: invalid })).toThrow(RangeError);
      expect(() => validateScopeOrderedPrepare({ nativeOrder: 'name', pageSize: 1, allowance: invalid })).toThrow(
        RangeError,
      );
    }
  }
});

test('ordered preparation validates before I/O and the new method honestly remains unavailable', async () => {
  let reads = 0;
  const forbidden = () => {
    reads++;
    throw new Error('Unexpected native work');
  };
  const scope = createSearchScopeSource({
    pool: { query: forbidden, connect: forbidden } as unknown as Pool,
    client: { request: forbidden } as unknown as OpenSearch,
    prefix: 'ordered-scope-',
    source: {} as SubjectSource,
    release: async () => {
      reads++;
      return null;
    },
  });
  const filter = { type: { in: ['schema:Book'] } };
  for (const options of [
    { nativeOrder: 'name' },
    { nativeOrder: 'name', allowance },
    { nativeOrder: 'name', pageSize: 1 },
    { pageSize: 1, allowance },
    { nativeOrder: 'ordinal', pageSize: 1, allowance },
    ...[0, 101, 0.5, NaN, Infinity].map((pageSize) => ({ nativeOrder: 'name', pageSize, allowance })),
  ])
    await expect(scope.prepare(filter, options as ScopePrepareOptions)).rejects.toBeInstanceOf(RangeError);
  for (const nativeOrder of ['name', 'collections'] as const)
    for (const pageSize of [1, 100])
      await expect(scope.prepare(filter, { nativeOrder, pageSize, allowance })).rejects.toMatchObject({
        code: 'semantic_not_ready',
      });
  // Forgery exercises refusal only; it supplies no positive prepared capability.
  await expect(scope.orderedPrefix({} as PreparedSearchScope, request)).rejects.toMatchObject({
    code: 'semantic_not_ready',
  });
  expect(reads).toBe(0);
});
