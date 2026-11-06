import { expect, test } from 'bun:test';
import { liveActionWorkType } from '../src/bangumi-subject-profile.ts';
import { liveActionWorkType as entityLiveActionWorkType } from '../src/cross-media-entities.ts';

test('live-action platform grain lives on the subject-profile contract and entities re-export it', () => {
  expect(liveActionWorkType('movie')).toBe('schema:Movie');
  expect(liveActionWorkType('tv')).toBe('schema:TVSeries');
  expect(liveActionWorkType('unknown-platform')).toBeUndefined();
  expect(entityLiveActionWorkType).toBe(liveActionWorkType);
});
