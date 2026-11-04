import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { ExactRevisionState } from '../src/threads/exact-revision';
import type { HistoryPage } from '../src/threads/post-history-lifetime';
import type {
  HistoricalActualReader,
  HistoricalReadBinding,
  HistoricalReadEnvelope,
} from '../src/threads/historical-reader-provenance';
import { selected, later, id } from '../src/stories/exact-revision/fixture';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/example/prepared' });
for (const key of [
  'window',
  'document',
  'navigator',
  'location',
  'HTMLElement',
  'HTMLButtonElement',
  'Element',
  'Node',
  'Document',
  'DocumentFragment',
  'MutationObserver',
  'ResizeObserver',
] as const)
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value: key === 'window' ? window : window[key],
  });
for (const key of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia'] as const)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: window[key].bind(window) });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, scrollTo: () => {} });

type HistoryRequestData = {
  postId: string;
  cursor?: string;
  locale: string;
  credentialMode: 'anonymous' | 'session';
  binding: HistoricalReadBinding;
};
type ExactRequestData = HistoryRequestData & { revisionId: string };
const historyReads: HistoryRequestData[] = [];
const exactReads: ExactRequestData[] = [];
let pages = new Map<string, HistoryPage>();
let failNextHistoryCursor: string | undefined;
const anonymousReader: HistoricalActualReader = { credentialMode: 'anonymous', subject: null, complete: true };
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reads', () => ({
  readPostHistory: async ({ data }: { data: HistoryRequestData }): Promise<HistoricalReadEnvelope<unknown>> => {
    historyReads.push(data);
    if (data.cursor === failNextHistoryCursor) {
      failNextHistoryCursor = undefined;
      throw new Error('Constructed history read failure');
    }
    const page = pages.get(data.cursor ?? '') ?? pages.get('')!;
    return {
      data: page,
      provenance: { binding: data.binding, actualReader: anonymousReader, responseGeneration: historyReads.length },
    };
  },
}));
mock.module('../src/threads/exact-revision-read', () => ({
  readExactRevision: async ({ data }: { data: ExactRequestData }): Promise<HistoricalReadEnvelope<ExactRevisionState>> => {
    exactReads.push(data);
    return {
      data: { state: 'unavailable', status: 404 },
      provenance: { binding: data.binding, actualReader: anonymousReader, responseGeneration: exactReads.length },
    };
  },
}));
mock.module('../src/content-editions/edition-create-actions', () => ({
  readEditionCreateEntry: async () => ({ kind: 'available' as const }),
}));

const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider, useLocation, useRouter } =
  await import('@tanstack/react-router');
const { createRoot } = await import('react-dom/client');
const { PostHistory } = await import('../src/threads/post-history');
const { exactRevisionRoute } = await import('../src/threads/exact-revision-href');
const { Route: ExactRoute } = await import('../src/routes/posts/$id.revisions.$revisionId');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
notifyManager.setScheduler((callback) => callback());

const cursor = 'admitted-history-slice';
const firstRevision = { ...selected, revisionId: id(2_301) };
const otherRevision = { ...later, id: selected.id, revisionId: id(2_302) };
const targetRevision = { ...selected, revisionId: id(2_303) };
function page(revisions: HistoryPage['revisions'], next: string | null): HistoryPage {
  return {
    available: true,
    revisions,
    context: undefined,
    authors: {},
    mentions: {},
    subjects: [],
    reviewVotes: {},
    documentMedia: { kind: 'unavailable' },
    next,
    now: '2026-11-01T12:00:00Z',
  } as unknown as HistoryPage;
}

function button(host: HTMLElement, label: string) {
  const control = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label);
  expect(control, `Missing ${label}. Current view: ${host.textContent}`).toBeDefined();
  return control!;
}
async function click(control: HTMLElement) {
  await act(async () => {
    control.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
async function openExactFromLaterSlice(view: Awaited<ReturnType<typeof mount>>) {
  await click(button(view.host, m.thread_history_show()));
  await click(button(view.host, m.thread_history_more()));
  await click(button(view.host, m.revision_history_inspect({ number: '2' })));
  await click(button(view.host, m.revision_return_open_here()));
}

async function mount(initialUrl: string) {
  historyReads.length = 0;
  exactReads.length = 0;
  failNextHistoryCursor = undefined;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  const rootRoute = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: 'anonymous' | 'session';
  }>()({ component: Outlet });
  const localeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$locale', component: Outlet });
  let router: ReturnType<typeof createRouter>;
  const threadRoute = createRoute({
    getParentRoute: () => localeRoute,
    path: 'threads/$id_/$slug',
    component: function ThreadHistory() {
      const location = useLocation();
      const navigate = useRouter();
      return (
        <PostHistory
          postId={selected.id}
          threadId={selected.threadId}
          returnOrigin={{ pathname: location.pathname, search: new URL(location.publicHref, 'https://site.test').search }}
          navigateToExactRevision={(identity, historyReturn) => {
            void navigate.navigate(exactRevisionRoute(identity, historyReturn));
          }}
        />
      );
    },
    validateSearch: (search: Record<string, unknown>) => search,
  });
  ExactRoute.update({
    id: '/posts/$id/revisions/$revisionId',
    path: 'posts/$id/revisions/$revisionId',
    getParentRoute: () => localeRoute,
  } as never);
  router = createRouter({
    routeTree: rootRoute.addChildren([localeRoute.addChildren([threadRoute, ExactRoute])]),
    context: { queryClient: client, credentialMode: 'anonymous' },
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  });
  await router.load();
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return {
    client,
    host,
    router,
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await window.happyDOM.close();
  mock.restore();
});

test('a later admitted slice opens a fresh exact read and returns through re-admission to its exact focused occurrence', async () => {
  pages = new Map([
    ['', page([firstRevision], cursor)],
    [cursor, page([otherRevision, targetRevision], null)],
  ]);
  const view = await mount(`/en/threads/${selected.threadId}/prepared?cursor=thread-page&post=${selected.id}`);
  try {
    await click(button(view.host, m.thread_history_show()));
    expect(historyReads.map(({ cursor: value }) => value)).toEqual([undefined]);
    await click(button(view.host, m.thread_history_more()));
    expect(historyReads.map(({ cursor: value }) => value)).toEqual([undefined, cursor]);
    await click(button(view.host, m.revision_history_inspect({ number: '2' })));
    await click(button(view.host, m.revision_return_open_here()));

    expect(exactReads).toHaveLength(1);
    expect(exactReads[0]).toMatchObject({ postId: selected.id, revisionId: targetRevision.revisionId });
    expect(view.host.textContent).toContain(m.exact_revision_unavailable());
    expect(view.host.textContent).toContain(m.revision_return_to_history());
    expect(view.host.textContent).not.toContain('The original edition leaves room for the reader to pause.');
    expect(view.router.state.location.href).toContain('historyReturn=');
    expect(view.router.state.location.href).not.toContain(cursor);

    await click(
      [...view.host.querySelectorAll<HTMLAnchorElement>('a')].find(
        (link) => link.textContent?.trim() === m.revision_return_to_history(),
      )!,
    );
    expect(historyReads.map(({ cursor: value }) => value)).toEqual([undefined, cursor, cursor]);
    expect(view.host.textContent).toContain(m.revision_return_restored());
    const focusedHeading = view.host.querySelector<HTMLElement>('[data-history-focus-boundary][tabindex="-1"]');
    expect(focusedHeading).not.toBeNull();
    expect(document.activeElement).toBe(focusedHeading);
    expect(focusedHeading?.textContent).toContain(m.thread_history_version({ number: '2' }));
  } finally {
    await view.dispose();
  }
});

test('a failed return retries the same admitted cursor and does not re-arm focus after it was relinquished', async () => {
  pages = new Map([
    ['', page([firstRevision], cursor)],
    [cursor, page([otherRevision, targetRevision], null)],
  ]);
  const view = await mount(`/en/threads/${selected.threadId}/prepared?cursor=thread-page&post=${selected.id}`);
  try {
    await openExactFromLaterSlice(view);
    failNextHistoryCursor = cursor;
    await click(
      [...view.host.querySelectorAll<HTMLAnchorElement>('a')].find(
        (link) => link.textContent?.trim() === m.revision_return_to_history(),
      )!,
    );
    expect(view.host.textContent).toContain(m.revision_return_failed());
    expect(historyReads.map(({ cursor: value }) => value)).toEqual([undefined, cursor, cursor]);
    button(view.host, m.thread_history_hide()).focus();
    await click(button(view.host, m.revision_return_retry()));
    expect(historyReads.map(({ cursor: value }) => value)).toEqual([undefined, cursor, cursor, cursor]);
    expect(view.host.textContent).toContain(m.revision_return_restored());
    const focusedHeading = view.host.querySelector<HTMLElement>('[data-history-focus-boundary][tabindex="-1"]');
    expect(document.activeElement).not.toBe(focusedHeading);
  } finally {
    await view.dispose();
  }
});

test('a return without its one-shot local receipt is legible and restarts at the first current page', async () => {
  pages = new Map([['', page([firstRevision], null)]]);
  const missingReceipt = '00000000-0000-4000-8000-000000000000';
  const view = await mount(
    `/en/threads/${selected.threadId}/prepared?post=${selected.id}&historyReturn=${missingReceipt}&historyRevision=${targetRevision.revisionId}`,
  );
  try {
    expect(view.host.textContent).toContain(m.revision_return_lost());
    expect(historyReads).toHaveLength(0);
    await click(button(view.host, m.revision_return_restart()));
    expect(historyReads).toHaveLength(1);
    expect(historyReads[0]?.cursor).toBeUndefined();
  } finally {
    await view.dispose();
  }
});
