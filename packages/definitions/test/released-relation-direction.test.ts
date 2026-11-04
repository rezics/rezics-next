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

  const changedTarget = structuredClone(bundledRelease);
  changedTarget.properties['wdt:P725']!.targets = ['missing:type'];
  const staleDescriptor = createReleasedRelationDirectionResolver(changedTarget, releaseDigest(changedTarget));
  expect(staleDescriptor.resolve('schema:Person', 'wdt:P725', 'forward')).toMatchObject({
    state: 'unavailable',
    reason: 'stale-descriptor',
  });
});
