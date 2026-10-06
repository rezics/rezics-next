import { readFileSync } from 'node:fs';
import { Elysia } from 'elysia';
import { createMcpHandler, Server, ProtocolError, ProtocolErrorCode, type Tool } from '@modelcontextprotocol/server';
import { AccountAssertionDenied } from '../modules/account/verify-assertion.ts';
import { operationTools, type CapabilityDeclarations, type CapabilityDocument } from '../modules/mcp/capabilities.ts';
import { dispatchTool, type HttpDispatch } from '../modules/mcp/dispatch.ts';
import { mcpBody } from '../modules/mcp/body.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { anonymousPlatformAccess, exposureAllows } from '../modules/access/exposure.ts';
import { exposureOperationId } from '../modules/access/exposure-routes.ts';

/** Initial toolkit bindings live here while their route owners are concurrently claimed.
 * Discovery still checks the operation exists and uses its generated runtime schema. */
export const capabilities = {
  '/v1/resources/{resource}': { get: { disposition: 'supported', mcp: { tool: 'read_resource',
    scopes: ['work:read', 'context:read'],
    title: 'Read a resource', description: 'Read a resource summary and available content with current disclosure. Supply the selected actingSubject for authenticated reads.' } } },
  '/v1/resources/summaries': { post: { disposition: 'supported', mcp: { tool: 'resource_summaries',
    scopes: ['work:read', 'context:read'],
    title: 'Read resource summaries', description: 'Read a bounded batch of resource summaries. Each item reports available or unavailable with current disclosure and its generation.' } } },
  '/v1/resources/{resource}/relations': { get: { disposition: 'supported', mcp: { tool: 'resource_relations',
    scopes: ['work:read'],
    title: 'Read resource relations', description: 'Read visible resource relations, exact revisions and evidence. Continue with the returned cursor and preserve the reading position.' } } },
  '/v1/works/{id}/releases': { get: { disposition: 'supported', mcp: { tool: 'work_editions',
    scopes: ['work:read'],
    title: 'Read editions of a Work', description: 'Read releases and editions of a Work, their identifiers, languages and coverage. Continue with the returned cursor.' } } },
} as const satisfies CapabilityDeclarations;

export interface McpConfig { issuer: string; resource: string }

const installedContract = () => JSON.parse(readFileSync(new URL('../../../../generated/openapi/main/public.json',
  import.meta.url), 'utf8')) as CapabilityDocument;

export function mcpRoutes(work: Pick<MainWorkDependencies, 'account' | 'mcp' | 'platformAccess'>, dispatch: HttpDispatch,
  contract: () => CapabilityDocument = installedContract) {
  const config = work.mcp;
  if (!config) return new Elysia();
  const metadataURL = new URL('/.well-known/oauth-protected-resource/mcp', config.resource).href;
  let inventory: ReturnType<typeof operationTools> | undefined;
  const tools = () => inventory ??= operationTools(contract());
  const scopes = () => [...new Set(tools().flatMap(tool => tool.operation['x-rezics-capability']!.mcp!.scopes))].sort();
  const challenge = () => `Bearer resource_metadata="${metadataURL}", scope="${scopes().join(' ')}"`;
  const metadata = () => Response.json({ resource: config.resource, authorization_servers: [config.issuer],
    scopes_supported: scopes(), bearer_methods_supported: ['header'] }, { headers: { 'cache-control': 'no-store' } });
  const handler = createMcpHandler(({ requestInfo }) => {
    const server = new Server({ name: 'rezics', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', async ({ params }) => {
      if (params?.cursor) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool inventory has no continuation');
      const principal = await work.account.verify(requestInfo!, []);
      const viewer = work.platformAccess ? await work.platformAccess.summary(principal) : anonymousPlatformAccess();
      return { tools: tools().filter(tool => exposureAllows(tool.operation['x-rezics-exposure'],
        tool.operation.operationId ?? exposureOperationId(tool.method, tool.path), viewer))
        .map(({ name, title, description, inputSchema }) =>
        ({ name, title, description, inputSchema: inputSchema as Tool['inputSchema'] })) };
    });
    server.setRequestHandler('tools/call', async ({ params }) => {
      const tool = tools().find(candidate => candidate.name === params.name);
      if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Tool is not declared');
      return dispatchTool(tool, params.arguments ?? {}, requestInfo!, dispatch);
    });
    return server;
  }, { legacy: 'stateless', maxSubscriptions: 0 });
  return new Elysia({ name: 'main-mcp' })
    // Transport messages have no domain rate family. Early interception leaves
    // the one in-process operation subject to the installed G-543 hook exactly once.
    .request(async function handleMcp({ request }) {
      const path = new URL(request.url).pathname;
      if (path === '/.well-known/oauth-protected-resource/mcp'
        || path === '/.well-known/oauth-protected-resource') return metadata();
      if (path !== '/mcp') return;
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(config.resource).origin) {
        return new Response(null, { status: 403 });
      }
      try { await work.account.verify(request, []); }
      catch (error) {
        const status = error instanceof AccountAssertionDenied ? 401 : 503;
        return Response.json({ type: 'about:blank', status, code: status === 401
          ? 'invalid_account_assertion' : 'account_unavailable', title: 'Account authorization unavailable' },
        { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store',
          ...(status === 401 ? { 'www-authenticate': challenge() } : { 'retry-after': '5' }) } });
      }
      const body = await mcpBody(request);
      if (body instanceof Response) return body;
      return handler.fetch(new Request(request, { ...(body ? { body: new Uint8Array(body) } : {}) }));
    })
    .cleanup(() => handler.close())
    .all('/mcp', { parse: 'none', detail: { hide: true } }, () => new Response(null, { status: 405 }))
    .get('/.well-known/oauth-protected-resource/mcp', { detail: { hide: true } }, metadata)
    .get('/.well-known/oauth-protected-resource', { detail: { hide: true } }, metadata);
}

export const openApiOperations = {
  '/.well-known/oauth-protected-resource': { get: { exposure: 'public' } },
  '/.well-known/oauth-protected-resource/mcp': { get: { exposure: 'public' } },
  '/mcp': { all: { exposure: 'public' } },
} as const;
