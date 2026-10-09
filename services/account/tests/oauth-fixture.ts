import { authorize, postToken } from '../../../scripts/lib/oauth-client.ts';
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
  const redirectUri = 'https://notes.example.test/callback';
  const oauth = (clientId: string) => ({ account: f.baseURL, clientId, redirectUri,
    scope: 'openid work:read offline_access', resource: f.config.resource });
  const token = (values: Record<string, string>) => postToken(oauth(values.client_id ?? ''), values);
  const code = async (clientId: string, cookie: string) => {
    const pending = await authorize(oauth(clientId), cookie);
    if (!pending.ok) throw new Error(`Authorize: ${pending.response.status} ${await pending.response.text()}`);
    return { client_id: clientId, code: pending.code, code_verifier: pending.verifier,
      redirect_uri: redirectUri, resource: f.config.resource };
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
    return response.json() as Promise<{ active: boolean; rezics_content_evidence?: unknown }>;
  };
  return { owner, verifier, createClient, code, issue, token, introspect };
}
