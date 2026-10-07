import { expect, spyOn, test } from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');

async function revocationFixture(count: number) {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const product = await oauth.createClient(true);
    const external = await oauth.createClient();
    const online = await oauth.createClient();
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
    const member = await f.signup('bulk-session-member@example.test');
    const current = (await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) }))!.session;
    await f.pool.query('DELETE FROM "session" WHERE "userId" = $1 AND id <> $2', [member.id, current.id]);
    // Put the current session last so a failed later page can be retried with
    // the same authenticated caller, after earlier pages have committed.
    await f.pool.query('UPDATE "session" SET "createdAt" = now() - interval \'1 day\' WHERE id = $1', [current.id]);
    const context = await f.auth.$context;
    const inserted = await f.pool.query<{ id: string; token: string }>(`INSERT INTO "session"
      (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      SELECT 'bulk-session-' || n, "userId", 'bulk-session-token-' || n,
        now() - n * interval '1 second', "updatedAt", "expiresAt"
      FROM "session", generate_series(1, $2::integer) n WHERE id = $1 RETURNING id, token`, [current.id, count]);
    const sessions = [];
    for (const row of inserted.rows) {
      const signature = createHmac('sha256', f.secret).update(row.token).digest('base64');
      const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${row.token}.${signature}`)}`;
      const tokens = await oauth.issue(product.client_id, cookie);
      const opaque = randomUUID();
      await f.pool.query(`INSERT INTO "oauthAccessToken"
        (id, token, "clientId", "userId", "sessionId", scopes, resources, "createdAt", "expiresAt")
        SELECT $1, $2, "clientId", "userId", "sessionId", scopes, resources, now(), now() + interval '5 minutes'
        FROM "oauthRefreshToken" WHERE token = $3`, [row.id, hash(opaque), hash(tokens.refresh_token)]);
      sessions.push({ ...row, cookie, tokens, opaque });
    }
    const kept = await oauth.issue(product.client_id, member.cookie);
    const offline = await oauth.issue(external.client_id, sessions[0]!.cookie);
    const onlineTokens = await oauth.issue(online.client_id, sessions.at(-1)!.cookie);
    // The provider supports retained online refresh rows from older grants.
    await f.pool.query(`UPDATE "oauthRefreshToken" SET scopes = scopes - 'offline_access' WHERE token = $1`,
      [hash(onlineTokens.refresh_token)]);
    const peer = await f.signup('bulk-session-peer@example.test');
    const unrelated = await oauth.issue(product.client_id, peer.cookie);
    expect((await f.request('/api/account/reauthenticate', { password: member.password }, member.cookie)).status).toBe(200);
    const consent = (await f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1', [member.id])).rows;
    const generations = (await f.pool.query(`SELECT client_id, generation, revoked_at FROM rezics_account_grant
      WHERE user_id = $1 ORDER BY client_id`, [member.id])).rows;
    await f.pool.query(`CREATE TABLE session_delete_pages (session_id text, transaction_id bigint);
      CREATE FUNCTION record_session_delete_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO session_delete_pages VALUES (OLD.id, txid_current()); RETURN OLD; END $$;
      CREATE TRIGGER record_session_delete_page AFTER DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION record_session_delete_page()`);
    const refresh = (clientId: string, token: string) => oauth.token({ grant_type: 'refresh_token',
      client_id: clientId, refresh_token: token, resource: f.config.resource });
    const opaqueActive = (token: string) => f.auth.api.oauth2Introspect({ body: { token,
      client_id: oauth.verifier.client_id, client_secret: oauth.verifier.client_secret! } });
    return { f, oauth, product, external, online, member, current, sessions, kept, offline, onlineTokens,
      unrelated, consent, generations, refresh, opaqueActive };
  } catch (error) { await f.close(); throw error; }
}

for (const mode of ['all', 'others', 'single'] as const) {
  test(`native ${mode} session revocation retires every selected family before link cleanup and preserves offline consent`, async () => {
    const r = await revocationFixture(mode === 'single' ? 3 : 107);
    const { f, oauth, sessions, product, member, current, refresh } = r;
    const outbound: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === f.baseURL) return originalFetch(input, init);
      outbound.push(url.toString());
      return Promise.resolve(new Response(null, { status: 204 }));
    }, { preconnect: originalFetch.preconnect }));
    try {
      await f.pool.query(`UPDATE "oauthClient" SET "backchannelLogoutUri" = 'https://127.0.0.1/legacy-logout'
        WHERE "clientId" = ANY($1::text[])`, [[product.client_id, r.external.client_id, r.online.client_id]]);
      expect(await r.opaqueActive(sessions[0]!.opaque)).toMatchObject({ active: true });
      const rotated = await refresh(product.client_id, sessions[0]!.tokens.refresh_token);
      expect(rotated.status).toBe(200);
      const child = await rotated.json() as { access_token: string; refresh_token: string };
      const selected = mode === 'single' ? [sessions[0]!] : sessions;
      const path = mode === 'all' ? '/revoke-sessions' : mode === 'others' ? '/revoke-other-sessions' : '/revoke-session';
      const revoke = () => f.request(`/api/auth${path}`, mode === 'single' ? { token: sessions[0]!.token } : {}, member.cookie);
      expect((await revoke()).status).toBe(200);
      for (const session of selected) {
        expect(await oauth.introspect(session.tokens.access_token)).toEqual({ active: false });
        expect(await r.opaqueActive(session.opaque)).toMatchObject({ active: false });
        expect((await refresh(product.client_id, session.tokens.refresh_token)).status).toBe(400);
      }
      expect(await oauth.introspect(child.access_token)).toEqual({ active: false });
      expect((await refresh(product.client_id, child.refresh_token)).status).toBe(400);
      expect((await f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
        WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" = ANY($3::text[])`,
      [member.id, product.client_id, selected.map(session => session.id)])).rowCount).toBe(0);
      const retired = (await f.pool.query('SELECT revoked FROM "oauthAccessToken" WHERE id = ANY($1::text[])',
        [selected.map(session => session.id)])).rows;
      expect(retired).toHaveLength(selected.length);
      expect(retired.every(row => row.revoked instanceof Date)).toBe(true);
      expect((await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [member.id])).rows.map(row => row.id).sort())
        .toEqual((mode === 'all' ? [] : mode === 'others' ? [current.id] : [current.id, ...sessions.slice(1).map(row => row.id)]).sort());
      expect((await refresh(product.client_id, r.kept.refresh_token)).status).toBe(mode === 'all' ? 400 : 200);
      expect((await refresh(product.client_id, r.unrelated.refresh_token)).status).toBe(200);
      if (mode === 'single') {
        expect(await r.opaqueActive(sessions[1]!.opaque)).toMatchObject({ active: true });
        expect((await refresh(product.client_id, sessions[1]!.tokens.refresh_token)).status).toBe(200);
      } else {
        expect((await f.pool.query('SELECT revoked FROM "oauthRefreshToken" WHERE token = $1',
          [hash(r.onlineTokens.refresh_token)])).rows[0].revoked).toBeInstanceOf(Date);
        expect((await refresh(r.online.client_id, r.onlineTokens.refresh_token)).status).toBe(400);
        const pages = (await f.pool.query(`SELECT count(*)::integer AS size FROM session_delete_pages
          GROUP BY transaction_id`)).rows.map(row => row.size as number);
        expect(pages.length).toBeGreaterThan(1);
        expect(Math.max(...pages)).toBeLessThanOrEqual(100);
      }
      const offlineRefresh = await refresh(r.external.client_id, r.offline.refresh_token);
      expect(offlineRefresh.status).toBe(200);
      expect(await oauth.introspect((await offlineRefresh.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
      expect((await f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1', [member.id])).rows)
        .toEqual(r.consent);
      expect((await f.pool.query(`SELECT client_id, generation, revoked_at FROM rezics_account_grant
        WHERE user_id = $1 ORDER BY client_id`, [member.id])).rows).toEqual(r.generations);
      if (mode !== 'all') expect((await revoke()).status).toBe(200);
      expect(outbound).toEqual([]);
    } finally { fetchSpy.mockRestore(); await f.close(); }
  }, 120_000);
}

test('bulk revocation commits bounded pages, rolls back a failed page and finishes on retry', async () => {
  const r = await revocationFixture(107);
  try {
    await r.f.pool.query(`CREATE FUNCTION fail_session_delete_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD."createdAt" < now() - interval '1 hour' THEN RAISE EXCEPTION 'injected_session_delete_failure'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER fail_session_delete_page BEFORE DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION fail_session_delete_page()`);
    const revoke = () => r.f.request('/api/auth/revoke-sessions', {}, r.member.cookie);
    expect((await revoke()).status).toBe(500);
    expect((await r.f.pool.query('SELECT count(*)::integer AS count FROM "session" WHERE "userId" = $1', [r.member.id])).rows[0].count)
      .toBe(8);
    expect((await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token)).status).toBe(400);
    expect(await r.opaqueActive(r.sessions.at(-1)!.opaque)).toMatchObject({ active: true });
    const preserved = await r.refresh(r.product.client_id, r.sessions.at(-1)!.tokens.refresh_token);
    expect(preserved.status).toBe(200);
    const child = await preserved.json() as { refresh_token: string };
    await r.f.pool.query('DROP TRIGGER fail_session_delete_page ON "session"');
    expect((await revoke()).status).toBe(200);
    expect((await r.refresh(r.product.client_id, child.refresh_token)).status).toBe(400);
    expect(await r.opaqueActive(r.sessions.at(-1)!.opaque)).toMatchObject({ active: false });
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [r.member.id])).rowCount).toBe(0);
  } finally { await r.f.close(); }
}, 120_000);

test('one bulk HTTP invocation has a fixed query budget with a large retained inventory', async () => {
  const r = await revocationFixture(107);
  let queries = 0;
  const query = Client.prototype.query;
  const querySpy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    queries++;
    return Reflect.apply(query, this, args);
  });
  try {
    expect((await r.f.request('/api/auth/revoke-sessions', {}, r.member.cookie)).status).toBe(200);
    expect(queries).toBeLessThanOrEqual(64);
  } finally { querySpy.mockRestore(); await r.f.close(); }
}, 120_000);

test('concurrent authorization-code issuance and refresh cannot resurrect a revoked session family', async () => {
  const r = await revocationFixture(3);
  try {
    const session = r.sessions[0]!;
    const code = await r.oauth.code(r.product.client_id, session.cookie);
    const [revoked, issued, rotated] = await Promise.all([
      r.f.request('/api/auth/revoke-other-sessions', {}, r.member.cookie),
      r.oauth.token({ ...code, grant_type: 'authorization_code' }),
      r.refresh(r.product.client_id, session.tokens.refresh_token),
    ]);
    expect(revoked.status).toBe(200);
    for (const response of [issued, rotated]) {
      if (response.ok) {
        const tokens = await response.json() as { access_token: string; refresh_token: string };
        expect(await r.oauth.introspect(tokens.access_token)).toEqual({ active: false });
        expect((await r.refresh(r.product.client_id, tokens.refresh_token)).status).toBe(400);
      }
    }
    expect((await r.refresh(r.product.client_id, session.tokens.refresh_token)).status).toBe(400);
    expect((await r.f.pool.query('SELECT 1 FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" IS NULL',
      [r.member.id, r.product.client_id])).rowCount).toBe(0);
    expect((await r.f.request('/api/auth/revoke-other-sessions', {}, r.member.cookie)).status).toBe(200);
  } finally { await r.f.close(); }
}, 60_000);

test('revoke-other drains retained first-party families when the provider has no active other session hook', async () => {
  const r = await revocationFixture(107);
  try {
    await r.f.pool.query('UPDATE "session" SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1 AND id <> $2',
      [r.member.id, r.current.id]);
    const context = await r.f.auth.$context;
    const sample = await context.internalAdapter.listSessions(r.member.id);
    expect(sample).toHaveLength(100);
    expect(sample.filter(row => row.id !== r.current.id && row.expiresAt > new Date())).toHaveLength(0);
    const refreshed = await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const child = await refreshed.json() as { refresh_token: string };
    expect((await r.f.request('/api/auth/revoke-other-sessions', {})).status).toBe(401);
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [r.member.id])).rowCount).toBe(108);
    expect((await r.f.request('/api/auth/revoke-other-sessions', {}, r.member.cookie)).status).toBe(200);
    expect((await r.f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [r.member.id])).rows).toEqual([{ id: r.current.id }]);
    expect((await r.f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
      WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" IS DISTINCT FROM $3`,
    [r.member.id, r.product.client_id, r.current.id])).rowCount).toBe(0);
    expect((await r.refresh(r.product.client_id, child.refresh_token)).status).toBe(400);
    expect((await r.refresh(r.product.client_id, r.kept.refresh_token)).status).toBe(200);
    const external = await r.refresh(r.external.client_id, r.offline.refresh_token);
    expect(external.status).toBe(200);
    expect(await r.oauth.introspect((await external.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
  } finally { await r.f.close(); }
}, 120_000);
