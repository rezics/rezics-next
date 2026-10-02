import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import {
  assertListConvention,
  listConventionViolations,
  type ListOpenApi,
} from '../../../scripts/static/list-convention.ts';
import { listRequest, listResponse } from '../src/api-list.ts';
import { t } from 'elysia';

const document = () =>
  JSON.parse(
    readFileSync(new URL('../../../generated/openapi/main/public.json', import.meta.url), 'utf8'),
  ) as ListOpenApi;
const owned = ['/v1/discovery/concepts', '/v1/discovery/sections', '/v1/rating-populations'];

test('G939: all new list reads serve the convention in generated OpenAPI', () => {
  const api = document();
  expect(owned.every((path) => !!api.paths[path])).toBe(true);
  expect(
    listConventionViolations({
      paths: Object.fromEntries(owned.map((path) => [path, api.paths[path]!])),
    }),
  ).toEqual([]);
  const query = structuredClone(api.paths['/v1/query']!) as unknown as Record<
    string,
    {
      requestBody: {
        content: {
          'application/json': {
            schema: { anyOf: Array<{ properties: { profile?: { const?: string } } }> };
          };
        };
      };
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                properties: {
                  result: { anyOf: Array<{ properties: { profile?: { const?: string } } }> };
                };
              };
            };
          };
        };
      };
    }
  >;
  const post = query.post!;
  const input = post.requestBody.content['application/json'].schema;
  input.anyOf = input.anyOf.filter(
    (shape) => shape.properties.profile?.const === 'resource-list-v1',
  );
  const result = post.responses['200'].content['application/json'].schema.properties.result;
  result.anyOf = result.anyOf.filter(
    (shape) => shape.properties?.profile?.const === 'resource-list-v1',
  );
  expect(input.anyOf).toHaveLength(1);
  expect(result.anyOf).toHaveLength(1);
  assertListConvention({ paths: { '/v1/query': query as never } });
});

test('G939: the generated-contract guard rejects missing input and output fields', () => {
  for (const field of ['cursor', 'limit', 'items', 'nextCursor', 'complete']) {
    const api = document();
    const operation = api.paths['/v1/discovery/concepts']!.get!;
    if (field === 'cursor' || field === 'limit')
      operation.parameters = operation.parameters!.filter((item) => item.name !== field);
    else {
      const schema = operation.responses!['200']!.content!['application/json']!.schema!;
      delete schema.properties![field];
    }
    expect(() =>
      assertListConvention({ paths: { '/v1/discovery/concepts': { get: operation } } }),
    ).toThrow(field);
  }
});

test('G939: request bounds do not imply a finite collection, and completion is explicit', () => {
  expect(Value.Check(listRequest, { q: '', limit: 64 })).toBe(true);
  expect(Value.Check(listRequest, { limit: 65 })).toBe(false);
  expect(Value.Check(listRequest, { cursor: '' })).toBe(false);
  const schema = listResponse(t.String());
  expect(
    Value.Check(schema, {
      items: [],
      nextCursor: 'continue',
      complete: false,
      count: { kind: 'at-least', value: 0 },
    }),
  ).toBe(true);
  expect(Value.Check(schema, { items: [] })).toBe(false);
});

test('G939: compatibility directories remain explicitly deprecated', () => {
  const api = document() as ListOpenApi & {
    paths: Record<string, { get: { deprecated: boolean } }>;
  };
  for (const path of ['/v1/realms', '/v1/classification-vocabulary'])
    expect(api.paths[path]!.get.deprecated).toBe(true);
});
