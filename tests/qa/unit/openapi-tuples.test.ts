import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { jsonSchema2020Tuples } from '../../../scripts/api/generate.ts';

const root = resolve(import.meta.dir, '../../..');

test('draft-07 tuples become JSON Schema 2020-12 prefixItems; literal values are left alone', () => {
  expect(jsonSchema2020Tuples({ type: 'array', items: [{ const: 'realm' }], additionalItems: false,
    minItems: 1, maxItems: 1 })).toEqual({ type: 'array', prefixItems: [{ const: 'realm' }], items: false,
    minItems: 1, maxItems: 1 });
  expect(jsonSchema2020Tuples({ type: 'array', items: { type: 'string' } }))
    .toEqual({ type: 'array', items: { type: 'string' } });
  expect(jsonSchema2020Tuples({ properties: { list: { items: [{ type: 'integer' }] } },
    example: { items: [1] } })).toEqual({ properties: { list: { prefixItems: [{ type: 'integer' }] } },
    example: { items: [1] } });
});

test('the generated public contract has no draft-07 tuple keywords', () => {
  const text = readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8');
  const arrayItems: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}/${index}`));
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if ((key === 'items' && Array.isArray(item)) || key === 'additionalItems') arrayItems.push(`${path}/${key}`);
        walk(item, `${path}/${key}`);
      }
    }
  };
  walk(JSON.parse(text), '');
  expect(arrayItems).toEqual([]);
  expect(text).toContain('"prefixItems"');
});
