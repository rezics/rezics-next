import { useCallback, useEffect, useMemo, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { WorkbenchPage } from '../moderation/workbench-queue/page';
import { WorkbenchPreparing } from '../moderation/workbench-queue/view';
import { prepareWorkbenchRead, readWorkbenchPage, type WorkbenchRead } from '../moderation/workbench-queue/read';
import { workbenchSearch, type WorkbenchSearch } from '../moderation/workbench-queue/scope';
import type { ModerationDirectoryPage } from '../moderation/workbench-queue/directory';
import { privateReaderFingerprint } from '../moderation/private-reader-origin';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';

type Mode = 'ready' | 'empty' | 'preparing' | 'unavailable' | 'denied' | 'stale' | 'sparse' | 'loading' | 'closed';
const longLabel = 'A board with a very long title that wraps without hiding its queue choices — '.repeat(5);

/** The served prepare/read/page composition through installed client transport fixtures. */
function DirectoryStory({ mode = 'ready', continuation = false }: { mode?: Mode; continuation?: boolean }) {
  const cache = useMemo(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: 'directory-story-reader',
      csrfToken: null,
    });
    return client;
  }, []);
  const [search, setSearch] = useState(() =>
    workbenchSearch(continuation ? { directoryCursor: 'original-frontier' } : {}),
  );
  const [page, setPage] = useState<WorkbenchRead>();
  const [revision, retry] = useState(0);
  const read = useCallback(
    async (input: WorkbenchSearch, signal?: AbortSignal): Promise<WorkbenchRead> => {
      const directory: ModerationDirectoryPage =
        mode === 'preparing' || mode === 'unavailable' || mode === 'denied' || mode === 'stale'
          ? { state: mode, items: [], next: null }
          : {
              state: 'ready',
              source: 'illustrative-native-source',
              validUntil: new Date(Date.now() + 180000).toISOString(),
              next: mode === 'sparse' ? 'native-opaque-frontier' : null,
              items:
                mode === 'empty' || mode === 'sparse'
                  ? []
                  : [
                      {
                        scope: { kind: 'board', id: 'direct-board' },
                        label: longLabel,
                        parent: { id: 'parent-realm', label: 'A currently disclosed parent Realm with a long name' },
                        queues: ['reports', 'appeals', 'resolved'],
                        viewer: { open: mode === 'closed' ? 'denied' : 'permitted' },
                      },
                      {
                        scope: { kind: 'catalogue' },
                        label: 'Global catalogue',
                        parent: null,
                        queues: ['reports', 'resolved'],
                        viewer: { open: mode === 'closed' ? 'unavailable' : 'permitted' },
                      },
                    ],
            };
      const native = createKernelClient('https://illustrative-kernel.invalid', {
        fetch: (async (input, init) => {
          const path = new URL(new Request(input, init).url).pathname;
          if (path === '/v1/me/moderation-directory') return Response.json(directory);
          if (path === '/v1/boards/direct-board/appeals') return Response.json({ appeals: [], next: null });
          if (path === '/v1/boards/direct-board/reports' || path === '/v1/catalogue/reports')
            return Response.json({ reports: [], next: null });
          return Response.json({ code: 'not_found' }, { status: 404 });
        }) as typeof fetch,
      });
      return readWorkbenchPage(
        native,
        input,
        'Bearer illustrative-story',
        {
          subject: 'directory-story-reader',
          csrfFingerprint: await privateReaderFingerprint(null),
        },
        signal,
      );
    },
    [mode],
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
      {page && mode !== 'loading' ? (
        <WorkbenchPage
          key={page.generation}
          page={page}
          search={search}
          onSearch={setSearch}
          onRetry={() => retry((value) => value + 1)}
          read={read}
        />
      ) : (
        <WorkbenchPreparing />
      )}
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Moderation/Queue directory',
  id: 'pages-moderation-queue-directory',
  component: DirectoryStory,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: queueViewports },
    docs: {
      description: {
        component:
          'The workbench route consumer uses the installed KernelClient directory binding and private reader preparation. Responses are illustrative transport fixtures, including native coverage and horizon states; they are not API recordings or native authority, growth or browser execution evidence.',
      },
    },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/moderation/workbench">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
} satisfies Meta<typeof DirectoryStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const KeyboardAndLongLabels: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const button = await view.findByRole('button', { name: `${longLabel}: ${m.moderation_workbench_queue_reports()}` });
    button.focus();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await view.findByRole('status');
    await expect(view.getByText(m.moderation_workbench_empty())).toBeVisible();
  },
};
export const Loading: Story = { args: { mode: 'loading' } };
export const SparseContinuation: Story = { args: { mode: 'sparse' } };
export const Unavailable: Story = { args: { mode: 'unavailable' } };
export const Denied: Story = { args: { mode: 'denied' } };
export const Expired: Story = { args: { mode: 'stale' } };
export const ClosedAdvice: Story = { args: { mode: 'closed' } };
export const Empty: Story = { args: { mode: 'empty' } };
export const Preparing: Story = { args: { mode: 'preparing' } };
export const FailedContinuation: Story = { args: { mode: 'unavailable', continuation: true } };
export const Phone390: Story = { globals: { viewport: { value: 'phone390' } } };
export const Desktop1280: Story = { globals: { viewport: { value: 'desktop1280' } } };
