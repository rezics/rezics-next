import { uuidToSid } from '@rezics/model/address';
import { spaceHref } from '../features/address/path.ts';
import { describe, expect, test } from 'bun:test';
import { markedSpoiler, threadPath } from '../features/feed/discussion.ts';
import {
  parseThreadSort,
  parseThreadWindow,
  replyTree,
  type ThreadReply,
} from '../features/feed/thread.ts';

const id = (value: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
function reply(value: number, parent: number | null): ThreadReply {
  return {
    reply: id(value),
    placement: id(1000 + value),
    parent: parent === null ? null : id(parent),
    author: null,
    time: '2026-09-28T07:38:50.000Z',
    language: 'en',
    revisionId: '00000000-0000-4000-a000-000000000001',
    title: parent === null ? `Discussion ${value}` : null,
    body: `Reply ${value}`,
    vote: { score: 0, value: 0, revision: null, open: true },
  };
}

describe('how a discussion reads', () => {
  test('a spoiler warning follows the declaration, never words in the title', () => {
    expect(markedSpoiler(true)).toBe(true);
    expect(markedSpoiler(false)).toBe(false);
    expect(markedSpoiler(undefined)).toBe(false);
  });

  test('a thread lives under its Realm’s address, by the reply’s SID', () => {
    expect(threadPath(spaceHref('fiction', 'community'), id(7))).toBe(
      // ast-grep-ignore: web-links-use-address -- Independent canonical expectation verifies the address builder without calling it again.
      `/r/fiction/discussions/${uuidToSid(id(7).slice(-36))}`,
    );
  });
});

describe('a thread laid out for reading', () => {
  test('replies nest under their parents in Main’s order, and each knows how many replies it holds', () => {
    const tree = replyTree([reply(1, null), reply(2, 1), reply(4, 2), reply(3, 1), reply(5, 4)])!;
    expect(tree.children.map((node) => node.reply.reply)).toEqual([id(2), id(3)]);
    expect(tree.children[0]!.children[0]!.children[0]).toMatchObject({
      depth: 3,
      reply: { reply: id(5) },
    });
    expect(tree.descendants).toBe(4);
    expect(tree.children[0]!.descendants).toBe(2);
  });

  test('a reply whose parent is not in the read is left out rather than guessed at', () => {
    expect(replyTree([reply(1, null), reply(3, 9)])!.children).toEqual([]);
    expect(replyTree([])).toBeNull();
  });

  test('sort and period come from the URL, Best this week when absent or unknown', () => {
    expect(parseThreadSort({ sort: 'top' })).toBe('top');
    expect(parseThreadSort({ sort: 'hot' })).toBe('best');
    expect(parseThreadWindow({ t: ['month', 'all'] })).toBe('month');
    expect(parseThreadWindow({})).toBe('week');
  });
});
