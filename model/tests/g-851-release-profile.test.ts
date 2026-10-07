import { expect, test } from 'bun:test';
import { profileRegistry } from '../../packages/model/src/generated/profiles.ts';
import { createHash } from 'node:crypto';
import { profileSource } from '../compiler/shacl.ts';
import { releaseV2Profile } from '../definitions/release-v2.ts';
import { releaseV3Profile } from '../definitions/release-v3.ts';

test('G851: release-v3 pins exact per-entry coverage and retains the v2 profile', () => {
  for (const profile of [releaseV2Profile, releaseV3Profile]) {
    const sha256 = createHash('sha256').update(profileSource(profile)).digest('hex');
    expect(profileRegistry[profile.id].sha256).toBe(sha256);
  }
  const entry = releaseV3Profile.shapes.find((shape) => shape.iri.endsWith('/coverage-shape'))!;
  for (const predicate of ['work', 'realization', 'revision', 'contentLanguage', 'completeness']) {
    expect(entry.properties.find((property) => property.path === `rv:${predicate}`)).toMatchObject({
      minCount: 1,
      maxCount: 1,
    });
  }
  expect(entry.properties.find((property) => property.path === 'rv:portion')).toMatchObject({
    maxCount: 1,
  });
});
