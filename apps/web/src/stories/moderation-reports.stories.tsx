import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { ModerationAppealsView } from '../moderation/appeals-tab';
import { ModerationReportsView } from '../moderation/reports-page';
import type { ReportQueueAction } from '../moderation/reports-view-action';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import * as Queue from './patterns/board-report-queue/board-report-queue.stories';
import { m } from '../paraglide/messages.js';
import {
  moderationQueueFixture,
  resolvedQueueFixture,
  selectedQueueFixture,
  postReport,
  queueViewports,
} from './patterns/board-report-queue/fixture';

const meta = {
  title: 'Community/Moderation reports',
  id: 'pages-community-moderation-reports',
  component: ModerationReportsView,
  parameters: {
    layout: 'fullscreen',
    viewport: { options: queueViewports },
  },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path="/boards/community/moderation">
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    boardId: 'community',
    ...moderationQueueFixture,
    next: 'cursor-next',
    onNext: fn(),
    onSelection: fn(),
    onRestart: fn(),
    onAction: fn<ReportQueueAction>(async (_input) => {
      throw new TypeError('Failed to fetch');
    }),
  },
} satisfies Meta<typeof ModerationReportsView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OpenReports: Story = {
  name: 'Open reports',
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(await view.findByRole('navigation', { name: m.moderation_tabs_label() })).toBeVisible();
    const article = view.getByRole('article', {
      name: new RegExp(`${m.moderation_reports_tab()}.*${m.moderation_queue_post()}`),
    });
    await expect(article.querySelector('h2')).toHaveTextContent(m.moderation_queue_post());
    await expect(article).toHaveTextContent(postReport.target.id);
    await expect(article.querySelector('a')).toBeNull();
    await userEvent.click(view.getAllByRole('button', { name: m.moderation_queue_review() })[0]!);
    await expect(view.getAllByRole('textbox', { name: m.moderation_reason_label() })).toHaveLength(1);
    await userEvent.type(view.getAllByRole('textbox')[0]!, 'Private address disclosure.');
    await userEvent.click(view.getAllByRole('button', { name: m.moderation_take_down() })[0]!);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_uncertain());
    await expect(view.getAllByRole('textbox')[0]!).toHaveValue('Private address disclosure.');
    await userEvent.click(view.getByRole('button', { name: m.threads_next_page() }));
    await expect(args.onNext).toHaveBeenCalledWith('cursor-next');
  },
};

export const ResolvedReports: Story = {
  name: 'Resolved reports',
  args: { ...resolvedQueueFixture, next: null },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.moderation_actioned())).toBeVisible();
    await expect(view.getByText(m.moderation_dismissed())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('button', { name: m.moderation_queue_review() })).toBeNull();
  },
};

const appeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000101',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  appellantId: 'private-author',
  statement: 'The post shares the event details participants need. Please restore it.',
  createdAt: '2026-10-29T14:20:00.000Z',
  decision: {
    statement: 'The post includes a private phone number.',
    target: { kind: 'post' as const, id: moderationQueueFixture.reports[0]!.target.id },
  },
  canResolve: true,
};

export const Appeals: Story = {
  render: () => (
    <ModerationAppealsView
      appeals={[
        appeal,
        {
          ...appeal,
          id: '0192f3a0-6c1e-7b2a-9d4e-000000000102',
          decision: {
            ...appeal.decision,
            appeal: {
              outcome: 'reversed' as const,
              statement: 'The submitted context changes the original decision.',
              resolvedAt: '2026-10-30T09:15:00.000Z',
            },
          },
        },
      ]}
      targets={moderationQueueFixture.targets}
      next={null}
    />
  ),
};

export const TargetUnavailable: Story = {
  args: { ...Queue.TargetUnavailable.args, reports: [postReport], next: null },
};
export const RevisionDiffers: Story = { args: { reports: [postReport], next: null } };
export const NativeDenied: Story = {
  args: { ...Queue.NativeDenied.args, reports: [postReport], next: null },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.moderation_queue_review() }));
    await userEvent.type(
      view.getByRole('textbox', { name: m.moderation_reason_label() }),
      'Private address disclosure.',
    );
    await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_denied());
    await expect(view.getByRole('textbox')).toHaveValue('Private address disclosure.');
    await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeDisabled();
    await expect(view.getByRole('link', { name: m.moderation_queue_back() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.moderation_queue_retry_action() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_refresh() }));
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await expect(args.onAction).toHaveBeenCalledTimes(1);
    await expect(view.getByRole('textbox')).toHaveValue('Private address disclosure.');
  },
};
export const UncertainRetry: Story = {
  args: { reports: [postReport], next: null },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.moderation_queue_review() }));
    await userEvent.type(
      view.getByRole('textbox', { name: m.moderation_reason_label() }),
      'Private address disclosure.',
    );
    const submit = view.getByRole('button', { name: m.moderation_take_down() });
    await userEvent.click(submit);
    await view.findByRole('alert');
    await expect(submit).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry_action() }));
    await expect(args.onAction).toHaveBeenCalledTimes(2);
  },
};
export const EmptyWithNext: Story = { args: { reports: [], targets: [], revisions: [] } };
export const Loading: Story = { args: { state: 'loading', next: null } };
export const Error: Story = { args: { state: 'error', next: null, onRetry: fn() } };

export const SelectedReports: Story = {
  args: { ...selectedQueueFixture },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('combobox', { name: m.moderation_filter_status() })).toHaveValue('pending');
    await expect(view.getByRole('combobox', { name: m.moderation_filter_kind() })).toHaveValue('post');
    await expect(view.getByRole('combobox', { name: m.moderation_filter_order() })).toHaveValue('oldest');
    await userEvent.selectOptions(view.getByRole('combobox', { name: m.moderation_filter_status() }), 'resolved');
    await expect(args.onSelection).toHaveBeenCalledWith({ status: 'resolved', targetKind: 'post', order: 'oldest' });
  },
};
export const SelectedPending: Story = {
  args: { ...selectedQueueFixture, reports: [], targets: [], revisions: [], state: 'loading', next: null },
};
export const ReadDenied: Story = { args: { reports: [], targets: [], revisions: [], state: 'denied', next: null } };
export const StaleSelection: Story = { args: { reports: [], targets: [], revisions: [], state: 'stale', next: null } };

// Added illustrative observations are UNRUN; the queue example supplies the same fixture-derived record.
export const IllustrativeReferenceAndPreciseDates: Story = {
  name: 'Illustrative reference and precise UTC dates (fixture-derived)',
  args: { ...Queue.IllustrativeReferenceAndPreciseDates.args, next: null },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const report = args.reports[0]!;
    await expect(view.getByRole('heading', { level: 1, name: m.moderation_reports_heading() })).toBeVisible();
    await expect(view.getByRole('link', { name: m.moderation_queue_back() })).toBeVisible();
    const article = view.getByRole('article', {
      name: new RegExp(`${m.moderation_reports_tab()}.*${m.moderation_queue_post()}`),
    });
    await expect(article.textContent).toContain(report.evidence!);
    const summary = within(article).getByText(m.moderation_queue_details_reference(), { exact: true });
    summary.focus();
    await expect(summary).toHaveFocus();
    await userEvent.keyboard(' ');
    const details = summary.closest('details')!;
    await expect(details).toHaveAttribute('open');
    await expect(within(details).getByText(m.moderation_queue_details_report_id())).toBeVisible();
    await expect(within(details).getByText(report.id, { exact: true })).toBeVisible();
    await expect(details.textContent).not.toContain(report.target.id);
    await expect(details.textContent).not.toContain(report.revisionId!);
    const dates = [...article.querySelectorAll('time')];
    await expect(dates.map((time) => time.getAttribute('datetime'))).toEqual([report.createdAt, report.resolvedAt]);
    await expect(dates.map((time) => time.textContent)).toEqual([
      '2026-10-28 15:30:12.123456 UTC',
      '2026-10-29 08:45:23.120400 UTC',
    ]);
    await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
    await expect(args.onAction).not.toHaveBeenCalled();
    await expect(args.onNext).not.toHaveBeenCalled();
  },
};

export const IllustrativeReferenceAndPreciseDatesRtl: Story = {
  ...IllustrativeReferenceAndPreciseDates,
  name: 'Illustrative reference and precise UTC dates · RTL',
  decorators: [
    (Story) => (
      <div dir="rtl">
        <Story />
      </div>
    ),
  ],
};
