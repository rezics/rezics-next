import { expect, test } from 'bun:test';
import { signIn, type LocalOAuthClient } from '../../../scripts/lib/oauth-client.ts';

const account = 'http://127.0.0.1:4404';
const redirectUri = 'http://127.0.0.1:4400/auth/callback';
const granted = 'openid work:read';

function issuer(consent: boolean, changeScope = false): { client: LocalOAuthClient; calls: string[] } {
  const calls: string[] = [];
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
          expires_in: 30, scope: granted, token_type: 'Bearer' });
      }
      expect(form.get('grant_type')).toBe('refresh_token');
      expect(form.get('scope')).toBe(granted);
      expect(form.get('refresh_token')).toBe(`${client.clientId}-refresh`);
      return Response.json({ access_token: `${client.clientId}-renewed`, refresh_token: `${client.clientId}-refresh-2`,
        expires_in: 30, scope: changeScope ? 'openid' : granted, token_type: 'Bearer' });
    },
  };
  return { client, calls };
}

test('a trusted client and a consent-bearing client sign in and refresh an expired token with the granted scopes', async () => {
  for (const consent of [false, true]) {
    const { client, calls } = issuer(consent);
    const session = await signIn(client, 'session=local', { now: () => 1_000 });
    expect(session.scope).toBe(granted);
    expect(await session.current(1_000)).toBe(`${client.clientId}-access`);
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
