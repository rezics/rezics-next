import { describe, expect, test } from 'bun:test';
import { isAccountServicePath, proxyAccountRequest } from '../features/proxy/account-proxy.ts';

const own = 'http://127.0.0.1:41234';
const publicOrigin = 'http://127.0.0.1:3004';
const serviceOrigin = 'http://127.0.0.1:3002';

function recorder(response: () => Response = () => Response.json({ ok: true })) {
  const calls: { url: string; init: RequestInit & { headers: Headers } }[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: String(url), init: init as RequestInit & { headers: Headers } });
    return response();
  }) as typeof globalThis.fetch;
  return { calls, options: { serviceOrigin, publicOrigin, fetch } };
}

describe('Account proxy', () => {
  test('serves exactly the Account service surface', () => {
    for (const path of ['/api/auth/get-session', '/api/account/installations/x', '/oauth2/token',
      '/.well-known/openid-configuration']) expect(isAccountServicePath(path)).toBe(true);
    for (const path of ['/', '/api/authx', '/api/main/v1/works', '/sign-in', '/consent']) {
      expect(isAccountServicePath(path)).toBe(false);
    }
  });

  test('rejects malformed paths before reaching the service', async () => {
    const { calls, options } = recorder();
    for (const path of ['/api/auth/a%2F..%2Fb', '/api/auth/a/b/c/d/e/f/g/h', '/api/auth/x!y', '/api/auth/']) {
      const response = await proxyAccountRequest(new Request(`${own}${path}`), options);
      expect(response.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  test('forwards the path, query, method and body to the service', async () => {
    const { calls, options } = recorder();
    const response = await proxyAccountRequest(new Request(`${own}/api/auth/sign-in/email?x=1`, {
      method: 'POST', body: '{"email":"a@example.test"}',
      headers: { 'content-type': 'application/json', origin: own, cookie: 'better-auth.session_token=s' },
    }), options);
    expect(response.status).toBe(200);
    expect(calls[0]!.url).toBe(`${serviceOrigin}/api/auth/sign-in/email?x=1`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(await new Response(calls[0]!.init.body).text()).toBe('{"email":"a@example.test"}');
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.headers.get('cookie')).toBe('better-auth.session_token=s');
  });

  test('presents a same-origin browser request as the public Account origin', async () => {
    const { calls, options } = recorder();
    await proxyAccountRequest(new Request(`${own}/api/auth/sign-out`, { method: 'POST',
      headers: { origin: own, referer: `${own}/security?tab=1` } }), options);
    expect(calls[0]!.init.headers.get('origin')).toBe(publicOrigin);
    expect(calls[0]!.init.headers.get('referer')).toBe(`${publicOrigin}/security?tab=1`);
    await proxyAccountRequest(new Request(`${own}/api/auth/sign-out`, { method: 'POST',
      headers: { origin: 'https://evil.example', referer: 'https://evil.example/x' } }), options);
    // A foreign origin reaches Better Auth's CSRF check unchanged and is refused there.
    expect(calls[1]!.init.headers.get('origin')).toBe('https://evil.example');
    expect(calls[1]!.init.headers.get('referer')).toBe('https://evil.example/x');
  });

  test('forwards only needed headers and never a client-chosen address', async () => {
    const { calls, options } = recorder();
    await proxyAccountRequest(new Request(`${own}/api/auth/list-sessions`, { headers: {
      'user-agent': 'Browser/1', 'accept-language': 'zh-CN', 'x-forwarded-for': '203.0.113.9',
      'x-custom': 'secret', host: 'evil.example' } }), options);
    const sent = calls[0]!.init.headers;
    expect(sent.get('user-agent')).toBe('Browser/1');
    expect(sent.get('accept-language')).toBe('zh-CN');
    expect(sent.get('x-forwarded-for')).toBeNull();
    expect(sent.get('x-custom')).toBeNull();
    await proxyAccountRequest(new Request(`${own}/api/auth/list-sessions`, { headers: {
      'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '203.0.113.9' } }), options);
    expect(calls[1]!.init.headers.get('x-forwarded-for')).toBe('198.51.100.7');
  });

  test('keeps browser fetch metadata and marks server callers as not a browser fetch', async () => {
    const { calls, options } = recorder();
    await proxyAccountRequest(new Request(`${own}/api/auth/oauth2/consent`, { method: 'POST',
      headers: { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' } }),
    options);
    expect(calls[0]!.init.headers.get('sec-fetch-mode')).toBe('cors');
    expect(calls[0]!.init.headers.get('sec-fetch-site')).toBe('same-origin');
    // A product BFF's authorize check expects a redirect; undici adds `cors`.
    await proxyAccountRequest(new Request(`${own}/api/auth/oauth2/authorize?client_id=x`, {
      headers: { 'sec-fetch-mode': 'cors' } }), options);
    expect(calls[1]!.init.headers.get('sec-fetch-mode')).toBe('no-cors');
    expect(calls[1]!.init.headers.get('sec-fetch-site')).toBeNull();
  });

  test('returns redirects to this origin and keeps the service’s headers', async () => {
    const { options } = recorder(() => new Response(null, { status: 302, headers: [
      ['location', `${publicOrigin}/consent?sig=abc`], ['set-cookie', 'a=1; Path=/'],
      ['set-cookie', 'b=2; Path=/'], ['content-encoding', 'gzip'], ['cache-control', 'private, max-age=5'],
    ] }));
    const response = await proxyAccountRequest(new Request(`${own}/api/auth/oauth2/authorize`), options);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${own}/consent?sig=abc`);
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/']);
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, max-age=5');
    const product = recorder(() => new Response(null, { status: 302,
      headers: { location: 'http://127.0.0.1:3000/auth/callback?code=c' } }));
    const away = await proxyAccountRequest(new Request(`${own}/api/auth/oauth2/authorize`), product.options);
    expect(away.headers.get('location')).toBe('http://127.0.0.1:3000/auth/callback?code=c');
    expect(away.headers.get('cache-control')).toBe('no-store');
  });

  test('reports an unreachable service as temporarily unavailable', async () => {
    const response = await proxyAccountRequest(new Request(`${own}/api/auth/get-session`), {
      serviceOrigin, publicOrigin,
      fetch: (async () => { throw new TypeError('connect ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'temporarily_unavailable' });
  });
});
