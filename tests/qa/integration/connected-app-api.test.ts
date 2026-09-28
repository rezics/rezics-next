import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { ConnectedAppStore } from '../../../services/main/src/modules/connected-apps/store.ts';
import type { McpHttpResponse, McpTransport, McpTransportRequest }
  from '../../../services/main/src/modules/connected-apps/protocol.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';
import { startControlledMcpServer } from '../support/mcp-server.ts';
import { type AccountOwner, qaEnvironment, startAccount } from './account-boundary-fixture.ts';

const root = resolve(import.meta.dir, '../../..');
const allScopes = ['connected-app:observe', 'connected-app:consent',
  'connected-app:invoke', 'connected-app:read'];
const standardScope = `openid offline_access ${allScopes.join(' ')}`;
const narrowScope = 'openid offline_access connected-app:observe connected-app:invoke connected-app:read';

class LoopbackMcpTransport implements McpTransport {
  async send(endpoint: string, request: McpTransportRequest): Promise<McpHttpResponse> {
    const response = await fetch(endpoint, { method: request.method, headers: request.headers,
      body: request.body ? new Uint8Array(request.body) : undefined,
      signal: request.signal, redirect: 'manual' });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 1_048_576) throw new Error('controlled MCP response exceeded the fixture limit');
    return { status: response.status, headers: response.headers, body: bytes };
  }
}

let contentPool: Pool;
let accessPool: Pool;
let closeDatabases: (() => Promise<void>) | undefined;
let account: AccountOwner;
let verifierClient: { client_id: string; client_secret?: string };
let verifier: AccountAssertionVerifier;
let mcp: ReturnType<typeof startControlledMcpServer>;
let fuseki: FusekiClient;
let environment: { fuseki: FusekiClient; lineage: { dataEpoch: string; routingEpoch: string };
  objectDirectory: string };

beforeAll(async () => {
  const env = qaEnvironment();
  const databases = await cloneQaAccountAccessDatabases(env.runId);
  closeDatabases = databases.close;
  contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL, max: 8 });
  accessPool = new Pool({ connectionString: databases.urls.access, max: 8 });
  await migrateContent(contentPool);
  mcp = startControlledMcpServer();
  account = await startAccount({ pool: { connectionString: databases.urls.account, max: 8 },
    secret: env.secret, resource: mcp.resource });
  verifierClient = await account.workloadApp('Connected apps Main verifier', ['connected-app:invoke']);
  verifier = new AccountAssertionVerifier(account.verifierConfig(verifierClient));
  fuseki = new FusekiClient(env.fusekiUrl);
  environment = { fuseki, lineage: { dataEpoch: env.dataEpoch, routingEpoch: env.routingEpoch },
    objectDirectory: join(root, '.temp', `connected-app-${randomUUID()}`) };
}, 60_000);

beforeEach(() => mcp?.reset());

afterAll(async () => {
  await account?.stop();
  await mcp?.stop();
  await Promise.all([contentPool?.end(), accessPool?.end()]);
  await closeDatabases?.();
}, 60_000);

async function fixture(name: string, scopes = standardScope) {
  const client = await account.nativeApp(`Connected app ${name}`, scopes);
  const member = await account.signUp(`connected-${name}`);
  const token = await account.issue(client.client_id, member, scopes);
  const principalId = randomUUID();
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1, $2, $3)`, [principalId, account.issuer, member.id]);
  const connectedApps = new ConnectedAppStore(contentPool, new LoopbackMcpTransport());
  const app = createMainApp(fuseki, { environment, account: verifier,
    access: new AccessAdmissionRegistry(accessPool), connectedApps });
  const call = (method: string, path: string, bearer: string, body?: unknown, key?: string,
    signal?: AbortSignal) => app.handle(new Request(`http://main.local${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}) }));
  return { client, member, token: token.access_token, principalId, call };
}

async function json(response: Response, status: number): Promise<Record<string, any>> {
  const text = await response.text();
  expect({ status: response.status, text: response.status === status ? '' : text })
    .toEqual({ status, text: '' });
  return JSON.parse(text) as Record<string, any>;
}

function body(profile: string, values: Record<string, unknown>) {
  return { profile, ...values };
}

async function observe(f: Awaited<ReturnType<typeof fixture>>, key = `observe-${randomUUID()}`) {
  return json(await f.call('POST', '/v1/connected-apps/observations', f.token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), key), 201);
}

async function createCeiling(f: Awaited<ReturnType<typeof fixture>>, observation: string,
  tools: string[] = ['echo'], resource = mcp.resource, key = `ceiling-${randomUUID()}`) {
  return json(await f.call('POST', '/v1/connected-apps/consent-ceilings', f.token,
    body('connected-app-consent-ceiling-v1', { observation, resource, tools }), key), 201);
}

function invocation(ceiling: string, toolName: string, args: Record<string, unknown>) {
  return body('connected-app-invocation-v1', { ceiling, toolName, arguments: args });
}

test('HUB05: tool schema and capability drift invalidate the current Account consent ceiling', async () => {
  const f = await fixture('drift');
  const original = await observe(f);
  expect(original).toMatchObject({ protocolVersion: '2026-07-28', drift: 'initial', pageCount: 3,
    serverInfo: { name: 'controlled-mcp' } });
  expect(mcp.methods).toEqual(['server/discover', 'tools/list', 'tools/list', 'tools/list']);
  expect(original.tools.map((tool: { name: string }) => tool.name)).toEqual(['echo', 'reject', 'slow']);
  const firstCeiling = await createCeiling(f, original.observation, ['echo']);
  const oldClaims = await account.introspect(verifierClient, f.token);
  expect(oldClaims.active).toBe(true);

  mcp.setSchemaRevision(2);
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(firstCeiling.ceiling, 'echo', { text: 'allowed' }), 'drift-schema-call')).status).toBe(409);
  expect(mcp.calls).toHaveLength(0);
  const driftedSchema = await json(await f.call('POST', '/v1/connected-apps/observations', f.token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `observe-schema-${randomUUID()}`), 200);
  expect(driftedSchema).toMatchObject({ drift: 'unchanged', predecessor: original.observation });
  expect(driftedSchema.tools[0].definitionSha256).not.toBe(original.tools[0].definitionSha256);

  await account.issue(f.client.client_id, f.member, narrowScope);
  expect((await account.introspect(verifierClient, f.token)).active).toBe(false);
  const renewed = await account.issue(f.client.client_id, f.member, standardScope);
  const newClaims = await account.introspect(verifierClient, renewed.access_token);
  expect(newClaims).toMatchObject({ active: true, rezics_auth_mode: 'consent' });
  expect(newClaims.rezics_consent_generation).not.toBe(oldClaims.rezics_consent_generation);
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(firstCeiling.ceiling, 'echo', { text: 'allowed' }), 'old-consent-call')).status).toBe(401);

  const nextSnapshot = await json(await f.call('POST', '/v1/connected-apps/observations', renewed.access_token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `observe-renewed-${randomUUID()}`), 200);
  const secondCeiling = await json(await f.call('POST', '/v1/connected-apps/consent-ceilings', renewed.access_token,
    body('connected-app-consent-ceiling-v1', { observation: nextSnapshot.observation,
      resource: mcp.resource, tools: ['echo'] }), `ceiling-renewed-${randomUUID()}`), 201);

  mcp.setCapabilityRevision(1);
  expect((await f.call('POST', '/v1/connected-apps/invocations', renewed.access_token,
    invocation(secondCeiling.ceiling, 'echo', { text: 'allowed' }), 'drift-capability-call')).status).toBe(409);
  expect(mcp.calls).toHaveLength(0);
  const driftedCapability = await json(await f.call('POST', '/v1/connected-apps/observations', renewed.access_token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `observe-capability-${randomUUID()}`), 200);
  expect(driftedCapability).toMatchObject({ drift: 'unchanged', capabilities: { tools: { listChanged: true } } });

  await account.issue(f.client.client_id, f.member, narrowScope);
  const reconsented = await account.issue(f.client.client_id, f.member, standardScope);
  const finalSnapshot = await json(await f.call('POST', '/v1/connected-apps/observations', reconsented.access_token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `observe-final-${randomUUID()}`), 200);
  const finalCeiling = await json(await f.call('POST', '/v1/connected-apps/consent-ceilings', reconsented.access_token,
    body('connected-app-consent-ceiling-v1', { observation: finalSnapshot.observation,
      resource: mcp.resource, tools: ['echo'] }), `ceiling-final-${randomUUID()}`), 201);
  const result = await json(await f.call('POST', '/v1/connected-apps/invocations', reconsented.access_token,
    invocation(finalCeiling.ceiling, 'echo', { text: 'renewed authority' }), 'drift-approved-call'), 201);
  expect(result.state).toBe('completed');
  expect(mcp.calls).toHaveLength(1);
  expect((await account.introspect(verifierClient, renewed.access_token)).active).toBe(false);
  expect((await contentPool.query<{ count: string }>(`SELECT count(*) FROM connected_app.server_observation
    WHERE principal_id = $1`, [f.principalId])).rows[0]?.count).toBe('3');
}, 60_000);

test('HUB06: paginated observations, Account scopes, delegated audience and tool/protocol errors stay distinct', async () => {
  const f = await fixture('protocol');
  expect((await f.call('POST', '/v1/connected-apps/observations', f.token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }))).status).toBe(400);

  const noObserver = await fixture('no-observer', 'openid offline_access');
  const beforeDenied = mcp.methods.length;
  expect((await f.call('POST', '/v1/connected-apps/observations', noObserver.token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `denied-${randomUUID()}`)).status).toBe(401);
  expect(mcp.methods.length).toBe(beforeDenied);

  const snapshot = await observe(f);
  expect(snapshot).toMatchObject({ pageCount: 3, toolCount: 3 });
  expect(mcp.methods.slice(0, 4)).toEqual(['server/discover', 'tools/list', 'tools/list', 'tools/list']);
  expect((await contentPool.query<{ count: string }>(`SELECT count(*) FROM connected_app.observation_page
    WHERE observation_id = $1`, [snapshot.observation])).rows[0]?.count).toBe('3');
  expect((await f.call('POST', '/v1/connected-apps/consent-ceilings', f.token,
    body('connected-app-consent-ceiling-v1', { observation: snapshot.observation,
      resource: `${mcp.resource}/unapproved`, tools: ['echo'] }), `wrong-resource-${randomUUID()}`)).status)
    .toBe(403);
  const ceiling = await createCeiling(f, snapshot.observation, ['echo', 'reject']);
  const beforeCalls = mcp.calls.length;
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(ceiling.ceiling, 'slow', { text: 'outside the ceiling' }), `outside-${randomUUID()}`)).status)
    .toBe(403);
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(ceiling.ceiling, 'echo', {}), `bad-args-${randomUUID()}`)).status).toBe(422);
  expect(mcp.calls).toHaveLength(beforeCalls);

  const toolError = await json(await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(ceiling.ceiling, 'reject', { text: 'please reject' }), 'tool-error-call'), 201);
  expect(toolError.state).toBe('tool-error');
  expect(toolError.result.isError).toBe(true);
  mcp.setCallMode('rpc-error');
  const protocolError = await json(await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(ceiling.ceiling, 'echo', { text: 'remote protocol rejection' }), 'protocol-error-call'), 502);
  expect(protocolError.state).toBe('protocol-error');
  expect(protocolError.protocolError).toMatchObject({ code: -32001 });
  expect(mcp.calls.map(call => call.authorization)).toEqual([`Bearer ${f.token}`, `Bearer ${f.token}`]);
  expect(mcp.calls.every(call => call.protocolVersion === '2026-07-28'
    && call.methodHeader === 'tools/call' && call.nameHeader === call.name)).toBe(true);
  expect(mcp.invalidHeaders).toEqual([]);
  const other = await fixture('private-read');
  expect((await other.call('GET', `/v1/connected-apps/invocations/${toolError.invocation}`,
    other.token)).status).toBe(404);
}, 60_000);

test('HUB06: cancellation and lost upstream replies are uncertain, replay safely and never redispatch', async () => {
  const f = await fixture('cancel');
  const snapshot = await observe(f);
  const ceiling = await createCeiling(f, snapshot.observation, ['slow', 'echo']);
  const controller = new AbortController();
  const intent = invocation(ceiling.ceiling, 'slow', { text: 'wait for cancellation' });
  const first = f.call('POST', '/v1/connected-apps/invocations', f.token, intent,
    'cancelled-call-key', controller.signal);
  await mcp.waitForCalls(1);
  const concurrentReplay = await json(await f.call('POST', '/v1/connected-apps/invocations', f.token,
    intent, 'cancelled-call-key'), 202);
  expect(concurrentReplay.state).toBe('sent');
  controller.abort();
  const cancelledResponse = await first;
  expect([200, 202]).toContain(cancelledResponse.status);
  expect(mcp.cancellations).toEqual(['slow']);
  const cancelled = await json(await f.call('POST', '/v1/connected-apps/invocations', f.token, intent,
    'cancelled-call-key'), 200);
  expect(cancelled.state).toBe('uncertain');
  expect(mcp.calls).toHaveLength(1);

  mcp.setCallMode('http-error');
  const uncertainIntent = invocation(ceiling.ceiling, 'echo', { text: 'upstream may have completed' });
  const uncertain = await json(await f.call('POST', '/v1/connected-apps/invocations', f.token,
    uncertainIntent, 'lost-response-key'), 202);
  expect(uncertain.state).toBe('uncertain');
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    uncertainIntent, 'lost-response-key')).status).toBe(200);
  expect(mcp.calls).toHaveLength(2);
  expect((await f.call('POST', '/v1/connected-apps/invocations', f.token,
    invocation(ceiling.ceiling, 'echo', { text: 'different payload' }), 'lost-response-key')).status).toBe(409);
}, 60_000);

test('HUB06: a server whose discovery facts outgrow their bounds is refused, not stored', async () => {
  const f = await fixture('oversized');
  mcp.setCapabilityRevision(-1);
  const refused = await f.call('POST', '/v1/connected-apps/observations', f.token,
    body('connected-app-observation-v1', { endpoint: mcp.endpoint }), `observe-${randomUUID()}`);
  expect(refused.status).toBe(502);
  expect(await refused.json()).toMatchObject({ code: 'connected_app_protocol_error' });
  expect((await contentPool.query<{ count: string }>(`SELECT count(*) FROM connected_app.server_observation
    WHERE principal_id = $1`, [f.principalId])).rows[0]?.count).toBe('0');
  mcp.setCapabilityRevision(0);
  expect(await observe(f)).toMatchObject({ drift: 'initial' });
}, 60_000);
