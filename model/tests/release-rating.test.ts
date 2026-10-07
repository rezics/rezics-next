import { expect, test } from 'bun:test';
import { authoredProfiles } from '../compiler/generate.ts';
import { releaseRatingSlotIri } from '../../services/main/src/modules/rating/release.ts';

const realmReleaseRatingContextProfile = authoredProfiles.find(profile => profile.id === 'realm-release-rating-context-v1')!;
const realmReleaseRatingObservationProfile = authoredProfiles.find(profile => profile.id === 'realm-release-rating-observation-v1')!;

const id = (suffix: number) => `https://rezics.com/id/019cb49e-0ea2-7000-8000-0000000007${String(suffix).padStart(2, '0')}`;
const property = (role: string, path: string) => realmReleaseRatingObservationProfile.shapes
  .find(shape => shape.iri.endsWith(`/${role}-shape`))?.properties.find(item => item.path === path);

test('WORK06: release Context and observation definitions bind the exact release grain', () => {
  const context = realmReleaseRatingContextProfile.shapes
    .find(shape => shape.iri.endsWith('/context-shape'));
  expect(context?.properties.find(item => item.path === 'rv:targetGrain'))
    .toMatchObject({ hasValue: 'rv:FixedRelease' });
  expect(context?.properties.find(item => item.path === 'rdf:type'))
    .toMatchObject({ hasValue: 'rv:ReleaseRatingContext' });
  expect(property('observation', 'rv:targetRelease'))
    .toMatchObject({ minCount: 1, maxCount: 1, class: 'rv:FixedRelease' });
  expect(property('observation', 'rv:targetMainVersion')).toMatchObject({ maxCount: 0 });
  expect(realmReleaseRatingObservationProfile.binding!.required).toContain('release');
  expect(realmReleaseRatingObservationProfile.binding!.roles).toContain('release');
});

test('WORK06: one principal and Context have distinct opaque slots for sibling releases', () => {
  const principal = '019cb49e-0ea2-7000-8000-000000000701';
  const first = releaseRatingSlotIri(principal, id(2), id(5));
  expect(first).toMatch(/^urn:rezics:rating-slot:[0-9a-f]{64}$/);
  expect(releaseRatingSlotIri(principal, id(2), id(5))).toBe(first);
  expect(releaseRatingSlotIri(principal, id(2), id(6))).not.toBe(first);
  expect(releaseRatingSlotIri('019cb49e-0ea2-7000-8000-000000000702', id(2), id(5)))
    .not.toBe(first);
});
