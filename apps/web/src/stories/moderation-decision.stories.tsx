import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DecisionPageView, type DecisionAppealAction } from '../moderation/decision-page';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { reporterStatusViewports } from './reporter-status/fixture';
import { decisionNow, openDecision, pendingDecision } from './patterns/moderation-decision/fixtures';
import * as pattern from './patterns/moderation-decision/moderation-decision.stories';

// Fixture-derived illustration, not native evidence: long reasons/references exercise wrapping while the target stays withheld.
const longId = (value: string) => `${value}-${value}-${value}`;
const longDecisionReason = Array.from(
  { length: 8 },
  (_, index) => `Decision reason paragraph ${index + 1}: ${openDecision.decision.statement}`,
).join('\n\n');
const longReferencePage = {
  ...pendingDecision,
  decision: {
    ...pendingDecision.decision,
    id: longId(pendingDecision.decision.id),
    targetId: longId(pendingDecision.decision.targetId),
    statement: longDecisionReason,
    appeal: {
      ...pendingDecision.decision.appeal!,
      id: longId(pendingDecision.decision.appeal!.id),
    },
  },
};

const meta = {
  title: 'Community/Moderation decision',
  id: 'pages-community-moderation-decision',
  component: DecisionPageView,
  parameters: { layout: 'fullscreen', viewport: { options: reporterStatusViewports } },
  decorators: [
    (Story) => (
      <PatternStory visitor="Signed In" path={`/moderation/decisions/${openDecision.decision.id}`}>
        <AppShell>
          <Story />
        </AppShell>
      </PatternStory>
    ),
  ],
  args: {
    page: openDecision,
    now: decisionNow,
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'acknowledged', readback: { state: 'unavailable' } })),
    onRefresh: fn(async () => openDecision),
  },
} satisfies Meta<typeof DecisionPageView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {
  ...pattern.Open,
  play: async (context) => {
    await expect(within(context.canvasElement).getAllByRole('main')).toHaveLength(1);
    await pattern.Open.play!(context);
  },
};
export const Pending: Story = { ...pattern.Pending };
export const Reversed: Story = { ...pattern.Reversed };
export const Upheld: Story = { ...pattern.Upheld };
export const Expired: Story = { ...pattern.Expired };
export const ContextUnavailable: Story = { ...pattern.ContextUnavailable };
export const AdviceUnavailable: Story = { ...pattern.AdviceUnavailable };
export const UnsupportedBoard: Story = { ...pattern.UnsupportedBoard };
export const ConcealedContext: Story = { ...pattern.ConcealedContext };
export const KeyboardSubmit: Story = { ...pattern.KeyboardSubmit };
export const LostAcknowledgementRetry: Story = { ...pattern.LostAcknowledgementRetry };
export const ReplacementDuringCommand: Story = { ...pattern.ReplacementDuringCommand };
export const KeyboardContextReturn: Story = { ...pattern.KeyboardContextReturn };
export const Loading: Story = { ...pattern.Loading };
export const ReadUnavailable: Story = { ...pattern.ReadUnavailable };
export const ReadClosed: Story = { ...pattern.ReadClosed };
export const PlatformClosed: Story = { ...pattern.PlatformClosed };
export const RefreshRecovery: Story = { ...pattern.RefreshRecovery };

export const IllustrativeLongReferences: Story = {
  name: 'Illustrative long references (fixture-derived)',
  args: { page: longReferencePage },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { level: 1, name: m.decision_heading() })).toBeVisible();
    await expect(view.getByText(m.decision_target_concealed())).toBeVisible();
    await expect(view.queryByRole('link', { name: /affected by this decision/i })).toBeNull();
    await expect(view.getByText(longDecisionReason)).toBeVisible();
    await expect(view.getByText(m.decision_appeal_pending())).toBeVisible();
    const reference = view.getByText(m.reporter_status_reference(), { exact: true });
    await userEvent.click(reference);
    await expect(view.getByText(longReferencePage.decision.id, { exact: true })).toBeVisible();
    await expect(view.getByText(longReferencePage.decision.appeal!.id, { exact: true })).toBeVisible();
    await expect(view.queryByText(longReferencePage.decision.targetId, { exact: true })).toBeNull();
    expect(canvasElement.innerHTML).not.toContain(longReferencePage.decision.targetId);
  },
};
