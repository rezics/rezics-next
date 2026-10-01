import { afterAll, expect, test } from 'bun:test';
import { accountFixture } from './account-fixture.ts';
import { oauthFixture } from './oauth-fixture.ts';
import { agentRegistrationScopes } from '../src/auth.ts';

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
    { resources: ['https://elsewhere.test'] },
    { subject_type: 'pairwise' },
  ]) {
    const response = await f.request('/api/auth/oauth2/register', { ...registration, ...extra });
    expect(response.status, JSON.stringify(extra) + await response.clone().text()).toBe(400);
  }
}, 90_000);
