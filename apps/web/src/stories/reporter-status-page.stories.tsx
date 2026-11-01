import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { useState } from 'react';
import { AppShell } from '../shell/shell';
import { ReporterStatusPage } from '../moderation/reporter-status-view';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { PageStory } from './page';
import { reporterStatusViewports } from './reporter-status/fixture';

const meta = {
  title: 'Pages/Reporter status',
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
    await expect(page.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(page.getByText(m.reporter_status_submitted(), { exact: true })).toBeVisible();
    await expect(page.getByText(m.reporter_status_reviewed(), { exact: true })).toBeVisible();
    await expect(page.queryByText(m.reporter_status_pending(), { exact: true })).toBeNull();
    await expect(page.queryByRole('alert')).toBeNull();
    await expect(page.getByRole('link', { name: m.reporter_status_back() })).toHaveAttribute(
      'href',
      localizeHref('/inbox'),
    );
    await expect(page.getAllByRole('link')).toHaveLength(1);
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
