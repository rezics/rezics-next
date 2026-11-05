import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { readInboxPage, readyInboxPage, type InboxPage, type InboxPageQuery } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { inboxReadRecoveryStory, inboxSeenAccessStory, inboxSeenRecoveryStory } from '../kernel/fake/notifications';
import { env } from '../../.storybook/cloudflare-workers';
import { setStoryRequestContext } from '../../.storybook/react-start';
import { getLocale } from '../paraglide/runtime.js';

const meta = { title: 'Pages/Account/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function inboxMain(canvasElement: HTMLElement) {
  return within(canvasElement).findByRole('main');
}

async function inboxNoticeList(canvasElement: HTMLElement) {
  const main = await inboxMain(canvasElement);
  return within(main).findByRole('list', { name: m.inbox_heading() });
}

async function rowsReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await inboxNoticeList(canvasElement);
}

const recordedPostHref = '/threads/01a17a3b-0884-721b-91ef-d7ffd7bb58f1#post-01a17a3b-0884-721b-91ef-d7ffd7bb58f2';

async function readablePostAnchor({ canvasElement }: { canvasElement: HTMLElement }) {
  const list = within(await within(canvasElement).findByRole('list', { name: m.inbox_heading() }));
  await expect(list.getAllByRole('link')[0]).toHaveAttribute('href', recordedPostHref);
}

async function emptyReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByText(m.inbox_empty());
}

function InboxStory({ fixture }: { fixture: string }) {
  return <PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />;
}

export const Empty: Story = { name: 'Empty', render: () => <InboxStory fixture="empty" />, play: emptyReady };
export const Mixed: Story = {
  name: 'Mixed replies and moderation',
  render: () => <InboxStory fixture="mixed" />,
  play: readablePostAnchor,
};
export const Unavailable: Story = {
  name: 'Unavailable item',
  render: () => <InboxStory fixture="unavailable" />,
  play: rowsReady,
};
export const SparseUnreadPhone: Story = {
  name: 'Sparse unread page',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <InboxStory fixture="sparse-unread" />,
  play: async ({ canvasElement }) => {
    const main = within(await inboxMain(canvasElement));
    await main.findByText(m.inbox_selection_sparse());
    const unread = main.getByRole('button', { name: m.inbox_triage_filter_unread() });
    unread.focus();
    await expect(unread).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await main.findByText(m.inbox_triage_no_unread_loaded());
    const next = await main.findByRole('button', { name: m.inbox_next_page() });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await main.findByRole('list', { name: m.inbox_heading() });
  },
};
export const Preparing: Story = {
  name: 'Service unavailable (503)',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <InboxStory fixture="preparing" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '503');
    await within(status).findByRole('button', { name: m.inbox_retry() });
    await expect(within(canvasElement).queryByText(m.inbox_empty())).toBeNull();
    await within(status).findByText(m.inbox_unavailable());
    await expect(within(status).getByRole('button', { name: m.inbox_retry() })).toBeEnabled();
    await expect(within(status).queryByText(m.inbox_preparing())).toBeNull();
    await expect(within(status).queryByText(m.settings_retry_wait())).toBeNull();
  },
};

function WaitingInboxStory() {
  useState(() => {
    inboxReadRecoveryStory.reads = 0;
  });
  return <InboxStory fixture="retry-after" />;
}

export const RetryAfterRecovery: Story = {
  name: 'Unavailable, wait, then retry',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <WaitingInboxStory />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const status = await view.findByRole('status');
    await expect(status).toHaveAttribute('data-response-code', 'deadline_exceeded');
    await expect(status).toHaveAttribute('data-retry-after', '2');
    await within(status).findByText(m.inbox_unavailable());
    await within(status).findByText(m.settings_retry_wait());
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeDisabled();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
    await expect(inboxReadRecoveryStory.reads).toBe(1);
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
    await userEvent.click(retry);
    await view.findByText(m.inbox_empty());
    await expect(inboxReadRecoveryStory.reads).toBe(2);
    await expect(view.queryByText(m.inbox_unavailable())).toBeNull();
  },
};
export const Closed: Story = {
  name: 'Inbox closed',
  render: () => <InboxStory fixture="closed" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(status).toHaveAttribute('data-response-code', 'platform_closed');
    await within(status).findByRole('button', { name: m.inbox_retry() });
  },
};
export const UnavailableOperation: Story = {
  name: 'Inbox unavailable',
  render: () => <InboxStory fixture="unavailable-operation" />,
  play: async ({ canvasElement }) => {
    const status = await within(canvasElement).findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '500');
    await within(status).findByRole('button', { name: m.inbox_retry() });
    await expect(within(canvasElement).queryByText(m.inbox_empty())).toBeNull();
  },
};
export const MoreThanNinetyNine: Story = {
  name: 'More than 99 unread',
  render: () => <InboxStory fixture="many" />,
  play: rowsReady,
};
export const RowOverlay: Story = {
  name: 'Row overlay',
  render: () => <InboxStory fixture="row-overlay" />,
  play: readablePostAnchor,
};

const reportHref = '/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3';

export const ReporterAvailable: Story = {
  render: () => <InboxStory fixture="report-available" />,
  play: async ({ canvasElement }) => {
    const list = within(await inboxNoticeList(canvasElement));
    await expect(list.getByRole('link', { name: m.moderation_actioned() })).toHaveAttribute('href', reportHref);
  },
};

export const ReporterUnavailable: Story = {
  render: () => <InboxStory fixture="report-unavailable" />,
  play: async ({ canvasElement }) => {
    const list = within(await inboxNoticeList(canvasElement));
    await expect(list.getByRole('link', { name: m.moderation_dismissed() })).toHaveAttribute('href', reportHref);
    await expect(list.queryByText(m.inbox_unavailable_item())).toBeNull();
  },
};

function SessionTransitionPage() {
  const client = useQueryClient();
  const sessionKey: readonly unknown[] = sessionQuery.queryKey;
  return (
    <>
      <div className="p-2 text-sm">
        <button
          type="button"
          onClick={() => client.setQueryData(sessionKey, { state: 'unknown', subject: null, csrfToken: null })}
        >
          Session becomes unknown
        </button>
      </div>
      <AppShell>
        <InboxPageView />
      </AppShell>
    </>
  );
}

export const ViewerBecomesUnknown: Story = {
  name: 'Signed-in viewer becomes unknown',
  render: () => (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <SessionTransitionPage />
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const mainElement = await inboxMain(canvasElement);
    const main = within(mainElement);
    const rows = await main.findByRole('list', { name: m.inbox_heading() });
    const ids = [...rows.querySelectorAll('[data-notice-id]')].map((row) => row.getAttribute('data-notice-id'));
    await userEvent.click(view.getByRole('button', { name: 'Session becomes unknown' }));
    await main.findByText(m.inbox_loading());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    for (const id of ids) await expect(mainElement.querySelector(`[data-notice-id="${id}"]`)).toBeNull();
    await expect(main.queryByText(m.inbox_seen_unavailable())).toBeNull();
  },
};

const rejectedCursor = 'opaque.signed+rejected/cursor==';
let restartRequests: (string | undefined)[] = [];

function RejectedContinuationExample({ failedReset = false }: { failedReset?: boolean }) {
  const loadPage = useMemo(() => {
    restartRequests = [];
    let firstPages = 0;
    return async (query: InboxPageQuery): Promise<InboxPage> => {
      restartRequests.push(query.cursor);
      if (query.cursor !== undefined)
        return { signedIn: true, state: 'unavailable', failure: { status: 409, retryAfter: '1' } };
      firstPages++;
      if (failedReset && firstPages === 2)
        return { signedIn: true, state: 'unavailable', failure: { status: 503, retryAfter: '1' } };
      // Illustrative IO sequence over existing fixture rows; no native cursor rejection is claimed.
      const page = await readInboxPage({ data: { selection: query.selection } });
      if (!page.signedIn || page.state !== 'ready') return page;
      const index = firstPages === 1 ? 0 : 1;
      return readyInboxPage(
        page.items.slice(index, index + 1).map((item) => ({ ...item, unread: false })),
        firstPages === 1 ? rejectedCursor : null,
        page.viewer.accountId,
        query.selection,
      );
    };
  }, [failedReset]);
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <InboxPageView loadPage={loadPage} />
    </PatternStory>
  );
}

const restartParameters = {
  docs: {
    description: {
      story:
        'Actual Inbox page with illustrative rejected-continuation IO and existing mixed fixture rows. Uses shared locale/theme globals; review at phone390 and desktop1280. Native, runtime and visual proof remain separate.',
    },
  },
};

async function rejectedContinuation({ canvasElement }: { canvasElement: HTMLElement }) {
  const main = within(await inboxMain(canvasElement));
  await main.findByRole('list', { name: m.inbox_heading() });
  await expect(main.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
  const loadMore = await main.findByRole('button', { name: m.inbox_load_more() });
  await waitFor(() => expect(loadMore).toBeEnabled());
  await userEvent.click(loadMore);
  const status = await main.findByRole('status');
  await expect(status).toHaveAttribute('data-response-status', '409');
  await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
  await expect(main.queryByText(m.inbox_empty())).toBeNull();
  const retry = within(status).getByRole('button', { name: m.inbox_retry() });
  const restart = within(status).getByRole('button', { name: m.inbox_start_first_page() });
  await expect(retry).toBeDisabled();
  await expect(restart).toBeDisabled();
  await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
  await expect(restart).toBeEnabled();
  await expect(restartRequests).toEqual([undefined, rejectedCursor]);
}

export const RejectedContinuation: Story = {
  name: 'Rejected continuation with separate first-page choice',
  parameters: restartParameters,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RejectedContinuationExample />,
  play: async (context) => {
    await rejectedContinuation(context);
    const main = within(await inboxMain(context.canvasElement));
    await userEvent.click(main.getByRole('button', { name: m.inbox_retry() }));
    await waitFor(() => expect(restartRequests).toEqual([undefined, rejectedCursor, rejectedCursor]));
    await expect(main.getByRole('status')).toHaveAttribute('data-response-status', '409');
    await waitFor(() => expect(main.getByRole('button', { name: m.inbox_start_first_page() })).toBeEnabled(), {
      timeout: 5000,
    });
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
  },
};

export const RestartAfterRejectedContinuation: Story = {
  name: 'Explicit first-page restart after rejection',
  parameters: restartParameters,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <RejectedContinuationExample />,
  play: async (context) => {
    await rejectedContinuation(context);
    const main = within(await inboxMain(context.canvasElement));
    await userEvent.click(main.getByRole('button', { name: m.inbox_start_first_page() }));
    const list = within(await main.findByRole('list', { name: m.inbox_heading() }));
    await expect(list.getAllByRole('listitem').map((row) => row.getAttribute('data-notice-id'))).toEqual([
      '01a17a3b-0884-721b-91ef-d7ffd7bb5802',
    ]);
    await expect(restartRequests).toEqual([undefined, rejectedCursor, undefined]);
    await expect(main.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
    await expect(main.queryByText(m.inbox_unavailable())).toBeNull();
  },
};

export const FirstPageRestartUnavailable: Story = {
  name: 'First-page restart unavailable, then deliberate retry',
  parameters: restartParameters,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RejectedContinuationExample failedReset />,
  play: async (context) => {
    await rejectedContinuation(context);
    const main = within(await inboxMain(context.canvasElement));
    await userEvent.click(main.getByRole('button', { name: m.inbox_start_first_page() }));
    const status = await main.findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeDisabled();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
    await expect(restartRequests).toEqual([undefined, rejectedCursor, undefined]);
    await userEvent.click(retry);
    const list = within(await main.findByRole('list', { name: m.inbox_heading() }));
    await expect(list.getAllByRole('listitem').map((row) => row.getAttribute('data-notice-id'))).toEqual([
      '01a17a3b-0884-721b-91ef-d7ffd7bb5802',
    ]);
    await expect(restartRequests).toEqual([undefined, rejectedCursor, undefined, undefined]);
  },
};

function SeenInboxStory({ fixture, transition = false }: { fixture: string; transition?: boolean }) {
  useState(() => {
    inboxSeenRecoveryStory.commands = [];
  });
  return transition ? (
    <PatternStory visitor="Signed In" path={`/inbox?fixture=${fixture}`}>
      <SessionTransitionPage />
    </PatternStory>
  ) : (
    <InboxStory fixture={fixture} />
  );
}

export const SeenRetryAfterRecovery: Story = {
  name: 'Mark seen waits, then retries the original notice after pagination',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-wait" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await inboxNoticeList(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_triage_mark() }));
    const status = (await view.findByText(m.inbox_seen_unavailable())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '429');
    await expect(status).toHaveAttribute('data-response-code', 'rate_limited');
    await expect(status).toHaveAttribute('data-retry-after', '2');
    await within(status).findByText(m.inbox_seen_rate_limited());
    await within(status).findByText(m.settings_retry_wait());
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeDisabled();
    retry.click();
    await expect(inboxSeenRecoveryStory.commands).toHaveLength(1);
    const original = inboxSeenRecoveryStory.commands[0];
    await userEvent.click(view.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(() => expect(view.queryByRole('button', { name: m.inbox_load_more() })).toBeNull());
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
    // Expiry and page reads must not replay an uncertain write.
    await expect(inboxSeenRecoveryStory.commands).toHaveLength(1);
    await userEvent.click(retry);
    await waitFor(() => expect(view.queryByText(m.inbox_seen_unavailable())).toBeNull());
    await expect(inboxSeenRecoveryStory.commands).toEqual([original, original]);
    await expect(await inboxNoticeList(canvasElement)).toBeVisible();
  },
};

export const SeenUnavailable: Story = {
  name: 'Mark seen unavailable without a native wait',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await inboxNoticeList(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_triage_mark() }));
    const status = (await view.findByText(m.inbox_seen_unavailable())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(status).toHaveAttribute('data-response-code', 'deadline_exceeded');
    await expect(within(status).getByRole('button', { name: m.inbox_retry() })).toBeEnabled();
    await expect(within(status).queryByText(m.settings_retry_wait())).toBeNull();
    await expect(view.queryByText(m.inbox_preparing())).toBeNull();
    await expect(await inboxNoticeList(canvasElement)).toBeVisible();
  },
};

export const SeenClosed: Story = {
  name: 'Mark seen closed after a readable Inbox',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-closed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await inboxNoticeList(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_triage_mark() }));
    const status = (await view.findByText(m.inbox_seen_closed())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-code', 'platform_closed');
    await expect(await inboxNoticeList(canvasElement)).toBeVisible();
  },
};

export const SeenDenied: Story = {
  name: 'Mark seen denied after a readable Inbox',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-denied" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await inboxNoticeList(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_triage_mark() }));
    const status = (await view.findByText(m.inbox_seen_denied())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(status).toHaveAttribute('data-response-code', 'forbidden');
    await expect(view.queryByText(m.inbox_seen_closed())).toBeNull();
  },
};

export const SeenViewerBecomesUnknown: Story = {
  name: 'Viewer changes while mark seen is waiting',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-wait" transition />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const main = within(await inboxMain(canvasElement));
    await main.findByRole('list', { name: m.inbox_heading() });
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_mark() }));
    await main.findByText(m.inbox_seen_rate_limited());
    await userEvent.click(view.getByRole('button', { name: 'Session becomes unknown' }));
    await main.findByText(m.inbox_loading());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_seen_unavailable())).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_retry() })).toBeNull();
    await expect(inboxSeenRecoveryStory.commands).toHaveLength(1);
  },
};

export const SeenDeniedAccessRecovery: Story = {
  name: 'Default Inbox denied mark-seen recovery checks current access without replaying the mutation and preserves the exact unresolved marker for deliberate retry',
  tags: ['!dev'],
  globals: { viewport: { value: 'phone390', isRotated: false } },
  parameters: {
    docs: {
      description: {
        story:
          'Default Inbox route and PageStory with the existing illustrative session RPC and fake native-response transport. Covers access reads, original marker retry, native Retry-After and signed-out retirement. Source regression only; native, browser and visual verification remain with integration.',
      },
    },
  },
  beforeEach: () => {
    inboxSeenRecoveryStory.commands = [];
    inboxSeenAccessStory.pageReads = 0;
    inboxSeenAccessStory.sessionReads = 0;
    const sessions = env.SESSIONS as unknown as { get(id: unknown): { signedIn(): Promise<unknown> } };
    const original = sessions.get;
    sessions.get = (id) => {
      const existing = original.call(sessions, id);
      return {
        ...existing,
        signedIn: () => {
          inboxSeenAccessStory.sessionReads++;
          return existing.signedIn();
        },
      };
    };
    return () => {
      sessions.get = original;
    };
  },
  render: () => <InboxStory fixture="seen-access-recovery" />,
  play: async ({ canvasElement }) => {
    const main = within(await inboxMain(canvasElement));
    await main.findByRole('list', { name: m.inbox_heading() });
    await userEvent.click(main.getByRole('button', { name: m.inbox_triage_mark() }));
    const status = (await main.findByText(m.inbox_seen_denied())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(status).toHaveAttribute('data-response-code', 'forbidden');
    await expect(status).toHaveAttribute('data-retry-after', '2');
    await within(status).findByText(m.inbox_seen_unavailable());
    await within(status).findByText(m.inbox_seen_readable());
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    const rows = await main.findByRole('list', { name: m.inbox_heading() });
    await expect(within(rows).getAllByRole('link')[0]).toHaveAttribute('href', recordedPostHref);
    await expect(rows.querySelector('[data-unread="true"]')).not.toBeNull();
    await expect(inboxSeenRecoveryStory.commands).toHaveLength(1);
    const original = inboxSeenRecoveryStory.commands[0]!;
    await expect(original.through).toBe('01a17a3b-0884-721b-91ef-d7ffd7bb5801');
    await expect(JSON.parse(original.key!)).toMatch(/^[0-9a-f-]{36}$/i);
    const sessionReads = inboxSeenAccessStory.sessionReads;
    const access = within(status).getByRole('button', { name: m.inbox_check_access() });
    await expect(access).toBeDisabled();
    access.click();
    await expect(inboxSeenAccessStory.pageReads).toBe(1);
    await expect(inboxSeenAccessStory.sessionReads).toBe(sessionReads);
    await waitFor(() => expect(access).toBeEnabled(), { timeout: 5000 });
    await expect(inboxSeenRecoveryStory.commands).toEqual([original]);
    await expect(inboxSeenAccessStory.pageReads).toBe(1);
    await expect(inboxSeenAccessStory.sessionReads).toBe(sessionReads);

    // A current native read denial retires rows; refreshing a session does not grant permission or mark seen.
    await userEvent.click(access);
    await main.findByText(m.inbox_read_denied());
    await waitFor(() => expect(access).toBeEnabled());
    await expect(inboxSeenAccessStory.sessionReads).toBe(sessionReads + 1);
    await expect(inboxSeenAccessStory.pageReads).toBe(2);
    await expect(inboxSeenRecoveryStory.commands).toEqual([original]);
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(status).toHaveAttribute('data-response-code', 'forbidden');
    await expect(within(status).queryByRole('button', { name: m.inbox_seen_retry() })).toBeNull();
    await within(status).findByText(m.inbox_seen_access_checked());

    // A readable current page still leaves the failed marker unresolved, with a separate deliberate action.
    await userEvent.click(access);
    await main.findByRole('list', { name: m.inbox_heading() });
    const markerRetry = await within(status).findByRole('button', { name: m.inbox_seen_retry() });
    await expect(inboxSeenAccessStory.sessionReads).toBe(sessionReads + 2);
    await expect(inboxSeenAccessStory.pageReads).toBe(3);
    await expect(inboxSeenRecoveryStory.commands).toEqual([original]);
    await expect(status).toHaveAttribute('data-response-code', 'forbidden');
    await within(status).findByText(m.inbox_seen_denied());
    await userEvent.click(markerRetry);
    await within(status).findByText(m.inbox_seen_rate_limited());
    await expect(inboxSeenRecoveryStory.commands).toEqual([original, original]);
    await expect(inboxSeenAccessStory.pageReads).toBe(3);
    await expect(access).toBeDisabled();
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeDisabled();
    access.click();
    retry.click();
    await expect(inboxSeenRecoveryStory.commands).toEqual([original, original]);
    await waitFor(() => expect(access).toBeEnabled(), { timeout: 5000 });
    await expect(retry).toBeEnabled();
    await expect(inboxSeenAccessStory.pageReads).toBe(3);
    await expect(inboxSeenAccessStory.sessionReads).toBe(sessionReads + 2);
    await expect(inboxSeenRecoveryStory.commands).toEqual([original, original]);

    // Exercise the real viewer boundary through the installed session query, without a replacement view.
    const path = `/${getLocale()}/inbox?fixture=seen-access-recovery`;
    setStoryRequestContext({ visitor: 'Signed Out', url: path });
    await userEvent.click(access);
    const signIn = await main.findByRole('link', { name: m.inbox_sign_in() });
    await expect(signIn).toHaveAttribute('href', `/auth/sign-in?return_to=${encodeURIComponent(path)}`);
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_seen_unavailable())).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_retry() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(inboxSeenAccessStory.pageReads).toBe(3);
    await expect(inboxSeenRecoveryStory.commands).toEqual([original, original]);
  },
};
