import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadThreadPageWithAuthors } from '../src/identity/page-loaders';
import { m } from '../src/paraglide/messages.js';
import { ExactRevisionView } from '../src/threads/exact-revision-view';
import { PostHistoryLifetime, type HistoryPage } from '../src/threads/post-history-lifetime';
import { RevisionEntry } from '../src/threads/post-history';
import type { ThreadSubject } from '../src/threads/subjects';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import type { ThreadPost } from '../src/threads/thread-page';
import type { ThreadReadingPage, ThreadReadingPersonal } from '../src/threads/thread-reading';
import type { DocumentImagePresentation } from '../src/threads/document-media';
import type { ExactRevisionState } from '../src/threads/exact-revision';
import { id, identity, ready, selected } from '../src/stories/exact-revision/fixture';
import thread from '../src/kernel/recorded/thread.json';
import posts from '../src/kernel/recorded/thread-posts.json';
import board from '../src/kernel/recorded/board.json';
import accounts from '../src/kernel/recorded/accounts.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingHeader, ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');

const finalParagraph = 'The final canonical paragraph remains visible in the complete discussion document.';
const longBody = fromPlainText(
  [
    ...Array.from(
      { length: 40 },
      (_, index) => `Canonical paragraph ${index + 1}: the complete supplied text remains readable.`,
    ),
    finalParagraph,
  ].join('\n\n'),
  'blocks',
);

async function readingPage(): Promise<ThreadReadingPage> {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      if (path.endsWith('/posts')) return Response.json(posts);
      if (path.includes('/boards/')) return Response.json(board);
      if (path.endsWith('/accounts')) return Response.json(accounts);
      return Response.json(thread);
    },
  });
  const page = await loadThreadPageWithAuthors(
    client,
    new Request('https://rezics.test/'),
    {},
    { id: thread.thread.id },
    { sitekey: '', scriptUrl: '' },
    'anonymous',
  );
  if ('redirect' in page) throw new Error('The recorded reading page must not redirect');
  return { ...page, provenanceSubjects: page.subjects };
}

async function renderThread(page: ThreadReadingPage, personal?: ThreadReadingPersonal) {
  const region = createElement(ThreadReading, {
    page,
    personal,
    Post: ThreadReadingPost,
    session: personal ? 'signed-in' : 'signed-out',
    returnTo: '/',
    signedOut: 'Sign in to reply',
    renderHeader: (title) => createElement(ThreadReadingHeader, { page, title }),
    onMutation: async () => {},
    onPageRefresh: async () => page,
  });
  const route = createRootRoute({ component: () => region });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
  );
}

function withImageBody() {
  const mediaId = id(60);
  const image: DocumentImagePresentation = {
    id: mediaId,
    containerId: selected.threadId,
    digest: 'a'.repeat(64),
    width: 640,
    height: 448,
    variants: [{ format: 'webp', width: 640, height: 448 }],
    placeholder: null,
    focalPoint: null,
    credit: null,
  };
  const revision = {
    ...selected,
    mediaIds: [mediaId],
    body: {
      ...selected.body,
      doc: {
        ...selected.body.doc,
        content: [
          ...(selected.body.doc.content ?? []),
          {
            type: 'image',
            attrs: { id: 'immutable-image', src: mediaId, alt: 'A still lake in the original edition' },
          },
        ],
      },
    },
  } satisfies HistoryPage['revisions'][number];
  const documentMedia: HistoryPage['documentMedia'] = { kind: 'ready', images: new Map([[mediaId, image]]) };
  return { revision, documentMedia };
}

test('the production discussion composition keeps full canonical documents, shared frames, meaningful headings and independent controls', async () => {
  const source = await readingPage();
  const opening = source.posts.posts[0];
  if (!opening || opening.availability !== 'available') throw new Error('The recorded opening post must be readable');
  const page: ThreadReadingPage = {
    ...source,
    posts: {
      ...source.posts,
      posts: source.posts.posts.map((post, index): ThreadPost =>
        index === 0 && post.availability === 'available' ? { ...post, body: longBody } : post,
      ),
    },
  };
  const html = await renderThread(page, {
    viewerId: opening.authorId,
    reactions: {},
    reviewVotes: {},
    idempotencyKey: 'composed-reading',
  });
  const itemStart = html.indexOf(`id="post-${opening.id}"`);
  const frameStart = html.indexOf('data-slot="content-item-frame"', itemStart);
  const frameEnd = html.indexOf('</article>', frameStart);
  const item = html.slice(itemStart, frameEnd + '</article>'.length);

  expect(html).toContain(finalParagraph);
  expect(html).toContain('data-slot="content-item-frame"');
  expect(html).toContain('data-content-item-slot="title"');
  expect(html).toContain(`<h1 class="text-4xl font-semibold tracking-tight text-balance">${page.thread.title}</h1>`);
  expect(html).toContain(m.thread_posts_heading());
  expect(item).toContain('data-slot="document-body"');
  expect(item).toContain(`${m.thread_history_licence()}: ${opening.licence}`);
  expect(item).toContain(m.thread_history_show());
  expect(item).toContain(m.thread_provenance_heading());
  expect(item).toContain(m.thread_reading_share());
  expect(item).toContain(m.thread_reply_to_post());
  expect(item).toContain(m.thread_content_more_actions());
  expect(item).not.toContain('line-clamp');
  expect(item).not.toContain('data-slot="list-row-link"');
  expect(item).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>).)*<(?:button|input|select|textarea)\b/s);
});

test('withheld and erased post shapes and unavailable exact revisions never render their former private body', async () => {
  const source = await readingPage();
  const opening = source.posts.posts[0];
  if (!opening || opening.availability !== 'available') throw new Error('The recorded opening post must be readable');
  const privateText = 'Private body removed from the current disclosure.';
  const privatePage: ThreadReadingPage = {
    ...source,
    authors: null,
    posts: {
      ...source.posts,
      posts: source.posts.posts.map((post, index): ThreadPost =>
        index === 0 && post.availability === 'available'
          ? { ...post, body: fromPlainText(privateText, 'blocks') }
          : post,
      ),
    },
  };
  const withheld: ThreadReadingPage = {
    ...privatePage,
    posts: {
      ...privatePage.posts,
      posts: privatePage.posts.posts.map((post, index): ThreadPost =>
        index === 0 && post.availability === 'available'
          ? { ...post, body: null, sha256: null, removed: true, availability: 'withheld' }
          : post,
      ),
    },
  };
  const erased: ThreadReadingPage = {
    ...privatePage,
    posts: {
      ...privatePage.posts,
      posts: privatePage.posts.posts.map((post, index): ThreadPost =>
        index === 0
          ? {
              id: opening.id,
              threadId: opening.threadId,
              route: opening.route,
              parentId: opening.parentId,
              availability: 'erased',
              removed: true,
              body: null,
              sha256: null,
            }
          : post,
      ),
    },
  };
  const withheldHtml = await renderThread(withheld);
  const erasedHtml = await renderThread(erased);
  expect(withheldHtml).toContain(m.thread_post_withheld());
  expect(erasedHtml).toContain(m.thread_post_deleted());
  expect(withheldHtml).not.toContain(privateText);
  expect(erasedHtml).not.toContain(privateText);
  expect(withheldHtml).toContain('data-slot="content-item-frame"');
  expect(erasedHtml).toContain('data-slot="content-item-frame"');

  const unavailable = renderToStaticMarkup(
    createElement(ExactRevisionView, {
      identity,
      page: { state: 'unavailable', status: 404 },
    }),
  );
  expect(unavailable).toContain(m.exact_revision_unavailable());
  expect(unavailable).not.toContain('data-slot="document-body"');
  expect(unavailable).not.toContain('The original edition leaves room for the reader to pause.');
  expect(unavailable).not.toContain(m.exact_revision_back());
});

test('exact and historical revisions retain their immutable media, citation, subjects and independent current-vote disclosure', () => {
  const { revision, documentMedia } = withImageBody();
  const exactState: ExactRevisionState = { ...ready, revision, documentMedia };
  const exact = renderToStaticMarkup(createElement(ExactRevisionView, { identity, page: exactState }));
  expect(exact).toContain('data-slot="content-item-frame"');
  expect(exact).toContain('A still lake in the original edition');
  expect(exact).toContain(revision.licence);
  expect(exact).toContain(revision.subjectIds[0]!);
  expect(exact).toContain(m.thread_provenance_vote({ units: '14', questionId: id(40), revision: '2' }));
  expect(exact).not.toContain(m.thread_provenance_current_vote());
  expect(exact).toContain(`#post-${revision.id}`);

  const subject: ThreadSubject = {
    id: revision.subjectIds[0]!,
    types: ['schema:Book'],
    label: 'The first edition',
    labels: { en: 'The first edition' },
    cover: null,
  };
  const currentVote = { questionId: id(40), units: 0, revision: 7 };
  const entry = renderToStaticMarkup(
    createElement(
      'ol',
      null,
      createElement(RevisionEntry, {
        revision,
        number: 1,
        authors: {},
        mentions: null,
        documentMedia,
        now: '2026-10-31T13:00:00Z',
        subjects: [subject],
        currentVote,
        review: true,
      }),
    ),
  );
  expect(entry).toMatch(/<ol[^>]*><li[^>]*><article[^>]*data-slot="content-item-frame"/);
  expect(entry).toContain('data-content-item-slot="title"');
  expect(entry).toContain('A still lake in the original edition');
  expect(entry).toContain(
    `href="${exactRevisionHref({ postId: revision.id, revisionId: revision.revisionId }, 'en')}"`,
  );
  expect(entry).toContain('The first edition');
  expect(entry).toContain(m.thread_provenance_current_vote());
  expect(entry).toContain(m.thread_provenance_vote({ units: '0', questionId: id(40), revision: '7' }));
});

test('a failed history continuation preserves its exact recovery cursor on the live disclosure lifetime', () => {
  const cursor = 'native-signed/+=exact-continuation';
  const lifetime = new PostHistoryLifetime(() => true);
  const ticket = lifetime.ticket();
  const firstPage = lifetime.begin(ticket);
  if (!firstPage) throw new Error('The first history page must acquire its disclosure request');
  lifetime.update(ticket, (view) => ({ ...view, loading: true, loaded: true, next: cursor }));
  lifetime.finish(firstPage);

  const continuation = lifetime.begin(ticket);
  if (!continuation) throw new Error('The requested continuation must acquire its disclosure request');
  lifetime.update(ticket, (view) => ({ ...view, loading: true, available: false, failedCursor: cursor }));
  lifetime.finish(continuation);
  expect(lifetime.snapshot()).toMatchObject({ loaded: true, available: false, failedCursor: cursor, next: cursor });

  const retry = lifetime.begin(ticket);
  if (!retry) throw new Error('The unavailable disclosure must remain retryable');
  expect(lifetime.owns(retry)).toBe(true);
  expect(lifetime.snapshot().failedCursor).toBe(cursor);
});
