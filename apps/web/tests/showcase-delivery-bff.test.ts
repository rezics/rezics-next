import { afterAll, beforeAll, expect, test } from 'bun:test';
import { forwardToMain } from '../features/api/bff.ts';

// Main labels media public only when no reader identity decided it (services/main/src/routes/media.ts);
// the BFF keeps that label and Main's validators for media reads, and nothing else.
let upstream: ReturnType<typeof Bun.serve>;
const seen: Array<{ path: string; headers: Headers }> = [];
const etag = `"${'a'.repeat(64)}"`;
beforeAll(() => {
  upstream = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    seen.push({ path: url.pathname, headers: request.headers });
    if (url.pathname.startsWith('/v1/me/')) return Response.json({});
    const cacheControl = url.pathname.includes('private') ? 'private, no-store' : 'public, no-cache';
    if (url.pathname.startsWith('/v1/media/') && request.headers.get('if-none-match') === etag)
      return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } });
    return new Response(url.pathname.startsWith('/v1/media/') ? new Uint8Array([1, 2, 3]) : '{}', { headers: {
      'content-type': url.pathname.startsWith('/v1/media/') ? 'image/webp' : 'application/json',
      etag, 'cache-control': cacheControl } });
  } });
});
afterAll(() => upstream.stop(true));

const art = `/v1/media/representations/${'b'.repeat(8)}-0000-4000-8000-000000000001/bytes`;
const forward = (path: string, init: RequestInit = {}, accessToken: string | undefined = 'session-token') =>
  forwardToMain(new Request(`http://web.test/api/main${path}`, init), path.split('?')[0]!.split('/').slice(1),
    { mainOrigin: `http://127.0.0.1:${upstream.port}`, accessToken });

test('public media keeps Main\'s revalidating policy and validator, and passes its 304 through', async () => {
  for (const token of [undefined, 'session-token']) {
    const response = await forward(art, {}, token);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, no-cache');
    expect(response.headers.get('etag')).toBe(etag);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  }
  const revalidated = await forward(art, { headers: { 'if-none-match': etag } });
  expect(revalidated.status).toBe(304);
  expect(revalidated.body).toBeNull();
  expect(revalidated.headers.get('etag')).toBe(etag);
  expect(revalidated.headers.get('cache-control')).toBe('public, no-cache');
  expect(seen.at(-1)!.headers.get('if-none-match')).toBe(etag);
});

test('a signed-in reader\'s media read costs Main no session or preference lookups', async () => {
  const before = seen.length;
  await forward(art);
  expect(seen.slice(before).map(item => item.path)).toEqual([art]);
  // Other reads still resolve the reader's languages.
  const page = seen.length;
  await forward('/v1/works');
  expect(seen.slice(page).map(item => item.path)).toContain('/v1/me/session-agent');
});

test('private media, other reads and media writes are never cached by the browser', async () => {
  expect((await forward(`${art}/private`)).headers.get('cache-control')).toBe('no-store');
  expect((await forward('/v1/works')).headers.get('cache-control')).toBe('no-store');
  const write = await forward('/v1/media/metadata', { method: 'POST', body: '{"items":[]}',
    headers: { 'content-type': 'application/json' } });
  expect(write.headers.get('cache-control')).toBe('no-store');
});
