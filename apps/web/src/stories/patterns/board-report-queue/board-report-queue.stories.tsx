import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, waitFor, within } from 'storybook/test';
import { BoardReportQueue } from './board-report-queue';
import type { ReportActionInput } from '../../../moderation/actions';
import { m } from '../../../paraglide/messages.js';

const report = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000001',
  target: { kind: 'post' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000051',
  reason: 'other',
  evidence: 'The original post disclosed a private address.',
  createdAt: '2026-10-28T15:30:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const targets = [
  {
    key: `post:${report.target.id}`,
    kind: 'post' as const,
    value: { post: { body: 'Edited current text with the address removed.' } },
  },
];
const revisions = [{ reportId: report.id, value: { post: { body: 'Original reported text.' } } }];
const meta = {
  title: 'Patterns/Community/Board report queue',
  component: BoardReportQueue,
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
    reports: [report],
    targets,
    revisions,
    onAction: fn(async (_input: ReportActionInput): Promise<void> => {
      throw new Error('Service unavailable');
    }),
  },
} satisfies Meta<typeof BoardReportQueue>;
export default meta;
type Story = StoryObj<typeof meta>;

export const EditedTarget: Story = {
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_current_target_label())).toBeVisible();
    await expect(view.getByText('Original reported text.')).toBeVisible();
    await expect(view.getByText('Edited current text with the address removed.')).toBeVisible();
    await userEvent.type(
      view.getByRole('textbox', { name: m.moderation_reason_label() }),
      'Private address disclosure.',
    );
  },
};
export const UnavailableRevision: Story = {
  args: { revisions: [{ reportId: report.id, value: null }] },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(view.queryByText('Original reported text.')).toBeNull();
  },
};
export const AuthorityLost: Story = {
  args: { reports: [], targets: [], revisions: [] },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.moderation_reports_empty())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByText(report.evidence)).toBeNull();
  },
};
export const RetryAction: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    const reason = view.getByRole('textbox', { name: m.moderation_reason_label() });
    await userEvent.type(reason, 'Private address disclosure.');
    const submit = view.getByRole('button', { name: m.moderation_take_down() });
    await userEvent.click(submit);
    await view.findByRole('alert');
    await userEvent.click(submit);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(2));
    const calls = mocked(args.onAction).mock.calls;
    await expect(calls[0]![0]).toEqual(calls[1]![0]);
    await expect(calls[0]![0]).toMatchObject({ action: 'take-down', reason: 'Private address disclosure.' });
    await userEvent.type(reason, ' More context.');
    await userEvent.click(submit);
    await waitFor(() => expect(args.onAction).toHaveBeenCalledTimes(3));
    await expect(calls[2]![0].idempotencyKey).not.toBe(calls[0]![0].idempotencyKey);
  },
};
export const PendingAction: Story = {
  args: { onAction: fn((_input: ReportActionInput) => new Promise<void>(() => {})) },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(
      view.getByRole('textbox', { name: m.moderation_reason_label() }),
      'Private address disclosure.',
    );
    await userEvent.click(view.getByRole('button', { name: m.moderation_take_down() }));
    await expect(view.getByRole('button', { name: m.moderation_dismiss() })).toBeDisabled();
  },
};
