import { expect, test } from 'bun:test';
import { signIn, type LocalOAuthClient } from '../../../scripts/lib/oauth-client.ts';

const account = 'http://127.0.0.1:4404';
const redirectUri = 'http://127.0.0.1:4400/auth/callback';
const granted = 'openid work:read';

function issuer(consent: boolean, changeScope = false, expiresIn = 30): { client: LocalOAuthClient; calls: string[] } {
  const calls: string[] = [];
  let refreshes = 0;
  const client: LocalOAuthClient = {
    account, clientId: consent ? 'consent-client' : 'trusted-client', redirectUri, scope: granted,
    resource: 'https://main.rezics.test',
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/auth/oauth2/authorize') {
        expect(url.searchParams.get('code_challenge_method')).toBe('S256');
        expect(url.searchParams.get('scope')).toBe(granted);
        expect(url.searchParams.get('client_id')).toBe(client.clientId);
        const location = consent
          ? `${account}/consent?sig=signed-query&scope=${encodeURIComponent(granted)}`
          : `${redirectUri}?code=${consent ? 'consent' : 'trusted'}-code`;
        return new Response(null, { status: 302, headers: { location } });
      }
      if (url.pathname === '/api/account/consent') {
        const body = JSON.parse(String(init?.body)) as { accept?: boolean; oauth_query?: string; scope?: string };
        expect(body.accept).toBe(true);
        expect(body.oauth_query).toContain('sig=signed-query');
        expect(body.scope).toBe(granted);
        expect(new Headers(init?.headers).get('origin')).toBe(account);
        return Response.json({ url: `${redirectUri}?code=consent-code` });
      }
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('code_verifier')!.length).toBeGreaterThan(30);
        expect(form.get('redirect_uri')).toBe(redirectUri);
        return Response.json({ access_token: `${client.clientId}-access`, refresh_token: `${client.clientId}-refresh`,
          expires_in: expiresIn, scope: granted, token_type: 'Bearer' });
      }
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('scope')).toBe(granted);
      expect(form.get('refresh_token')).toBe(`${client.clientId}-refresh${refreshes === 0 ? '' : `-${refreshes + 1}`}`);
      expect(form.get('resource')).toBe(client.resource!);
      refreshes++;
      return Response.json({ access_token: `${client.clientId}-renewed${refreshes === 1 ? '' : `-${refreshes}`}`, refresh_token: `${client.clientId}-refresh-${refreshes + 1}`,
        expires_in: expiresIn, scope: changeScope ? 'openid' : granted, token_type: 'Bearer' });
    },
  };
  return { client, calls };
}

test('a trusted client and a consent-bearing client sign in and refresh an expired token with the granted scopes', async () => {
  for (const consent of [false, true]) {
    const { client, calls } = issuer(consent);
    const session = await signIn(client, 'session=local', { now: () => 1_000 });
    expect(session.scope).toBe(granted);
    expect(await session.current(1_000, 0)).toBe(`${client.clientId}-access`);
    expect(calls.some(call => call.startsWith('POST /api/account/consent'))).toBe(consent);
    expect(await session.current(31_000)).toBe(`${client.clientId}-renewed`);
    expect(session.scope).toBe(granted);
    expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toEqual([
      'POST /api/auth/oauth2/token', 'POST /api/auth/oauth2/token']);
  }
});

test('refresh refuses a token whose scopes differ from the grant', async () => {
  const { client } = issuer(false, true);
  const session = await signIn(client, 'session=local', { now: () => 0 });
  await expect(session.current(60_000)).rejects.toThrow('Refresh changed the granted scopes');
});

test('slow exchanges count token life from the request and renew within the default margin', async () => {
  const { client, calls } = issuer(false, false, 300);
  let now = 0;
  const send = client.fetch!;
  client.fetch = async (input, init) => {
    const response = await send(input, init);
    if (new URL(String(input)).pathname === '/api/auth/oauth2/token') now += 10_000;
    return response;
  };
  const session = await signIn(client, 'session=local', { now: () => now });
  expect(now).toBe(10_000);
  now = 269_000;
  expect(await session.current()).toBe(`${client.clientId}-access`);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(1);
  now = 280_000;
  expect(await Promise.all([session.current(), session.current()]))
    .toEqual([`${client.clientId}-renewed`, `${client.clientId}-renewed`]);
  expect(now).toBe(290_000);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(2);
  // The renewal's ten-second response delay must not extend its lifetime either.
  now = 549_000;
  expect(await session.current()).toBe(`${client.clientId}-renewed`);
  now = 550_000;
  expect(await session.current()).toBe(`${client.clientId}-renewed-2`);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(3);
});

test('a caller with no validity margin still expires a slow sign-in at its request-based deadline', async () => {
  const { client } = issuer(false, false, 300);
  let now = 0;
  const send = client.fetch!;
  client.fetch = async (input, init) => {
    const response = await send(input, init);
    if (new URL(String(input)).pathname === '/api/auth/oauth2/token') now += 10_000;
    return response;
  };
  const session = await signIn(client, 'session=local', { now: () => now });
  now = 299_999;
  expect(await session.current(undefined, 0)).toBe(`${client.clientId}-access`);
  now = 300_000;
  expect(await session.current(undefined, 0)).toBe(`${client.clientId}-renewed`);
});

test('a request validity window refreshes before expiry and shares one rotating grant across concurrent callers', async () => {
  const { client, calls } = issuer(false, false, 300);
  const session = await signIn(client, 'session=local', { now: () => 1_000 });
  expect(await session.current(270_999, 30_000)).toBe(`${client.clientId}-access`);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(1);
  expect(await Promise.all([session.current(271_000, 30_000), session.current(271_000, 30_000)]))
    .toEqual([`${client.clientId}-renewed`, `${client.clientId}-renewed`]);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(2);
  expect(await session.current(540_999, 30_000)).toBe(`${client.clientId}-renewed`);
  expect(await session.current(541_000, 30_000)).toBe(`${client.clientId}-renewed-2`);
  expect(session.refreshToken).toBe(`${client.clientId}-refresh-3`);
  expect(session.scope).toBe(granted);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(3);
});

test('concurrent early refresh failures propagate without replacing the grant and allow a later retry', async () => {
  const { client, calls } = issuer(false, true, 300);
  const session = await signIn(client, 'session=local', { now: () => 1_000 });
  const refresh = () => session.current(271_000, 30_000);
  const outcomes = await Promise.allSettled([refresh(), refresh()]);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason.message).toBe('Refresh changed the granted scopes');
  }
  expect(session.accessToken).toBe(`${client.clientId}-access`);
  expect(session.refreshToken).toBe(`${client.clientId}-refresh`);
  expect(calls.filter(call => call === 'POST /api/auth/oauth2/token')).toHaveLength(2);
  // Retry the same original grant after a rejected response, rather than using
  // its unaccepted token or silently signing the fixture in again.
  client.fetch = async () => Response.json({ error: 'invalid_grant' }, { status: 400 });
  await expect(refresh()).rejects.toThrow('refresh: HTTP 400');
});
