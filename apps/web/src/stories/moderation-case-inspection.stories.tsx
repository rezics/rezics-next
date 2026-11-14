import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { WorkbenchCaseDetail } from '../moderation/workbench-case';
import type { ReportQueueAction } from '../moderation/reports-view-action';
import type { Report, ResolvedReportTarget } from '../moderation/reports-read';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { queueViewports } from './patterns/board-report-queue/fixture';

const report: Report = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000202' },
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000203',
  reason: 'spam',
  evidence: Array.from(
    { length: 7 },
    (_, index) =>
      `Evidence paragraph ${index + 1}: this is the complete reporter statement attached to the selected case.`,
  ).join('\n\n'),
  createdAt: '2026-10-01T09:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};

const current: ResolvedReportTarget = {
  key: `post:${report.target.id}`,
  kind: 'post',
  value: {
    post: {
      id: report.target.id,
      availability: 'available',
      body: 'The current post after the reported revision changed.',
    },
  },
};

const revision = {
  post: {
    id: report.target.id,
    revisionId: report.revisionId,
    availability: 'available',
    body: 'The exact revision selected when the report was created.',
  },
};

const currentDestination = {
  boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000204',
  threadId: '0192f3a0-6c1e-7b2a-9d4e-000000000205',
  realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000206',
};

const meta = {
  title: 'Moderation/Moderation case inspection',
  id: 'pages-moderation-case-inspection',
  component: WorkbenchCaseDetail,
  parameters: { layout: 'fullscreen', viewport: { options: queueViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={`/moderation/cases/${report.id}?boardId=board-opened&cursor=old`}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    report,
    boardId: 'board-opened',
    target: current,
    revision,
    currentState: 'available',
    destination: currentDestination,
    actionAdvice: { dismiss: true, takeDown: false },
    queueHref: '/moderation/workbench?queue=reports&board=board-opened&cursor=old',
    isCurrent: () => true,
    register: () => () => {},
    onAction: fn<ReportQueueAction>(async () => ({ ok: true })),
  },
} satisfies Meta<typeof WorkbenchCaseDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReportedAndCurrent: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_admission_current())).toBeVisible();
    await expect(canvas.getByRole('heading', { name: m.moderation_reported_revision_label() })).toBeVisible();
    await expect(canvas.getByText('The exact revision selected when the report was created.')).toBeVisible();
    await expect(canvas.getByText('The current post after the reported revision changed.')).toBeVisible();
    await expect(canvas.getByText(/Evidence paragraph 7/)).toBeVisible();
    await expect(canvas.getByRole('navigation', { name: m.moderation_current_destination() })).toBeVisible();
    const first = canvas.getByRole('link', { name: m.moderation_current_board({ id: currentDestination.boardId }) });
    first.focus();
    await expect(first).toHaveFocus();
    await userEvent.tab();
    await expect(
      canvas.getByRole('link', { name: m.moderation_current_thread({ id: currentDestination.threadId }) }),
    ).toHaveFocus();
    await expect(canvas.getByRole('link', { name: m.moderation_workbench_history_return() })).toHaveAttribute(
      'href',
      '/moderation/workbench?queue=reports&board=board-opened&cursor=old',
    );
    await userEvent.click(canvas.getByRole('button', { name: m.moderation_queue_review() }));
    const review = within(canvas.getByRole('form', { name: m.moderation_queue_review() }));
    await expect(review.getByText(report.target.id, { exact: true })).toBeVisible();
    await expect(review.getByText(`${m.moderation_queue_details_report_id()}: ${report.id}`)).toBeVisible();
    await expect(review.getByRole('button', { name: m.moderation_take_down() })).toBeDisabled();
    await expect(review.getByRole('button', { name: m.moderation_dismiss() })).toBeEnabled();
    await expect(args.onAction).not.toHaveBeenCalled();
  },
};

export const CurrentTargetWithheld: Story = {
  args: {
    target: { ...current, value: null },
    currentState: 'withheld',
    destination: null,
    actionAdvice: { dismiss: false, takeDown: false },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.moderation_target_withheld());
    await expect(canvas.queryByText('PRIVATE CURRENT BODY')).not.toBeInTheDocument();
    await expect(canvas.getByText('The exact revision selected when the report was created.')).toBeVisible();
    await expect(
      canvas.queryByRole('navigation', { name: m.moderation_current_destination() }),
    ).not.toBeInTheDocument();
  },
};

export const ResolvedCase: Story = {
  args: {
    report: { ...report, outcome: 'dismissed', resolvedAt: '2026-10-02T11:15:00.000Z' },
    target: { ...current, value: null },
    currentState: 'withheld',
    destination: null,
    actionAdvice: { dismiss: false, takeDown: false },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.moderation_dismissed(), { exact: true })).toBeVisible();
    await expect(canvas.getByText('The exact revision selected when the report was created.')).toBeVisible();
    await expect(canvas.getByText(/Evidence paragraph 7/)).toBeVisible();
    await expect(canvas.getByText(m.moderation_target_withheld())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.moderation_queue_review() })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByText(m.moderation_queue_details_reference(), { exact: true }));
    await expect(canvas.getByText(report.id, { exact: true })).toBeVisible();
    await expect(args.onAction).not.toHaveBeenCalled();
  },
};
