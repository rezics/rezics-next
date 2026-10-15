import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { openapi } from '@elysia/openapi';
import { readFileSync } from 'node:fs';
import { buildMainOpenApi, isProblemSchema, overlayAuthoredResponses, responseMediaSchemas } from './generate.ts';

test.each([false, true])('authored binary content survives generation and raw delivery (stream=%s)', async streamed => {
  const binary = { description: 'Retained recording', content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } } as const;
  const app = new Elysia().get('/v1/recordings/:id/bytes', {
    response: { 200: t.Any(), 400: t.Object({ code: t.String() }) }, detail: { responses: { 200: binary } },
  }, () => {
    const bytes = readFileSync(new URL('../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url));
    return new Response(streamed ? new Blob([bytes]).stream() : bytes, { headers: { 'content-type': 'audio/wav' } });
  }).use(openapi());
  const delivered = await app.handle(new Request('http://localhost/v1/recordings/original/bytes'));
  expect(delivered.status).toBe(200);
  expect(new Uint8Array(await delivered.arrayBuffer())).toEqual(new Uint8Array(readFileSync(new URL('../../tests/fixtures/recipes/original-tomato-method.wav', import.meta.url))));
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  const document = await response.json();
  const refusal = structuredClone(document.paths['/v1/recordings/{id}/bytes'].get.responses['400']);
  overlayAuthoredResponses(document, app.routes);
  expect(document.paths['/v1/recordings/{id}/bytes'].get.responses).toEqual({ '200': binary, '400': refusal });
  overlayAuthoredResponses(document, app.routes);
  expect(document.paths['/v1/recordings/{id}/bytes'].get.responses['400']).toEqual(refusal);
});

test('JSON error representations keep their media type while Problem variants use problem+json', async () => {
  const document = JSON.parse(await buildMainOpenApi());
  const responses = [
    document.paths['/v1/addresses/resolve'].get.responses['410'],
    document.paths['/v1/media/uploads/{upload}/bytes'].put.responses['422'],
  ];
  for (const response of responses) {
    expect(response.content).toHaveProperty('application/json');
    expect(response.content).not.toHaveProperty('application/problem+json');
  }
  expect(document.paths['/v1/works'].post.responses['429'].content).toHaveProperty('application/problem+json');
  for (const [path, method, status] of [
    ['/v1/works/{id}', 'get', '404'],
    ['/v1/works/{id}/scalar-value', 'post', '409'],
    ['/v1/me/acting-context-preferences/work.create', 'put', '409'],
  ]) {
    expect(document.paths[path!][method!].responses[status!].content).toHaveProperty('application/problem+json');
  }
  for (const response of [document.paths['/v1/connected-apps/invocations'].post.responses['502'],
    document.paths['/v1/recipes/works/{id}'].get.responses['409']]) {
    expect(response.content).toHaveProperty('application/json');
    expect(response.content).toHaveProperty('application/problem+json');
    expect(isProblemSchema(response.content['application/problem+json'].schema)).toBe(true);
    expect(isProblemSchema(response.content['application/json'].schema)).toBe(false);
  }
  for (const path of ['/v1/addresses/resolve', '/v1/facets', '/v1/types', '/v1/zones/{id}/presentation']) {
    expect(document.paths[path].get.responses['304']).not.toHaveProperty('content');
  }
}, 30_000);

test('a mixed JSON body is not re-labelled as a Problem based on its status', () => {
  const problem = { properties: { type: {}, title: {}, status: {}, code: {} } };
  expect(isProblemSchema({ anyOf: [problem, problem] })).toBe(true);
  expect(isProblemSchema({ anyOf: [problem, { properties: { upload: {} } }] })).toBe(false);
});

test('named response models retain references while partitioning Problem and JSON variants', () => {
  const problem = { properties: { type: {}, title: {}, status: {}, code: {} } };
  const receipt = { properties: { upload: {} } };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const models = { Problem: problem, Receipt: receipt, Mixed: { anyOf: [ref('Problem'), ref('Receipt')] }, Loop: ref('Loop') };
  expect(responseMediaSchemas(ref('Problem'), models)).toEqual({ problem: ref('Problem') });
  expect(responseMediaSchemas(ref('Receipt'), models)).toEqual({ json: ref('Receipt') });
  expect(responseMediaSchemas(ref('Mixed'), models)).toEqual({ problem: ref('Problem'), json: ref('Receipt') });
  expect(responseMediaSchemas(ref('Loop'), models)).toEqual({ json: ref('Loop') });
  expect(responseMediaSchemas(ref('Missing'), models)).toEqual({ json: ref('Missing') });
});
