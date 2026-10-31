import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createStoryFetch, env } from '../.storybook/cloudflare-workers';
import * as start from '../.storybook/react-start';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import search from '../src/kernel/recorded/search.json';

mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const { loadGlobalHeaderSuggestions } = await import('../src/search/header-search/suggestions');
const { searchContentSubjects } = await import('../src/threads/content-subject-search');
const { setLocale } = await import('../src/paraglide/runtime.js');
const originalFetch = globalThis.fetch;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalContext = Object.getOwnPropertyDescriptor(globalThis, '__rezicsStoryContext');
const endpoint = 'https://storybook.test/api/search/suggestions';
const calls: Request[] = [];
const live = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('live'));
let native: typeof fetch;

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: new URL('https://storybook.test/iframe.html') },
  });
  start.setStoryRequestContext({ visitor: 'Signed Out', url: '/zh-Hant/collections/recorded' });
  setLocale('en', { reload: false });
  calls.length = 0;
  live.mockClear();
  native = createStoryRecordedKernelFetch();
  globalThis.fetch = createStoryFetch(
    live as typeof fetch,
    (async (input, init) => {
      calls.push(new Request(input, init));
      return native(input, init);
    }) as typeof fetch,
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalContext) Object.defineProperty(globalThis, '__rezicsStoryContext', originalContext);
  else Reflect.deleteProperty(globalThis, '__rezicsStoryContext');
});

test('the real header and entity picker share recorded native suggestions and released type labels', async () => {
  start.setStoryRequestContext({ visitor: 'Signed In', url: '/en/collections/recorded' });
  const result = await loadGlobalHeaderSuggestions('Prince', 'en', new AbortController().signal);
  expect(result.subjects.map((subject) => subject.id)).toEqual([search.subjects[1]!.id]);
  expect(result.types['schema:Book']?.en).toBe('Book');
  const picked = await searchContentSubjects('Prince', new AbortController().signal);
  expect(picked.map(({ id, typeLabel }) => ({ id, typeLabel }))).toEqual([
    { id: search.subjects[1]!.id, typeLabel: result.types['schema:Book']!.en! },
  ]);
  const suggestions = calls.filter((request) => new URL(request.url).pathname === '/v1/subjects:suggest');
  expect(suggestions).toHaveLength(2);
  for (const request of suggestions) {
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.searchParams.get('q')).toBe('Prince');
    expect(url.searchParams.get('limit')).toBe('8');
    expect(url.searchParams.getAll('languages')).toEqual(['en']);
    expect(request.headers.get('authorization')).toBe('Bearer recorded-story-token');
  }
  expect(calls.every((request) => /^\/v1\/(subjects:suggest|definitions\/)/.test(new URL(request.url).pathname))).toBe(
    true,
  );
  expect(live).not.toHaveBeenCalled();
});

test('the BFF keeps locale order, numeric bounds, explicit identity and each story visitor', async () => {
  for (const [visitor, credential, init] of [
    ['Signed Out', null, {}],
    ['Signed In', 'Bearer recorded-story-token', {}],
    ['Signed In', null, { credentials: 'omit' }],
    ['Signed In', 'Bearer supplied', { headers: { authorization: 'Bearer supplied' } }],
  ] as const) {
    start.setStoryRequestContext({ visitor, url: '/zh-Hant/collections/recorded' });
    const input = new Request(`${endpoint}?q=Prince&limit=10`, init);
    // Bun omits Request.credentials; retain the browser caller's metadata in this source-level test.
    if ('credentials' in init) Object.defineProperty(input, 'credentials', { value: init.credentials });
    const response = await fetch(input);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const request = calls.filter((request) => new URL(request.url).pathname === '/v1/subjects:suggest').at(-1)!;
    const url = new URL(request.url);
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.getAll('languages')).toEqual(['zh-Hant', 'zh', 'zh-Hans']);
    expect(request.headers.get('accept-language')).toBe('zh-Hant, zh;q=0.9, zh-Hans;q=0.8');
    expect(request.headers.get('authorization'), `${visitor} ${JSON.stringify(init)}`).toBe(credential);
  }
  const before = calls.length;
  for (const query of [
    'q=',
    `q=${'a'.repeat(65)}`,
    'q=Prince&limit=1.5',
    'q=Prince&limit=11',
    'q=Prince&locale=bad_locale',
  ]) {
    const response = await fetch(`${endpoint}?${query}`);
    expect(response.status).toBe(400);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('code', 'invalid_request');
  }
  await expect(
    loadGlobalHeaderSuggestions('Prince', 'en', new AbortController().signal, {
      kind: 'Realm',
      id: 'closed',
      name: 'Closed',
    }),
  ).rejects.toThrow('Scoped suggestions are unavailable');
  expect(calls).toHaveLength(before);
});

test('native failures remain private failures without anonymous retries or invented subjects', async () => {
  for (const [status, code] of [
    [401, 'invalid_credentials'],
    [403, 'platform_closed'],
    [404, 'not_found'],
    [503, 'dependency_unavailable'],
  ] as const) {
    const before = calls.length;
    native = (async () => Response.json({ code }, { status })) as typeof fetch;
    const response = await fetch(`${endpoint}?q=Prince&locale=en`, { headers: { authorization: 'Bearer denied' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('code', code);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer denied');
  }
});

test('Request and init cancellation reject fetch while unrelated paths, methods and origins retain live fetch', async () => {
  const controller = new AbortController();
  const request = new Request(`${endpoint}?q=Prince&locale=en`, { signal: controller.signal });
  controller.abort();
  await expect(fetch(request)).rejects.toHaveProperty('name', 'AbortError');
  expect(calls).toHaveLength(0);
  const active = new AbortController();
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  native = (async () => {
    started();
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  const pending = fetch(request, { signal: active.signal });
  await ready;
  active.abort();
  expect(calls.at(-1)!.signal.aborted).toBe(true);
  finish();
  await expect(pending).rejects.toHaveProperty('name', 'AbortError');
  for (const [input, init] of [
    [new URL(`${endpoint}/extra`), undefined],
    [`https://external.test/api/search/suggestions?q=Prince`, undefined],
    [endpoint, { method: 'POST' }],
    [new Request(endpoint, { method: 'HEAD' }), undefined],
    [request, { method: 'OPTIONS' }],
  ] as const) {
    expect(await (await fetch(input, init)).text()).toBe('live');
    expect(live.mock.calls.at(-1)).toEqual([input, init]);
  }
});

test('the exact trending route rejects missing language through its BFF without native or live reads', async () => {
  const response = await fetch('https://storybook.test/api/search/trending');
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toHaveProperty('code', 'invalid_request');
  expect(calls).toHaveLength(0);
  expect(live).not.toHaveBeenCalled();
});

test('trending keeps language, bounds and story identity while a missing recording stays unavailable', async () => {
  for (const [visitor, credential, init] of [
    ['Signed Out', null, {}],
    ['Signed In', 'Bearer recorded-story-token', {}],
    ['Signed In', null, { credentials: 'omit' }],
    ['Signed In', 'Bearer supplied', { headers: { authorization: 'Bearer supplied' } }],
  ] as const) {
    start.setStoryRequestContext({ visitor, url: '/en/collections/recorded' });
    const response = await fetch('/api/search/trending?language=zh-Hant', init);
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('code', 'dependency_unavailable');
    const request = calls.at(-1)!;
    const url = new URL(request.url);
    expect(request.method).toBe('GET');
    expect(url.pathname).toBe('/v1/trendingSearches');
    expect(url.searchParams.get('language')).toBe('zh-Hant');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(request.headers.get('accept-language')).toBe('zh-Hant, zh;q=0.9, zh-Hans;q=0.8');
    expect(request.headers.get('authorization'), `${visitor} ${JSON.stringify(init)}`).toBe(credential);
  }
  expect(calls).toHaveLength(4);
  expect(live).not.toHaveBeenCalled();
});

test('trending preserves native refusal and preparation without anonymous retry', async () => {
  for (const [status, code] of [
    [401, 'invalid_credentials'],
    [403, 'platform_closed'],
    [503, 'semantic_not_ready'],
    [503, 'index_not_ready'],
    [503, 'dependency_unavailable'],
  ] as const) {
    const before = calls.length;
    native = (async () => Response.json({ code }, { status })) as typeof fetch;
    const response = await fetch('/api/search/trending?language=en', { headers: { authorization: 'Bearer denied' } });
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toHaveProperty('code', code);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer denied');
  }
  expect(live).not.toHaveBeenCalled();
});

test('trending preserves cancellation and passes through other paths, origins and methods', async () => {
  const endpoint = 'https://storybook.test/api/search/trending?language=en';
  const controller = new AbortController();
  const request = new Request(endpoint, { signal: controller.signal });
  controller.abort();
  await expect(fetch(request)).rejects.toHaveProperty('name', 'AbortError');
  expect(calls).toHaveLength(0);
  const active = new AbortController();
  native = (async () => {
    active.abort();
    return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  }) as typeof fetch;
  await expect(fetch(request, { signal: active.signal })).rejects.toHaveProperty('name', 'AbortError');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.signal.aborted).toBe(true);
  for (const [input, init] of [
    ['https://storybook.test/api/search/trending/extra', undefined],
    ['https://external.test/api/search/trending?language=en', undefined],
    [endpoint, { method: 'POST' }],
    [new Request(endpoint, { method: 'HEAD' }), undefined],
    [request, { method: 'OPTIONS' }],
  ] as const) {
    expect(await (await fetch(input, init)).text()).toBe('live');
    expect(live.mock.calls.at(-1)).toEqual([input, init]);
  }
});
