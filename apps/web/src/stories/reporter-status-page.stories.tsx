import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { AppShell } from '../shell/shell';
import { ReporterStatusPage } from '../moderation/reporter-status-view';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { PageStory } from './page';
import { reporterStatusViewports, submittedReport } from './reporter-status/fixture';

// Fixture-derived long references exercise the page presenter without claiming a native report receipt.
const longId = (value: string) => `${value}-${value}-${value}`;
const longEvidence = Array.from(
  { length: 8 },
  (_, index) =>
    `Evidence paragraph ${index + 1}: ${submittedReport.evidence} The full explanation remains available to the reporter.`,
).join('\n\n');
const longReferenceReport = {
  ...submittedReport,
  id: longId(submittedReport.id),
  target: { ...submittedReport.target, id: longId(submittedReport.target.id) },
  revisionId: longId(submittedReport.revisionId!),
  evidence: longEvidence,
  targetAvailability: 'unavailable' as const,
};

const meta = {
  title: 'Moderation/Reporter status Page',
  id: 'pages-reporter-status',
  parameters: { layout: 'fullscreen', viewport: { options: reporterStatusViewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SubmittedReport: Story = {
  render: () => (
    <PageStory
      visitor="Signed In"
      path="/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3?fixture=report-unavailable"
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText('Repeated advertising in this discussion.');
    await canvas.findByRole('heading', { level: 1, name: m.reporter_status_heading() });
    await expect(canvas.getAllByRole('main')).toHaveLength(1);
    const page = within(canvas.getByRole('main'));
    await expect(page.getByText(m.moderation_dismissed(), { exact: true })).toBeVisible();
    await expect(page.getByText(m.reporter_status_dismissed_explanation())).toBeVisible();
    await expect(page.getByText(m.report_spam(), { exact: true })).toBeVisible();
    await expect(page.getByText('Repeated advertising in this discussion.')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: m.reporter_status_timeline() })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: m.reporter_status_submission() })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: m.reporter_status_target() })).toBeVisible();
    await expect(page.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(page.getByText(m.reporter_status_submitted(), { exact: true })).toBeVisible();
    await expect(page.getByText(m.reporter_status_reviewed(), { exact: true })).toBeVisible();
    const timeline = page.getByRole('list', { name: m.reporter_status_timeline() });
    await expect(timeline.querySelectorAll('li')).toHaveLength(2);
    await expect(timeline.querySelectorAll('time')).toHaveLength(2);
    await expect(timeline.querySelector('time[datetime="2026-10-27T08:00:00.000Z"]')).not.toBeNull();
    await expect(timeline.querySelector('time[datetime="2026-10-28T08:00:00.000Z"]')).not.toBeNull();
    await expect(timeline.textContent).toContain('UTC');
    await expect(page.queryByText(m.reporter_status_pending(), { exact: true })).toBeNull();
    await expect(page.queryByRole('alert')).toBeNull();
    await expect(page.getByRole('link', { name: m.reporter_status_back() })).toHaveAttribute(
      'href',
      localizeHref('/inbox'),
    );
    await expect(page.getAllByRole('link')).toHaveLength(1);
  },
};

export const CurrentTarget: Story = {
  render: () => <PageStory visitor="Signed In" path="/moderation/reports/01a17a3b-0884-721b-91ef-d7ffd7bb58f3" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const page = within(await canvas.findByRole('main'));
    await expect(page.getByText(m.reporter_status_available())).toBeVisible();
    await expect(page.getByText(m.reporter_status_post(), { exact: true })).toBeVisible();
    await expect(page.queryByRole('link', { name: m.reporter_status_post() })).toBeNull();
    await userEvent.click(page.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(page.getByText('01a17a3b-0884-721b-91ef-d7ffd7bb58f3', { exact: true })).toBeVisible();
  },
};

export const IllustrativeLongReferences: Story = {
  name: 'Illustrative long references (fixture-derived)',
  render: () => <ReporterStatusPage report={longReferenceReport} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.reporter_status_heading() })).toBeVisible();
    await expect(canvas.getByText(longEvidence)).toBeVisible();
    await expect(canvas.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('link', { name: m.reporter_status_post() })).toBeNull();
    await userEvent.click(canvas.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(canvas.getByText(longReferenceReport.id, { exact: true })).toBeVisible();
    await expect(canvas.getByText(longReferenceReport.target.id, { exact: true })).toBeVisible();
    await expect(canvas.getByText(longReferenceReport.revisionId!, { exact: true })).toBeVisible();
  },
};

/** Explicit page-state fixtures complement the actual routed SubmittedReport story above. */
function ReadStatePage({ retired = false }: { retired?: boolean }) {
  const [cache] = useState(() => new QueryClient());
  const [router] = useState(() => {
    const route = createRootRoute({
      component: () => (
        <AppShell>
          {retired ? (
            <ReporterStatusPage state="concealed" />
          ) : (
            <ReporterStatusPage
              onRetry={async () => {
                throw new Error('Report status unavailable');
              }}
            />
          )}
        </AppShell>
      ),
    });
    return createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ['/moderation/reports/private'] }),
    });
  });
  return (
    <QueryClientProvider client={cache}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
export const ReadUnavailable: Story = { render: () => <ReadStatePage /> };
export const SessionRetired: Story = { render: () => <ReadStatePage retired /> };
