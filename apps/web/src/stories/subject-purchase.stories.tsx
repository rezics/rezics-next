import { createContext, useContext, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { SubjectPurchaseSlot, type SubjectPurchaseContext } from '../features/pages/subject-slots';
import { SubjectOffersView, SubjectOwnedBenefitsRegion } from '../checkout/subject-offers-region';
import { SubjectOffersRegion } from '../checkout/subject-purchase';
import {
  subjectOfferFixture,
  subjectOffersStoryPage,
  type SubjectPurchaseStoryState,
} from '../kernel/fake/subject-offers';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import { FeatureSlotsProvider } from '../shell/feature-slots';

const meta = {
  title: 'Pages/Commerce/Subject purchase',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const StoryState = createContext<SubjectPurchaseStoryState>('ready');
function PublicExample({ locale }: SubjectPurchaseContext) {
  const state = useContext(StoryState);
  const [continued, setContinued] = useState(false);
  return (
    <SubjectOffersView
      page={subjectOffersStoryPage(continued ? 'next-page' : state)}
      locale={locale}
      onNext={() => setContinued(true)}
      {...(continued || state === 'cursor-error' ? { onRestart: () => setContinued(false) } : {})}
    />
  );
}
/** Real shared mount seam and private export; only the public wire examples are constructed. */
function PurchaseStory({
  state = 'ready',
  signedIn = false,
  actualAdapter = false,
}: {
  state?: SubjectPurchaseStoryState;
  signedIn?: boolean;
  actualAdapter?: boolean;
}) {
  const [client] = useState(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(sessionQuery.queryKey, {
      state: signedIn ? 'signed-in' : 'signed-out',
      subject: signedIn ? 'constructed-story-buyer' : null,
      csrfToken: signedIn ? 'constructed-story-session' : null,
    });
    return queryClient;
  });
  const locale = getLocale();
  return (
    <QueryClientProvider client={client}>
      <StoryState.Provider value={state}>
        <FeatureSlotsProvider
          subjectPurchase={{
            publicRegion: actualAdapter ? SubjectOffersRegion : PublicExample,
            privateRegion: SubjectOwnedBenefitsRegion,
          }}
        >
          <main className="min-h-screen min-w-0 bg-background p-4 sm:p-8">
            <header className="max-w-4xl min-w-0">
              <h1 className="text-2xl font-semibold">The Little Prince</h1>
              <SubjectPurchaseSlot
                context={{ subjectId: subjectOfferFixture.targetSubjectId, subjectType: 'schema:Book', locale }}
              />
            </header>
          </main>
        </FeatureSlotsProvider>
      </StoryState.Provider>
    </QueryClientProvider>
  );
}
export const SignedOut: Story = {
  render: () => <PurchaseStory />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      view.getByRole('link', { name: m.subject_purchase_review_offer({ title: subjectOfferFixture.title }) }),
    ).toHaveAttribute('href', `/${getLocale()}/offers/${subjectOfferFixture.id}`);
    await expect(view.queryByRole('link', { name: m.subject_purchase_records() })).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.subject_purchase_next() }));
    await expect(view.getByRole('button', { name: m.subject_purchase_restart() })).toBeVisible();
  },
};
export const SignedIn: Story = {
  render: () => <PurchaseStory signedIn />,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole('link', { name: m.subject_purchase_records() }),
    ).toHaveAttribute('href', `/${getLocale()}/entitlements`);
  },
};
export const Pending: Story = { render: () => <PurchaseStory state="pending" /> };
export const Empty: Story = { render: () => <PurchaseStory state="empty" /> };
export const Preparing: Story = { render: () => <PurchaseStory state="preparing" /> };
export const PartialPreparing: Story = { render: () => <PurchaseStory state="partial-preparing" /> };
export const DeniedSignedIn: Story = { render: () => <PurchaseStory state="denied" signedIn /> };
export const Unavailable: Story = { render: () => <PurchaseStory state="unavailable" /> };
export const CursorError: Story = { render: () => <PurchaseStory state="cursor-error" /> };
export const LongTitle: Story = { render: () => <PurchaseStory state="long-title" /> };
export const MappedPriceUnknown: Story = { render: () => <PurchaseStory state="mapped-price-unknown" signedIn /> };
export const UnknownMapping: Story = { render: () => <PurchaseStory state="unknown-mapping" /> };
export const ActualAdapterUnavailable: Story = { render: () => <PurchaseStory actualAdapter signedIn /> };
export const SignedInLongTitle: Story = {
  render: () => <PurchaseStory state="long-title" signedIn />,
};
