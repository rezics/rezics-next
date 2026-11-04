import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import type { ReporterHistoryEntry, ReporterHistoryPage as HistoryPage } from '../moderation/reporter-history/model';
import { ReporterHistoryPage } from '../moderation/reporter-history/view';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PatternStory } from './page';

const meta = { title: 'Pages/Moderation/Reporter history', parameters: { layout: 'fullscreen' } } satisfies Meta;
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
  entries: readonly ReporterHistoryEntry[],
  selectedReportId: string | null = null,
  nextCursor: string | null = null,
): HistoryPage {
  return { state, entries, selectedReportId, nextCursor, retry: { cursor: 'opaque/history-cursor' }, viewer: { kind: 'reporter' } };
}

function loaded(value: HistoryPage) {
  return { state: 'loaded' as const, page: value, nativeSourceFingerprint: 'story-native-source' };
}

function Frame({ children }: { children: ReactNode }) {
  return <PatternStory>{children}</PatternStory>;
}

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
  return (
    <ReporterHistoryPage
      result={loaded(page('ready', [row], selected ? reportId : null))}
      query={{ cursor: 'phone-cursor' }}
      onSelect={() => setSelected(true)}
    />
  );
}

export const KeyboardAndPhone: Story = {
  name: 'Keyboard selection on a phone',
  parameters: {
    viewport: {
      viewports: { phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } } },
      defaultViewport: 'phone390',
    },
  },
  render: () => (
    <Frame>
      <KeyboardSelection />
    </Frame>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
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
    await expect(href.searchParams.get('historyCursor')).toBe('phone-cursor');
    await expect(href.searchParams.get('historyReportId')).toBe(reportId);
  },
};
