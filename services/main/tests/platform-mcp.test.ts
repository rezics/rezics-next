import { expect, test } from 'bun:test';
import { Elysia } from 'elysia';
import { mcpRoutes } from '../src/routes/mcp.ts';
import type { CapabilityDocument } from '../src/modules/mcp/capabilities.ts';
import { bindPlatformExposure } from '../src/modules/access/exposure-routes.ts';
import {
  exposureAllows,
  PlatformClosed,
  type AccessExposure,
} from '../src/modules/access/exposure.ts';

const rpc = (method: string, params: Record<string, unknown> = {}) =>
  new Request('http://main.test/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer reader',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(params.name ? { 'mcp-name': String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'platform-test', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });

test('MCP tools/list follows grant changes and guessed closed tools/call still uses the HTTP gate', async () => {
  let groups: string[] = [],
    effects = 0;
  const principal = { issuer: 'https://account.test', subject: 'reader' };
  const platformAccess = {
    summary: async () => ({ groups, operations: [], generation: groups.join(':') }),
    require: async (
      _principal: unknown,
      exposure: Parameters<typeof exposureAllows>[0],
      id: string,
    ) => {
      if (!exposureAllows(exposure, id, { groups, operations: [], generation: '' }))
        throw new PlatformClosed();
    },
  } as unknown as AccessExposure;
  const account = { verify: async () => principal };
  const contract: CapabilityDocument = {
    paths: {
      '/v1/saved': {
        get: {
          operationId: 'getV1Saved',
          'x-rezics-exposure': 'platform:saved-views',
          'x-rezics-capability': {
            disposition: 'supported',
            mcp: {
              tool: 'saved',
              title: 'Saved views',
              description: 'Read saved views',
              scopes: ['follow:read'],
            },
          },
        },
      },
    },
  };
  const app = new Elysia().get('/v1/saved', () => {
    effects++;
    return {};
  });
  app
    .use(
      mcpRoutes(
        {
          account,
          platformAccess,
          mcp: { issuer: 'https://account.test', resource: 'http://main.test/mcp' },
        },
        (request) => app.handle(request),
        () => contract,
      ),
    )
    .use(
      bindPlatformExposure({ account, platformAccess }, [
        {
          '/v1/saved': { get: { exposure: 'platform:saved-views' } },
          '/mcp': { all: { exposure: 'public' } },
          '/.well-known/oauth-protected-resource': { get: { exposure: 'public' } },
          '/.well-known/oauth-protected-resource/mcp': { get: { exposure: 'public' } },
        },
      ]),
    );
  expect(await (await app.handle(rpc('tools/list'))).json()).toMatchObject({
    result: { tools: [] },
  });
  const refused = await app.handle(rpc('tools/call', { name: 'saved', arguments: {} }));
  expect(await refused.json()).toMatchObject({
    result: {
      isError: true,
      structuredContent: { status: 403, body: { code: 'platform_closed' } },
    },
  });
  expect(effects).toBe(0);
  groups = ['saved-views'];
  expect(await (await app.handle(rpc('tools/list'))).json()).toMatchObject({
    result: { tools: [{ name: 'saved' }] },
  });
  expect(
    await (await app.handle(rpc('tools/call', { name: 'saved', arguments: {} }))).json(),
  ).toMatchObject({ result: { isError: false } });
  expect(effects).toBe(1);
  groups = [];
  expect(await (await app.handle(rpc('tools/list'))).json()).toMatchObject({
    result: { tools: [] },
  });
});
