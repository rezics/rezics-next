import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { authoredProfiles } from '../compiler/generate.ts';
import { workTitleControlProfile } from '../definitions/work-title-control-v1.ts';
import { workTitleControlV2Profile } from '../definitions/work-title-control-v2.ts';
import { spaceRealmProfile } from '../definitions/space-realm-v1.ts';
import { spaceRealmV2Profile } from '../definitions/space-realm-v2.ts';
import { spaceRealmV3Profile } from '../definitions/space-realm-v3.ts';

test('G-512 one native title epoch carries its language and leaves the English v1 readable', () => {
  expect(renderProfile(workTitleControlProfile)).toContain('sh:hasValue "title:en"');
  const current = renderProfile(workTitleControlV2Profile);
  expect(current).toContain('sh:hasValue "title"');
  expect(current).toContain('sh:path rv:controlLanguage ; sh:minCount 1 ; sh:maxCount 1');
  expect(current).not.toContain('title:en');
  expect(current).not.toContain('"en"');
});

test('G-512 canonical title validation selects v2 by model revision and retains the v1 fallback', () => {
  const registry = buildCommandRegistry(authoredProfiles);
  const entry = registry.canonical.find(entry => entry.type === 'https://rezics.com/vocab/EditorialControlRevision');
  expect(entry?.routes).toEqual([
    { profile: 'work-title-control-v2', shape: 'https://rezics.com/definition/work-title-control-v2/control-shape',
      when: [{ path: 'https://rezics.com/vocab/modelRevision', value: 'https://rezics.com/definition/work-title-control-v2' }] },
    { profile: 'work-title-control-v1', shape: 'https://rezics.com/definition/work-title-control-v1/control-shape', when: [] },
  ]);
});

test('G-512 Space payload language is versioned without losing legacy community profiles', () => {
  const registry = buildCommandRegistry([spaceRealmProfile, spaceRealmV2Profile, spaceRealmV3Profile], {
    canonicalOrder: ['<https://rezics.com/vocab/Space>', '<https://rezics.com/vocab/Realm>'], demandOrder: [],
    established: { 'space-realm-v1': { canonical: {
      space: { types: ['<https://rezics.com/vocab/Space>'] }, realm: { types: ['<https://rezics.com/vocab/Realm>'] },
    } } },
  });
  for (const entry of registry.canonical) {
    expect(entry.routes.map(route => route.profile)).toEqual(['space-realm-v2', 'space-realm-v3', 'space-realm-v1']);
  }
  expect(renderProfile(spaceRealmV3Profile)).toContain('sh:path rv:communityHandle');
  expect(renderProfile(spaceRealmV3Profile)).not.toContain('"en"');
});
