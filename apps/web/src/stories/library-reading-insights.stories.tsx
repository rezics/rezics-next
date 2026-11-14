import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { ReadingInsightsView } from '../library/reading-insights/page';
import { readingInsightsExample } from '../library/reading-insights/story-values';
import type { InsightsState } from '../library/reading-insights/current';
import { m } from '../paraglide/messages.js';

const full = readingInsightsExample();
const meta = {
  title: 'Library/Reading Insights',
  id: 'pages-library-reading-insights',
  component: ReadingInsightsView,
  parameters: { layout: 'fullscreen' },
  args: { year: 2026, state: { kind: 'ready', value: full }, onRefresh: () => {}, onYear: () => {} },
} satisfies Meta<typeof ReadingInsightsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FivePanels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: m.library_insights_current_progress() })).toBeVisible();
    await expect(canvas.getByText('9007199254740993.250000')).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_insights_unallocated() })).toHaveAttribute(
      'href',
      expect.stringContaining('year=2026&month=unallocated'),
    );
    await expect(canvas.getAllByText(m.library_insights_historical_unknown())[0]!).toBeVisible();
  },
};

export const GenuineZero: Story = {
  args: { state: { kind: 'ready', value: readingInsightsExample(2026, true) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText(m.library_insights_none()).length).toBeGreaterThan(0);
    await expect(canvas.queryByText(m.library_insights_not_installed())).toBeNull();
    await expect(canvas.getByRole('link', { name: m.library_insights_diary() })).toHaveAttribute(
      'href',
      expect.stringContaining('year=2026'),
    );
  },
};

const partial = {
  ...full,
  panels: {
    ...full.panels,
    reportedYear: { status: 'failed' as const, reason: 'deadline_exceeded' as const },
    profiles: {
      status: 'received' as const,
      value: {
        scope: 'selected_reported_year' as const,
        year: 2026,
        state: 'unavailable' as const,
        reason: 'initializing' as const,
        coverage: { initializedSessions: '7', retainedSessions: '30' },
      },
    },
    assessments: {
      status: 'received' as const,
      value: {
        scope: 'retained_nonretired_sessions' as const,
        state: 'unavailable' as const,
        reason: 'not_installed' as const,
        coverage: { initializedSessions: null, retainedSessions: null },
      },
    },
  },
};
export const IndependentFailure: Story = {
  args: { state: { kind: 'ready', value: partial } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_insights_failed())).toBeVisible();
    await expect(canvas.getByText('9007199254740993.250000')).toBeVisible();
    await expect(canvas.getByText(m.library_insights_initializing())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_insights_unallocated() })).toHaveAttribute(
      'href',
      expect.stringContaining('month=unallocated'),
    );
  },
};

export const ChangedReading: Story = {
  render: (args) => {
    const [state, setState] = useState<InsightsState>({ kind: 'changed' });
    return <ReadingInsightsView {...args} state={state} onRefresh={() => setState({ kind: 'ready', value: full })} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.library_insights_changed())).toBeVisible();
    await expect(canvas.queryByText('9007199254740993.250000')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.library_insights_refresh() }));
    await expect(canvas.getByText('9007199254740993.250000')).toBeVisible();
  },
};
