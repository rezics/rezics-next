import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { InboxPageView } from '../inbox/inbox-page';
import {
  nativeInboxEnvelope,
  resolveInboxItems,
  type InboxNotice,
  type InboxPage,
  type InboxPageQuery,
} from '../inbox/inbox-read';
import type { InboxNoticeSeenAttempt } from '../inbox/inbox-read';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Account/Inbox update triage',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Connected Inbox page fixtures demonstrate chosen acknowledgement, sparse continuation, withheld report context, unavailable reads and exact retry. These authored fixtures establish no native runtime or rendered acceptance.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type View = 'mixed' | 'mixed-previous' | 'sparse' | 'report' | 'unavailable' | 'uncertain';

const timestamp = '2026-11-03T10:00:00.000Z';

function nativeNotice(id: string, kind: InboxNotice['kind']): InboxNotice {
  const moderation = kind === 'moderation_decision';
  const reportId = moderation && id === 'report-outcome' ? 'report-1' : null;
  const decisionId = moderation && reportId === null ? 'decision-1' : null;
  const board = kind === 'board_activity';
  const threadId = moderation ? null : kind === 'thread_watch' ? 'watched-thread' : 'thread-1';
  const postId = moderation ? null : 'post-1';
  const target = moderation
    ? { state: 'withheld' as const, threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null }
    : {
        state: 'available' as const,
        threadId,
        postId,
        boardId: board ? 'board-1' : null,
        threadTitle: threadId ? (kind === 'thread_watch' ? 'Reading together' : 'A current discussion') : null,
        boardTitle: board ? 'Books and reading' : null,
      };
  const actor = moderation
    ? { state: 'system' as const, displayName: 'Moderation team' as const, handle: null, avatarUrl: null }
    : {
        state: 'available' as const,
        accountId: 'actor-1',
        displayName: 'Momo',
        handle: 'momo',
        avatarUrl: null,
        automated: false,
      };
  const open = moderation
    ? reportId
      ? { kind: 'report_outcome' as const, reportId }
      : { kind: 'moderation_decision' as const, decisionId: decisionId! }
    : { kind: 'thread_post' as const, threadId: threadId!, postId: postId! };
  return {
    id,
    kind,
    createdAt: timestamp,
    unread: true,
    actorId: actor.state === 'available' ? actor.accountId : null,
    threadId,
    postId,
    decisionId,
    reportId,
    actor,
    target,
    summary: reportId ? 'Your report was actioned' : 'A useful update summary',
    actions: {
      open,
      markSeen: { method: 'POST', path: `/v1/accounts/alice/notifications/${id}:markSeen` },
    },
  };
}

const mixedNotices = [
  nativeNotice('reply-1', 'reply'),
  nativeNotice('mention-1', 'mention'),
  nativeNotice('thread-watch-1', 'thread_watch'),
  nativeNotice('board-activity-1', 'board_activity'),
  nativeNotice('report-outcome', 'moderation_decision'),
];

async function readyPage(
  notices: InboxNotice[],
  next: string | null,
  selection: InboxPageQuery['selection'] = 'all',
): Promise<InboxPage> {
  const resolved = await resolveInboxItems(nativeInboxEnvelope(notices, next, 'alice', selection));
  return { signedIn: true, state: 'ready', ...resolved };
}

function Preview({
  view,
  attempts,
  cursors,
}: {
  view: View;
  attempts: InboxNoticeSeenAttempt[];
  cursors: (string | null)[];
}) {
  const loadPage = useMemo(
    () =>
      async (query: InboxPageQuery): Promise<InboxPage> => {
        cursors.push(query.cursor ?? null);
        if (view === 'unavailable')
          return { signedIn: true, state: 'unavailable', failure: { status: 503, code: 'dependency_unavailable' } };
        if (view === 'sparse')
          return readyPage([], query.cursor === undefined ? 'opaque/+continuation==' : null, query.selection);
        if (view === 'report')
          return readyPage([nativeNotice('report-outcome', 'moderation_decision')], null, query.selection);
        if (view === 'uncertain') return readyPage([nativeNotice('reply-1', 'reply')], null, query.selection);
        if (view === 'mixed-previous' && query.cursor === 'opaque/+older==')
          return readyPage([nativeNotice('older-reply', 'reply'), nativeNotice('older-report', 'moderation_decision')], null, query.selection);
        return readyPage(mixedNotices, view === 'mixed-previous' ? 'opaque/+older==' : null, query.selection);
      },
    [cursors, view],
  );
  const acknowledgeNotice = async (attempt: InboxNoticeSeenAttempt) => {
    attempts.push(attempt);
    if (view === 'uncertain' && attempts.length === 1) throw new Error('Response lost');
  };
  return (
    <PatternStory visitor="Signed In" path="/inbox">
      <AppShell>
        <InboxPageView loadPage={loadPage} acknowledgeNotice={acknowledgeNotice} />
      </AppShell>
    </PatternStory>
  );
}

function journey(view: View, viewport: 'phone390' | 'desktop1280', theme: 'light' | 'dark'): Story {
  const attempts: InboxNoticeSeenAttempt[] = [];
  const cursors: (string | null)[] = [];
  return {
    globals: { viewport: { value: viewport, isRotated: false }, theme },
    render: () => <Preview view={view} attempts={attempts} cursors={cursors} />,
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement);
      await canvas.findByRole('heading', { name: m.inbox_heading() });
      if (view === 'mixed' || view === 'mixed-previous') {
        const list = within(await canvas.findByRole('list', { name: m.inbox_heading() }));
        const rows = await list.findAllByRole('listitem');
        await expect(rows).toHaveLength(5);
        await userEvent.click(within(rows[0]!).getByRole('button', { name: m.inbox_notice_mark_seen() }));
        await within(rows[0]!).findByText(m.inbox_notice_marked_seen());
        await expect(rows[1]).toHaveAttribute('data-unread', 'true');
        await expect(attempts[0]).toMatchObject({ accountId: 'alice', noticeId: 'reply-1' });
        if (view === 'mixed-previous') {
          await userEvent.click(await canvas.findByRole('button', { name: m.inbox_load_more() }));
          await canvas.findByRole('link', { name: 'A useful update summary' });
          await userEvent.click(await canvas.findByRole('button', { name: m.inbox_previous_page() }));
          await expect(cursors).toEqual([null, 'opaque/+older==', null]);
          await expect(within(await canvas.findByRole('list', { name: m.inbox_heading() })).getAllByRole('listitem'))
            .toHaveLength(5);
        }
      } else if (view === 'sparse') {
        await canvas.findByText(m.inbox_selection_sparse());
        const next = await canvas.findByRole('button', { name: m.inbox_next_page() });
        next.focus();
        await expect(next).toHaveFocus();
        await userEvent.keyboard('{Enter}');
        await expect(cursors).toEqual([null, 'opaque/+continuation==']);
        await canvas.findByText(m.inbox_triage_no_loaded());
      } else if (view === 'report') {
        const link = await canvas.findByRole('link', { name: 'Your report was actioned' });
        await expect(link).toHaveAttribute('href', `/${getLocale()}/moderation/reports/report-1`);
        await expect(canvas.queryByText('Hidden target')).toBeNull();
      } else if (view === 'unavailable') {
        await canvas.findByText(m.inbox_unavailable());
      } else {
        const list = within(await canvas.findByRole('list', { name: m.inbox_heading() }));
        const row = (await list.findAllByRole('listitem'))[0]!;
        await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_mark_seen() }));
        await within(row).findByText(m.inbox_notice_seen_unknown());
        await userEvent.click(within(row).getByRole('button', { name: m.inbox_notice_seen_retry() }));
        await within(row).findByText(m.inbox_notice_marked_seen());
        await expect(attempts).toHaveLength(2);
        await expect(attempts[1]).toBe(attempts[0]);
      }
    },
  };
}

export const MixedPhoneLight = journey('mixed-previous', 'phone390', 'light');
export const MixedPhoneDark = journey('mixed', 'phone390', 'dark');
export const MixedDesktopLight = journey('mixed', 'desktop1280', 'light');
export const MixedDesktopDark = journey('mixed', 'desktop1280', 'dark');
export const SparsePhoneLight = journey('sparse', 'phone390', 'light');
export const SparsePhoneDark = journey('sparse', 'phone390', 'dark');
export const SparseDesktopLight = journey('sparse', 'desktop1280', 'light');
export const SparseDesktopDark = journey('sparse', 'desktop1280', 'dark');
export const ReportWithheldPhoneLight = journey('report', 'phone390', 'light');
export const ReportWithheldPhoneDark = journey('report', 'phone390', 'dark');
export const ReportWithheldDesktopLight = journey('report', 'desktop1280', 'light');
export const ReportWithheldDesktopDark = journey('report', 'desktop1280', 'dark');
export const UnavailablePhoneLight = journey('unavailable', 'phone390', 'light');
export const UnavailablePhoneDark = journey('unavailable', 'phone390', 'dark');
export const UnavailableDesktopLight = journey('unavailable', 'desktop1280', 'light');
export const UnavailableDesktopDark = journey('unavailable', 'desktop1280', 'dark');
export const UncertainPhoneLight = journey('uncertain', 'phone390', 'light');
export const UncertainPhoneDark = journey('uncertain', 'phone390', 'dark');
export const UncertainDesktopLight = journey('uncertain', 'desktop1280', 'light');
export const UncertainDesktopDark = journey('uncertain', 'desktop1280', 'dark');
