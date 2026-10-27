import { afterAll, expect, test } from 'bun:test';
import type { Kernel as ClientKernel } from '@rezics/client';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
afterAll(() => pool.end());

type Feed = ClientKernel['~Routes']['v1']['subject-pages']['get'];
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type ExpectedPage = { id: string; lastModified: string; labels: { language: string; value: string }[] };
const preciseQuery: Equal<Feed['query'], { cursor?: string; limit?: number | string }> = true;
const preciseResponse: Equal<Feed['response'][200], { subjectPages: ExpectedPage[]; next: string | null }> = true;

test('the subject page feed has a precise public HTTP contract', () => {
  expect([preciseQuery, preciseResponse]).toEqual([true, true]);
  const operation = openApiDocument(kernel).paths['/v1/subject-pages']?.get;
  expect(operation).toMatchObject({
    operationId: 'subject_pages.list',
    'x-exposure': 'public',
    'x-action': 'subject:read',
    parameters: expect.arrayContaining([
      expect.objectContaining({
        name: 'cursor',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ type: 'string' }),
      }),
      expect.objectContaining({
        name: 'limit',
        in: 'query',
        required: false,
        schema: expect.objectContaining({
          default: 20,
          anyOf: [{ type: 'number', minimum: 1, maximum: 1000, multipleOf: 1 }, { type: 'string' }],
        }),
      }),
    ]),
    responses: {
      200: {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['subjectPages', 'next'],
              properties: {
                subjectPages: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'lastModified', 'labels'],
                    properties: {
                      id: { type: 'string', format: 'uuid' },
                      lastModified: { type: 'string', format: 'date-time', pattern: 'Z$' },
                      labels: {
                        type: 'array',
                        items: {
                          type: 'object',
                          additionalProperties: false,
                          required: ['language', 'value'],
                          properties: { language: { type: 'string' }, value: { type: 'string' } },
                        },
                      },
                    },
                  },
                },
                next: { type: ['string', 'null'] },
              },
            },
          },
        },
      },
      400: expect.anything(),
      503: expect.anything(),
    },
  });
});

test('the feed refuses limits outside its approved sitemap range', async () => {
  for (const [query, status, code] of [
    ['', 503, 'semantic_not_ready'],
    ['?limit=1', 503, 'semantic_not_ready'],
    ['?limit=1000&cursor=opaque', 503, 'semantic_not_ready'],
    ['?limit=0', 400, 'invalid_request'],
    ['?limit=1001', 400, 'invalid_request'],
    ['?limit=1.5', 400, 'invalid_request'],
  ] as const) {
    const response = await kernel.handle(new Request(`http://kernel.test/v1/subject-pages${query}`));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
});
