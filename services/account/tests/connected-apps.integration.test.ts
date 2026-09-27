import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

test('G205 apps: described grants, actual last use, private revocation and stale trusted/consent token fences', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const member = await f.signup('connected@example.test');
    const peer = await f.signup('peer@example.test');
    const client = await oauth.createClient();
    const trusted = await oauth.createClient(true);
    const initial = await oauth.issue(client.client_id, member.cookie);
    const trustedTokens = await oauth.issue(trusted.client_id, member.cookie);
    expect(await oauth.introspect(initial.access_token)).toMatchObject({ active: true });
    expect(await oauth.introspect(trustedTokens.access_token)).toMatchObject({ active: true });
    const list = await (await f.request('/api/account/connected-apps?limit=1', undefined, member.cookie)).json() as {
      items: { clientId: string; lastUsedAt: string | null; scopes: { scope: string }[] }[]; nextCursor: string };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]!.lastUsedAt).toBeTruthy();
    expect(list.items[0]!.scopes.map(item => item.scope)).toContain('work:read');
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
