import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import { DecisionPageView, type DecisionAppealAction } from '../../../moderation/decision-page';
import { m } from '../../../paraglide/messages.js';
import {
  appealDraft,
  availableDecision,
  decisionNow,
  expiredDecision,
  openDecision,
  pendingDecision,
  resolvedDecision,
} from './fixtures';

const meta = {
  title: 'Patterns/Moderation/Decision',
  component: DecisionPageView,
  parameters: { layout: 'padded' },
  args: {
    page: openDecision,
    now: decisionNow,
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'pending', decision: pendingDecision.decision })),
    onRefresh: fn(async () => openDecision),
  },
} satisfies Meta<typeof DecisionPageView>;
export default meta;
type Story = StoryObj<typeof meta>;

async function submit(canvasElement: HTMLElement) {
  const view = within(canvasElement);
  await userEvent.type(view.getByRole('textbox', { name: m.decision_appeal_prompt() }), appealDraft);
  await userEvent.click(view.getByRole('button', { name: m.decision_appeal_submit() }));
  return view;
}
export const Open: Story = {
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getByText(openDecision.decision.statement)).toBeVisible();
    await expect(view.queryByText(openDecision.decision.targetId)).toBeNull();
    await expect(view.queryByRole('link', { name: /affected by this decision/ })).toBeNull();
    await submit(canvasElement);
    await expect(await view.findByText(m.decision_appeal_pending())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.getByText(appealDraft)).toBeVisible();
    await expect(args.onAppeal).toHaveBeenCalledTimes(1);
  },
};
export const Pending: Story = { args: { page: pendingDecision } };
export const ReversedUnavailable: Story = {
  args: { page: resolvedDecision('reversed') },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_reversed())).toBeVisible();
    await expect(view.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(view.getByText(openDecision.decision.statement)).toBeVisible();
    await expect(view.queryByText(openDecision.decision.targetId)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Upheld: Story = { args: { page: resolvedDecision('upheld') } };
export const Available: Story = { args: { page: availableDecision } };
export const Expired: Story = { args: { page: expiredDecision } };
export const NativeDenied: Story = {
  args: { onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'denied' })) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_denied());
    await expect(view.getByRole('textbox')).toHaveValue(appealDraft);
    await expect(view.getByRole('button', { name: m.decision_appeal_submit() })).toBeDisabled();
    await expect(view.queryByRole('button', { name: m.decision_retry_same() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.decision_refresh() }));
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await expect(view.getByRole('textbox')).toHaveValue(appealDraft);
    await expect(args.onAppeal).toHaveBeenCalledTimes(1);
  },
};
export const Conflict: Story = {
  args: { onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'updated', decision: pendingDecision.decision })) },
  play: async ({ canvasElement }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_conflict());
    await expect(view.getByText(m.decision_appeal_pending())).toBeVisible();
    await expect(view.getByText(appealDraft)).toBeVisible();
    await expect(view.queryByRole('button', { name: m.decision_retry_same() })).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const UncertainRetry: Story = {
  args: {
    onAppeal: fn<DecisionAppealAction>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ state: 'pending', decision: pendingDecision.decision }),
  },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_uncertain());
    await expect(view.getByRole('textbox')).toHaveValue(appealDraft);
    await expect(view.getByRole('textbox')).toBeDisabled();
    await expect(view.getByText(m.decision_status_taken_down())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.decision_retry_same() }));
    await expect(await view.findByText(m.decision_appeal_pending())).toBeVisible();
    const calls = mocked(args.onAppeal!).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
  },
};
