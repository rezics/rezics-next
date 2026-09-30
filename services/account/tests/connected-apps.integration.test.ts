import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { disableSupersededSeedClients, operatorSeedSession, reusableSeedClient } from '../../../scripts/dev/seed/operator.ts';
import { setClientDisabled } from '../src/admin-actions.ts';

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

test('G373 seed: concurrent and repeated runs share one installed client', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const databaseUrl = `postgresql://${f.pool.options.user}@127.0.0.1:${f.pool.options.port}/postgres`;
    const input = { accountDatabaseUrl: databaseUrl, accessDatabaseUrl: databaseUrl, accountSecret: f.secret,
      credentials: { email: oauth.owner.email, password: oauth.owner.password }, accountSubject: oauth.owner.id,
      ownerAccountSubject: oauth.owner.id, actingSubject: oauth.owner.id,
      endpoints: { account: f.baseURL, main: f.config.resource, resource: f.config.resource, mailpit: f.baseURL,
        clientId: '', redirectUri: 'https://notes.example.test/callback', scope: 'openid' } };
    const first = await Promise.all([operatorSeedSession(input), operatorSeedSession(input)]);
    const repeated = await operatorSeedSession(input);
    expect(new Set([...first, repeated].map(session => session.api.endpoints.clientId)).size).toBe(1);
    for (const session of [...first, repeated]) expect(await oauth.introspect(session.token)).toMatchObject({ active: true });
    expect((await f.pool.query(`SELECT 1 FROM "oauthClient" WHERE name = 'Local official Zone seed'`)).rowCount).toBe(1);
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
    expect(marked.items.find(item => item.clientId === trusted.client_id)).toBeUndefined();
    expect(marked.items.find(item => item.clientId === client.client_id)?.firstParty).toBe(false);
    expect(list.nextCursor).toBeNull();
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

test('G522 apps: only explicit consents are private and paginated; product sessions and operator grants stay out', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const reader = await f.signup('reader@example.test');
    const peer = await f.signup('peer@example.test');
    const consented = await oauth.createClient();
    const secondConsented = await oauth.createClient();
    const firstParty = await oauth.createClient(true);
    const unusedFirstParty = await oauth.createClient(true);
    const operator = await oauth.createClient(true);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1), ($2)',
      [firstParty.client_id, unusedFirstParty.client_id]);
    await oauth.issue(consented.client_id, reader.cookie);
    await oauth.issue(secondConsented.client_id, reader.cookie);
    await oauth.issue(firstParty.client_id, reader.cookie);
    const unattended = await oauth.issue(operator.client_id, reader.cookie);
    await oauth.introspect(unattended.access_token);
    await oauth.issue(consented.client_id, peer.cookie);
    const list = async (cookie: string, cursor = '') => {
      const response = await f.request(`/api/account/connected-apps?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, undefined, cookie);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ items: { clientId: string }[]; nextCursor: string | null }>;
    };
    const first = await list(reader.cookie);
    expect(first.items.map(app => app.clientId)).toEqual([secondConsented.client_id]);
    expect(first.nextCursor).toBeTruthy();
    const second = await list(reader.cookie, first.nextCursor!);
    expect(second.items.map(app => app.clientId)).toEqual([consented.client_id]);
    expect(second.nextCursor).toBeNull();
    expect((await list(peer.cookie)).items.map(app => app.clientId)).toEqual([consented.client_id]);
    expect((await f.request(`/api/account/connected-apps?cursor=${encodeURIComponent(first.nextCursor!)}`, undefined, peer.cookie)).status).toBe(400);
    expect((await f.request('/api/account/connected-apps')).status).toBe(401);
    // Changing client trust does not hide someone's explicit consent.
    await f.pool.query('UPDATE "oauthClient" SET "skipConsent" = true WHERE "clientId" = $1', [consented.client_id]);
    expect((await list(peer.cookie)).items.map(app => app.clientId)).toEqual([consented.client_id]);
    await f.request(`/api/account/connected-apps/${firstParty.client_id}/revoke`, {}, reader.cookie);
    expect((await list(reader.cookie)).items.map(app => app.clientId)).toEqual([secondConsented.client_id]);
  } finally { await f.close(); }
}, 60_000);

test('G373 seed: reuse one matching client and audit disabling only its owner’s superseded clients', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const headers = new Headers({ cookie: oauth.owner.cookie, origin: f.baseURL });
    const create = () => f.auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'Local official Zone seed', token_endpoint_auth_method: 'none',
        redirect_uris: ['https://notes.example.test/callback'], grant_types: ['authorization_code', 'refresh_token'],
        scope: 'openid work:read offline_access', require_pkce: true, skip_consent: true } });
    const older = await create();
    const kept = await create();
    const otherOwner = await create();
    // Provider timestamps can share a second; make the superseded ordering explicit.
    await f.pool.query('UPDATE "oauthClient" SET "createdAt" = "createdAt" - interval \'1 minute\' WHERE "clientId" = $1',
      [older.client_id]);
    const peer = await f.signup('peer-seed@example.test');
    await f.pool.query('UPDATE "oauthClient" SET "userId" = $1 WHERE "clientId" = $2', [peer.id, otherOwner.client_id]);
    const tokens = await oauth.issue(older.client_id, oauth.owner.cookie);
    const cleanup = () => disableSupersededSeedClients(f.pool, oauth.owner.id, kept.client_id, clientId =>
      setClientDisabled(f.auth, f.pool, new Request(f.baseURL, { headers }), clientId,
        { action: 'disable', reason: 'Superseded local Zone seed client', commandId: crypto.randomUUID() }));
    expect(await reusableSeedClient(f.pool, oauth.owner.id, 'https://notes.example.test/callback', 'openid work:read'))
      .toBe(kept.client_id);
    await cleanup();
    await cleanup();
    const clients = await f.pool.query<{ clientId: string; disabled: boolean }>(
      'SELECT "clientId", disabled FROM "oauthClient" WHERE "clientId" = ANY($1::text[])',
      [[older.client_id, kept.client_id, otherOwner.client_id]]);
    expect(clients.rows.find(client => client.clientId === older.client_id)?.disabled).toBe(true);
    expect(clients.rows.filter(client => !client.disabled).map(client => client.clientId).sort())
      .toEqual([kept.client_id, otherOwner.client_id].sort());
    expect(await oauth.introspect(tokens.access_token)).toEqual({ active: false });
    expect((await f.pool.query(`SELECT 1 FROM rezics_account_operator_audit
      WHERE target_id = $1 AND action = 'client_disabled'`, [older.client_id])).rowCount).toBe(1);
  } finally { await f.close(); }
}, 60_000);
