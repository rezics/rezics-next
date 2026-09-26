import { MCP_PROTOCOL_VERSION } from '../../../services/main/src/modules/connected-apps/protocol.ts';

interface RpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface ControlledMcpCall {
  name: string;
  arguments: Record<string, unknown>;
  authorization: string | null;
  protocolVersion: string | null;
  methodHeader: string | null;
  nameHeader: string | null;
}

export interface ControlledMcpServer {
  endpoint: string;
  resource: string;
  methods: string[];
  calls: ControlledMcpCall[];
  cancellations: string[];
  invalidHeaders: string[];
  setSchemaRevision(revision: number): void;
  setCapabilityRevision(revision: number): void;
  setCallMode(mode: 'normal' | 'rpc-error' | 'http-error'): void;
  reset(): void;
  waitForCalls(count: number): Promise<void>;
  stop(): Promise<void>;
}

/** Real loopback Streamable HTTP peer with deterministic pagination and failures. */
export function startControlledMcpServer(): ControlledMcpServer {
  let schemaRevision = 1;
  let capabilityRevision = 0;
  let callMode: 'normal' | 'rpc-error' | 'http-error' = 'normal';
  const methods: string[] = [];
  const calls: ControlledMcpCall[] = [];
  const cancellations: string[] = [];
  const invalidHeaders: string[] = [];
  const waiters = new Set<{ count: number; resolve: () => void }>();

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    let rpc: RpcRequest;
    try { rpc = await request.json() as RpcRequest; }
    catch { return new Response(null, { status: 400 }); }
    methods.push(rpc.method);
    const headers = request.headers;
    if (headers.get('mcp-protocol-version') !== MCP_PROTOCOL_VERSION) invalidHeaders.push('protocol-version');
    if (headers.get('mcp-method') !== rpc.method) invalidHeaders.push('method');
    if (headers.has('mcp-session-id')) invalidHeaders.push('session');
    const params = rpc.params ?? {};
    const meta = params._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)
      || (meta as Record<string, unknown>)['io.modelcontextprotocol/protocolVersion'] !== MCP_PROTOCOL_VERSION
      || !Object.hasOwn(meta as Record<string, unknown>, 'io.modelcontextprotocol/clientCapabilities')
      || !Object.hasOwn(meta as Record<string, unknown>, 'io.modelcontextprotocol/clientInfo')) {
      invalidHeaders.push('request-meta');
    }
    if (rpc.method !== 'tools/call' && headers.has('mcp-name')) invalidHeaders.push('unexpected-name');

    if (rpc.method === 'server/discover') {
      return rpcResponse(rpc, { supportedVersions: [MCP_PROTOCOL_VERSION],
        capabilities: { tools: { listChanged: capabilityRevision % 2 === 1 } },
        ttlMs: 0, cacheScope: 'private' }, { name: 'controlled-mcp', version: '1' });
    }
    if (rpc.method === 'tools/list') {
      const cursor = params.cursor;
      const page = cursor === undefined ? 1 : cursor === 'page-2' ? 2 : cursor === 'page-3' ? 3 : 0;
      if (page === 0) return rpcError(rpc, -32602, 'invalid cursor');
      const tool = toolFor(page, schemaRevision);
      const nextCursor = page < 3 ? `page-${page + 1}` : undefined;
      return rpcResponse(rpc, { tools: [tool], ...(nextCursor ? { nextCursor } : {}) });
    }
    if (rpc.method === 'tools/call') {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments as Record<string, unknown> : {};
      if (headers.get('mcp-name') !== name) invalidHeaders.push('name');
      calls.push({ name, arguments: args, authorization: headers.get('authorization'),
        protocolVersion: headers.get('mcp-protocol-version'), methodHeader: headers.get('mcp-method'),
        nameHeader: headers.get('mcp-name') });
      for (const waiter of waiters) if (calls.length >= waiter.count) waiter.resolve();
      if (callMode === 'rpc-error') return rpcError(rpc, -32001, 'controlled remote rejection', 400);
      if (callMode === 'http-error') return new Response('upstream failure', { status: 500 });
      if (name === 'reject') return rpcResponse(rpc,
        { content: [{ type: 'text', text: 'The controlled tool rejected this input.' }], isError: true });
      if (name === 'slow') {
        const cancelled = await waitForAbort(request.signal, 4_000);
        if (cancelled) cancellations.push(name);
        return rpcResponse(rpc, { content: [{ type: 'text', text: cancelled ? 'cancelled' : 'timeout' }] });
      }
      return rpcResponse(rpc, { content: [{ type: 'text', text: String(args.text ?? '') }],
        structuredContent: { text: String(args.text ?? '') } });
    }
    return rpcError(rpc, -32601, 'method not found');
  } });

  return {
    endpoint: `${server.url.origin}/mcp`,
    resource: server.url.origin,
    methods,
    calls,
    cancellations,
    invalidHeaders,
    setSchemaRevision(revision) { schemaRevision = revision; },
    setCapabilityRevision(revision) { capabilityRevision = revision; },
    setCallMode(mode) { callMode = mode; },
    reset() {
      schemaRevision = 1;
      capabilityRevision = 0;
      callMode = 'normal';
      methods.length = 0;
      calls.length = 0;
      cancellations.length = 0;
      invalidHeaders.length = 0;
    },
    async waitForCalls(count) {
      if (calls.length >= count) return;
      await new Promise<void>(resolve => {
        const waiter = { count, resolve: () => { waiters.delete(waiter); resolve(); } };
        waiters.add(waiter);
      });
    },
    async stop() { await server.stop(true); },
  };
}

function toolFor(page: number, revision: number): Record<string, unknown> {
  const name = ['echo', 'reject', 'slow'][page - 1]!;
  const minimum = name === 'echo' && revision > 1 ? 2 : 0;
  return { name, description: `Controlled ${name} tool; schema revision ${revision}.`,
    inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: minimum } },
      required: ['text'], additionalProperties: false } };
}

function rpcResponse(rpc: RpcRequest, result: Record<string, unknown>, serverInfo?: Record<string, unknown>): Response {
  return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete', ...result,
    ...(serverInfo ? { _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } } : {}) } });
}

function rpcError(rpc: RpcRequest, code: number, message: string, status = 200): Response {
  return Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code, message } }, { status });
}

async function waitForAbort(signal: AbortSignal, timeoutMs: number): Promise<boolean> {
  if (signal.aborted) return true;
  return new Promise(resolve => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onAbort = () => finish(true);
    const finish = (aborted: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve(aborted);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
