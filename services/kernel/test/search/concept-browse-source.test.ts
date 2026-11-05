import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { relationSource, type ConceptBrowseNativeReservation } from '../../src/semantic/search-relations.ts';

const concept = '018f0000-0000-7000-8000-00a000000001';
const scheme = '018f0000-0000-7000-8000-00a000000010';
const binding = {
  release: 'release-a',
  graph: 'graph-a',
  scheme,
  membership: 'membership-a',
  principal: 'anonymous',
  request: 'request-a',
};

test('reserves each observation, replay and empty terminal seek before native dispatch', async () => {
  const failure = new Error('native dispatch should follow reservation');
  const pool = { connect: async () => Promise.reject(failure) } as unknown as Pool;
  const reservations: ConceptBrowseNativeReservation[] = [];
  const source = relationSource(pool, new Uint8Array(32)).conceptBrowse(
    { concept, property: 'schema:keywords', scheme, includeChildren: true },
    { principal: binding.principal, request: binding.request },
    (reservation) => reservations.push(reservation),
  );
  const dispatch = async (work: Promise<unknown>) => expect(work).rejects.toBe(failure);

  await dispatch(source.observe());
  await dispatch(source.children({ parent: concept, after: null, binding, limit: 2 }));
  await dispatch(source.children({ parent: concept, after: null, binding, limit: 2 }));
  await dispatch(
    source.children({
      parent: concept,
      after: `00160:${concept}:018f0000-0000-7000-8000-00a000000011:018f0000-0000-7000-8000-00a000000012`,
      binding,
      limit: 2,
    }),
  );

  expect(reservations).toEqual([
    { keys: 1, rows: 12, points: 8, statements: 12, bytes: 96_000, emptySeeks: 1 },
    ...Array.from({ length: 3 }, () => ({
      keys: 2,
      rows: 8,
      points: 6,
      statements: 16,
      bytes: 24_576,
      emptySeeks: 1,
    })),
  ]);
});
