import { expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { cleanupRevokedSessionPage } from '../src/first-party-session.ts';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

async function finishSessionCleanup(pool: Pool) {
  for (let invocation = 0; invocation < 16; invocation++) {
    const page = await cleanupRevokedSessionPage(pool);
    if (!page.userId) return;
  }
  throw new Error('session cleanup did not finish');
}

const registration = { client_name: 'Logout metadata client', token_endpoint_auth_method: 'none',
  redirect_uris: ['https://notes.example.test/callback'], grant_types: ['authorization_code', 'refresh_token'],
  scope: 'openid work:read offline_access' };
const refusal = { error: 'invalid_client_metadata',
  error_description: 'Backchannel logout is unavailable; omit backchannel_logout_uri' };

test('backchannel metadata is refused on every HTTP and embedded client write without partial changes', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const client = await oauth.createClient();
    const headers = new Headers({ origin: f.baseURL, cookie: oauth.owner.cookie });
    const snapshot = async () => (await f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthClient" c ORDER BY id')).rows;
    const before = await snapshot();
    // Both an apparently public hostname and a literal private address are
    // refused. No DNS or endpoint is contacted to decide admission.
    for (const uri of ['https://unverified.example.test/logout', 'https://127.0.0.1/logout']) {
      const body = { ...registration, backchannel_logout_uri: uri };
      const update = { client_id: client.client_id,
        update: { client_name: 'Must not be saved', backchannel_logout_uri: uri } };
      for (const [path, metadata, cookie] of [
        ['/oauth2/register', body, undefined],
        ['/oauth2/create-client', body, oauth.owner.cookie],
        ['/oauth2/update-client', update, oauth.owner.cookie],
      ] as const) {
        const response = await f.request(`/api/auth${path}`, metadata, cookie,
          { 'x-account-reason': 'Verify metadata admission' });
        expect({ path, status: response.status, body: await response.json() })
          .toEqual({ path, status: 400, body: refusal });
      }
      for (const write of [
        () => f.auth.api.registerOAuthClient({ body }),
        () => f.auth.api.createOAuthClient({ headers, body }),
        () => f.auth.api.adminCreateOAuthClient({ headers, body }),
        () => f.auth.api.updateOAuthClient({ headers, body: update }),
        () => f.auth.api.adminUpdateOAuthClient({ headers, body: update }),
      ]) {
        await expect(write()).rejects.toMatchObject({ status: 'BAD_REQUEST', body: refusal });
      }
      expect(await snapshot()).toEqual(before);
    }
    // Recovery: ordinary client writes still work after a refusal.
    expect((await f.request('/api/auth/oauth2/register', registration)).status).toBe(201);
    const created = await f.auth.api.createOAuthClient({ headers, body: registration });
    await f.auth.api.updateOAuthClient({ headers, body: { client_id: created.client_id,
      update: { client_name: 'Updated client' } } });
    await f.auth.api.adminUpdateOAuthClient({ headers, body: { client_id: client.client_id,
      update: { client_name: 'Updated by operator' } } });
    expect((await f.pool.query('SELECT "backchannelLogoutUri" FROM "oauthClient"')).rows
      .every(row => row.backchannelLogoutUri === null)).toBe(true);
  } finally { await f.close(); }
}, 90_000);

test('legacy backchannel destinations never dispatch on single or bulk session deletion; revocation and offline rotation remain', async () => {
  const f = await accountFixture();
  try {
    const oauth = await oauthFixture(f);
    const offlineClient = await oauth.createClient();
    const onlineClient = await oauth.createClient();
    const outbound: string[] = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(Object.assign((input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === f.baseURL) return originalFetch(input, init);
      outbound.push(url.toString());
      // Stub every external destination, including private addresses. A
      // regression records the unsafe attempt without opening any connection.
      return Promise.resolve(new Response(null, { status: 204 }));
    }, { preconnect: originalFetch.preconnect }));
    try {
      await f.pool.query(`UPDATE "oauthClient" SET "backchannelLogoutUri" = $2
        WHERE "clientId" = ANY($1::text[])`, [[offlineClient.client_id, onlineClient.client_id],
      'https://127.0.0.1/legacy-logout']);
      for (const path of ['/sign-out', '/revoke-sessions']) {
        const member = await f.signup(`${path.slice(1)}@example.test`);
        // Send Cookie pairs, rather than the fixture's raw Set-Cookie header:
        // sign-out verifies the signature independently of session lookup.
        const cookie = member.cookie.split(';', 1)[0]!;
        const session = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
        expect(session).not.toBeNull();
        // The signup fixture also opens a verification session. Retain the
        // eligible session so each deletion path snapshots its bound tokens.
        await f.pool.query('DELETE FROM "session" WHERE "userId" = $1 AND id <> $2', [member.id, session!.session.id]);
        const offline = await oauth.issue(offlineClient.client_id, cookie);
        const online = await oauth.issue(onlineClient.client_id, cookie);
        const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
        // Model a retained non-offline grant and an opaque access token. Both
        // must still be revoked by the provider's session-delete hooks.
        await f.pool.query(`UPDATE "oauthRefreshToken" SET scopes = scopes - 'offline_access'
          WHERE token = $1`, [hash(online.refresh_token)]);
        const accessId = randomUUID();
        await f.pool.query(`INSERT INTO "oauthAccessToken"
          (id, token, "clientId", "userId", "sessionId", scopes, "createdAt", "expiresAt")
          SELECT $1, $2, "clientId", "userId", "sessionId", scopes, now(), now() + interval '5 minutes'
          FROM "oauthRefreshToken" WHERE token = $3`, [accessId, randomUUID(), hash(online.refresh_token)]);
        const retained = (await f.pool.query(`SELECT "sessionId" FROM "oauthRefreshToken" WHERE token = $1`,
          [hash(online.refresh_token)])).rows[0];
        expect(retained.sessionId).toBeTruthy();
        expect(retained.sessionId).toBe(session!.session.id);
        expect((await f.request(`/api/auth${path}`, {}, cookie)).status).toBe(200);
        await finishSessionCleanup(f.pool);
        expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [retained.sessionId])).rowCount).toBe(0);
        if (path === '/revoke-sessions') {
          expect((await f.pool.query('SELECT 1 FROM "session" WHERE "userId" = $1', [member.id])).rowCount).toBe(0);
        }
        expect((await f.pool.query('SELECT revoked FROM "oauthAccessToken" WHERE id = $1', [accessId])).rows[0].revoked)
          .toBeInstanceOf(Date);
        const rows = (await f.pool.query('SELECT token, revoked FROM "oauthRefreshToken" WHERE "userId" = $1', [member.id])).rows;
        expect(rows.find(row => row.token === hash(online.refresh_token)).revoked).toBeInstanceOf(Date);
        expect(rows.find(row => row.token === hash(offline.refresh_token)).revoked).toBeNull();
        const refresh = await oauth.token({ grant_type: 'refresh_token', client_id: offlineClient.client_id,
          refresh_token: offline.refresh_token, resource: f.config.resource });
        expect(refresh.status).toBe(200);
        expect((await refresh.json() as { refresh_token: string }).refresh_token).not.toBe(offline.refresh_token);
        expect(outbound).toEqual([]);
      }
      expect((await f.pool.query('SELECT "backchannelLogoutUri" FROM "oauthClient" WHERE "clientId" = $1',
        [offlineClient.client_id])).rows[0].backchannelLogoutUri).toBe('https://127.0.0.1/legacy-logout');
    } finally { fetchSpy.mockRestore(); }
  } finally { await f.close(); }
}, 90_000);

test('HTTP and embedded discovery report backchannel logout unavailable while retaining JWT and PKCE metadata', async () => {
  const f = await accountFixture();
  try {
    const documents = [await f.auth.api.getOAuthServerConfig(), await f.auth.api.getOpenIdConfig()];
    for (const path of ['/.well-known/oauth-authorization-server/api/auth',
      '/api/auth/.well-known/oauth-authorization-server', '/api/auth/.well-known/openid-configuration']) {
      const response = await f.request(path);
      expect(response.status).toBe(200);
      documents.push(await response.json());
    }
    for (const metadata of documents) {
      expect(metadata).toMatchObject({ backchannel_logout_supported: false,
        backchannel_logout_session_supported: false, jwks_uri: `${f.baseURL}/api/auth/jwks`,
        code_challenge_methods_supported: ['S256'] });
    }
  } finally { await f.close(); }
}, 60_000);
