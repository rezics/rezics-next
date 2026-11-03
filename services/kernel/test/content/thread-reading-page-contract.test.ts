import { expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { Compile } from 'typebox/compile';
import type { Actor } from '../../src/request/access.ts';
import {
  READING_CARD_REFERENCE_LIMIT,
  ReadingPageQuerySchema,
  ReadingPageResponseSchema,
  normalizeSelectedReadingCardReferences,
  readingPageOperationState,
  readingPageReactionCoverageState,
  readingPageRawLimit,
} from '../../src/content/reading-page.ts';

const id = (tail: string) => `00000000-0000-4000-8000-${tail.padStart(12, '0')}`;
const boardId = id('1');
const threadId = id('2');
const authorId = id('3');
const openingId = id('4');
const timestamp = '2026-01-02T03:04:05.000Z';

function item(itemId: string, parentId: string | null) {
  return {
    id: itemId,
    threadId,
    route: 0,
    authorId,
    parentId,
    licence: 'MIT',
    subjectIds: [],
    boardId,
    visibility: 'published',
    securityRevision: '1',
    availability: 'available',
    createdAt: timestamp,
    revisedAt: null,
    sha256: 'a'.repeat(64),
    mediaIds: [],
    voteCitation: null,
    revisionId: id('5'),
    body: fromPlainText('Reading page item'),
  };
}

function response(replyCount: number) {
  const firstPost = item(openingId, null);
  return {
    target: { threadId, boardId, boardSecurityRevision: '1' },
    viewer: { kind: 'anonymous' },
    query: { cursor: null, limit: 20 },
    thread: {
      id: threadId,
      route: 0,
      authorId,
      kind: 'discussion',
      title: 'Reading page',
      licence: 'MIT',
      subjectIds: [],
      boardId,
      visibility: 'published',
      securityRevision: '1',
      availability: 'available',
      createdAt: timestamp,
      firstPost,
    },
    replies: {
      items: Array.from({ length: replyCount }, (_, index) => item(id(String(index + 10)), openingId)),
      next: null,
    },
    authors: { state: 'current', retryable: false, items: [] },
    actions: {
      state: 'current',
      retryable: false,
      references: [{ type: 'content.thread', id: threadId, state: 'current', operations: [] }],
      reply: { state: 'sign_in_required' },
    },
    watch: { state: 'sign_in_required' },
    slowMode: { state: 'unavailable', retryable: true },
    currentness: {
      source: 'current',
      place: 'current',
      reactions: 'current',
      authors: 'current',
      actions: 'current',
      watch: 'sign_in_required',
      slowMode: 'unavailable',
    },
    reactionsAsOf: null,
  };
}

test('reading-page cursor, reply and withheld-entry bounds are closed', () => {
  const query = Compile(ReadingPageQuerySchema);
  const page = Compile(ReadingPageResponseSchema);
  expect(readingPageRawLimit()).toBe(21);
  expect(readingPageRawLimit('next')).toBe(20);
  expect(query.Check({ cursor: 'x'.repeat(4096) })).toBe(true);
  expect(query.Check({ cursor: 'x'.repeat(4097) })).toBe(false);
  expect(page.Check(response(0))).toBe(true);
  expect(page.Check(response(20))).toBe(true);
  expect(page.Check(response(21))).toBe(false);
  const withheld = response(1);
  withheld.replies.items[0] = {
    id: id('10'),
    threadId,
    route: 0,
    parentId: openingId,
    removed: true,
    availability: 'withheld',
    body: null,
    sha256: null,
    authorId,
    decisionId: id('6'),
  } as (typeof withheld.replies.items)[number];
  expect(page.Check(withheld)).toBe(false);
  const unavailableReactions = response(0);
  unavailableReactions.currentness.reactions = 'unavailable';
  expect(page.Check(unavailableReactions)).toBe(true);
});

test('selected reading-card references keep exact keys and close raw and reaction coverage bounds', () => {
  const selected = Array.from({ length: READING_CARD_REFERENCE_LIMIT }, (_, index) => ({
    type: 'content.thread' as const,
    id: id(String(index + 100)),
    placeId: boardId,
    sourceRevisionId: id(String(index + 200)),
    subjectId: id('300'),
  }));
  expect(normalizeSelectedReadingCardReferences([])).toEqual([]);
  expect(normalizeSelectedReadingCardReferences(selected)).toEqual(selected);
  expect(normalizeSelectedReadingCardReferences([selected[0]!, selected[0]!])).toEqual([selected[0]!]);
  const postReference = {
    type: 'content.post' as const,
    id: id('401'),
    threadId: threadId,
    placeId: boardId,
    threadRevisionId: id('402'),
    sourceRevisionId: id('403'),
  };
  expect(normalizeSelectedReadingCardReferences([postReference])).toEqual([postReference]);
  expect(() => normalizeSelectedReadingCardReferences([...selected, selected[0]!])).toThrow();
  expect(() =>
    normalizeSelectedReadingCardReferences([
      selected[0]!,
      { ...selected[0]!, placeId: id('301') },
    ]),
  ).toThrow();
  expect(readingPageReactionCoverageState(['thread', 'opening'], new Set(['thread']))).toBe('unavailable');
  expect(readingPageReactionCoverageState(['thread', 'opening'], new Set(['thread', 'opening']))).toBe('current');
});

test('mounted guest authentication stays distinct from denial and dependency failure', () => {
  const guest = { kind: 'anonymous' } as Actor;
  const watching = { state: 'current' as const, watching: false };
  expect(
    readingPageOperationState(guest, 'post.create', new Set(), new Map([['post.create', 'authenticated']]), watching),
  ).toBe('sign_in_required');
  expect(
    readingPageOperationState(guest, 'report.create', new Set(), new Map([['report.create', 'anonymous']]), watching),
  ).toBe('denied');
  expect(readingPageOperationState(guest, 'post.create', new Set(), new Map(), watching)).toBe('unavailable');
  expect(
    readingPageOperationState(
      guest,
      'post.create',
      new Set(['post.create']),
      new Map([['post.create', 'anonymous']]),
      watching,
    ),
  ).toBe('available');
});
