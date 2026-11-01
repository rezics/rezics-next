import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { DecisionPageView, type DecisionAppealAction } from '../moderation/decision-page';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { decisionNow, openDecision, pendingDecision } from './patterns/moderation-decision/fixtures';
import * as pattern from './patterns/moderation-decision/moderation-decision.stories';

const meta = {
  title: 'Pages/Community/Moderation decision',
  component: DecisionPageView,
  parameters: { layout: 'fullscreen' },
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
