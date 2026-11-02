import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { DecisionPageView, type DecisionAppealAction } from '../moderation/decision-page';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { reporterStatusViewports } from './reporter-status/fixture';
import { decisionNow, openDecision, pendingDecision } from './patterns/moderation-decision/fixtures';
import * as pattern from './patterns/moderation-decision/moderation-decision.stories';

// Fixture-derived long references exercise wrapping only; this illustration is not native evidence.
const longId = (value: string) => `${value}-${value}-${value}`;
const longReferencePage = {
  ...openDecision,
  decision: {
    ...openDecision.decision,
    id: longId(openDecision.decision.id),
    targetId: longId(openDecision.decision.targetId),
  },
};

const meta = {
  title: 'Pages/Community/Moderation decision',
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
    onAppeal: fn<DecisionAppealAction>(async () => ({ state: 'pending', decision: pendingDecision.decision })),
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
export const ReversedUnavailable: Story = { ...pattern.ReversedUnavailable };
export const Upheld: Story = { ...pattern.Upheld };
export const Available: Story = { ...pattern.Available };
export const OpenWithAvailableTarget: Story = { ...pattern.OpenWithAvailableTarget };
export const Expired: Story = { ...pattern.Expired };
export const NativeDenied: Story = { ...pattern.NativeDenied };
export const Conflict: Story = { ...pattern.Conflict };
export const UncertainRetry: Story = { ...pattern.UncertainRetry };
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
    await expect(view.getByText(m.moderation_target_unavailable())).toBeVisible();
    await expect(view.queryByRole('link', { name: /affected by this decision/i })).toBeNull();
    const reference = view.getByText(m.reporter_status_reference(), { exact: true });
    await userEvent.click(reference);
    await expect(view.getByText(longReferencePage.decision.id, { exact: true })).toBeVisible();
    await expect(view.getByText(longReferencePage.decision.targetId, { exact: true })).toBeVisible();
  },
};
