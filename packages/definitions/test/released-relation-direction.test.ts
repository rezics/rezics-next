import { expect, test } from 'bun:test';
import { createReleasedRelationDirectionResolver, releaseDigest } from '@rezics/definitions';
import { bundledDigest, bundledRelease } from '../src/bundled.ts';

test('public resolver preserves missing, stale, ambiguous and inapplicable outcomes', () => {
  expect(
    createReleasedRelationDirectionResolver(undefined, undefined).resolve('schema:Person', 'wdt:P725', 'inverse'),
  ).toMatchObject({ state: 'unavailable', release: null, reason: 'missing-release-pin' });
  const stale = createReleasedRelationDirectionResolver(bundledRelease, 'sha256:stale');
  expect(stale.resolve('schema:Person', 'wdt:P725', 'inverse')).toMatchObject({
    state: 'unavailable',
    reason: 'stale-release',
  });

  const directions = createReleasedRelationDirectionResolver(bundledRelease, bundledDigest);
  expect(directions.resolve('schema:Person', 'rezics:notReleased', 'forward')).toMatchObject({
    state: 'unsupported',
    reason: 'missing-property',
  });
  expect(directions.resolve('schema:Person', 'rezics:notReleased', 'inverse')).toMatchObject({
    state: 'unsupported',
    reason: 'missing-inverse',
  });
  expect(directions.resolve('wd:Q95074', 'wdt:P453', 'inverse')).toMatchObject({
    state: 'unsupported',
    reason: 'ambiguous-inverse',
  });
  expect(directions.resolve('schema:Movie', 'wdt:P725', 'inverse')).toMatchObject({
    state: 'unsupported',
    reason: 'inapplicable-type',
  });
  expect(directions.resolve('bf:Instance', 'schema:exampleOfWork', 'inverse')).toMatchObject({
    state: 'admitted',
    property: 'schema:exampleOfWork',
    targetTypes: ['schema:CreativeWork'],
  });
  for (const type of ['schema:Book', 'schema:VideoGame']) {
    expect(directions.resolve(type, 'rezics:stylisticallyComparableTo', 'forward')).toMatchObject({
      state: 'admitted',
      property: 'rezics:stylisticallyComparableTo',
    });
    expect(directions.resolve(type, 'rezics:stylisticallyComparableTo', 'inverse')).toMatchObject({
      state: 'admitted',
      property: 'rezics:stylisticallyComparableTo',
    });
  }
  expect(directions.resolve('wd:Q689445', 'rezics:stylisticallyComparableTo', 'forward')).toMatchObject({
    state: 'admitted',
    property: 'rezics:stylisticallyComparableTo',
  });
  expect(directions.resolve('wd:Q689445', 'rezics:stylisticallyComparableTo', 'inverse')).toMatchObject({
    state: 'admitted',
    property: 'rezics:stylisticallyComparableTo',
  });
  for (const type of ['schema:CreativeWork', 'bf:Instance', 'skos:Concept']) {
    expect(directions.resolve(type, 'rezics:stylisticallyComparableTo', 'forward')).toMatchObject({
      state: 'unsupported',
      reason: 'inapplicable-type',
    });
    expect(directions.resolve(type, 'rezics:stylisticallyComparableTo', 'inverse')).toMatchObject({
      state: 'unsupported',
      reason: 'inapplicable-type',
    });
  }

  const changedTarget = structuredClone(bundledRelease);
  changedTarget.properties['wdt:P725']!.targets = ['missing:type'];
  const staleDescriptor = createReleasedRelationDirectionResolver(changedTarget, releaseDigest(changedTarget));
  expect(staleDescriptor.resolve('schema:Person', 'wdt:P725', 'forward')).toMatchObject({
    state: 'unavailable',
    reason: 'stale-descriptor',
  });
});
