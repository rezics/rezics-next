import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DecisionPageView, DecisionReadStatus, type DecisionAppealAction } from '../../../moderation/decision-page';
import type { DecisionPage } from '../../../moderation/decision-read';
import { m } from '../../../paraglide/messages.js';
import {
  decisionNow,
  expiredDecision,
  openDecision,
  pendingDecision,
  resolvedDecision,
  unavailableAdviceDecision,
  unavailableContextDecision,
} from './fixtures';

const emptyCommand: DecisionAppealAction = async () => ({ state: 'failed' });
const meta = {
  title: 'Patterns/Moderation/Decision',
  component: DecisionPageView,
  parameters: { layout: 'padded' },
  args: {
    page: openDecision,
    now: decisionNow,
    onAppeal: fn<DecisionAppealAction>(emptyCommand),
    onRefresh: fn(async () => openDecision),
  },
} satisfies Meta<typeof DecisionPageView>;
export default meta;
type Story = StoryObj<typeof meta>;

const fullDecisionReason = Array.from(
  { length: 10 },
  (_, index) =>
    `Reason detail ${index + 1}: the report was reviewed against the community rules and the material supplied with the original post. The decision records why the identified information had to be removed and what the author can appeal.`,
).join('\n\n');
const fullAppealReviewStatement = [
  'The independent reviewer checked the original decision, the context available at the time and the additional statement submitted with the appeal.',
  'The public event information was published by its organization for that purpose, and the review found no private contact details in the affected post.',
  'The reviewer therefore reversed the original takedown and retained the complete explanation with the resolution date.',
].join('\n\n');
const withFullReason = (page: DecisionPage): DecisionPage => ({
  ...page,
  decision: { ...page.decision, statement: fullDecisionReason },
});
const fullOpenDecision = withFullReason(openDecision);
const fullPendingDecision = withFullReason(pendingDecision);
const fullResolvedDecision = (outcome: 'reversed' | 'upheld') => {
  const page = resolvedDecision(outcome);
  return {
    ...page,
    decision: {
      ...page.decision,
      statement: fullDecisionReason,
      appeal: { ...page.decision.appeal!, statement: fullAppealReviewStatement },
    },
  } satisfies DecisionPage;
};

export const Open: Story = {
  args: { page: fullOpenDecision },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expect(view.getByRole('heading', { level: 2, name: m.decision_current_outcome() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_original_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_current_target() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_appeal_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 3, name: m.decision_reasons_heading() })).toBeVisible();
    await expect(view.getByText(fullDecisionReason)).toBeVisible();
    await expect(view.getByText(m.decision_target_context_unavailable())).toBeVisible();
    await expect(view.getByText(m.decision_appeal_advice_unavailable())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('link', { name: /affected by this decision/ })).toBeNull();
  },
};
export const Pending: Story = {
  args: { page: fullPendingDecision },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_pending())).toBeVisible();
    await expect(canvasElement.querySelector('form')).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Reversed: Story = {
  args: { page: fullResolvedDecision('reversed') },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_reversed())).toBeVisible();
    await expect(view.getByText(fullDecisionReason)).toBeVisible();
    await expect(view.getByText(fullAppealReviewStatement)).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Upheld: Story = {
  args: { page: fullResolvedDecision('upheld') },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_upheld())).toBeVisible();
    await expect(view.getByText(fullAppealReviewStatement)).toBeVisible();
    await expect(canvasElement.querySelector('time[datetime="2026-10-30T10:15:00.000Z"]')).not.toBeNull();
    await expect(canvasElement.querySelector('form')).toBeNull();
  },
};
export const Expired: Story = { args: { page: expiredDecision } };
export const ContextUnavailable: Story = { args: { page: unavailableContextDecision } };
export const AdviceUnavailable: Story = { args: { page: unavailableAdviceDecision } };
export const Loading: Story = { render: () => <DecisionReadStatus state="loading" /> };
export const ReadUnavailable: Story = {
  render: () => <DecisionReadStatus state="unavailable" onRetry={fn()} />,
};
export const ReadClosed: Story = { render: () => <DecisionReadStatus state="closed" /> };
export const PlatformClosed: Story = { render: () => <DecisionReadStatus state="platform-closed" /> };
export const RefreshRecovery: Story = {
  args: {
    page: fullOpenDecision,
    onRefresh: fn().mockRejectedValueOnce(new Error('Read unavailable')).mockResolvedValue(fullOpenDecision),
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.decision_refresh() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_decision_read_unavailable());
    await expect(view.queryByText(fullDecisionReason)).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.moderation_decision_read_retry() }));
    await expect(await view.findByText(fullDecisionReason)).toBeVisible();
    await expect(args.onRefresh).toHaveBeenCalledTimes(2);
    await expect(args.onAppeal).not.toHaveBeenCalled();
  },
};
