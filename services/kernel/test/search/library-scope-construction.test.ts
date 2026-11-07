import { expect, expectTypeOf, test } from 'bun:test';
import { BOUND_AXES, withinCeiling } from '@rezics/bounds';
import { createNativeLibraryScopeWork, createSearchLibraryScopePort } from '../../src/composition/search-library.ts';
import { SearchOperationError } from '../../src/search/operation-outcomes.ts';
import { createSearchScopeOrder, SEARCH_SCOPE_ORDINAL_OPERATION } from '../../src/search/service-scope-order.ts';
import type { SearchLibraryScopePort } from '../../src/search/library-scope-port.ts';
import type { CollectionSource } from '../../src/library/contract/index.ts';

test('each constructed Search application retains a complete supplied Library capability', () => {
  const library = createSearchLibraryScopePort();
  const other = createSearchLibraryScopePort();
  expect(library).not.toBe(other);
  expectTypeOf(library).toEqualTypeOf<SearchLibraryScopePort>();
  expectTypeOf(library.source.open).returns.toEqualTypeOf<CollectionSource>();
  expect(library.source.limits.collectionWorkGroupLimit).toBe(100);
  expect(library.source.limits.ordinalPageBound(1).limit).toBe(1);
  expect(library.source.limits.receivingCost.state.statements).toBeGreaterThan(0);
  expect(createNativeLibraryScopeWork(library)).not.toBe(createNativeLibraryScopeWork(library));
  const plan = SEARCH_SCOPE_ORDINAL_OPERATION(library);
  expect(plan.axes).toEqual(BOUND_AXES);
  expect(plan.rawLimit).toBe(1);
  expect(withinCeiling(plan.cost, plan.ceiling)).toBe(true);
});

test('scoped ordering refuses with a native Search outcome, not an HTTP problem type', async () => {
  const library = createSearchLibraryScopePort();
  const order = createSearchScopeOrder({
    pool: {} as never,
    options: {
      access: {} as never,
      actor: { kind: 'anonymous' },
      routeKey: new Uint8Array(32),
      deadline: Date.now() + 1000,
    },
    clock: () => new Date(),
    library,
  });
  await expect(order.prepare({ kind: 'id' }, { reservationId: 'scope', remaining: zero() })).rejects.toBeInstanceOf(
    SearchOperationError,
  );
  await expect(order.prepare({ kind: 'id' }, { reservationId: 'scope', remaining: zero() })).rejects.toMatchObject({
    name: 'SearchOperationError',
    code: 'unsupported_query',
  });
});

function zero() {
  return {
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  };
}
