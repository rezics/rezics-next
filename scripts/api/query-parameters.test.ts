import { expect, test } from 'bun:test';
import { Elysia, t } from 'elysia';
import { openapi } from '@elysia/openapi';
import { overlayQueryAlternatives } from './generate.ts';

test('alternative query profiles retain parameter discovery and exact correlated admission', async () => {
  const shared = { actingSubject: t.Optional(t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' })),
    cursor: t.Optional(t.String({ maxLength: 2048 })) };
  const query = t.Union([
    t.Object({ ...shared, limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })) }, { additionalProperties: false }),
    t.Object({ ...shared, profile: t.Literal('contextual-v1'),
      limit: t.Optional(t.Numeric({ minimum: 1, maximum: 64 })),
      frame: t.Optional(t.Array(t.String(), { maxItems: 8 })) }, { additionalProperties: false }),
  ]);
  const app = new Elysia().get('/v1/records/:id', {
    params: t.Object({ id: t.String() }), query,
    headers: t.Object({ 'x-selection': t.String() }),
  }, ({ query: selected }) => selected).use(openapi());
  const get = (search: string) => app.handle(new Request(`http://localhost/v1/records/item?${search}`, {
    headers: { 'x-selection': 'current' },
  }));
  expect((await get('limit=64')).status).toBe(422);
  expect((await get('frame=release')).status).toBe(422);
  const accepted = await get('profile=contextual-v1&limit=64&frame=release&frame=canon');
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ profile: 'contextual-v1', limit: 64, frame: ['release', 'canon'] });
  const document = await (await app.handle(new Request('http://localhost/openapi/json'))).json();
  const operation = document.paths['/v1/records/{id}'].get;
  const other = structuredClone(operation.parameters);
  overlayQueryAlternatives(document, app.routes);
  expect(operation.parameters.filter((parameter: { in: string }) => parameter.in !== 'query')).toEqual(other);
  expect(operation.parameters.filter((parameter: { in: string }) => parameter.in === 'query')
    .map((parameter: { name: string; required: boolean }) => [parameter.name, parameter.required]))
    .toEqual([['actingSubject', false], ['cursor', false], ['limit', false], ['profile', false], ['frame', false]]);
  expect(operation.parameters.find((parameter: { name: string }) => parameter.name === 'limit').schema.anyOf)
    .toEqual([
      expect.objectContaining({ anyOf: expect.arrayContaining([expect.objectContaining({ type: 'number', minimum: 1, maximum: 20 })]) }),
      expect.objectContaining({ anyOf: expect.arrayContaining([expect.objectContaining({ type: 'number', minimum: 1, maximum: 64 })]) }),
    ]);
  const variants = operation['x-rezics-query-schema'].anyOf;
  expect(variants[0].additionalProperties).toBe(false);
  expect(variants[0].properties).not.toHaveProperty('profile');
  expect(variants[1].required).toContain('profile');
  expect(variants[1].properties.frame.maxItems).toBe(8);
  const once = JSON.stringify(document);
  overlayQueryAlternatives(document, app.routes);
  expect(JSON.stringify(document)).toBe(once);
});
