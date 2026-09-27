import { expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { accountFixture } from './account-fixture.ts';
import { providerScopes } from '../src/oauth-scopes.ts';
import { scopeDescriptions } from '../src/scope-descriptions.ts';

test('G205 consent: authenticated signed preview, localization, denial, tampering, stale and concurrent decisions', async () => {
  const f = await accountFixture();
  try {
    const owner = await f.signup('owner@example.test');
    const peer = await f.signup('peer@example.test');
    f.operators.add(owner.id);
    const client = await f.auth.api.adminCreateOAuthClient({ headers: new Headers({ origin: f.baseURL, cookie: owner.cookie }),
      body: { client_name: 'Notes', redirect_uris: ['https://notes.example.test/callback'],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
        scope: 'openid work:read offline_access', require_pkce: true } });
    const pending = async () => {
      const verifier = randomBytes(32).toString('base64url');
      const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id,
        redirect_uri: 'https://notes.example.test/callback', scope: 'openid work:read offline_access',
        state: randomUUID(), prompt: 'consent', resource: f.config.resource,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
      const response = await f.request(`/api/auth/oauth2/authorize?${query}`, undefined, owner.cookie);
      expect(response.status).toBe(302);
      return new URL(response.headers.get('location')!, f.baseURL).searchParams.toString();
    };
    const signed = await pending();
    const read = `/api/account/consent?${new URLSearchParams({ oauth_query: signed })}`;
    expect((await f.request(read)).status).toBe(401);
    const preview = await f.request(read, undefined, owner.cookie);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ client: { id: client.client_id, name: 'Notes' },
      scopes: [{ scope: 'openid', description: { en: 'Identify your REZICS account', 'zh-CN': '识别你的 REZICS 账号' } },
        { scope: 'work:read' }, { scope: 'offline_access' }], resources: [f.config.resource] });
    expect((await f.request(read, undefined, peer.cookie)).status).toBe(409);
    expect((await f.request(`/api/account/consent?${new URLSearchParams({ oauth_query: `${signed}&scope=work:edit` })}`,
      undefined, owner.cookie)).status).toBe(409);
    const denied = await f.request('/api/account/consent', { oauth_query: signed, accept: false }, owner.cookie);
    expect(denied.status).toBe(200);
    expect(new URL((await denied.json() as { url: string }).url).searchParams.get('error')).toBe('access_denied');
    expect((await f.pool.query('SELECT 1 FROM "oauthConsent"')).rowCount).toBe(0);
    expect((await f.request('/api/account/consent', { oauth_query: signed, accept: true }, owner.cookie)).status).toBe(409);
    const another = await pending();
    const raced = await Promise.all([1, 2].map(() => f.request('/api/auth/oauth2/update-consent',
      { oauth_query: another, accept: true }, owner.cookie)));
    expect(raced.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await f.pool.query('SELECT 1 FROM "oauthConsent"')).rowCount).toBe(1);
    const stale = await pending();
    await f.request(`/api/account/consent?${new URLSearchParams({ oauth_query: stale })}`, undefined, owner.cookie);
    await f.pool.query(`UPDATE rezics_account_pending_consent SET expires_at = now() - interval '1 second' WHERE decided_at IS NULL`);
    expect((await f.request('/api/account/consent', { oauth_query: stale, accept: true }, owner.cookie)).status).toBe(409);
    expect(scopeDescriptions.map(item => item.scope)).toEqual([...providerScopes]);
    expect(scopeDescriptions.every(item => item.description.en && item.description['zh-CN'])).toBe(true);
  } finally { await f.close(); }
}, 60_000);
