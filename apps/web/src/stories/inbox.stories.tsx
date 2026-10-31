import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { readInboxPage, type InboxPage } from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { inboxReadRecoveryStory, inboxSeenRecoveryStory } from '../kernel/fake/notifications';

const meta = { title: 'Pages/Account/Inbox', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

async function rowsReady({ canvasElement }: { canvasElement: HTMLElement }) {
  await within(canvasElement).findByRole('list');
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
  play: rowsReady,
};
export const Unavailable: Story = {
  name: 'Unavailable item',
  render: () => <InboxStory fixture="unavailable" />,
  play: rowsReady,
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
  play: rowsReady,
};

const reportHref = '/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3';

export const ReporterAvailable: Story = {
  render: () => <InboxStory fixture="report-available" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    await expect(list.getByRole('link', { name: m.moderation_actioned() })).toHaveAttribute('href', reportHref);
  },
};

export const ReporterUnavailable: Story = {
  render: () => <InboxStory fixture="report-unavailable" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
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
    const main = within(await view.findByRole('main'));
    const rows = await main.findByRole('list');
    const ids = [...rows.querySelectorAll('[data-notice-id]')].map((row) => row.getAttribute('data-notice-id'));
    await userEvent.click(view.getByRole('button', { name: 'Session becomes unknown' }));
    await main.findByText(m.inbox_loading());
    await expect(main.queryByRole('list')).toBeNull();
    for (const id of ids) await expect(canvasElement.querySelector(`[data-notice-id="${id}"]`)).toBeNull();
    await expect(main.queryByText(m.inbox_seen_unavailable())).toBeNull();
  },
};

const rejectedCursor = 'opaque.signed+rejected/cursor==';
let restartRequests: (string | undefined)[] = [];

function RejectedContinuationExample({ failedReset = false }: { failedReset?: boolean }) {
  const loadPage = useMemo(() => {
    restartRequests = [];
    let firstPages = 0;
    return async (cursor?: string): Promise<InboxPage> => {
      restartRequests.push(cursor);
      if (cursor !== undefined)
        return { signedIn: true, state: 'unavailable', failure: { status: 409, retryAfter: '1' } };
      firstPages++;
      if (failedReset && firstPages === 2)
        return { signedIn: true, state: 'unavailable', failure: { status: 503, retryAfter: '1' } };
      // Illustrative IO sequence over existing fixture rows; no native cursor rejection is claimed.
      const page = await readInboxPage({ data: {} });
      if (!page.signedIn || page.state !== 'ready') return page;
      const index = firstPages === 1 ? 0 : 1;
      return {
        ...page,
        items: page.items.slice(index, index + 1).map((item) => ({ ...item, unread: false })),
        next: firstPages === 1 ? rejectedCursor : null,
      };
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
  const view = within(canvasElement);
  await view.findByRole('list');
  await expect(view.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
  const loadMore = await view.findByRole('button', { name: m.inbox_load_more() });
  await waitFor(() => expect(loadMore).toBeEnabled());
  await userEvent.click(loadMore);
  const status = await view.findByRole('status');
  await expect(status).toHaveAttribute('data-response-status', '409');
  await expect(view.queryByRole('list')).toBeNull();
  await expect(view.queryByText(m.inbox_empty())).toBeNull();
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
    const view = within(context.canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_retry() }));
    await waitFor(() => expect(restartRequests).toEqual([undefined, rejectedCursor, rejectedCursor]));
    await expect(view.getByRole('status')).toHaveAttribute('data-response-status', '409');
    await waitFor(() => expect(view.getByRole('button', { name: m.inbox_start_first_page() })).toBeEnabled(), {
      timeout: 5000,
    });
    await expect(view.queryByRole('list')).toBeNull();
  },
};

export const RestartAfterRejectedContinuation: Story = {
  name: 'Explicit first-page restart after rejection',
  parameters: restartParameters,
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <RejectedContinuationExample />,
  play: async (context) => {
    await rejectedContinuation(context);
    const view = within(context.canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_start_first_page() }));
    const list = within(await view.findByRole('list'));
    await expect(list.getAllByRole('listitem').map((row) => row.getAttribute('data-notice-id'))).toEqual([
      '01a17a3b-0884-721b-91ef-d7ffd7bb5802',
    ]);
    await expect(restartRequests).toEqual([undefined, rejectedCursor, undefined]);
    await expect(view.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await expect(view.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
    await expect(view.queryByText(m.inbox_unavailable())).toBeNull();
  },
};

export const FirstPageRestartUnavailable: Story = {
  name: 'First-page restart unavailable, then deliberate retry',
  parameters: restartParameters,
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <RejectedContinuationExample failedReset />,
  play: async (context) => {
    await rejectedContinuation(context);
    const view = within(context.canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.inbox_start_first_page() }));
    const status = await view.findByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(view.queryByRole('list')).toBeNull();
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
    await expect(view.queryByRole('button', { name: m.inbox_start_first_page() })).toBeNull();
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeDisabled();
    await waitFor(() => expect(retry).toBeEnabled(), { timeout: 5000 });
    await expect(restartRequests).toEqual([undefined, rejectedCursor, undefined]);
    await userEvent.click(retry);
    const list = within(await view.findByRole('list'));
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
    await expect(view.getByRole('list')).toBeVisible();
  },
};

export const SeenUnavailable: Story = {
  name: 'Mark seen unavailable without a native wait',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const status = (await view.findByText(m.inbox_seen_unavailable())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(status).toHaveAttribute('data-response-code', 'deadline_exceeded');
    await expect(within(status).getByRole('button', { name: m.inbox_retry() })).toBeEnabled();
    await expect(within(status).queryByText(m.settings_retry_wait())).toBeNull();
    await expect(view.queryByText(m.inbox_preparing())).toBeNull();
    await expect(view.getByRole('list')).toBeVisible();
  },
};

export const SeenClosed: Story = {
  name: 'Mark seen closed after a readable Inbox',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-closed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const status = (await view.findByText(m.inbox_seen_closed())).closest('section')!;
    await expect(status).toHaveAttribute('data-response-code', 'platform_closed');
    await expect(view.getByRole('list')).toBeVisible();
  },
};

export const SeenDenied: Story = {
  name: 'Mark seen denied after a readable Inbox',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <SeenInboxStory fixture="seen-denied" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
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
    const main = within(await view.findByRole('main'));
    await main.findByText(m.inbox_seen_rate_limited());
    await userEvent.click(view.getByRole('button', { name: 'Session becomes unknown' }));
    await main.findByText(m.inbox_loading());
    await expect(main.queryByRole('list')).toBeNull();
    await expect(main.queryByText(m.inbox_seen_unavailable())).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_retry() })).toBeNull();
    await expect(inboxSeenRecoveryStory.commands).toHaveLength(1);
  },
};
