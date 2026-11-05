import type { Meta, StoryObj } from '@storybook/react-vite';
import { useRef, useState } from 'react';
import { expect, fn, userEvent, within, waitFor } from 'storybook/test';
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
  unsupportedDecision,
  appealDraft,
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
    await expect(view.getByText(m.decision_target_concealed())).toBeVisible();
    await expect(view.getByRole('textbox')).toBeVisible();
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
export const UnsupportedBoard: Story = { args: { page: unsupportedDecision } };
export const ConcealedContext: Story = { args: { page: openDecision } };
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

// The actual presenter owns intent, command/readback separation and focus in these connected examples.
const pendingReadback = {
  state: 'available' as const,
  decision: pendingDecision.decision,
  nativeSourceFingerprint: openDecision.nativeSourceFingerprint,
};
export const KeyboardSubmit: Story = {
  args: { onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'acknowledged', readback: pendingReadback })) },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox'), appealDraft);
    const submit = view.getByRole('button', { name: m.decision_appeal_submit() });
    submit.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await view.findByText(m.decision_appeal_pending())).toHaveFocus();
    await expect(view.getByText(m.decision_appeal_acknowledged())).toBeVisible();
    await expect(args.onAppeal).toHaveBeenCalledTimes(1);
  },
};
export const LostAcknowledgementRetry: Story = {
  args: {
    onAppeal: fn<DecisionAppealAction>()
      .mockResolvedValueOnce({ state: 'failed' })
      .mockResolvedValue({ state: 'acknowledged', readback: pendingReadback }),
  },
  play: async ({ canvasElement, args }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox'), appealDraft);
    view.getByRole('button', { name: m.decision_appeal_submit() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await view.findByText(m.decision_appeal_uncertain())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.decision_refresh() }));
    await expect(view.getByText(m.decision_appeal_uncertain())).toBeVisible();
    view.getByRole('button', { name: m.decision_retry_same() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(await view.findByText(m.decision_appeal_pending())).toHaveFocus();
    const calls = (args.onAppeal as ReturnType<typeof fn<DecisionAppealAction>>).mock.calls;
    await expect(calls).toHaveLength(2);
    await expect(calls[1]![0]).toBe(calls[0]![0]);
  },
};
function ReplacedOperation() {
  const [page, setPage] = useState(openDecision);
  const finish = useRef<((result: Awaited<ReturnType<DecisionAppealAction>>) => void) | null>(null);
  const send = useRef<DecisionAppealAction>(
    () =>
      new Promise((resolve) => {
        finish.current = resolve;
      }),
  ).current;
  const refresh = useRef(async () => openDecision).current;
  return (
    <>
      <button
        className="min-h-11"
        onClick={() => {
          setPage({ ...openDecision, nativeSourceFingerprint: 'replacement-native-source' });
          queueMicrotask(() => finish.current?.({ state: 'acknowledged', readback: pendingReadback }));
        }}
      >
        Replace native source
      </button>
      <DecisionPageView page={page} now={decisionNow} onAppeal={send} onRefresh={refresh} />
    </>
  );
}
export const ReplacementDuringCommand: Story = {
  render: () => <ReplacedOperation />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(view.getByRole('textbox'), appealDraft);
    await userEvent.click(view.getByRole('button', { name: m.decision_appeal_submit() }));
    await userEvent.click(view.getByRole('button', { name: 'Replace native source' }));
    await waitFor(() => expect(view.getByRole('textbox')).toHaveValue(''));
    await expect(view.queryByText(m.decision_appeal_acknowledged())).toBeNull();
  },
};
function ContextReturn() {
  const [away, setAway] = useState(false);
  const page = useRef(resolvedDecision('reversed')).current;
  const focusReturn = useRef(false);
  const refresh = useRef(async () => page).current;
  return away ? (
    <article className="space-y-4">
      <h1>Current context after reversal</h1>
      <button
        className="min-h-11"
        onClick={() => {
          focusReturn.current = true;
          setAway(false);
        }}
      >
        {m.decision_heading()}
      </button>
    </article>
  ) : (
    <div
      ref={(node) => {
        if (node && focusReturn.current) {
          focusReturn.current = false;
          node.querySelector<HTMLAnchorElement>('a[href*="/threads/"]')?.focus();
        }
      }}
      onClickCapture={(event) => {
        if ((event.target as Element).closest('a[href*="/threads/"]')) {
          event.preventDefault();
          setAway(true);
        }
      }}
    >
      <DecisionPageView page={page} now={decisionNow} onAppeal={emptyCommand} onRefresh={refresh} />
    </div>
  );
}
export const KeyboardContextReturn: Story = {
  render: () => <ContextReturn />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const target = view.getByRole('link', { name: 'Current context after reversal' });
    await expect(target).toHaveAttribute('href', expect.stringContaining('/threads/original-thread/'));
    target.focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByRole('heading', { level: 1, name: 'Current context after reversal' })).toBeVisible();
    view.getByRole('button', { name: m.decision_heading() }).focus();
    await userEvent.keyboard('{Enter}');
    await expect(view.getByRole('link', { name: 'Current context after reversal' })).toHaveFocus();
  },
};
