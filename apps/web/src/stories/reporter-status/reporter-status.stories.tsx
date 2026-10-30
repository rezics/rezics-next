import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import { ReporterStatusFailure, ReporterStatusView } from '../../moderation/reporter-status-view';
import { reporterStatusViewports, submittedReport } from './fixture';
import { m } from '../../paraglide/messages.js';

const evidence = submittedReport.evidence;
const revisionId = submittedReport.revisionId;
if (!evidence || !revisionId) throw new Error('The report story requires submitted evidence and a revision reference');

const meta = {
  title: 'Patterns/Reporter status',
  component: ReporterStatusView,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The reporter’s receipt, submitted reason and evidence, native timeline and current disposition. Reference details expand for copying; availability never grants a target read or link. The served page reuses this presenter. Review the same IDs at phone390 and desktop1280 using globals; native acceptance and visual review remain pending.',
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
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
export const Actioned: Story = {
  args: { report: { ...submittedReport, outcome: 'actioned', resolvedAt: '2026-10-31T09:00:00.000Z' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_actioned(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_actioned_explanation())).toBeVisible();
    await expect(canvas.getByText(m.reporter_status_reviewed())).toBeVisible();
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
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.click(canvas.getByText(m.reporter_status_reference(), { exact: true }));
    await expect(canvas.getByText(`post ${submittedReport.target.id}`)).toBeVisible();
    await expect(canvas.getByText(revisionId)).toBeVisible();
  },
};
export const SubmittedDetails: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByText(submittedReport.id)).toBeVisible();
    await expect(canvas.getByText(revisionId)).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.reporter_status_copy() }));
    await waitFor(() =>
      expect([m.reporter_status_copied(), m.reporter_status_copy_failed()]).toContain(
        canvas.getByRole('status').textContent?.trim(),
      ),
    );
    await expect(canvas.getByText(evidence)).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
const retry = fn(async () => {
  throw new Error('Report status unavailable');
});
export const NativeError: Story = {
  render: () => <ReporterStatusFailure onRetry={retry} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.reporter_status_unavailable());
    await expect(canvas.getByRole('button', { name: m.sources_retry() })).toBeEnabled();
    await expect(canvas.queryByText(m.reporter_status_pending())).toBeNull();
    await expect(canvas.queryByText(evidence)).toBeNull();
  },
};
export const Retry: Story = {
  render: () => <ReporterStatusFailure onRetry={retry} />,
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: m.sources_retry() });
    await userEvent.tab();
    await expect(button).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(retry).toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent(m.reporter_status_unavailable());
  },
};
