import { expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { revokeSessions } from '../src/security-activity.ts';

test('G522 classification: registry membership, skipConsent and explicit consent are independent', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const reader = await f.signup('classification@example.test');
    const matrix: { clientId: string; firstParty: boolean; skipConsent: boolean }[] = [];
    for (const firstParty of [false, true]) {
      for (const skipConsent of [false, true]) {
        const client = await oauth.createClient(skipConsent);
        await oauth.issue(client.client_id, reader.cookie);
        if (firstParty) await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
        matrix.push({ clientId: client.client_id, firstParty, skipConsent });
      }
    }
    const apps = await (await f.request('/api/account/connected-apps', undefined, reader.cookie)).json() as {
      items: { clientId: string }[] };
    expect(apps.items.map(app => app.clientId).sort()).toEqual(matrix.filter(client => !client.skipConsent).map(client => client.clientId).sort());
    const response = await f.request('/api/account/admin/clients?limit=100', undefined, oauth.owner.cookie);
    expect(response.status).toBe(200);
    const admin = await response.json() as { items: typeof matrix };
    for (const client of matrix) expect(admin.items.find(item => item.clientId === client.clientId)).toMatchObject(client);
    // Trust changes must not erase the explicit consent from the person's list.
    await f.pool.query('UPDATE "oauthClient" SET "skipConsent" = NOT "skipConsent" WHERE "clientId" = ANY($1::text[])',
      [matrix.map(client => client.clientId)]);
    const changed = await (await f.request('/api/account/connected-apps', undefined, reader.cookie)).json() as typeof apps;
    expect(changed.items.map(app => app.clientId).sort()).toEqual(apps.items.map(app => app.clientId).sort());
  } finally { await f.close(); }
}, 60_000);

for (const mode of ['single', 'group', 'others'] as const) {
  test(`G522 session sign-out (${mode}): revokes rotated product refresh tokens, preserves other people and current session`, async () => {
    const f = await accountFixture();
    try {
      const oauth = await oauthFixture(f);
      const client = await oauth.createClient(true);
      await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
      await f.pool.query('UPDATE "oauthClient" SET name = $1 WHERE "clientId" = $2', ['REZICS', client.client_id]);
      const reader = await f.signup(`sessions-${mode}@example.test`);
      const peer = await f.signup(`peer-${mode}@example.test`);
      const signedIn = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password },
        undefined, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0' });
      const cookie = signedIn.headers.get('set-cookie')!;
      const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
      const issued = await oauth.issue(client.client_id, cookie);
      const refresh = (token: string) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
        refresh_token: token, resource: f.config.resource });
      const rotated = await refresh(issued.refresh_token);
      expect(rotated.ok).toBe(true);
      const tokens = await rotated.json() as { access_token: string; refresh_token: string; expires_in: number };
      expect(tokens.expires_in).toBe(300);
      // Qualify the pinned provider's binding on issuance AND rotation.
      const stored = await f.pool.query<{ sessionId: string | null }>(
        'SELECT "sessionId" FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2', [reader.id, client.client_id]);
      expect(stored.rows).toHaveLength(2);
      expect(stored.rows.every(row => row.sessionId === session!.session.id)).toBe(true);
      const currentTokens = await oauth.issue(client.client_id, reader.cookie);
      const peerTokens = await oauth.issue(client.client_id, peer.cookie);
      const list = await (await f.request('/api/account/sessions', undefined, reader.cookie)).json() as {
        items: { id: string; thisDevice: boolean; clientName: string | null; device: { browser: string } }[] };
      expect(list.items.find(row => row.id === session!.session.id)).toMatchObject({ clientName: 'REZICS', device: { browser: 'Chrome' } });
      expect(await (await f.request('/api/account/sessions/revoke', { sessionId: session!.session.id }, peer.cookie)).json())
        .toEqual({ revoked: 0 });
      expect((await refresh(peerTokens.refresh_token)).ok).toBe(true);
      const selection = mode === 'single' ? { sessionId: session!.session.id }
        : mode === 'group' ? { sessionIds: [session!.session.id, session!.session.id, 'missing'] } : { others: true };
      const revoke = () => f.request('/api/account/sessions/revoke', selection, reader.cookie);
      expect(await (await revoke()).json()).toEqual({ revoked: mode === 'others' ? list.items.filter(row => !row.thisDevice).length : 1 });
      expect(await (await revoke()).json()).toEqual({ revoked: 0 });
      expect((await refresh(tokens.refresh_token)).ok).toBe(false);
      expect((await refresh(currentTokens.refresh_token)).ok).toBe(true);
      expect(await (await f.request('/api/auth/get-session', undefined, cookie)).json()).toBeNull();
      expect((await f.request('/api/account/sessions/revoke', selection)).status).toBe(401);
    } finally { await f.close(); }
  }, 60_000);
}

test('G522 concurrent refresh and session sign-out cannot leave a usable refresh token', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    const reader = await f.signup('concurrent-session@example.test');
    const other = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password });
    const cookie = other.headers.get('set-cookie')!;
    const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
    const tokens = await oauth.issue(client.client_id, cookie);
    const refresh = (token: string) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: token, resource: f.config.resource });
    const [revoked, raced] = await Promise.all([
      f.request('/api/account/sessions/revoke', { sessionId: session!.session.id }, reader.cookie), refresh(tokens.refresh_token),
    ]);
    expect(await revoked.json()).toEqual({ revoked: 1 });
    if (raced.ok) expect((await refresh((await raced.json() as { refresh_token: string }).refresh_token)).ok).toBe(false);
    expect((await refresh(tokens.refresh_token)).ok).toBe(false);
    expect((await f.pool.query('SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = $1 AND revoked IS NULL', [reader.id])).rowCount).toBe(0);
  } finally { await f.close(); }
}, 60_000);

test('G522 failed session deletion rolls back token revocation and a retry signs out', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    const reader = await f.signup('rollback-session@example.test');
    const session = await f.auth.api.getSession({ headers: new Headers({ cookie: reader.cookie }) });
    const tokens = await oauth.issue(client.client_id, reader.cookie);
    await f.pool.query(`CREATE FUNCTION g522_fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_session_delete_failure'; END $$;
      CREATE TRIGGER g522_fail_session_delete BEFORE DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION g522_fail_session_delete()`);
    const revoke = () => revokeSessions(f.pool, reader.id, session!.session.id, { sessionId: session!.session.id });
    await expect(revoke()).rejects.toThrow('injected_session_delete_failure');
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [session!.session.id])).rowCount).toBe(1);
    const refresh = (token: string) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: token, resource: f.config.resource });
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.ok).toBe(true);
    const rotated = await refreshed.json() as { refresh_token: string };
    await f.pool.query('DROP TRIGGER g522_fail_session_delete ON "session"');
    expect(await revoke()).toEqual({ revoked: 1 });
    expect((await refresh(rotated.refresh_token)).ok).toBe(false);
  } finally { await f.close(); }
}, 60_000);
