import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RemovedPost } from '../src/threads/post-removed';
import type { ThreadPost } from '../src/threads/thread-page';
import { m } from '../src/paraglide/messages.js';

test('a native withheld reply keeps its anchor without inventing a byline or date', () => {
  const post = {
    id: 'reply',
    threadId: 'thread',
    route: 1,
    parentId: null,
    removed: true,
    availability: 'withheld',
    body: null,
    sha256: null,
  } satisfies ThreadPost;
  const html = renderToStaticMarkup(
    createElement(RemovedPost, {
      post,
      authors: {},
      now: '2026-11-04T00:00:00Z',
      anchorId: 'post-reply',
      itemRef: null,
      menuButton: null,
      onCopyLink() {},
    }),
  );
  expect(html).toContain('id="post-reply"');
  expect(html).toContain(m.thread_post_withheld());
  expect(html).not.toContain('<time');
});
