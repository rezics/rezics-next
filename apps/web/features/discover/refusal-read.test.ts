import { expect, test } from 'bun:test';
import { readDiscovery } from './read.ts';
import { readQueryDiscovery } from './query-read.ts';
import type { MainClient } from './types.ts';

test('the first-page staleness transformation keeps every field of the adapter failure', async () => {
  // Structural coverage only: no recorded first-page Discovery 409 exists.
  const problem = { code: 'read_basis_changed', title: 'Moved', detail: 'Exact detail', extension: { opaque: [7, null] } };
  const queries: unknown[] = [];
  const main = { v1: { works: { get: async (options: unknown) => {
    queries.push(options);
    return { data: null, error: { status: 409, value: problem } };
  } } } } as unknown as MainClient;
  for (const cursor of [undefined, 'opaque']) {
    const query = { scope: 'global' as const, actingSubject: 'person', ...(cursor ? { cursor } : {}) };
    expect(await readDiscovery(main, query))
      .toEqual({ ok: false, failure: cursor ? 'moved' : 'stale', status: 409, problem });
    expect(queries.at(-1)).toEqual({ query });
  }
  expect(queries).toHaveLength(2);
});

test('a local Mine sign-in prerequisite carries no invented HTTP problem', async () => {
  const main = { v1: { query: { post: () => { throw new Error('Unexpected request'); } } } } as unknown as MainClient;
  const state = { scope: { kind: 'mine' as const }, context: null, type: null, term: null,
    conditions: { include: ['00000000-0000-4000-8000-000000000001'], exclude: [], match: 'all' as const } };
  expect(await readQueryDiscovery(main, state, { scope: 'mine' })).toEqual({ ok: false, failure: 'sign-in' });
});
