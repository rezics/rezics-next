import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KernelClient } from '@rezics/client';
import { ContentItem } from '@rezics/ui/content-item';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { createHomeSpaceSelection, type HomeSpaceResult } from '../src/features/pages/home-feed-spaces';
import {
  createHomeFeedWindow,
  HOME_FEED_LIMIT,
  homeFeedHistoryState,
  homeFeedNavigationDescriptor,
  readHomeFeedPage,
  readHomeFeedNavigationDescriptor,
  type FeedInput,
  type FeedItem,
  type FeedPage,
  type HomeSpaceFeedItem,
  type HomeFeedResult,
} from '../src/features/pages/home-feed-read';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

const location = { origin: 'https://example.test', pathname: '/en/' };
const selection: FeedInput = {
  stream: 'home',
  cursor: 'signed-native-frontier',
  kind: 'schema:Book',
  spaceId: '01a1a000-0000-7000-8000-000000000811',
  ratingQuestionId: '01a1a000-0000-7000-8000-000000000812',
};

function page(id: string): HomeFeedResult {
  return {
    state: 'ready',
    page: {
      feedItems: [],
      next: id === 'initial' ? null : `frontier:${id}`,
      asOf: '2026-11-03T00:00:00Z',
      sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
    },
  };
}

const collectionId = '01a1a000-0000-7000-8000-000000000821';
const reviewId = '01a1a000-0000-7000-8000-000000000822';
const discussionId = '01a1a000-0000-7000-8000-000000000823';
const subjectId = '01a1a000-0000-7000-8000-000000000824';
const spaceId = '01a1a000-0000-7000-8000-000000000825';

function mixedRows(spaceAddress: string | null = 'quiet-room'): FeedItem[] {
  const collection: FeedItem = {
    id: `discovery:library:${collectionId}`,
    source: 'discovery',
    key: { owner: 'library', kind: 'collection', route: 4660, id: collectionId },
    occurredAt: null,
    summary: { id: collectionId, title: 'Reading shelf', description: 'Short novels.' },
    destination: { kind: 'collection', id: collectionId, title: 'Reading shelf' },
  };
  const review: FeedItem = {
    id: `following:review:${reviewId}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 4660, id: reviewId },
    occurredAt: null,
    summary: { id: reviewId, kind: 'review', title: 'A careful reread', createdAt: '2026-11-03T00:00:00Z' },
    destination: { kind: 'thread', id: reviewId, title: 'A careful reread' },
  };
  const discussion: FeedItem = {
    id: `following:thread:${discussionId}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 4660, id: discussionId },
    occurredAt: null,
    summary: { id: discussionId, kind: 'discussion', title: 'A discussion', createdAt: '2026-11-03T00:00:00Z' },
    destination: { kind: 'thread', id: discussionId, title: 'A discussion' },
  };
  const space: HomeSpaceFeedItem = {
    id: `discovery:space:${spaceId}`,
    source: 'discovery',
    key: { owner: 'community', kind: 'space', route: 4660, id: spaceId },
    occurredAt: null,
    summary: {
      id: spaceId,
      title: 'Quiet room',
      address: spaceAddress,
      summary: 'A quiet reading room.',
      realm: { id: '01a1a000-0000-7000-8000-000000000826', title: 'Atlas Realm' },
    },
    destination: { kind: 'space', id: spaceId, title: 'Quiet room', address: spaceAddress },
  };
  return [collection, review, discussion, space];
}

test('Home makes missing public native variants visible in every launch locale', () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    const html = renderToStaticMarkup(<HomeFeed result={page('initial')} locale={locale} onNext={() => undefined} />);
    expect(html).toContain(m.home_feed_public_discovery_unavailable({}, { locale }));
  }
  setLocale('en', { reload: false });
});

test('mixed Collection, review and Space seams keep exact identity and hide an undisclosed Subject', () => {
  const rows = mixedRows();
  const cards = rows.map((item) => renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(item, 'en')} />));
  const collection = cards[0]!;
  const review = cards[1]!;
  const discussion = cards[2]!;
  const space = cards[3]!;
  expect(collection).toContain('Reading shelf');
  expect(collection).toContain('Short novels.');
  expect(collection).toContain('/en/collections/01a1a000-0000-7000-8000-000000000821');
  expect(collection).not.toContain('members');
  expect(review).toContain('Review');
  expect(review).toContain('A careful reread');
  expect(review).not.toContain(subjectId);
  expect(review).not.toContain('/subjects/');
  expect(discussion).toContain('A discussion');
  expect(space).toContain('Quiet room');
  expect(space).toContain('A quiet reading room.');
  expect(space).toContain('Atlas Realm');
  expect(space).toContain('/en/spaces/quiet-room');
  expect(space).not.toContain('/realms/');
  const unavailable = homeFeedItemPresentation(mixedRows(null)[3]!, 'en');
  expect(unavailable.href).toBeUndefined();

  const result = renderToStaticMarkup(
    <HomeFeed
      result={{
        state: 'ready',
        page: {
          feedItems: rows,
          next: 'opaque-next',
          asOf: '2026-11-03T00:00:00Z',
          sources: { discovery: 'ready', following: 'ready', continue: 'not_requested' },
        },
      }}
      locale="en"
    />,
  );
  expect(result.indexOf('Reading shelf')).toBeLessThan(result.indexOf('A careful reread'));
  expect(result.indexOf('A careful reread')).toBeLessThan(result.indexOf('A discussion'));
  expect(result.indexOf('A discussion')).toBeLessThan(result.indexOf('Quiet room'));
  for (const locale of locales) {
    const collectionLocale = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(rows[0]!, locale)} />);
    const reviewLocale = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(rows[1]!, locale)} />);
    const spaceLocale = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(rows[3]!, locale)} />);
    expect(collectionLocale).toContain(m.library_following_kind_collection({}, { locale }));
    expect(reviewLocale).toContain(m.home_feed_kind_review({}, { locale }));
    expect(spaceLocale).toContain(m.library_following_kind_space({}, { locale }));
  }
});

test('owner return restores only a bounded same-origin selection and opaque frontier', async () => {
  const descriptor = homeFeedNavigationDescriptor(selection, location, 'en')!;
  const state = homeFeedHistoryState({ router: { route: '/' } }, descriptor);
  expect(readHomeFeedNavigationDescriptor(state, location, 'en')?.input).toEqual(selection);
  expect(readHomeFeedNavigationDescriptor(state, location, 'fr')).toBeUndefined();
  expect(JSON.stringify(descriptor)).not.toContain('feedItems');
  expect(JSON.stringify(descriptor)).not.toContain('private');
  expect(readHomeFeedNavigationDescriptor(state, { ...location, origin: 'https://other.test' }, 'en')).toBeUndefined();
  expect(readHomeFeedNavigationDescriptor(state, { ...location, pathname: '/en/search' }, 'en')).toBeUndefined();
  const oversized = homeFeedNavigationDescriptor({ ...selection, cursor: 'x'.repeat(32_769) }, location, 'en');
  expect(oversized).toMatchObject({
    frontierUnavailable: true,
    input: { kind: selection.kind, spaceId: selection.spaceId },
  });
  expect(oversized?.input).not.toHaveProperty('cursor');
  expect(
    readHomeFeedNavigationDescriptor(homeFeedHistoryState({}, oversized), location, 'en')?.frontierUnavailable,
  ).toBe(true);
  expect(
    homeFeedNavigationDescriptor({ ...selection, kind: `schema:${String.fromCharCode(10)}Book` }, location, 'en'),
  ).toBeUndefined();
  expect(
    homeFeedNavigationDescriptor({ ...selection, extraFilter: 'rating>4' } as FeedInput, location, 'en'),
  ).toBeUndefined();

  const requests: FeedInput[] = [];
  const controller = createHomeFeedWindow({ state: 'loading', code: 'loading' }, async (input) => {
    requests.push(input);
    return page('returned');
  });
  await controller.load(readHomeFeedNavigationDescriptor(state, location, 'en')!.input);
  expect(requests).toEqual([selection]);
  expect(controller.snapshot().result).toEqual(page('returned'));
  expect(homeFeedHistoryState(state, undefined)).not.toHaveProperty('rezicsHomeFeed');
});

test('selection replacement retires the old page and ignores its late response', async () => {
  const requests = new Map<string, { resolve: (result: HomeFeedResult) => void; signal: AbortSignal }>();
  const controller = createHomeFeedWindow({ state: 'loading', code: 'loading' }, async (input, signal) => {
    return new Promise((resolve) => requests.set(input.kind!, { resolve, signal }));
  });
  const book = controller.load({ stream: 'home', kind: 'schema:Book' });
  const movie = controller.load({ stream: 'home', kind: 'schema:Movie' });
  expect(requests.get('schema:Book')!.signal.aborted).toBe(true);
  requests.get('schema:Book')!.resolve(page('stale-book'));
  await book;
  expect(controller.snapshot()).toMatchObject({
    busy: true,
    result: { state: 'loading' },
    input: { kind: 'schema:Movie' },
  });
  requests.get('schema:Movie')!.resolve(page('current-movie'));
  await movie;
  expect(controller.snapshot().result).toEqual(page('current-movie'));
});

test('return revalidates Space access and shows restart for an expired native frontier', async () => {
  const returnedSpace = {
    spaceId,
    title: 'Quiet room',
    address: 'quiet-room',
    headRevisionId: '01a1a000-0000-7000-8000-000000000827',
    realmId: '01a1a000-0000-7000-8000-000000000828',
  };
  let reads = 0;
  const outcomes: HomeSpaceResult[] = [
    { status: 'ready', space: returnedSpace },
    { status: 'denied', spaceId },
  ];
  const spaces = createHomeSpaceSelection(
    async () => {
      reads++;
      return outcomes.shift()!;
    },
    () => undefined,
  );
  await spaces.restore(spaceId);
  expect(spaces.snapshot().selected?.spaceId).toBe(spaceId);
  await spaces.restore(spaceId);
  expect(reads).toBe(2);
  expect(spaces.snapshot()).toMatchObject({ status: 'denied', available: false });
  expect(spaces.snapshot().selected).toBeUndefined();

  const expired = {
    feedItems: {
      get: async () => ({ status: 400, error: { value: { code: 'stale_cursor' } }, data: undefined }),
    },
  } as unknown as KernelClient;
  expect(await readHomeFeedPage(expired, selection)).toEqual({ state: 'cursor', code: 'stale_cursor' });
  const recovery = renderToStaticMarkup(
    <HomeFeed result={{ state: 'cursor', code: 'stale_cursor' }} locale="en" onRestart={() => undefined} />,
  );
  expect(recovery).toContain(m.home_feed_restart({}, { locale: 'en' }));
});

test('the Web reader keeps one bounded request and one page at fixed response size', async () => {
  const measurements: Array<{
    population: number;
    requestComponents: number;
    queryValues: number;
    projectedRows: number;
    projectedBytes: number;
    metadataRows: number;
    retainedBytes: number;
  }> = [];
  for (const population of [32, 256, 2_048]) {
    const calls: Array<Record<string, unknown>> = [];
    const nativePage: FeedPage = {
      feedItems: [],
      next: 'opaque-next',
      asOf: '2026-11-03T00:00:00Z',
      sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
    };
    const client = {
      feedItems: {
        get: async (request: { query: Record<string, unknown> }) => {
          calls.push(request.query);
          return { status: 200, data: nativePage, error: undefined };
        },
      },
    } as unknown as KernelClient;
    const input: FeedInput = {
      stream: 'home',
      cursor: 'opaque-current',
      kind: 'schema:Book',
      spaceId: selection.spaceId,
    };
    const controller = createHomeFeedWindow({ state: 'loading', code: 'loading' }, (request, signal) =>
      readHomeFeedPage(client, request, undefined, signal),
    );
    await controller.load(input);
    const result = controller.snapshot().result;
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') continue;
    expect(result.page.next).toBe('opaque-next');
    measurements.push({
      population,
      requestComponents: calls.length,
      queryValues: Object.keys(calls[0] ?? {}).length,
      projectedRows: result.page.feedItems.length,
      projectedBytes: new TextEncoder().encode(JSON.stringify(result.page.feedItems)).byteLength,
      metadataRows: 0,
      retainedBytes: new TextEncoder().encode(JSON.stringify(controller.snapshot())).byteLength,
    });
  }
  // Population labels are fixture inputs only: this proves the Web projection and retention bound,
  // not the producer's indexed scan cost.
  expect(
    measurements.map(
      ({ requestComponents, queryValues, projectedRows, metadataRows, projectedBytes, retainedBytes }) => [
        requestComponents,
        queryValues,
        projectedRows,
        metadataRows,
        projectedBytes,
        retainedBytes,
      ],
    ),
  ).toEqual([
    [1, 5, 0, 0, 2, measurements[0]!.retainedBytes],
    [1, 5, 0, 0, 2, measurements[0]!.retainedBytes],
    [1, 5, 0, 0, 2, measurements[0]!.retainedBytes],
  ]);
  expect(measurements.map(({ population }) => population)).toEqual([32, 256, 2_048]);
  expect(HOME_FEED_LIMIT).toBe(20);
});
