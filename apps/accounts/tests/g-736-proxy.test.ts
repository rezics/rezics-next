import { describe, expect, test } from 'bun:test';
import { edgeCountry, proxyAccountRequest } from '../features/proxy/account-proxy.ts';

const own = 'http://127.0.0.1:41234';
const options = (response: () => Response) => {
  const calls: Headers[] = [];
  const fetch = (async (_url: URL, init: RequestInit) => {
    calls.push(init.headers as Headers);
    return response();
  }) as typeof globalThis.fetch;
  return { calls, options: { serviceOrigin: 'http://127.0.0.1:3002', publicOrigin: own, fetch } };
};
const withEdge = (url: string, cf: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Request(url, { headers }), cf === undefined ? {} : { cf });

describe('G-736 edge country', () => {
  test('on Cloudflare only the edge country is used, never a client header', () => {
    expect(edgeCountry(withEdge(`${own}/`, { country: 'KR' }, { 'cf-ipcountry': 'US' }))).toBe('KR');
    expect(edgeCountry(withEdge(`${own}/`, {}, { 'cf-ipcountry': 'US' }))).toBeUndefined();
    expect(edgeCountry(withEdge(`${own}/`, { country: 'kr' }))).toBeUndefined();
  });

  test('development may choose the region by header even where an edge reports one country', () => {
    const request = withEdge(`${own}/`, { country: 'GB' }, { 'cf-ipcountry': 'KR' });
    expect(edgeCountry(request)).toBe('GB');
    expect(edgeCountry(request, true)).toBe('KR');
  });

  test('without an edge (local development) the header passes through when well formed', () => {
    expect(edgeCountry(withEdge(`${own}/`, undefined, { 'cf-ipcountry': 'US' }))).toBe('US');
    expect(edgeCountry(withEdge(`${own}/`, undefined, { 'cf-ipcountry': 'usa' }))).toBeUndefined();
  });

  test('the service receives the resolved country, replacing any client value', async () => {
    const { calls, options: o } = options(() => Response.json({}));
    await proxyAccountRequest(
      withEdge(`${own}/api/auth/sign-up/email`, { country: 'DE' }, { 'cf-ipcountry': 'US' }),
      o,
    );
    expect(calls[0]!.get('cf-ipcountry')).toBe('DE');
    await proxyAccountRequest(withEdge(`${own}/api/auth/sign-up/email`, {}, { 'cf-ipcountry': 'US' }), o);
    expect(calls[1]!.get('cf-ipcountry')).toBeNull();
  });
});

describe('G-736 pages for browser navigations', () => {
  const navigation = { 'sec-fetch-mode': 'navigate' };

  test('a refused authorize request resumes after accepting the current policies', async () => {
    const { options: o } = options(() =>
      Response.json({ code: 'policy_acceptance_required' }, { status: 403 }));
    const response = await proxyAccountRequest(
      new Request(`${own}/api/auth/oauth2/authorize?client_id=reader&sig=abc`, { headers: navigation }),
      o,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${own}/accept-policies`);
    expect(location.searchParams.get('continue')).toBe('/api/auth/oauth2/authorize?client_id=reader&sig=abc');
  });

  test('a server caller or another refusal keeps the service’s answer', async () => {
    const refused = () => Response.json({ code: 'policy_acceptance_required' }, { status: 403 });
    const server = await proxyAccountRequest(
      new Request(`${own}/api/auth/oauth2/authorize?client_id=reader`),
      options(refused).options,
    );
    expect(server.status).toBe(403);
    const other = await proxyAccountRequest(
      new Request(`${own}/api/auth/oauth2/authorize?client_id=reader`, { headers: navigation }),
      options(() => Response.json({ code: 'OTHER' }, { status: 403 })).options,
    );
    expect(other.status).toBe(403);
  });

  test('an unsubscribe link opened in a browser shows the page; the one-click POST does not', async () => {
    const { calls, options: o } = options(() => Response.json({ confirmationRequired: true }));
    const page = await proxyAccountRequest(
      new Request(`${own}/api/account/mail/unsubscribe?token=t.s`, { headers: navigation }),
      o,
    );
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(`${own}/unsubscribe?token=t.s`);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const post = await proxyAccountRequest(
      new Request(`${own}/api/account/mail/unsubscribe?token=t.s`, {
        method: 'POST',
        body: 'List-Unsubscribe=One-Click',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-mode': 'navigate' },
      }),
      o,
    );
    expect(post.status).toBe(200);
    expect(calls).toHaveLength(2);
  });
});
