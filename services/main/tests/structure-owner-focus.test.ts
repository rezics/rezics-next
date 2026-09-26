import { expect, test } from 'bun:test';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { structureCreationValidations } from '../src/modules/structure/change.ts';
import { structureProfileFor } from '../src/modules/structure/profiles.ts';
import { GRAPHS, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('Structure create validates Collection and Zone owner links under their owner shapes', async () => {
  const environment = { fuseki: { commandHealth: async () => ({
    profiles: Object.fromEntries(Object.entries(profileRegistry).map(([id, profile]) =>
      [id, profile.sha256])),
  }) } } as unknown as WorkActivationEnvironment;
  const owner = 'https://rezics.com/id/11111111-1111-1111-1111-111111111111';
  const structure = 'https://rezics.com/id/22222222-2222-2222-2222-222222222222';
  const generation = 'https://rezics.com/id/33333333-3333-3333-3333-333333333333';
  const revision = 'https://rezics.com/id/44444444-4444-4444-4444-444444444444';
  for (const [profileId, ownerProfile, ownerShape] of [
    ['collection-membership', 'collection-curation-v1', 'collection-shape'],
    ['zone-navigation', 'zone-capability-v1', 'zone-shape'],
  ] as const) {
    const checks = await structureCreationValidations(environment, structureProfileFor(profileId),
      owner, structure, generation, revision);
    expect(checks).toHaveLength(4);
    expect(checks.slice(0, 3).map(check => check.focus))
      .toEqual([[structure], [generation], [revision]]);
    expect(checks[3]).toMatchObject({ profile: ownerProfile,
      shape: `https://rezics.com/definition/${ownerProfile}/${ownerShape}`,
      focus: [owner], graphs: [GRAPHS.current] });
  }
  expect(await structureCreationValidations(environment, structureProfileFor('book-composition'),
    owner, structure, generation, revision)).toHaveLength(3);
});
