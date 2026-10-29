import { afterAll, expect, spyOn, test } from 'bun:test';
import { toOpenAPISchema } from '@elysia/openapi';
import { RELEASE_FORMAT, RELEASE_LIMITS, validateRelease } from '@rezics/definitions';
import canonicalize from 'canonicalize';
import { ADMISSION_LIMITS } from '../../src/http/admission.ts';
import { t } from 'elysia';
import { kernelContract } from '../../scripts/openapi.ts';
import { createPool } from '../../src/database/pool.ts';
import { createApp } from '../../src/http/app.ts';
import { bodyBytes, bodyWireBytes, DEFAULT_BODY_LIMIT, MAX_BODY_LIMIT, requestBody } from '../../src/http/body.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { customMethodPath } from '../../src/http/custom-method.ts';
import { openApiDocument } from '../../src/http/openapi.ts';

const pool = createPool('postgres://kernel.invalid/openapi');
afterAll(() => pool.end());
const schema = t.Object({ count: t.Integer(), enabled: t.Boolean() }, { additionalProperties: false });
const detail = {
  operationId: 'probe.bounded_openapi',
  'x-action': 'probe:read',
  'x-exposure': 'public',
  security: [{ bearerAuth: [] }, {}],
};
function probe() {
  return createApp({ pool }).post('/bounded-openapi', { body: schema, detail }, ({ body, request }) => {
    expect(bodyWireBytes(request)).toBeGreaterThan(0);
    expect(Object.isFrozen(requestBody(request))).toBe(true);
    expect(bodyBytes(request)).toBe(requestBody(request)!.bytes);
    return body;
  });
}

test('the actual kernel generation caller retains closed subject and typed JSON request schemas', async () => {
  const document = JSON.parse(await kernelContract());
  const subject = document.paths['/v1/subjects'].post.requestBody.content;
  expect(Object.keys(subject)).toEqual(['application/json']);
  expect(subject['application/json'].schema).toEqual({
    type: 'object',
    additionalProperties: false,
    required: ['type', 'labels'],
    properties: {
      type: { type: 'string' },
      labels: { type: 'object', patternProperties: { '^.*$': {} } },
      descriptions: { type: 'object', patternProperties: { '^.*$': {} } },
      aliases: { type: 'object', patternProperties: { '^.*$': {} } },
      statements: { type: 'object', patternProperties: { '^.*$': {} } },
    },
  });
  const search = document.paths['/v1/subjects:search'].post.requestBody.content['application/json'].schema;
  expect(search).toMatchObject({ additionalProperties: false, properties: { limit: { type: 'integer' } } });
  const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
  expect(openApiDocument(kernel)).toEqual(document);
});

test('bounded global parsing preserves the real code-first schema without mutating parser hooks', async () => {
  const app = probe();
  const route = app.routes.find((route) => route.path === '/bounded-openapi')!;
  const parsers = route.hooks!.parse;
  // The installed generator sees only the global function parser and emits empty content.
  const native = toOpenAPISchema(app, { staticFile: false });
  expect((native.paths['/bounded-openapi']!.post!.requestBody as { content: Record<string, unknown> }).content).toEqual(
    {},
  );
  const document = openApiDocument(app);
  expect(document.paths['/bounded-openapi']!.post!.requestBody).toEqual({
    required: true,
    content: { 'application/json': { schema } },
  });
  expect(route.hooks!.parse).toBe(parsers);
  const response = await app.handle(
    new Request('http://kernel.test/bounded-openapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"count":2,"enabled":true}',
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ count: 2, enabled: true });
});

test('generation preserves actual self-parsing declarations and never invents a raw body schema', async () => {
  const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
  const native = toOpenAPISchema(kernel, { staticFile: false });
  const document = openApiDocument(kernel);
  const board = document.paths['/v1/boards']!.post!.requestBody!;
  const nativeBody = native.paths['/v1/boards']!.post!.requestBody as { content: Record<string, unknown> };
  expect(nativeBody.content['application/json']).toEqual(board.content!['application/json']);
  const rawDetail = { ...detail, 'x-body-mode': 'raw' };
  const app = createApp({ pool }).post('/raw-openapi', { detail: rawDetail }, ({ body }) => [...(body as Uint8Array)]);
  expect(openApiDocument(app).paths['/raw-openapi']!.post!.requestBody).toBeUndefined();
  const request = () =>
    new Request('http://kernel.test/raw-openapi', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([255, 0, 123]),
    });
  // Compile before counting request-path parsing work.
  expect((await app.handle(request())).status).toBe(200);
  const parse = spyOn(JSON, 'parse');
  const decode = spyOn(TextDecoder.prototype, 'decode');
  let response: Response;
  try {
    response = await app.handle(request());
    expect(parse).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
    decode.mockRestore();
  }
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([255, 0, 123]);
});

test('native typed400, strict JSON and wire caps survive generation', async () => {
  const app = probe();
  openApiDocument(app);
  for (const body of ['{"count":"2","enabled":true}', '{broken', '{"count":2,"enabled":true,"extra":1}']) {
    const response = await app.handle(
      new Request('http://kernel.test/bounded-openapi', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(await response.json()).toMatchObject({ code: 'invalid_request', status: 400 });
  }
  expect(DEFAULT_BODY_LIMIT).toBe(1_048_576);
  expect(MAX_BODY_LIMIT).toBe(4_259_840);
  const oversized = await app.handle(
    new Request('http://kernel.test/bounded-openapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ' '.repeat(DEFAULT_BODY_LIMIT + 1),
    }),
  );
  expect(oversized.status).toBe(413);
});

test('the mounted Definitions route enforces its larger wire cap before decoding or effects', async () => {
  const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
  const document = openApiDocument(kernel);
  expect(document.paths['/v1/definitions/releases']!.post!['x-body-limit']).toBe(MAX_BODY_LIMIT);
  for (const [bytes, status] of [
    [DEFAULT_BODY_LIMIT + 1, 400],
    [MAX_BODY_LIMIT, 400],
    [MAX_BODY_LIMIT + 1, 413],
  ]) {
    // Malformed JSON cannot reach authentication, publication, or the invalid database pool.
    const response = await kernel.handle(
      new Request('http://kernel.test/v1/definitions/releases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: ' '.repeat(bytes! - 1) + '{',
      }),
    );
    expect(response.status).toBe(status!);
    expect(await response.json()).toMatchObject({ code: status === 413 ? 'content_too_large' : 'invalid_request' });
  }
});

test('a maximum canonical release in its compact envelope reaches native release validation', async () => {
  const release = {
    format: RELEASE_FORMAT,
    catalogue: { id: 'https://kernel.test/catalogue', version: '1' },
    generator: { name: '', version: '1' },
    prefixes: {},
    types: {},
    properties: {},
  };
  release.generator.name = 'x'.repeat(RELEASE_LIMITS.bytes - Buffer.byteLength(canonicalize(release)!));
  expect(Buffer.byteLength(canonicalize(release)!)).toBe(RELEASE_LIMITS.bytes);
  expect(validateRelease(release)).toEqual([]);
  // An equal-width invalid format produces a release-validation pointer, before any database effect.
  release.format = RELEASE_FORMAT.replace(/1$/, '0');
  const kernel = createKernel({
    pool,
    routeKey: new Uint8Array(32),
    access: {
      async authenticate() {
        return {
          kind: 'account',
          accountId: '019a1b2c-3d4e-7000-8000-000000000001',
          clientId: 'body-limit',
          requestedBy: null,
          authnEpoch: 0,
          scopes: ['definitions:publish'],
        };
      },
      async authorize() {
        throw new Error('release validation must precede command authorization');
      },
    },
    writeRate: {
      async spend() {
        return { allowed: true };
      },
    },
  });
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/definitions/releases', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer probe',
        'idempotency-key': '"maximum-release"',
      },
      body: JSON.stringify({ release }),
    }),
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    code: 'invalid_request',
    errors: [{ pointer: '/release/format', code: 'invalid_format' }],
  });
});

test('native ingress reservations refuse excess requests before reading and release after responses', async () => {
  const budget = (ADMISSION_LIMITS.permits + ADMISSION_LIMITS.queue) * DEFAULT_BODY_LIMIT + 2 * MAX_BODY_LIMIT;
  const capacity = Math.floor(budget / DEFAULT_BODY_LIMIT);
  const app = probe();
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  const request = (body: ReadableStream<Uint8Array>) =>
    new Request('http://kernel.test/bounded-openapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
  try {
    for (let index = 0; index < capacity; index++) {
      const reading = Promise.withResolvers<void>();
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controllers.push(controller);
          },
          pull() {
            reading.resolve();
            return new Promise<void>(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      pending.push(app.handle(request(body)));
      await reading.promise;
    }
    let reads = 0;
    const excess = () =>
      request(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    const refused = await app.handle(excess());
    expect(refused.status).toBe(503);
    expect(refused.headers.get('retry-after')).toBe('1');
    expect(await refused.json()).toMatchObject({ code: 'overloaded' });
    expect(reads).toBe(0);
  } finally {
    for (const controller of controllers) {
      controller.enqueue(new TextEncoder().encode('{"count":2,"enabled":true}'));
      controller.close();
    }
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  }
  const next = await app.handle(
    new Request('http://kernel.test/bounded-openapi', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"count":2,"enabled":true}',
    }),
  );
  expect(next.status).toBe(200);
});

test('all mounted body routes use the shared cap or an explicitly listed bounded parser', async () => {
  const ownParsers = new Set([
    'POST /v1/boards',
    'POST /v1/realms/:realmId/boards',
    'POST /v1/threads',
    'POST /v1/threads/:id/posts',
    'POST /v1/posts/:id/revisions',
    'POST /v1/reports',
    'POST /v1/sourceFences/$takedown',
    'POST /v1/media/:id/$takeDown',
    'POST /v1/webhooks/stripe',
  ]);
  const kernel = createKernel({ pool, routeKey: new Uint8Array(32) });
  const seenOwnParsers = new Set<string>();
  let shared = 0;
  let largest = DEFAULT_BODY_LIMIT;
  for (const route of kernel.routes) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.method)) continue;
    const key = `${route.method} ${route.path}`;
    if (ownParsers.has(key)) {
      expect(route.hooks?.parse).toBeDefined();
      seenOwnParsers.add(key);
      continue;
    }
    const metadata = route.hooks?.detail as Record<string, unknown> | undefined;
    const limit = typeof metadata?.['x-body-limit'] === 'number' ? metadata['x-body-limit'] : DEFAULT_BODY_LIMIT;
    largest = Math.max(largest, limit);
    let reads = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reads++;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const path = customMethodPath(route.path.replace(/:[^/]+/g, '019a1b2c-3d4e-7000-8000-000000000001'));
    const response = await kernel.handle(
      new Request(`http://kernel.test${path}`, {
        method: route.method,
        headers: { 'content-type': 'application/json', 'content-length': String(limit + 1) },
        body,
        duplex: 'half',
      } as RequestInit),
    );
    expect(response.status, key).toBe(413);
    expect(await response.json(), key).toMatchObject({ code: 'content_too_large' });
    expect(reads, key).toBe(0);
    shared++;
  }
  expect([...seenOwnParsers].sort()).toEqual([...ownParsers].sort());
  expect(shared).toBeGreaterThan(0);
  expect(largest).toBe(MAX_BODY_LIMIT);
  const server = await Bun.file(new URL('../../src/server.ts', import.meta.url)).text();
  expect(server).toContain('maxRequestBodySize: MAX_BODY_LIMIT');
});
