import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { InboxPageView, InboxRows } from '../inbox/inbox-page';
import { inboxContent } from '../inbox/adapters/presentation';
import {
  readInboxPage,
  readyInboxPage,
  type InboxPage,
  type InboxPageQuery,
  type ResolvedInboxPage,
} from '../inbox/inbox-read';
import { UnreadBadgeView } from '../inbox/unread-badge';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Account/Inbox Workflow',
  id: 'patterns-account-inbox',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The real Inbox components with controlled page IO for pagination recovery and an illustrative long-content DTO for wrapping review. Recovery states reuse the existing mixed native-shaped fixture through readInboxPage. No native proof is claimed. Review the same IDs with phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
function Example({ fixture }: { fixture: string }) {
  return (
    <PatternStory visitor="Signed In" path={`/inbox?fixture=${fixture}`}>
      <InboxPageView content={inboxContent} />
    </PatternStory>
  );
}

const secondCursor = 'opaque.signed+second/cursor==';
const thirdCursor = 'opaque.signed+third/cursor==';
const fourthCursor = 'opaque.signed+fourth/cursor==';

function PaginationExample({ denied = false }: { denied?: boolean }) {
  const loadPage = useMemo(() => {
    let attempts = 0;
    return async (query: InboxPageQuery): Promise<InboxPage> => {
      const cursor = query.cursor;
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
      const page = await readInboxPage({ data: { selection: query.selection } });
      if (!page.signedIn || page.state !== 'ready') return page;
      if (cursor === thirdCursor) return readyInboxPage([], fourthCursor, page.viewer.accountId, query.selection);
      if (cursor === undefined)
        return readyInboxPage(page.items.slice(0, 1), secondCursor, page.viewer.accountId, query.selection);
      if (cursor === secondCursor)
        return readyInboxPage(page.items.slice(0, 2), thirdCursor, page.viewer.accountId, query.selection);
      await expect(cursor).toBe(fourthCursor);
      return readyInboxPage(page.items.slice(1), null, page.viewer.accountId, query.selection);
    };
  }, [denied]);
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <InboxPageView loadPage={loadPage} content={inboxContent} />
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
    await waitFor(() => expect(view.getByRole('button', { name: m.inbox_next_page() })).toBeEnabled());
    await expect(view.queryByRole('list')).toBeNull();
    await expect(view.queryByText(m.inbox_empty())).toBeNull();
    await view.findByText(m.inbox_selection_sparse());
    await userEvent.click(view.getByRole('button', { name: m.inbox_next_page() }));
    const replaced = within(await view.findByRole('list'));
    await waitFor(() => expect(replaced.getAllByRole('listitem')).toHaveLength(2));
    await expect(view.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await expect(replaced.getAllByRole('listitem').map((row) => row.getAttribute('data-notice-id'))).toEqual([
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

const unreadContinuationCursor = 'opaque.signed+unread-filter/cursor==';
const emptyContinuationCursor = 'opaque.signed+all-empty/cursor==';
const emptyRetryCursor = 'opaque.signed+all-empty-retry/cursor==';

function EmptyFilterContinuationCase({ mode }: { mode: 'unread' | 'all-empty' }) {
  const [requestedCursors, setRequestedCursors] = useState<Array<string | null>>([]);
  const loadPage = useMemo(() => {
    let continuationAttempts = 0;
    return async (query: InboxPageQuery): Promise<InboxPage> => {
      await Promise.resolve();
      const cursor = query.cursor;
      setRequestedCursors((current) => [...current, cursor ?? null]);
      if (mode === 'unread' && cursor === unreadContinuationCursor && continuationAttempts++ === 0)
        return {
          signedIn: true,
          state: 'unavailable',
          failure: { status: 503, code: 'dependency_unavailable', retryable: true },
        };
      if (mode === 'all-empty' && cursor === emptyRetryCursor && continuationAttempts++ === 0)
        return {
          signedIn: true,
          state: 'unavailable',
          failure: { status: 503, code: 'dependency_unavailable', retryable: true },
        };

      const source = await readInboxPage({ data: { selection: query.selection } });
      if (!source.signedIn || source.state !== 'ready') return source;
      const accountId = source.viewer.accountId;
      if (cursor === undefined) {
        return query.selection === 'unread' || mode === 'all-empty'
          ? readyInboxPage(
              [],
              query.selection === 'unread' ? unreadContinuationCursor : emptyContinuationCursor,
              accountId,
              query.selection,
            )
          : readyInboxPage(
              source.items.slice(0, 1).map((item) => ({ ...item, unread: false })),
              unreadContinuationCursor,
              accountId,
              query.selection,
            );
      }
      if (mode === 'all-empty' && cursor === emptyContinuationCursor)
        return readyInboxPage([], emptyRetryCursor, accountId, query.selection);

      await expect(cursor).toBe(mode === 'unread' ? unreadContinuationCursor : emptyRetryCursor);
      return query.selection === 'unread'
        ? readyInboxPage([], null, accountId, query.selection)
        : readyInboxPage(source.items.slice(1, 2), null, accountId, query.selection);
    };
  }, [mode]);

  return (
    <section
      data-inbox-case={mode}
      data-requested-cursors={JSON.stringify(requestedCursors)}
      className="border-b border-border px-4 py-6 last:border-b-0 sm:px-6"
    >
      <h2 className="mb-3 font-display text-xl font-semibold">
        {mode === 'unread' ? 'Unread filter recovery' : 'All-empty continuation'}
      </h2>
      <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
        <InboxPageView loadPage={loadPage} content={inboxContent} />
      </PatternStory>
    </section>
  );
}

function EmptyFilterContinuationExample() {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <EmptyFilterContinuationCase mode="unread" />
      <EmptyFilterContinuationCase mode="all-empty" />
    </div>
  );
}

export const EmptyFilterContinuationRecovery: Story = {
  render: () => <EmptyFilterContinuationExample />,
  play: async ({ canvasElement }) => {
    const unreadSection = canvasElement.querySelector<HTMLElement>('[data-inbox-case="unread"]')!;
    const unread = within(unreadSection);
    await unread.findByRole('list');
    await waitFor(() => expect(unreadSection.dataset.requestedCursors).toBe('[null]'));
    const originalList = within(unread.getByRole('list'));
    const originalId = originalList.getByRole('listitem').getAttribute('data-notice-id');
    await expect(originalId).not.toBeNull();

    await userEvent.click(unread.getByRole('button', { name: m.inbox_triage_filter_unread() }));
    await unread.findByText(m.inbox_triage_no_unread_loaded());
    await unread.findByText(m.inbox_triage_older_pages());
    await expect(unread.queryByText(m.inbox_empty())).toBeNull();
    await expect(unread.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();
    await expect(unreadSection.dataset.requestedCursors).toBe('[null]');

    await userEvent.click(unread.getByRole('button', { name: m.inbox_load_more() }));
    await unread.findByText(m.inbox_unavailable());
    await waitFor(() =>
      expect(unreadSection.dataset.requestedCursors).toBe(JSON.stringify([null, unreadContinuationCursor])),
    );
    await unread.findByText(m.inbox_page_retry_hint());
    await unread.findByText(m.inbox_triage_no_unread_loaded());
    await unread.findByText(m.inbox_triage_older_pages());
    await expect(unread.queryByText(m.inbox_empty())).toBeNull();
    await expect(unread.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    const retry = unread.getByRole('button', { name: m.inbox_retry() });
    await expect(retry).toBeEnabled();
    await expect(unread.getByRole('button', { name: m.inbox_start_first_page() })).toBeEnabled();

    await userEvent.click(unread.getByRole('button', { name: m.inbox_triage_filter_all() }));
    const retainedRows = within(await unread.findByRole('list')).getAllByRole('listitem');
    await expect(retainedRows).toHaveLength(1);
    await expect(retainedRows[0]!).toHaveAttribute('data-notice-id', originalId!);
    await expect(unread.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();
    await userEvent.click(unread.getByRole('button', { name: m.inbox_triage_filter_unread() }));
    await userEvent.click(unread.getByRole('button', { name: m.inbox_retry() }));
    await waitFor(() =>
      expect(unreadSection.dataset.requestedCursors).toBe(
        JSON.stringify([null, unreadContinuationCursor, unreadContinuationCursor]),
      ),
    );
    await waitFor(() => expect(unread.queryByText(m.inbox_unavailable())).toBeNull());
    await expect(unread.queryByText(m.inbox_triage_older_pages())).toBeNull();
    await expect(unread.queryByText(m.inbox_empty())).toBeNull();
    await userEvent.click(unread.getByRole('button', { name: m.inbox_triage_filter_all() }));
    const recoveredRows = within(await unread.findByRole('list')).getAllByRole('listitem');
    await expect(recoveredRows).toHaveLength(2);
    await expect(recoveredRows[0]!).toHaveAttribute('data-notice-id', originalId!);
    await expect(unread.queryByRole('button', { name: m.inbox_triage_mark() })).toBeNull();

    const emptySection = canvasElement.querySelector<HTMLElement>('[data-inbox-case="all-empty"]')!;
    const empty = within(emptySection);
    await empty.findByText(m.inbox_triage_no_loaded());
    await empty.findByText(m.inbox_triage_older_pages());
    await expect(empty.queryByText(m.inbox_empty())).toBeNull();
    await waitFor(() => expect(emptySection.dataset.requestedCursors).toBe('[null]'));
    await userEvent.click(empty.getByRole('button', { name: m.inbox_load_more() }));
    await waitFor(() =>
      expect(emptySection.dataset.requestedCursors).toBe(JSON.stringify([null, emptyContinuationCursor])),
    );
    await expect(empty.queryByText(m.inbox_empty())).toBeNull();
    await expect(empty.queryByRole('list')).toBeNull();
    const continueEmpty = empty.getByRole('button', { name: m.inbox_load_more() });
    await waitFor(() => expect(continueEmpty).toBeEnabled());
    await userEvent.click(continueEmpty);
    await empty.findByText(m.inbox_unavailable());
    await waitFor(() =>
      expect(emptySection.dataset.requestedCursors).toBe(
        JSON.stringify([null, emptyContinuationCursor, emptyRetryCursor]),
      ),
    );
    await empty.findByText(m.inbox_triage_no_loaded());
    await empty.findByText(m.inbox_triage_older_pages());
    await expect(empty.queryByText(m.inbox_empty())).toBeNull();
    await expect(empty.queryByRole('button', { name: m.inbox_load_more() })).toBeNull();
    await expect(empty.getByRole('button', { name: m.inbox_retry() })).toBeEnabled();
    await userEvent.click(empty.getByRole('button', { name: m.inbox_retry() }));
    await waitFor(() =>
      expect(emptySection.dataset.requestedCursors).toBe(
        JSON.stringify([null, emptyContinuationCursor, emptyRetryCursor, emptyRetryCursor]),
      ),
    );
    await waitFor(() => expect(empty.queryByText(m.inbox_unavailable())).toBeNull());
    const recoveredList = within(await empty.findByRole('list'));
    await waitFor(() => expect(recoveredList.getAllByRole('listitem')).toHaveLength(3));
    await expect(empty.queryByText(m.inbox_empty())).toBeNull();
    await expect(empty.queryByText(m.inbox_triage_marked())).toBeNull();
  },
};

export const NativeRows: Story = {
  render: () => <Example fixture="mixed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = within(await view.findByRole('list', { name: m.inbox_heading() }));
    await expect(list.getAllByRole('listitem')).toHaveLength(3);
    await expect(list.getAllByRole('link')[0]).toHaveAttribute(
      'href',
      '/threads/01a17a3b-0884-721b-91ef-d7ffd7bb58f1#post-01a17a3b-0884-721b-91ef-d7ffd7bb58f2',
    );
    await userEvent.tab();
    await expect(list.getAllByRole('link')[0]).toHaveFocus();
  },
};

// Illustrative current resolved DTO only: no session, transport, new fixture world or native recording.
const illustrativeLongContent: Pick<ResolvedInboxPage, 'items' | 'next'> = {
  items: [
    {
      id: 'illustrative-long-token',
      kind: 'reply',
      actorId: 'illustrative-author',
      threadId: 'illustrative-thread',
      postId: 'illustrative-long-token',
      decisionId: null,
      reportId: null,
      actorName: 'IllustrativePublicNameWithoutSpaces'.repeat(2),
      unread: true,
      createdAt: '2026-10-29T10:00:00.000Z',
      text: `https://example.invalid/${'LongUnbrokenInboxToken'.repeat(12)}`,
      href: '/threads/illustrative-thread#illustrative-long-token',
      unavailable: false,
    },
    {
      id: 'illustrative-cjk',
      kind: 'mention',
      actorId: 'illustrative-cjk-author',
      threadId: 'illustrative-thread',
      postId: 'illustrative-cjk',
      decisionId: null,
      reportId: null,
      actorName: 'Illustrative CJK reader',
      unread: false,
      createdAt: '2026-10-28T10:00:00.000Z',
      text: '這是一段用於檢查收件匣換行的示例文字。これは受信トレイの折り返しを確認するための例文です。'.repeat(3),
      href: '/threads/illustrative-thread#illustrative-cjk',
      unavailable: false,
    },
    {
      id: 'illustrative-long-paragraph',
      kind: 'reply',
      actorId: 'illustrative-reader',
      threadId: 'illustrative-thread',
      postId: 'illustrative-long-paragraph',
      decisionId: null,
      reportId: null,
      actorName: 'Illustrative reader with a long public name containing ordinary spaces',
      unread: false,
      createdAt: '2026-10-27T10:00:00.000Z',
      text: 'An illustrative reply keeps its complete explanation visible as the notice grows across several lines. Each sentence should remain easy to read on a phone and on a wider screen, with the author, notification kind and date following the complete message.',
      href: '/threads/illustrative-thread#illustrative-long-paragraph',
      unavailable: false,
    },
  ],
  next: null,
};

export const LongContent: Story = {
  render: () => (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{m.inbox_heading()}</h1>
      <InboxRows page={illustrativeLongContent} content={inboxContent} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list'));
    const rows = list.getAllByRole('listitem');
    await expect(rows).toHaveLength(illustrativeLongContent.items.length);
    for (const [index, row] of rows.entries()) {
      const item = illustrativeLongContent.items[index]!;
      const text = row.querySelector('p')!;
      const byline = row.querySelector('[data-notice-byline]')!;
      await expect(text.textContent).toBe(item.text);
      await expect(byline).toHaveTextContent(item.actorName!);
      for (const block of [text, byline.parentElement!]) {
        await expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
      }
      const link = within(row).getByRole('link');
      await expect(link).toHaveAttribute('href', item.href);
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(link.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await userEvent.tab();
      await expect(link).toHaveFocus();
    }
    const viewport = canvasElement.ownerDocument.documentElement;
    await expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
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
