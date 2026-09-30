import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { realizationProfile } from '../definitions/realization-v1.ts';
import { releaseProfile } from '../definitions/release-v1.ts';
import { releaseV2Profile } from '../definitions/release-v2.ts';

test('G833: registry-only realizations and discriminated release-v2 coexist with release-v1', () => {
  const registry = buildCommandRegistry([realizationProfile, releaseProfile, releaseV2Profile],
    { established: {}, canonicalOrder: [], demandOrder: [] });
  const release = registry.canonical.find(entry => entry.type.endsWith('/Release'))!;
  expect(release.routes.map(route => route.profile)).toContain('release-v1');
  expect(release.routes.map(route => route.profile)).toContain('release-v2');
  expect(release.routes.find(route => route.profile === 'release-v2')!.when)
    .toEqual([{ path: 'https://rezics.com/vocab/definitionProfile', value: 'https://rezics.com/definition/release-v2' }]);
  expect(registry.bindings.get('realization-v1')!.roles).toEqual(['realization', 'revision']);
  const realized = renderProfile(realizationProfile);
  expect(realized).toContain('rv:head');
  expect(realized).toContain('rv:sourceRevision');
  expect(realized).toContain('"unresolved"');
  const released = renderProfile(releaseV2Profile);
  for (const path of ['rv:work', 'rv:coverageWork', 'rv:coverageRevision', 'rv:contentLanguage', 'rv:platform', 'rv:territory', 'rv:completeness', 'rv:identifier']) {
    expect(released).toContain(path);
  }
  expect(released).toContain('sh:maxCount 64');
  const properties = releaseV2Profile.shapes[0].properties;
  expect(properties.find(property => property.path === 'rv:work')).toMatchObject({ minCount: 1, maxCount: 1 });
  expect(properties.find(property => property.path === 'rv:coverageWork')).toMatchObject({ minCount: 1, maxCount: 64 });
});
