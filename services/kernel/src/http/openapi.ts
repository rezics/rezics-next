import { toOpenAPISchema } from '@elysia/openapi';
import { unwrapSchema } from '@elysia/openapi/openapi';
import type { AnyElysia } from 'elysia/base';
import { customMethodPath } from './custom-method.ts';
import { PROBLEMS, type ProblemCode } from './problem.ts';

const SECURITY_SCHEMES = {
  bearerAuth: { type: 'http', scheme: 'bearer' },
} as const;

const PROBLEM_MEMBERS = ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'] as const;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

type RecordValue = Record<string, unknown>;
type MediaType = RecordValue & { schema?: unknown };
type Response = RecordValue & {
  description?: string;
  content?: Record<string, MediaType>;
};
type Operation = RecordValue & {
  requestBody?: RecordValue & { content?: Record<string, MediaType> };
  responses?: Record<string, Response>;
  security?: Record<string, unknown>[];
};
type OpenApiDocument = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: typeof SECURITY_SCHEMES;
  };
};
type Route = {
  method: string;
  path: string;
  hooks?: {
    body?: unknown;
    detail?: RouteDetail;
  };
};
type RouteDetail = Record<string, unknown> & { responses?: unknown };
type GeneratedDocument = {
  paths?: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, unknown> };
};

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schemaReference(value: RecordValue, schemas: Record<string, unknown>): unknown {
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith('#/components/schemas/')) return undefined;
  const name = value.$ref.slice('#/components/schemas/'.length).replaceAll('~1', '/').replaceAll('~0', '~');
  return schemas[name];
}

function codeValues(
  value: unknown,
  schemas: Record<string, unknown>,
  seen: Set<unknown> = new Set(),
): string[] | undefined {
  if (!isRecord(value) || seen.has(value)) return undefined;
  seen.add(value);

  if (typeof value.$ref === 'string') {
    const referenced = schemaReference(value, schemas);
    return referenced === undefined ? undefined : codeValues(referenced, schemas, seen);
  }
  if (typeof value.const === 'string') return [value.const];
  if (Array.isArray(value.enum)) {
    return value.enum.length > 0 && value.enum.every((code) => typeof code === 'string')
      ? (value.enum as string[])
      : undefined;
  }

  const variants = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined;
  if (!variants?.length) return undefined;
  const values = variants.map((variant) => codeValues(variant, schemas, new Set(seen)));
  return values.every((codes): codes is string[] => codes !== undefined) ? values.flat() : undefined;
}

function problemCodes(
  value: unknown,
  schemas: Record<string, unknown>,
  seen: Set<unknown> = new Set(),
): string[] | undefined {
  if (!isRecord(value) || seen.has(value)) return undefined;
  seen.add(value);

  if (typeof value.$ref === 'string') {
    const referenced = schemaReference(value, schemas);
    return referenced === undefined ? undefined : problemCodes(referenced, schemas, seen);
  }

  const variants = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined;
  if (variants) {
    if (variants.length === 0) return undefined;
    const codes = variants.map((variant) => problemCodes(variant, schemas, new Set(seen)));
    return codes.every((items): items is string[] => items !== undefined) ? codes.flat() : undefined;
  }

  const properties = value.properties;
  if (!isRecord(properties) || !PROBLEM_MEMBERS.every((name) => Object.hasOwn(properties, name))) return undefined;
  return codeValues(properties.code, schemas);
}

/** Checks that a schema has the fixed Problem members and only catalogued codes. */
export function isProblemSchema(value: unknown, schemas: Record<string, unknown> = {}): boolean {
  const codes = problemCodes(value, schemas);
  return codes !== undefined && codes.length > 0 && codes.every((code) => Object.hasOwn(PROBLEMS, code));
}

function titleForCode(code: ProblemCode): string {
  const words = code.replaceAll('_', ' ');
  return words[0]!.toUpperCase() + words.slice(1);
}

function normalizedPath(path: string): string {
  return path.replace(/:([^/?]+)\??/g, '{$1}');
}

function operationsFor(paths: OpenApiDocument['paths'], route: Route): [string, Operation][] {
  const operations = paths[normalizedPath(route.path)];
  if (!operations) return [];
  const method = route.method.toLowerCase();
  if (method === 'all' || method === '*')
    return Object.entries(operations).filter(([name]) => HTTP_METHODS.includes(name as (typeof HTTP_METHODS)[number]));
  const operation = operations[method];
  return operation ? [[method, operation]] : [];
}

function overlayAuthoredResponses(operation: Operation, detail: RouteDetail | undefined) {
  const authored = detail?.responses;
  if (!isRecord(authored)) return;

  const responses = (operation.responses ??= {});
  for (const [status, value] of Object.entries(authored)) {
    if (!isRecord(value)) continue;
    responses[status] = { ...responses[status], ...value };
  }
}

function validateSecurity(operation: Operation, method: string, path: string): void {
  if (!Array.isArray(operation.security)) return;
  for (const requirement of operation.security) {
    if (!isRecord(requirement)) continue;
    for (const scheme of Object.keys(requirement)) {
      if (!Object.hasOwn(SECURITY_SCHEMES, scheme))
        throw new Error(`${method.toUpperCase()} ${path}: unknown security scheme ${scheme}`);
    }
  }
}

function validateRequestBody(operation: Operation, method: string, path: string): void {
  const requestBody = operation.requestBody;
  if (!requestBody) return;
  const content = requestBody.content;
  const json = content?.['application/json'];
  if (!json) throw new Error(`${method.toUpperCase()} ${path}: request bodies must include application/json`);
  requestBody.content = { 'application/json': json };
}

function restoreJsonRequestBody(operation: Operation, route: Route): void {
  if (route.hooks?.detail?.['x-body-mode'] === 'raw' || operation.requestBody?.content?.['application/json']) return;
  const schema = route.hooks?.body;
  if (!schema) return;
  const openApiSchema = unwrapSchema(schema as never);
  if (!openApiSchema) return;
  const requestBody = (operation.requestBody ??= { required: true });
  requestBody.content = { ...(requestBody.content ?? {}), 'application/json': { schema: openApiSchema } };
}

function validateErrorResponses(operation: Operation, method: string, path: string, schemas: Record<string, unknown>) {
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    const statusCode = Number(status);
    if (!Number.isInteger(statusCode) || statusCode < 400 || statusCode >= 600) continue;

    const content = response.content;
    const media = content?.['application/json'] ?? content?.['application/problem+json'];
    if (!media || !isProblemSchema(media.schema, schemas))
      throw new Error(`${method.toUpperCase()} ${path} ${status}: error responses are problem documents`);

    const codes = problemCodes(media.schema, schemas) as string[];
    response.content = { 'application/problem+json': media };
    if (response.description === `Response for status ${status}`)
      response.description = codes.map((code) => titleForCode(code as ProblemCode)).join('; ');
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => [key, canonical(value[key])]),
  );
}

export function formatDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(canonical(document), null, 2)}\n`;
}

export function openApiDocument(app: AnyElysia): OpenApiDocument {
  // GET /v1/openapi.json is an operation. The default static-file filter would drop it because the path ends in .json.
  const generated = toOpenAPISchema(app, { staticFile: false }) as unknown as GeneratedDocument;
  const schemas = generated.components?.schemas ?? {};
  const document: OpenApiDocument = {
    openapi: '3.1.2',
    info: { title: 'REZICS Kernel API', version: '0.1.0' },
    paths: generated.paths ?? {},
    components: { schemas, securitySchemes: SECURITY_SCHEMES },
  };

  for (const route of app.routes as unknown as Route[]) {
    for (const [method, operation] of operationsFor(document.paths, route)) {
      overlayAuthoredResponses(operation, route.hooks?.detail);
      validateSecurity(operation, method, route.path);
      restoreJsonRequestBody(operation, route);
      if (route.hooks?.detail?.['x-body-mode'] !== 'raw') validateRequestBody(operation, method, route.path);
      validateErrorResponses(operation, method, route.path, schemas);
    }
  }

  document.paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, operations]) => [customMethodPath(path), operations]),
  );
  return canonical(document) as OpenApiDocument;
}
