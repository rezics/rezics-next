import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { WorkbenchCaseDetail } from '../moderation/workbench-case';
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
    (_, index) => `Evidence paragraph ${index + 1}: this is the complete reporter statement attached to the selected case.`,
  ).join('\n\n'),
  createdAt: '2026-10-01T09:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};

const current: ResolvedReportTarget = {
  key: `post:${report.target.id}`,
  kind: 'post',
  value: { post: { id: report.target.id, availability: 'available', body: 'The current post after the reported revision changed.' } },
};

const revision = {
  post: { id: report.target.id, revisionId: report.revisionId, availability: 'available', body: 'The exact revision selected when the report was created.' },
};

const currentDestination = {
  boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000204',
  threadId: '0192f3a0-6c1e-7b2a-9d4e-000000000205',
  realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000206',
};

const meta = {
  title: 'Pages/Moderation case inspection',
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
    target: current,
    revision,
    currentState: 'available',
    destination: currentDestination,
    actionAdvice: { dismiss: true, takeDown: false },
    queueHref: '/moderation/workbench?queue=reports&board=board-opened&cursor=old',
    isCurrent: () => true,
    register: () => () => {},
    onAction: async () => ({ ok: true }),
  },
} satisfies Meta<typeof WorkbenchCaseDetail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReportedAndCurrent: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: m.moderation_reported_revision_label() })).toBeVisible();
    await expect(canvas.getByText('The exact revision selected when the report was created.')).toBeVisible();
    await expect(canvas.getByText('The current post after the reported revision changed.')).toBeVisible();
    await expect(canvas.getByText(/Evidence paragraph 7/)).toBeVisible();
    await expect(canvas.getByRole('navigation', { name: m.moderation_current_destination() })).toBeVisible();
    const first = canvas.getByRole('link', { name: m.moderation_current_board({ id: currentDestination.boardId }) });
    first.focus();
    await expect(first).toHaveFocus();
    await userEvent.tab();
    await expect(canvas.getByRole('link', { name: m.moderation_current_thread({ id: currentDestination.threadId }) })).toHaveFocus();
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
    await expect(canvas.queryByRole('navigation', { name: m.moderation_current_destination() })).not.toBeInTheDocument();
  },
};
