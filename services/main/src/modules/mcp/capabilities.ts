/** Route-owned declarations. The disposition gate for every route is a later slice. */
export interface Capability {
  disposition: 'supported' | 'internal' | 'deferred';
  reason?: string;
  mcp?: { tool: string; title: string; description: string; scopes: readonly string[] };
}

export interface HttpOperation {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Record<string, unknown>;
    style?: string; explode?: boolean }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Record<string, unknown> }> };
  'x-rezics-capability'?: Capability;
}

export interface CapabilityDocument {
  paths?: Record<string, Record<string, HttpOperation>>;
}

export type CapabilityDeclarations = Record<string, Record<string, Capability>>;

export function attachCapabilities(document: CapabilityDocument, declarations: CapabilityDeclarations, owner: string) {
  for (const [path, methods] of Object.entries(declarations)) {
    for (const [method, capability] of Object.entries(methods)) {
      const operation = document.paths?.[path]?.[method];
      if (!operation) throw new Error(`${owner} declares a missing OpenAPI operation: ${method} ${path}`);
      if (!['supported', 'internal', 'deferred'].includes(capability.disposition)
        || (capability.disposition !== 'supported' && (!capability.reason || capability.mcp))) {
        throw new Error(`${owner} declares an invalid capability: ${method} ${path}`);
      }
      if (operation['x-rezics-capability']) throw new Error(`Duplicate capability: ${method} ${path}`);
      operation['x-rezics-capability'] = capability;
    }
  }
}

export const MCP_COST = Object.freeze({ maxTools: 128, maxInventoryBytes: 1_048_576,
  maxRequestBytes: 1_048_576, deadlineMs: 30_000 });

export interface OperationTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
  method: string;
  path: string;
  operation: HttpOperation;
}

/** Groups preserve identically named path/query/body fields, omission and JSON unions. */
export function operationTools(document: CapabilityDocument): OperationTool[] {
  const tools: OperationTool[] = [];
  const names = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(methods)) {
      const declaration = operation['x-rezics-capability']?.mcp;
      if (!declaration) continue;
      if (!Array.isArray(declaration.scopes) || declaration.scopes.some(scope =>
        typeof scope !== 'string' || !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
        || new Set(declaration.scopes).size !== declaration.scopes.length) {
        throw new Error(`MCP tool requires explicit OAuth scopes: ${method} ${path}`);
      }
      if (operation['x-rezics-capability']?.disposition !== 'supported'
        || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(declaration.tool)
        || !declaration.title || !declaration.description || names.has(declaration.tool)) {
        throw new Error(`Invalid or duplicate MCP tool: ${method} ${path}`);
      }
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [location, group] of [['path', 'path'], ['query', 'query'], ['header', 'headers']] as const) {
        const parameters = (operation.parameters ?? []).filter(parameter => parameter.in === location);
        if (!parameters.length) continue;
        if (parameters.some(parameter => !parameter.schema || (location === 'header'
          && parameter.name.toLowerCase() !== 'idempotency-key'))) {
          throw new Error(`Unsupported MCP parameter: ${method} ${path}`);
        }
        const fields = parameters.filter(parameter => parameter.required).map(parameter => parameter.name);
        properties[group] = { type: 'object', properties: Object.fromEntries(parameters.map(parameter =>
          [parameter.name, parameter.schema])), required: fields, additionalProperties: false };
        if (fields.length) required.push(group);
      }
      if (operation.requestBody) {
        const schema = operation.requestBody.content?.['application/json']?.schema;
        if (!schema) throw new Error(`MCP requires a JSON body: ${method} ${path}`);
        properties.body = schema;
        if (operation.requestBody.required) required.push('body');
      }
      names.add(declaration.tool);
      tools.push({ name: declaration.tool, title: declaration.title, description: declaration.description,
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        method: method.toUpperCase(), path, operation });
    }
  }
  tools.sort((left, right) => left.name.localeCompare(right.name));
  if (tools.length > MCP_COST.maxTools || Buffer.byteLength(JSON.stringify(tools)) > MCP_COST.maxInventoryBytes) {
    throw new Error('Declared MCP inventory exceeds its cost contract');
  }
  return tools;
}
