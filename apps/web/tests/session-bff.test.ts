import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forwardToMain, MAIN_METHODS, mainTarget } from '../features/api/bff.ts';
import { browserMainApi } from '../features/api/browser.ts';
import { sameOriginWrite } from '../features/api/origins.ts';
import * as route from '../app/api/main/[...path]/route.ts';

const routes = join(import.meta.dir, '../../../services/main/src/routes');
/** Every HTTP operation Main registers, read from its route plugins. */
function mainOperations(): Array<{ method: string; path: string }> {
  return readdirSync(routes).filter(file => file.endsWith('.ts')).flatMap(file =>
    [...readFileSync(join(routes, file), 'utf8').matchAll(/\.(get|post|put|patch|delete)\('(\/v1\/[^']*)'/g)]
      .map(match => ({ method: match[1]!.toUpperCase(), path: match[2]! })));
}

test('IAM01: the BFF accepts every method and path Main registers', () => {
  const operations = mainOperations();
  expect(operations.length).toBeGreaterThan(400);
  expect(new Set(operations.map(operation => operation.method))).toEqual(new Set(MAIN_METHODS));
  for (const method of MAIN_METHODS) expect(typeof route[method]).toBe('function');
  expect(operations.filter(operation => operation.method === 'PUT').length).toBeGreaterThanOrEqual(13);
  for (const { path } of operations) {
    // Parameters take their widest shapes: UUIDs, slugs, `global`, dotted task names.
    const concrete = path.replace(/:[A-Za-z]+/g, 'b8df6385-cec9-4fa0-8b89-71def5fa82b5');
    const target = mainTarget(concrete.split('/').slice(1), '?actingSubject=x', 'http://main.test');
    expect(target?.pathname, path).toBe(concrete);
  }
  expect(mainTarget(['v1', 'me', 'acting-context-preferences', 'work.create'], '', 'http://main.test')?.href)
    .toBe('http://main.test/v1/me/acting-context-preferences/work.create');
});

test('IAM01: BFF paths cannot leave Main\'s /v1 API', () => {
  const main = 'http://main.test';
  for (const segments of [[], ['v1'], ['health', 'live'], ['v1', '..', 'health'], ['v1', '.'],
    ['v1', 'works', '..'], ['v1', 'a/b'], ['v1', 'a\\b'], ['v1', ''], ['v1', 'café'],
    ['v1', '%2e%2e'], ['v1', 'a b'], ['v1', 'x'.repeat(201)], ['v1', ...Array(16).fill('a')]]) {
    expect(mainTarget(segments, '', main), JSON.stringify(segments)).toBeNull();
  }
});

test('IAM02: browser writes cannot use a foreign origin or cross-site fetch metadata', () => {
  const write = (headers: Record<string, string>) => sameOriginWrite(new Request(
    'https://web.rezics.test/api/main/v1/works', { method: 'POST', headers }));
  expect(write({ origin: 'https://web.rezics.test', 'sec-fetch-site': 'same-origin' })).toBe(true);
  expect(write({})).toBe(true);
  expect(write({ 'sec-fetch-site': 'cross-site' })).toBe(false);
  expect(write({ 'sec-fetch-site': 'same-site', origin: 'https://web.rezics.test' })).toBe(false);
  expect(write({ origin: 'https://other.test' })).toBe(false);
});

let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ method: string; path: string; headers: Headers; chunks: number; body: string }> = [];
beforeAll(() => {
  upstream = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    let chunks = 0;
    let body = '';
    if (request.body) {
      const decoder = new TextDecoder();
      for await (const chunk of request.body) { chunks += 1; body += decoder.decode(chunk, { stream: true }); }
    }
    seen.push({ method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, chunks, body });
    if (url.pathname === '/v1/media/uploads') {
      return new Response(null, { status: 201, headers: { location: '/v1/media/uploads/u1?x=1',
        etag: '"g1"', 'set-cookie': 'main=1', 'cache-control': 'public, no-cache', 'x-internal': 'yes' } });
    }
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"a":'));
      controller.enqueue(new TextEncoder().encode('1}'));
      controller.close();
    } }), { headers: { 'content-type': 'application/json' } });
  } });
});
afterAll(() => upstream.stop(true));

const bff = (path: string, init: RequestInit & { duplex?: 'half' } = {}) =>
  new Request(`http://web.test/api/main/${path}`, init);
const segments = (path: string) => path.split('?')[0]!.split('/');

test('IAM01: the BFF streams request and response bodies and forwards the Idempotency-Key', async () => {
  const main = `http://127.0.0.1:${upstream.port}`;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) {
    for (const part of ['{"profile":', '"x",', '"n":1}']) controller.enqueue(encoder.encode(part));
    controller.close();
  } });
  const path = 'v1/me/acting-context-preferences/work.create';
  const response = await forwardToMain(bff(path, { method: 'PUT', body, duplex: 'half', headers: {
    'content-type': 'application/json', 'idempotency-key': 'k-1', 'if-match': '"g0"',
    cookie: 'rezics_access=secret', authorization: 'Bearer forged', origin: 'http://web.test' } }),
  segments(path), { mainOrigin: main, accessToken: 'session-token' });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{"a":1}');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const request = seen.at(-1)!;
  expect(request).toMatchObject({ method: 'PUT', path: `/${path}`, body: '{"profile":"x","n":1}' });
  expect(request.headers.get('idempotency-key')).toBe('k-1');
  expect(request.headers.get('if-match')).toBe('"g0"');
  expect(request.headers.get('authorization')).toBe('Bearer session-token');
  expect(request.headers.get('cookie')).toBeNull();
  expect(request.headers.get('origin')).toBeNull();
});

test('IAM01: BFF responses keep Main\'s path shape and drop what the browser must not see', async () => {
  const main = `http://127.0.0.1:${upstream.port}`;
  const response = await forwardToMain(bff('v1/media/uploads', { method: 'POST', body: '{}',
    headers: { 'content-type': 'application/json' } }), ['v1', 'media', 'uploads'],
  { mainOrigin: main, accessToken: undefined });
  expect(response.status).toBe(201);
  expect(response.headers.get('location')).toBe('/api/main/v1/media/uploads/u1?x=1');
  expect(response.headers.get('etag')).toBe('"g1"');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('x-internal')).toBeNull();
  expect(seen.at(-1)!.headers.get('authorization')).toBeNull();
  const get = await forwardToMain(bff('v1/works?q=a%20b'), ['v1', 'works'], { mainOrigin: main, accessToken: 't' });
  expect(get.status).toBe(200);
  expect(seen.at(-1)!.path).toBe('/v1/works?q=a%20b');
});

test('IAM01: the BFF refuses unknown methods, foreign writes and reports Main unavailable', async () => {
  const main = `http://127.0.0.1:${upstream.port}`;
  const before = seen.length;
  expect((await forwardToMain(bff('v1/works', { method: 'OPTIONS' }), ['v1', 'works'],
    { mainOrigin: main, accessToken: 't' })).status).toBe(405);
  expect((await forwardToMain(bff('v1/works', { method: 'POST', body: '{}', headers: { origin: 'https://evil.test' } }),
    ['v1', 'works'], { mainOrigin: main, accessToken: 't' })).status).toBe(403);
  expect((await forwardToMain(bff('v1/../health'), ['v1', '..', 'health'],
    { mainOrigin: main, accessToken: 't' })).status).toBe(404);
  expect(seen.length).toBe(before);
  const down = await forwardToMain(bff('v1/works'), ['v1', 'works'],
    { mainOrigin: main, accessToken: 't', fetch: (() => Promise.reject(new TypeError('refused'))) as unknown as typeof fetch });
  expect(down.status).toBe(503);
  expect(down.headers.get('retry-after')).toBe('5');
});

test('IAM01: the browser Eden client reaches Main through the BFF with Main\'s own paths and types', async () => {
  const response = await browserMainApi(`http://127.0.0.1:${upstream.port}`)
    .v1.me['acting-contexts'].get({ query: { task: 'work.create' } });
  expect(seen.at(-1)!.path).toBe('/api/main/v1/me/acting-contexts?task=work.create');
  expect(response.status).toBe(200);
});
