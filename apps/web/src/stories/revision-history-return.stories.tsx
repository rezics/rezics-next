import type { Meta, StoryObj } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useSearch,
  useRouter,
} from '@tanstack/react-router';
import { useLayoutEffect, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PostHistory } from '../threads/post-history';
import { ExactRevisionView } from '../threads/exact-revision-view';
import { exactRevisionRoute } from '../threads/exact-revision-href';
import { historicalReaderSource } from '../threads/historical-reader-provenance';
import { parseHistoryReturnToken, resolveHistoryReturnTarget } from '../threads/revision-return/history-return';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { currentHistoryEnvelope } from './post-history-current-fixture';
import { current, selected, exactRevisionViewports } from './exact-revision/fixture';

type RouterContext = { queryClient: QueryClient; credentialMode: 'anonymous' };
const lostToken = '00000000-0000-4000-8000-000000000000';

function ThreadHistoryRoute() {
  const location = useLocation();
  const router = useRouter();
  return (
    <main className="mx-auto min-w-0 max-w-3xl space-y-4 p-4 sm:p-8">
      <PostHistory
        postId={selected.id}
        threadId={selected.threadId}
        review
        returnOrigin={{ pathname: location.pathname, search: new URL(location.publicHref, 'https://site.test').search }}
        navigateToExactRevision={(identity, historyReturn) => {
          void router.navigate(exactRevisionRoute(identity, historyReturn));
        }}
      />
    </main>
  );
}

function UnavailableExactRoute() {
  const { id: postId, revisionId } = useParams({ strict: false }) as { id: string; revisionId: string };
  const { historyReturn } = useSearch({ strict: false }) as { historyReturn?: string };
  const client = useQueryClient();
  const returnTarget = resolveHistoryReturnTarget(
    historyReturn,
    { postId, revisionId },
    getLocale(),
    'anonymous',
    historicalReaderSource(client),
  );
  return (
    <main className="mx-auto min-w-0 max-w-3xl p-4 sm:p-8">
      <ExactRevisionView
        identity={{ postId, revisionId }}
        page={{ state: 'unavailable', status: 404 }}
        historyReturn={returnTarget}
      />
    </main>
  );
}

function ReturnJourney({ lostReceipt = false }: { lostReceipt?: boolean }) {
  const [client] = useState(() => {
    const value = new QueryClient();
    value.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    return value;
  });
  const router = useMemo(() => {
    const root = createRootRouteWithContext<RouterContext>()({ component: Outlet });
    const locale = createRoute({ getParentRoute: () => root, path: '/$locale', component: Outlet });
    const thread = createRoute({ getParentRoute: () => locale, path: 'threads/$id_/$slug', component: ThreadHistoryRoute });
    const exact = createRoute({
      getParentRoute: () => locale,
      path: 'posts/$id/revisions/$revisionId',
      validateSearch: (search: Record<string, unknown>) => {
        const historyReturn = parseHistoryReturnToken(search.historyReturn);
        return historyReturn ? { historyReturn } : {};
      },
      component: UnavailableExactRoute,
    });
    const initial = lostReceipt
      ? `/en/posts/${selected.id}/revisions/${selected.revisionId}?historyReturn=${lostToken}`
      : `/en/threads/${selected.threadId}/prepared?post=${selected.id}`;
    return createRouter({
      routeTree: root.addChildren([locale.addChildren([thread, exact])]),
      context: { queryClient: client, credentialMode: 'anonymous' },
      history: createMemoryHistory({ initialEntries: [initial] }),
    });
  }, [client, lostReceipt]);

  useLayoutEffect(() => {
    const previous = globalThis.fetch;
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path === `/v1/posts/${selected.id}/revisions`) return Response.json(currentHistoryEnvelope(2, 'review'));
      if (path === `/v1/posts/${selected.id}/revisions/${selected.revisionId}`)
        return Response.json({ post: selected });
      if (path === `/v1/threads/${selected.threadId}`) return Response.json(current);
      if (path === '/v1/accounts') return Response.json({ accounts: [] });
      if (path.startsWith('/v1/subjects/')) return new Response(null, { status: 404 });
      return previous(input, init);
    }) as typeof fetch;
    globalThis.fetch = transport;
    return () => {
      if (globalThis.fetch === transport) globalThis.fetch = previous;
      router.dispose();
      client.clear();
    };
  }, [client, router]);

  return (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Interfaces/Community/Revision history return',
  component: ReturnJourney,
  args: { lostReceipt: false },
  parameters: {
    layout: 'fullscreen',
    viewport: { options: exactRevisionViewports },
    docs: {
      description: {
        component:
          'Mounted history and exact-reading components with constructed native responses. The exact page is intentionally unavailable here; native authorization and browser acceptance remain controller work.',
      },
    },
  },
} satisfies Meta<typeof ReturnJourney>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentSlice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_history_show() }));
    await expect(await canvas.findByText('Admitted Board')).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '1' }) })).toBeVisible();
  },
};

export const UnavailableExactWithReturn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.thread_history_show() }));
    await userEvent.click(canvas.getByRole('button', { name: m.revision_history_inspect({ number: '1' }) }));
    await userEvent.click(canvas.getByRole('button', { name: m.revision_return_open_here() }));
    await expect(await canvas.findByRole('heading', { name: m.exact_revision_heading() })).toBeVisible();
    await expect(canvas.getByRole('status', { name: m.exact_revision_unavailable() })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.revision_return_to_history() })).toBeVisible();
    await userEvent.click(canvas.getByRole('link', { name: m.revision_return_to_history() }));
    await expect(await canvas.findByText(m.revision_return_restored())).toBeVisible();
  },
};

export const LostReceipt: Story = {
  args: { lostReceipt: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.exact_revision_heading() })).toBeVisible();
    await expect(canvas.getByText(m.revision_return_unavailable())).toBeVisible();
    expect(canvas.queryByRole('link', { name: m.revision_return_to_history() })).toBeNull();
    expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
