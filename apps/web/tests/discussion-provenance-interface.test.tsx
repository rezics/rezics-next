import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { documentText, fromPlainText } from '@rezics/document';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HistoryPage } from '../src/threads/post-history-lifetime';
import type { ThreadSubject } from '../src/threads/subjects';
import type { ThreadPost } from '../src/threads/thread-page';
import type { ThreadReadingPage } from '../src/threads/thread-reading';
import { m } from '../src/paraglide/messages.js';
import { identity, ready, selected } from '../src/stories/exact-revision/fixture';
import accounts from '../src/kernel/recorded/accounts.json';
import board from '../src/kernel/recorded/board.json';
import subject from '../src/kernel/recorded/subject.json';
import thread from '../src/kernel/recorded/thread.json';
import posts from '../src/kernel/recorded/thread-posts.json';
import { exactRevisionHref } from '../src/threads/exact-revision-href';
import { loadThreadPageWithAuthors } from '../src/identity/page-loaders';
import { subjectHref } from '../src/subject/subject-href';
import { authoredReadingPage } from '../src/kernel/fake/thread-reading-page';
import type { ReadingPage } from '../src/threads/thread-page';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { ExactRevisionView } = await import('../src/threads/exact-revision-view');
const { RevisionEntry } = await import('../src/threads/post-history');
const { ThreadReading } = await import('../src/threads/thread-reading');
const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');

const sourceId = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const questionId = `${sourceId}-question-${'citation-'.repeat(8)}`;
const completeDocumentText =
  'This complete historical document keeps its entire human supplied context across narrow and wide reading layouts. '.repeat(
    4,
  ) + 'The final canonical sentence remains visible.';
const completeDocument = fromPlainText(completeDocumentText, 'blocks');

async function readingPage(fetchPaths: string[]): Promise<ThreadReadingPage> {
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const path = new URL(new Request(input, init).url).pathname;
      fetchPaths.push(path);
      if (path.endsWith('/reading-page'))
        return Response.json(
          authoredReadingPage(
            thread.thread as ReadingPage['thread'],
            posts.posts.filter((post) => post.id !== thread.thread.firstPost.id) as ReadingPage['replies']['items'],
            accounts.accounts
              .filter((account) => account.state === 'active')
              .map((account) => ({
                id: account.id,
                displayName: 'displayName' in account ? account.displayName : null,
                handle: 'handle' in account ? account.handle : null,
                avatar: null,
              })),
          ),
        );
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

test('discussion readers keep human context primary and exact source data reachable without added reads', async () => {
  const fetchPaths: string[] = [];
  const page = await readingPage(fetchPaths);
  const readCountBeforeRendering = fetchPaths.length;
  const namedSubject: ThreadSubject = {
    id: subject.subject.id,
    types: subject.summary.types,
    label: subject.summary.label?.value ?? null,
    labels: subject.subject.labels as Record<string, string>,
    cover: subject.summary.cover,
  };
  const revision = {
    ...selected,
    subjectIds: [namedSubject.id, sourceId],
    voteCitation: { questionId, units: 14, revision: 2 },
    body: completeDocument,
  } as unknown as HistoryPage['revisions'][number];
  const exactPage = {
    ...ready,
    revision: {
      ...selected,
      subjectIds: [sourceId],
      voteCitation: { questionId, units: 14, revision: 2 },
      body: completeDocument,
    },
  };
  const exactHtml = renderToStaticMarkup(createElement(ExactRevisionView, { identity, page: exactPage }));
  const historyHtml = renderToStaticMarkup(
    createElement(
      'ol',
      null,
      createElement(RevisionEntry, {
        revision,
        number: 1,
        authors: page.authors,
        mentions: ready.mentions,
        documentMedia: ready.documentMedia,
        now: ready.now,
        subjects: [namedSubject],
        currentVote: undefined,
        review: true,
      }),
    ),
  );
  const erasedSource = page.posts.posts.find((post) => post.availability === 'available');
  if (!erasedSource || erasedSource.availability !== 'available') throw new Error('Expected a readable source post');
  const tombstonePage: ThreadReadingPage = {
    ...page,
    posts: {
      ...page.posts,
      posts: page.posts.posts.map((post, index): ThreadPost =>
        index === 0 && post.availability === 'available'
          ? { ...post, body: null, sha256: null, removed: true, availability: 'erased' }
          : post,
      ),
    },
  };
  const reading = createElement(ThreadReading, {
    page: tombstonePage,
    Post: ThreadReadingPost,
    personal: undefined,
    session: 'signed-out',
    returnTo: '/',
    signedOut: 'Sign in to reply',
    renderHeader: (title) => createElement('header', null, createElement('h1', null, title)),
    onMutation: async () => {},
    onPageRefresh: async () => tombstonePage,
  });
  const route = createRootRoute({ component: () => reading });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await router.load();
  const threadHtml = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
  );

  expect(exactHtml).toContain(`<h1>${m.exact_revision_heading()}</h1>`);
  expect(exactHtml).toContain(m.discussion_provenance_details_subject_unavailable());
  expect(exactHtml).toContain('<details');
  expect(exactHtml).toContain('<summary');
  expect(exactHtml).toContain(m.discussion_provenance_details_heading());
  expect(exactHtml).toContain(questionId);
  expect(exactHtml).toContain(m.thread_provenance_subject_reference({ id: sourceId }));
  expect(exactHtml.slice(0, exactHtml.indexOf('<details'))).not.toContain(sourceId);
  expect(exactHtml.slice(0, exactHtml.indexOf('<details'))).not.toContain(questionId);
  expect(exactHtml.split(selected.licence).length - 1).toBe(1);
  expect(exactHtml).toContain(completeDocumentText);
  expect(exactHtml).toContain(exactRevisionHref(identity, 'en'));

  expect(historyHtml).toContain(`<a href="${exactRevisionHref(identity, 'en')}"`);
  expect(historyHtml).toContain(
    `<a href="${subjectHref({ id: namedSubject.id, label: namedSubject.label ?? '' }, 'en').href}"`,
  );
  expect(historyHtml).toContain(subject.summary.label?.value ?? '');
  expect(historyHtml).toContain(completeDocumentText);
  expect(historyHtml).toContain(m.discussion_provenance_details_heading());
  expect(historyHtml).toContain(questionId);
  expect(historyHtml).toContain(m.discussion_provenance_details_subject_unavailable());
  expect(historyHtml).toContain(m.thread_provenance_subject_reference({ id: sourceId }));
  expect(historyHtml.split(selected.licence).length - 1).toBe(1);
  expect(historyHtml.slice(0, historyHtml.indexOf('<details'))).not.toContain(questionId);
  expect(historyHtml.slice(0, historyHtml.indexOf('<details'))).not.toContain(sourceId);

  expect(threadHtml).toContain(m.thread_post_deleted());
  expect(threadHtml).not.toContain(documentText(erasedSource.body));
  expect(fetchPaths).toHaveLength(readCountBeforeRendering);
});
