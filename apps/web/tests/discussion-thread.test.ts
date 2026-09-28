import { describe, expect, test } from 'bun:test';
import { announcesSpoilers, discussionText, threadPath } from '../features/feed/discussion.ts';
import { parseThreadSort, parseThreadWindow, replyTree, type ThreadReply } from '../features/feed/thread.ts';

const id = (value: number) => `https://rezics.com/id/00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
function reply(value: number, parent: number | null): ThreadReply {
  return { reply: id(value), placement: id(1000 + value), parent: parent === null ? null : id(parent), author: null,
    time: '2026-09-28T07:38:50.000Z', language: 'en', revisionId: '00000000-0000-4000-a000-000000000001',
    body: `Reply ${value}`, vote: { score: 0, value: 0, revision: null, open: true } };
}

describe('how a discussion reads', () => {
  test('the author’s first line is the title and the rest is the body', () => {
    expect(discussionText('【本周共读】《雨夜书店》第一章 雨夜\n这周我们读第一章。\n\n我最喜欢开头那句。'))
      .toEqual({ title: '【本周共读】《雨夜书店》第一章 雨夜', body: '这周我们读第一章。\n\n我最喜欢开头那句。' });
    expect(discussionText('  Share your smallest useful prompt  ')).toEqual({ title: 'Share your smallest useful prompt',
      body: '' });
  });

  test('a first line too long for a title keeps every word, the overflow opening the body', () => {
    const line = 'x'.repeat(320);
    const { title, body } = discussionText(`${line}\nsecond`);
    expect(Array.from(title)).toHaveLength(301);
    expect(`${title.slice(0, -1)}${body}`).toBe(`${line}\nsecond`);
  });

  test('only a spoiler the author announced at the start of the title veils the body', () => {
    for (const title of ['【剧透】《雨夜书店》第二章：那张旧车票', 'Spoilers (chapter 35): Darcy’s letter',
      '[Spoiler] the ending', 'ネタバレ注意：最終章']) expect(announcesSpoilers(title)).toBe(true);
    for (const title of ['No spoilers please: first impressions', 'Which edition of Jane Eyre for a first read?',
      '[Solved] Lumen Lanterns render as black cubes']) expect(announcesSpoilers(title)).toBe(false);
  });

  test('a thread lives under its Realm’s address, by the reply’s UUID', () => {
    expect(threadPath('/r/fiction', id(7))).toBe('/r/fiction/discussions/00000000-0000-4000-8000-000000000007');
  });
});

describe('a thread laid out for reading', () => {
  test('replies nest under their parents in Main’s order, and each knows how many replies it holds', () => {
    const tree = replyTree([reply(1, null), reply(2, 1), reply(4, 2), reply(3, 1), reply(5, 4)])!;
    expect(tree.children.map(node => node.reply.reply)).toEqual([id(2), id(3)]);
    expect(tree.children[0]!.children[0]!.children[0]).toMatchObject({ depth: 3, reply: { reply: id(5) } });
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
