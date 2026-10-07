import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { commandProfiles } from '../compiler/generate.ts';
import { profileSource } from '../compiler/shacl.ts';
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
  const shape = profileSource(ratingQuestionPresentationProfile);
  expect(shape).toContain('sh:path rv:questionPresentationHead');
  expect(shape).toContain('sh:path rv:predecessor');
  expect(shape).toContain('sh:datatype rdf:langString');
  expect(shape).not.toContain('sh:languageIn');
  expect(shape).not.toContain('sh:path rv:head');
  expect(shape).not.toContain('rv:observationHead');
});
test('Rating question presentation registry pins the profile digest and command binding', () => {
  const { manifest } = commandProfiles([ratingQuestionPresentationProfile], {
    established: {},
    canonicalOrder: [],
    demandOrder: [],
  });
  const profile = (manifest.profiles as { sha256: string; binding: object }[])[0]!;
  expect<string>(profileRegistry['rating-question-presentation-v1'].sha256).toBe(profile.sha256);
  expect(ratingQuestionPresentationProfile.binding).toBeDefined();
  expect(profile.binding).toEqual({ optional: [], required: [...ratingQuestionPresentationProfile.binding!.required], roles: [...ratingQuestionPresentationProfile.binding!.roles] });
});
