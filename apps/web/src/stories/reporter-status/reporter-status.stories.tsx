import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ReporterStatusFailure, ReporterStatusView } from '../../moderation/reporter-status-view';
import { reporterStatusViewports, submittedReport } from './fixture';
import { m } from '../../paraglide/messages.js';

const meta = {
  title: 'Patterns/Reporter status',
  component: ReporterStatusView,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'Private original submission and current report disposition. Target availability never grants a read. The same presenter is used by the report page; native acceptance and visual review are pending.',
      },
    },
    viewport: { options: reporterStatusViewports },
  },
  args: { report: submittedReport },
  render: (args) => (
    <div className="mx-auto max-w-3xl">
      <ReporterStatusView {...args} />
    </div>
  ),
} satisfies Meta<typeof ReporterStatusView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.reporter_status_pending())).toBeVisible();
    await expect(canvas.getByText(submittedReport.evidence!)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
export const Actioned: Story = {
  args: { report: { ...submittedReport, outcome: 'actioned', resolvedAt: '2026-10-31T09:00:00.000Z' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.moderation_actioned())).toBeVisible();
  },
};
export const Dismissed: Story = {
  args: { report: { ...submittedReport, outcome: 'dismissed', resolvedAt: '2026-10-31T09:00:00.000Z' } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(m.moderation_dismissed())).toBeVisible();
  },
};
export const TargetUnavailable: Story = {
  args: {
    report: {
      ...submittedReport,
      targetAvailability: 'unavailable',
      outcome: 'actioned',
      resolvedAt: '2026-10-31T09:00:00.000Z',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(canvas.getByText(`post ${submittedReport.target.id}`)).toBeVisible();
    await expect(canvas.getByText(submittedReport.evidence!)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
const retry = fn();
export const Retry: Story = {
  render: () => <ReporterStatusFailure onRetry={retry} />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: m.sources_retry() });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(retry).toHaveBeenCalled();
  },
};
