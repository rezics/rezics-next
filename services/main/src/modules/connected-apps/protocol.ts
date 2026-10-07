import { lookup as resolveHost } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { canonicalJson, isObject, sha256, validateInputSchema } from './json.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_MAX_PAGE_BYTES = 1_048_576;
export const MCP_MAX_PAGES = 64;
export const MCP_MAX_TOOLS = 1024;
/** Discovery facts are kept with every observation, so a server cannot make them large. */
export const MCP_MAX_SERVER_INFO_BYTES = 4_096;
export const MCP_MAX_CAPABILITIES_BYTES = 16_384;
const HTTP_TIMEOUT_MS = 3_000;
const HTTP_MAX_REQUEST_BYTES = 262_144;

export class McpProtocolError extends Error {
  constructor(message: string, readonly protocolError?: Record<string, unknown>) { super(message); }
}

export class McpHttpError extends Error {
  constructor(readonly status: number) { super(`MCP server returned HTTP ${status}`); }
}

export class McpCancelled extends Error {
  constructor(readonly notificationSent: boolean) { super('MCP invocation was cancelled'); }
}

export interface McpHttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

export interface McpTransportRequest {
  method: 'POST';
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
}

/** Injectable transport lets integration QA use a real loopback server. */
export interface McpTransport {
  send(endpoint: string, request: McpTransportRequest): Promise<McpHttpResponse>;
}

/**
 * Production Streamable HTTP transport. It resolves every destination, rejects
 * special/private ranges and pins the socket lookup to the validated address.
 * Redirects are never followed, avoiding credential forwarding to a new origin.
 */
export class SafeMcpTransport implements McpTransport {
  private readonly resolve: (host: string) => Promise<Array<{ address: string; family: number }>>;
  private readonly request: typeof httpsRequest;

  constructor(network: {
    resolve?: (host: string) => Promise<Array<{ address: string; family: number }>>;
    request?: typeof httpsRequest;
  } = {}) {
    this.resolve = network.resolve ?? (host => resolveHost(host, { all: true, verbatim: true }));
    this.request = network.request ?? httpsRequest;
  }

  async send(endpoint: string, request: McpTransportRequest): Promise<McpHttpResponse> {
    const url = parseEndpoint(endpoint);
    if (url.protocol !== 'https:') throw new McpProtocolError('MCP endpoints must use HTTPS');
    const host = unbracket(url.hostname);
    const addresses = await resolveAddresses(host, this.resolve, request.signal);
    if (addresses.length === 0 || addresses.some(address => !isPublicAddress(address.address))) {
      throw new McpProtocolError('MCP endpoint resolves to a non-public address');
    }
    const address = addresses[0]!;
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (options && typeof options === 'object' && 'all' in options && options.all) {
        callback(null, [address]);
      } else callback(null, address.address, address.family);
    };
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const body = request.body ?? Buffer.alloc(0);
    if (body.byteLength > HTTP_MAX_REQUEST_BYTES) throw new McpProtocolError('MCP request exceeds the byte limit');
    const headers = { accept: 'application/json, text/event-stream', ...request.headers,
      'content-length': String(body.byteLength) };
    return new Promise((resolve, reject) => {
      const outgoing = this.request(url, { method: request.method, headers, signal, lookup: pinnedLookup,
        agent: false, maxHeaderSize: 16_384 }, (incoming: IncomingMessage) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) responseHeaders.set(key, value.join(', '));
          else if (value !== undefined) responseHeaders.set(key, value);
        }
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on('data', (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          length += bytes.byteLength;
          if (length > MCP_MAX_PAGE_BYTES) {
            incoming.destroy(new McpProtocolError('MCP response exceeds the byte limit'));
            return;
          }
          chunks.push(bytes);
        });
        incoming.on('error', reject);
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 502,
          headers: responseHeaders, body: Buffer.concat(chunks, length) }));
      });
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  }
}

export interface ObservedTool {
  name: string;
  definition: Record<string, unknown>;
  definitionJcsSha256: string;
  schemaValidation: 'valid' | 'invalid' | 'unsupported';
  pageNumber: number;
}

export interface ObservedPage {
  pageNumber: number;
  requestCursor: string | null;
  nextCursor: string | null;
  responseBytes: Buffer;
}

export interface McpSnapshot {
  protocolVersion: string;
  serverInfo: Record<string, unknown>;
  capabilities: Record<string, unknown>;
  snapshotSha256: string;
  pages: ObservedPage[];
  tools: ObservedTool[];
}

export interface McpToolResult {
  result: Record<string, unknown>;
  responseSha256: string;
}

/** Bounded stateless 2026-07-28 MCP client: discover, list with cursors, call and cancel. */
export class McpProtocolClient {
  private requestCount = 0;
  private readonly clientMeta = {
    'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'rezics-connected-apps', version: '1' },
  };

  constructor(private readonly transport: McpTransport, private readonly endpoint: string,
    private readonly bearerToken?: string) {}

  async observe(signal?: AbortSignal): Promise<McpSnapshot> {
    const discovered = await this.discover(signal);
    const pages: ObservedPage[] = [];
      const tools: ObservedTool[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let totalBytes = 0;
      for (let pageNumber = 1; pageNumber <= MCP_MAX_PAGES; pageNumber++) {
        const params = cursor === null ? {} : { cursor };
        const response = await this.request('tools/list', params, signal);
        totalBytes += response.bytes.byteLength;
        if (totalBytes > MCP_MAX_PAGES * MCP_MAX_PAGE_BYTES) {
          throw new McpProtocolError('MCP tool inventory exceeds the byte limit');
        }
        const result = response.envelope.result;
        if (!isObject(result) || !Array.isArray(result.tools)) {
          throw new McpProtocolError('MCP tools/list result is malformed');
        }
        const next = result.nextCursor;
        if (next !== undefined && (typeof next !== 'string' || next.length < 1 || next.length > 1024)) {
          throw new McpProtocolError('MCP tools/list cursor is invalid');
        }
        const nextCursor = typeof next === 'string' ? next : null;
        if (nextCursor !== null && (cursors.has(nextCursor) || nextCursor === cursor)) {
          throw new McpProtocolError('MCP tools/list cursor repeated');
        }
        if (nextCursor !== null) cursors.add(nextCursor);
        pages.push({ pageNumber, requestCursor: cursor, nextCursor, responseBytes: response.bytes });
        for (const candidate of result.tools) {
          if (!isObject(candidate) || typeof candidate.name !== 'string' || !isObject(candidate.inputSchema)) {
            throw new McpProtocolError('MCP tool definition is malformed');
          }
          const name = candidate.name;
          if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name) || names.has(name)) {
            throw new McpProtocolError('MCP tool name is invalid or duplicated');
          }
          names.add(name);
          const canonical = canonicalJson(candidate);
          if (Buffer.byteLength(canonical) > 262_144) throw new McpProtocolError('MCP tool definition exceeds the byte limit');
          tools.push({ name, definition: candidate, definitionJcsSha256: sha256(canonical),
            schemaValidation: validateInputSchema(candidate.inputSchema), pageNumber });
          if (tools.length > MCP_MAX_TOOLS) throw new McpProtocolError('MCP tool count exceeds the limit');
        }
        if (nextCursor === null) break;
        cursor = nextCursor;
        if (pageNumber === MCP_MAX_PAGES) throw new McpProtocolError('MCP tool pagination exceeds the page limit');
      }
      const canonicalTools = [...tools].sort((left, right) => left.name < right.name ? -1 : 1)
        .map(tool => tool.definition);
      // The composite snapshot digest also detects capability/version changes;
      // per-tool digests remain over the exact RFC 8785 canonical definition.
      const snapshotSha256 = sha256(canonicalJson({ protocolVersion: discovered.protocolVersion,
        serverInfo: discovered.serverInfo, capabilities: discovered.capabilities, tools: canonicalTools }));
    return { protocolVersion: discovered.protocolVersion, serverInfo: discovered.serverInfo,
      capabilities: discovered.capabilities, snapshotSha256, pages, tools };
  }

  async callTool(name: string, arguments_: Record<string, unknown>, signal: AbortSignal,
    onCancelRequested: () => Promise<void>): Promise<McpToolResult> {
    const id = randomUUID();
    if (signal.aborted) throw new McpCancelled(false);
    const controller = new AbortController();
    let callStarted = false;
    let finished = false;
    let cancellation: Promise<void> | null = null;
    const cancel = () => {
      if (finished || !callStarted || cancellation) return;
      cancellation = (async () => {
        try {
          await onCancelRequested();
        } catch { /* durable cancellation receipt still fences retries */ }
        // In the stateless HTTP protocol, cancelling means closing the active
        // response stream. There is no per-session cancellation notification.
        controller.abort();
      })();
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      callStarted = true;
      const response = await this.request('tools/call', { name, arguments: arguments_ }, controller.signal, id);
      finished = true;
      return { result: response.envelope.result as Record<string, unknown>, responseSha256: sha256(response.bytes) };
    } catch (error) {
      finished = true;
      if (signal.aborted) throw new McpCancelled(false);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancellation;
    }
  }

  private async discover(signal?: AbortSignal): Promise<{ protocolVersion: string;
    serverInfo: Record<string, unknown>; capabilities: Record<string, unknown> }> {
    const response = await this.request('server/discover', {}, signal);
    const result = response.envelope.result;
    if (!isObject(result) || !Array.isArray(result.supportedVersions)
      || !result.supportedVersions.includes(MCP_PROTOCOL_VERSION) || !isObject(result.capabilities)) {
      throw new McpProtocolError('MCP server/discover result is unsupported or malformed');
    }
    const serverInfoMeta = isObject(result._meta)
      ? result._meta['io.modelcontextprotocol/serverInfo'] : undefined;
    const serverInfo = isObject(serverInfoMeta) ? serverInfoMeta : {};
    if (Buffer.byteLength(canonicalJson(serverInfo)) > MCP_MAX_SERVER_INFO_BYTES
      || Buffer.byteLength(canonicalJson(result.capabilities)) > MCP_MAX_CAPABILITIES_BYTES) {
      throw new McpProtocolError('MCP server/discover server info or capabilities exceed their bounds');
    }
    return { protocolVersion: MCP_PROTOCOL_VERSION, serverInfo, capabilities: result.capabilities };
  }

  private async request(method: string, params: Record<string, unknown>, signal?: AbortSignal,
    id = `${++this.requestCount}`): Promise<{ envelope: Record<string, unknown>;
      bytes: Buffer; headers: Headers }> {
    const requestId = id;
    const requestParams = { ...params, _meta: this.clientMeta };
    const payload = Buffer.from(canonicalJson({ jsonrpc: '2.0', id: requestId, method, params: requestParams }));
    const response = await this.send(method, payload, signal,
      method === 'tools/call' && typeof params.name === 'string' ? params.name : undefined);
    if (response.status !== 200 && response.status !== 400) throw new McpHttpError(response.status);
    const envelope = parseResponse(response, requestId);
    if (isObject(envelope.error)) {
      const protocolError = envelope.error;
      if (typeof protocolError.code !== 'number' || typeof protocolError.message !== 'string') {
        throw new McpProtocolError('MCP server returned a malformed JSON-RPC error');
      }
      throw new McpProtocolError('MCP server returned a JSON-RPC error', protocolError);
    }
    if (!Object.hasOwn(envelope, 'result')) throw new McpProtocolError('MCP response omitted result');
    if (!isObject(envelope.result) || envelope.result.resultType !== 'complete') {
      throw new McpProtocolError('MCP response is not a complete result');
    }
    return { envelope, bytes: response.body, headers: response.headers };
  }

  private async send(method: string, body: Buffer, signal?: AbortSignal, name?: string): Promise<McpHttpResponse> {
    if (signal?.aborted) throw new McpCancelled(false);
    const headers: Record<string, string> = { 'content-type': 'application/json',
      'mcp-protocol-version': MCP_PROTOCOL_VERSION, 'mcp-method': method };
    if (name) headers['mcp-name'] = name;
    if (this.bearerToken) headers.authorization = `Bearer ${this.bearerToken}`;
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    return this.transport.send(this.endpoint, { method: 'POST', headers, body, signal: requestSignal });
  }
}

function parseResponse(response: McpHttpResponse, expectedId: string): Record<string, unknown> {
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  let value: unknown;
  try {
    if (type === 'application/json') value = JSON.parse(response.body.toString('utf8')) as unknown;
    else if (type === 'text/event-stream') value = parseSse(response.body.toString('utf8'), expectedId);
    else throw new McpProtocolError('MCP response media type is unsupported');
  } catch (error) {
    if (error instanceof McpProtocolError) throw error;
    throw new McpProtocolError('MCP response is not valid JSON');
  }
  if (!isObject(value) || value.jsonrpc !== '2.0' || value.id !== expectedId) {
    throw new McpProtocolError('MCP response id or envelope is invalid');
  }
  return value;
}

function parseSse(body: string, expectedId: string): unknown {
  let candidate = '';
  const events = body.split(/\r?\n\r?\n/);
  for (const event of events) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (isObject(parsed) && parsed.id === expectedId) candidate = data;
    } catch { throw new McpProtocolError('MCP SSE event contains invalid JSON'); }
  }
  if (!candidate) throw new McpProtocolError('MCP SSE stream omitted the JSON-RPC response');
  return JSON.parse(candidate) as unknown;
}

function parseEndpoint(value: string): URL {
  if (typeof value !== 'string' || value.length > 2048) throw new McpProtocolError('MCP endpoint is invalid');
  let url: URL;
  try { url = new URL(value); } catch { throw new McpProtocolError('MCP endpoint is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
    || url.search || !url.hostname) throw new McpProtocolError('MCP endpoint is invalid');
  return url;
}

export function validateEndpoint(value: string): URL {
  return parseEndpoint(value);
}

async function resolveAddresses(host: string,
  resolver: (host: string) => Promise<Array<{ address: string; family: number }>>,
  signal?: AbortSignal): Promise<Array<{ address: string; family: number }>> {
  if (signal?.aborted) throw new McpCancelled(false);
  const family = isIP(host);
  if (family) return [{ address: host, family }];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new McpProtocolError('MCP DNS lookup timed out')), HTTP_TIMEOUT_MS);
    const abort = () => finish(new McpCancelled(false));
    const finish = (error?: Error, addresses?: Array<{ address: string; family: number }>) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(addresses ?? []);
    };
    signal?.addEventListener('abort', abort, { once: true });
    resolver(host).then(
      addresses => finish(undefined, addresses), error => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

function unbracket(host: string): string { return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host; }

const nonPublic = new BlockList();
// Match SafeSnapshotTransport's conservative policy, including whole special
// blocks with public exceptions. Numeric checks cover every address spelling.
// https://www.iana.org/assignments/iana-ipv4-special-registry (2025-10-09)
// Reverified with the IPv6 registry on 2026-10-07.
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) nonPublic.addSubnet(address, prefix, 'ipv4');

const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
// Refuse protocol/transition and documentation assignments inside global
// unicast; mapped, translated, private and scoped addresses stay outside it.
// https://www.iana.org/assignments/iana-ipv6-special-registry (2025-10-09)
for (const [address, prefix] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) nonPublic.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) return !nonPublic.check(value, 'ipv4');
  return family === 6 && !value.includes('%')
    && globalV6.check(value, 'ipv6') && !nonPublic.check(value, 'ipv6');
}
