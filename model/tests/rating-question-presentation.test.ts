import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { commandProfiles } from '../compiler/generate.ts';
import { renderProfile } from '../compiler/ir.ts';
import { ratingQuestionPresentationProfile } from '../definitions/rating-question-presentation-v1.ts';

test('Rating question presentations have their own head, revision chain and unrestricted language bindings', () => {
  const registry = buildCommandRegistry([ratingQuestionPresentationProfile], {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  expect(registry.bindings.get('rating-question-presentation-v1')?.roles).toEqual([
    'presentation',
    'revision',
  ]);
  const shape = renderProfile(ratingQuestionPresentationProfile);
  expect(shape).toContain('sh:path rv:questionPresentationHead');
  expect(shape).toContain('sh:path rv:predecessor');
  expect(shape).toContain('sh:datatype rdf:langString');
  expect(shape).not.toContain('sh:languageIn');
  expect(shape).not.toContain('sh:path rv:head');
  expect(shape).not.toContain('rv:observationHead');
});
test('Rating question presentation accepted lock pins the profile digest and command binding', () => {
  const { manifest } = commandProfiles([ratingQuestionPresentationProfile], {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  const profile = (manifest.profiles as { sha256: string; binding: object }[])[0]!;
  expect(
    readFileSync(
      new URL('../accepted/profiles/rating-question-presentation-v1.json', import.meta.url),
      'utf8',
    ),
  ).toBe(`${JSON.stringify({ sha256: profile.sha256, binding: profile.binding }, null, 2)}\n`);
});
