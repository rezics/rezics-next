import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';
import { MCP_COST, type OperationTool } from './capabilities.ts';

export type HttpDispatch = (request: Request) => Promise<Response>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** No caller-selected destination, bearer, cookie or infrastructure headers. */
export async function dispatchTool(tool: OperationTool, arguments_: Record<string, unknown>,
  caller: Request, dispatch: HttpDispatch) {
  const invalid = (reason: string) => { throw new ProtocolError(ProtocolErrorCode.InvalidParams,
    `Arguments do not match the declared HTTP operation: ${reason}`); };
  const { properties, required } = tool.inputSchema;
  if (Object.keys(arguments_).some(key => !Object.hasOwn(properties, key))
    || required.some(key => !Object.hasOwn(arguments_, key))) invalid('unknown or missing argument group');
  for (const group of ['path', 'query', 'headers']) {
    if (!Object.hasOwn(arguments_, group)) continue;
    const allowed = (properties[group] as { properties: Record<string, unknown> }).properties;
    const values = arguments_[group];
    if (!object(values) || Object.keys(values).some(key => !Object.hasOwn(allowed, key))) invalid(`invalid ${group} fields`);
  }
  let path = tool.path;
  for (const parameter of tool.operation.parameters ?? []) {
    if (parameter.in !== 'path') continue;
    const value = (arguments_.path as Record<string, unknown> | undefined)?.[parameter.name];
    if (typeof value !== 'string' && typeof value !== 'number') invalid(`invalid path parameter ${parameter.name}`);
    if (String(value) === '.' || String(value) === '..' || String(value).includes('/')) invalid(`invalid path segment ${parameter.name}`);
    path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
  }
  const url = new URL(path, 'http://localhost');
  for (const parameter of tool.operation.parameters ?? []) {
    if (parameter.in !== 'query') continue;
    const value = (arguments_.query as Record<string, unknown> | undefined)?.[parameter.name];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.some(item => !['string', 'number', 'boolean'].includes(typeof item))) invalid(`invalid query array ${parameter.name}`);
      if (parameter.explode === false) url.searchParams.set(parameter.name, value.join(','));
      else for (const item of value) url.searchParams.append(parameter.name, String(item));
    } else {
      if (!['string', 'number', 'boolean'].includes(typeof value)) invalid(`invalid query parameter ${parameter.name}`);
      url.searchParams.set(parameter.name, String(value));
    }
  }
  const headers = new Headers({ authorization: caller.headers.get('authorization')!, accept: 'application/json' });
  // Optional language preferences retain the direct read's presentation semantics.
  for (const name of ['accept-language', 'x-rezics-display-languages']) {
    const value = caller.headers.get(name);
    if (value) headers.set(name, value);
  }
  const argumentKey = (arguments_.headers as Record<string, unknown> | undefined)?.['Idempotency-Key'];
  const requestKey = caller.headers.get('idempotency-key');
  if (argumentKey !== undefined && (typeof argumentKey !== 'string' || (requestKey && requestKey !== argumentKey))) invalid('conflicting or invalid Idempotency-Key');
  const key = argumentKey ?? requestKey;
  if (typeof key === 'string') headers.set('idempotency-key', key);
  const hasBody = Object.hasOwn(arguments_, 'body');
  if (hasBody) headers.set('content-type', 'application/json');
  const response = await dispatch(new Request(url, { method: tool.method, headers,
    signal: AbortSignal.any([caller.signal, AbortSignal.timeout(MCP_COST.deadlineMs)]),
    ...(hasBody ? { body: JSON.stringify(arguments_.body) } : {}) }));
  const text = await response.text();
  let body: unknown = text;
  if (response.headers.get('content-type')?.includes('json') && text) body = JSON.parse(text) as unknown;
  const result = { status: response.status, headers: Object.fromEntries([...response.headers]
    .filter(([name]) => name !== 'set-cookie')), body };
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result,
    isError: response.status >= 400 };
}
