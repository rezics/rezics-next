import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import type { ReportActionInput } from '../../moderation/actions';
import type { Report, ReportedRevision, ResolvedReportTarget } from '../../moderation/reports-read';
import { m } from '../../paraglide/messages.js';
import { BoardReportQueue } from './board-report-queue/board-report-queue';

const postReport: Report = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000052',
  reason: 'other',
  evidence: 'The original post disclosed a private address.',
  createdAt: '2026-10-28T15:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const threadReport: Report = {
  ...postReport,
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
  target: { kind: 'thread', id: '0192f3a0-6c1e-7b2a-9d4e-000000000051' },
  revisionId: null,
  reason: 'spam',
  evidence: null,
};
const currentText = 'Edited current text with the address removed.';
const revisionText = 'Original reported text.';
const reason = 'Private address disclosure.';

// Contract-shaped presenter inputs, shared with the canonical pages; no reporter identities or moderator notes.
export const moderationQueueFixture = {
  reports: [postReport, threadReport],
  targets: [
    {
      key: `post:${postReport.target.id}`,
      kind: 'post',
      value: {
        post: {
          body: {
            version: 'rezics-document-v1',
            profile: 'blocks',
            doc: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'moderation-report-post' },
                  content: [{ type: 'text', text: currentText }],
                },
              ],
            },
          },
        },
      },
    },
    {
      key: `thread:${threadReport.target.id}`,
      kind: 'thread',
      value: { thread: { title: 'A reported advertising thread' } },
    },
  ] satisfies ResolvedReportTarget[],
  revisions: [{ reportId: postReport.id, value: { post: { body: revisionText } } }] satisfies ReportedRevision[],
};
export const resolvedQueueFixture = {
  ...moderationQueueFixture,
  reports: [
    { ...postReport, outcome: 'actioned', resolvedAt: '2026-10-29T08:30:00.000Z' },
    { ...threadReport, outcome: 'dismissed', resolvedAt: '2026-10-29T08:45:00.000Z' },
  ] satisfies Report[],
};

const meta = {
  title: 'Patterns/Moderation Queue',
  component: BoardReportQueue,
  excludeStories: ['moderationQueueFixture', 'resolvedQueueFixture'],
  parameters: {
    layout: 'padded',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
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

export const AmbiguousRetry: Story = {
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

export const Unavailable: Story = {
  args: {
    targets: [{ key: `post:${postReport.target.id}`, kind: 'post', value: null }],
    revisions: [{ reportId: postReport.id, value: null }],
    onAction: fn(async (_input: ReportActionInput) => {
      throw Object.assign(new Error('Service unavailable'), { status: 503 });
    }),
  },
  play: async ({ canvasElement }) => {
    await refused(canvasElement);
    const view = within(canvasElement);
    await expect(view.getAllByText(m.moderation_target_unavailable())).toHaveLength(2);
    await expect(view.queryByText(currentText)).toBeNull();
    await expect(view.queryByText(revisionText)).toBeNull();
  },
};

export const Forbidden: Story = {
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
