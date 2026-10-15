import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { openapi } from '@elysia/openapi';
import { overlayAuthoredResponses } from './generate.ts';

test('authored binary content survives generation alongside a runtime refusal schema', async () => {
  const binary = { description: 'Retained recording', content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } } } as const;
  const app = new Elysia().get('/v1/recordings/:id/bytes', {
    response: { 400: t.Object({ code: t.String() }) }, detail: { responses: { 200: binary } },
  }, () => new Response()).use(openapi());
  const response = await app.handle(new Request('http://localhost/openapi/json'));
  const document = await response.json();
  const refusal = structuredClone(document.paths['/v1/recordings/{id}/bytes'].get.responses['400']);
  overlayAuthoredResponses(document, app.routes);
  expect(document.paths['/v1/recordings/{id}/bytes'].get.responses).toEqual({ '200': binary, '400': refusal });
  overlayAuthoredResponses(document, app.routes);
  expect(document.paths['/v1/recordings/{id}/bytes'].get.responses['400']).toEqual(refusal);
});
