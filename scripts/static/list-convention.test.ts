import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { newListViolations, type ListViolation, type ListOpenApi } from './list-convention.ts';

// Existing violations remain visible in the full CLI audit. This exact field
// debt follows the repository's anti-silo baseline pattern; it is separate from
// the two inherently bounded registry exceptions. Owners can remove debt as
// their reads adopt the shared contract, without widening this baseline.
const debt = JSON.parse(
  readFileSync(new URL('./list-convention-debt.json', import.meta.url), 'utf8'),
) as ListViolation[];
const api = () =>
  JSON.parse(
    readFileSync(new URL('../../generated/openapi/main/public.json', import.meta.url), 'utf8'),
  ) as ListOpenApi;
test('collection read contracts introduce no new list convention debt', () => {
  expect(newListViolations(api(), debt)).toEqual([]);
});
test('new collection reads cannot borrow another operation or profile’s debt', () => {
  const document = api();
  document.paths['/v1/g939-broken-list'] = {
    get: {
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { items: { type: 'array' } } },
            },
          },
        },
      },
    },
  };
  expect(
    newListViolations(document, debt).some((item) =>
      item.operation.startsWith('GET /v1/g939-broken-list'),
    ),
  ).toBe(true);
});

test('detail arrays are ignored and added collection profiles are checked', () => {
  const document = api();
  document.paths['/v1/g939-records'] = {
    get: {
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { records: { type: 'array' } } },
            },
          },
        },
      },
    },
  };
  document.paths['/v1/query'] = {
    post: {
      requestBody: {
        content: {
          'application/json': {
            schema: {
              anyOf: [{ type: 'object', properties: { profile: { const: 'another-list-v1' } } }],
            },
          },
        },
      },
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: { type: 'object', properties: { items: { type: 'array' } } },
            },
          },
        },
      },
    },
  };
  const violations = newListViolations(document, debt);
  expect(violations.some((item) => item.operation.startsWith('GET /v1/g939-records'))).toBe(false);
  expect(
    violations.some((item) => item.operation === 'POST /v1/query request[another-list-v1]'),
  ).toBe(true);
});
