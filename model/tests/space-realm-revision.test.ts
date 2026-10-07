import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { spaceRealmProfile } from '../definitions/space-realm-v1.ts';
import { spaceRealmV2Profile } from '../definitions/space-realm-v2.ts';

test('persisted v1 Realm excludes community properties; v2 admits them', () => {
  const oldShape = renderProfile(spaceRealmProfile);
  const newShape = renderProfile(spaceRealmV2Profile);
  for (const property of ['rv:communityHandle', 'rv:topic']) {
    expect(oldShape).not.toContain(`sh:path ${property}`);
    expect(newShape).toContain(`sh:path ${property}`);
  }
  expect(newShape).toContain('sh:path rv:communityHandle ; sh:maxCount 1 ; sh:datatype xsd:string');
  expect(newShape).toContain('sh:path rv:topic ; sh:maxCount 3 ; sh:nodeKind sh:IRI');
  const registry = buildCommandRegistry([spaceRealmProfile, spaceRealmV2Profile], {
    canonicalOrder: ['<https://rezics.com/vocab/Space>', '<https://rezics.com/vocab/Realm>'], demandOrder: [],
    established: {},
  });
  for (const entry of registry.canonical) {
    expect(entry.routes.map(route => route.profile)).toEqual(['space-realm-v2', 'space-realm-v1']);
  }
});
