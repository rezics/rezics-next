import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Schema = {
  type?: string;
  const?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
};
interface Operation {
  parameters?: { in: string; name: string }[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
}
export interface ListOpenApi {
  paths: Record<string, Record<string, Operation>>;
}
export interface ListViolation {
  operation: string;
  fields: string[];
}

// Deployment-bounded definition registries; new definitions require a deploy.
export const boundedListReads = new Set(['GET /v1/facets', 'GET /v1/types']);
const variants = (schema: Schema): Schema[] =>
  schema.anyOf?.flatMap(variants) ?? schema.oneOf?.flatMap(variants) ?? [schema];
const isArray = (schema: Schema) => variants(schema).some((shape) => shape.type === 'array');
function listObjects(schema: Schema): Schema[] {
  return variants(schema).flatMap((shape) => {
    const properties = shape.properties ?? {};
    if (properties.nextCursor || (properties.items && isArray(properties.items))) return [shape];
    return properties.result ? listObjects(properties.result) : [];
  });
}

/** Inspect served schemas, including POST read profiles and nested Query
 * results. A GET path's spelling is not used to infer collection semantics. */
export function listConventionViolations(document: ListOpenApi): ListViolation[] {
  const violations: ListViolation[] = [];
  for (const [path, operations] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(operations)) {
      if (
        method !== 'get' &&
        !(method === 'post' && /(?:query|queries|pages|search)(?:\/|$)/u.test(path))
      )
        continue;
      const key = `${method.toUpperCase()} ${path}`;
      if (boundedListReads.has(key)) continue;
      const response = operation.responses?.['200']?.content?.['application/json']?.schema;
      if (!response) continue;
      const lists = listObjects(response);
      if (!lists.length) continue;
      const body = operation.requestBody?.content?.['application/json']?.schema;
      const requests = body ? variants(body) : [];
      const queryMissing: string[] = [];
      for (const field of ['cursor', 'limit']) {
        const query = operation.parameters?.some(
          (parameter) => parameter.in === 'query' && parameter.name === field,
        );
        if (!query) queryMissing.push(field);
      }
      if (!requests.length && queryMissing.length)
        violations.push({
          operation: key,
          fields: queryMissing.map((field) => `request.${field}`),
        });
      for (const [index, request] of requests.entries()) {
        const fields = queryMissing
          .filter((field) => !request.properties?.[field])
          .map((field) => `request.${field}`);
        if (fields.length)
          violations.push({
            operation: `${key} request[${request.properties?.profile?.const ?? index}]`,
            fields,
          });
      }
      for (const [index, list] of lists.entries()) {
        const fields = ['items', 'nextCursor', 'complete']
          .filter((field) => !list.properties?.[field])
          .map((field) => `response.${field}`)
          .sort();
        if (fields.length)
          violations.push({
            operation: `${key} response[${list.properties?.profile?.const ?? index}]`,
            fields,
          });
      }
    }
  }
  return violations.sort((a, b) => a.operation.localeCompare(b.operation));
}

export function assertListConvention(document: ListOpenApi) {
  const violations = listConventionViolations(document);
  if (violations.length)
    throw new Error(
      violations.map((item) => `${item.operation}: ${item.fields.join(', ')}`).join('\n'),
    );
}

/** Existing owners are scheduled separately. Debt never exempts a new field,
 * operation or Query profile, and the full audit continues to report it. */
export function newListViolations(document: ListOpenApi, debt: readonly ListViolation[]) {
  const known = new Map(debt.map((item) => [item.operation, new Set(item.fields)]));
  return listConventionViolations(document).flatMap((item) => {
    const fields = item.fields.filter((field) => !known.get(item.operation)?.has(field));
    return fields.length ? [{ ...item, fields }] : [];
  });
}

if (import.meta.main) {
  const document = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../../generated/openapi/main/public.json'), 'utf8'),
  );
  const violations = listConventionViolations(document);
  if (process.argv.includes('--record-debt')) {
    const path = resolve(import.meta.dir, 'list-convention-debt.json');
    const debt = JSON.parse(readFileSync(path, 'utf8')) as ListViolation[];
    if (newListViolations(document, debt).length) throw new Error('List debt may only shrink');
    writeFileSync(
      resolve(import.meta.dir, 'list-convention-debt.json'),
      JSON.stringify(violations, null, 2) + '\n',
    );
    process.exit(0);
  }
  for (const violation of violations)
    process.stdout.write(`${violation.operation}: ${violation.fields.join(', ')}\n`);
  process.exitCode = violations.length ? 1 : 0;
}
