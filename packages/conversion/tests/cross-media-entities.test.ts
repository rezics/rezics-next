import { expect, test } from 'bun:test';
import { liveActionWorkType } from '../src/bangumi-subject-profile.ts';
import {
  convertCrossMediaEntity,
  liveActionWorkType as entityLiveActionWorkType,
} from '../src/cross-media-entities.ts';

test('live-action platform grain lives on the subject-profile contract and entities re-export it', () => {
  expect(liveActionWorkType('movie')).toBe('schema:Movie');
  expect(liveActionWorkType('tv')).toBe('schema:TVSeries');
  expect(liveActionWorkType('unknown-platform')).toBeUndefined();
  expect(entityLiveActionWorkType).toBe(liveActionWorkType);
});

test('a Bangumi portrait survives staged replay with the original fact digest', () => {
  const sourceUrl = 'https://lain.bgm.tv/pic/crt/l/fixture.jpg';
  const input = { external_id: 'character:11546', record_revision: null, record: { id: 11546, name: 'Fixture' } };
  const context = { subjectId: '00000000-0000-4000-8000-000000000001' };
  const facts = convertCrossMediaEntity(input, context);
  const withPortrait = convertCrossMediaEntity(
    { ...input, record: { ...input.record, images: { large: sourceUrl } } },
    context,
  );
  const reopened = convertCrossMediaEntity({ ...input, record: withPortrait.normalizedRecord }, context);
  expect(withPortrait.digest).toBe(facts.digest);
  expect(reopened.digest).toBe(facts.digest);
  expect(reopened.mediaImportIntents.map((intent) => intent.sourceUrl)).toEqual([sourceUrl]);
});
