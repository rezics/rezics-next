import { afterAll, expect, test } from 'bun:test';
import { toOpenAPISchema, withHeaders } from '@elysia/openapi';
import { Elysia, t } from 'elysia';
import { resolve } from 'node:path';
import type { OpenAPIV3_1 } from 'openapi-types';
import { CONTRACT, kernelContract } from '../scripts/openapi.ts';
import { createPool } from '../src/database/pool.ts';
import { createApp } from '../src/http/app.ts';
import { formatDocument, isProblemSchema, openApiDocument } from '../src/http/openapi.ts';
import { problemSchema } from '../src/http/problem.ts';

const pool = createPool('postgres://kernel.invalid/openapi');
afterAll(() => pool.end());

const Thing = t.Object({ id: t.String({ format: 'uuid' }), name: t.String() }, { additionalProperties: false });
const create = {
  operationId: 'thing.create',
  summary: 'Create a thing',
  'x-action': 'thing:create',
  security: [{ bearerAuth: [] }],
  responses: { 201: { description: 'The created thing' } },
};
const read = { operationId: 'thing.get', 'x-action': 'thing:read', security: [{ bearerAuth: [] }, {}] };
const app = createApp({ pool })
  .post(
    '/v1/things',
    {
      headers: t.Object({ 'idempotency-key': t.String({ maxLength: 255 }) }),
      body: t.Object({ name: t.String({ minLength: 1 }) }, { additionalProperties: false }),
      response: {
        201: withHeaders(Thing, { 'rezics-session-token': t.String() }),
        400: problemSchema('invalid_request'),
        503: withHeaders(problemSchema('overloaded', 'partition_unavailable'), { 'retry-after': t.String() }),
      },
      detail: create,
    },
    ({ body, set }) => {
      set.status = 201;
      return { id: '00000000-0000-7000-8000-000000000000', name: body.name };
    },
  )
  .get(
    '/v1/things/:id',
    {
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      response: { 200: Thing, 404: problemSchema('not_found') },
      detail: read,
    },
    ({ params }) => ({ id: params.id, name: 'thing' }),
  );

type Operation = OpenAPIV3_1.OperationObject & Record<string, unknown>;
const document = openApiDocument(app);
const operation = (path: string, method: 'get' | 'post') => document.paths![path]![method] as Operation;
const response = (op: Operation, status: string) => op.responses![status] as OpenAPIV3_1.ResponseObject;

test('error responses are problem documents with their codes', () => {
  const created = operation('/v1/things', 'post');
  const unavailable = response(created, '503');
  expect(Object.keys(unavailable.content!)).toEqual(['application/problem+json']);
  const schema = unavailable.content!['application/problem+json']!.schema as { properties: Record<string, unknown> };
  expect(isProblemSchema(schema)).toBe(true);
  expect(schema.properties.code).toMatchObject({ enum: ['overloaded', 'partition_unavailable'] });
  expect(schema.properties.status).toMatchObject({ const: 503 });
  expect(unavailable.description).toBe('Overloaded; Partition unavailable');
  expect(Object.keys(unavailable.headers ?? {})).toEqual(['retry-after']);
  expect(Object.keys(response(created, '400').content!)).toEqual(['application/problem+json']);
  expect(response(operation('/v1/things/{id}', 'get'), '404').description).toBe('Not found');
});

test('authored response members, operation ids and extensions survive generation', () => {
  const created = operation('/v1/things', 'post');
  const success = response(created, '201');
  expect(success.description).toBe('The created thing');
  expect(Object.keys(success.content!)).toEqual(['application/json']);
  expect(success.content!['application/json']!.schema).toMatchObject({ required: ['id', 'name'] });
  expect(Object.keys(success.headers ?? {})).toEqual(['rezics-session-token']);
  expect(created).toMatchObject({
    operationId: 'thing.create',
    summary: 'Create a thing',
    'x-action': 'thing:create',
    security: [{ bearerAuth: [] }],
  });
  expect(operation('/v1/things/{id}', 'get')).toMatchObject({
    operationId: 'thing.get',
    'x-action': 'thing:read',
    security: [{ bearerAuth: [] }, {}],
  });
});

test('request bodies are JSON only and hidden routes are left out', () => {
  const created = operation('/v1/things', 'post');
  const body = created.requestBody as OpenAPIV3_1.RequestBodyObject;
  expect(Object.keys(body.content)).toEqual(['application/json']);
  expect(created.parameters).toEqual([
    { name: 'idempotency-key', in: 'header', required: true, schema: { type: 'string', maxLength: 255 } },
  ]);
  expect(Object.keys(document.paths!)).toEqual(['/v1/things', '/v1/things/{id}']);
});

test('global body parser restores JSON schemas and preserves raw request content types', () => {
  const build = (withGlobalParser: boolean) => {
    const app = (withGlobalParser ? createApp({ pool }).onParse('global', async () => ({})) : createApp({ pool }))
      .post(
        '/v1/global-body',
        { body: t.Object({ name: t.String() }), detail: { operationId: 'global.body' } },
        () => ({ ok: true }),
      )
      .post(
        '/v1/raw-body',
        {
          detail: {
            operationId: 'raw.body',
            'x-body-mode': 'raw',
            requestBody: {
              required: true,
              content: {
                'text/plain': { schema: { type: 'string' } },
                'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
              },
            },
          } as never,
        },
        () => ({ ok: true }),
      );
    return app;
  };

  const withoutHook = build(false);
  const withHook = build(true);
  const rawGenerated = toOpenAPISchema(withHook, { staticFile: false }).paths['/v1/global-body']?.post?.requestBody;
  console.log('Global parser generated request body:', JSON.stringify(rawGenerated));
  expect((rawGenerated as { content?: unknown } | undefined)?.content).toEqual({});

  const withoutHookDocument = openApiDocument(withoutHook);
  const withHookDocument = openApiDocument(withHook);
  expect(withHookDocument).toEqual(withoutHookDocument);

  const globalBody = withHookDocument.paths['/v1/global-body']!.post!.requestBody!;
  expect(Object.keys(globalBody.content!)).toEqual(['application/json']);
  expect(globalBody.content!['application/json']!.schema).toMatchObject({
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  });

  const rawBody = withHookDocument.paths['/v1/raw-body']!.post!.requestBody!;
  expect(Object.keys(rawBody.content!)).toEqual(['application/octet-stream', 'text/plain']);
});

test('generation refuses an error response that is not a problem and an unknown security scheme', () => {
  const bare = new Elysia().get('/v1/bare', { response: { 404: t.Object({ message: t.String() }) } }, () => {
    throw new Error('unreachable');
  });
  expect(() => openApiDocument(bare)).toThrow('GET /v1/bare 404: error responses are problem documents');
  const cookie = { security: [{ cookieSession: [] }] };
  const unknown = new Elysia().get('/v1/cookie', { detail: cookie }, () => 'ok');
  expect(() => openApiDocument(unknown)).toThrow('GET /v1/cookie: unknown security scheme cookieSession');
});

test('the document is OpenAPI 3.1 with the bearer scheme and stable text', () => {
  expect(document.openapi).toBe('3.1.2');
  expect(document.info).toEqual({ title: 'REZICS Kernel API', version: '0.1.0' });
  expect(document.components?.securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
  const text = formatDocument(document);
  expect(text).toBe(formatDocument(openApiDocument(app)));
  expect(text.endsWith('}\n')).toBe(true);
  expect(Object.keys(JSON.parse(text))).toEqual(['components', 'info', 'openapi', 'paths']);
});

test('the committed contract is the document generated from the kernel app', async () => {
  expect(CONTRACT).toBe(resolve(import.meta.dir, '../../../contracts/openapi.json'));
  const committed = await Bun.file(CONTRACT)
    .text()
    .catch(() => '');
  if (committed !== (await kernelContract()))
    throw new Error('contracts/openapi.json is stale; run `bun run --cwd services/kernel openapi`');
});
