import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { readSearchPage } from './read.ts';
import { searchPagesOptions, SearchError } from './query.ts';
import type { SearchState } from './state.ts';
import type { SearchContinuation, SearchResultPage } from './types.ts';

const state: SearchState = { phrase: 'Original lantern', scope: { kind: 'realm',
  realm: '00000000-0000-4000-8000-000000000001' }, language: null, term: null };

test('search refuses closed Realm reads and continuations without losing their ordinary problem', async () => {
  const problem = { type: 'about:blank', title: 'Not found', status: 404, code: 'realm_not_found',
    detail: 'This resource is unavailable.' };
  const requests: unknown[] = [];
  const main = browserMainApi('https://story.invalid', { anonymous: true,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
      return new Response(JSON.stringify(problem), { status: 404, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch });
  const continuation: SearchContinuation = { queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
    sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '12' },
    indexGeneration: 'fixture', nextOffset: 10, expiresAt: 0 };
  for (const cursor of [undefined, continuation]) {
    expect(await readSearchPage({ search: main, names: main }, state, { language: 'en', continuation: cursor }))
      .toEqual({ ok: false, failure: 'missing', status: 404, problem });
  }
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({ context: { realm: `https://rezics.com/id/${state.scope.kind === 'realm' ? state.scope.realm : ''}` },
    page: { continuation } });
});

test('the search continuation error retains the problem through query state', async () => {
  const problem = { status: 409, code: 'invalid_search_continuation', detail: 'The basis changed.' };
  const first = { indexGeneration: 'fixture', sequence: '12' } as SearchResultPage;
  const options = searchPagesOptions(state, 'en', undefined, first,
    async () => ({ ok: false, failure: 'restart', status: 409, problem }));
  const fn = options.queryFn;
  if (typeof fn !== 'function') throw new Error('Missing query function');
  try {
    await fn({ pageParam: null } as Parameters<typeof fn>[0]);
    throw new Error('Expected a failed search continuation');
  } catch (error) {
    expect(error).toBeInstanceOf(SearchError);
    expect((error as SearchError).response).toMatchObject({ status: 409, problem });
  }
});
