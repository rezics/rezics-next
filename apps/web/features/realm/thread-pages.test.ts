import { expect, test } from 'bun:test';
import { spaceHref, threadHref } from '../address/path.ts';
import { storyThread } from '../feed/thread-fixtures.ts';
import { mergeThreadPage, threadContinuationHref } from './thread-pages.ts';

test('a route fallback retains the exact sibling cursor, order and language', () => {
  const url = new URL(threadContinuationHref(threadHref(spaceHref('garden', 'community'), storyThread.focus), 'sort=new&language=ja', 'siblings/+=='), 'https://contract.invalid');
  expect(Object.fromEntries(url.searchParams)).toEqual({ sort: 'new', language: 'ja', cursor: 'siblings/+==' });
});

test('a sibling continuation replaces only its control and retains depth and ancestor routes', () => {
  const reply = storyThread.items[0]!.reply;
  const consumed = { kind: 'siblings' as const, reply, cursor: 'siblings/+==' };
  const depth = { kind: 'depth' as const, reply: storyThread.items[1]!.reply };
  const ancestors = { kind: 'ancestors' as const, reply: storyThread.items[2]!.reply };
  const current = { ...storyThread, continuations: [consumed, depth, ancestors], complete: false };
  const page = { ...storyThread, focus: reply, items: [storyThread.items[0]!], continuations: [] };
  const merged = mergeThreadPage(current, page, consumed);
  expect(merged.items).toEqual(storyThread.items);
  expect(merged.continuations).toEqual([depth, ancestors]);
  expect(merged.complete).toBe(false);
  expect(current.continuations).toEqual([consumed, depth, ancestors]);
});

test('a continuation cannot inject a different Realm, Work, root revision, focus or order', () => {
  const consumed = { kind: 'siblings' as const, reply: storyThread.focus, cursor: 'siblings/+==' };
  for (const change of [{ realm: 'another' }, { work: { ...storyThread.work, id: 'another' } },
    { rootRevision: 'another' }, { focus: 'another' }, { sort: 'new' as const }]) {
    expect(() => mergeThreadPage(storyThread, { ...storyThread, ...change }, consumed)).toThrow('Thread continuation changed');
  }
});
