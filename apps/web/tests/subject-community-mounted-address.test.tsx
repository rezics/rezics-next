import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider, useLocation } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import type { CommunityRegion, CommunityThread, SubjectCommunity } from '../src/features/pages/subject-community';
import type { SubjectPageData } from '../src/features/pages/subject';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const [{ SubjectPage }, { SubjectViewPage }, { subjectPageMessages }] = await Promise.all([
  import('../src/features/pages/subject'),
  import('../src/features/pages/subject-frame'),
  import('../src/features/pages/route-support'),
]);

afterAll(() => mock.restore());

const subjectId = recordedPage.subject;
const realmId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const boardId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e6';
const threadId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e7';
const nativeCursor = 'opaque:/+?=&版%';

function community(paged: boolean): SubjectCommunity {
  const region = (kind: 'review' | 'discussion'): CommunityRegion => ({
    state: 'ready',
    threads: [
      {
        id: threadId,
        title: 'Mounted community post',
        authorId: 'author-one',
        boardId,
        createdAt: '2026-11-05T00:00:00.000Z',
        summary: '',
        licence: 'CC BY',
      } satisfies CommunityThread,
    ],
    next: null,
    context: {
      subjectId,
      subjectLabel: 'The Little Prince',
      place: {
        kind: 'realm',
        id: realmId,
        title: 'Global Reviews and Discussion',
        spaceId: '01a17a3b-0884-721b-91ef-d7ffd7bb58e8',
        headRevisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58e9',
      },
    },
    reactionsAsOf: null,
    request: {
      kind: 'subjectThreads',
      id: subjectId,
      place: realmId,
      threadKind: kind,
      limit: 20,
      ...(paged ? { cursor: nativeCursor } : {}),
    },
  });
  const reviews = region('review');
  const discussions = region('discussion');
  return {
    regions: { review: reviews, discussion: discussions },
    nodes: { reviews, threads: discussions },
    authors: {},
    now: '2026-11-05T00:00:00.000Z',
    sourceKey: 'community-source',
  };
}

function page(paged: boolean): SubjectPageData {
  const value = structuredClone(recordedPage) as unknown as SubjectPageData;
  value.community = community(paged);
  const document = value.document as unknown as {
    root: Record<string, unknown>;
    content: { type: string; props: Record<string, unknown> }[];
  };
  document.content = [
    {
      type: 'Slot',
      props: {
        id: 'header',
        name: 'header',
        children: [
          { type: 'SubjectHeader', props: { id: 'subject-header' } },
          { type: 'Slot', props: { id: 'actions', name: 'actions', children: [] } },
        ],
      },
    },
    { type: 'ThreadList', props: { id: 'threads', ...(paged ? { paged: true } : {}) } },
  ];
  return value;
}

async function routedHtml(view: 'overview' | 'discussion', entry: string): Promise<string> {
  const loaded = page(view === 'discussion');
  function RoutedSubject() {
    const currentHref = useLocation().publicHref;
    const messages = subjectPageMessages();
    return view === 'overview' ? (
      <SubjectPage page={loaded} locale="en" messages={messages} currentHref={currentHref} renderJsonLd={false} />
    ) : (
      <SubjectViewPage
        page={loaded}
        locale="en"
        messages={messages}
        currentHref={currentHref}
        view="discussion"
        label="Discussion"
        frame={null}
        renderJsonLd={false}
      />
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute({ component: RoutedSubject }),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await router.load();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

function threadReturn(html: string): string | null {
  const section = /<section id="subject-community-threads"[\s\S]*?<\/section>/.exec(html)?.[0];
  const href = section?.match(/href="([^"]*\/boards\/[^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  return href ? new URL(href, 'https://site.test').searchParams.get('returnTo') : null;
}

test('independently mounted Subject lists do not need RouterProvider when their context is missing', async () => {
  const { ReviewList, ThreadList } = await import('../src/features/pages/overview');
  expect(renderToStaticMarkup(<ReviewList id="reviews" />)).toBe('');
  expect(renderToStaticMarkup(<ThreadList id="threads" />)).toBe('');
});

test('actual overview and full-view addresses flow into the Subject region return', async () => {
  const base = `/en/subjects/${subjectId}/the-little-prince`;
  const overview = await routedHtml('overview', `${base}?realm=${realmId}`);
  expect(threadReturn(overview)).toBe(`${base}?realm=${realmId}#subject-community-threads`);

  const fullView = await routedHtml(
    'discussion',
    `${base}/discussion?realm=${realmId}&cursor=route-cursor&node=route-node`,
  );
  const expected = new URL(`${base}/discussion`, 'https://site.test');
  expected.searchParams.set('realm', realmId);
  expected.searchParams.set('cursor', nativeCursor);
  expected.searchParams.set('node', 'threads');
  expected.hash = 'subject-community-threads';
  expect(threadReturn(fullView)).toBe(`${expected.pathname}${expected.search}${expected.hash}`);
});

test('the title-only invitation states the current empty state without inviting edits', () => {
  expect(m.subject_empty({}, { locale: 'en' })).toBe('This subject has only a title so far.');
});
