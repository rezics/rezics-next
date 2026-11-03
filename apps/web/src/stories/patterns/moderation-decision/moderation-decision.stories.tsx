import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, mocked, userEvent, within } from 'storybook/test';
import { DecisionPageView, DecisionReadStatus, type DecisionAppealAction } from '../../../moderation/decision-page';
import type { DecisionPage } from '../../../moderation/decision-read';
import { m } from '../../../paraglide/messages.js';
import {
  appealDraft,
  availableDecision,
  decisionNow,
  expiredDecision,
  openDecision,
  pendingDecision,
  resolvedDecision,
  unavailableAdviceDecision,
  unavailableContextDecision,
  unsupportedBoardDecision,
} from './fixtures';

const meta = {
  title: 'Patterns/Moderation/Decision',
  component: DecisionPageView,
  parameters: { layout: 'padded' },
  args: {
    page: openDecision,
    now: decisionNow,
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'acknowledged', readback: { state: 'unavailable' } })),
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
const fullAppealDraft = `${appealDraft}\n\n${Array.from(
  { length: 12 },
  () => 'The complete appeal includes additional context that must remain available for an exact retry.',
).join('\n')}`;
const withFullReason = (page: DecisionPage): DecisionPage => ({
  ...page,
  decision: { ...page.decision, statement: fullDecisionReason },
});
const fullOpenDecision = withFullReason(openDecision);
const fullPendingDecision = withFullReason(pendingDecision);
const fullResolvedDecision = (outcome: 'reversed' | 'upheld') => {
  const page = withFullReason(resolvedDecision(outcome));
  return {
    ...page,
    decision: {
      ...page.decision,
      appeal: { ...page.decision.appeal!, statement: fullAppealReviewStatement },
    },
  };
};
const openWithAvailableTarget: DecisionPage = {
  ...fullOpenDecision,
  decision: { ...fullOpenDecision.decision, targetContext: availableDecision.decision.targetContext },
};

async function submit(canvasElement: HTMLElement, statement = fullAppealDraft) {
  const view = within(canvasElement);
  await userEvent.type(view.getByRole('textbox', { name: m.decision_appeal_prompt() }), statement);
  await userEvent.click(view.getByRole('button', { name: m.decision_appeal_submit() }));
  return view;
}
export const Open: Story = {
  args: {
    page: fullOpenDecision,
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'acknowledged', readback: { state: 'unavailable' } })),
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await expect(view.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    await expect(view.getByRole('heading', { level: 2, name: m.decision_current_outcome() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_original_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_current_target() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 2, name: m.decision_appeal_heading() })).toBeVisible();
    await expect(view.getByRole('heading', { level: 3, name: m.decision_reasons_heading() })).toBeVisible();
    await expect(view.getByText(fullDecisionReason)).toBeVisible();
    await expect(view.queryByText(openDecision.decision.targetId)).toBeNull();
    await expect(view.queryByRole('link', { name: /affected by this decision/ })).toBeNull();
    await submit(canvasElement);
    await expect(await view.findByText(m.decision_appeal_acknowledged())).toBeVisible();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.getByText(fullAppealDraft)).toBeVisible();
    await expect(args.onAppeal).toHaveBeenCalledTimes(1);
  },
};
export const Pending: Story = {
  args: { page: fullPendingDecision },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_pending())).toBeVisible();
    await expect(canvasElement.querySelector('form')).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(view.queryByRole('button', { name: m.decision_appeal_submit() })).toBeNull();
  },
};
export const ReversedUnavailable: Story = {
  args: { page: fullResolvedDecision('reversed') },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByText(m.decision_appeal_reversed())).toBeVisible();
    await expect(view.getByText(m.decision_target_concealed())).toBeVisible();
    await expect(view.getByText(fullDecisionReason)).toBeVisible();
    await expect(view.getByText(fullAppealReviewStatement)).toBeVisible();
    await expect(view.queryByText(openDecision.decision.targetId)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
    await expect(canvasElement.querySelector('form')).toBeNull();
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
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};
export const Available: Story = {
  args: { page: availableDecision },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const target = view.getByRole('link', { name: /Community event: practical information/ });
    await expect(target.getAttribute('href')).toContain('/threads/');
    await expect(canvasElement.querySelector('form')).toBeNull();
  },
};
export const OpenWithAvailableTarget: Story = {
  args: { page: openWithAvailableTarget },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const target = view.getByRole('link', { name: /Community event: practical information/ });
    const form = canvasElement.querySelector('form');
    await expect(form).not.toBeNull();
    await expect(target.getAttribute('href')).toContain('/threads/');
    await expect(target.contains(form)).toBe(false);
    await expect(form?.contains(target)).toBe(false);
  },
};
export const Expired: Story = { args: { page: expiredDecision } };
export const ContextUnavailable: Story = { args: { page: unavailableContextDecision } };
export const AdviceUnavailable: Story = { args: { page: unavailableAdviceDecision } };
export const BoardUnsupported: Story = { args: { page: unsupportedBoardDecision } };
export const NativeDenied: Story = {
  args: { page: fullOpenDecision, onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'denied' })) },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_denied());
    await expect(view.getByRole('textbox')).toHaveValue(fullAppealDraft);
    await expect(view.getByRole('button', { name: m.decision_appeal_submit() })).toBeDisabled();
    await expect(view.queryByRole('button', { name: m.decision_retry_same() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.decision_refresh() }));
    await expect(args.onRefresh).toHaveBeenCalledTimes(1);
    await expect(view.getByRole('textbox')).toHaveValue(fullAppealDraft);
    await expect(args.onAppeal).toHaveBeenCalledTimes(1);
  },
};
export const Conflict: Story = {
  args: {
    page: fullOpenDecision,
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'conflict', readback: { state: 'unavailable' } })),
  },
  play: async ({ canvasElement }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_conflict());
    await expect(view.getByText(m.decision_readback_unavailable())).toBeVisible();
    await expect(view.getByText(fullAppealDraft)).toBeVisible();
    await expect(view.queryByRole('button', { name: m.decision_retry_same() })).toBeNull();
    await expect(view.getByRole('textbox')).toBeDisabled();
  },
};
export const UncertainRetry: Story = {
  args: {
    page: fullOpenDecision,
    onAppeal: fn<DecisionAppealAction>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ state: 'acknowledged', readback: { state: 'unavailable' } }),
  },
  play: async ({ canvasElement, args }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.decision_appeal_uncertain());
    await expect(view.getByRole('textbox')).toHaveValue(fullAppealDraft);
    await expect(view.getByRole('textbox')).toBeDisabled();
    await expect(view.getByText(m.decision_status_taken_down())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.decision_retry_same() }));
    await expect(await view.findByText(m.decision_appeal_acknowledged())).toBeVisible();
    const calls = mocked(args.onAppeal!).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toEqual(calls[0]![0]);
  },
};
export const NativeObservationReplaced: Story = {
  args: {
    page: fullOpenDecision,
    onAppeal: fn<DecisionAppealAction>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        state: 'acknowledged',
        readback: {
          state: 'available',
          decision: {
            ...openDecision.decision,
            appeal: { id: '0192f3a0-6c1e-7b2a-9d4e-000000000081', outcome: null, statement: null, resolvedAt: null },
            viewer: { ...openDecision.decision.viewer, appeal: { state: 'unavailable', reason: 'already_appealed' } },
          },
          nativeSourceFingerprint: 'illustrative-source-replaced',
        },
      };
    }),
  },
  play: async ({ canvasElement }) => {
    const view = await submit(canvasElement);
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_decision_read_closed());
    await expect(view.queryByText(fullDecisionReason)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
  },
};

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
    await userEvent.type(view.getByRole('textbox'), fullAppealDraft);
    await userEvent.click(view.getByRole('button', { name: m.decision_refresh() }));
    await expect(await view.findByRole('alert')).toHaveTextContent(m.moderation_decision_read_unavailable());
    await expect(view.queryByText(fullDecisionReason)).toBeNull();
    await expect(view.queryByRole('textbox')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.moderation_decision_read_retry() }));
    await expect(await view.findByRole('textbox')).toHaveValue(fullAppealDraft);
    await expect(args.onRefresh).toHaveBeenCalledTimes(2);
    await expect(args.onAppeal).not.toHaveBeenCalled();
  },
};
