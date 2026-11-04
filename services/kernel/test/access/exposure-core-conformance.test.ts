import { expect, test } from 'bun:test';
import { compileExposureCatalogue, isExposureGroup, isRouteExposureGroup } from '@rezics/access';

await import('reylo/register');
const { classifyExposureRoutes, mountedExposureCatalogue } = await import('../../src/access/gates/visibility.ts');
const { parseExposure } = await import('../../src/access/gates/declaration.ts');

test('mounted metadata adapts to the canonical catalogue without widening route declarations', () => {
  const routes = [
    {
      method: 'get',
      path: '/v1/feature',
      hooks: {
        detail: {
          operationId: 'feature.read',
          'x-action': 'feature:read',
          'x-exposure': 'gate:feature_group',
        },
      },
    },
    {
      method: 'post',
      path: '/v1/public',
      hooks: { detail: { operationId: 'public.read', 'x-action': 'public:read', 'x-exposure': 'public' } },
    },
    { method: 'get', path: '/hidden', hooks: { detail: { hide: true } } },
  ];
  const operations = classifyExposureRoutes(routes);
  const catalogue = compileExposureCatalogue(operations);
  const mountedCatalogue = mountedExposureCatalogue(routes);
  expect(mountedExposureCatalogue(routes)).toBe(mountedCatalogue);
  expect(mountedCatalogue).toEqual(catalogue);
  expect(catalogue.groups).toEqual(['feature_group']);
  expect(catalogue.operations.map(({ operationId, action }) => [operationId, action])).toEqual([
    ['feature.read', 'feature:read'],
    ['public.read', 'public:read'],
  ]);
  expect(parseExposure({ 'x-exposure': 'gate:feature_group' })).toEqual({ kind: 'gate', group: 'feature_group' });
  expect(isRouteExposureGroup('feature-name')).toBe(false);
  expect(isExposureGroup('feature-name')).toBe(true);
  expect(() => parseExposure({ operationId: 'feature.read', 'x-exposure': 'gate:feature-name' })).toThrow(
    'feature.read',
  );
});
