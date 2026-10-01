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

test('G-909: local fixture policy gates accept current owner digests once before OAuth', async () => {
  const calls: string[] = [];
  let accepted = false;
  const policies = [{ policyId: 'terms', versionDigest: 'a'.repeat(64) },
    { policyId: 'privacy', versionDigest: 'b'.repeat(64) }];
  const publicOrigin = 'http://localhost:39999';
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    calls.push(path);
    if (!path.endsWith('/oauth2/token')) expect(request.headers.get('cookie')).toBe('session=seed');
    if (path.endsWith('/oauth2/authorize')) return accepted
      ? new Response(null, { status: 302, headers: { location: 'http://localhost:3000/callback?code=code' } })
      : Response.json({ error: 'policy_acceptance_required' }, { status: 403 });
    if (path === '/api/account/policies') return Response.json({ acceptanceRequired: !accepted, policies });
    if (path === '/api/account/policies/acceptance') {
      expect(request.headers.get('origin')).toBe(publicOrigin);
      expect(await request.json()).toEqual({ acceptedPolicies: policies });
      accepted = true;
      return Response.json({ acceptanceRequired: false });
    }
    if (path.endsWith('/oauth2/token')) return Response.json({ access_token: 'token' });
    return new Response(null, { status: 404 });
  } });
  try {
    const api = new SeedApi({ account: publicOrigin, accountService: server.url.origin,
      main: 'http://localhost:3001', mailpit: '', clientId: 'client', redirectUri: 'http://localhost:3000/callback',
      resource: 'http://localhost:3001', scope: 'openid work:read' });
    expect(await api.token('session=seed')).toBe('token');
    expect(await api.token('session=seed')).toBe('token');
    expect(calls.filter(path => path === '/api/account/policies/acceptance')).toHaveLength(1);
    expect(calls.slice(0, 4)).toEqual(['/api/auth/oauth2/authorize', '/api/account/policies',
      '/api/account/policies/acceptance', '/api/auth/oauth2/authorize']);
  } finally { await server.stop(true); }
});

test('G-909: remote Account policy refusals never trigger automatic acceptance', async () => {
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    calls.push(new URL(request.url).pathname);
    return Response.json({ error: 'policy_acceptance_required' }, { status: 403 });
  } });
  try {
    const api = new SeedApi({ account: 'https://account.example.test', accountService: server.url.origin,
      main: 'http://localhost:3001', mailpit: '', clientId: 'client', redirectUri: 'http://localhost:3000/callback',
      resource: 'http://localhost:3001', scope: 'openid work:read' });
    await expect(api.token('session=seed')).rejects.toThrow('policy_acceptance_required');
    expect(calls).toEqual(['/api/auth/oauth2/authorize']);
  } finally { await server.stop(true); }
});

test('G-909: transient OAuth authorization failures retry the same PKCE request', async () => {
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    if (new URL(request.url).pathname.endsWith('/oauth2/token')) return Response.json({ access_token: 'token' });
    requests.push(request.url);
    return requests.length < 3 ? new Response(null, { status: requests.length === 1 ? 500 : 503 })
      : new Response(null, { status: 302, headers: { location: 'http://localhost:3000/callback?code=code' } });
  } });
  try {
    const api = new SeedApi({ account: server.url.origin, main: 'http://localhost:3001', mailpit: '', clientId: 'client',
      redirectUri: 'http://localhost:3000/callback', resource: 'http://localhost:3001', scope: 'openid work:read' });
    expect(await api.token('session=seed')).toBe('token');
    expect(requests).toHaveLength(3);
    expect(new Set(requests).size).toBe(1);
  } finally { await server.stop(true); }
});
