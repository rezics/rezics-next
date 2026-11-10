import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import {
  RealmClaimReviewExample,
  reviewExample,
  reviewRequest,
  pendingReview,
  type ReviewScenario,
} from './patterns/realm-claim-review/example';
import { confirmReview } from './patterns/realm-claim-review/realm-claim-review.stories';
import { m } from '../paraglide/messages.js';
import { RealmClaimReviewView } from '../community/realm-claim-review-page';
import type { RealmClaimReviewAdapter, RealmClaimReviewRead } from '../community/realm-claim-review';

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
  title: 'Community/Realm Claim Review Page',
  id: 'pages-community-realm-claim-review',
  component: ReviewPage,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone: { name: 'Phone', styles: { width: '390px', height: '844px' } },
        desktop: { name: 'Desktop', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Illustrative response fixtures, not native approval proof. Full UUID references are the longest identifier shape admitted by the production reader; no longer synthetic identifier is passed off as a native result. Inspect these same states at 390 and 1280 pixels, in both directions and locale/theme globals. Interaction assertions are authored and unrun in this delivery.',
      },
    },
  },
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

// Additional page projections use the same declared request and approval response fixtures.
function ProjectionPage({
  initial,
  adapter,
  load = false,
}: {
  initial: RealmClaimReviewRead;
  adapter: RealmClaimReviewAdapter;
  load?: boolean;
}) {
  return (
    <PatternStory visitor="Signed In" path={`/realms/${reviewRequest.realmId}/claims`}>
      <AppShell>
        <RealmClaimReviewView realmId={reviewRequest.realmId} initial={initial} adapter={adapter} load={load} />
      </AppShell>
    </PatternStory>
  );
}
const refused = {
  read: reviewExample('pending').adapter.read,
  approve: reviewExample('denied').adapter.approve,
};
const loading: RealmClaimReviewAdapter = {
  read: () => new Promise(() => {}),
  approve: reviewExample('denied').adapter.approve,
};
const withheldProjections = (['unavailable', 'signed-out', 'closed'] as const).map((kind) => ({
  initial: { kind },
  adapter: {
    read: async () => ({ kind }),
    approve: reviewExample('denied').adapter.approve,
  },
}));

export const Confirmation: Story = {
  args: { scenario: 'pending' },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('button', { name: m.realm_review_review() }));
    const confirmation = await view.findByRole('region', { name: m.realm_review_confirm_heading() });
    await expect(within(confirmation).getByText(reviewRequest.claimantAccountId)).toBeVisible();
    await expect(within(confirmation).getByRole('button', { name: m.realm_review_cancel() })).toBeEnabled();
    await expect(within(confirmation).getByRole('button', { name: m.realm_review_confirm() })).toBeEnabled();
  },
};
export const Refused: Story = {
  render: () => <ProjectionPage initial={pendingReview} adapter={refused} />,
  play: async (context) => {
    await confirmReview(context);
    const view = within(context.canvasElement);
    await expect(await view.findByText(m.realm_review_denied())).toBeVisible();
    await expect(view.queryByText(reviewRequest.claimantAccountId)).toBeNull();
    await expect(view.queryByText(m.realm_review_success())).toBeNull();
  },
};
export const Loading: Story = {
  render: () => <ProjectionPage initial={{ kind: 'unavailable' }} adapter={loading} load />,
};
export const Unavailable: Story = { render: () => <ProjectionPage {...withheldProjections[0]!} /> };
export const SignedOut: Story = { render: () => <ProjectionPage {...withheldProjections[1]!} /> };
export const Closed: Story = { render: () => <ProjectionPage {...withheldProjections[2]!} /> };

async function exactReferences({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const queue = await view.findByRole('list', { name: m.realm_review_queue() });
  await expect(within(queue).getByRole('heading', { level: 3 })).toHaveTextContent(
    m.realm_review_details_request_heading(),
  );
  await expect(within(queue).getByText(reviewRequest.claimantAccountId)).toBeVisible();
  const details = queue.querySelector('details')!;
  const summary = details.querySelector('summary')!;
  summary.focus();
  await expect(summary).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  await expect(details).toHaveAttribute('open');
  for (const value of [reviewRequest.requestId, reviewRequest.realmId]) {
    const reference = within(details).getByText(value, { exact: true });
    await expect(reference).toBeVisible();
    await expect(getComputedStyle(reference).wordBreak).toBe('break-all');
    await expect(getComputedStyle(reference).userSelect).toBe('all');
  }
  await expect(view.queryByRole('button', { name: m.realm_review_confirm() })).toBeNull();
  const page = canvasElement.querySelector('article[aria-busy]')!;
  for (const element of page.querySelectorAll<HTMLElement>('button, summary')) {
    const bounds = element.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  for (const element of page.querySelectorAll<HTMLElement>('p, h2, h3, dd')) {
    await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  }
  await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth + 1);
}
export const LongReferencesPhone: Story = {
  name: 'Full references — illustrative UUIDs at 390px',
  args: { scenario: 'pending' },
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: exactReferences,
};
export const LongReferencesDesktop: Story = {
  name: 'Full references — illustrative UUIDs at 1280px',
  args: { scenario: 'pending' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: exactReferences,
};
export const LongReferencesRtl: Story = {
  name: 'Full references — RTL at 390px',
  render: () => (
    <div dir="rtl">
      <ReviewPage />
    </div>
  ),
  globals: { viewport: { value: 'phone', isRotated: false } },
  play: exactReferences,
};
