import { expect, test } from 'bun:test';
import { releaseSeedPlan } from './releases-step.ts';

test('the release seed records Hant and Hans print editions, an English translation, and two fixture snapshots', () => {
  const [hant, hans, english] = releaseSeedPlan.editions;
  expect(hant?.contentLanguages).toEqual(['zh-Hant']);
  expect(hans?.contentLanguages).toEqual(['zh-Hans']);
  expect(english).toMatchObject({ isTranslation: true, originalLanguages: ['zh'], contentLanguages: ['en'] });
  expect(releaseSeedPlan.serial.snapshots).toHaveLength(2);
  expect(releaseSeedPlan.serial.originalUrl).toBe('https://example.com/star-harbor');
  expect(JSON.stringify(releaseSeedPlan)).not.toContain('"mul"');
  expect(releaseSeedPlan.serial.snapshots.every(snapshot => snapshot.coverage.complete === false)).toBe(true);
});
