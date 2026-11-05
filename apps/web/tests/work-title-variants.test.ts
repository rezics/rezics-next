import { expect, test } from 'bun:test';
import type { Subject } from '../src/subject/types';
import { WORK_NAMES_BYTES, supportsWorkNames, workNames } from '../src/features/catalogue/work-names/model';

export function work(): Subject {
  return {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000910',
    type: 'wd:Q689445',
    labels: { ja: '海の物語', 'zh-Hant': '海的故事' },
    aliases: { ja: ['海の物語', '海ノ物語', '海の物語！'], fr: ['La mer', 'La mér'] },
    descriptions: {},
    statements: {},
  } as Subject;
}

test('all supplied languages retain exact spelling and roles without guessing original language', () => {
  const names = workNames(work(), 'en');
  expect(names.state).toBe('ready');
  if (names.state !== 'ready') return;
  expect(names.originalLanguage).toBeUndefined();
  expect(names.original).toBeUndefined();
  expect(names.selected.text).toBe('海の物語');
  expect(names.groups[0]?.names).toEqual([
    { text: '海の物語', roles: ['title', 'alias'] },
    { text: '海ノ物語', roles: ['alias'] },
    { text: '海の物語！', roles: ['alias'] },
  ]);
  expect(names.groups[2]?.names.map((name) => name.text)).toEqual(['La mer', 'La mér']);
  expect(supportsWorkNames('custom:Novel', ['schema:Book'])).toBe(true);
  expect(supportsWorkNames('schema:Person')).toBe(false);
});

test('over-budget admitted terms are unavailable, never silently truncated', () => {
  const subject = work();
  subject.aliases = { ja: ['海'.repeat(WORK_NAMES_BYTES)] };
  expect(workNames(subject, 'ja').state).toBe('unavailable');
});
