import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Elysia, t } from 'elysia';
import { attachCapabilities, MCP_COST, operationTools, type CapabilityDocument } from '../src/modules/mcp/capabilities.ts';
import { mcpRoutes } from '../src/routes/mcp.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { rateLimitBudgets } from '../src/modules/rate-limit/budgets.ts';
import { mcpBody } from '../src/modules/mcp/body.ts';

const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'g580', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {} };
const rpc = (method: string, params: Record<string, unknown> = {}, token = 'reader') =>
  new Request('http://localhost/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': method,
    ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }) });

const fixture: CapabilityDocument = { paths: { '/v1/works': { post: {
  'x-rezics-exposure': 'public',
  parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object',
    properties: { actingSubject: { type: 'string' }, value: { anyOf: [{ type: 'null' }, { type: 'string' }] } },
    required: ['actingSubject'], additionalProperties: false } } } },
  'x-rezics-capability': { disposition: 'supported', mcp: { tool: 'fixture_write', title: 'Fixture write',
    description: 'One effect with the same key', scopes: ['work:create'] } },
} }, '/v1/undeclared': { get: {} } } };

test('G-580: declaration guard rejects missing operations, duplicate names and unsupported dispositions', () => {
  expect(() => attachCapabilities({ paths: {} }, { '/missing': { get: { disposition: 'supported' } } }, 'fixture'))
    .toThrow('declares a missing OpenAPI operation');
  const document: CapabilityDocument = { paths: { '/exists': { get: {} } } };
  expect(() => attachCapabilities(document, { '/exists': { get: { disposition: 'deferred' } } }, 'fixture'))
    .toThrow('invalid capability');
  expect(() => operationTools({ paths: { '/a': fixture.paths!['/v1/works'], '/b': fixture.paths!['/v1/works'] } }))
    .toThrow('duplicate MCP tool');
  for (const scopes of [undefined, [''], ['work:read', 'work:read'], ['work:read other'], ['quote"']]) {
    const invalid = structuredClone(fixture);
    const declaration = invalid.paths!['/v1/works']!.post!['x-rezics-capability']!.mcp!;
    Object.assign(declaration, { scopes });
    expect(() => operationTools(invalid)).toThrow('requires explicit OAuth scopes');
  }
});

test('G-580: every installed tool preserves each OpenAPI parameter and JSON body schema', () => {
  const document = JSON.parse(readFileSync(new URL('../../../generated/openapi/main/public.json', import.meta.url), 'utf8')) as CapabilityDocument;
  const tools = operationTools(document);
  for (const name of ['read_resource', 'resource_relations', 'resource_summaries', 'search_catalogue', 'work_editions']) {
    expect(tools.some(tool => tool.name === name)).toBe(true);
  }
  for (const tool of tools) {
    expect(tool.operation['x-rezics-capability']?.mcp?.tool).toBe(tool.name);
    expect(tool.operation['x-rezics-capability']!.mcp!.scopes.length).toBeGreaterThan(0);
    if (['wiki_candidates','wiki_validate'].includes(tool.name)) {
      expect(tool.operation['x-rezics-capability']!.mcp!.scopes).toEqual(['wiki:propose']);
    }
    if (tool.name === 'wiki_evidence') expect(tool.operation['x-rezics-capability']!.mcp!.scopes).toEqual(['work:read']);
    for (const parameter of tool.operation.parameters ?? []) {
      const group = parameter.in === 'header' ? 'headers' : parameter.in;
      const schema = tool.inputSchema.properties[group] as { properties: Record<string, unknown>; required: string[] };
      expect(schema.properties[parameter.name]).toEqual(parameter.schema);
      expect(schema.required.includes(parameter.name)).toBe(!!parameter.required);
    }
    if (tool.operation.requestBody) expect(tool.inputSchema.properties.body)
      .toEqual(tool.operation.requestBody.content!['application/json']!.schema);
    expect(tool.inputSchema.additionalProperties).toBe(false);
  }
});

test('G-580: stateless SDK transport dispatches once through G-543, preserves retry/problems, denies revoked and undeclared calls', async () => {
  let revoked = false, effects = 0, counters = 0, limited = false;
  const effectsByKey = new Map<string, { receipt: string; value?: string | null }>();
  const account = { async verify(request: Request) {
    if (revoked || request.headers.get('authorization') !== 'Bearer reader') throw new AccountAssertionDenied();
    return { issuer: 'https://account.test/api/auth', subject: 'person', accountExpiresAt: Date.now() / 1000 + 300 };
  } };
  const app = new Elysia().use(rateLimitHook(account, {
    budgets: rateLimitBudgets(), options: { secret: 'g580-counter-secret-at-least-32-characters',
      trustedProxyPeers: new Set(), serviceClientIds: new Set(), clientIpHeader: 'x-forwarded-for' },
    store: { async classify() { return 'member'; }, async consume() {
      counters++; return { allowed: !limited, retryAfter: 17 };
    } },
  })).post('/v1/works', { body: t.Object({ actingSubject: t.String(), value: t.Optional(t.Nullable(t.String())) },
    { additionalProperties: false }) }, async ({ request, body }) => {
    await account.verify(request);
    const key = request.headers.get('idempotency-key')!;
    let result = effectsByKey.get(key);
    if (!result) { result = { receipt: `receipt-${++effects}`, ...body }; effectsByKey.set(key, result); }
    return Response.json(result, { status: 201 });
  }).get('/v1/undeclared', () => 'not a tool');
  app.use(mcpRoutes({ account, mcp: { issuer: 'https://account.test/api/auth', resource: 'http://localhost' } },
    request => app.handle(request), () => fixture));
  const discover = await app.handle(rpc('server/discover'));
  expect(discover.status).toBe(200);
  expect(await discover.json()).toMatchObject({ result: { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } } });
  const listed = await app.handle(rpc('tools/list'));
  expect(await listed.json()).toMatchObject({ result: { tools: [{ name: 'fixture_write' }] } });
  expect(counters).toBe(0);
  const args = { headers: { 'Idempotency-Key': 'same-key' }, body: { actingSubject: 'chosen-agent', value: null } };
  const first = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: args }));
  const retry = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: args }));
  expect(await first.json()).toEqual(await retry.json());
  expect(effects).toBe(1); expect(counters).toBe(2);
  const undeclared = await app.handle(rpc('tools/call', { name: 'undeclared' }));
  expect(await undeclared.json()).toMatchObject({ error: { code: -32602 } });
  expect(effects).toBe(1);
  const forged = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: { ...args, authorization: 'other' } }));
  expect(await forged.json()).toMatchObject({ error: { code: -32602 } });
  const invalid = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: { ...args, body: { actingSubject: 42 } } }));
  expect(await invalid.json()).toMatchObject({ result: { isError: true, structuredContent: { status: 422 } } });
  limited = true;
  const direct = await app.handle(new Request('http://localhost/v1/works', { method: 'POST',
    headers: { authorization: 'Bearer reader', 'content-type': 'application/json', 'idempotency-key': 'limited' }, body: JSON.stringify(args.body) }));
  const denied = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: args }));
  expect(await denied.json()).toMatchObject({ result: { isError: true, structuredContent: {
    status: direct.status, body: await direct.json(), headers: { 'retry-after': '17' } } } });
  revoked = true;
  const expired = await app.handle(rpc('tools/call', { name: 'fixture_write', arguments: args }));
  expect(expired.status).toBe(401);
  expect(expired.headers.get('www-authenticate')).toContain('resource_metadata=');
  expect(expired.headers.get('www-authenticate')).toContain('scope="work:create"');
  expect(effects).toBe(1);
});

test('G-580: protected-resource discovery, Origin and request byte limits apply before transport dispatch', async () => {
  const account = { async verify() { return { issuer: 'account', subject: 'person' }; } };
  const app = new Elysia().use(mcpRoutes({ account, mcp: { issuer: 'https://account.test/api/auth',
    resource: 'https://main.test' } }, async () => { throw new Error('unexpected dispatch'); }, () => fixture));
  const metadata = await app.handle(new Request('http://localhost/.well-known/oauth-protected-resource/mcp'));
  expect(await metadata.json()).toEqual({ resource: 'https://main.test', authorization_servers: ['https://account.test/api/auth'],
    scopes_supported: ['work:create'], bearer_methods_supported: ['header'] });
  const hostile = rpc('tools/list'); hostile.headers.set('origin', 'https://hostile.test');
  expect((await app.handle(hostile)).status).toBe(403);
  const huge = new Request('http://localhost/mcp', { method: 'POST', body: 'x'.repeat(MCP_COST.maxRequestBytes + 1) });
  expect((await app.handle(huge)).status).toBe(413);
});

test('G-580: a stalled or oversized chunked upload cannot outlive the transport cost contract', async () => {
  let cancelled = false;
  const stalled = new Request('http://localhost/mcp', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([123])); }, cancel() { cancelled = true; },
  }) });
  expect((await mcpBody(stalled, 5) as Response).status).toBe(408);
  expect(cancelled).toBe(true);
  const chunked = new Request('http://localhost/mcp', { method: 'POST', body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MCP_COST.maxRequestBytes + 1)); controller.close(); },
  }) });
  expect((await mcpBody(chunked) as Response).status).toBe(413);
});
