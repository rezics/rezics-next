import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { accountFixture } from './account-fixture.ts';

export async function oauthFixture(f: Awaited<ReturnType<typeof accountFixture>>) {
  const owner = await f.signup('oauth-owner@example.test');
  f.operators.add(owner.id);
  const headers = new Headers({ origin: f.baseURL, cookie: owner.cookie });
  const verifier = await f.auth.api.adminCreateOAuthClient({ headers,
    body: { client_name: 'Resource verifier', token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'], scope: 'work:read', client_credentials_scopes: ['work:read'] } });
  const createClient = (trusted = false) => f.auth.api.adminCreateOAuthClient({ headers,
    body: { client_name: trusted ? 'Trusted app' : 'Notes', token_endpoint_auth_method: 'none',
      redirect_uris: ['https://notes.example.test/callback'], grant_types: ['authorization_code', 'refresh_token'],
      scope: 'openid work:read offline_access', require_pkce: true, skip_consent: trusted } });
  const token = (values: Record<string, string>) => fetch(`${f.baseURL}/api/auth/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values) });
  const code = async (clientId: string, cookie: string) => {
    const verifier = randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId,
      redirect_uri: 'https://notes.example.test/callback', scope: 'openid work:read offline_access',
      state: randomUUID(), resource: f.config.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const authorized = await f.request(`/api/auth/oauth2/authorize?${query}`, undefined, cookie);
    let destination = new URL(authorized.headers.get('location')!, f.baseURL);
    if (destination.pathname === '/consent') {
      const consent = await f.request('/api/account/consent', { oauth_query: destination.searchParams.toString(), accept: true }, cookie);
      if (!consent.ok) throw new Error(`Consent: ${consent.status} ${await consent.text()}`);
      destination = new URL((await consent.json() as { url: string }).url);
    }
    if (!destination.searchParams.get('code')) throw new Error(`Authorize: ${destination}`);
    return { client_id: clientId, code: destination.searchParams.get('code')!,
      code_verifier: verifier, redirect_uri: 'https://notes.example.test/callback', resource: f.config.resource };
  };
  const issue = async (clientId: string, cookie: string) => {
    const response = await token({ ...await code(clientId, cookie), grant_type: 'authorization_code' });
    if (!response.ok) throw new Error(`Token: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ access_token: string; refresh_token: string }>;
  };
  const introspect = async (accessToken: string) => {
    const response = await fetch(`${f.baseURL}/api/auth/oauth2/introspect`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken, client_id: verifier.client_id,
        client_secret: verifier.client_secret! }) });
    if (!response.ok) throw new Error(`Introspect: ${response.status}`);
    return response.json() as Promise<{ active: boolean }>;
  };
  return { owner, createClient, code, issue, token, introspect };
}
