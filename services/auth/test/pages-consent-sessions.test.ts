import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService } from '../src/index.ts';

const issuer = 'https://pages.auth.test';
const password = 'pages fixture correct horse battery staple';
const prefix = randomUUID();
const web = `${prefix}-web`;
const external = `${prefix}-external`;
const accounts = new Map<string, AccessAccount>();
let fixture: ReturnType<typeof testDatabase> | undefined;
let database: Pool;
let service: AuthService;
let person: string;
let other: string;
let cookie: string;
let otherCookie: string;

function request(path: string, body?: unknown, session = cookie, headers: Record<string, string> = {}) {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie: session, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function signin(accountId = person, clientId = web) {
  const response = await request(
    '/signin',
    { account_id: accountId, password, client_id: clientId, scope: ['read'] },
    '',
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function sessionId(session: string) {
  const response = await request('/sessions', undefined, session);
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.sessions.find((entry: { current: boolean }) => entry.current).id as string;
}
beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  const key = { ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)), kid: prefix };
  service = await createAuthService({
    database,
    issuer,
    audience: 'https://pages.api.test',
    secret: 'pages-fixture-secret-with-at-least-32-bytes',
    signing: { activeKid: prefix, privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(accountId) {
        return { accountId };
      },
    }),
  });
  await service.internal.registerClient({ clientId: web, firstParty: true, scopes: ['read'] });
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['write', 'read'],
    displayName: '  Example Client  ',
  });
  for (const id of [(person = randomUUID()), (other = randomUUID())]) {
    const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
    accounts.set(id, account);
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    account.state = 'active';
  }
  cookie = await signin();
  otherCookie = await signin(other);
}, 60000);
afterAll(async () => {
  await database?.end();
  fixture?.close();
});

test('consent read returns the client display name registered scopes and current consent', async () => {
  const path = `/consent/${external}`;
  const response = await request(path);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    client_id: external,
    display_name: 'Example Client',
    scopes: ['read', 'write'],
    requested: [],
    granted: [],
    pending_reduction: false,
    acting_account: { account_id: person, email: `${person}@example.test` },
    decisions: { allow: true, decline: true, switch_account: true },
  });
  expect((await request('/consent', { client_id: external, scope: ['read'] })).status).toBe(200);
  expect((await request('/consent', { client_id: external, scope: ['write'] }, otherCookie)).status).toBe(200);
  expect((await (await request(path)).json()).granted).toEqual(['read']);
  const review = await request(`${path}?scope=write%20unknown:permission`);
  expect(review.status).toBe(200);
  expect((await review.json()).requested).toEqual(['write', 'unknown:permission']);
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['read', 'write'],
    displayName: 'Renamed',
  });
  expect((await (await request(path)).json()).display_name).toBe('Renamed');
  for (const displayName of ['', '   ', 'x'.repeat(101), 42, null]) {
    await expect(
      service.internal.registerClient({
        clientId: external,
        firstParty: false,
        scopes: ['read', 'write'],
        displayName: displayName as string,
      }),
    ).rejects.toMatchObject({ status: 400 });
  }
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['read', 'write'],
    displayName: ` ${'x'.repeat(100)} `,
  });
  expect((await (await request(path)).json()).display_name).toHaveLength(100);
  await service.internal.registerClient({ clientId: external, firstParty: false, scopes: ['read', 'write'] });
  expect((await (await request(path)).json()).display_name).toBeNull();
  // Pending reductions are already effective, before the epoch barrier completes.
  await database.query(
    'UPDATE auth_consent SET pending_scopes=ARRAY[]::text[],pending_reference=$3 WHERE account_id=$1 AND client_id=$2',
    [person, external, 'pending'],
  );
  const pending = await request(path);
  expect(await pending.json()).toMatchObject({ granted: [], pending_reduction: true, decisions: { allow: false } });
  await database.query(
    'UPDATE auth_consent SET pending_scopes=NULL,pending_reference=NULL WHERE account_id=$1 AND client_id=$2',
    [person, external],
  );
});

test('review-bound Allow and a nonempty reduction refuse grants added after the browser review', async () => {
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['read', 'write', 'delete'],
    displayName: 'Example Client',
  });
  await database.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [person, external]);
  const establish = await request('/consent', { client_id: external, scope: ['read', 'write'] });
  expect(establish.status).toBe(200);

  const allowReview = await request(`/consent/${external}?scope=delete`);
  expect((await allowReview.json()).granted).toEqual(['read', 'write']);
  expect((await request('/consent', { client_id: external, scope: ['read', 'write', 'delete'] })).status).toBe(200);
  const staleAllow = await request('/consent', {
    client_id: external,
    scope: ['read', 'write', 'delete'],
    reviewed_account_id: person,
    reviewed_scopes: ['read', 'write'],
    reviewed_requested: ['delete'],
  });
  expect(staleAllow.status).toBe(409);
  expect(await staleAllow.json()).toMatchObject({ code: 'stale_review' });
  expect((await (await request(`/consent/${external}`)).json()).granted).toEqual(['read', 'write', 'delete']);

  expect((await request('/consent', { client_id: external, scope: ['read', 'write'] })).status).toBe(200);
  const lastBrowserRead = await request(`/consent/${external}`);
  expect((await lastBrowserRead.json()).granted).toEqual(['read', 'write']);
  expect((await request('/consent', { client_id: external, scope: ['read', 'write', 'delete'] })).status).toBe(200);
  const staleReduction = await request('/consent', {
    client_id: external,
    scope: ['read'],
    reviewed_scopes: ['read', 'write'],
  });
  expect(staleReduction.status).toBe(409);
  expect(await staleReduction.json()).toMatchObject({ code: 'stale_review' });
  const stored = await database.query<{
    scopes: string[];
    pending_scopes: string[] | null;
    pending_reference: string | null;
  }>('SELECT scopes,pending_scopes,pending_reference FROM auth_consent WHERE account_id=$1 AND client_id=$2', [
    person,
    external,
  ]);
  expect(stored.rows[0]).toEqual({
    scopes: ['read', 'write', 'delete'],
    pending_scopes: null,
    pending_reference: null,
  });
  await database.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [person, external]);
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['read', 'write'],
    displayName: 'Example Client',
  });
});

test('consent read refuses signed-out browsers and first-party or unknown clients', async () => {
  for (const session of ['', 'better-auth.session_token=invalid']) {
    expect((await request(`/consent/${external}`, undefined, session)).status).toBe(401);
    expect((await request('/sessions', undefined, session)).status).toBe(401);
  }
  for (const clientId of [web, 'unknown', 'rezics-website']) {
    const response = await request(`/consent/${clientId}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'authentication_denied' });
  }
  await database.query('UPDATE auth_client_coverage SET ready=false WHERE client_id=$1', [external]);
  expect((await request(`/consent/${external}`)).status).toBe(404);
  await database.query('UPDATE auth_client_coverage SET ready=true WHERE client_id=$1', [external]);
  await database.query("INSERT INTO auth_client_reduction VALUES ($1,$2,ARRAY['read'],false)", [
    external,
    `${prefix}-reduction`,
  ]);
  expect((await request(`/consent/${external}`)).status).toBe(404);
  await database.query('DELETE FROM auth_client_reduction WHERE client_id=$1', [external]);
  const account = accounts.get(person)!;
  for (const patch of [{ fenced: true }, { authnEpoch: 2 }, { state: 'suspended' as const }]) {
    const saved = { ...account };
    Object.assign(account, patch);
    expect((await request(`/consent/${external}`)).status).toBe(401);
    expect((await request('/sessions')).status).toBe(401);
    Object.assign(account, saved);
    delete account.fenced;
  }
});

test("sessions list returns only this person's sessions and marks the current one", async () => {
  const second = await signin();
  const secondId = await sessionId(second);
  await database.query(
    'UPDATE session SET "createdAt"=CURRENT_TIMESTAMP+interval \'1 second\',"userAgent"=\'Pages Browser\' WHERE id=$1',
    [secondId],
  );
  const expired = await signin();
  const expiredId = await sessionId(expired);
  await database.query('UPDATE session SET "expiresAt"=CURRENT_TIMESTAMP-interval \'1 second\' WHERE id=$1', [
    expiredId,
  ]);
  const response = await request('/sessions');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { sessions } = await response.json();
  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toMatchObject({ id: secondId, client_id: web, user_agent: 'Pages Browser', current: false });
  expect(sessions.filter((entry: { current: boolean }) => entry.current)).toHaveLength(1);
  for (const entry of sessions) {
    expect(Object.keys(entry).sort()).toEqual([
      'client_display_name',
      'client_id',
      'created_at',
      'current',
      'expires_at',
      'id',
      'user_agent',
    ]);
    expect(entry.client_display_name).toBeNull();
    expect(Number.isFinite(Date.parse(entry.created_at))).toBe(true);
    expect(Date.parse(entry.expires_at)).toBeGreaterThan(Date.now());
    const stored = (await database.query('SELECT token,"userId" FROM session WHERE id=$1', [entry.id])).rows[0];
    expect(stored.userId).toBe(person);
    expect(entry.id).not.toBe(stored.token);
    expect(JSON.stringify(sessions)).not.toContain(stored.token);
  }
  expect((await request('/session', undefined, expired)).status).toBe(401);
});

test('sessions carry registered names including reduced clients and null for unnamed or missing clients', async () => {
  await service.internal.registerClient({
    clientId: external,
    firstParty: false,
    scopes: ['read', 'write'],
    displayName: '  Session Client  ',
  });
  const id = await sessionId(await signin(person, external));
  const listed = async () => {
    const response = await request('/sessions');
    expect(response.status).toBe(200);
    return (await response.json()).sessions as { id: string; client_id: string; client_display_name: string | null }[];
  };
  try {
    const consent = await request(`/consent/${external}`);
    expect(consent.status).toBe(200);
    const { display_name } = await consent.json();
    expect(display_name).toBe('Session Client');
    for (const session of await listed())
      expect(session.client_display_name).toBe(session.client_id === external ? display_name : null);
    for (const reduced of [false, true]) {
      if (reduced)
        await database.query("INSERT INTO auth_client_reduction VALUES ($1,$2,ARRAY['read'],false)", [
          external,
          `${prefix}-session-reduction`,
        ]);
      else await database.query('UPDATE auth_client_coverage SET ready=false WHERE client_id=$1', [external]);
      expect((await listed()).find((session) => session.id === id)).toMatchObject({
        client_id: external,
        client_display_name: display_name,
      });
      await database.query('UPDATE auth_client_coverage SET ready=true WHERE client_id=$1', [external]);
    }
    await database.query('UPDATE auth_client SET display_name=NULL WHERE client_id=$1', [external]);
    expect((await listed()).find((session) => session.id === id)?.client_display_name).toBeNull();
    const connection = await database.connect();
    try {
      await connection.query('BEGIN');
      // Model an orphaned historical session despite the current foreign key.
      await connection.query('SET LOCAL session_replication_role=replica');
      await connection.query('UPDATE session SET "clientId"=$2 WHERE id=$1', [id, `${prefix}-missing`]);
      await connection.query('COMMIT');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    expect((await listed()).find((session) => session.id === id)).toMatchObject({
      client_id: `${prefix}-missing`,
      client_display_name: null,
    });
  } finally {
    await database.query('DELETE FROM session WHERE id=$1', [id]);
    await database.query('DELETE FROM auth_client_reduction WHERE client_id=$1', [external]);
    await database.query('UPDATE auth_client_coverage SET ready=true WHERE client_id=$1', [external]);
  }
});

test('revoking an own session ends it and revoking the current one clears the cookie', async () => {
  const own = await signin();
  const ownId = await sessionId(own);
  const response = await request('/sessions/revoke', { session_id: ownId });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
  expect(response.headers.getSetCookie()).toEqual([]);
  expect((await request('/session', undefined, own)).status).toBe(401);
  expect((await request('/session')).status).toBe(200);
  const current = await signin();
  const currentId = await sessionId(current);
  const revoked = await request('/sessions/revoke', { session_id: currentId }, current);
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({});
  expect(
    revoked.headers.getSetCookie().some((value) => value.includes('session_token=;') && /max-age=0/i.test(value)),
  ).toBe(true);
  expect((await request('/session', undefined, current)).status).toBe(401);
});

test("revoking another account's session is refused and changes nothing", async () => {
  const foreignId = await sessionId(otherCookie);
  const before = (await database.query('SELECT * FROM session ORDER BY id')).rows;
  for (const id of [foreignId, randomUUID()]) {
    const response = await request('/sessions/revoke', { session_id: id });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'authentication_denied' });
    expect(response.headers.getSetCookie()).toEqual([]);
  }
  expect((await database.query('SELECT * FROM session ORDER BY id')).rows).toEqual(before);
  expect((await request('/session', undefined, otherCookie)).status).toBe(200);
});

test('pages routes enforce origin queries closed bodies and no-store errors without mutation', async () => {
  const id = await sessionId(cookie);
  for (const [path, body, headers, status] of [
    ['/sessions?extra=1', undefined, {}, 400],
    [`/consent/${external}?extra=1`, undefined, {}, 400],
    [`/consent/${external}?scope=read&scope=write`, undefined, {}, 400],
    ['/sessions/revoke?extra=1', { session_id: id }, {}, 400],
    ['/sessions/revoke', { session_id: id }, { origin: 'https://evil.test' }, 403],
    ['/sessions/revoke', { session_id: id }, { 'sec-fetch-site': 'cross-site' }, 403],
    ['/sessions/revoke', { session_id: id, user_id: other }, {}, 400],
    ['/sessions/revoke', {}, {}, 400],
    ['/sessions/revoke', { session_id: 1 }, {}, 400],
    ['/sessions/revoke', { session_id: id }, { 'content-type': 'text/plain' }, 415],
    ['/sessions/revoke', { session_id: id }, { cookie: '' }, 401],
    ['/sessions/revoke', undefined, {}, 404],
    ['/sessions', {}, {}, 404],
    [`/consent/${external}`, {}, {}, 404],
  ] as const) {
    const response = await request(path, body, cookie, headers);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ error: 'authentication_denied' });
  }
  expect((await request('/session')).status).toBe(200);
});
