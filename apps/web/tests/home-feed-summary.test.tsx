import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContentItem } from '@rezics/ui/content-item';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import type { FeedItem } from '../src/features/pages/home-feed-read';

function row(kind: 'thread' | 'post', identity = true): FeedItem {
  const id = '12345678-1234-1234-1234-123456789abc';
  return {
    id: 'activity:1', source: 'following', key: { owner: 'content', kind, route: 4660, id },
    occurredAt: '2026-11-03T00:00:00Z',
    summary: {
      id, kind: 'discussion', threadId: id, title: 'A discussion', createdAt: '2026-11-03T00:00:00Z',
      excerpt: 'Opening <script> & post text',
      ...(identity ? { author: { displayName: 'Current Reader', handle: 'reader', avatar: null } } : {}),
    },
    destination: kind === 'thread' ? { kind, id, title: 'A discussion' }
      : { kind, id, threadId: id, postId: id, title: 'A discussion' },
  } as FeedItem;
}

test('Thread and post rows expose supplied identity beside the primary destination without reads', () => {
  for (const kind of ['thread', 'post'] as const) {
    const presentation = homeFeedItemPresentation(row(kind), 'en');
    const html = renderToStaticMarkup(<ContentItem {...presentation} />);
    expect(html).toContain('Current Reader');
    expect(html).toContain('@reader');
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
