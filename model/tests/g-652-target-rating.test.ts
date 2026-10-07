import { expect, test } from 'bun:test';
import { authoredProfiles } from '../compiler/generate.ts';

import { buildCommandRegistry } from '../compiler/registry.ts';

const realmStandingRatingContextProfile = authoredProfiles.find(profile => profile.id === 'realm-standing-rating-context-v1')!;
const realmTargetRatingContextProfile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-context-v1')!;
const realmTargetRatingObservationProfile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-observation-v1')!;
const realmReleaseRatingContextProfile = authoredProfiles.find(profile => profile.id === 'realm-release-rating-context-v1')!;

test('G-652: one registry-only pair covers four owner grains without a target class assertion', () => {
  const context = realmTargetRatingContextProfile.shapes.find(shape => shape.iri.endsWith('/context-shape'))!;
  expect(context.properties.find(property => property.path === 'rv:targetGrain'))
    .toMatchObject({ minCount: 1, maxCount: 1, in: ['rv:Release', 'rv:Realization', 'rv:Occurrence', 'rv:Resource'] });
  const observation = realmTargetRatingObservationProfile.shapes.find(shape => shape.iri.endsWith('/observation-shape'))!;
  const target = observation.properties.find(property => property.path === 'rv:target')!;
  expect(target).toMatchObject({ minCount: 1, maxCount: 1, nodeKind: 'sh:IRI' });
  expect(target).not.toHaveProperty('class');
  expect(observation.properties.find(property => property.path === 'rv:targetMainVersion')).toMatchObject({ maxCount: 0 });
  expect(observation.properties.find(property => property.path === 'rv:targetRelease')).toMatchObject({ maxCount: 0 });
  const registry = buildCommandRegistry([realmTargetRatingContextProfile, realmTargetRatingObservationProfile],
    { established: {}, canonicalOrder: [], demandOrder: [] });
  expect(JSON.stringify(registry)).toContain('realm-target-rating-observation-v1');
  expect(registry.canonical.find(entry => entry.type === 'https://rezics.com/vocab/TargetRatingContext'))
    .toMatchObject({ routes: [{ profile: 'realm-target-rating-context-v1' }] });
  expect(realmTargetRatingObservationProfile.binding!.roles).not.toContain('target');
});

test('G-652: old Context grains remain fixed and cannot select generic target observations', () => {
  const grain = (profile: typeof realmStandingRatingContextProfile | typeof realmReleaseRatingContextProfile) =>
    profile.shapes.find(shape => shape.iri.endsWith('/context-shape'))!.properties.find(property => property.path === 'rv:targetGrain');
  expect(grain(realmStandingRatingContextProfile)).toMatchObject({ hasValue: 'rv:MainVersion' });
  expect(grain(realmReleaseRatingContextProfile)).toMatchObject({ hasValue: 'rv:FixedRelease' });
  expect(realmTargetRatingObservationProfile.shapes.find(shape => shape.iri.endsWith('/observation-shape'))!.properties[0])
    .toMatchObject({ hasValue: 'rv:TargetRatingObservation' });
});
