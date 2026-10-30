import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import { readInboxPage, type InboxPage } from '../inbox/inbox-read';
import { UnreadBadgeView } from '../inbox/unread-badge';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Patterns/Account/Inbox',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The real Inbox component with controlled page IO for pagination recovery. Reuses the existing mixed native-shaped fixture through readInboxPage; no second notice fixture or native proof. Review the same IDs with phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function Example({ fixture }: { fixture: string }) {
  return (
    <PatternStory visitor="Signed In" path={`/inbox?fixture=${fixture}`}>
      <InboxPageView />
    </PatternStory>
  );
}

const secondCursor = 'opaque.signed+second/cursor==';
const thirdCursor = 'opaque.signed+third/cursor==';
const fourthCursor = 'opaque.signed+fourth/cursor==';

function PaginationExample({ denied = false }: { denied?: boolean }) {
  const loadPage = useMemo(() => {
    let attempts = 0;
    return async (cursor?: string): Promise<InboxPage> => {
      if (cursor === secondCursor) {
        attempts++;
        if (denied) return { signedIn: true, state: 'unavailable', failure: { status: 403, code: 'forbidden' } };
        if (attempts === 1)
          return {
            signedIn: true,
            state: 'preparing',
            failure: { status: 503, code: 'dependency_unavailable', retryable: true },
          };
      }
      if (cursor === thirdCursor) return { signedIn: true, state: 'ready', items: [], next: fourthCursor };
      // Only the IO sequence is controlled; rows still come from the existing inbox source adapter.
      const page = await readInboxPage({ data: {} });
      if (!page.signedIn || page.state !== 'ready') return page;
      if (cursor === undefined) return { ...page, items: page.items.slice(0, 1), next: secondCursor };
      if (cursor === secondCursor) return { ...page, items: page.items.slice(0, 2), next: thirdCursor };
      await expect(cursor).toBe(fourthCursor);
      return { ...page, items: page.items.slice(1), next: null };
    };
  }, [denied]);
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <InboxPageView loadPage={loadPage} />
    </PatternStory>
  );
}

export const PaginationRecovery: Story = {
  render: () => <PaginationExample />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = within(await view.findByRole('list'));
    const original = list.getByRole('link');
    const href = original.getAttribute('href');
    const loadMore = await view.findByRole('button', { name: m.inbox_load_more() });
    await waitFor(() => expect(loadMore).toBeEnabled());
    await userEvent.click(loadMore);
    await view.findByText(m.inbox_page_retry_hint());
    await expect(list.getAllByRole('listitem')).toHaveLength(1);
    await expect(original).toHaveAttribute('href', href);
    original.focus();
    await expect(original).toHaveFocus();
    await expect(view.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.inbox_retry() }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(2));
    await expect(view.queryByText(m.inbox_page_retry_hint())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(() => expect(view.getByRole('button', { name: m.inbox_load_more() })).toBeEnabled());
    await expect(list.getAllByRole('listitem')).toHaveLength(2);
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(() => expect(list.getAllByRole('listitem')).toHaveLength(3));
    await expect(view.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await expect(list.getAllByRole('listitem').map((row) => row.getAttribute('data-notice-id'))).toEqual([
      '01a17a3b-0884-721b-91ef-d7ffd7bb5801',
      '01a17a3b-0884-721b-91ef-d7ffd7bb5802',
      '01a17a3b-0884-721b-91ef-d7ffd7bb5803',
    ]);
  },
};

export const PaginationDenied: Story = {
  render: () => <PaginationExample denied />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('list');
    const loadMore = await view.findByRole('button', { name: m.inbox_load_more() });
    await waitFor(() => expect(loadMore).toBeEnabled());
    await userEvent.click(loadMore);
    await view.findByText(m.inbox_unavailable());
    const status = view.getByRole('status');
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(status).toHaveAttribute('data-response-code', 'forbidden');
    await expect(view.queryByRole('list')).toBeNull();
    await expect(view.queryByRole('link')).toBeNull();
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.inbox_retry() }));
    await expect(status).toHaveAttribute('data-response-status', '403');
    await expect(view.queryByRole('list')).toBeNull();
  },
};
export const NativeRows: Story = {
  render: () => <Example fixture="mixed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = within(await view.findByRole('list'));
    await expect(list.getAllByRole('listitem')).toHaveLength(3);
    await userEvent.tab();
    await expect(list.getAllByRole('link')[0]).toHaveFocus();
  },
};
export const Empty: Story = {
  render: () => <Example fixture="empty" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.inbox_empty());
  },
};
export const DependencyUnavailable: Story = {
  render: () => <Example fixture="unavailable-operation" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.inbox_retry() }));
    await view.findByText(m.inbox_unavailable());
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
  },
};
export const HiddenTarget: Story = {
  render: () => <Example fixture="unavailable" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    await list.findByText(m.inbox_unavailable_item());
    await expect(list.queryByRole('link')).toBeNull();
  },
};
export const UnreadUnavailable: Story = {
  render: () => (
    <div className="p-4">
      <a href="#inbox-preview" className="inline-flex items-center gap-3">
        {m.inbox_heading()}
        <UnreadBadgeView data={{ signedIn: true, state: 'unavailable', failure: { status: 503 } }} />
      </a>
      <div id="inbox-preview">
        <Example fixture="mixed" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('img', { name: m.inbox_unread_unavailable() })).toBeEmptyDOMElement();
    await userEvent.click(view.getByRole('link', { name: new RegExp(m.inbox_heading()) }));
    await view.findByRole('list');
  },
};

export const ModeratorResponse: Story = {
  render: () => <Example fixture="report-moderator" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    await list.findByText(m.inbox_unavailable_item());
    await expect(list.queryByRole('link')).toBeNull();
    await expect(list.queryByText('Repeated advertising in this discussion.')).toBeNull();
  },
};

export const RowAnnouncements: Story = {
  render: () => <Example fixture="row-overlay" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    const rows = list.getAllByRole('listitem');
    await expect(rows.map((row) => row.getAttribute('data-unread'))).toEqual(['true', 'false']);
    for (const row of rows) {
      const link = within(row).getByRole('link');
      const content = row.querySelector('p')!.textContent;
      const byline = row.querySelector('[data-notice-byline]')!.textContent!.replace(' · ', '. ');
      const state = row.dataset.unread === 'true' ? m.inbox_notice_unread() : m.inbox_notice_read();
      const time = row.querySelector('time')!;
      const date = new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'full',
        timeStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(time.dateTime));
      await expect(link).toHaveAccessibleName([content, byline, state, date].join('. '));
      await expect(time).toBeVisible();
      await expect(time.parentElement).toHaveAttribute('aria-hidden', 'true');
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    }
    await userEvent.tab();
    await expect(list.getAllByRole('link')[0]).toHaveFocus();
    await userEvent.tab();
    await expect(list.getAllByRole('link')[1]).toHaveFocus();
  },
};

export const UnavailableRowAnnouncement: Story = {
  render: () => <Example fixture="unavailable" />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    const row = within(list.getByRole('listitem'));
    await expect(row.queryByRole('link')).toBeNull();
    await expect(row.getByText(m.inbox_unavailable_item())).toBeVisible();
    const byline = list.getByRole('listitem').querySelector('[data-notice-byline]')!;
    await expect(byline).toBeVisible();
    await expect(byline).toHaveTextContent(m.inbox_actor_moderation());
    await expect(row.getByText(m.inbox_notice_read())).not.toHaveAttribute('aria-hidden', 'true');
    await expect(byline).toHaveTextContent(m.inbox_kind_moderation());
    const time = list.getByRole('listitem').querySelector('time')!;
    const date = new Intl.DateTimeFormat(getLocale(), {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: 'UTC',
    }).format(new Date(time.dateTime));
    await expect(row.getByText(date)).not.toHaveAttribute('aria-hidden', 'true');
    await expect(time).toBeVisible();
    await expect(time.parentElement).toHaveAttribute('aria-hidden', 'true');
  },
};
