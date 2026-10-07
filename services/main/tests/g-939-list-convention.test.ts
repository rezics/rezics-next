import { expect, test } from 'bun:test';
import { openapi } from '@elysia/openapi';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import {
  assertListConvention,
  listConventionViolations,
  type ListOpenApi,
} from '../../../scripts/static/list-convention.ts';
import { listRequest, listResponse } from '../src/api-list.ts';
import { resourceListQuery, resourceListPage } from '../src/modules/query/resource-contract.ts';
import { Elysia, t } from 'elysia';

type QueryShape = {
  anyOf?: QueryShape[];
  oneOf?: QueryShape[];
  properties?: Record<string, QueryShape>;
  const?: string;
};
const unionLeaves = (shape: QueryShape): QueryShape[] =>
  shape.anyOf?.flatMap(unionLeaves) ?? shape.oneOf?.flatMap(unionLeaves) ?? [shape];

const document = () =>
  JSON.parse(
    readFileSync(new URL('../../../generated/openapi/main/public.json', import.meta.url), 'utf8'),
  ) as ListOpenApi;
const owned = ['/v1/discovery/concepts', '/v1/discovery/sections', '/v1/rating-populations'];

test('G939: all new list reads serve the convention in generated OpenAPI', async () => {
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
            schema: QueryShape & { anyOf: QueryShape[] };
          };
        };
      };
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                properties: {
                  result: QueryShape & { anyOf: QueryShape[] };
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
  input.anyOf = unionLeaves(input).filter(
    (shape) => shape.properties?.profile?.const === 'resource-list-v1',
  );
  const result = post.responses['200'].content['application/json'].schema.properties.result;
  result.anyOf = unionLeaves(result).filter(
    (shape) => shape.properties?.profile?.const === 'resource-list-v1',
  );
  expect(input.anyOf).toHaveLength(1);
  expect(result.anyOf).toHaveLength(1);
  const fixture = new Elysia()
    .post('/resource-list', { body: resourceListQuery, response: { 200: resourceListPage } },
      () => { throw new Error('Only the fixture OpenAPI document is served'); })
    .use(openapi());
  const response = await fixture.handle(new Request('http://localhost/openapi/json'));
  expect(response.status).toBe(200);
  const expected = (await response.json() as ListOpenApi).paths['/resource-list']!.post!;
  expect(input.anyOf[0]).toEqual(expected.requestBody!.content!['application/json']!.schema);
  expect(result.anyOf[0]).toEqual(expected.responses!['200']!.content!['application/json']!.schema);
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
