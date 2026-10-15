import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { openapi } from '@elysia/openapi';
import { readFileSync } from 'node:fs';
import { overlayAuthoredResponses } from './generate.ts';

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
