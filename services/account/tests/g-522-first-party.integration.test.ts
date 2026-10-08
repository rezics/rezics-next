import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { Pool } from 'pg';
import { cleanupRevokedSessionPage } from '../src/first-party-session.ts';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { revokeSessions } from '../src/security-activity.ts';

/** The logical fence denies the family at once. Physical removal of that
 * session and its product tokens commits together, one bounded page at a time. */
async function finishSessionCleanup(pool: Pool) {
  for (let invocation = 0; invocation < 16; invocation++) {
    const page = await cleanupRevokedSessionPage(pool);
    if (!page.userId) return;
  }
  throw new Error('session cleanup did not finish');
}

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

test('G522 sign-out token cleanup follows registry membership independently of skipConsent', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const reader = await f.signup('token-classification@example.test');
    const matrix = [];
    for (const firstParty of [false, true]) {
      for (const skipConsent of [false, true]) {
        const client = await oauth.createClient(skipConsent);
        if (firstParty) await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
        const tokens = await oauth.issue(client.client_id, reader.cookie);
        matrix.push({ clientId: client.client_id, firstParty, tokens });
      }
    }
    expect((await f.request('/api/auth/sign-out', {}, reader.cookie)).ok).toBe(true);
    for (const entry of matrix) {
      const refreshed = await oauth.token({ grant_type: 'refresh_token', client_id: entry.clientId,
        refresh_token: entry.tokens.refresh_token, resource: f.config.resource });
      expect(refreshed.ok).toBe(!entry.firstParty);
    }
  } finally { await f.close(); }
}, 60_000);

for (const mode of ['single', 'group', 'others'] as const) {
  test(`G522 session sign-out (${mode}): revokes rotated product refresh tokens, preserves other people and current session`, async () => {
    const f = await accountFixture();
    try {
      const oauth = await oauthFixture(f);
      const client = await oauth.createClient(true);
      const external = await oauth.createClient();
      await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
      await f.pool.query('UPDATE "oauthClient" SET name = $1 WHERE "clientId" = $2', ['REZICS', client.client_id]);
      const reader = await f.signup(`sessions-${mode}@example.test`);
      const peer = await f.signup(`peer-${mode}@example.test`);
      const signedIn = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password },
        undefined, { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140.0' });
      const cookie = signedIn.headers.get('set-cookie')!;
      const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
      const externalTokens = await oauth.issue(external.client_id, cookie);
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
      const externalRefresh = await oauth.token({ grant_type: 'refresh_token', client_id: external.client_id,
        refresh_token: externalTokens.refresh_token, resource: f.config.resource });
      expect(externalRefresh.ok).toBe(true);
      expect(await oauth.introspect((await externalRefresh.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
      const apps = await (await f.request('/api/account/connected-apps', undefined, reader.cookie)).json() as {
        items: { clientId: string }[] };
      expect(apps.items.map(app => app.clientId)).toEqual([external.client_id]);
      expect((await refresh(currentTokens.refresh_token)).ok).toBe(true);
      expect(await (await f.request('/api/auth/get-session', undefined, cookie)).json()).toBeNull();
      expect((await f.request('/api/account/sessions/revoke', selection)).status).toBe(401);
    } finally { await f.close(); }
  }, 60_000);
}

for (const route of ['devices', 'accounts'] as const) {
  test(`G522 concurrent refresh and ${route} sign-out cannot leave a usable refresh token`, async () => {
    const f = await accountFixture();
    try {
      const oauth = await oauthFixture(f);
      const client = await oauth.createClient(true);
      await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
      const reader = await f.signup('concurrent-session@example.test');
      const other = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password });
      const cookie = other.headers.get('set-cookie')!;
      const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
      const tokens = await oauth.issue(client.client_id, cookie);
      const refresh = (token: string) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
        refresh_token: token, resource: f.config.resource });
      const [revoked, raced] = await Promise.all([
        route === 'devices'
          ? f.request('/api/account/sessions/revoke', { sessionId: session!.session.id }, reader.cookie)
          : f.request('/api/auth/sign-out', {}, cookie),
        refresh(tokens.refresh_token),
      ]);
      expect(revoked.ok).toBe(true);
      if (route === 'devices') expect(await revoked.json()).toEqual({ revoked: 1 });
      if (raced.ok) expect((await refresh((await raced.json() as { refresh_token: string }).refresh_token)).ok).toBe(false);
      expect((await refresh(tokens.refresh_token)).ok).toBe(false);
      // The row can outlive the fence; cleanup removes it in the same transaction as the session.
      await finishSessionCleanup(f.pool);
      expect((await f.pool.query('SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = $1 AND revoked IS NULL', [reader.id])).rowCount).toBe(0);
    } finally { await f.close(); }
  }, 60_000);
}

for (const action of ['sign-out', 'revoke-session', 'revoke-other-sessions', 'revoke-sessions'] as const) {
  test(`G522 Accounts ${action}: signs the product out in those browsers and preserves consented offline access`, async () => {
    const f = await accountFixture();
    try {
      const oauth = await oauthFixture(f);
      const product = await oauth.createClient(true);
      const external = await oauth.createClient();
      await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
      const reader = await f.signup(`native-${action}@example.test`);
      const signedIn = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password });
      const cookie = signedIn.headers.get('set-cookie')!;
      const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
      const productTokens = await oauth.issue(product.client_id, cookie);
      const externalTokens = await oauth.issue(external.client_id, cookie);
      const keptTokens = await oauth.issue(product.client_id, reader.cookie);
      const response = await f.request(`/api/auth/${action}`, action === 'revoke-session' ? { token: session!.session.token } : {},
        action === 'sign-out' ? cookie : reader.cookie);
      expect(response.ok).toBe(true);
      const refresh = (clientId: string, token: string) => oauth.token({ grant_type: 'refresh_token', client_id: clientId,
        refresh_token: token, resource: f.config.resource });
      expect((await refresh(product.client_id, productTokens.refresh_token)).ok).toBe(false);
      expect((await refresh(product.client_id, keptTokens.refresh_token)).ok).toBe(action !== 'revoke-sessions');
      const externalRefresh = await refresh(external.client_id, externalTokens.refresh_token);
      expect(externalRefresh.ok).toBe(true);
      expect(await oauth.introspect((await externalRefresh.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
      await finishSessionCleanup(f.pool);
      expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [session!.session.id])).rowCount).toBe(0);
      expect((await f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
        WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" IS NULL`, [reader.id, product.client_id])).rowCount).toBe(0);
      const consent = await f.pool.query('SELECT 1 FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2',
        [reader.id, external.client_id]);
      expect(consent.rowCount).toBe(1);
    } finally { await f.close(); }
  }, 60_000);
}

test('G522 expiry: live first-party sessions stay listed and expiry cleanup cannot detach product tokens', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const product = await oauth.createClient(true);
    const external = await oauth.createClient();
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
    const reader = await f.signup('expired-products@example.test');
    const sessions = [];
    for (const state of ['live', 'live-revoke', 'revoked', 'expired-token', 'external-only'] as const) {
      const signedIn = await f.request('/api/auth/sign-in/email', { email: reader.email, password: reader.password });
      const cookie = signedIn.headers.get('set-cookie')!;
      const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
      const externalTokens = await oauth.issue(external.client_id, cookie);
      const productTokens = state === 'external-only' ? null : await oauth.issue(product.client_id, cookie);
      await f.pool.query('UPDATE "session" SET "expiresAt" = now() - interval \'1 minute\' WHERE id = $1', [session!.session.id]);
      if (state === 'revoked') await f.pool.query(`UPDATE "oauthRefreshToken" SET revoked = now()
        WHERE "sessionId" = $1 AND "clientId" = $2`, [session!.session.id, product.client_id]);
      if (state === 'expired-token') await f.pool.query(`UPDATE "oauthRefreshToken" SET "expiresAt" = now() - interval '1 minute'
        WHERE "sessionId" = $1 AND "clientId" = $2`, [session!.session.id, product.client_id]);
      sessions.push({ id: session!.session.id, cookie, state, externalTokens, productTokens });
    }
    const list = await (await f.request('/api/account/sessions?limit=100', undefined, reader.cookie)).json() as {
      items: { id: string; expiresAt: string }[] };
    const live = sessions.find(session => session.state === 'live')!;
    const actionable = sessions.find(session => session.state === 'live-revoke')!;
    expect(list.items.find(session => session.id === live.id)).toBeDefined();
    expect(list.items.find(session => session.id === actionable.id)).toBeDefined();
    expect(Date.parse(list.items.find(session => session.id === live.id)!.expiresAt)).toBeLessThan(Date.now());
    for (const hidden of sessions.filter(session => !session.state.startsWith('live'))) {
      expect(list.items.find(session => session.id === hidden.id)).toBeUndefined();
    }
    const refresh = (clientId: string, token: string) => oauth.token({ grant_type: 'refresh_token', client_id: clientId,
      refresh_token: token, resource: f.config.resource });
    const revoked = await f.request('/api/account/sessions/revoke', { sessionId: actionable.id }, reader.cookie);
    expect(await revoked.json()).toEqual({ revoked: 1 });
    expect((await refresh(product.client_id, actionable.productTokens!.refresh_token)).ok).toBe(false);
    expect((await refresh(external.client_id, actionable.externalTokens.refresh_token)).ok).toBe(true);
    // An expired-session read fences that browser. Product refresh dies with the
    // fence; consented offline access stays. Cleanup then removes the row.
    expect(await (await f.request('/api/auth/get-session', undefined, live.cookie)).json()).toBeNull();
    expect((await refresh(product.client_id, live.productTokens!.refresh_token)).ok).toBe(false);
    expect((await refresh(external.client_id, live.externalTokens.refresh_token)).ok).toBe(true);
    await finishSessionCleanup(f.pool);
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [live.id])).rowCount).toBe(0);
    const after = await (await f.request('/api/account/sessions?limit=100', undefined, reader.cookie)).json() as typeof list;
    expect(after.items.find(session => session.id === live.id)).toBeUndefined();
  } finally { await f.close(); }
}, 60_000);

test('G522 failed session deletion rolls back token removal while the fence keeps refresh unusable', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient(true);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [client.client_id]);
    const reader = await f.signup('rollback-session@example.test');
    const session = await f.auth.api.getSession({ headers: new Headers({ cookie: reader.cookie }) });
    const tokens = await oauth.issue(client.client_id, reader.cookie);
    const refresh = (token: string) => oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
      refresh_token: token, resource: f.config.resource });
    const revoke = () => revokeSessions(f.pool, reader.id, session!.session.id, { sessionId: session!.session.id });
    expect(await revoke()).toEqual({ revoked: 1 });
    expect((await refresh(tokens.refresh_token)).ok).toBe(false);
    await f.pool.query(`CREATE FUNCTION g522_fail_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected_session_delete_failure'; END $$;
      CREATE TRIGGER g522_fail_session_delete BEFORE DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION g522_fail_session_delete()`);
    const inventory = () => f.pool.query<{ sessions: string; refresh: string }>(`SELECT
      (SELECT count(*) FROM "session" WHERE id = $1) AS sessions,
      (SELECT count(*) FROM "oauthRefreshToken" WHERE "userId" = $2 AND revoked IS NULL) AS refresh`,
    [session!.session.id, reader.id]);
    const before = (await inventory()).rows;
    await expect(cleanupRevokedSessionPage(f.pool)).rejects.toThrow('injected_session_delete_failure');
    expect((await inventory()).rows).toEqual(before);
    expect((await refresh(tokens.refresh_token)).ok).toBe(false);
    await f.pool.query('DROP TRIGGER g522_fail_session_delete ON "session"');
    await finishSessionCleanup(f.pool);
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [session!.session.id])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = $1 AND revoked IS NULL', [reader.id])).rowCount).toBe(0);
    expect((await refresh(tokens.refresh_token)).ok).toBe(false);
  } finally { await f.close(); }
}, 60_000);

test('G522 native bulk sign-out reaches first-party tokens beyond the provider hook snapshot', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const product = await oauth.createClient(true);
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
    const reader = await f.signup('bulk-products@example.test');
    const current = await f.auth.api.getSession({ headers: new Headers({ cookie: reader.cookie }) });
    await f.pool.query(`INSERT INTO "session" (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      SELECT 'g522-bulk-' || n, "userId", 'g522-bulk-token-' || n, "createdAt", "updatedAt", "expiresAt"
      FROM "session", generate_series(1, 150) n WHERE id = $1`, [current!.session.id]);
    const context = await f.auth.$context;
    const snapshot = await context.adapter.findMany<{ id: string }>({ model: 'session', where: [{ field: 'userId', value: reader.id }] });
    expect(snapshot).toHaveLength(100);
    const excluded = (await f.pool.query<{ id: string; token: string }>(`SELECT id, token FROM "session"
      WHERE "userId" = $1 AND id <> ALL($2::text[]) ORDER BY id LIMIT 1`, [reader.id, snapshot.map(row => row.id)])).rows[0]!;
    // A real, signed Account cookie for a session outside the pinned provider's
    // hook snapshot. OAuth issuance still follows authorization code and PKCE.
    const signature = createHmac('sha256', f.secret).update(excluded.token).digest('base64');
    const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${excluded.token}.${signature}`)}`;
    expect((await f.auth.api.getSession({ headers: new Headers({ cookie }) }))?.session.id).toBe(excluded.id);
    const tokens = await oauth.issue(product.client_id, cookie);
    const revoked = await f.request('/api/auth/revoke-sessions', {}, reader.cookie);
    expect(revoked.ok).toBe(true);
    // The provider hook snapshots 100 sessions. The fence still denies a token
    // minted on a session outside that snapshot, before bounded cleanup.
    const refreshed = await oauth.token({ grant_type: 'refresh_token', client_id: product.client_id,
      refresh_token: tokens.refresh_token, resource: f.config.resource });
    expect(refreshed.ok).toBe(false);
    await finishSessionCleanup(f.pool);
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [reader.id])).rowCount).toBe(0);
    expect((await f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
      WHERE "userId" = $1 AND "clientId" = $2`, [reader.id, product.client_id])).rowCount).toBe(0);
  } finally { await f.close(); }
}, 60_000);
