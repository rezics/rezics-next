import { useCallback, useEffect, useMemo, useState } from 'react';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';
import { WorkbenchPage } from '../moderation/workbench-queue/page';
import { WorkbenchPreparing } from '../moderation/workbench-queue/view';
import { prepareWorkbenchRead, readWorkbenchPage, type WorkbenchRead } from '../moderation/workbench-queue/read';
import { privateReaderFingerprint } from '../moderation/private-reader-origin';
import { sessionQuery } from '../session/query';
import { workbenchSearch, type WorkbenchSearch } from '../moderation/workbench-queue/scope';
import type { HistoryEntry, HistoryRead } from '../moderation/workbench-history/read';
import { m } from '../paraglide/messages.js';

const entry: HistoryEntry = {
  id: 'decision-1',
  targetKind: 'post',
  targetId: 'original-post-1',
  action: 'takedown',
  decidedAt: '2026-11-04T00:00:00.000Z',
  statement: 'The retained moderator reason explains this decision. '.repeat(18),
  history: { reasonState: 'retained', decider: 'withheld', receipt: 'permitted', target: 'unavailable' },
};
const page: HistoryRead = { state: 'ready', entries: [entry], next: 'native-opaque-history-cursor' };
/** Installed operations with illustrative responses, not recorded native acceptance. */
function HistoryStory({
  page: supplied,
  search: initial,
  onSearch,
  onReturn,
  onRetry,
}: {
  page: HistoryRead;
  search: WorkbenchSearch;
  onSearch: (search: WorkbenchSearch) => void;
  onReturn: () => void;
  onRetry: () => void;
}) {
  const cache = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'history-story', csrfToken: null });
    return client;
  }, []);
  const [search, setSearch] = useState(initial);
  const [page, setPage] = useState<WorkbenchRead>();
  const [revision, retry] = useState(0);
  const read = useCallback(
    async (input: WorkbenchSearch, signal?: AbortSignal) => {
      const native = createKernelClient('https://illustrative-kernel.invalid', {
        fetch: (async (input, init) => {
          const path = new URL(new Request(input, init).url).pathname;
          const response = (data: unknown, status = 200) =>
            Response.json(data, { status, headers: { [SESSION_HEADER]: 'illustrative-native-session' } });
          if (path === '/v1/boards/board-1/moderation-history') {
            if (supplied.state !== 'ready')
              return response(
                { code: supplied.state === 'stale' ? 'invalid_cursor' : supplied.state },
                supplied.state === 'stale' ? 400 : supplied.state === 'denied' ? 404 : 503,
              );
            return response({
              viewer: { kind: 'board-moderator' },
              entries: supplied.entries.map((row) => ({ ...row, appeal: null, appealDeadline: null })),
              nextCursor: supplied.next,
            });
          }
          const selected = supplied.entries.find((row) => path === `/v1/moderation-decisions/${row.id}`);
          if (selected)
            return response({
              ...selected,
              appeal: null,
              appealDeadline: null,
              viewer: {
                affectedAuthor: false,
                observedAt: selected.decidedAt,
                appeal: { state: 'unavailable', reason: 'not_affected_author' },
              },
              targetContext: { state: 'concealed' },
            });
          if (path === '/v1/boards/board-1/reports') return response({ reports: [], next: null });
          return response({ code: 'not_found' }, 404);
        }) as typeof fetch,
      });
      return readWorkbenchPage(
        native,
        input,
        'Bearer illustrative-story',
        {
          subject: 'history-story',
          csrfFingerprint: await privateReaderFingerprint(null),
        },
        signal,
      );
    },
    [supplied],
  );
  useEffect(() => {
    const controller = new AbortController();
    setPage(undefined);
    void prepareWorkbenchRead(cache, search, read, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setPage(result);
      },
      () => undefined,
    );
    return () => controller.abort();
  }, [cache, search, read, revision]);
  return (
    <QueryClientProvider client={cache}>
      {page ? (
        <WorkbenchPage
          key={page.generation}
          page={page}
          search={search}
          read={read}
          onSearch={(next) => {
            onSearch(next);
            if (!next.history) onReturn();
            setSearch(next);
          }}
          onRetry={() => {
            onRetry();
            retry((value) => value + 1);
          }}
        />
      ) : (
        <WorkbenchPreparing />
      )}
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Moderation/Board decision history',
  id: 'pages-moderation-board-decision-history',
  component: HistoryStory,
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'The private workbench uses the installed Board history and exact decision operations. Illustrative transport fixtures exercise retained/retired reasons, sparse pages, selection and captured queue return. These are not API recordings or native, growth or browser acceptance evidence.',
      },
    },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/workbench">
        <AppShell>
          <main className="mx-auto min-w-0 max-w-4xl p-4">
            <Story />
          </main>
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page,
    search: workbenchSearch({ board: 'board-1', history: true, cursor: 'original-queue-cursor' }),
    onSearch: fn(),
    onReturn: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof HistoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const inspect = view.getByRole('button', { name: m.moderation_history_open_receipt() });
    inspect.focus();
    await userEvent.keyboard('{Enter}');
    await expect(args.onSearch).toHaveBeenCalledWith(
      expect.objectContaining({ historyDecision: entry.id, cursor: 'original-queue-cursor' }),
    );
  },
};
export const InitialPage: Story = {};
export const Withheld: Story = {
  args: {
    page: {
      ...page,
      entries: [
        {
          ...entry,
          statement: '',
          history: { reasonState: 'retired', decider: 'retired', receipt: 'unavailable', target: 'unavailable' },
        },
      ],
    },
  },
};
export const Sparse: Story = { args: { page: { ...page, entries: [] } } };
export const Empty: Story = { args: { page: { ...page, entries: [], next: null } } };
export const Denied: Story = { args: { page: { state: 'denied', entries: [], next: null } } };
