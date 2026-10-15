import { enrollSecondFactor } from './factor-fixture.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Pool } from 'pg';
import type { AccountConfig } from '../src/auth.ts';
import { startPostgresCluster, type PostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { prepareAuthentication, type AuthenticationProvider } from '../src/authentication-input.ts';
import { resolveAuthenticationSubject } from '../src/authentication-subject.ts';
import { AccountProblem, accountSession } from '../src/http.ts';
import { createAccountApp } from '../src/app.ts';
import { accountFixture, freePort } from './account-fixture.ts';

let cluster: PostgresCluster | undefined;
let databases: Pool | undefined;
let databaseSequence = 0;
const templateDatabase = 'authentication_subject_template';

beforeAll(async () => {
  cluster = await startPostgresCluster();
  databases = new Pool(cluster.connection);
  await databases.query(`CREATE DATABASE ${templateDatabase}`);
  const template = await accountFixture({}, '127.0.0.1', {}, {
    connection: { ...cluster.connection, database: templateDatabase },
    initialize: true, dispose: async () => {},
  });
  try {
    // Provider initialization is lazy and also reads the schema. Finish it
    // before closing every connection for CREATE DATABASE's consistent cut.
    await template.auth.$context;
  } finally { await template.close(); }
}, 60_000);

afterAll(async () => {
  try { await databases?.end(); }
  finally { cluster?.remove(); }
});

async function subjectFixture(overrides: Partial<AccountConfig> = {}) {
  const database = `authentication_subject_${++databaseSequence}`;
  // Build the provider schema once; each proof restores an independent copy.
  await databases!.query(`CREATE DATABASE ${database} TEMPLATE ${templateDatabase}`);
  return accountFixture(overrides, '127.0.0.1', {}, {
    connection: { ...cluster!.connection, database },
    dispose: async () => { await databases!.query(`DROP DATABASE ${database}`); },
  });
}

const expiresAt = new Date(Date.now() + 7 * 86_400_000);

function request(path: string, body?: unknown, headers: HeadersInit = {}, method = body === undefined ? 'GET' : 'POST') {
  return new Request(`http://transport.test${path}`, { method,
    headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

async function resolve(auth: AuthenticationProvider, pool: Pool, req: Request) {
  const prepared = await prepareAuthentication(auth, req);
  if (prepared.kind !== 'prepared') throw new Error(`unexpected admission: ${prepared.response.status}`);
  return resolveAuthenticationSubject(auth, pool, prepared.input);
}

test('P21: embedded mail admission validates the effective schema and session-first matching email', async () => {
  const f = await subjectFixture({ requireEmailVerification: false });
  try {
    const peer = await f.signup('embedded-peer@example.test');
    const address = 'embedded-mail@example.test';
    const created = await f.request('/api/auth/sign-up/email', { email: address,
      password: 'correct horse battery staple', name: 'Embedded mail' });
    expect(created.status).toBe(200);
    const cookie = created.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const headers = new Headers({ cookie, origin: f.baseURL });
    const count = async (email: string) => (await f.pool.query('SELECT count FROM rezics_account_rate_limit WHERE key=$1',
      [createHmac('sha256', f.secret).update(`/api/auth/send-verification-email:${email}`).digest('hex')])).rows;
    expect(await f.auth.api.sendVerificationEmail({ headers, body: { email: address.toUpperCase() } })).toEqual({ status: true });
    expect(await count(address)).toEqual([{ count: 1 }]);
    expect(await count(peer.email)).toEqual([]);
    for (const email of [peer.email, ` ${address} `]) {
      await expect(f.auth.api.sendVerificationEmail({ headers, body: { email } })).rejects.toMatchObject({ statusCode: 400 });
      expect(await count(address)).toEqual([{ count: 1 }]);
      expect(await count(peer.email)).toEqual([]);
    }
  } finally { await f.close(); }
}, 60_000);

test('P18: newest verification selection is read-only and equal-createdAt ambiguity refuses', async () => {
  const f = await subjectFixture();
  try {
    const a = await f.signup('newest-a@example.test');
    const b = await f.signup('newest-b@example.test');
    const identifier = 'reset-password:duplicate-proof';
    const old = new Date(Date.now() - 5_000);
    const fresh = new Date(Date.now() - 1_000);
    await f.pool.query('INSERT INTO verification (id, identifier, value, "createdAt", "updatedAt", "expiresAt") VALUES ($1,$2,$3,$4,$4,$5),($6,$2,$7,$8,$8,$5)',
      ['duplicate-old', identifier, a.id, old, expiresAt, 'duplicate-new', b.id, fresh]);
    const req = request('/api/auth/reset-password', { token: 'duplicate-proof', newPassword: 'new long password' });
    const subject = await resolve(f.auth, f.pool, req);
    expect(subject.candidateUserId).toBe(b.id);
    expect(subject.verification?.createdAt).toEqual(fresh);
    expect((await f.pool.query('SELECT id FROM verification WHERE identifier=$1', [identifier])).rowCount).toBe(2);
    await f.pool.query('UPDATE verification SET "createdAt"=$1 WHERE identifier=$2', [fresh, identifier]);
    await expect(resolve(f.auth, f.pool, req)).rejects.toEqual(new AccountProblem('invalid_request', 400));
  } finally { await f.close(); }
}, 60_000);

test('P22: operator audit keeps the provider-context actor and returned client id despite forged actor fields', async () => {
  const f = await subjectFixture();
  try {
    const operator = await f.signup('provider-operator@example.test');
    const peer = await f.signup('forged-operator@example.test');
    f.operators.add(operator.id);
    await enrollSecondFactor(f, operator);
    const headers = new Headers({ cookie: operator.cookie, origin: f.baseURL });
    headers.append('x-account-reason', 'First reason');
    headers.append('x-account-reason', 'Second reason');
    const body = { client_name: 'Provider custody', token_endpoint_auth_method: 'none' as const,
      grant_types: ['authorization_code' as const], redirect_uris: ['https://app.example.test/callback'], scope: 'openid',
      actorId: peer.id, userId: peer.id, sessionId: 'forged-session' };
    const created = await f.auth.api.adminCreateOAuthClient({ headers, body });
    const audit = (await f.pool.query<{ actor_id: string; target_id: string; outcome: string; reason: string }>(
      `SELECT actor_id,target_id,outcome,reason FROM rezics_account_operator_audit
       WHERE action='/admin/oauth2/create-client'`,
    )).rows;
    expect(audit).toHaveLength(2);
    expect(audit.every(row => row.actor_id === operator.id && row.reason === headers.get('x-account-reason'))).toBe(true);
    expect(audit.find(row => row.outcome === 'attempted')?.target_id).toBe('new-client');
    expect(audit.find(row => row.outcome === 'succeeded')?.target_id).toBe(created.client_id);
    const client = (await f.pool.query('SELECT "userId" FROM "oauthClient" WHERE "clientId"=$1', [created.client_id])).rows[0];
    expect(client.userId).toBe(operator.id);
  } finally { await f.close(); }
}, 60_000);

test('P23: trusted ingress normalizes repeated metadata without changing the provider subject', async () => {
  const f = await subjectFixture();
  const handler = f.auth.handler;
  let trustedApp: ReturnType<typeof createAccountApp> | undefined;
  try {
    const member = await f.signup('ingress-subject@example.test');
    const peer = await f.signup('ingress-forged@example.test');
    const port = await freePort();
    trustedApp = createAccountApp(f.auth, f.pool, { trustedProxyPeers: new Set(['127.0.0.1', '::ffff:127.0.0.1']) })
      .listen({ hostname: '127.0.0.1', port });
    const observed: { ip: string | null; country: string | null }[] = [];
    f.auth.handler = request => {
      observed.push({ ip: request.headers.get('x-rezics-client-ip'), country: request.headers.get('x-rezics-request-country') });
      return handler(request);
    };
    for (const scenario of ['untrusted', 'trusted', 'repeated'] as const) {
      const headers = new Headers({ origin: f.baseURL, 'content-type': 'application/json',
        'x-rezics-client-ip': '203.0.113.250', 'x-rezics-request-country': 'ZZ',
        'x-forwarded-for': '192.0.2.25', 'cf-ipcountry': 'US' });
      if (scenario === 'repeated') {
        headers.append('x-forwarded-for', '198.51.100.2');
        headers.append('cf-ipcountry', 'CA');
      }
      const origin = scenario === 'untrusted' ? f.baseURL : `http://127.0.0.1:${port}`;
      const response = await fetch(`${origin}/api/auth/sign-in/email`, { method: 'POST', headers,
        body: JSON.stringify({ email: member.email, password: member.password, userId: peer.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ user: { id: member.id } });
      const metadata = observed.at(-1)!;
      if (scenario === 'trusted') expect(metadata).toEqual({ ip: '192.0.2.25', country: 'US' });
      else {
        expect(metadata.country).toBeNull();
        expect(metadata.ip === '127.0.0.1' || metadata.ip === '::ffff:127.0.0.1').toBe(true);
      }
    }
    expect(observed).toHaveLength(3);
    const events = (await f.pool.query('SELECT user_id,detail FROM rezics_account_security_event WHERE user_id=$1 AND action=\'sign_in\'', [member.id])).rows;
    expect(events.every(event => event.user_id === member.id && !JSON.stringify(event.detail).includes('203.0.113.250'))).toBe(true);
  } finally {
    f.auth.handler = handler;
    await trustedApp?.stop();
    await f.close();
  }
}, 60_000);

test('P29: Account origin admission and custom proof retain the provider actor despite injected session fields', async () => {
  const f = await subjectFixture();
  try {
    const member = await f.signup('account-actor@example.test');
    const peer = await f.signup('account-forged-actor@example.test');
    const actor = await f.auth.api.getSession({ headers: new Headers({ cookie: member.cookie }) });
    const other = await f.auth.api.getSession({ headers: new Headers({ cookie: peer.cookie }) });
    expect(actor).not.toBeNull();
    expect(other).not.toBeNull();
    const headers = new Headers({ cookie: member.cookie, origin: f.baseURL });
    headers.append('origin', f.baseURL);
    await expect(accountSession(f.auth, request('/api/account/reauthenticate', { password: member.password }, headers)))
      .rejects.toEqual(new AccountProblem('invalid_origin', 403));
    const beforePeer = (await f.pool.query('SELECT verified_at FROM rezics_account_step_up WHERE session_id=$1', [other!.session.id])).rows;
    const result = await f.request('/api/account/reauthenticate', { password: member.password,
      userId: peer.id, actorId: peer.id, sessionId: other!.session.id }, member.cookie);
    expect(result.status).toBe(200);
    expect((await f.pool.query('SELECT session_id FROM rezics_account_step_up WHERE session_id=$1', [actor!.session.id])).rows)
      .toEqual([{ session_id: actor!.session.id }]);
    expect((await f.pool.query('SELECT verified_at FROM rezics_account_step_up WHERE session_id=$1', [other!.session.id])).rows).toEqual(beforePeer);
  } finally { await f.close(); }
}, 60_000);

test('P30: provider-created user and session identities ignore forged signup and sign-in user ids', async () => {
  const f = await subjectFixture();
  try {
    const peer = await f.signup('provider-created-peer@example.test');
    const email = 'provider-created-owner@example.test';
    const password = 'correct horse battery staple';
    const signup = await f.request('/api/auth/sign-up/email', { email, password, name: 'Provider-created owner',
      userId: peer.id, actorId: peer.id, sessionId: 'forged-session' });
    expect(signup.status).toBe(200);
    expect(await signup.json()).toEqual({ status: true });
    const user = (await f.pool.query<{ id: string }>('SELECT id FROM "user" WHERE email=$1', [email])).rows[0]!;
    expect(user.id).not.toBe(peer.id);
    await f.email.drain();
    const mail = [...f.messages].reverse().find(message => message.to === email)!;
    const verification = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    expect((await f.request(`${verification.pathname}${verification.search}`)).status).toBe(302);
    const signin = await f.request('/api/auth/sign-in/email', { email, password,
      userId: peer.id, actorId: peer.id, sessionId: 'forged-session' });
    expect(signin.status).toBe(200);
    expect(await signin.clone().json()).toMatchObject({ user: { id: user.id } });
    const cookie = signin.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const actual = await f.auth.api.getSession({ headers: new Headers({ cookie }) });
    expect(actual).toMatchObject({ user: { id: user.id }, session: { userId: user.id } });
    expect((await f.pool.query('SELECT "userId" FROM "session" WHERE id=$1', [actual!.session.id])).rows)
      .toEqual([{ userId: user.id }]);
  } finally { await f.close(); }
}, 60_000);
