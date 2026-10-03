import { afterEach, expect, test } from 'bun:test';
import { uuidToSid } from '@rezics/model/address';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import { beforePathNormalization } from '../features/address/edge.ts';
import { readAddress, type ResolvedAddress } from '../features/address/client.ts';
import { mainReadHeaders } from '../features/api/main-read.ts';
import { sessionCookies } from '../features/auth/session-state.ts';
import { forwardToMain, mainRequestHeaders } from '../features/api/bff.ts';
import { appEnvironment } from '../../../scripts/dev/config.ts';
import { families, principalClasses, rateLimitBudgets } from '../../../services/main/src/modules/rate-limit/budgets.ts';

const uuid = 'dfc1030e-efa0-4041-a686-bebce31f645c';
const holder = `https://rezics.com/id/${uuid}`;
const sid = uuidToSid(uuid);
const agent: ResolvedAddress = {
  profile: 'address-resolution-v1', status: 'resolved', scope: 'agent', key: uuid,
  holder, state: 'current', canonical: { prefix: '/a/', key: sid, slugSource: 'Reader' },
};
const claim = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const signedInCookie = sessionCookies('https://rezics.test', {
  accessToken: `${claim({ alg: 'none' })}.${claim({ sub: 'g998-user' })}.x`,
  refreshToken: 'private-refresh', expiresIn: 300,
}, { id: 'g998-user' }).map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
const originalFetch = globalThis.fetch;
const originalClient = process.env.WEB_OAUTH_CLIENT_ID;
const originalIpHeader = process.env.WEB_CLIENT_IP_HEADER;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalClient === undefined) delete process.env.WEB_OAUTH_CLIENT_ID;
  else process.env.WEB_OAUTH_CLIENT_ID = originalClient;
  if (originalIpHeader === undefined) delete process.env.WEB_CLIENT_IP_HEADER;
  else process.env.WEB_CLIENT_IP_HEADER = originalIpHeader;
});

function stub(send: (url: URL, headers: Headers, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input, init) => send(
    new URL(input instanceof Request ? input.url : String(input)), new Headers(init?.headers), init,
  )) as typeof fetch;
}

test('G998: dev/QA policy covers every budget family, including address, without changing production', () => {
  const compose = { ACCOUNT_PORT: '3002', MAIN_PORT: '3001' };
  const local = rateLimitBudgets(appEnvironment(compose, '.temp/g-998').MAIN_RATE_LIMIT_BUDGETS);
  for (const principal of principalClasses) for (const family of families)
    expect(local[principal][family]).toEqual({ maximum: 1_000_000, seconds: 60 });
  expect(rateLimitBudgets().anonymous.address.maximum).toBe(30);
  const custom = JSON.stringify({ anonymous: { address: { maximum: 12, seconds: 60 } } });
  expect(appEnvironment({ ...compose, MAIN_RATE_LIMIT_BUDGETS: custom }, '.temp/g-998')
    .MAIN_RATE_LIMIT_BUDGETS).toBe(custom);
});

test.each(['203.0.113.17', '2001:db8::17'])('G998: server reads and the BFF forward the same ingress IP %s', async (ip) => {
  const incoming = new Headers({ 'cf-connecting-ip': ` ${ip} `, 'x-rezics-client-ip': '192.0.2.99',
    'x-forwarded-for': '192.0.2.98', cookie: 'private=secret', authorization: 'Bearer forged' });
  const outgoing = await mainReadHeaders({ accept: 'application/json' }, incoming);
  expect(outgoing.get('x-rezics-client-ip')).toBe(ip);
  expect(mainRequestHeaders(incoming, undefined).get('x-rezics-client-ip')).toBe(ip);
  expect(outgoing.has('cookie')).toBe(false);
  expect(outgoing.has('authorization')).toBe(false);
  expect(outgoing.has('x-forwarded-for')).toBe(false);
});

test.each(['', 'unknown', '203.0.113.17, 203.0.113.18', '[2001:db8::1]', '203.0.113.17:80'])(
  'G998: invalid ingress IP %s cannot fall back to spoofed client headers', async (ip) => {
    const incoming = new Headers({ 'cf-connecting-ip': ip, 'x-rezics-client-ip': '192.0.2.99',
      'x-forwarded-for': '192.0.2.98' });
    expect((await mainReadHeaders({ 'x-rezics-client-ip': '192.0.2.97' }, incoming))
      .has('x-rezics-client-ip')).toBe(false);
    expect(mainRequestHeaders(incoming, undefined).has('x-rezics-client-ip')).toBe(false);
  },
);

test('G998: a configured ingress source replaces cf-connecting-ip for server reads', async () => {
  process.env.WEB_CLIENT_IP_HEADER = 'x-ingress-client';
  const incoming = new Headers({ 'x-ingress-client': '203.0.113.17', 'cf-connecting-ip': '192.0.2.99' });
  expect((await mainReadHeaders(undefined, incoming)).get('x-rezics-client-ip')).toBe('203.0.113.17');
  expect(mainRequestHeaders(incoming, undefined, process.env.WEB_CLIENT_IP_HEADER)
    .get('x-rezics-client-ip')).toBe('203.0.113.17');
});

for (const locale of ['en', 'zh-Hant']) {
  for (const form of [`/a/${uuid.toUpperCase()}`, `/@agent-${uuid.toUpperCase()}`, `/a/${sid}-stale`]) {
    test(`G998: signed-in ${locale}${form} goes directly to its canonical address`, async () => {
      const seen: URL[] = [];
      stub((url, headers) => {
        seen.push(url);
        expect(url.pathname).toBe('/v1/addresses/resolve');
        expect(headers.get('x-rezics-client-ip')).toBe('203.0.113.17');
        expect(headers.has('authorization')).toBe(false);
        expect(headers.has('cookie')).toBe(false);
        expect(headers.get('x-rezics-display-languages')).toBe(locale);
        return Response.json({ ...agent, key: url.searchParams.get('key') });
      });
      const response = await proxy(new NextRequest(`https://rezics.test/${locale}${form}?direction9=preserved`, {
        headers: { 'cf-connecting-ip': '203.0.113.17', cookie: signedInCookie,
          'x-rezics-client-ip': '192.0.2.99' },
      }));
      expect(response.status).toBe(301);
      expect(response.headers.get('location'))
        .toBe(`https://rezics.test/${locale}/a/${sid}-reader?direction9=preserved`);
      expect(seen).toHaveLength(1);
    });
  }
}

test('G998: a canonical signed-in request carries admission without another resolver read or redirect', async () => {
  process.env.WEB_OAUTH_CLIENT_ID = 'g-998-test';
  let calls = 0;
  stub((url) => { calls += 1; return Response.json({ ...agent, key: url.searchParams.get('key') }); });
  const response = await proxy(new NextRequest(`https://rezics.test/en/a/${sid}-reader`, {
    headers: { cookie: signedInCookie, 'cf-connecting-ip': '203.0.113.17' },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get('location')).toBeNull();
  expect(calls).toBe(1);
  const admission = response.headers.get('x-middleware-request-x-rezics-resolved-address');
  expect(JSON.parse(decodeURIComponent(admission!)).holder).toBe(holder);
});

test('G998: rate limits preserve 429 and Retry-After instead of becoming an infrastructure 503', async () => {
  stub(() => Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'retry-after': '17' } }));
  const path = `https://rezics.test/en/a/${uuid.toUpperCase()}`;
  for (const response of [await proxy(new NextRequest(path)), await beforePathNormalization(new Request(`${path}/`))]) {
    expect(response?.status).toBe(429);
    expect(response?.headers.get('retry-after')).toBe('17');
    expect(response?.headers.get('location')).toBeNull();
    expect(response?.headers.get('cache-control')).toBe('no-store');
  }
});

test.each(['failure', 'timeout', 'malformed-canonical'])(
  'G998: transient Main %s never manufactures a permanent identity URL; a fresh request recovers', async (failure) => {
    stub(() => {
      if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
      return failure === 'failure' ? new Response(null, { status: 503 })
        : Response.json({ ...agent, canonical: { ...agent.canonical, key: uuid } });
    });
    const path = `https://rezics.test/zh-Hant/a/${uuid.toUpperCase()}?direction9=preserved`;
    const response = await proxy(new NextRequest(path, { headers: { cookie: 'rezics_refresh=private' } }));
    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    stub(() => Response.json(agent));
    const recovered = await proxy(new NextRequest(path));
    expect(recovered.status).toBe(301);
    expect(recovered.headers.get('location'))
      .toBe(`https://rezics.test/zh-Hant/a/${sid}-reader?direction9=preserved`);
  },
);

test('G998: trailing-slash Worker resolution forwards client attribution before normalization', async () => {
  stub((_url, headers) => {
    expect(headers.get('x-rezics-client-ip')).toBe('203.0.113.17');
    return Response.json(agent);
  });
  const response = await beforePathNormalization(new Request(`https://rezics.test/en/a/${uuid.toUpperCase()}/?x=1`, {
    headers: { 'cf-connecting-ip': '203.0.113.17' },
  }), 'https://main.test');
  expect(response?.status).toBe(301);
  expect(response?.headers.get('location')).toBe(`https://rezics.test/en/a/${sid}-reader?x=1`);
});

test('G998: the BFF attributes its session and preference lookups as well as the requested Main read', async () => {
  const paths: string[] = [];
  const send = (async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    paths.push(url.pathname);
    expect(headers.get('x-rezics-client-ip')).toBe('203.0.113.17');
    expect(headers.has('cookie')).toBe(false);
    if (url.pathname === '/v1/me/session-agent')
      return Response.json({ sessionAgent: { eligible: true, actingSubject: holder } });
    if (url.pathname === '/v1/me/person-preferences') return Response.json({ contentLanguages: ['sv'] });
    expect(headers.get('x-rezics-display-languages')).toContain('sv');
    return Response.json({ items: [] });
  }) as typeof fetch;
  const response = await forwardToMain(new Request('https://rezics.test/api/main/v1/works', {
    headers: { 'cf-connecting-ip': '203.0.113.17', cookie: 'rezics_session_key=g998',
      'x-rezics-client-ip': '192.0.2.99' },
  }), ['v1', 'works'], { mainOrigin: 'https://main.test', accessToken: 'g998-token', fetch: send });
  expect(response.status).toBe(200);
  expect(paths).toEqual(['/v1/me/session-agent', '/v1/me/person-preferences', '/v1/works']);
});

test('G998: an anonymous address lookup forwards the client while retaining URL language and no credentials', async () => {
  stub((_url, headers) => {
    expect(headers.get('x-rezics-client-ip')).toBe('203.0.113.17');
    expect(headers.get('x-rezics-display-languages')).toBe('sv,en');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    return Response.json(agent);
  });
  expect((await readAddress({ scope: 'agent', key: uuid }, 'sv,en', 'https://main.test',
    new Headers({ 'cf-connecting-ip': '203.0.113.17', cookie: 'private=secret' }))).kind).toBe('resolved');
});
