import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type EffectAuthorization,
  type SessionProof,
} from '../src/index.ts';

const issuer = 'https://effects.auth.test';
const password = 'correct horse battery staple';
const accounts = new Map<string, AccessAccount>();
const deliveries = new Map<string, string>();
let pool: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let fixture: ReturnType<typeof testDatabase> | undefined;
let outage = false;
let fence = false;
let sequence = 0;
const credentialKey = await generateKeyPair('ES256', { extractable: true });
const publicJwk = { ...(await exportJWK(credentialKey.publicKey)), kid: 'own-key', alg: 'ES256' as const };

function actor(id: string, automated = false) {
  const account: AccessAccount = { accountId: id, kind: 'actor', state: 'active', automated, authnEpoch: 1 };
  accounts.set(id, account);
  return account;
}
function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(new Request(`${issuer}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}
function cookie(response: Response) {
  return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
}
async function login(id: string, target = service) {
  const response = await request('/signin', { email: `${id}@example.test`, password, client_id: 'effects-web', scope: ['read', 'write'] }, '', target);
  expect(response.status).toBe(200);
  return cookie(response);
}
async function provision(id: string, automated = false) {
  const account = actor(id, automated);
  account.state = 'pending';
  await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  account.state = 'active';
}
async function proof(headers: Headers): Promise<SessionProof> {
  const response = await request('/session', undefined, headers.get('cookie') ?? '');
  expect(response.status).toBe(200);
  return response.json() as Promise<SessionProof>;
}
async function authorization(subjectAccountId: string, purpose: EffectAuthorization['purpose'], headers: Headers, invalidates = false) {
  const human = await proof(headers);
  const subject = accounts.get(subjectAccountId)!;
  const receipt: EffectAuthorization = {
    receiptId: `effect-${++sequence}`, subjectAccountId, purpose,
    actingHumanId: human.account_id, operatorAccountId: subject.automated ? 'effects-human' : null,
    clientId: human.client_id, scopes: human.scope, humanEpoch: human.authn_epoch,
    subjectEpoch: subject.authnEpoch, expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  await pool.query('INSERT INTO test_effect_receipt VALUES ($1,$2,$3)', [receipt.receiptId, receipt, invalidates]);
  return receipt.receiptId;
}
async function credential(subjectAccountId: string, headers: Headers, value: Parameters<AuthService['internal']['setCredential']>[0]['credential']) {
  const purpose = value.kind === 'password' ? value.password === null ? 'remove-password' : 'set-password' : value.remove ? 'remove-key' : 'add-key';
  const ref = await authorization(subjectAccountId, purpose, headers, purpose === 'remove-password' || purpose === 'remove-key' || purpose === 'set-password');
  return service.internal.setCredential({ subjectAccountId, authorization: ref, headers, credential: value });
}
async function assertion(id: string, overrides: Record<string, unknown> = {}, kid = 'own-key') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: id, sub: id, aud: `${issuer}/token`, iat: now, exp: now + 60, jti: `assertion-${++sequence}`, ...overrides })
    .setProtectedHeader({ alg: 'ES256', kid }).sign(credentialKey.privateKey);
}
async function keySignin(id: string, jwt: string, target = service) {
  return request('/signin/key', { account_id: id, assertion: jwt, client_id: 'effects-web', scope: ['read'] }, '', target);
}
async function issued(cookieValue: string) {
  const response = await request('/token', {}, cookieValue);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function kernelAccepts(token: string) {
  // Models the existing cached-JWKS/floor verifier boundary; final Goal suites
  // must bind actual Access commands and kernel verification instead of this fixture.
  const jwks = await (await request('/.well-known/jwks.json')).json();
  const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), { issuer, audience: 'https://effects.api.test', algorithms: ['ES256'] });
  const account = accounts.get(payload.sub!)!;
  return !fence && account.state === 'active' && Number(payload.authn_epoch) >= account.authnEpoch;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.AUTH_TEST_DATABASE_URL ?? (fixture = testDatabase()).url });
  await pool.query('CREATE TABLE test_effect_receipt (id text PRIMARY KEY, value jsonb NOT NULL, invalidates boolean NOT NULL)');
  const key = await generateKeyPair('ES256', { extractable: true });
  const signingKey = { ...(await exportJWK(key.privateKey)), kid: 'effects-signer', alg: 'ES256' };
  options = {
    database: pool, issuer, audience: 'https://effects.api.test', secret: 'effects-better-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    recoveryDelivery: { async deliver(input) { deliveries.set(input.accountId, input.token); } },
    trustedAccess: {
      async readAccount(id) { if (outage) throw new Error('Access unavailable'); return fence ? null : accounts.get(id) ?? null; },
      async readRecoveryAccount(id) { if (outage) throw new Error('Access unavailable'); return accounts.get(id) ?? null; },
      async authorizeProvisioning(id) { return { accountId: id }; },
      async consumeAuthorization(input) {
        if (outage) throw new Error('Access unavailable');
        const result = await pool.query('DELETE FROM test_effect_receipt WHERE id=$1 RETURNING value, invalidates', [input.authorization]);
        const receipt = result.rows[0]?.value as EffectAuthorization | undefined;
        const subject = accounts.get(input.subjectAccountId);
        if (!receipt || !subject || receipt.purpose !== input.purpose || receipt.subjectAccountId !== input.subjectAccountId ||
          receipt.actingHumanId !== input.human.account_id || receipt.clientId !== input.human.client_id ||
          receipt.humanEpoch !== input.human.authn_epoch || receipt.subjectEpoch !== subject.authnEpoch ||
          JSON.stringify(receipt.scopes) !== JSON.stringify(input.human.scope) ||
          Date.parse(receipt.expiresAt) <= Date.now() ||
          (subject.automated ? receipt.operatorAccountId !== 'effects-human' || input.human.account_id !== 'effects-human' : input.human.account_id !== subject.accountId)) throw new Error('Access denied');
        if (result.rows[0].invalidates) {
          subject.authnEpoch++;
          receipt.subjectEpoch = subject.authnEpoch;
          receipt.invalidation = { receiptId: `floor-${sequence}`, accountId: subject.accountId, minimumAuthnEpoch: subject.authnEpoch };
        }
        return receipt;
      },
      async invalidateAccount(input) {
        if (outage) throw new Error('Access unavailable');
        const subject = accounts.get(input.accountId)!;
        subject.authnEpoch++;
        return { receiptId: `floor-${++sequence}`, accountId: subject.accountId, minimumAuthnEpoch: subject.authnEpoch };
      },
      async authorizeRecovery(input) {
        if (outage) throw new Error('Access unavailable');
        const account = accounts.get(input.accountId)!;
        if (input.proofEpoch !== account.authnEpoch || account.automated) throw new Error('Stale recovery');
        account.authnEpoch++;
        return { receiptId: `recovery-${++sequence}`, accountId: account.accountId, minimumAuthnEpoch: account.authnEpoch };
      },
    },
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'effects-web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({ clientId: 'effects-external', firstParty: false, scopes: ['read', 'write'] });
  await provision('effects-human');
}, 30000);
afterAll(async () => { await pool?.end(); fixture?.close(); });

test('automated opening consumes its own durable purpose-bound Access receipt before a real Better Auth session', async () => {
  actor('effects-agent', true);
  const headers = new Headers({ cookie: await login('effects-human') });
  const ref = await authorization('effects-agent', 'session', headers);
  const response = await service.internal.openAutomatedSession({ subjectAccountId: 'effects-agent', authorization: ref, headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ account_id: 'effects-agent', amr: ['operator'], authn_epoch: 1 });
  const token = await issued(cookie(response));
  expect(decodeJwt(token)).toMatchObject({ sub: 'effects-agent', amr: ['operator'] });
  expect(decodeJwt(token)).not.toHaveProperty('act');
  expect(decodeJwt(token)).not.toHaveProperty('actingHumanId');
  const rows = await pool.query('SELECT "userId" FROM session WHERE "userId"=$1', ['effects-agent']);
  expect(rows.rows).toEqual([{ userId: 'effects-agent' }]);
  expect((await pool.query('SELECT email FROM "user" WHERE id=$1', ['effects-agent'])).rows).toEqual([{ email: null }]);
  expect((await pool.query('SELECT acting_human_id, operator_account_id FROM auth_session_opening WHERE subject_account_id=$1', ['effects-agent'])).rows)
    .toEqual([{ acting_human_id: 'effects-human', operator_account_id: 'effects-human' }]);
  await expect(service.internal.openAutomatedSession({ subjectAccountId: 'effects-agent', authorization: ref, headers })).rejects.toThrow();
});

test('opening denies missing forged expired wrong-subject wrong-purpose and invalid operator evidence without session effects', async () => {
  const headers = new Headers({ cookie: await login('effects-human') });
  actor('effects-other-agent', true);
  for (const mode of ['missing', 'forged', 'expired', 'subject', 'purpose', 'operator', 'inactive', 'human', 'organization', 'outage']) {
    const ref = await authorization('effects-agent', 'session', headers);
    if (mode === 'expired') await pool.query("UPDATE test_effect_receipt SET value=jsonb_set(value,'{expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [ref]);
    if (mode === 'purpose') await pool.query("UPDATE test_effect_receipt SET value=jsonb_set(value,'{purpose}',to_jsonb('add-key'::text)) WHERE id=$1", [ref]);
    if (mode === 'operator') await pool.query("UPDATE test_effect_receipt SET value=jsonb_set(value,'{operatorAccountId}',to_jsonb('other'::text)) WHERE id=$1", [ref]);
    if (mode === 'inactive') accounts.get('effects-agent')!.state = 'suspended';
    if (mode === 'outage') outage = true;
    if (mode === 'organization') accounts.set('effects-org', { ...accounts.get('effects-agent')!, accountId: 'effects-org', kind: 'organization' });
    const before = (await pool.query('SELECT count(*) FROM session')).rows;
    await expect(service.internal.openAutomatedSession({
      subjectAccountId: mode === 'subject' ? 'effects-other-agent' : mode === 'human' ? 'effects-human' : mode === 'organization' ? 'effects-org' : 'effects-agent',
      authorization: mode === 'missing' ? '' : mode === 'forged' ? 'forged' : ref, headers,
    })).rejects.toThrow();
    expect((await pool.query('SELECT count(*) FROM session')).rows).toEqual(before);
    outage = false;
    accounts.get('effects-agent')!.state = 'active';
  }
});

test('own public keys authenticate people and automation through native sessions and durable concurrent replay protection', async () => {
  for (const id of ['effects-human', 'effects-agent']) {
    let headers = new Headers({ cookie: await login('effects-human') });
    await credential(id, headers, { kind: 'key', publicJwk, kid: 'own-key' });
    const signed = await assertion(id);
    const response = await keySignin(id, signed);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ account_id: id, amr: ['private_key_jwt'] });
    expect(decodeJwt(await issued(cookie(response))).sub).toBe(id);
    const reloaded = await createAuthService(options);
    expect((await keySignin(id, signed, reloaded)).status).toBeGreaterThanOrEqual(400);
    const concurrent = await assertion(id);
    const results = await Promise.all([keySignin(id, concurrent), keySignin(id, concurrent, reloaded)]);
    expect(results.filter(result => result.status === 200)).toHaveLength(1);
    expect((await pool.query('SELECT public_jwk FROM auth_public_key WHERE account_id=$1', [id])).rows[0].public_jwk).not.toHaveProperty('d');
    headers = new Headers({ cookie: await login('effects-human') });
    await expect(credential(id, headers, { kind: 'key', publicJwk: { ...publicJwk, d: 'secret' }, kid: 'private' })).rejects.toThrow();
  }
});

test('key assertion unknown key owner audience lifetime algorithm and unsigned confusions reject', async () => {
  for (const jwt of [
    await assertion('effects-agent', {}, 'unknown'),
    await assertion('effects-human'),
    await assertion('effects-agent', { aud: issuer }),
    await assertion('effects-agent', { exp: 1 }),
    await assertion('effects-agent', { exp: Math.floor(Date.now() / 1000) + 3600 }),
    await assertion('effects-agent', { jti: '' }),
    `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'own-key' })).toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`,
    await new SignJWT({ iss: 'effects-agent', sub: 'effects-agent' }).setProtectedHeader({ alg: 'HS256', kid: 'own-key' }).sign(new TextEncoder().encode('forged-secret')),
  ]) expect((await keySignin('effects-agent', jwt)).status).toBeGreaterThanOrEqual(400);
  expect((await request('/signin/key', { account_id: 'effects-agent', assertion: await assertion('effects-agent'), client_id: 'effects-web', scope: ['read'], operator: true })).status).toBe(400);
});

test('approved credential effects toggle independent automated signin and enforce owner and organization guards', async () => {
  let headers = new Headers({ cookie: await login('effects-human') });
  await credential('effects-agent', headers, { kind: 'password', password });
  const sign = () => request('/signin', { account_id: 'effects-agent', password, client_id: 'effects-web', scope: ['read'] });
  const signed = await sign();
  expect(signed.status).toBe(200);
  expect(await signed.json()).toMatchObject({ account_id: 'effects-agent', amr: ['pwd'] });
  const old = await issued(cookie(signed));
  headers = new Headers({ cookie: await login('effects-human') });
  await credential('effects-agent', headers, { kind: 'password', password: null });
  expect(await kernelAccepts(old)).toBe(false);
  expect((await sign()).status).toBeGreaterThanOrEqual(400);
  await credential('effects-agent', headers, { kind: 'key', kid: 'own-key', remove: true });
  expect((await keySignin('effects-agent', await assertion('effects-agent'))).status).toBeGreaterThanOrEqual(400);
  await expect(service.internal.setCredential({ subjectAccountId: 'effects-agent', headers, authorization: 'forged', credential: { kind: 'password', password } })).rejects.toThrow();
  await expect(credential('effects-org', headers, { kind: 'password', password })).rejects.toThrow();
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', ['effects-org'])).rows).toEqual([]);
  const noPorts = await createAuthService({ ...options, trustedAccess: { readAccount: options.trustedAccess.readAccount, authorizeProvisioning: options.trustedAccess.authorizeProvisioning } });
  await expect(noPorts.internal.openAutomatedSession({ subjectAccountId: 'effects-agent', authorization: 'unused', headers })).rejects.toThrow();
});

test('native human recovery delivers short lived one-use proof and requires Access invalidation before resetting credentials', async () => {
  const old = await issued(await login('effects-human'));
  expect((await request('/recovery/start', { account_id: 'effects-human' })).status).toBe(200);
  const token = deliveries.get('effects-human')!;
  expect(token.length).toBeGreaterThan(10);
  const response = await request('/recovery/complete', { account_id: 'effects-human', token, new_password: password });
  expect(response.status).toBe(200);
  expect(await kernelAccepts(old)).toBe(false);
  expect((await request('/recovery/complete', { account_id: 'effects-human', token, new_password: password })).status).toBeGreaterThanOrEqual(400);
  expect((await login('effects-human')).length).toBeGreaterThan(0);
  expect((await request('/recovery/start', { account_id: 'effects-agent' })).status).toBeGreaterThanOrEqual(400);
  expect(deliveries.has('effects-agent')).toBe(false);
  const native = await pool.query('SELECT identifier FROM verification');
  expect(JSON.stringify(native.rows)).not.toContain(token);
});

test('stale expired wrong-owner recovery and Access outage cannot clear a newer floor or fence', async () => {
  await request('/recovery/start', { account_id: 'effects-human' });
  const stale = deliveries.get('effects-human')!;
  accounts.get('effects-human')!.authnEpoch++;
  fence = true;
  const floor = accounts.get('effects-human')!.authnEpoch;
  expect((await request('/recovery/complete', { account_id: 'effects-human', token: stale, new_password: password })).status).toBeGreaterThanOrEqual(400);
  expect(accounts.get('effects-human')!.authnEpoch).toBe(floor);
  expect(fence).toBe(true);
  await request('/recovery/start', { account_id: 'effects-human' });
  const fresh = deliveries.get('effects-human')!;
  outage = true;
  expect((await request('/recovery/complete', { account_id: 'effects-human', token: fresh, new_password: password })).status).toBeGreaterThanOrEqual(400);
  outage = false;
  expect(accounts.get('effects-human')!.authnEpoch).toBe(floor);
  expect(fence).toBe(true);
  await request('/recovery/start', { account_id: 'effects-human' });
  const expired = deliveries.get('effects-human')!;
  await pool.query('UPDATE auth_recovery SET expires_at=$1', [new Date(0)]);
  expect((await request('/recovery/complete', { account_id: 'effects-human', token: expired, new_password: password })).status).toBeGreaterThanOrEqual(400);
  await request('/recovery/start', { account_id: 'effects-human' });
  const current = deliveries.get('effects-human')!;
  expect((await request('/recovery/complete', { account_id: 'effects-agent', token: current, new_password: password })).status).toBeGreaterThanOrEqual(400);
  expect((await request('/recovery/complete', { account_id: 'effects-human', token: current, new_password: password })).status).toBe(200);
  expect(fence).toBe(true);
  expect((await request('/signin', { email: 'effects-human@example.test', password, client_id: 'effects-web', scope: ['read'] })).status).toBeGreaterThanOrEqual(400);
  fence = false; // Only Access lifecycle clears its own fence after fresh recovery evidence.
});

test('consent reductions invalidate already-issued signed authority through Access before Auth changes and outages fail closed', async () => {
  let human = await login('effects-human');
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read', 'write'] }, human)).status).toBe(200);
  const before = accounts.get('effects-human')!.authnEpoch;
  const external = await request('/signin', { email: 'effects-human@example.test', password, client_id: 'effects-external', scope: ['write'] });
  expect(external.status).toBe(200);
  const old = await issued(cookie(external));
  expect(await kernelAccepts(old)).toBe(true);
  outage = true;
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human)).status).toBeGreaterThanOrEqual(400);
  outage = false;
  expect(accounts.get('effects-human')!.authnEpoch).toBe(before);
  const noInvalidation = await createAuthService({ ...options, trustedAccess: { ...options.trustedAccess, invalidateAccount: undefined } });
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human, noInvalidation)).status).toBeGreaterThanOrEqual(400);
  expect(await kernelAccepts(old)).toBe(true);
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read'] }, human)).status).toBe(200);
  expect(await kernelAccepts(old)).toBe(false);
  expect((await request('/token', {}, cookie(external))).status).toBeGreaterThanOrEqual(400);
  expect((await pool.query('SELECT id FROM session WHERE "userId"=$1', ['effects-human'])).rows).toEqual([]);
  human = await login('effects-human');
  const after = accounts.get('effects-human')!.authnEpoch;
  expect((await request('/consent', { client_id: 'effects-external', scope: ['read', 'write'] }, human)).status).toBe(200);
  expect(accounts.get('effects-human')!.authnEpoch).toBe(after);
});

test('registered-client shrink refuses unsupported cross-account revocation and preserves old configuration', async () => {
  const old = await issued(await login('effects-human'));
  await expect(service.internal.registerClient({ clientId: 'effects-web', firstParty: true, scopes: ['read'] })).rejects.toThrow();
  expect(await kernelAccepts(old)).toBe(true);
  expect((await pool.query('SELECT scopes FROM auth_client WHERE client_id=$1', ['effects-web'])).rows).toEqual([{ scopes: ['read', 'write'] }]);
});
