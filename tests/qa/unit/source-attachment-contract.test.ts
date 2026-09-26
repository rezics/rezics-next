import { expect, test } from 'bun:test';
import { buildMainOpenApi } from '../../../scripts/api/generate.ts';

test('LIVE03/LIVE05: v2 source support collection and commands publish explicit private contracts', async () => {
  const spec = JSON.parse(await buildMainOpenApi());
  for (const [path, methods] of [
    ['/v2/works/{id}/source-supports', ['get', 'post']],
    ['/v2/works/{id}/source-supports/{binding}', ['get']],
    ['/v2/works/{id}/source-supports/{binding}/withdrawal', ['post']],
  ] as const) {
    for (const method of methods) {
      const operation = spec.paths[path][method];
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.responses['200']).toBeDefined();
      expect(operation.responses['404']).toBeDefined();
      expect(operation.responses['503']).toBeDefined();
      if (method === 'post') {
        expect(operation.responses['201']).toBeDefined();
        expect(operation.responses['409']).toBeDefined();
        expect(operation.parameters).toContainEqual(expect.objectContaining({
          in: 'header', name: 'Idempotency-Key', required: true }));
        expect(operation.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
      }
    }
  }
  const collection = spec.paths['/v2/works/{id}/source-supports'].get.responses['200'].content['application/json'].schema;
  expect(collection.properties.supports.maxItems).toBe(2);
  expect(collection.properties.supports.items.anyOf).toHaveLength(2);
  expect(spec.paths['/v1/works/{id}/source-support'].get).toBeDefined();
  expect(spec.paths['/v1/works/{id}/source-support/withdrawal'].post).toBeDefined();
});
