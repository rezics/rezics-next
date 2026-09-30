import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { renderProfile } from '../compiler/ir.ts';
import { releaseV2Profile } from '../definitions/release-v2.ts';
import { releaseV3Profile } from '../definitions/release-v3.ts';

test('G851: release-v3 locks exact per-entry coverage and preserves the frozen v2 profile', () => {
  for (const profile of [releaseV2Profile, releaseV3Profile]) {
    const sha256 = createHash('sha256').update(renderProfile(profile)).digest('hex');
    expect(readFileSync(new URL(`../accepted/profiles/${profile.id}.json`, import.meta.url), 'utf8'))
      .toBe(`${JSON.stringify({ sha256 }, null, 2)}\n`);
  }
  const entry = releaseV3Profile.shapes.find(shape => shape.iri.endsWith('/coverage-shape'))!;
  for (const predicate of ['work', 'realization', 'revision', 'contentLanguage', 'completeness']) {
    expect(entry.properties.find(property => property.path === `rv:${predicate}`))
      .toMatchObject({ minCount: 1, maxCount: 1 });
  }
  expect(entry.properties.find(property => property.path === 'rv:portion')).toMatchObject({ maxCount: 1 });
});
