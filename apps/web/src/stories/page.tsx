import React, { type ReactNode } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import {
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  Outlet,
  createMemoryHistory,
  Link,
} from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { DocumentBody } from '@rezics/ui/document-body';
import { AppShell, HomePage } from '../shell/shell';
import { createRecordedKernelFetch } from '../kernel/fake';
import { SearchPage } from '../search/search';
import subjectRecording from '../kernel/recorded/subject.json';
import missingRecording from '../kernel/recorded/missing-subject.json';
import boardRecording from '../kernel/recorded/board.json';
import boardThreadsRecording from '../kernel/recorded/board-threads.json';
import threadRecording from '../kernel/recorded/thread.json';
import threadPostsRecording from '../kernel/recorded/thread-posts.json';
import searchRecording from '../kernel/recorded/search.json';
import searchEmptyRecording from '../kernel/recorded/search-empty.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

const boardId = boardRecording.board.id;
const threadId = threadRecording.thread.id;
const client = createKernelClient('http://kernel.local', {
  fetch: createRecordedKernelFetch({
    subject: subjectRecording,
    'missing-subject': missingRecording,
    board: boardRecording,
    'board-threads': boardThreadsRecording,
    thread: threadRecording,
    'thread-posts': threadPostsRecording,
    search: searchRecording,
    'search-empty': searchEmptyRecording,
  }),
});
type Document = React.ComponentProps<typeof DocumentBody>['document'];
type SearchView = NonNullable<NonNullable<Parameters<typeof SearchPage>[0]['data']>['result']>;
// Eden merges /v1/threads/:id with /v1/threads/:threadId, so the typed call no longer exposes get or posts.
// The client still puts the id value into the path.
type ThreadReader = {
  get: () => Promise<{ data: { thread: { title: string | null } } | null }>;
  posts: {
    get: (query: Record<string, never>) => Promise<{
      data: { posts: { id: string; availability: string; body: unknown }[] } | null;
    }>;
  };
};
const readThread = client.threads as unknown as (params: { id: string }) => ThreadReader;

function searchResult(recording: typeof searchRecording | typeof searchEmptyRecording): SearchView {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(recording)) {
    if (key === 'status' || key === 'query') continue;
    body[key] = value;
  }
  return body as SearchView;
}

function BoardPage() {
  const [board, setBoard] = React.useState<{ title: string | null }>(boardRecording.board);
  const [threads, setThreads] = React.useState<{ threads: { id: string; title: string | null }[] }>(
    boardThreadsRecording,
  );
  React.useEffect(() => {
    void client
      .boards({ id: boardId })
      .get()
      .then(({ data }) => {
        if (data) setBoard(data.board);
      });
    void client
      .boards({ id: boardId })
      .threads.get({})
      .then(({ data }) => {
        if (data) setThreads(data);
      });
  }, []);
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{board.title ?? m.threads_untitled()}</h1>
      </header>
      <section className="space-y-4" aria-labelledby="board-threads-heading">
        <h2 id="board-threads-heading" className="text-xl font-semibold">
          {m.board_threads_heading()}
        </h2>
        {threads.threads.length ? (
          <ul className="divide-y divide-border/60 border-y border-border/60">
            {threads.threads.map((thread) => (
              <li key={thread.id} className="py-4">
                <Link
                  to="/threads/$id"
                  params={{ id: thread.id }}
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {thread.title ?? m.threads_untitled()}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{m.board_threads_empty()}</p>
        )}
      </section>
    </article>
  );
}
function ThreadPage() {
  const [thread, setThread] = React.useState<{ title: string | null }>(threadRecording.thread);
  const [posts, setPosts] = React.useState<{ posts: { id: string; availability: string; body: unknown }[] }>(
    threadPostsRecording,
  );
  React.useEffect(() => {
    const thread = readThread({ id: threadId });
    void thread.get().then(({ data }) => {
      if (data) setThread(data.thread);
    });
    void thread.posts.get({}).then(({ data }) => {
      if (data) setPosts(data);
    });
  }, []);
  return (
    <article className="max-w-4xl space-y-8 text-foreground">
      <header className="space-y-3">
        <h1 className="font-serif text-4xl font-semibold tracking-tight">{thread.title ?? m.threads_untitled()}</h1>
      </header>
      <section className="space-y-6" aria-labelledby="thread-posts-heading">
        <h2 id="thread-posts-heading" className="text-xl font-semibold">
          {m.thread_posts_heading()}
        </h2>
        {posts.posts.length ? (
          <ol className="divide-y divide-border/60 border-y border-border/60">
            {posts.posts.map((post) => (
              <li key={post.id} className="py-6">
                {post.availability === 'erased' ? (
                  <p className="text-muted-foreground" role="note">
                    {m.thread_post_erased()}
                  </p>
                ) : (
                  <DocumentBody document={post.body as Document} />
                )}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-muted-foreground">{m.thread_posts_empty()}</p>
        )}
      </section>
    </article>
  );
}
function RecordedSearch({ recording }: { recording: typeof searchRecording | typeof searchEmptyRecording }) {
  const [result, setResult] = React.useState(() => searchResult(recording));
  React.useEffect(() => {
    void client.subjects.$search.post({ text: recording.query, limit: 100 }).then(({ data }) => {
      if (data) setResult(data);
    });
  }, [recording]);
  return (
    <SearchPage
      query={recording.query}
      data={{
        result,
        typeChoices: [],
        groups: [],
        selectedFacets: {},
        selectedFacetLabels: {},
        facetsAvailable: false,
      }}
    />
  );
}
export function PageStory({ visitor, children }: { visitor: 'Signed In' | 'Signed Out'; children: ReactNode }) {
  const root = createRootRoute({
    component: () => (
      <AppShell session={visitor === 'Signed In' ? 'signed-in' : 'signed-out'}>
        <Outlet />
      </AppShell>
    ),
  });
  const page = createRoute({ getParentRoute: () => root, path: '/', component: () => <>{children}</> });
  const subjectRoute = createRoute({ getParentRoute: () => root, path: 'subjects/$id', component: () => null });
  const threadRoute = createRoute({ getParentRoute: () => root, path: 'threads/$id', component: () => null });
  const boardRoute = createRoute({ getParentRoute: () => root, path: 'boards/$id', component: () => null });
  const searchRoute = createRoute({ getParentRoute: () => root, path: 'search', component: () => null });
  const router = createRouter({
    routeTree: root.addChildren([page, subjectRoute, threadRoute, boardRoute, searchRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  React.useLayoutEffect(() => {
    const moveSkipLink = () => {
      const skipLink = document.querySelector('[data-slot="skip-nav-link"]');
      const header = document.querySelector('header');
      if (skipLink && header && !header.contains(skipLink)) header.appendChild(skipLink);
    };
    moveSkipLink();
    const observer = new MutationObserver(moveSkipLink);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return <RouterProvider router={router} />;
}

export const pages = {
  home: <HomePage />,
  shell: <HomePage />,
  board: <BoardPage />,
  thread: <ThreadPage />,
  search: <RecordedSearch recording={searchRecording} />,
  'search-empty': <RecordedSearch recording={searchEmptyRecording} />,
};

export async function pageReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('main');
}

function viewOf({ canvasElement }: { canvasElement: HTMLElement }) {
  return within(within(canvasElement).getByRole('main'));
}

// A list item's accessible name stays empty; the named control inside it carries the text.
async function listItemWithLink(view: ReturnType<typeof within>, name: string): Promise<void> {
  const link = await view.findByRole('link', { name });
  const items = await view.findAllByRole('listitem');
  expect(items.some((item: HTMLElement) => item.contains(link))).toBe(true);
}

export async function boardReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = boardThreadsRecording.threads[0]?.title;
  if (!title) throw new Error('The recorded board has no thread.');
  await view.findByRole('heading', { level: 1, name: boardRecording.board.title });
  await view.findByRole('heading', { level: 2, name: m.board_threads_heading() });
  await listItemWithLink(view, title);
}

export async function threadReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const title = threadRecording.thread.title;
  if (!title) throw new Error('The recorded thread has no title.');
  await view.findByRole('heading', { level: 1, name: title });
  await view.findByRole('heading', { level: 2, name: m.thread_posts_heading() });
  await view.findByRole('heading', { level: 2, name: 'Flight notes' });
  const note = await view.findByText('Watch the baobabs');
  const items = await view.findAllByRole('listitem');
  expect(items.some((item) => item.contains(note))).toBe(true);
  await listItemWithLink(view, 'The asteroid');
  await userEvent.click(await view.findByRole('button', { name: 'Reveal spoiler' }));
  await expect(view.getByText('The rose was unique')).toBeVisible();
}

function searchLabel(recording: typeof searchRecording) {
  const labels = recording.subjects[0]?.labels;
  if (!labels) throw new Error('The recorded search has no subject.');
  return labels[getLocale()] ?? labels.en;
}

export async function searchReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  const label = searchLabel(searchRecording);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
  await listItemWithLink(view, label);
}

export async function searchEmptyReady(context: { canvasElement: HTMLElement }) {
  await pageReady(context);
  const view = viewOf(context);
  await view.findByRole('heading', { level: 1, name: m.search_heading() });
  await expect(view.getByRole('textbox', { name: m.search_label() })).toHaveValue(searchEmptyRecording.query);
  await view.findByRole('button', { name: m.search_submit() });
  await expect(view.getByText(m.search_no_results())).toBeVisible();
}
