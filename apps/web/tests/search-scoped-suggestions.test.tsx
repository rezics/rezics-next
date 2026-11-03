import { afterEach, expect, test } from 'bun:test';
import { loadGlobalHeaderSuggestions, loadScopedHeaderSuggestions } from '../src/search/header-search/suggestions';
import { suggestionResponse, type SuggestionResult } from '../src/search/suggestions';

const realm = '018f0000-0000-7000-8000-00a000000001';
const filter = JSON.stringify({
  and: [
    { realm: { id: realm } },
    { or: [{ type: { in: ['schema:Book'] } }, { not: { statement: { property: 'schema:genre', in: ['private'] } } }] },
  ],
});
const scope = { kind: 'Realm' as const, id: realm, name: 'display-only name', searchAction: `/en/search?filter=${encodeURIComponent(filter)}` };
const result: SuggestionResult = {
  subjects: [
    {
      id: '018f0000-0000-7000-8000-00a000000002',
      type: 'schema:Book',
      labels: { en: 'The Book' },
      summary: null,
    },
  ],
  as_of: '2026-11-03T00:00:00.000Z',
  types: {},
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('the scoped header loader sends the complete filter and ordered display languages through the private BFF', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: new URL(input instanceof Request ? input.url : String(input), 'https://rezics.test'), init });
    return Response.json(result);
  }) as typeof fetch;
  const controller = new AbortController();
  const fields: [string, string][] = [
    ['filter', filter],
    ['language', 'ja'],
    ['language', 'en'],
  ];

  await expect(loadScopedHeaderSuggestions('The', 'en', controller.signal, scope, fields)).resolves.toEqual(result);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.pathname).toBe('/api/search/suggestions');
  expect(calls[0]!.url.searchParams.get('filter')).toBe(filter);
  expect(calls[0]!.url.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(calls[0]!.url.searchParams.get('q')).toBe('The');
  expect(calls[0]!.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
});

test('missing or unsupported native scope refuses before any Global request', async () => {
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json(result);
  }) as typeof fetch;
  const signal = new AbortController().signal;
  await expect(loadScopedHeaderSuggestions('The', 'en', signal, undefined, [['filter', filter]])).rejects.toMatchObject({
    problem: { status: 503, code: 'scoped_suggestions_unavailable' },
  });
  await expect(
    loadScopedHeaderSuggestions('The', 'en', signal, { ...scope, kind: 'Zone' }, [['filter', filter]]),
  ).rejects.toMatchObject({ problem: { status: 503, code: 'scoped_suggestions_unavailable' } });
  await expect(
    loadScopedHeaderSuggestions('The', 'en', signal, scope, [['filter', JSON.stringify({ type: { in: ['schema:Book'] } })]]),
  ).rejects.toMatchObject({ problem: { status: 503, code: 'scoped_suggestions_unavailable' } });
  expect(requests).toBe(0);
});

test('ordinary Global suggestions keep their original prefix request semantics', async () => {
  let requested: URL | undefined;
  globalThis.fetch = (async (input) => {
    requested = new URL(input instanceof Request ? input.url : String(input), 'https://rezics.test');
    return Response.json(result);
  }) as typeof fetch;
  const fields: [string, string][] = [['filter', filter], ['language', 'ja']];
  await loadGlobalHeaderSuggestions('The', 'en', new AbortController().signal, undefined, fields);
  expect(requested?.searchParams.has('filter')).toBe(false);
  expect(requested?.searchParams.getAll('language')).toEqual(['ja']);
});

test('the cookie-backed suggestions BFF preserves filter fields and sends a private no-store page', async () => {
  const request = new Request(
    `https://rezics.test/api/search/suggestions?q=The&locale=en&filter=${encodeURIComponent(filter)}&language=ja&language=en`,
  );
  let received = '';
  const response = await suggestionResponse(request, {}, async (query, forwarded) => {
    received = `${query}|${new URL(forwarded.url).searchParams.get('filter')}|${new URL(forwarded.url).searchParams.getAll('language').join(',')}`;
    return result;
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(received).toBe(`The|${filter}|ja,en`);
  expect(await response.json()).toEqual(result);
});
