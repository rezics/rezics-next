import { expect, test } from 'bun:test';
import { profileSource } from '../compiler/shacl.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { authoredProfiles } from '../compiler/generate.ts';

const realmTargetRatingContextV3Profile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-context-v3')!;
const realmTargetRatingContextV4Profile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-context-v4')!;
const realmTargetRatingObservationV4Profile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-observation-v4')!;

test('v4 adds optional type and frame declarations and accepts Realm or Global ownership without altering v3', () => {
  const source = profileSource(realmTargetRatingContextV4Profile);
  expect(source).toContain('sh:path rv:acceptedSubjectType ; sh:maxCount 32 ; sh:nodeKind sh:IRI');
  expect(source).toContain(
    'sh:path rv:acceptedFrameDimension ; sh:maxCount 8 ; sh:datatype xsd:string',
  );
  expect(source).toContain('rv:GlobalRatingPopulation');
  expect(source).toContain('sh:or');
  expect(source).toContain('rv:Resource rv:Projection )');
  const older = profileSource(realmTargetRatingContextV3Profile);
  expect(older).not.toContain('acceptedSubjectType');
  expect(older).not.toContain('GlobalRatingPopulation');
});

test('Context and observation v4 select their accepted shapes before shared base types', () => {
  const registry = buildCommandRegistry(authoredProfiles);
  const order = registry.canonical.map((entry) => entry.type);
  for (const [type, profile] of [
    ['AcceptedTargetRatingContext', realmTargetRatingContextV4Profile.id],
    ['AcceptedTargetRatingObservation', realmTargetRatingObservationV4Profile.id],
    ['AcceptedTargetRatingObservationRevision', realmTargetRatingObservationV4Profile.id],
  ]) {
    const iri = `https://rezics.com/vocab/${type}`;
    expect(
      registry.canonical.find((entry) => entry.type === iri)?.routes.map((route) => route.profile),
    ).toEqual([profile]);
    expect(order.indexOf(iri)).toBeLessThan(order.indexOf(iri.replace('Accepted', '')));
  }
  expect(profileSource(realmTargetRatingObservationV4Profile)).toContain('rv:acceptedSubjectType');
});
