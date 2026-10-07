import { expect, test } from 'bun:test';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { profileSource } from '../compiler/shacl.ts';
import { definitionPresentationProfile } from '../definitions/definition-presentation-v1.ts';
import { commandProfiles } from '../compiler/generate.ts';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';

test('G-832: presentation bindings are registry-only and meaning has a separate head', () => {
  const registry = buildCommandRegistry([definitionPresentationProfile], {
    canonicalOrder: [],
    demandOrder: [],
  });
  expect(registry.bindingDemands.map((item) => item.profile)).toEqual([
    'definition-presentation-v1',
    'definition-presentation-v1',
  ]);
  expect(registry.bindings.get('definition-presentation-v1')?.roles).toEqual([
    'presentation',
    'revision',
  ]);
  const shape = profileSource(definitionPresentationProfile);
  expect(shape).toContain(
    'sh:path rv:meaningRevision ; sh:minCount 1 ; sh:maxCount 1 ; sh:class rv:DefinitionRevision',
  );
  expect(shape).not.toContain('rv:definitionHead');
  expect(shape).not.toContain('sh:languageIn');
  expect(shape).not.toContain('rv:sentenceTemplate');
});

test('G-832: current profile registry pins the generated digest and registry binding', () => {
  const command = commandProfiles([definitionPresentationProfile], {
    canonicalOrder: [],
    demandOrder: [],
  });
  const profile = (command.manifest.profiles as { sha256: string; binding: object }[])[0]!;
  expect<string>(profileRegistry['definition-presentation-v1'].sha256).toBe(profile.sha256);
  expect(definitionPresentationProfile.binding).toBeDefined();
  expect(profile.binding).toEqual({ optional: [], required: [...definitionPresentationProfile.binding!.required], roles: [...definitionPresentationProfile.binding!.roles] });
});
