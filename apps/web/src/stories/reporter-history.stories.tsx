import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { ReporterHistoryEntry, ReporterHistoryPage as HistoryPage } from '../moderation/reporter-history/model';
import { ReporterHistoryPage } from '../moderation/reporter-history/view';
import { reporterHistoryReturnHref } from '../moderation/reporter-history/navigation';
import { ReporterStatusPage } from '../moderation/reporter-status-view';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = {
  title: 'Moderation/Reporter history',
  id: 'pages-moderation-reporter-history',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const reportId = '11111111-1111-8111-8111-123411111111';
const targetId = '22222222-2222-7222-8222-234522222222';
const row: ReporterHistoryEntry = {
  id: reportId,
  target: { kind: 'thread', id: targetId },
  revisionId: null,
  reason: 'spam',
  evidence: 'Repeated advertising in this discussion.',
  createdAt: '2026-10-27T08:00:00.000Z',
  outcome: null,
  resolvedAt: null,
  targetSummary: { state: 'available', label: 'Discussion title', href: `/v1/threads/${targetId}` },
  viewer: { ownsReport: true },
  actions: {
    open: { method: 'GET', href: `/v1/reports/${reportId}` },
    follow: { method: 'GET', href: `/v1/reports/${reportId}` },
    target: { method: 'GET', href: `/v1/threads/${targetId}` },
  },
};

function page(
  state: 'ready' | 'preparing',
  entries: ReporterHistoryEntry[],
  selectedReportId: string | null = null,
  nextCursor: string | null = null,
): HistoryPage {
  return {
    state,
    entries,
    selectedReportId,
    nextCursor,
    retry: { cursor: 'opaque/history-cursor' },
    viewer: { kind: 'reporter' },
  };
}

function loaded(value: HistoryPage) {
  return { state: 'loaded' as const, page: value, nativeSourceFingerprint: 'story-native-source' };
}

function Frame({ children }: { children: ReactNode }) {
  return <PatternStory>{children}</PatternStory>;
}

export const Loading: Story = {
  render: () => (
    <Frame>
      <ReporterHistoryPage result={{ state: 'loading' }} query={{}} />
    </Frame>
  ),
};

function suppliedRow(id: string, changes: Partial<ReporterHistoryEntry>): ReporterHistoryEntry {
  return {
    ...row,
    id,
    actions: {
      ...row.actions,
      open: { method: 'GET', href: `/v1/reports/${id}` },
      follow: { method: 'GET', href: `/v1/reports/${id}` },
    },
    ...changes,
  };
}

const resolved = suppliedRow('33333333-3333-8333-8333-345633333333', {
  reason: 'inappropriate',
  outcome: 'actioned',
  resolvedAt: '2026-10-28T08:00:00.000Z',
});
const withheld = suppliedRow('44444444-4444-8444-8444-456744444444', {
  target: { kind: 'realm', id: '55555555-5555-8555-8555-567855555555' },
  targetSummary: { state: 'unavailable' },
  reason: 'native_policy_reason',
  outcome: 'dismissed',
  resolvedAt: '2026-10-29T08:00:00.000Z',
  actions: {
    open: { method: 'GET', href: '/v1/reports/44444444-4444-8444-8444-456744444444' },
    follow: { method: 'GET', href: '/v1/reports/44444444-4444-8444-8444-456744444444' },
    target: null,
  },
});

export const PendingResolvedAndWithheld: Story = {
  name: 'Illustrative pending, resolved and selected withheld target',
  render: () => (
    <Frame>
      <ReporterHistoryPage
        result={loaded(page('ready', [
          {
            ...row,
            targetSummary: {
              state: 'available',
              label: 'A long discussion title about shared reading, repeated advertisements and the original submission context',
              href: `/v1/threads/${targetId}`,
            },
          },
          resolved,
          withheld,
        ], withheld.id, 'next-frontier'))}
        query={{ cursor: 'opaque/history-cursor', reportId: withheld.id }}
      />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText(m.reporter_status_pending(), { exact: true })).toHaveLength(1);
    await expect(canvas.getAllByText(m.moderation_actioned(), { exact: true })).toHaveLength(1);
    await expect(canvas.getAllByText(m.moderation_dismissed(), { exact: true })).toHaveLength(1);
    await expect(canvas.getByText(m.reporter_history_item_unavailable())).toBeVisible();
    await expect(canvasElement.innerHTML).not.toContain(withheld.target.id);
    const status = canvas.getByRole('link', { name: m.reporter_status_view() });
    const href = new URL(status.getAttribute('href')!, 'https://site.test');
    await expect(href.searchParams.get('historyCursor')).toBe('opaque/history-cursor');
    await expect(href.searchParams.get('historyReportId')).toBe(withheld.id);
  },
};

export const Preparing: Story = {
  name: 'Preparing private history',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={loaded(page('preparing', []))} query={{ cursor: 'opaque/history-cursor' }} />
    </Frame>
  ),
};

export const CompleteEmpty: Story = {
  name: 'Complete empty history',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={loaded(page('ready', []))} query={{}} />
    </Frame>
  ),
};

export const SparseContinuation: Story = {
  name: 'Sparse page with continuation',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={loaded(page('ready', [row], null, 'next-frontier'))} query={{}} />
    </Frame>
  ),
};

export const Denied: Story = {
  name: 'Denied history',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={{ state: 'denied' }} query={{}} />
    </Frame>
  ),
};

export const FailedContinuation: Story = {
  name: 'Failed continuation with exact retry',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={{ state: 'unavailable' }} query={{ cursor: 'opaque/history-cursor' }} />
    </Frame>
  ),
};

export const SelectedUnavailable: Story = {
  name: 'Selected report unavailable',
  render: () => (
    <Frame>
      <ReporterHistoryPage
        result={loaded(page('ready', [], null))}
        query={{ cursor: 'opaque/history-cursor', reportId }}
      />
    </Frame>
  ),
};

export const ExpiredRestart: Story = {
  name: 'Expired history with explicit restart',
  render: () => (
    <Frame>
      <ReporterHistoryPage result={{ state: 'expired' }} query={{ cursor: 'expired-cursor', reportId }} />
    </Frame>
  ),
};

function KeyboardSelection() {
  const [selected, setSelected] = useState(false);
  const [opened, setOpened] = useState(false);
  if (opened)
    return (
      <ReporterStatusPage
        report={{
          id: reportId,
          target: row.target,
          revisionId: row.revisionId,
          reason: 'spam',
          evidence: row.evidence,
          reporterId: '66666666-6666-8666-8666-678966666666',
          createdAt: row.createdAt,
          outcome: 'dismissed',
          resolvedAt: '2026-10-28T08:00:00.000Z',
          targetAvailability: 'available',
        }}
        returnHref={localizeHref(reporterHistoryReturnHref({ historyReportId: reportId }, reportId)!)}
        onReturn={() => setOpened(false)}
      />
    );
  return (
    <ReporterHistoryPage
      result={loaded(page('ready', [row], selected ? reportId : null))}
      query={selected ? { reportId } : { cursor: 'phone-cursor' }}
      onSelect={() => setSelected(true)}
      onOpenStatus={async () => setOpened(true)}
    />
  );
}

export const KeyboardHistory: Story = {
  name: 'Illustrative keyboard selection, status and return',
  render: () => (
    <Frame>
      <KeyboardSelection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: m.reporter_status_view() })).toBeDisabled();
    await expect(canvas.queryByRole('link', { name: m.reporter_status_view() })).toBeNull();
    const select = canvas.getByRole('button', { name: m.reporter_history_select() });
    select.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: m.reporter_history_selected() })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const status = canvas.getByRole('link', { name: m.reporter_status_view() });
    const href = new URL(status.getAttribute('href')!, 'https://site.test');
    await expect(status).toBeVisible();
    await expect(href.pathname).toBe(`/${getLocale()}/moderation/reports/${reportId}`);
    await expect(href.searchParams.get('historyCursor')).toBeNull();
    await expect(href.searchParams.get('historyReportId')).toBe(reportId);
    status.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('heading', { level: 1, name: m.reporter_status_heading() })).toBeVisible();
    await expect(canvas.getAllByText(m.moderation_dismissed(), { exact: true })).toHaveLength(1);
    const back = canvas.getByRole('link', { name: m.reporter_history_return() });
    back.focus();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('button', { name: m.reporter_history_selected() })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  },
};
