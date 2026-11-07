import { expect, test } from 'bun:test';
import { createFeedApplication } from '../../src/content/application/index.ts';
import {
  FEED_CANDIDATE_LIMIT,
  FeedBoundExceededError,
  FeedRefusedError,
  type FeedApplicationPorts,
  type FeedContinuationSubject,
  type FeedItem,
  type FeedLaneCandidate,
  type FeedPublicSummary,
} from '../../src/content/contract/index.ts';
import { canonicalFeedObject, feedCandidateBound, mergeFeedLanes } from '../../src/content/core/index.ts';

const summary = (id: string, type = 'schema:Book'): FeedPublicSummary => ({
  id,
  type,
  types: [type],
  label: { value: id, language: 'en' },
  creativeWork: true,
  cover: null,
});

const continueRow = (id: string, at: string): FeedContinuationSubject => ({
  subjectId: id,
  state: 'active',
  lastActivityAt: at,
  activeProgressSession: null,
  subject: summary(id),
});

function item(source: 'discovery' | 'continue' | 'following', id: string, kind = 'schema:Book'): FeedItem {
  const key = { owner: 'semantic' as const, kind, route: 1, id };
  const destination = { kind: 'subject' as const, id, title: id };
  const row = { id: `${source}:${id}`, key, occurredAt: null, summary: summary(id, kind), destination };
  if (source === 'continue') return { ...row, source, continue: continueRow(id, '2026-01-01T00:00:00.000Z') };
  if (source === 'discovery') return { ...row, source };
  return { ...row, source };
}

function ports(overrides: Partial<FeedApplicationPorts> = {}): FeedApplicationPorts {
  return {
    admission: {
      following: async () => undefined,
      personalLibrary: async () => undefined,
      readingProgress: async () => undefined,
      discovery: async () => undefined,
    },
    cursor: {
      fingerprint: (value) => JSON.stringify(value),
      encode: async () => 'cursor',
      decode: async () => {
        throw new FeedRefusedError('invalid_cursor');
      },
    },
    space: {
      open: async () => {
        throw new FeedRefusedError('not_found');
      },
      openPopulation: async () => undefined,
    },
    finish: {
      beginConversation: async () => ({}),
      confirmConversation: async (items) => ({ items }),
      contentContext: async (items) => ({ items }),
      reactions: async (items) => ({ items }),
      reactionAdvice: async (items) => ({ items }),
      subjectReactions: async (items) => ({ items }),
      followSupport: async (items) => ({ items }),
      personalActions: async (items) => ({ items }),
      reopenSelected: async (items) => items,
    },
    classifyFailure: () => 'unavailable',
    refuse: (code) => {
      throw new FeedRefusedError(code);
    },
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

test('missing continuation, discovery and following producers stay unavailable rather than empty or all-candidate', async () => {
  const page = await createFeedApplication(ports(), { route: () => 1 }).list(
    {
      kind: 'account',
      accountId: '00000000-0000-4000-8000-000000000001',
      scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    },
    { stream: 'home', limit: 20 },
    1,
    ['en'],
  );
  expect(page.feedItems).toEqual([]);
  expect(page.sources).toEqual({ discovery: 'unavailable', following: 'unavailable', continue: 'unavailable' });
  expect(page.next).toBeNull();
});

test('exact kind conjunction drops other kinds without refill and keeps Continue examined positions', async () => {
  const continueRows = [
    continueRow('00000000-0000-4000-8000-0000000000aa', '2026-01-01T00:00:01.000Z'),
    {
      ...continueRow('00000000-0000-4000-8000-0000000000bb', '2026-01-01T00:00:02.000Z'),
      subject: summary('00000000-0000-4000-8000-0000000000bb', 'schema:Movie'),
    },
  ];
  const page = await createFeedApplication(
    ports({
      continuation: {
        page: async () => ({ subjects: continueRows, next: 'more' }),
      },
      discovery: {
        page: async () => ({
          candidates: [
            { item: item('discovery', '00000000-0000-4000-8000-0000000000cc', 'schema:Book') },
            { item: item('discovery', '00000000-0000-4000-8000-0000000000dd', 'schema:Movie') },
          ],
          next: false,
        }),
      },
      following: {
        page: async () => ({ candidates: [], next: false }),
      },
    }),
    { route: () => 1 },
  ).list(
    {
      kind: 'account',
      accountId: '00000000-0000-4000-8000-000000000001',
      scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    },
    { stream: 'home', limit: 20, kind: 'schema:Book' },
    1,
    ['en'],
  );
  expect(page.feedItems.map((entry) => entry.key.id)).toEqual([
    '00000000-0000-4000-8000-0000000000aa',
    '00000000-0000-4000-8000-0000000000cc',
  ]);
  expect(page.sources.continue).toBe('ready');
});

test('sparse Continue resume skips the examined key and refuses a changed fingerprint', async () => {
  const rows = [
    continueRow('00000000-0000-4000-8000-0000000000aa', '2026-01-01T00:00:01.000Z'),
    continueRow('00000000-0000-4000-8000-0000000000bb', '2026-01-01T00:00:02.000Z'),
  ];
  const fingerprint = (value: unknown) => JSON.stringify(value);
  const reads = createFeedApplication(
    ports({
      cursor: {
        fingerprint,
        encode: async (_actor, _query, _languages, position) => JSON.stringify(position),
        decode: async () => ({
          boundary: '2026-01-01T00:00:00.000Z',
          turn: 0,
          discovery: false,
          following: false,
          continue: 'head',
          resume: {
            fingerprint: fingerprint(rows.map((row) => [row.subjectId, row.lastActivityAt])),
            after: fingerprint([rows[0]!.subjectId, rows[0]!.lastActivityAt]),
          },
        }),
      },
      continuation: { page: async () => ({ subjects: rows, next: null }) },
      following: { page: async () => ({ candidates: [], next: false }) },
    }),
    { route: () => 1 },
  );
  const actor = {
    kind: 'account' as const,
    accountId: '00000000-0000-4000-8000-000000000001',
    scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
  };
  const page = await reads.list(actor, { stream: 'home', limit: 20, cursor: 'opaque' }, 1, ['en']);
  expect(page.feedItems.map((entry) => entry.key.id)).toEqual(['00000000-0000-4000-8000-0000000000bb']);
  await expect(
    createFeedApplication(
      ports({
        cursor: {
          fingerprint,
          encode: async () => 'x',
          decode: async () => ({
            boundary: '2026-01-01T00:00:00.000Z',
            turn: 0,
            discovery: false,
            following: false,
            continue: 'head',
            resume: { fingerprint: 'other', after: 'gone' },
          }),
        },
        continuation: { page: async () => ({ subjects: rows, next: null }) },
      }),
      { route: () => 1 },
    ).list(actor, { stream: 'home', cursor: 'opaque' }, 1, ['en']),
  ).rejects.toMatchObject({ name: 'FeedRefusedError', code: 'stale_cursor' });
});

test('one renderer keeps page 20, candidate 160, Continue 6 and no all-candidate fallback', () => {
  expect(feedCandidateBound(7, 7, true)).toBeLessThanOrEqual(FEED_CANDIDATE_LIMIT);
  const lanes: Record<'continue' | 'following' | 'discovery', FeedLaneCandidate[]> = {
    continue: [{ item: item('continue', 'a') }, { item: null, after: 'skip' }],
    following: [{ item: item('following', 'a') }],
    discovery: [{ item: item('discovery', 'b') }],
  };
  const merged = mergeFeedLanes({ lanes, turn: 0, limit: 20 });
  expect(merged.items.map((entry) => `${entry.source}:${canonicalFeedObject(entry)}`)).toEqual([
    'continue:semantic:a',
    'discovery:semantic:b',
  ]);
  expect(() => {
    throw new FeedBoundExceededError();
  }).toThrow('Feed native candidate bound exceeded');
});
