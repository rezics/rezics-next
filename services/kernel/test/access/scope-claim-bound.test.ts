import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createAuthenticator, type AuthenticationConfig } from '../../src/access/authenticate.ts';
import { createAccess } from '../../src/access/index.ts';
import { createApp } from '../../src/http/app.ts';
import { actionCatalogue } from '../../src/http/request.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url, max: 1 });
const accountId = '00000000-0000-7000-8000-123400000001';
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const keys = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'scope-bound', alg: 'ES256' };
const auth: AuthenticationConfig = {
  issuer,
  audience,
  jwksUrl: `${issuer}/.well-known/jwks.json`,
  fetch: async () => Response.json({ keys: [jwk] }),
};
const app = createApp({ pool, access: (config) => createAccess({ ...config, auth }) });
for (let index = 0; index < MAX_CONSENTED_SCOPES - 3; index++) {
  const suffix = String.fromCharCode(97 + Math.floor(index / 26), 97 + (index % 26));
  const action = `scope:${'a'.repeat(120)}${suffix}`;
  const detail = {
    operationId: action.replace(':', '.'),
    'x-action': action,
    'x-exposure': 'public',
    security: [{ bearerAuth: [] }],
  };
  app.get(`/scopes/${index}`, { detail }, ({ actor }) => actor);
}
const catalogue = actionCatalogue(app);
const scopes = ['openid', 'offline_access', 'media:complete', ...catalogue.keys()];
const bound = MAX_CONSENTED_SCOPE_OCTETS;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
     VALUES ($1,$2,'actor','active',$2)`,
    [0x1234, accountId],
  );
});
afterAll(() => pool.end());

async function signed(scope: string) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ client_id: 'web', scope, authn_epoch: 1, auth_time: now, amr: ['pwd'] })
    .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
}

async function request(scope: string) {
  return app.handle(
    new Request(`${audience}/scopes/0`, { headers: { authorization: `Bearer ${await signed(scope)}` } }),
  );
}

function atBound() {
  return Array.from({ length: MAX_CONSENTED_SCOPES }, (_, index) => `scope:${index}:`.padEnd(128, 'a')).join(' ');
}

async function refused(scope: string) {
  const response = await request(scope);
  expect(response.status).toBe(401);
  expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(await response.json()).toMatchObject({ status: 401, code: 'invalid_credentials' });
}

test('the kernel admits every known scope with more than 100 maximum-length mounted actions', async () => {
  expect(catalogue.size).toBe(MAX_CONSENTED_SCOPES - 3);
  expect([...catalogue.keys()].every((action) => action.length === 128)).toBe(true);
  expect(scopes.join(' ').length).toBeGreaterThan(12_900);
  const response = await request(scopes.join(' '));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ accountId, scopes });
});

test('the shared scope claim bound is inclusive and one character more is invalid credentials', async () => {
  const scope = atBound();
  expect(scope.length).toBe(bound);
  expect((await request(scope)).status).toBe(200);
  await refused(`${scope}a`);
});

test('each scope keeps its 128-character limit and original character rules', async () => {
  const allowed = Array.from({ length: 94 }, (_, index) => String.fromCharCode(33 + index))
    .filter((character) => character !== '"' && character !== '\\')
    .join('');
  for (const scope of ['', 'a'.repeat(128), allowed]) expect((await request(scope)).status).toBe(200);
  for (const scope of ['a'.repeat(129), ' a', 'a ', 'a  b', 'a"b', 'a\\b', 'a\tb', 'a\nb', 'a\x7fb', 'aéb'])
    await refused(scope);
});

test('an authenticator without a catalogue uses the shared inclusive joined-length bound', async () => {
  const { authenticate } = createAuthenticator(auth);
  const scope = atBound();
  const context = () => ({ pool, deadline: Date.now() + 3000 });
  expect(scope.length).toBe(MAX_CONSENTED_SCOPE_OCTETS);
  expect(await authenticate(await signed(scope), context())).toMatchObject({ accountId });
  await expect(authenticate(await signed(`${scope}a`), context())).rejects.toMatchObject({
    status: 401,
    challenge: 'Bearer error="invalid_token"',
  });
});

test('the consented scope bound is shared by factories regardless of catalogue size', async () => {
  const actions = new Map([['media:complete', { anonymous: false }]]);
  const access = createAccess({ actions, auth });
  for (const [action, metadata] of catalogue) actions.set(action, metadata);
  const scope = atBound();
  const context = () => ({ pool, deadline: Date.now() + 3000 });
  expect(await access.authenticate(await signed(scope), context())).toMatchObject({ accountId });
  await expect(access.authenticate(await signed(`${scope}a`), context())).rejects.toMatchObject({ status: 401 });
  expect((await request(scopes.join(' '))).status).toBe(200);
});
