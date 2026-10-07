import { afterAll, expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { AGENT_REGISTRATION_BUDGET, agentRegistrationScopes } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { freePort } from './account-fixture.ts';

let started: ReturnType<typeof accountFixture> | undefined;
const fixture = () => started ??= accountFixture();
afterAll(async () => { if (started) await (await started).close(); });
const registration = { client_name: 'Public MCP client', token_endpoint_auth_method: 'none',
  redirect_uris: ['https://notes.example.test/callback'], grant_types: ['authorization_code', 'refresh_token'],
  scope: 'openid work:read offline_access' };

test('G-580: public PKCE registration retains Main audience, declared ceiling, consent and live revocation', async () => {
  const f = await fixture();
  const response = await f.request('/api/auth/oauth2/register', registration);
  expect(response.status, await response.clone().text()).toBe(201);
  const client = await response.json() as { client_id: string; client_secret?: string; resources: string[]; scope: string };
  expect(client.client_secret).toBeUndefined();
  expect(client.resources).toEqual([f.config.resource]);
  expect(client.scope.split(' ').sort()).toEqual(agentRegistrationScopes());
  // Optional private summary contexts can be consented later without allowing writes.
  expect(client.scope.split(' ')).toContain('context:read');
  // Closed-group scopes stay registered for first-party clients and are refused here.
  expect(client.scope.split(' ')).not.toContain('wiki:propose');
  const persisted = await f.pool.query<{ requirePkce: boolean; skipConsent: boolean }>(
    'SELECT "requirePKCE" AS "requirePkce", "skipConsent" FROM "oauthClient" WHERE "clientId" = $1', [client.client_id]);
  // Public clients always require PKCE; the provider stores null for its default.
  expect(persisted.rows[0]?.requirePkce).not.toBe(false);
  expect(persisted.rows[0]?.skipConsent).not.toBe(true);
  const oauth = await oauthFixture(f);
  const user = await f.signup('g580-reader@example.test');
  const pending = await oauth.code(client.client_id, user.cookie);
  const wrong = await oauth.token({ ...pending, code_verifier: 'wrong'.repeat(16), grant_type: 'authorization_code' });
  expect(wrong.status).toBe(401);
  const tokens = await oauth.issue(client.client_id, user.cookie);
  expect(await oauth.introspect(tokens.access_token)).toMatchObject({ active: true });
  await f.pool.query('DELETE FROM "oauthConsent" WHERE "clientId" = $1 AND "userId" = $2', [client.client_id, user.id]);
  expect(await oauth.introspect(tokens.access_token)).toMatchObject({ active: false });
  expect((await oauth.token({ grant_type: 'refresh_token', client_id: client.client_id,
    refresh_token: tokens.refresh_token, resource: f.config.resource })).status).toBe(400);
}, 90_000);

test('G-580: registration cannot obtain confidential, workload, trusted, excess scopes or other audiences', async () => {
  const f = await fixture();
  for (const extra of [
    { token_endpoint_auth_method: 'client_secret_post' },
    { grant_types: ['client_credentials'] },
    { skip_consent: true },
    { scope: 'access:manage' },
    { scope: 'wiki:propose' },
    { resources: ['https://elsewhere.test'] },
    { subject_type: 'pairwise' },
    ...['logo_uri', 'client_uri', 'policy_uri', 'tos_uri'].map(field => ({ [field]: 'https://unverified.test/value' })),
  ]) {
    const response = await f.request('/api/auth/oauth2/register', { ...registration, ...extra });
    expect(response.status, JSON.stringify(extra) + await response.clone().text()).toBe(400);
  }
}, 90_000);

test('G-580: persistent registration budget ignores forged IPs and trusts only configured socket peers', async () => {
  const f = await fixture();
  await f.pool.query('TRUNCATE rezics_account_rate_limit');
  const before = Number((await f.pool.query('SELECT count(*) FROM "oauthClient"')).rows[0].count);
  for (let i = 0; i < AGENT_REGISTRATION_BUDGET.maximum; i++) {
    const response = await f.request('/api/auth/oauth2/register', registration, undefined,
      { 'x-rezics-client-ip': `192.0.2.${i + 1}`, 'x-forwarded-for': `198.51.100.${i + 1}` });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const blocked = await f.request('/api/auth/oauth2/register', registration, undefined,
    { 'x-rezics-client-ip': '203.0.113.9', 'x-forwarded-for': '203.0.113.9' });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get('retry-after')).toBe(String(AGENT_REGISTRATION_BUDGET.seconds));
  expect(Number((await f.pool.query('SELECT count(*) FROM "oauthClient"')).rows[0].count))
    .toBe(before + AGENT_REGISTRATION_BUDGET.maximum);
  expect((await f.pool.query('SELECT count(*) FROM rezics_account_rate_limit')).rows[0].count).toBe('1');
  // A second service process uses the same durable counter.
  const sibling = createAccountApp(f.auth, f.pool).listen({ hostname: '127.0.0.1', port: await freePort() });
  const proxy = createAccountApp(f.auth, f.pool, { trustedProxyPeers: new Set(['127.0.0.1']) })
    .listen({ hostname: '127.0.0.1', port: await freePort() });
  try {
    const request = (port: number, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/api/auth/oauth2/register`,
      { method: 'POST', headers: { origin: f.baseURL, 'content-type': 'application/json', ...headers }, body: JSON.stringify(registration) });
    expect((await request(sibling.server!.port!)).status).toBe(429);
    expect((await request(proxy.server!.port!, { 'x-forwarded-for': '192.0.2.200' })).status).toBe(201);
    expect((await request(proxy.server!.port!, { 'x-forwarded-for': '192.0.2.1, 192.0.2.2' })).status).toBe(429);
    await f.pool.query("UPDATE rezics_account_rate_limit SET started_at = now() - interval '301 seconds'");
    const concurrent = await Promise.all(Array.from({ length: AGENT_REGISTRATION_BUDGET.maximum + 3 }, () => request(sibling.server!.port!)));
    expect(concurrent.filter(response => response.status === 201)).toHaveLength(AGENT_REGISTRATION_BUDGET.maximum);
    expect(concurrent.filter(response => response.status === 429)).toHaveLength(3);
  } finally { await sibling.stop(); await proxy.stop(); }
}, 90_000);
