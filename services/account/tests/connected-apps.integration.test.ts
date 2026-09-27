import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { reusableSeedClient } from '../../../scripts/dev/seed/operator.ts';

test('official Zone seed reuses an installed OAuth client and rejects a stale ceiling', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const redirectUri = 'http://127.0.0.1:3000/auth/callback';
    const scope = 'openid owner:operate zone:edit';
    const registered = await f.auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: oauth.owner.cookie, origin: f.baseURL }),
      body: { client_name: 'Local official Zone seed', application_type: 'native',
        redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], skip_consent: true, require_pkce: true, scope },
    });
    expect(await reusableSeedClient(f.pool, oauth.owner.id, redirectUri, scope)).toBe(registered.client_id);
    expect(await reusableSeedClient(f.pool, oauth.owner.id, 'http://127.0.0.1:3001/auth/callback', scope))
      .toBeUndefined();
    await f.pool.query(`UPDATE rezics_oauth_installation SET scopes = scopes - 'zone:edit'
      WHERE client_id = $1`, [registered.client_id]);
    expect(await reusableSeedClient(f.pool, oauth.owner.id, redirectUri, scope)).toBeUndefined();
  } finally { await f.close(); }
}, 60_000);

test('G205 apps: described grants, actual last use, private revocation and stale trusted/consent token fences', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('connected@example.test');
    const peer = await f.signup('peer@example.test');
    const client = await oauth.createClient();
    const trusted = await oauth.createClient(true);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [trusted.client_id]);
    const initial = await oauth.issue(client.client_id, member.cookie);
    const trustedTokens = await oauth.issue(trusted.client_id, member.cookie);
    expect(await oauth.introspect(initial.access_token)).toMatchObject({ active: true });
    expect(await oauth.introspect(trustedTokens.access_token)).toMatchObject({ active: true });
    const list = await (await f.request('/api/account/connected-apps?limit=1', undefined, member.cookie)).json() as {
      items: { clientId: string; lastUsedAt: string | null; scopes: { scope: string }[] }[]; nextCursor: string };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.lastUsedAt).toBeTruthy();
    expect(list.items[0]!.scopes.map(item => item.scope)).toContain('work:read');
    const marked = await (await f.request('/api/account/connected-apps?limit=25', undefined, member.cookie)).json() as {
      items: { clientId: string; trusted: boolean; firstParty: boolean }[] };
    expect(marked.items.find(item => item.clientId === trusted.client_id)).toMatchObject({ trusted: true, firstParty: true });
    expect(marked.items.find(item => item.clientId === client.client_id)?.firstParty).toBe(false);
    const second = await f.request(`/api/account/connected-apps?limit=1&cursor=${encodeURIComponent(list.nextCursor)}`, undefined, member.cookie);
    expect(second.status).toBe(200);
    expect((await f.request(`/api/account/connected-apps/${client.client_id}/revoke`, {}, peer.cookie)).status).toBe(404);
    const held = await oauth.code(trusted.client_id, member.cookie);
    const revocations = await Promise.all([1, 2].map(() => f.request(`/api/account/connected-apps/${trusted.client_id}/revoke`, {}, member.cookie)));
    expect(revocations.every(response => response.status === 200)).toBe(true);
    expect(await oauth.introspect(trustedTokens.access_token)).toEqual({ active: false });
    expect((await oauth.token({ grant_type: 'refresh_token', client_id: trusted.client_id,
      refresh_token: trustedTokens.refresh_token, resource: f.config.resource })).ok).toBe(false);
    expect((await oauth.token({ ...held, grant_type: 'authorization_code' })).ok).toBe(false);
    expect(await oauth.introspect(initial.access_token)).toMatchObject({ active: true });
    const renewed = await oauth.issue(trusted.client_id, member.cookie);
    expect(await oauth.introspect(renewed.access_token)).toMatchObject({ active: true });
    expect(await oauth.introspect(trustedTokens.access_token)).toEqual({ active: false });
    await f.request(`/api/account/connected-apps/${client.client_id}/revoke`, {}, member.cookie);
    expect(await oauth.introspect(initial.access_token)).toEqual({ active: false });
    expect((await f.pool.query('SELECT 1 FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2', [member.id, client.client_id])).rowCount).toBe(0);
  } finally { await f.close(); }
}, 60_000);
