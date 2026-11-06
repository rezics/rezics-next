import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import {
  nativeInboxEnvelope,
  resolveInboxItems,
  type InboxNotice,
  type InboxNoticeSeenAttempt,
  type InboxPage,
  type InboxPageQuery,
} from '../inbox/inbox-read';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from '../threads/thread-href';
import { AppShell } from '../shell/shell';
import { PageStory, PatternStory } from './page';
import { inboxTriageStory, resetInboxTriageStory } from '../kernel/fake/notifications';
import recordedWatch from '../kernel/recorded/notifications-inbox-thread-watch.json';

const meta = {
  title: 'Pages/Account/Inbox consumption',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Installed signed-in Inbox consumption: recorded thread_watch decoding, keyboard return to the original range, named empty/sparse/unknown-command/observation recovery. API evidence is the fake native page and one-item mark-seen transport. Native runtime acceptance remains separate.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const watchHref = threadLocation(
  getLocale(),
  { id: '01a17a3b-0884-721b-91ef-d7ffd7bb58f1', title: 'Reading together' },
  undefined,
  '01a17a3b-0884-721b-91ef-d7ffd7bb58f2',
);

function InboxStory({ fixture }: { fixture: string }) {
  return <PageStory visitor="Signed In" path={`/inbox?fixture=${fixture}`} />;
}

async function installedWatch({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const list = await view.findByRole('list', { name: m.inbox_heading() });
  await expect(within(list).getByText(m.inbox_kind_thread_activity())).toBeVisible();
  await expect(within(list).getByRole('link', { name: 'A new post on a thread you watch' })).toHaveAttribute(
    'href',
    watchHref,
  );
  await expect(recordedWatch.items[0]?.kind).toBe('thread_watch');
  await expect(recordedWatch.items[0]?.actor).toMatchObject({ state: 'available', avatar: null, avatarUrl: null });
}

export const InstalledWatchPhone: Story = {
  name: 'Recorded thread_watch on phone',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <InboxStory fixture="thread-watch" />,
  play: installedWatch,
};

export const InstalledWatchDesktop: Story = {
  name: 'Recorded thread_watch on desktop',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <InboxStory fixture="thread-watch" />,
  play: installedWatch,
};

export const GenuineEmpty: Story = {
  name: 'Genuine empty Inbox',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <InboxStory fixture="empty" />,
  play: async ({ canvasElement }) => {
    await within(canvasElement).findByText(m.inbox_empty());
    await expect(within(canvasElement).queryByRole('list', { name: m.inbox_heading() })).toBeNull();
  },
};

export const SparseContinuing: Story = {
  name: 'Sparse continuing unread page',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <InboxStory fixture="sparse-unread" />,
  play: async ({ canvasElement }) => {
    const main = within(canvasElement);
    await main.findByText(m.inbox_selection_sparse());
    const unread = main.getByRole('button', { name: m.inbox_triage_filter_unread() });
    unread.focus();
    await userEvent.keyboard('{Enter}');
    await main.findByText(m.inbox_triage_no_unread_loaded());
    const next = await main.findByRole('button', { name: m.inbox_next_page() });
    next.focus();
    await userEvent.keyboard('{Enter}');
    await main.findByRole('list', { name: m.inbox_heading() });
  },
};

function nativeNotice(id: string, kind: InboxNotice['kind'], unread = true): InboxNotice {
  const moderation = kind === 'moderation_decision';
  const threadId = moderation ? null : '01a17a3b-0884-721b-91ef-d7ffd7bb58f1';
  const postId = moderation ? null : '01a17a3b-0884-721b-91ef-d7ffd7bb58f2';
  return {
    id,
    kind,
    createdAt: '2026-11-04T10:00:00.000Z',
    unread,
    actorId: moderation ? null : '01a17a3b-0884-721b-91ef-d7ffd7bb58f0',
    threadId,
    postId,
    decisionId: moderation ? '01a17a3b-0884-721b-91ef-d7ffd7bb58f4' : null,
    reportId: null,
    actor: moderation
      ? { state: 'system', displayName: 'Moderation team', handle: null, avatar: null, avatarUrl: null }
      : {
          state: 'available',
          accountId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f0',
          displayName: 'Momo',
          handle: 'momo',
          avatar: null,
          avatarUrl: null,
          automated: false,
        },
    target: moderation
      ? { state: 'withheld', threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null }
      : {
          state: 'available',
          threadId,
          postId,
          boardId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f7',
          threadTitle: 'Reading together',
          boardTitle: 'Books',
        },
    summary: kind === 'thread_watch' ? 'A new post on a thread you watch' : 'A useful update summary',
    actions: {
      open: moderation
        ? { kind: 'moderation_decision', decisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58f4' }
        : { kind: 'thread_post', threadId: threadId!, postId: postId! },
      markSeen: { method: 'POST', path: `/v1/accounts/alice/notifications/${id}:markSeen` },
    },
  };
}

function ReturnPreview() {
  const reads: InboxPageQuery[] = [];
  const loadPage = useMemo(
    () => async (query: InboxPageQuery): Promise<InboxPage> => {
      reads.push(query);
      const resolved = await resolveInboxItems(
        nativeInboxEnvelope([nativeNotice('watch-origin', 'thread_watch')], 'watch-older', 'alice', query.selection),
      );
      return { signedIn: true, state: 'ready', ...resolved };
    },
    [],
  );
  return (
    <PatternStory visitor="Signed In" path="/inbox">
      <AppShell>
        <InboxPageView
          loadPage={loadPage}
          historyKey={reads.length > 1 ? 'returned-range' : 'original-range'}
        />
      </AppShell>
    </PatternStory>
  );
}

async function keyboardReturnPlay({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const list = await view.findByRole('list', { name: m.inbox_heading() });
  const destination = within(list).getByRole('link', { name: 'A new post on a thread you watch' });
  destination.focus();
  await expect(destination).toHaveFocus();
  await expect(destination).toHaveAttribute('href', watchHref);
  await userEvent.keyboard('{Enter}');
}

export const KeyboardReturnPhone: Story = {
  name: 'Keyboard return restores the current watch notice',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <ReturnPreview />,
  play: keyboardReturnPlay,
};

export const KeyboardReturnDesktop: Story = {
  name: 'Keyboard return on desktop',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <ReturnPreview />,
  play: keyboardReturnPlay,
};

function RecoveryPreview() {
  const attempts: InboxNoticeSeenAttempt[] = [];
  const loadPage = useMemo(
    () => async (query: InboxPageQuery): Promise<InboxPage> => {
      const resolved = await resolveInboxItems(
        nativeInboxEnvelope([nativeNotice('watch-origin', 'thread_watch')], null, 'alice', query.selection),
      );
      return { signedIn: true, state: 'ready', ...resolved };
    },
    [],
  );
  const acknowledgeNotice = async (attempt: InboxNoticeSeenAttempt) => {
    attempts.push(attempt);
    if (attempts.length === 1) throw new Error('Response lost');
  };
  return (
    <PatternStory visitor="Signed In" path="/inbox">
      <AppShell>
        <InboxPageView loadPage={loadPage} acknowledgeNotice={acknowledgeNotice} />
      </AppShell>
    </PatternStory>
  );
}

export const UnknownCommandRecovery: Story = {
  name: 'Unknown command then exact original recovery',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <RecoveryPreview />,
  play: async ({ canvasElement }) => {
    const list = within(await within(canvasElement).findByRole('list', { name: m.inbox_heading() }));
    const row = (await list.findAllByRole('listitem'))[0]!;
    await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_mark_seen() }));
    await within(row).findByText(m.inbox_notice_seen_unknown());
    await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_seen_retry() }));
    await within(row).findByText(m.inbox_notice_marked_seen());
  },
};

function ObservationStory() {
  useState(() => {
    resetInboxTriageStory();
  });
  return <InboxStory fixture="observation-recovery" />;
}

export const ObservationRecovery: Story = {
  name: 'Validated receipt then failed page observation',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <ObservationStory />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = within(await view.findByRole('list', { name: m.inbox_heading() }));
    const row = (await list.findAllByRole('listitem'))[0]!;
    await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_mark_seen() }));
    await view.findByText(m.inbox_acknowledged_observation_unavailable());
    await expect(view.queryByText(m.inbox_notice_seen_retry())).toBeNull();
    await expect(view.getByRole('button', { name: m.inbox_retry() })).toBeVisible();
  },
};

function OneItemAckStory() {
  useState(() => {
    resetInboxTriageStory();
  });
  return <InboxStory fixture="thread-watch" />;
}

export const OneItemAcknowledgement: Story = {
  name: 'One-item acknowledgement of recorded thread_watch',
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => <OneItemAckStory />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const list = await view.findByRole('list', { name: m.inbox_heading() });
    const row = within(list).getAllByRole('listitem')[0]!;
    await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_mark_seen() }));
    await within(row).findByText(m.inbox_notice_marked_seen());
    await expect(inboxTriageStory.writes.length).toBeGreaterThan(0);
  },
};
