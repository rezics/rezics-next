import { readFileSync } from 'node:fs';
import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
// Installs the served registry's Work-type format predicate.
import '../../../services/main/src/modules/types/registry.ts';

interface Operation {
  requestBody?: { content: Record<string, { schema: TSchema }> };
}
let routes: [RegExp, Record<string, Operation>][] | undefined;

/** OpenAPI 3.0 marks optional nulls with `nullable: true`, which TypeBox's checker
 * ignores: a nullable enum then refused the null Main accepts. Express each one as
 * an explicit `anyOf` with `null` before checking. */
function withNulls(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withNulls);
  if (!schema || typeof schema !== 'object') return schema;
  const { nullable, ...rest } = schema as Record<string, unknown>;
  const mapped = Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, withNulls(value)]));
  return nullable === true ? { anyOf: [mapped, { type: 'null' }] } : mapped;
}

/** Seed and fixture transports validate every Main write against the generated
 * public contract, including dynamic paths, before sending any request. */
export function assertSeedRequest(method: string, path: string, body: unknown): void {
  routes ??= Object.entries(
    (
      JSON.parse(
        readFileSync(
          new URL('../../../generated/openapi/main/public.json', import.meta.url),
          'utf8',
        ),
      ) as { paths: Record<string, Record<string, Operation>> }
    ).paths,
  ).map(([route, operations]) => [route, withNulls(operations) as Record<string, Operation>] as const,
  ).map(([route, operations]) => [
    new RegExp(
      `^${route
        .split('/')
        .map((segment) =>
          segment.startsWith('{') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/')}$`,
    ),
    operations,
  ]);
  const pathname = path.split('?')[0]!;
  const operation = routes.find(
    ([pattern, operations]) => pattern.test(pathname) && operations[method.toLowerCase()],
  )?.[1][method.toLowerCase()];
  const schema = operation?.requestBody?.content['application/json']?.schema;
  if (!schema) throw new Error(`Seed request has no generated JSON schema: ${method} ${pathname}`);
  if (!Value.Check(schema, body)) {
    const errors = Value.Errors(schema, body)
      .map((error) => `${error.instancePath}: ${error.message}`)
      .slice(0, 4);
    throw new Error(
      `Seed request violates generated schema: ${method} ${pathname}: ${errors.join('; ')}`,
    );
  }
}
