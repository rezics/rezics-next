import { expect, test } from 'bun:test';
import { renderProfile } from '../compiler/ir.ts';
import { buildCommandRegistry } from '../compiler/registry.ts';
import { authoredProfiles } from '../compiler/generate.ts';
import { realmTargetRatingContextV2Profile } from '../definitions/realm-target-rating-context-v2.ts';
import { realmTargetRatingContextV3Profile } from '../definitions/realm-target-rating-context-v3.ts';
import { realmTargetRatingObservationV3Profile } from '../definitions/realm-target-rating-observation-v3.ts';

const realmTargetRatingContextProfile = authoredProfiles.find(profile => profile.id === 'realm-target-rating-context-v1')!;

const contextShape = (profile: typeof realmTargetRatingContextV3Profile) => renderProfile(profile);

test('the v3 Context adds the projection grain and an optional bounded display threshold and leaves v1 and v2 as accepted', () => {
  const v3 = contextShape(realmTargetRatingContextV3Profile);
  expect(v3).toContain('sh:in ( rv:Release rv:Realization rv:Occurrence rv:Resource rv:Projection )');
  expect(v3).toContain('sh:path rv:displayThreshold ; sh:maxCount 1 ; sh:datatype xsd:integer ; sh:minInclusive 1 ; sh:maxInclusive 1000');
  expect(v3).not.toMatch(/rv:displayThreshold ; sh:minCount/);
  for (const older of [realmTargetRatingContextProfile, realmTargetRatingContextV2Profile]) {
    const rendered = renderProfile(older);
    expect(rendered).not.toContain('rv:Projection');
    expect(rendered).not.toContain('rv:displayThreshold');
  }
  // The scoped type selects the v3 shape; the language-tagged type of v2 does not ride along.
  expect(v3).toContain('sh:hasValue rv:ScopedTargetRatingContext');
  expect(v3).not.toContain('LanguageTagged');
});

test('Context and observation v3 route by their own scoped types, ahead of the types older profiles share', () => {
  const registry = buildCommandRegistry(authoredProfiles);
  const routes = (type: string) => registry.canonical.find(entry => entry.type === `https://rezics.com/vocab/${type}`)?.routes.map(route => route.profile);
  expect(routes('ScopedTargetRatingContext')).toEqual(['realm-target-rating-context-v3']);
  expect(routes('ScopedTargetRatingObservation')).toEqual(['realm-target-rating-observation-v3']);
  expect(routes('ScopedTargetRatingObservationRevision')).toEqual(['realm-target-rating-observation-v3']);
  // A scoped subject also carries the older base type; a v3 write must reach its own shape first.
  const order = registry.canonical.map(entry => entry.type);
  for (const [scoped, base] of [['ScopedTargetRatingContext', 'TargetRatingContext'],
    ['ScopedTargetRatingObservation', 'TargetRatingObservation'],
    ['ScopedTargetRatingObservationRevision', 'TargetRatingObservationRevision']]) {
    expect(order.indexOf(`https://rezics.com/vocab/${scoped}`)).toBeLessThan(order.indexOf(`https://rezics.com/vocab/${base}`));
  }
});

test('the v3 binding carries the threshold as an optional key only, and its observation shapes accept the projection grain', () => {
  expect(realmTargetRatingContextV3Profile.binding).toMatchObject({ optional: ['displayThreshold'],
    demandedBy: ['rv:ScopedTargetRatingContext'] });
  expect(realmTargetRatingContextV3Profile.binding.required).not.toContain('displayThreshold');
  expect(realmTargetRatingObservationV3Profile.binding).toMatchObject({
    demandedBy: ['rv:ScopedTargetRatingObservation', 'rv:ScopedTargetRatingObservationRevision'] });
  expect(renderProfile(realmTargetRatingObservationV3Profile)).toContain('rv:Resource rv:Projection )');
});
