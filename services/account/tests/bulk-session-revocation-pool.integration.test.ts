import { expect, spyOn, test } from 'bun:test';
import { schemaCheckFor } from '@better-auth/core/db/internal';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('base64url');
type Fixture = Awaited<ReturnType<typeof accountFixture>>;

/** Keep the real Account pool and provider transactions. A nested checkout
 * must fail promptly instead of hiding behind a second connection or hanging
 * until the test timeout. Count attempts, including ones caught by a hook. */
function oneConnection(f: Fixture) {
  f.pool.options.max = 1;
  f.pool.options.connectionTimeoutMillis = 250;
  expect(f.pool.totalCount).toBe(1);
  const accountClients = new WeakSet<Client>();
  const acquired = (client: Client) => { accountClients.add(client); };
  f.pool.on('acquire', acquired);
  const held = new Set<Client>();
  const stats = { nestedCheckouts: 0, transactions: 0, transactionReads: 0, nestedAttempts: [] as string[] };
  const query = Client.prototype.query;
  const querySpy = spyOn(Client.prototype, 'query').mockImplementation(function(this: Client, ...args: unknown[]) {
    // Code/refresh guard transactions have separate owner pools. Only clients
    // acquired from this exact Account pool can hold its sole connection.
    if (!accountClients.has(this)) return Reflect.apply(query, this, args);
    const input = args[0];
    const sql = typeof input === 'string' ? input
      : typeof input === 'object' && input !== null && 'text' in input ? String(input.text) : '';
    if (/^\s*begin\b/i.test(sql)) { held.add(this); stats.transactions++; }
    if (held.has(this) && /^\s*select\b/i.test(sql)) stats.transactionReads++;
    if (/^\s*(?:commit|rollback)\b/i.test(sql)) held.delete(this);
    return Reflect.apply(query, this, args);
  });
  const connect = f.pool.connect;
  const connectSpy = spyOn(f.pool, 'connect').mockImplementation(function(...args: unknown[]) {
    if (held.size && f.pool.idleCount === 0) {
      stats.nestedCheckouts++;
      stats.nestedAttempts.push(new Error('Account checkout attempted inside its held transaction').stack ?? 'missing stack');
    }
    return Reflect.apply(connect, f.pool, args);
  });
  return { stats, check: () => {
    expect(stats.nestedAttempts).toEqual([]);
    expect(stats.nestedCheckouts).toBe(0);
    expect(f.pool.totalCount).toBe(1);
    expect(f.pool.waitingCount).toBe(0);
  }, close: () => { f.pool.off('acquire', acquired); connectSpy.mockRestore(); querySpy.mockRestore(); } };
}

async function tokenFixture() {
  const f = await accountFixture({}, '127.0.0.1', { max: 1, connectionTimeoutMillis: 250 });
  const guard = oneConnection(f);
  try {
    const oauth = await oauthFixture(f);
    const product = await oauth.createClient(true);
    const external = await oauth.createClient();
    await f.pool.query('INSERT INTO rezics_oauth_first_party_client (client_id) VALUES ($1)', [product.client_id]);
    const member = await f.signup('one-connection-member@example.test');
    const original = (await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) }))!.session;
    const productTokens = await oauth.issue(product.client_id, member.cookie);
    const offline = await oauth.issue(external.client_id, member.cookie);
    const signed = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(signed.status).toBe(200);
    const currentCookie = signed.headers.get('set-cookie')!;
    const current = (await f.auth.api.getSession({ headers: new Headers({ cookie: currentCookie }) }))!.session;
    expect(current.id).not.toBe(original.id);
    return { f, guard, oauth, product, external, member, original, current, currentCookie, productTokens, offline };
  } catch (error) { guard.close(); await f.close(); throw error; }
}

test('real verified HTTP signup, signin, consent and native reads use a single Account connection', async () => {
  const f = await accountFixture({}, '127.0.0.1', { max: 1, connectionTimeoutMillis: 250 });
  const guard = oneConnection(f);
  try {
    const member = await f.signup('one-connection-signup@example.test');
    const session = await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) });
    expect(session).toMatchObject({ user: { id: member.id } });
    expect((await (await f.request('/api/auth/get-session', undefined, member.cookie)).json())
      .session.id).toBe(session!.session.id);
    expect((await f.request('/api/auth/list-sessions', undefined, member.cookie)).status).toBe(200);
    await f.pool.query('UPDATE rezics_account_security SET suspended_at = now() WHERE user_id = $1', [member.id]);
    expect((await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password })).status).toBe(403);
    await f.pool.query('UPDATE rezics_account_security SET suspended_at = NULL WHERE user_id = $1', [member.id]);
    const signed = await f.request('/api/auth/sign-in/email', { email: member.email, password: member.password });
    expect(signed.status).toBe(200);
    expect(await f.auth.api.getSession({ headers: new Headers({ cookie: signed.headers.get('set-cookie')! }) }))
      .toMatchObject({ user: { id: member.id } });
    const oauth = await oauthFixture(f);
    const external = await oauth.createClient();
    const issued = await oauth.issue(external.client_id, member.cookie);
    expect(await oauth.introspect(issued.access_token)).toMatchObject({ active: true });
    expect((await f.pool.query('SELECT 1 FROM "oauthConsent" WHERE "userId" = $1 AND "clientId" = $2',
      [member.id, external.client_id])).rowCount).toBe(1);
    expect(guard.stats.transactions).toBeGreaterThan(0);
    guard.check();
  } finally { guard.close(); await f.close(); }
}, 60_000);

test('real immediate-signin signup admits its fresh session inside the provider transaction with max1 Account pool', async () => {
  const f = await accountFixture({ requireEmailVerification: false }, '127.0.0.1', { max: 1, connectionTimeoutMillis: 250 });
  const guard = oneConnection(f);
  try {
    const response = await f.request('/api/auth/sign-up/email', {
      email: 'one-connection-immediate-signup@example.test', name: 'Immediate signup',
      password: 'correct horse battery staple',
    });
    expect(response.status).toBe(200);
    const signed = await response.json() as { token: string; user: { id: string } };
    expect(signed.token).toBeString();
    const cookie = response.headers.get('set-cookie');
    expect(cookie).not.toBeNull();
    const session = await f.auth.api.getSession({ headers: new Headers({ cookie: cookie! }) });
    expect(session).toMatchObject({ user: { id: signed.user.id }, session: { token: signed.token } });
    expect(await (await f.request('/api/auth/get-session', undefined, cookie!)).json())
      .toMatchObject({ user: { id: signed.user.id }, session: { id: session!.session.id } });
    expect((await f.pool.query(`SELECT s.rezics_generation = p.session_generation AS admitted
      FROM "session" s JOIN rezics_account_security p ON p.user_id = s."userId" WHERE s.id = $1`,
    [session!.session.id])).rows[0]).toEqual({ admitted: true });
    expect(guard.stats.transactions).toBeGreaterThan(0);
    guard.check();
  } finally { guard.close(); await f.close(); }
}, 60_000);

test('a provider-held transaction reads existing and freshly admitted sessions with one Account connection and rolls back admissions', async () => {
  const f = await accountFixture({}, '127.0.0.1', { max: 1, connectionTimeoutMillis: 250 });
  const context = await f.auth.$context;
  expect(schemaCheckFor(context.adapter)).toBeFunction();
  const existing = { id: randomUUID(), userId: randomUUID() };
  await f.pool.query(`INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    VALUES ($1, 'Existing admission', 'one-connection-admission@example.test', true, now(), now())`, [existing.userId]);
  await f.pool.query(`INSERT INTO "session" (id, "userId", token, "createdAt", "updatedAt", "expiresAt")
    VALUES ($1, $2, $3, now(), now(), now() + interval '1 hour')`, [existing.id, existing.userId, randomUUID()]);
  const guard = oneConnection(f);
  const userId = randomUUID();
  const sessionId = randomUUID();
  try {
    await context.adapter.transaction(async adapter => {
      expect(await adapter.findOne({ model: 'session', where: [{ field: 'id', value: existing.id }] }))
        .toMatchObject({ id: existing.id });
    });
    await expect(context.adapter.transaction(async adapter => {
      const now = new Date();
      await adapter.create({ model: 'user', forceAllowId: true, data: {
        id: userId, name: 'Transaction admission', email: 'transaction-admission@example.test',
        emailVerified: true, createdAt: now, updatedAt: now,
      } });
      await adapter.create({ model: 'session', forceAllowId: true, data: {
        id: sessionId, userId, token: randomUUID(), createdAt: now, updatedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      } });
      const admitted = await adapter.findOne<{ id: string; userId: string; rezicsGeneration: string | number }>({
        model: 'session', where: [{ field: 'id', value: sessionId }],
      });
      expect(admitted).toMatchObject({ id: sessionId, userId });
      expect(String(admitted!.rezicsGeneration)).toBe('0');
      throw new Error('rollback_admission');
    })).rejects.toThrow('rollback_admission');
    expect((await f.pool.query('SELECT 1 FROM "user" WHERE id = $1', [userId])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [sessionId])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM rezics_account_security WHERE user_id = $1', [userId])).rowCount).toBe(0);
    expect(guard.stats.transactions).toBe(2);
    expect(guard.stats.transactionReads).toBeGreaterThan(0);
    guard.check();
  } finally { guard.close(); await f.close(); }
}, 60_000);

for (const kind of ['first-party', 'third-party-offline'] as const) {
  test(`provider-held ${kind} stale refresh lookup checks owner fences without borrowing another Account connection`, async () => {
    const r = await tokenFixture();
    const context = await r.f.auth.$context;
    const guard = r.guard;
    try {
      expect((await r.f.request('/api/auth/revoke-other-sessions', {}, r.currentCookie)).status).toBe(200);
      expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [r.original.id])).rowCount).toBe(1);
      const token = kind === 'first-party' ? r.productTokens.refresh_token : r.offline.refresh_token;
      const row = await context.adapter.transaction(adapter => adapter.findOne<{ sessionId: string | null }>({
        model: 'oauthRefreshToken', where: [{ field: 'token', value: hash(token) }],
      }));
      if (kind === 'first-party') expect(row).toBeNull();
      else expect(row).toMatchObject({ sessionId: null });
      expect(guard.stats.transactions).toBeGreaterThanOrEqual(2);
      expect(guard.stats.transactionReads).toBeGreaterThan(0);
      guard.check();
    } finally { guard.close(); await r.f.close(); }
  }, 60_000);
}

for (const mode of ['all', 'others', 'single'] as const) {
  test(`native and embedded ${mode} fence denial preserves third-party offline consent with max1 Account pool before cleanup`, async () => {
    const r = await tokenFixture();
    const guard = r.guard;
    try {
      const consent = (await r.f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1',
        [r.member.id])).rows;
      const path = mode === 'all' ? '/revoke-sessions' : mode === 'others' ? '/revoke-other-sessions' : '/revoke-session';
      expect((await r.f.request(`/api/auth${path}`, mode === 'single' ? { token: r.original.token } : {},
        r.currentCookie)).status).toBe(200);
      expect((await r.f.pool.query('SELECT 1 FROM "session" WHERE id = $1', [r.original.id])).rowCount).toBe(1);
      expect(await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.member.cookie }) })).toBeNull();
      expect(await (await r.f.request('/api/auth/get-session', undefined, r.member.cookie)).json()).toBeNull();
      expect((await r.f.request('/api/auth/list-sessions', undefined, r.member.cookie)).status).toBe(401);
      const kept = await r.f.auth.api.getSession({ headers: new Headers({ cookie: r.currentCookie }) });
      if (mode === 'all') expect(kept).toBeNull();
      else expect(kept).toMatchObject({ session: { id: r.current.id } });
      const refresh = (clientId: string, token: string) => r.oauth.token({ grant_type: 'refresh_token',
        client_id: clientId, refresh_token: token, resource: r.f.config.resource });
      expect((await refresh(r.product.client_id, r.productTokens.refresh_token)).status).toBe(400);
      const offline = await refresh(r.external.client_id, r.offline.refresh_token);
      expect(offline.status).toBe(200);
      expect(await r.oauth.introspect((await offline.json() as { access_token: string }).access_token))
        .toMatchObject({ active: true });
      expect((await r.f.pool.query('SELECT to_jsonb(c) AS row FROM "oauthConsent" c WHERE "userId" = $1',
        [r.member.id])).rows).toEqual(consent);
      guard.check();
    } finally { guard.close(); await r.f.close(); }
  }, 60_000);
}
