import { expect, test } from 'bun:test';
import {
  createMemberPageProgress,
  MEMBER_CURSOR_HISTORY_LIMIT,
  memberPageCursor,
} from '../src/features/pages/member-page-progress';

test('keeps advancing sparse pages finite and detects both recent and longer cycles', () => {
  const progress = createMemberPageProgress('start');
  for (let index = 0; index < 1000; index++) {
    expect(progress.accept(memberPageCursor({ members: [], next: `cursor-${index}` }))).toBe(true);
    expect(progress.retainedCursors).toBeLessThanOrEqual(MEMBER_CURSOR_HISTORY_LIMIT + 1);
  }
  expect(progress.accept('cursor-999')).toBe(false);
  const short = createMemberPageProgress('a');
  expect(short.accept('b')).toBe(true);
  expect(short.accept('a')).toBe(false);
  const long = createMemberPageProgress('0');
  let stopped = false;
  for (let index = 1; index < 200 && !stopped; index++) stopped = !long.accept(String(index % 31));
  expect(stopped).toBe(true);
  expect(long.retainedCursors).toBeLessThanOrEqual(MEMBER_CURSOR_HISTORY_LIMIT + 1);
  expect(createMemberPageProgress().accept()).toBe(true);
});
