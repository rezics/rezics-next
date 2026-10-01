import { expect, test } from 'bun:test';
import { SeedApi } from './api.ts';

test('G-909: Account service authentication and PKCE exchange preserve the public origin', async () => {
  const publicOrigin = 'http://127.0.0.1:39999';
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const url = new URL(request.url);
    calls.push(url.pathname);
    if (url.pathname.endsWith('/sign-in/email')) {
      expect(request.headers.get('origin')).toBe(publicOrigin);
      expect(await request.json()).toEqual({ email: 'reader@example.test', password: 'password' });
      return Response.json({ user: { id: 'account-id' } }, { headers: { 'set-cookie': 'session=seed' } });
    }
    if (url.pathname.endsWith('/oauth2/authorize')) {
      expect(request.headers.get('cookie')).toBe('session=seed');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('client_id')).toBe('client');
      return new Response(null, { status: 302, headers: { location: 'http://localhost:3000/callback?code=code' } });
    }
    if (url.pathname.endsWith('/oauth2/token')) {
      const body = new URLSearchParams(await request.text());
      expect(body.get('code')).toBe('code');
      expect(body.get('code_verifier')).toBeString();
      return Response.json({ access_token: 'token' });
    }
    return new Response(null, { status: 404 });
  } });
  try {
    const api = new SeedApi({ account: publicOrigin, accountService: server.url.origin,
      main: 'http://localhost:3001', mailpit: '', clientId: 'client', redirectUri: 'http://localhost:3000/callback',
      resource: 'http://localhost:3001', scope: 'openid work:read' });
    const signed = await api.signInOrUp({ email: 'reader@example.test', password: 'password' });
    expect(await api.token(signed.cookie)).toBe('token');
    expect(api.endpoints.account).toBe(publicOrigin);
    expect(calls).toEqual(['/api/auth/sign-in/email', '/api/auth/oauth2/authorize', '/api/auth/oauth2/token']);
  } finally { await server.stop(true); }
});
