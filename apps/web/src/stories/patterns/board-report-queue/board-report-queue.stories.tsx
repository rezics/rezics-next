import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import type { ReportActionInput } from '../../../moderation/actions';
import { m } from '../../../paraglide/messages.js';
import { BoardReportQueue } from './board-report-queue';
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
  title: 'Patterns/Moderation Queue',
  component: BoardReportQueue,
  parameters: {
    layout: 'padded',
    viewport: { options: queueViewports },
  },
  args: {
    ...moderationQueueFixture,
    reports: [postReport],
    onAction: fn(async (_input: ReportActionInput): Promise<void> => {
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
  args: { onAction: fn((_input: ReportActionInput) => new Promise<void>(() => {})) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeDisabled();
    await expect(view.getByRole('button', { name: m.moderation_dismiss() })).toBeDisabled();
    await expect(view.getByRole('textbox')).toHaveValue(reason);
    await expect(args.onAction).toHaveBeenCalledTimes(1);
  },
};

export const UncertainRetry: Story = {
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_action_failed());
    const takeDown = view.getByRole('button', { name: m.moderation_take_down() });
    await userEvent.click(takeDown);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(2));
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
    await expect(calls[0]![0]).toMatchObject({ action: 'take-down', reason });
    await userEvent.type(view.getByRole('textbox'), ' Additional context.');
    await userEvent.click(takeDown);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(3));
    await expect(calls[2]![0].idempotencyKey).not.toBe(calls[0]![0].idempotencyKey);
    const dismiss = view.getByRole('button', { name: m.moderation_dismiss() });
    await userEvent.click(dismiss);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(4));
    await userEvent.click(dismiss);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(5));
    await expect(calls[4]![0]).toEqual(calls[3]![0]);
    await expect(calls[3]![0]).toMatchObject({ action: 'dismiss', reportId: postReport.id });
    await expect(calls[3]![0].idempotencyKey).not.toBe(calls[2]![0].idempotencyKey);
  },
};

async function refused(canvasElement: HTMLElement) {
  const view = await submit(canvasElement);
  await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_action_failed());
  await expect(view.getByRole('textbox')).toHaveValue(reason);
  await expect(view.getByRole('button', { name: m.moderation_take_down() })).toBeEnabled();
  await expect(view.queryByRole('status')).toBeNull();
}

export const StaleConflict: Story = {
  args: {
    onAction: fn(async (_input: ReportActionInput) => {
      throw Object.assign(new Error('Already resolved'), { status: 409 });
    }),
  },
  play: async ({ canvasElement }) => refused(canvasElement),
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

export const TargetUnavailable: Story = {
  args: {
    targets: [{ key: `post:${postReport.target.id}`, kind: 'post', value: null }],
    revisions: [{ reportId: postReport.id, value: null }],
    onAction: fn(async (_input: ReportActionInput) => {
      throw Object.assign(new Error('Service unavailable'), { status: 503 });
    }),
  },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByText(m.moderation_target_unavailable())).toHaveLength(2);
    await expect(view.queryByText(currentText)).toBeNull();
    await expect(view.queryByText(revisionText)).toBeNull();
  },
};

export const NativeDenied: Story = {
  args: {
    onAction: fn(async (_input: ReportActionInput) => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }),
  },
  play: async ({ canvasElement }) => refused(canvasElement),
};

export const ReasonValidation: Story = {
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
  args: { onAction: fn(async (_input: ReportActionInput): Promise<void> => {}) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('status')).toHaveTextContent(m.moderation_queue_takedown_confirmed());
    await expect(view.getByRole('status')).toHaveTextContent(reason);
    await expect(view.queryByText(currentText)).toBeNull();
    await expect(view.queryByText(revisionText)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(mocked(args.onAction).mock.calls[0]![0]).toMatchObject({ action: 'take-down', reason });
    await expect(view.getByText(postReport.evidence!, { exact: false })).toBeVisible();
  },
};
export const ConfirmedDismissal: Story = {
  args: { onAction: fn(async (_input: ReportActionInput): Promise<void> => {}) },
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
    onAction: fn<(input: ReportActionInput) => Promise<void>>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(undefined),
  },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await view.findByRole('alert');
    await expect(view.getByRole('textbox')).toHaveValue(reason);
    await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
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
