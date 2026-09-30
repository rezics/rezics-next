import { expect, test } from 'bun:test';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { renderProfile } from '../compiler/ir.ts';
import { definitionPresentationProfile } from '../definitions/definition-presentation-v1.ts';
import { commandProfiles } from '../compiler/generate.ts';
import { readFileSync } from 'node:fs';

test('G-832: presentation bindings are registry-only and meaning has a separate head', () => {
  const registry = buildCommandRegistry([definitionPresentationProfile], {
    established: {},
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
  const shape = renderProfile(definitionPresentationProfile);
  expect(shape).toContain(
    'sh:path rv:meaningRevision ; sh:minCount 1 ; sh:maxCount 1 ; sh:class rv:DefinitionRevision',
  );
  expect(shape).not.toContain('rv:definitionHead');
  expect(shape).not.toContain('sh:languageIn');
  expect(shape).not.toContain('rv:sentenceTemplate');
});

test('G-832: accepted profile lock exactly pins the generated digest and registry binding', () => {
  const command = commandProfiles([definitionPresentationProfile], {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  const profile = (command.manifest.profiles as { sha256: string; binding: object }[])[0]!;
  expect(
    readFileSync(
      new URL('../accepted/profiles/definition-presentation-v1.json', import.meta.url),
      'utf8',
    ),
  ).toBe(`${JSON.stringify({ sha256: profile.sha256, binding: profile.binding }, null, 2)}\n`);
});
