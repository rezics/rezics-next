import { expect, test } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Elysia } from 'elysia';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMainApp } from '../../../services/main/src/app.ts';
import { mcpRoutes } from '../../../services/main/src/routes/mcp.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { accountFixture, freePort } from '../../../services/account/tests/account-fixture.ts';
import { oauthFixture } from '../../../services/account/tests/oauth-fixture.ts';
import { startMediaStack } from './media-support.ts';

test('G-580: official remote MCP client registers, consents with PKCE, reads/searches through Main and loses access on revocation', async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const account = await accountFixture({ resource: origin });
  const stack = await startMediaStack('g580');
  const client = new Client({ name: 'g580-remote', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  let main: ReturnType<typeof createMainApp> | undefined;
  try {
    const owner = await stack.member('mcp-reader');
    const shown = await stack.publicWork(owner.actor);
    await stack.publicWork(owner.actor);
    const hidden = await stack.privateWork(owner.actor);
    await owner.grant(`work:read:${shown.work}`, 'work.read');
    await owner.grant(`work:read:${hidden.work}`, 'work.read');
    const oauth = await oauthFixture(account);
    const person = await account.signup('g580-remote@example.test');
    const registration = await account.request('/api/auth/oauth2/register', {
      client_name: 'Remote MCP agent', token_endpoint_auth_method: 'none',
      redirect_uris: ['https://notes.example.test/callback'], grant_types: ['authorization_code', 'refresh_token'],
      scope: 'openid work:read offline_access',
    });
    expect(registration.status).toBe(201);
    const registered = await registration.json() as { client_id: string };
    const tokens = await oauth.issue(registered.client_id, person.cookie);
    const verifierConfig = { issuer: `${account.baseURL}/api/auth`, audience: origin,
      jwksUrl: `${account.baseURL}/api/auth/jwks`, introspectUrl: `${account.baseURL}/api/auth/oauth2/introspect`,
      clientId: oauth.verifier.client_id, clientSecret: oauth.verifier.client_secret! };
    const verifier = new AccountAssertionVerifier(verifierConfig);
    await stack.accessPool.query('UPDATE access.principal SET account_issuer = $1, account_subject = $2 WHERE id = $3',
      [verifierConfig.issuer, person.id, owner.principalId]);
    main = createMainApp(stack.fuseki, { environment: stack.env, account: verifier, access: stack.access,
      accessPolicy: new AccessPolicyOwner(stack.accessPool), media: stack.media, mediaAccess: stack.mediaAccess,
      mcp: { issuer: verifierConfig.issuer, resource: origin } });
    main.listen({ hostname: '127.0.0.1', port });
    const headers = { authorization: `Bearer ${tokens.access_token}` };
    const metadata = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`);
    expect(await metadata.json()).toMatchObject({ authorization_servers: [verifierConfig.issuer], resource: origin,
      scopes_supported: ['context:read', 'wiki:propose', 'work:read'] });
    const issuerMetadata = await fetch(`${account.baseURL}/api/auth/.well-known/openid-configuration`);
    expect(await issuerMetadata.json()).toMatchObject({ registration_endpoint: `${account.baseURL}/api/auth/oauth2/register` });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers } }));
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === 'search_catalogue')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'read_resource')).toBe(true);
    expect(tools.tools.some(tool => tool.name === 'work_create')).toBe(false);
    const compare = async (tool: string, arguments_: Record<string, unknown>, path: string) => {
      const direct = await fetch(new URL(path, origin), { headers });
      const viaMcp = await client.callTool({ name: tool, arguments: arguments_ });
      const body = await direct.json() as Record<string, unknown>;
      const actual = viaMcp.structuredContent as { status: number; headers: Record<string, string>; body: Record<string, unknown> };
      // Fresh cursors use random authenticated encryption. Compare their
      // semantics by crossing adapters when redeeming, not their ciphertext.
      if (typeof body.next === 'string') {
        expect(typeof actual.body.next).toBe('string');
        body.next = actual.body.next;
      }
      expect(actual).toEqual({ status: direct.status,
        headers: Object.fromEntries([...direct.headers].filter(([name]) => !['date', 'content-length', 'transfer-encoding'].includes(name))),
        body });
      return viaMcp;
    };
    const path = { resource: shown.work.split('/').at(-1)! };
    const query = { actingSubject: owner.actor };
    const resource = await compare('read_resource', { path, query },
      `/v1/resources/${path.resource}?${new URLSearchParams(query)}`);
    expect(resource.structuredContent).toMatchObject({ status: 200, body: { reference: shown.work } });
    const search = await compare('search_catalogue', { query: { q: 'g580', limit: 1 } }, '/v1/search/catalogue?q=g580&limit=1');
    const firstPage = search.structuredContent as { status: number; body: { next: string; results: unknown[] } };
    expect(firstPage.status).toBe(200);
    expect(typeof firstPage.body.next).toBe('string');
    expect(firstPage.body.results).toHaveLength(1);
    // Continuation bytes are returned unchanged and can be supplied to either adapter.
    const cursor = firstPage.body.next;
    await compare('search_catalogue', { query: { q: 'g580', limit: 1, cursor } },
      `/v1/search/catalogue?${new URLSearchParams({ q: 'g580', limit: '1', cursor })}`);
    await expect(client.callTool({ name: 'work_create', arguments: {} })).rejects.toThrow('Tool is not declared');
    // The same Account-signed token is refused by a resource with a different audience.
    const other = new Elysia().use(mcpRoutes({ account: new AccountAssertionVerifier({ ...verifierConfig, audience: 'https://other.test' }),
      mcp: { issuer: verifierConfig.issuer, resource: 'https://other.test' } }, async () => { throw new Error('must not dispatch'); }));
    expect((await other.handle(new Request('http://localhost/mcp', { method: 'POST', headers }))).status).toBe(401);
    await account.pool.query('DELETE FROM "oauthConsent" WHERE "clientId" = $1 AND "userId" = $2', [registered.client_id, person.id]);
    await expect(client.callTool({ name: 'read_resource', arguments: { path, query } })).rejects.toThrow();
    expect((await fetch(`${origin}/mcp`, { method: 'POST', headers })).status).toBe(401);
    expect((await fetch(new URL(`/v1/resources/${path.resource}?${new URLSearchParams(query)}`, origin), { headers })).status).toBe(401);
  } finally {
    await client.close();
    if (main) await main.stop(true);
    await stack.stop();
    await account.close();
  }
}, 120_000);

test('G-580: native loopback registration completes signed consent and PKCE at its exact callback port', async () => {
  let returned: URL | undefined;
  const callback = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request) { returned = new URL(request.url); return new Response('Authorization received'); } });
  const redirect = `http://127.0.0.1:${callback.port}/callback`;
  const account = await accountFixture();
  try {
    const oauth = await oauthFixture(account);
    const person = await account.signup('g580-native@example.test');
    const registration = await account.request('/api/auth/oauth2/register', {
      client_name: 'REZICS', application_type: 'native', token_endpoint_auth_method: 'none',
      redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
      scope: 'openid work:read wiki:propose offline_access',
    });
    expect(registration.status, await registration.clone().text()).toBe(201);
    const registered = await registration.json() as { client_id: string; redirect_uris: string[]; application_type: string };
    expect(registered.redirect_uris).toEqual([redirect]);
    expect(registered.application_type).toBe('native');
    const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
    const authorize = new URLSearchParams({ client_id: registered.client_id, response_type: 'code',
      redirect_uri: redirect, scope: 'openid work:read wiki:propose offline_access', state,
      resource: account.config.resource, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' });
    const authorized = await account.request(`/api/auth/oauth2/authorize?${authorize}`, undefined, person.cookie);
    const pending = new URL(authorized.headers.get('location')!, account.baseURL);
    expect(pending.pathname).toBe('/consent');
    const signed = pending.searchParams.toString();
    const preview = await account.request(`/api/account/consent?${new URLSearchParams({ oauth_query: signed })}`, undefined, person.cookie);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ client: { name: 'REZICS', unverified: true,
      redirectHost: `127.0.0.1:${callback.port}` } });
    const tampered = new URLSearchParams(signed); tampered.set('redirect_uri', 'https://attacker.test/callback');
    expect((await account.request(`/api/account/consent?${new URLSearchParams({ oauth_query: tampered.toString() })}`,
      undefined, person.cookie)).status).toBe(409);
    const consent = await account.request('/api/account/consent', { oauth_query: signed, accept: true }, person.cookie);
    expect(consent.status).toBe(200);
    const destination = (await consent.json() as { url: string }).url;
    expect((await fetch(destination)).status).toBe(200);
    expect(returned!.searchParams.get('state')).toBe(state);
    const exchange = { client_id: registered.client_id, grant_type: 'authorization_code',
      code: returned!.searchParams.get('code')!, code_verifier: verifier, redirect_uri: redirect, resource: account.config.resource };
    const wrongPort = await oauth.token({ ...exchange, redirect_uri: `http://127.0.0.1:${await freePort()}/callback` });
    expect(wrongPort.status).toBe(400);
    const token = await oauth.token(exchange);
    expect(token.status, await token.clone().text()).toBe(200);
    const tokens = await token.json() as { access_token: string; scope: string };
    expect(tokens.scope.split(' ')).toContain('wiki:propose');
    expect(await oauth.introspect(tokens.access_token)).toMatchObject({ active: true });
  } finally { await account.close(); await callback.stop(true); }
}, 120_000);
