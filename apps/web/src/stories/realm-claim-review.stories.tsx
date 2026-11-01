import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { RealmClaimReviewExample, reviewExample, reviewRequest, type ReviewScenario } from './patterns/realm-claim-review/example';
import { confirmReview } from './patterns/realm-claim-review/realm-claim-review.stories';
import { m } from '../paraglide/messages.js';
import { RealmClaimReviewView } from '../community/realm-claim-review-page';

function ReviewPage({ scenario = 'pending' }: { scenario?: ReviewScenario | 'withheld' }) {
  const withheld = useMemo(() => reviewExample('pending'), []);
  return (
    <PatternStory visitor="Signed In" path={`/realms/${reviewRequest.realmId}/claims`}>
      <AppShell>
        {scenario === 'withheld' ? (
          <RealmClaimReviewView realmId={reviewRequest.realmId} {...withheld} ready={false} />
        ) : (
          <RealmClaimReviewExample scenario={scenario} />
        )}
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Pages/Community/Realm Claim Review',
  component: ReviewPage,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ReviewPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Pending: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getAllByRole('main')).toHaveLength(1);
    await expect(await view.findByRole('heading', { name: m.realm_review_heading() })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_review_confirm() })).toBeNull();
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Sparse: Story = { args: { scenario: 'sparse' } };
export const SessionWithheld: Story = {
  args: { scenario: 'withheld' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.getByRole('heading', { name: m.realm_review_heading() })).toBeVisible();
    await expect(view.queryByText(reviewRequest.claimantAccountId)).toBeNull();
    await expect(view.queryByRole('button', { name: m.realm_review_confirm() })).toBeNull();
  },
};
export const Denied: Story = { args: { scenario: 'denied' } };
export const Conflict: Story = { args: { scenario: 'conflict' }, play: confirmReview };
export const UncertainRetry: Story = { args: { scenario: 'uncertain' }, play: confirmReview };
export const Success: Story = { args: { scenario: 'success' }, play: confirmReview };
