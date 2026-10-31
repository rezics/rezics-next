import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { inboxReadRecoveryStory } from '../kernel/fake/notifications';

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
