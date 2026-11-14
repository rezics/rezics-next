import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';
import { RealmClaimReviewView } from '../community/realm-claim-review-page';
import type {
  RealmClaimReviewAdapter,
  RealmClaimReviewRead,
  NativeRealmClaimReviewPage,
} from '../community/realm-claim-review';
import { reviewExample, reviewRequest } from './patterns/realm-claim-review/example';
import { m } from '../paraglide/messages.js';

function CurrentReview({
  count = 1,
  concealed = false,
  context = true,
  long = false,
  uncertain = false,
  inspectionUnavailable = false,
  readbackUnavailable = false,
}) {
  const example = useMemo(() => {
    if (uncertain) return reviewExample('uncertain');
    if (readbackUnavailable) {
      const success = reviewExample('success');
      return {
        ...success,
        adapter: {
          ...success.adapter,
          read: async (input) =>
            input.inspectRequestId ? success.adapter.read(input) : { kind: 'unavailable' as const },
        },
      };
    }
    const rows = Array.from({ length: count }, (_, index) => {
      const requestId = `01a1a000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
      return {
        ...reviewRequest,
        requestId,
        claimantAccountId: `01a1a000-0000-7000-8000-${String(index + 101).padStart(12, '0')}`,
        claimant: concealed
          ? { label: 'Claimant', href: null }
          : { label: long ? 'River Chen 長い表示名 '.repeat(180) : 'River Chen', href: '/@river' },
        approvalAdvice: {
          ...reviewRequest.approvalAdvice!,
          destination: `/v1/realms/${reviewRequest.realmId}/claimRequests/${requestId}:approve`,
        },
      };
    });
    const page: NativeRealmClaimReviewPage = {
      claimRequests: rows,
      next: 'opaque-native-next',
      selectedRequest: null,
      realmPresentation: context
        ? {
            state: 'available',
            name: long ? 'A community Realm '.repeat(55) : 'A community Realm',
            description: long ? 'Admitted Realm context '.repeat(170) : 'Context admitted for this reviewer.',
          }
        : { state: 'unavailable' },
    };
    const initial: RealmClaimReviewRead = { kind: 'ready', page };
    const adapter: RealmClaimReviewAdapter = {
      read: async (input) => {
        if (input.inspectRequestId) {
          if (inspectionUnavailable) return { kind: 'unavailable' };
          const { realmId: _realm, ...row } = rows.find((row) => row.requestId === input.inspectRequestId)!;
          return { kind: 'ready', page: { ...page, selectedRequest: { ...row, currentEpisode: true } } };
        }
        return { kind: 'ready', page: { ...page, claimRequests: [], next: null } };
      },
      approve: async () => ({ kind: 'conflict' }),
    };
    return { initial, adapter };
  }, [count, concealed, context, long, uncertain, inspectionUnavailable, readbackUnavailable]);
  return (
    <PatternStory visitor="Signed In" path={`/realms/${reviewRequest.realmId}/claims`}>
      <AppShell>
        <RealmClaimReviewView realmId={reviewRequest.realmId} {...example} />
      </AppShell>
    </PatternStory>
  );
}
const meta = {
  title: 'Community/Realm Claim Current Review',
  id: 'pages-community-realm-claim-current-review',
  component: CurrentReview,
  parameters: {
    layout: 'fullscreen',

    docs: {
      description: {
        component:
          'Consumer fixtures of the delivered current-review schema. Native eligibility, identity history, authority, succession and growth are Content/Accounts evidence. Review the ordinary page at both widths and themes; long values stay within the admitted lengths.',
      },
    },
  },
} satisfies Meta<typeof CurrentReview>;
export default meta;
type Story = StoryObj<typeof meta>;
async function keyboardReview({ canvasElement }: { canvasElement: HTMLElement }) {
  const view = within(canvasElement);
  const button = view.getAllByRole('button', { name: m.realm_review_review() })[0]!;
  button.focus();
  await expect(button).toHaveFocus();
  await userEvent.keyboard('{Enter}');
  const confirmation = await view.findByRole('region', { name: m.realm_review_confirm_heading() });
  await expect(within(confirmation).getByRole('button', { name: m.realm_review_confirm() })).toBeEnabled();
  await expect(confirmation).toHaveFocus();
  await userEvent.click(within(confirmation).getByRole('button', { name: m.realm_review_cancel() }));
  await expect(view.queryByRole('region', { name: m.realm_review_confirm_heading() })).toBeNull();
  const article = canvasElement.querySelector('article[aria-busy]')!;
  await expect(article.scrollWidth).toBeLessThanOrEqual(article.clientWidth + 1);
}
export const Ordinary: Story = { play: keyboardReview };

export const TenRequests: Story = { args: { count: 10 } };
export const TwentyRequests: Story = { args: { count: 20 } };
export const ConcealedIdentityWithoutContext: Story = { args: { concealed: true, context: false } };
export const LongAdmittedValues: Story = {
  args: { long: true },
  play: keyboardReview,
};

export const InspectThenRecover: Story = {
  args: { uncertain: true },
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(view.getByRole('button', { name: m.realm_review_review() }));
    await userEvent.click(await view.findByRole('button', { name: m.realm_review_confirm() }));
    await expect(view.queryByRole('button', { name: m.realm_review_retry() })).toBeNull();
    await userEvent.click(await view.findByRole('button', { name: m.realm_review_inspect_original() }));
    await expect(await view.findByText(m.realm_review_inspected_approved())).toBeVisible();
    await expect(view.queryByText(m.realm_review_success())).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_review_retry() }));
    await expect(await view.findByText(m.realm_review_success())).toBeVisible();
  },
};

export const SparseCurrentQueue: Story = {
  args: { count: 0 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.realm_review_sparse())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_review_next() })).toBeEnabled();
    await expect(canvas.queryByText(m.realm_review_empty())).toBeNull();
  },
};

export const UnavailableCurrentInspection: Story = {
  args: { inspectionUnavailable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_review_review() }));
    await expect(await canvas.findByText(m.realm_review_unavailable())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.realm_review_confirm() })).toBeNull();
  },
};

export const AcceptedApprovalWithUnavailableQueue: Story = {
  args: { readbackUnavailable: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.realm_review_review() }));
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_review_confirm() }));
    const receipt = await canvas.findByRole('status', { name: m.realm_review_success() });
    await expect(receipt).toBeVisible();
    await expect(canvas.getByText(m.realm_review_refresh_after_approval())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_review_retry_page() })).toBeEnabled();
    await expect(canvas.queryByRole('button', { name: m.realm_review_retry() })).toBeNull();
  },
};
