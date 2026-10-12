import { expect, test } from 'bun:test';
import { MemberReads } from './members-state.ts';

test('a command refresh uses the latest submitted filter and supersedes pending searches', () => {
  const reads = new MemberReads();
  const first = reads.replace('daniel');
  const latest = reads.replace('sophie');
  expect(reads.search).toBe('sophie');
  const refresh = reads.replace();
  expect(refresh).toEqual({ search: 'sophie', after: null });
  expect(reads.finish(first, true)).toBe(false);
  expect(reads.finish(latest, true)).toBe(false);
  expect(reads.canAppend).toBe(false);
  expect(reads.finish(refresh, true)).toBe(true);
  expect(reads.canAppend).toBe(true);
});

test('pagination only extends a settled replacement and never supersedes a refresh', () => {
  const reads = new MemberReads();
  const search = reads.replace('sophie');
  expect(reads.append('old-cursor')).toBeNull();
  expect(reads.finish(search, true)).toBe(true);
  const page = reads.append('current-cursor')!;
  expect(page).toEqual({ search: 'sophie', after: 'current-cursor' });
  expect(reads.append('current-cursor')).toBeNull();
  const refresh = reads.replace();
  expect(reads.append('current-cursor')).toBeNull();
  expect(reads.finish(page, true)).toBe(false);
  expect(reads.finish(refresh, false)).toBe(true);
  expect(reads.append('current-cursor')).toBeNull();
  const retry = reads.replace();
  expect(reads.finish(retry, true)).toBe(true);
  const next = reads.append('new-cursor')!;
  expect(reads.finish(next, false)).toBe(true);
  expect(reads.append('new-cursor')).toEqual({ search: 'sophie', after: 'new-cursor' });
});
