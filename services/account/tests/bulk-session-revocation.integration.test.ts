import { expect, spyOn, test } from 'bun:test';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { prepareAuthorization } from '../../../scripts/lib/oauth-client.ts';
import { Client } from 'pg';
import { cleanupRevokedSessionPage } from '../src/first-party-session.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { checkActor } from '../src/admin-actions.ts';
import { requireRecoverySession } from '../src/recovery-guardian.ts';
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
    // Cleanup must recover even when the caller's oldest session is revoked.
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
    await f.pool.query(`CREATE TABLE session_cleanup_writes (table_name text, operation text, transaction_id bigint);
      CREATE FUNCTION record_session_cleanup_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        INSERT INTO session_cleanup_writes VALUES (TG_TABLE_NAME, TG_OP, txid_current());
        RETURN NULL; END $$`);
    for (const table of ['session', 'oauthAccessToken', 'oauthRefreshToken', 'rezics_account_pending_consent',
      'rezics_account_step_up', 'rezics_account_email_change', 'rezics_account_security_event', 'rezics_account_security']) {
      await f.pool.query(`CREATE TRIGGER record_session_cleanup_write AFTER INSERT OR UPDATE OR DELETE ON "${table}"
        FOR EACH ROW EXECUTE FUNCTION record_session_cleanup_write()`);
    }
    const refresh = (clientId: string, token: string) => oauth.token({ grant_type: 'refresh_token',
      client_id: clientId, refresh_token: token, resource: f.config.resource });
    const opaqueActive = (token: string) => f.auth.api.oauth2Introspect({ body: { token,
      client_id: oauth.verifier.client_id, client_secret: oauth.verifier.client_secret! } });
    return { f, oauth, product, external, online, member, current, sessions, kept, offline, onlineTokens,
      unrelated, consent, generations, refresh, opaqueActive };
  } catch (error) { await f.close(); throw error; }
}

async function queryCount<T>(work: () => Promise<T>) {
  let queries = 0;
  const query = Client.prototype.query;
  const querySpy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    queries++;
    return Reflect.apply(query, this, args);
  });
  try { return { result: await work(), queries }; }
  finally { querySpy.mockRestore(); }
}

async function cleanupPage(r: Awaited<ReturnType<typeof revocationFixture>>) {
  await r.f.pool.query('TRUNCATE session_cleanup_writes');
  const page = await queryCount(() => cleanupRevokedSessionPage(r.f.pool));
  expect(page.queries).toBeLessThanOrEqual(24);
  for (const size of [page.result.sessions, page.result.accessTokens, page.result.refreshTokens, page.result.pendingConsents]) {
    expect(size).toBeLessThanOrEqual(100);
    expect(size).toBeGreaterThanOrEqual(0);
  }
  const writes = (await r.f.pool.query<{ table_name: string; size: number }>(`SELECT table_name, count(*)::integer AS size
    FROM session_cleanup_writes GROUP BY table_name`)).rows;
  // AFTER triggers count FK side effects too, including repeated writes to the
  // same row; limiting candidate IDs alone cannot establish a write bound.
  for (const row of writes) {
    const bound = ['rezics_account_security', 'rezics_account_email_change'].includes(row.table_name) ? 1 : 100;
    expect(row.size).toBeLessThanOrEqual(bound);
  }
  return page.result;
}

async function finishCleanup(r: Awaited<ReturnType<typeof revocationFixture>>, budget = 12) {
  for (let invocation = 0; invocation < budget; invocation++) {
    if (!(await cleanupPage(r)).pending) {
      expect((await r.f.pool.query('SELECT session_cleanup_pending FROM rezics_account_security WHERE user_id = $1',
        [r.member.id])).rows[0]).toEqual({ session_cleanup_pending: false });
      return invocation + 1;
    }
  }
  throw new Error(`Session cleanup did not finish within ${budget} bounded invocations`);
}

for (const mode of ['all', 'others', 'single'] as const) {
  test(`native ${mode} session revocation denies every selected family immediately and preserves offline consent through bounded cleanup`, async () => {
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
      const selectedCookie = selected[0]!.cookie;
      await f.pool.query("INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'admin')", [member.id]);
      const authority = await f.pool.connect();
      try {
        expect(await checkActor(authority, { userId: member.id, sessionId: selected[0]!.id }, 'users:read')).toBe('admin');
        expect(await requireRecoverySession(authority, member.id, selected[0]!.id)).toMatchObject({ emailVerified: true });
      } finally { authority.release(); }
      expect((await f.request('/api/account/reauthenticate', { password: member.password }, selectedCookie)).status).toBe(200);
      await f.pool.query(`INSERT INTO rezics_account_step_up (session_id)
        SELECT unnest($1::text[]) ON CONFLICT DO NOTHING`, [selected.map(session => session.id)]);
      expect((await f.pool.query('SELECT 1 FROM rezics_account_step_up WHERE session_id = ANY($1::text[])',
        [selected.map(session => session.id)])).rowCount).toBe(selected.length);
      expect((await f.request('/api/auth/change-email', { newEmail: 'changed-bulk-session@example.test',
        callbackURL: '/verify-email?change=email' }, selectedCookie)).status).toBe(200);
      await f.email.drain();
      const confirmation = [...f.messages].reverse().find(message => message.to === member.email
        && message.subject === 'Confirm your email change')!;
      const emailConfirmation = /https?:\/\/\S+/.exec(confirmation.text)![0];
      expect(new URL(emailConfirmation).searchParams.get('token')).toMatch(/^ec_/);
      const emailIntent = (await f.pool.query('SELECT to_jsonb(i) AS row FROM rezics_account_email_change i WHERE user_id = $1',
        [member.id])).rows;
      expect(emailIntent).toHaveLength(1);
      expect(emailIntent[0].row).toMatchObject({ session_id: selected[0]!.id, stage: 'confirm' });
      const accountGeneration = (await f.pool.query('SELECT generation FROM rezics_account_security WHERE user_id = $1',
        [member.id])).rows;
      const code = await oauth.code(product.client_id, selectedCookie);
      const prepared = prepareAuthorization({ account: f.baseURL, clientId: r.external.client_id,
        redirectUri: 'https://notes.example.test/callback', scope: 'openid work:read offline_access',
        resource: f.config.resource }, { prompt: 'consent' });
      const authorization = await f.request(`${prepared.url.pathname}${prepared.url.search}`, undefined, selectedCookie);
      expect(authorization.status).toBe(302);
      const signedConsent = new URL(authorization.headers.get('location')!, f.baseURL).searchParams.toString();
      expect((await f.request(`/api/account/consent?${new URLSearchParams({ oauth_query: signedConsent })}`,
        undefined, selectedCookie)).status).toBe(200);
      const path = mode === 'all' ? '/revoke-sessions' : mode === 'others' ? '/revoke-other-sessions' : '/revoke-session';
      const revoke = () => f.request(`/api/auth${path}`, mode === 'single' ? { token: sessions[0]!.token } : {}, member.cookie);
      await f.pool.query('TRUNCATE session_cleanup_writes');
      const request = await queryCount(revoke);
      expect(request.result.status).toBe(200);
      expect(request.queries).toBeLessThanOrEqual(64);
      const deniedAuthority = await f.pool.connect();
      try {
        await expect(checkActor(deniedAuthority, { userId: member.id, sessionId: selected[0]!.id }, 'users:read'))
          .rejects.toThrow('forbidden');
        await expect(requireRecoverySession(deniedAuthority, member.id, selected[0]!.id)).rejects.toThrow('stale');
      } finally { deniedAuthority.release(); }
      expect((await f.request(emailConfirmation)).status).toBe(403);
      expect((await f.pool.query('SELECT to_jsonb(i) AS row FROM rezics_account_email_change i WHERE user_id = $1',
        [member.id])).rows).toEqual(emailIntent);
      expect((await f.pool.query('SELECT generation FROM rezics_account_security WHERE user_id = $1',
        [member.id])).rows).toEqual(accountGeneration);
      expect((await f.pool.query(`SELECT 1 FROM session_cleanup_writes
        WHERE table_name IN ('rezics_account_step_up', 'rezics_account_email_change')`)).rowCount).toBe(0);
      expect((await f.pool.query('SELECT 1 FROM session_cleanup_writes WHERE operation = \'DELETE\'')).rowCount).toBe(0);
      expect((await f.pool.query('SELECT count(*)::integer AS count FROM "session" WHERE "userId" = $1', [member.id]))
        .rows[0].count).toBe(sessions.length + 1);
      for (const session of selected) {
        expect(await oauth.introspect(session.tokens.access_token)).toEqual({ active: false });
        expect(await r.opaqueActive(session.opaque)).toMatchObject({ active: false });
        expect((await refresh(product.client_id, session.tokens.refresh_token)).status).toBe(400);
      }
      expect(await f.auth.api.getSession({ headers: new Headers({ cookie: selectedCookie }) })).toBeNull();
      expect(await (await f.request('/api/auth/get-session', undefined, selectedCookie)).json()).toBeNull();
      expect((await f.request('/api/auth/list-sessions', undefined, selectedCookie)).status).toBe(401);
      expect((await oauth.token({ ...code, grant_type: 'authorization_code' })).status).toBe(400);
      expect((await f.request('/api/account/consent', { oauth_query: signedConsent, accept: true }, selectedCookie)).status).toBe(401);
      expect((await f.request('/api/auth/oauth2/consent', { oauth_query: signedConsent, accept: true }, selectedCookie)).status).toBe(401);
      expect(await oauth.introspect(child.access_token)).toEqual({ active: false });
      expect((await refresh(product.client_id, child.refresh_token)).status).toBe(400);
      // A stale product token presented under another client must not reach
      // provider reuse cleanup against this account's surviving product family.
      expect((await refresh(r.external.client_id, child.refresh_token)).status).toBe(400);
      // Offline access must continue while its stale browser SID still exists.
      const offlineRefresh = await refresh(r.external.client_id, r.offline.refresh_token);
      expect(offlineRefresh.status).toBe(200);
      const offlineChild = await offlineRefresh.json() as { access_token: string; refresh_token: string };
      expect(await oauth.introspect(offlineChild.access_token)).toMatchObject({ active: true });
      expect((await f.pool.query('SELECT "sessionId" FROM "oauthRefreshToken" WHERE token = $1',
        [hash(offlineChild.refresh_token)])).rows[0]).toEqual({ sessionId: null });
      const invocations = await finishCleanup(r);
      if (mode !== 'single') expect(invocations).toBeGreaterThan(1);
      expect((await f.pool.query('SELECT 1 FROM rezics_account_email_change WHERE user_id = $1', [member.id])).rowCount).toBe(0);
      expect((await f.pool.query('SELECT 1 FROM rezics_account_step_up WHERE session_id = ANY($1::text[])',
        [selected.map(session => session.id)])).rowCount).toBe(0);
      expect((await f.pool.query('SELECT 1 FROM rezics_account_step_up WHERE session_id = $1', [current.id])).rowCount)
        .toBe(mode === 'all' ? 0 : 1);
      expect((await f.pool.query('SELECT generation FROM rezics_account_security WHERE user_id = $1',
        [member.id])).rows).toEqual(accountGeneration);
      expect((await f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
        WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" = ANY($3::text[])`,
      [member.id, product.client_id, selected.map(session => session.id)])).rowCount).toBe(0);
      const retired = (await f.pool.query('SELECT revoked, "sessionId" FROM "oauthAccessToken" WHERE id = ANY($1::text[])',
        [selected.map(session => session.id)])).rows;
      // Cleanup may delete retired opaque history or retain it detached.
      expect(retired.every(row => row.revoked instanceof Date && row.sessionId === null)).toBe(true);
      expect((await f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [member.id])).rows.map(row => row.id).sort())
        .toEqual((mode === 'all' ? [] : mode === 'others' ? [current.id] : [current.id, ...sessions.slice(1).map(row => row.id)]).sort());
      expect((await refresh(product.client_id, r.kept.refresh_token)).status).toBe(mode === 'all' ? 400 : 200);
      expect((await refresh(product.client_id, r.unrelated.refresh_token)).status).toBe(200);
      if (mode === 'single') {
        expect(await r.opaqueActive(sessions[1]!.opaque)).toMatchObject({ active: true });
        expect((await refresh(product.client_id, sessions[1]!.tokens.refresh_token)).status).toBe(200);
      } else {
        expect((await refresh(r.online.client_id, r.onlineTokens.refresh_token)).status).toBe(400);
      }
      const continuedOffline = await refresh(r.external.client_id, offlineChild.refresh_token);
      expect(continuedOffline.status).toBe(200);
      expect(await oauth.introspect((await continuedOffline.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
      expect((await f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1', [member.id])).rows)
        .toEqual(r.consent);
      expect((await f.pool.query(`SELECT client_id, generation, revoked_at FROM rezics_account_grant
        WHERE user_id = $1 ORDER BY client_id`, [member.id])).rows).toEqual(r.generations);
      if (mode !== 'all') expect((await revoke()).status).toBe(200);
      expect(outbound).toEqual([]);
    } finally { fetchSpy.mockRestore(); await f.close(); }
  }, 120_000);
}

test('failed cleanup rolls back one page and retries without the revoked caller', async () => {
  const r = await revocationFixture(107);
  try {
    await r.f.pool.query(`CREATE FUNCTION fail_session_delete_page() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'injected_session_delete_failure'; END $$;
      CREATE TRIGGER fail_session_delete_page BEFORE DELETE ON "session"
        FOR EACH ROW EXECUTE FUNCTION fail_session_delete_page()`);
    expect((await r.f.request('/api/auth/revoke-sessions', {}, r.member.cookie)).status).toBe(200);
    expect((await r.f.request('/api/auth/revoke-sessions', {}, r.member.cookie)).status).toBe(401);
    const before = (await r.f.pool.query(`SELECT
      (SELECT count(*) FROM "session" WHERE "userId" = $1) AS sessions,
      (SELECT count(*) FROM "oauthRefreshToken" WHERE "userId" = $1) AS refresh,
      (SELECT count(*) FROM "oauthAccessToken" WHERE "userId" = $1 AND revoked IS NULL) AS active,
      (SELECT count(*) FROM rezics_account_pending_consent WHERE session_id = ANY($2::text[])) AS pending`,
    [r.member.id, r.sessions.map(row => row.id)])).rows;
    await r.f.pool.query('TRUNCATE session_cleanup_writes');
    await expect(cleanupRevokedSessionPage(r.f.pool)).rejects.toThrow('injected_session_delete_failure');
    expect((await r.f.pool.query(`SELECT
      (SELECT count(*) FROM "session" WHERE "userId" = $1) AS sessions,
      (SELECT count(*) FROM "oauthRefreshToken" WHERE "userId" = $1) AS refresh,
      (SELECT count(*) FROM "oauthAccessToken" WHERE "userId" = $1 AND revoked IS NULL) AS active,
      (SELECT count(*) FROM rezics_account_pending_consent WHERE session_id = ANY($2::text[])) AS pending`,
    [r.member.id, r.sessions.map(row => row.id)])).rows).toEqual(before);
    expect((await r.f.pool.query('SELECT 1 FROM session_cleanup_writes')).rowCount).toBe(0);
    expect((await r.f.pool.query('SELECT session_cleanup_pending FROM rezics_account_security WHERE user_id = $1',
      [r.member.id])).rows[0]).toEqual({ session_cleanup_pending: true });
    expect((await r.f.pool.query('SELECT count(*)::integer AS count FROM "session" WHERE "userId" = $1', [r.member.id])).rows[0].count)
      .toBe(108);
    expect((await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token)).status).toBe(400);
    expect(await r.opaqueActive(r.sessions.at(-1)!.opaque)).toMatchObject({ active: false });
    await r.f.pool.query('DROP TRIGGER fail_session_delete_page ON "session"');
    expect(await finishCleanup(r)).toBeGreaterThan(1);
    expect(await r.opaqueActive(r.sessions.at(-1)!.opaque)).toMatchObject({ active: false });
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [r.member.id])).rowCount).toBe(0);
  } finally { await r.f.close(); }
}, 120_000);

test('one bulk HTTP invocation has fixed query and row bounds independent of a large retained inventory', async () => {
  const r = await revocationFixture(107);
  try {
    await expect(r.f.pool.query('UPDATE "session" SET rezics_generation = -1 WHERE id = $1', [r.current.id]))
      .rejects.toThrow('check constraint');
    await expect(r.f.pool.query('UPDATE rezics_account_security SET session_generation = -1 WHERE user_id = $1', [r.member.id]))
      .rejects.toThrow('check constraint');
    await r.f.pool.query(`INSERT INTO "session" (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      SELECT 'retained-session-' || n, "userId", 'retained-session-token-' || n,
        now(), now(), "expiresAt" FROM "session", generate_series(1, 3000) n WHERE id = $1`, [r.current.id]);
    await r.f.pool.query('TRUNCATE session_cleanup_writes');
    const request = await queryCount(() => r.f.request('/api/auth/revoke-sessions', {}, r.member.cookie));
    expect(request.result.status).toBe(200);
    expect(request.queries).toBeLessThanOrEqual(64);
    expect((await r.f.pool.query(`SELECT 1 FROM session_cleanup_writes
      WHERE table_name NOT IN ('rezics_account_security', 'rezics_account_security_event')`)).rowCount).toBe(0);
    expect((await r.f.pool.query('SELECT count(*)::integer AS count FROM "session" WHERE "userId" = $1', [r.member.id]))
      .rows[0].count).toBe(3108);
    // Reapplying owner migrations cannot resurrect the old epoch or lose its
    // continuation, including when the provider created the stamp column first.
    await installConsentRefreshFence(r.f.pool);
    expect((await r.f.pool.query(`SELECT session_generation::text AS generation, session_cleanup_pending AS pending
      FROM rezics_account_security WHERE user_id = $1`, [r.member.id])).rows[0])
      .toEqual({ generation: '1', pending: true });
    expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.member.cookie }) })).toBeNull();
    const page = await cleanupPage(r);
    expect(page.pending).toBe(true);
    expect(page.sessions).toBeLessThanOrEqual(100);
  } finally { await r.f.close(); }
}, 120_000);

test('concurrent authorization-code issuance and refresh cannot resurrect a revoked session family', async () => {
  const r = await revocationFixture(3);
  const admission = await r.f.pool.connect();
  let querySpy: ReturnType<typeof spyOn<Client, 'query'>> | undefined;
  try {
    const session = r.sessions[0]!;
    const code = await r.oauth.code(r.product.client_id, session.cookie);
    await admission.query('BEGIN');
    await admission.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1 FOR SHARE', [r.member.id]);
    await admission.query(`INSERT INTO "session" (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
      SELECT 'concurrent-admission', "userId", 'concurrent-admission-token', now(), now(), "expiresAt"
      FROM "session" WHERE id = $1`, [r.current.id]);
    // Hold the existing admission SHARE lock until revocation reaches its
    // conflicting owner lock, proving the fence includes a concurrent insert.
    let fenceStarted!: () => void;
    const fence = new Promise<void>(resolve => { fenceStarted = resolve; });
    const query = Client.prototype.query;
    querySpy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
      const sql = args[0];
      if (typeof sql === 'string' && sql.includes('FROM rezics_account_security') && sql.includes('FOR UPDATE')) fenceStarted();
      return Reflect.apply(query, this, args);
    });
    const responses = Promise.all([
      r.f.request('/api/auth/revoke-other-sessions', {}, r.member.cookie),
      r.oauth.token({ ...code, grant_type: 'authorization_code' }),
      r.refresh(r.product.client_id, session.tokens.refresh_token),
    ]);
    await Promise.race([fence, responses.then(() => { throw new Error('Revocation did not serialize with session admission'); })]);
    await admission.query('COMMIT');
    querySpy.mockRestore();
    querySpy = undefined;
    const [revoked, issued, rotated] = await responses;
    expect(revoked.status).toBe(200);
    expect((await r.f.pool.query(`SELECT s.rezics_generation < p.session_generation AS stale
      FROM "session" s JOIN rezics_account_security p ON p.user_id = s."userId" WHERE s.id = 'concurrent-admission'`))
      .rows[0]).toEqual({ stale: true });
    for (const response of [issued, rotated]) {
      expect([200, 400]).toContain(response.status);
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
    await finishCleanup(r);
  } finally { querySpy?.mockRestore(); await admission.query('ROLLBACK'); admission.release(); await r.f.close(); }
}, 60_000);

test('revoke-other fences retained first-party families when the provider has no active other session hook', async () => {
  const r = await revocationFixture(107);
  try {
    await r.f.pool.query('UPDATE "session" SET "expiresAt" = now() - interval \'1 minute\' WHERE "userId" = $1 AND id <> $2',
      [r.member.id, r.current.id]);
    const context = await r.f.auth.$context;
    const sample = await context.internalAdapter.listSessions(r.member.id);
    expect(sample).toHaveLength(100);
    expect(sample.filter(row => row.id !== r.current.id && row.expiresAt > new Date())).toHaveLength(0);
    // Natural browser expiry deliberately leaves retained refresh usable;
    // explicit sign-out must still fence that family without a provider hook.
    const refreshed = await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const child = await refreshed.json() as { refresh_token: string };
    expect((await r.f.request('/api/auth/revoke-other-sessions', {})).status).toBe(401);
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [r.member.id])).rowCount).toBe(108);
    expect((await r.f.request('/api/auth/revoke-other-sessions', {}, r.member.cookie)).status).toBe(200);
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [r.member.id])).rowCount).toBe(108);
    expect((await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token)).status).toBe(400);
    expect((await r.refresh(r.product.client_id, child.refresh_token)).status).toBe(400);
    await finishCleanup(r);
    expect((await r.f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [r.member.id])).rows).toEqual([{ id: r.current.id }]);
    expect((await r.f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
      WHERE "userId" = $1 AND "clientId" = $2 AND "sessionId" IS DISTINCT FROM $3`,
    [r.member.id, r.product.client_id, r.current.id])).rowCount).toBe(0);
    expect((await r.refresh(r.product.client_id, r.kept.refresh_token)).status).toBe(200);
    const external = await r.refresh(r.external.client_id, r.offline.refresh_token);
    expect(external.status).toBe(200);
    expect(await r.oauth.introspect((await external.json() as { access_token: string }).access_token)).toMatchObject({ active: true });
  } finally { await r.f.close(); }
}, 120_000);

test('cleanup caps retained token history and pending consent writes before deleting a session with large FK fanout', async () => {
  const r = await revocationFixture(3);
  try {
    const session = r.sessions[0]!;
    await r.f.pool.query(`INSERT INTO "oauthRefreshToken"
      SELECT (jsonb_populate_record(NULL::"oauthRefreshToken", to_jsonb(r) || jsonb_build_object(
        'id', 'retained-refresh-' || n, 'token', 'retained-refresh-token-' || n))).*
      FROM "oauthRefreshToken" r, generate_series(1, 251) n WHERE token = $1`, [hash(session.tokens.refresh_token)]);
    await r.f.pool.query(`INSERT INTO "oauthAccessToken"
      (id, token, "clientId", "userId", "sessionId", "refreshId", scopes, resources, "createdAt", "expiresAt")
      SELECT 'retained-access-' || n, 'retained-access-token-' || n, "clientId", "userId", "sessionId",
        id, scopes, resources, now(), now() + interval '5 minutes'
      FROM "oauthRefreshToken", generate_series(1, 251) n WHERE token = $1`, [hash(session.tokens.refresh_token)]);
    await r.f.pool.query(`INSERT INTO rezics_account_pending_consent (id, session_id, installation_id, expires_at)
      SELECT 'retained-consent-' || n, $1, $2::uuid, now() + interval '5 minutes' FROM generate_series(1, 251) n`,
    [session.id, randomUUID()]);
    await r.f.pool.query('TRUNCATE session_cleanup_writes');
    const revoked = await queryCount(() => r.f.request('/api/auth/revoke-session', { token: session.token }, r.member.cookie));
    expect(revoked.result.status).toBe(200);
    expect(revoked.queries).toBeLessThanOrEqual(64);
    expect((await r.f.pool.query(`SELECT count(*)::integer AS count FROM session_cleanup_writes
      WHERE table_name NOT IN ('session', 'rezics_account_security', 'rezics_account_security_event')`)).rows[0].count).toBe(0);
    expect(await r.opaqueActive(session.opaque)).toMatchObject({ active: false });
    const first = await cleanupPage(r);
    expect(first.pending).toBe(true);
    expect(first.sessions).toBe(0);
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [session.id])).rowCount).toBe(1);
    expect((await r.f.pool.query('SELECT 1 FROM "oauthRefreshToken" WHERE token = $1',
      [hash(session.tokens.refresh_token)])).rowCount).toBe(1);
    expect(await finishCleanup(r)).toBeGreaterThan(1);
    expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [session.id])).rowCount).toBe(0);
    expect((await r.f.pool.query(`SELECT 1 FROM "oauthRefreshToken"
      WHERE "sessionId" = $1 AND "clientId" = $2`, [session.id, r.product.client_id])).rowCount).toBe(0);
    expect((await r.refresh(r.product.client_id, r.kept.refresh_token)).status).toBe(200);
    expect((await r.refresh(r.external.client_id, r.offline.refresh_token)).status).toBe(200);
  } finally { await r.f.close(); }
}, 60_000);

test('Account revoke-other uses the same fixed fence for large inventories and preserves its current session', async () => {
  const r = await revocationFixture(107);
  try {
    await r.f.pool.query('TRUNCATE session_cleanup_writes');
    const request = await queryCount(() => r.f.request('/api/account/sessions/revoke', { others: true }, r.member.cookie));
    expect(request.result.status).toBe(200);
    expect(await request.result.json()).toEqual({ revoked: null });
    expect(request.queries).toBeLessThanOrEqual(64);
    expect((await r.f.pool.query('SELECT 1 FROM session_cleanup_writes WHERE operation = \'DELETE\'')).rowCount).toBe(0);
    expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.sessions[0]!.cookie }) })).toBeNull();
    expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.member.cookie }) }))
      .toMatchObject({ session: { id: r.current.id } });
    expect((await r.refresh(r.product.client_id, r.kept.refresh_token)).status).toBe(200);
    const devices = await r.f.request('/api/account/sessions?limit=100', undefined, r.member.cookie);
    expect(devices.status).toBe(200);
    const listed = await devices.json() as { items: { id: string }[]; nextCursor: string | null };
    expect(listed.items.map(item => item.id)).toEqual([r.current.id]);
    expect(listed.nextCursor).toBeNull();
    expect((await r.refresh(r.product.client_id, r.sessions.at(-1)!.tokens.refresh_token)).status).toBe(400);
    await finishCleanup(r);
    expect((await r.f.pool.query('SELECT id FROM "session" WHERE "userId" = $1', [r.member.id])).rows)
      .toEqual([{ id: r.current.id }]);
  } finally { await r.f.close(); }
}, 120_000);


for (const mode of ['others', 'single'] as const) {
  test(`external offline rotation replay stays usable after native ${mode} revocation before cleanup`, async () => {
    const r = await revocationFixture(3);
    try {
      const rotated = await r.refresh(r.external.client_id, r.offline.refresh_token);
      expect(rotated.status).toBe(200);
      const child = await rotated.json() as { access_token: string; refresh_token: string };
      expect(await r.oauth.introspect(child.access_token)).toMatchObject({ active: true });
      const path = mode === 'others' ? '/revoke-other-sessions' : '/revoke-session';
      expect((await r.f.request(`/api/auth${path}`, mode === 'single' ? { token: r.sessions[0]!.token } : {},
        r.member.cookie)).status).toBe(200);
      // Retain the authored link so replay recovery cannot rely on maintenance
      // having detached the parent or its already-issued child.
      expect((await r.f.pool.query('SELECT "sessionId" FROM "oauthRefreshToken" WHERE token = $1',
        [hash(r.offline.refresh_token)])).rows[0]).toEqual({ sessionId: r.sessions[0]!.id });
      expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [r.sessions[0]!.id])).rowCount).toBe(1);
      const replayed = await r.refresh(r.external.client_id, r.offline.refresh_token);
      expect(replayed.status).toBe(200);
      const replay = await replayed.json() as { access_token: string; refresh_token: string };
      expect(await r.oauth.introspect(replay.access_token)).toMatchObject({ active: true });
      const continued = await r.refresh(r.external.client_id, child.refresh_token);
      expect(continued.status).toBe(200);
      const continuation = await continued.json() as { access_token: string; refresh_token: string };
      expect(await r.oauth.introspect(continuation.access_token)).toMatchObject({ active: true });
      expect((await r.f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1',
        [r.member.id])).rows).toEqual(r.consent);
      expect((await r.f.pool.query(`SELECT client_id, generation, revoked_at FROM rezics_account_grant
        WHERE user_id = $1 ORDER BY client_id`, [r.member.id])).rows).toEqual(r.generations);
      await finishCleanup(r);
      const afterCleanup = await r.refresh(r.external.client_id, continuation.refresh_token);
      expect(afterCleanup.status).toBe(200);
      expect(await r.oauth.introspect((await afterCleanup.json() as { access_token: string }).access_token))
        .toMatchObject({ active: true });
      expect((await r.refresh(r.product.client_id, r.kept.refresh_token)).status).toBe(200);
      expect((await r.refresh(r.product.client_id, r.sessions[0]!.tokens.refresh_token)).status).toBe(400);
    } finally { await r.f.close(); }
  }, 60_000);
}

test('native session read cannot expose a row snapshotted before single-session terminal revocation', async () => {
  const r = await revocationFixture(3);
  let resume!: () => void;
  const releaseRead = new Promise<void>(resolve => { resume = resolve; });
  let snapshotted!: () => void;
  const snapshot = new Promise<void>(resolve => { snapshotted = resolve; });
  const query = Client.prototype.query;
  let paused = false;
  const target = r.sessions[0]!;
  const querySpy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    const input = args[0];
    const text = typeof input === 'string' ? input
      : typeof input === 'object' && input !== null && 'text' in input ? String(input.text) : '';
    const values = Array.isArray(args[1]) ? args[1]
      : typeof input === 'object' && input !== null && 'values' in input && Array.isArray(input.values)
        ? input.values : [];
    const result = Reflect.apply(query, this, args);
    if (!paused && /\bselect\b/i.test(text) && /\bfrom\s+(?:"public"\.)?"session"/i.test(text)
      && values.includes(target.token)) {
      paused = true;
      return Promise.resolve(result).then(async row => {
        snapshotted();
        await releaseRead;
        return row;
      });
    }
    return result;
  });
  try {
    const reading = r.f.request('/api/auth/get-session', undefined, target.cookie);
    await Promise.race([snapshot, reading.then(() => { throw new Error('Native session read did not reach the adapter snapshot'); })]);
    expect((await r.f.request('/api/auth/revoke-session', { token: target.token }, r.member.cookie)).status).toBe(200);
    expect((await r.f.pool.query('SELECT rezics_generation FROM "session" WHERE id = $1', [target.id])).rows[0])
      .toEqual({ rezics_generation: null });
    resume();
    const response = await reading;
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: target.cookie }) })).toBeNull();
    expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.member.cookie }) }))
      .toMatchObject({ session: { id: r.current.id } });
  } finally { resume(); querySpy.mockRestore(); await r.f.close(); }
}, 60_000);
