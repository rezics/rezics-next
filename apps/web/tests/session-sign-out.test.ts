import { expect, test } from 'bun:test';
import type { AccountClient } from '../features/auth/account.ts';
import { signOut } from '../features/auth/sign-out.ts';

function account(options: { down?: boolean } = {}) {
  const calls: Array<{ url: string; headers: Headers; body: string }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body ?? '') });
    if (options.down) throw new TypeError('connection refused');
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const client: AccountClient = { accountOrigin: 'http://account.test', clientId: 'web',
    resource: 'https://main.rezics.test', fetch: fetcher };
  return { client, calls };
}

const input = (client: AccountClient | null, next: string | null) => ({
  requestUrl: 'https://web.rezics.test/sign-out', refreshToken: 'refresh-1', client, next });

test('IAM01: sign-out revokes the refresh token and clears every web session cookie', async () => {
  const { client, calls } = account();
  const response = await signOut(input(client, '/works/6b92?view=main'));
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('https://web.rezics.test/works/6b92?view=main');
  expect(calls.map(call => call.url)).toEqual(['http://account.test/api/auth/oauth2/revoke']);
  expect(Object.fromEntries(new URLSearchParams(calls[0]!.body)))
    .toEqual({ client_id: 'web', token: 'refresh-1', token_type_hint: 'refresh_token' });
  expect(calls[0]!.headers.has('cookie')).toBe(false);
  const set = response.headers.getSetCookie();
  for (const name of ['rezics_access', 'rezics_refresh', 'rezics_session',
    'rezics_session_key', 'rezics_subject']) {
    const line = set.find(item => item.startsWith(`${name}=`));
    expect(line, name).toMatch(/Max-Age=0/);
    expect(line).toMatch(/Secure/);
  }
  expect(set.some(line => line.startsWith('better-auth.session_token='))).toBe(false);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('IAM01: sign-out stays on this site and signs the browser out even when Account is down', async () => {
  const { client, calls } = account({ down: true });
  for (const next of ['https://other.test/', '//other.test', null]) {
    const response = await signOut(input(client, next));
    expect(response.headers.get('location')).toBe('https://web.rezics.test/');
    expect(response.headers.getSetCookie().filter(line => /^rezics_\w+=;/.test(line) || /^rezics_\w+=(;|$)/.test(line)))
      .toHaveLength(5);
  }
  expect(calls.length).toBe(3);
});
