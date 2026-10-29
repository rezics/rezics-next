import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schema = JSON.parse(readFileSync(join(import.meta.dir, '../worker-result.schema.json'), 'utf8'));
type Schema = Record<string, unknown>;

/** Every way the provider's strict structured output refuses a schema, as paths into it. */
function strictViolations(node: Schema, path: string): string[] {
  const found: string[] = [];
  for (const keyword of ['if', 'then', 'else', 'allOf', 'oneOf', 'not', 'dependentRequired', 'dependentSchemas'])
    if (keyword in node) found.push(`${path}.${keyword}`);
  if (node.properties) {
    const keys = Object.keys(node.properties as Schema);
    const required = (node.required as string[] | undefined) ?? [];
    for (const key of keys) if (!required.includes(key)) found.push(`${path}.required lacks ${key}`);
    if (node.additionalProperties !== false) found.push(`${path}.additionalProperties`);
    for (const key of keys) found.push(...strictViolations((node.properties as Record<string, Schema>)[key]!, `${path}.${key}`));
  }
  if (node.items) found.push(...strictViolations(node.items as Schema, `${path}[]`));
  for (const [index, branch] of ((node.anyOf as Schema[] | undefined) ?? []).entries())
    found.push(...strictViolations(branch, `${path}.anyOf[${index}]`));
  return found;
}

test('the worker result schema meets the strict output rules every worker launch is sent with', () => {
  expect(schema.type).toBe('object');
  for (const keyword of ['anyOf', 'oneOf', 'allOf', 'enum', 'not']) expect(schema).not.toHaveProperty(keyword);
  expect(strictViolations(schema, '$')).toEqual([]);
});
