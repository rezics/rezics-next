import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentItem } from '@rezics/ui/content-item';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedDestination } from '../src/features/pages/home-feed-destination';
import type { FeedItem, FeedPage, HomeSpaceFeedItem } from '../src/features/pages/home-feed-read';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

function row(kind: 'thread' | 'post', identity = true): FeedItem {
  const id = '12345678-1234-1234-1234-123456789abc';
  return {
    id: 'activity:1',
    source: 'following',
    key: { owner: 'content', kind, route: 4660, id },
    occurredAt: '2026-11-03T00:00:00Z',
    summary: {
      id,
      kind: 'discussion',
      threadId: id,
      title: 'A discussion',
      createdAt: '2026-11-03T00:00:00Z',
      excerpt: 'Opening <script> & post text',
      ...(identity
        ? {
            author: {
              displayName: 'Current Reader',
              handle: 'reader',
              avatar: {
                media: '12345678-1234-1234-1234-123456789def',
                width: 96,
                height: 96,
                placeholder: { thumbhash: '', color: '#888888' },
                variants: [{ format: 'webp', width: 96 }],
                focalPoint: null,
                credit: null,
              },
            },
          }
        : {}),
    },
    destination:
      kind === 'thread'
        ? { kind, id, title: 'A discussion' }
        : { kind, id, threadId: id, postId: id, title: 'A discussion' },
  } as FeedItem;
}

test('Thread and post rows expose supplied identity beside the primary destination without reads', () => {
  for (const kind of ['thread', 'post'] as const) {
    const presentation = homeFeedItemPresentation(row(kind), 'en');
    const html = renderToStaticMarkup(<ContentItem {...presentation} />);
    expect(html).toContain('Current Reader');
    expect(html).toContain('@reader');
    expect(html).toContain('/media/12345678-1234-1234-1234-123456789def/webp-96');
    expect(html).toContain('href="/en/@reader"');
    expect(presentation.href).toContain('/threads/');
    if (kind === 'post') expect(presentation.href).toContain('#post-');
    expect(html).toContain('Opening &lt;script&gt; &amp; post text');
    expect(html).not.toContain('<script>');
    const omitted = row(kind, false);
    delete (omitted.summary as { excerpt?: string }).excerpt;
    const hidden = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(omitted, 'en')} />);
    expect(hidden).not.toContain('Current Reader');
    expect(hidden).not.toContain('/@');
    expect(hidden).not.toContain('Opening');
  }
});

const collectionId = '01a17a3b-6d8f-71f2-a0f8-f4ccbb7c7ba2';
const reviewId = '01a17a3b-09b4-77bf-a24b-1234ebeab5b3';
const subjectId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const spaceId = '01a1a000-0000-7000-8000-000000000811';

function collectionRow(source: 'following' | 'discovery' = 'following'): FeedItem {
  return {
    id: `activity:${collectionId}`,
    source,
    key: { owner: 'library', kind: 'collection', route: 4660, id: collectionId },
    occurredAt: '2026-11-03T00:00:00Z',
    summary: { id: collectionId, title: 'Books I come back to', description: 'Short novels.' },
    destination: { kind: 'collection', id: collectionId, title: 'Books I come back to' },
  };
}

function reviewRow(subject = true): FeedItem {
  return {
    id: `activity:${reviewId}`,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 4660, id: reviewId },
    occurredAt: '2026-11-03T00:00:00Z',
    summary: {
      id: reviewId,
      kind: 'review',
      title: 'A careful reread',
      createdAt: '2026-11-03T00:00:00Z',
      excerpt: 'The opening holds.',
      ...(subject ? { subject: { id: subjectId, title: 'The Little Prince' } } : {}),
    },
    destination: { kind: 'thread', id: reviewId, title: 'A careful reread' },
  };
}

function spaceRow(address: string | null = 'home-reading-room'): HomeSpaceFeedItem {
  return {
    id: `activity:${spaceId}`,
    source: 'discovery',
    key: { owner: 'community', kind: 'space', route: 4660, id: spaceId },
    occurredAt: null,
    summary: {
      id: spaceId,
      title: 'Home Reading Room',
      address,
      summary: 'A quiet room.',
      realm: { id: '01a1a000-0000-7000-8000-000000000812', title: 'Atlas' },
    },
    destination: { kind: 'space', id: spaceId, title: 'Home Reading Room', address },
  };
}

test('Collection, review and Space rows keep native identity and omit missing enrichment', () => {
  const collection = homeFeedItemPresentation(collectionRow(), 'en');
  const review = homeFeedItemPresentation(reviewRow(), 'en');
  const space = homeFeedItemPresentation(spaceRow(), 'en');
  expect(homeFeedDestination(collectionRow(), 'en')).toBe(`/en/collections/${collectionId}`);
  expect(homeFeedDestination(collectionRow('discovery'), 'en')).toBe(`/en/collections/${collectionId}`);
  expect(review.href).toContain(`/en/threads/${reviewId}`);
  expect(review.href).not.toContain('/subjects/');
  expect(homeFeedDestination(spaceRow(), 'en')).toBe('/en/spaces/home-reading-room');
  expect(homeFeedDestination(spaceRow(null), 'en')).toBeUndefined();
  const html = [collection, review, space].map((item) => renderToStaticMarkup(<ContentItem {...item} />));
  expect(html[0]).toContain('Collection');
  expect(html[0]).toContain('Books I come back to');
  expect(html[0]).toContain('Short novels.');
  expect(html[0]).not.toContain('Current Reader');
  expect(html[1]).toContain('Review');
  expect(html[1]).toContain('A careful reread');
  expect(html[1]).toContain('The Little Prince');
  expect(html[1]).toContain(`/en/subjects/${subjectId}`);
  expect(html[1]).not.toContain('rating');
  const bareReview = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(reviewRow(false), 'en')} />);
  expect(bareReview).toContain('Review');
  expect(bareReview).not.toContain('The Little Prince');
  expect(html[2]).toContain('Space');
  expect(html[2]).toContain('Home Reading Room');
  expect(html[2]).toContain('Atlas');
  expect(html[2]).toContain('A quiet room.');
  expect(html[2]).not.toContain('/realms/');
  expect(collection.visual).toBeUndefined();
  expect(review.visual).toBeUndefined();
  expect(space.visual).toBeUndefined();
  const page: FeedPage = {
    feedItems: [collectionRow(), reviewRow(), spaceRow()],
    next: 'opaque-continuation',
    asOf: '2026-11-03T00:00:00.000Z',
    sources: { discovery: 'ready', following: 'ready', continue: 'not_requested' },
  };
  const list = renderToStaticMarkup(<HomeFeed result={{ state: 'ready', page }} locale="en" />);
  expect(list.indexOf('Books I come back to')).toBeLessThan(list.indexOf('A careful reread'));
  expect(list.indexOf('A careful reread')).toBeLessThan(list.indexOf('Home Reading Room'));
  expect(list).toContain(m.library_next_page());
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    const labeled = renderToStaticMarkup(<ContentItem {...homeFeedItemPresentation(reviewRow(false), locale)} />);
    expect(labeled).toContain(m.home_feed_kind_review({}, { locale }));
    expect(labeled).toContain('A careful reread');
  }
  setLocale('en', { reload: false });
});
