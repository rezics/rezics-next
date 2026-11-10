import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import { useState } from 'react';
import { createKernelClient } from '@rezics/client';
import { sendModerationReportAction } from '../../../moderation/actions';
import { m } from '../../../paraglide/messages.js';
import { BoardReportQueue, type ReportQueueAction, type ReportQueueProps } from './board-report-queue';
import {
  moderationQueueFixture,
  resolvedQueueFixture,
  postReport,
  currentText,
  revisionText,
  reason,
  queueViewports,
} from './fixture';

const meta = {
  title: 'Moderation/Moderation Queue',
  id: 'patterns-moderation-queue',
  component: BoardReportQueue,
  parameters: {
    layout: 'padded',
    viewport: { options: queueViewports },
  },
  args: {
    ...moderationQueueFixture,
    reports: [postReport],
    onAction: fn<ReportQueueAction>(async (_input) => {
      throw new TypeError('Failed to fetch');
    }),
  },
} satisfies Meta<typeof BoardReportQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

async function submit(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.click(view.getByRole('button', { name: m.moderation_queue_review() }));
  await userEvent.type(view.getByRole('textbox', { name: m.moderation_reason_label() }), reason);
  await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
  return view;
}

export const Open: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(currentText)).toBeVisible();
    await expect(view.getByText(revisionText)).toBeVisible();
    await expect(view.getByText(postReport.evidence!, { exact: false })).toBeVisible();
    const article = view.getByRole('article', {
      name: new RegExp(`${m.moderation_reports_tab()}.*${m.moderation_queue_post()}`),
    });
    await expect(article.querySelector('h2')).toHaveTextContent(m.moderation_queue_post());
    await expect(article).toHaveTextContent(postReport.target.id);
    await expect(article.querySelector('a')).toBeNull();
    await expect(view.getByRole('heading', { level: 3, name: m.moderation_reported_revision_label() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 3, name: m.moderation_current_target_label() })).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_review() }));
    await expect(view.getAllByRole('textbox')).toHaveLength(1);
    await userEvent.type(view.getByRole('textbox', { name: m.moderation_reason_label() }), reason);
    await expect(view.getByRole('button', { name: m.moderation_dismiss() })).toBeEnabled();
  },
};

export const Empty: Story = {
  args: { reports: [], targets: [], revisions: [] },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_reports_empty())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};

export const PendingSubmission: Story = {
  args: { onAction: fn<ReportQueueAction>((_input) => new Promise<void>(() => {})) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.moderation_dismiss() })).toBeDisabled();
    await expect(view.getByRole('textbox')).toHaveValue(reason);
    await expect(args.onAction).toHaveBeenCalledTimes(1);
  },
};

export const UncertainRetry: Story = {
  args: {
    onAction: fn<ReportQueueAction>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ok: false, state: 'conflict' })
      .mockResolvedValueOnce({ ok: false, state: 'conflict' })
      .mockRejectedValue(new TypeError('Failed to fetch')),
    onRefresh: fn(async () => {}),
  },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_uncertain());
    const takeDown = view.getByRole('button', { name: m.moderation_take_down() });
    await expect(takeDown).toBeDisabled();
    await expect(view.getByRole('textbox')).toBeDisabled();
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry_action() }));
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(2));
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
    await expect(calls[0]![0]).toMatchObject({ action: 'take-down', reason });
    await expect(view.getByRole('alert')).toHaveTextContent(m.moderation_queue_conflict());
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_refresh() }));
    await userEvent.type(view.getByRole('textbox'), ' Additional context.');
    await userEvent.click(takeDown);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(3));
    await expect(calls[2]![0].idempotencyKey).not.toBe(calls[0]![0].idempotencyKey);
    await expect(view.getByRole('alert')).toHaveTextContent(m.moderation_queue_conflict());
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_refresh() }));
    const dismiss = view.getByRole('button', { name: m.moderation_dismiss() });
    await userEvent.click(dismiss);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(4));
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry_action() }));
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(5));
    await expect(calls[4]![0]).toEqual(calls[3]![0]);
    await expect(calls[3]![0]).toMatchObject({ action: 'dismiss', reportId: postReport.id });
    await expect(calls[3]![0].idempotencyKey).not.toBe(calls[2]![0].idempotencyKey);
  },
};

const refreshedText = 'Current content read again after the moderation refusal.';

function RefreshedQueue(args: ReportQueueProps) {
  const [refreshed, setRefreshed] = useState(false);
  return (
    <BoardReportQueue
      {...args}
      targets={
        refreshed
          ? [{ key: `post:${postReport.target.id}`, kind: 'post', value: { post: { body: refreshedText } } }]
          : args.targets
      }
      onRefresh={async () => {
        await args.onRefresh?.();
        setRefreshed(true);
      }}
    />
  );
}

function nativeRefusal(status: number, code: string) {
  const client = createKernelClient('https://kernel.invalid', {
    fetch: Object.assign(
      async () => Response.json({ code, status, detail: 'Private native denial detail' }, { status }),
      { preconnect() {} },
    ),
  });
  return fn<ReportQueueAction>((input) => sendModerationReportAction(client, input, 'Bearer story'));
}

async function refused(canvasElement: HTMLElement, args: ReportQueueProps, message: string) {
  const view = await submit(canvasElement);
  await expect(await view.findByRole('alert')).toHaveTextContent(message);
  await expect(view.getByRole('alert')).not.toHaveTextContent(m.moderation_queue_retry_hint());
  await expect(view.getByRole('textbox')).toHaveValue(reason);
  await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeDisabled();
  await expect(view.getByRole('button', { name: m.moderation_dismiss() })).toBeDisabled();
  await expect(view.queryByRole('button', { name: m.moderation_queue_retry_action() })).toBeNull();
  await expect(view.queryByText('Private native denial detail')).toBeNull();
  await expect(view.queryByRole('status')).toBeNull();
  await userEvent.click(view.getByRole('button', { name: m.moderation_queue_refresh() }));
  await expect(args.onRefresh).toHaveBeenCalledTimes(1);
  await expect(args.onAction).toHaveBeenCalledTimes(1);
  await expect(await view.findByText(refreshedText)).toBeVisible();
  await expect(view.getByRole('textbox')).toHaveValue(reason);
  await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeEnabled();
  await expect(view.queryByRole('alert')).toBeNull();
  return view;
}

export const StaleConflict: Story = {
  args: {
    onAction: nativeRefusal(422, 'idempotency_conflict'),
    onRefresh: fn(async () => {}),
  },
  render: (args) => <RefreshedQueue {...args} />,
  play: async ({ canvasElement, args }) => {
    const view = await refused(canvasElement, args, m.moderation_queue_conflict());
    await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_conflict());
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0].idempotencyKey).not.toBe(calls[0]![0].idempotencyKey);
    await expect(calls[1]![0]).toMatchObject({ action: 'take-down', reason });
  },
};

export const Resolved: Story = {
  args: resolvedQueueFixture,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_actioned())).toBeVisible();
    await expect(view.getByText(m.moderation_dismissed())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('button')).toBeNull();
  },
};

export const TargetUnavailable = {
  args: {
    targets: [{ key: `post:${postReport.target.id}`, kind: 'post', value: null }],
    revisions: [{ reportId: postReport.id, value: null }],
    onAction: fn<ReportQueueAction>(async (_input) => {
      throw Object.assign(new globalThis.Error('Service unavailable'), { status: 503 });
    }),
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByText(m.moderation_target_unavailable())).toHaveLength(2);
    await expect(view.queryByText(currentText)).toBeNull();
    await expect(view.queryByText(revisionText)).toBeNull();
  },
} satisfies Story;

export const NativeDenied = {
  args: {
    onAction: nativeRefusal(403, 'forbidden'),
    onRefresh: fn(async () => {}),
  },
  render: (args) => <RefreshedQueue {...args} />,
  play: async ({ canvasElement, args }) => {
    const view = await refused(canvasElement, args, m.moderation_queue_denied());
    await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_denied());
    await expect(args.onAction).toHaveBeenCalledTimes(2);
  },
} satisfies Story;

export const ReasonValidation: Story = {
  args: { onAction: nativeRefusal(422, 'idempotency_conflict'), onRefresh: fn(async () => {}) },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_review() }));
    const input = view.getByRole('textbox', { name: m.moderation_reason_label() });
    const takeDown = view.getByRole('button', { name: m.moderation_take_down() });
    await userEvent.click(takeDown);
    await expect(input).toBeInvalid();
    await expect(args.onAction).not.toHaveBeenCalled();
    await userEvent.type(input, '   ');
    await userEvent.click(takeDown);
    await view.findByRole('alert');
    await expect(input).toHaveValue('   ');
    await expect(args.onAction).not.toHaveBeenCalled();
    await userEvent.clear(input);
    await userEvent.type(input, 'R'.repeat(1025), { delay: null });
    await expect(input).toHaveValue('R'.repeat(1024));
    await userEvent.click(takeDown);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(1));
    await expect(mocked(args.onAction).mock.calls[0]![0]).toMatchObject({ reason: 'R'.repeat(1024) });
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_queue_conflict());
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_refresh() }));
    await userEvent.clear(input);
    await userEvent.type(input, `  ${reason}  `);
    await userEvent.click(takeDown);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(2));
    await expect(mocked(args.onAction).mock.calls[1]![0]).toMatchObject({ reason });
  },
};

export const RevisionDiffers: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(currentText)).toBeVisible();
    await expect(view.getByText(revisionText)).toBeVisible();
  },
};
export const ConfirmedTakedown: Story = {
  args: { onAction: fn<ReportQueueAction>(async (_input) => ({ ok: true })) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_queue_takedown_confirmed());
    await expect(view.getByRole('status')).toHaveTextContent(reason);
    await expect(view.getByRole('status')).toHaveFocus();
    await expect(view.queryByText(currentText)).toBeNull();
    await expect(view.queryByText(revisionText)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(mocked(args.onAction).mock.calls[0]![0]).toMatchObject({ action: 'take-down', reason });
    await expect(view.getByText(postReport.evidence!, { exact: false })).toBeVisible();
  },
};
export const ConfirmedDismissal: Story = {
  args: { onAction: fn<ReportQueueAction>(async (_input) => ({ ok: true })) },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_review() }));
    await userEvent.click(view.getByRole('button', { name: m.moderation_dismiss() }));
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_dismissed());
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(args.onAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'dismiss', reportId: postReport.id }),
    );
  },
};
export const RetryConfirmed: Story = {
  args: {
    onAction: fn<ReportQueueAction>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue({ ok: true }),
  },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await view.findByRole('alert');
    await expect(view.getByRole('textbox')).toHaveValue(reason);
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry_action() }));
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_queue_takedown_confirmed());
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
  },
};
export const EmptyWithNext: Story = {
  args: { reports: [], targets: [], revisions: [], next: 'sealed+continuation==', onNext: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_reports_empty())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.threads_next_page() }));
    await expect(args.onNext).toHaveBeenCalledWith('sealed+continuation==');
  },
};
export const Loading: Story = { args: { state: 'loading' } };
export const Error: Story = {
  args: { state: 'error', onRetry: fn() },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('alert')).toHaveTextContent(m.moderation_queue_error());
    await expect(view.queryByText(postReport.evidence!)).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.moderation_queue_retry() }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

export const ReadDenied: Story = { args: { reports: [], targets: [], revisions: [], state: 'denied', next: null } };
export const StaleSelection: Story = {
  args: { reports: [], targets: [], revisions: [], state: 'stale', next: null, onRestart: fn() },
};

const bulkReports = [...moderationQueueFixture.reports, { ...postReport, id: '0192f3a0-6c1e-7b2a-9d4e-000000000003' }];
async function confirmBulk(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_select_loaded() }));
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_review() }));
  await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_confirm({ count: 3 }) }));
  return view;
}
export const BulkSelected: Story = {
  args: { ...moderationQueueFixture, reports: bulkReports },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('checkbox', { name: m.moderation_bulk_select_report({ number: 1 }) }));
    await userEvent.click(view.getByRole('button', { name: m.moderation_bulk_review() }));
    await expect(view.getByRole('button', { name: m.moderation_bulk_confirm({ count: 1 }) })).toBeVisible();
    await expect(args.onAction).not.toHaveBeenCalled();
  },
};
export const BulkPartial: Story = {
  args: {
    ...moderationQueueFixture,
    reports: bulkReports,
    onAction: fn<ReportQueueAction>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValue({ ok: false, state: 'forbidden' }),
  },
  play: async ({ canvasElement, args }) => {
    const view = await confirmBulk(canvasElement);
    await expect(await view.findByText(m.moderation_bulk_forbidden(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_dismissed(), { exact: false })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_unattempted(), { exact: false })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledTimes(2);
  },
};
export const BulkUncertain: Story = {
  args: {
    ...moderationQueueFixture,
    reports: bulkReports,
    onAction: fn<ReportQueueAction>()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(new TypeError('Failed to fetch')),
  },
  play: async ({ canvasElement, args }) => {
    const view = await confirmBulk(canvasElement);
    await expect(await view.findByRole('button', { name: m.moderation_bulk_retry() })).toBeVisible();
    await expect(view.getByText(m.moderation_bulk_unattempted(), { exact: false })).toBeVisible();
    await expect(args.onAction).toHaveBeenCalledTimes(2);
  },
};

// Fixture-derived presentation examples; added observations are UNRUN, with native proof deferred.
const referenceExample = {
  ...postReport,
  id: `${postReport.id}-${postReport.id}-${postReport.id}`,
  evidence: Array.from({ length: 8 }, () => postReport.evidence).join('\n\n'),
  createdAt: '2026-10-28T15:30:12.123456Z',
  outcome: 'dismissed' as const,
  resolvedAt: '2026-10-29T08:45:23.120400Z',
};

export const IllustrativeReferenceAndPreciseDates = {
  name: 'Illustrative reference and precise UTC dates (fixture-derived)',
  args: {
    reports: [referenceExample],
    revisions: [{ ...moderationQueueFixture.revisions[0]!, reportId: referenceExample.id }],
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const article = view.getByRole('article', {
      name: new RegExp(`${m.moderation_reports_tab()}.*${m.moderation_queue_post()}`),
    });
    await expect(view.getByText(currentText)).toBeVisible();
    await expect(view.getByText(revisionText)).toBeVisible();
    await expect(article.textContent).toContain(referenceExample.evidence);
    await expect(view.getByText('2026-10-28 15:30:12.123456 UTC')).toBeVisible();
    await expect(view.getByText('2026-10-29 08:45:23.120400 UTC')).toBeVisible();
    await expect(article.querySelector('time')).toHaveAttribute('datetime', referenceExample.createdAt);
    const summary = within(article).getByText(m.moderation_queue_details_reference(), { exact: true });
    const details = summary.closest('details')!;
    await expect(details).not.toHaveAttribute('open');
    summary.focus();
    await expect(summary).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(details).toHaveAttribute('open');
    const references = within(details);
    await expect(references.getByText(m.moderation_queue_details_report_id())).toBeVisible();
    await expect(references.getByText(referenceExample.id, { exact: true })).toBeVisible();
    await expect([...details.querySelectorAll('dd')].map((value) => value.textContent)).toEqual([referenceExample.id]);
    await expect(details.textContent).not.toContain(postReport.target.id);
    await expect(details.textContent).not.toContain(postReport.revisionId!);
    await expect(summary.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth);
    await expect(args.onAction).not.toHaveBeenCalled();
  },
} satisfies Story;

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
