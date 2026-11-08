import { expect, expectTypeOf, test } from 'bun:test';
import { createFeedApplication } from '../../src/content/application/index.ts';
import type { PublicCollectionDiscoverySummary as CollectionCard } from '../../src/library/index.ts';
import type { ViewerPersonalActionsPage } from '../../src/library/index.ts';
import type { PublicCollectionDiscoverySummary as CollectionSummary } from '../../src/search/index.ts';
import { Value } from 'typebox/value';
import {
  FEED_CANDIDATE_LIMIT,
  FeedBoundExceededError,
  FeedRefusedError,
  type FeedApplicationPorts,
  type FeedContinuationSubject,
  type FeedItem,
  type FeedLaneCandidate,
  type FeedPage,
  type FeedPosition,
  type FeedPublicSummary,
} from '../../src/content/contract/index.ts';
import { canonicalFeedObject, feedCandidateBound, mergeFeedLanes } from '../../src/content/core/index.ts';
import { FeedPageSchema } from '../../src/content/feed-contract.ts';

type CollectionFeedItem = Extract<FeedItem, { key: { owner: 'commerce'; kind: 'collection' } }>;
expectTypeOf<CollectionFeedItem['summary']['card']>().toEqualTypeOf<CollectionCard>();
expectTypeOf<CollectionFeedItem['summary']>().toEqualTypeOf<CollectionSummary>();
expectTypeOf<FeedPage['viewerPersonalActions']>().toEqualTypeOf<ViewerPersonalActionsPage | undefined>();
expectTypeOf<
  Awaited<ReturnType<FeedApplicationPorts['finish']['personalActions']>>['viewerPersonalActions']
>().toEqualTypeOf<ViewerPersonalActionsPage | undefined>();

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
    question: {
      open: async () => {
        throw new FeedRefusedError('dependency_unavailable');
      },
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
  expect(page.viewerPersonalActions).toBeUndefined();
  expect(page.next).toBeNull();
});

test('current Collection cards and viewer actions keep their installed types and serialize through the FeedPage schema', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const card: CollectionCard = {
    kind: 'collection',
    id,
    destination: `/collections/${id}`,
    title: 'A public collection',
    description: null,
    visibility: 'public',
    revision: 1,
    sourceGeneration: '1',
    presentationKind: null,
    presentationKindSource: 'mixed',
    cover: null,
    coverSource: 'none',
    curator: { state: 'unavailable', reason: 'withheld' },
    preview: { state: 'empty' },
    membershipKind: 'curated',
    memberCount: 0,
    orderEpoch: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const summary: CollectionSummary = { id, title: card.title, description: null, card };
  const collection: CollectionFeedItem = {
    id: `discovery:${id}`,
    source: 'discovery',
    key: { owner: 'commerce', kind: 'collection', route: 1, id },
    occurredAt: null,
    summary,
    destination: { kind: 'collection', id, title: card.title },
  };
  const viewerPersonalActions: ViewerPersonalActionsPage = { state: 'current', question: null, rows: [] };
  const defaults = ports();
  const page = await createFeedApplication(
    {
      ...defaults,
      discovery: {
        page: async () => ({ candidates: [{ item: collection }], next: false, asOf: '2026-01-01T00:00:00.000Z' }),
      },
      finish: {
        ...defaults.finish,
        personalActions: async (items) => ({ items, viewerPersonalActions }),
      },
    },
    { route: () => 1 },
  ).list(
    {
      kind: 'account',
      accountId: '00000000-0000-4000-8000-000000000002',
      scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    },
    { stream: 'home', limit: 20 },
    Date.now() + 30_000,
    ['en'],
  );

  expect(page.feedItems).toEqual([collection]);
  expect(page.viewerPersonalActions).toEqual(viewerPersonalActions);
  expect(Value.Check(FeedPageSchema(), page)).toBe(true);
  expect(JSON.parse(JSON.stringify(page))).toEqual(page);
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

test('current question, kind and Space intersect the three bounded Home lanes and retain sparse frontiers', async () => {
  const questionId = '00000000-0000-4000-8000-0000000000f1';
  const spaceId = '00000000-0000-4000-8000-0000000000f2';
  const [continueMatch, continueAbsent, followingMatch, followingAbsent, discoveryMatch, discoveryAbsent] = [
    '00000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000052',
    '00000000-0000-4000-8000-000000000053',
    '00000000-0000-4000-8000-000000000054',
    '00000000-0000-4000-8000-000000000055',
    '00000000-0000-4000-8000-000000000056',
  ];
  const [continueNext, followingNext, discoveryNext] = [
    '00000000-0000-4000-8000-000000000057',
    '00000000-0000-4000-8000-000000000058',
    '00000000-0000-4000-8000-000000000059',
  ];
  const admitted = new Set([continueMatch, followingMatch, discoveryMatch, continueNext, followingNext, discoveryNext]);
  const seen: { discovery?: unknown; following?: unknown; continuation?: unknown } = {};
  let encodedPosition: FeedPosition | undefined;
  const defaults = ports();
  const page = await createFeedApplication(
    {
      ...defaults,
      question: {
        open: async (_actor, id) => {
          expect(id).toBe(questionId);
          return {
            id,
            revision: 7,
            qualify: async (candidates) =>
              candidates.map(({ item }) =>
                item?.destination.kind === 'subject' && admitted.has(item.destination.id) ? 'current' : 'absent',
              ),
            finish: async () => undefined,
          };
        },
      },
      cursor: {
        fingerprint: (value) => JSON.stringify(value),
        encode: async (_actor, _query, _languages, position) => {
          encodedPosition = position;
          return 'selected-question-next';
        },
        decode: async () => encodedPosition!,
      },
      space: {
        open: async (_actor, id) => {
          expect(id).toBe(spaceId);
          return { spaceId, finish: async () => undefined };
        },
        openPopulation: async (_actor, selected) => ({ spaceId: selected.spaceId, finish: async () => undefined }),
      },
      continuation: {
        page: async (_actor, query) => {
          seen.continuation = query;
          if (query.cursor) return { subjects: [continueRow(continueNext, '2026-01-01T00:00:03.000Z')], next: null };
          return {
            subjects: [
              continueRow(continueMatch, '2026-01-01T00:00:02.000Z'),
              continueRow(continueAbsent, '2026-01-01T00:00:01.000Z'),
            ],
            next: 'continue-next',
          };
        },
      },
      following: {
        page: async (input) => {
          seen.following = input;
          if (input.cursor) return { candidates: [{ item: item('following', followingNext) }], next: false };
          return {
            candidates: [{ item: item('following', followingMatch) }, { item: item('following', followingAbsent) }],
            next: 'following-next',
          };
        },
      },
      discovery: {
        page: async (input) => {
          seen.discovery = input;
          if (input.cursor) return { candidates: [{ item: item('discovery', discoveryNext) }], next: false };
          return {
            candidates: [{ item: item('discovery', discoveryMatch) }, { item: item('discovery', discoveryAbsent) }],
            next: 'discovery-next',
          };
        },
      },
    },
    { route: () => 1 },
  ).list(
    {
      kind: 'account',
      accountId: '00000000-0000-4000-8000-000000000001',
      scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    },
    { stream: 'home', limit: 20, kind: 'schema:Book', spaceId, ratingQuestionId: questionId },
    1,
    ['en'],
  );

  expect(page.feedItems.map((row) => [row.source, row.key.id])).toEqual([
    ['continue', continueMatch],
    ['following', followingMatch],
    ['discovery', discoveryMatch],
  ]);
  expect(page.sources).toEqual({ discovery: 'ready', following: 'ready', continue: 'ready' });
  expect(page.next).toBe('selected-question-next');
  expect(encodedPosition?.ratingQuestionRevision).toBe(7);
  expect(seen.continuation).toMatchObject({ kind: 'schema:Book', spaceId });
  expect(seen.following).toMatchObject({ kind: 'schema:Book', space: { spaceId } });
  expect(seen.discovery).toMatchObject({ kind: 'schema:Book', spaceId });
  expect(encodedPosition?.ratingQuestionRevision).toBe(7);

  const nextPage = await createFeedApplication(
    {
      ...defaults,
      question: {
        open: async (_actor, id) => ({
          id,
          revision: 7,
          qualify: async (candidates) =>
            candidates.map(({ item }) =>
              item?.destination.kind === 'subject' && admitted.has(item.destination.id) ? 'current' : 'absent',
            ),
          finish: async () => undefined,
        }),
      },
      cursor: {
        fingerprint: (value) => JSON.stringify(value),
        encode: async () => 'selected-question-end',
        decode: async () => encodedPosition!,
      },
      space: {
        open: async () => ({ spaceId, finish: async () => undefined }),
        openPopulation: async () => ({ spaceId, finish: async () => undefined }),
      },
      continuation: {
        page: async (_actor, query) => {
          expect(query.cursor).toBe('continue-next');
          return { subjects: [continueRow(continueNext, '2026-01-01T00:00:03.000Z')], next: null };
        },
      },
      following: {
        page: async (input) => {
          expect(input.cursor).toBe('following-next');
          return { candidates: [{ item: item('following', followingNext) }], next: false };
        },
      },
      discovery: {
        page: async (input) => {
          expect(input.cursor).toBe('discovery-next');
          return { candidates: [{ item: item('discovery', discoveryNext) }], next: false };
        },
      },
    },
    { route: () => 1 },
  ).list(
    {
      kind: 'account',
      accountId: '00000000-0000-4000-8000-000000000001',
      scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
    },
    {
      stream: 'home',
      limit: 20,
      kind: 'schema:Book',
      spaceId,
      ratingQuestionId: questionId,
      cursor: 'selected-question-next',
    },
    1,
    ['en'],
  );
  expect(nextPage.feedItems.map((row) => row.key.id)).toEqual([continueNext, followingNext, discoveryNext]);
  expect(nextPage.sources).toEqual({ discovery: 'ready', following: 'ready', continue: 'ready' });

  let sourceReads = 0;
  await expect(
    createFeedApplication(
      {
        ...defaults,
        question: {
          open: async (_actor, id) => ({
            id,
            revision: 7,
            qualify: async () => [],
            finish: async () => undefined,
          }),
        },
        cursor: {
          fingerprint: (value) => JSON.stringify(value),
          encode: async () => 'unused',
          decode: async () => ({
            boundary: '2026-01-01T00:00:00.000Z',
            turn: 0,
            discovery: null,
            following: null,
            continue: null,
            resume: null,
            ratingQuestionRevision: 6,
          }),
        },
        discovery: {
          page: async () => {
            sourceReads++;
            return { candidates: [], next: false };
          },
        },
      },
      { route: () => 1 },
    ).list(
      {
        kind: 'account',
        accountId: '00000000-0000-4000-8000-000000000001',
        scopes: ['follow:list', 'library_entry:list', 'progress_session:list'],
      },
      { stream: 'home', cursor: 'old-question-cursor', ratingQuestionId: questionId },
      1,
      ['en'],
    ),
  ).rejects.toMatchObject({ name: 'FeedRefusedError', code: 'invalid_cursor' });
  expect(sourceReads).toBe(0);
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
