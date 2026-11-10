import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import {
  PageStory,
  exposureStory,
  pagePaths,
  pageReady,
  offerCjkReady,
  offerDelistedReady,
  offerPageReady,
} from './page';
import { acquisitionProblems, setMappedCheckoutStory } from '../kernel/fake/checkout';
import { localizeHref } from '../paraglide/runtime.js';
import longOffer from '../kernel/recorded/offer-cjk.json';

function currentMappedOffer() {
  setMappedCheckoutStory(true);
  return () => setMappedCheckoutStory(false);
}

const meta = {
  title: 'Commerce/Offer',
  id: 'pages-commerce-offer',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Buyer',
  play: offerPageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer']} />,
};
export const SignedOut: Story = {
  name: 'Signed out',
  play: offerPageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['offer']} />,
};
export const LongCjkTitle: Story = {
  name: 'Long CJK Title',
  beforeEach: currentMappedOffer,
  play: async (context) => {
    await offerCjkReady(context);
    const view = within(await within(context.canvasElement).findByRole('main'));
    const summary = view.getByText(m.offer_full_titles());
    summary.focus();
    await userEvent.keyboard('{Enter}');
    const titles = summary.closest('details')!;
    await expect(await within(titles).findByText(longOffer.offer.title, { exact: false })).toBeVisible();
    await expect(view.getByRole('button', { name: m.offer_buy() })).toBeEnabled();
    await userEvent.keyboard('{Enter}');
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer-cjk']} />,
};
export const Delisted: Story = {
  name: 'Delisted',
  play: offerDelistedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer-delisted']} />,
};
export const KernelUnavailable: Story = {
  name: 'Kernel unavailable',
  tags: ['!dev'],
  play: async ({ canvasElement }) => {
    const originalFetch = window.fetch;
    window.fetch = (async (input: Parameters<typeof window.fetch>[0], init?: Parameters<typeof window.fetch>[1]) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(target, window.location.href);
      const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method);
      if (url.pathname === '/checkout' && method === 'POST') return new Response(null, { status: 503 });
      return originalFetch(input, init);
    }) as typeof window.fetch;
    try {
      const main = await within(canvasElement).findByRole('main');
      const view = within(main);
      await userEvent.click(await view.findByRole('button', { name: m.offer_buy() }));
      await view.findByText(m.offer_retry_note());
      await view.findByRole('button', { name: m.offer_retry() });
    } finally {
      window.fetch = originalFetch;
    }
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.offer} />,
};
export const ExposureOpen: Story = exposureStory(pagePaths.offer);
export const ExposureClosed: Story = exposureStory(pagePaths.offer, true);

export const TermsChanged: Story = {
  name: 'Terms changed after review',
  beforeEach: currentMappedOffer,
  play: async ({ canvasElement }) => {
    const originalFetch = window.fetch;
    let starts = 0;
    window.fetch = (async (input: Parameters<typeof window.fetch>[0], init?: Parameters<typeof window.fetch>[1]) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(target, window.location.href);
      const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method);
      if (url.pathname === '/checkout' && method === 'POST') {
        starts++;
        return Response.json({ code: 'offer_revision_conflict' }, { status: 409 });
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;
    try {
      const view = within(await within(canvasElement).findByRole('main'));
      await userEvent.click(await view.findByRole('button', { name: m.offer_buy() }));
      await view.findByText(m.offer_terms_changed());
      await expect(await view.findByRole('button', { name: m.offer_review_terms() })).toBeEnabled();
      await expect(view.queryByRole('button', { name: m.offer_buy() })).toBeNull();
      await expect(view.queryByRole('button', { name: m.offer_retry() })).toBeNull();
      await expect(starts).toBe(1);
    } finally {
      window.fetch = originalFetch;
    }
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.offer} />,
};
export const TermsChangedMobile: Story = {
  ...TermsChanged,
  parameters: {
    viewport: {
      options: { phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' } } },
    },
  },
  globals: {},
};

export const MappedFixedEdition: Story = {
  name: 'Buyer, fixed edition promise',
  beforeEach() {
    setMappedCheckoutStory(true);
    return () => setMappedCheckoutStory(false);
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths.offer} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.benefit_heading() });
    await canvas.findByText('CC-BY-SA-4.0');
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
    const buy = await canvas.findByRole('button', { name: m.offer_buy() });
    await waitFor(async () => expect(buy).toBeEnabled());
    const decision = within(buy.closest('section')!);
    await expect(decision.getByText(m.offer_price())).toBeVisible();
    await expect(decision.getByText(m.benefit_acquisition())).toBeVisible();
    await expect(decision.getByText(m.benefit_fixed_version())).toBeVisible();
    const terms = canvas.getByRole('heading', { name: m.benefit_heading() });
    await expect(Boolean(buy.compareDocumentPosition(terms) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  },
};

function recoveryStory(problem: (typeof acquisitionProblems)[keyof typeof acquisitionProblems]): Story {
  return {
    beforeEach: currentMappedOffer,
    render: () => <PageStory visitor="Signed In" path={pagePaths.offer} />,
    async play({ canvasElement, step }) {
      const originalFetch = window.fetch;
      let starts = 0;
      window.fetch = (async (input, init) => {
        const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = init?.method ?? (typeof input === 'string' || input instanceof URL ? 'GET' : input.method);
        if (new URL(target, window.location.href).pathname === '/checkout' && method === 'POST') {
          starts++;
          return Response.json(problem, { status: 409, headers: { 'content-type': 'application/problem+json' } });
        }
        return originalFetch(input, init);
      }) as typeof window.fetch;
      try {
        await step(
          'Offer recovery waits for genuine session and operation readiness then makes one checkout request and preserves exact own-record recovery and no second purchase',
          async () => {
            await pageReady({ canvasElement });
            const view = within(within(canvasElement).getByRole('main'));
            const buy = await view.findByRole('button', { name: m.offer_buy() });
            // Presence precedes session/exposure hydration; the real control owns readiness.
            await waitFor(async () => {
              await expect(buy).toBeVisible();
              await expect(buy).toBeEnabled();
              await expect(buy).not.toHaveStyle({ pointerEvents: 'none' });
            });
            await expect(starts).toBe(0);
            await userEvent.click(buy);
            const owned = problem.code === 'benefit_already_owned';
            await view.findByText(owned ? m.offer_already_owned() : m.offer_acquisition_pending());
            const link = await view.findByRole('link', {
              name: owned ? m.offer_open_entitlement() : m.offer_open_order(),
            });
            await expect(link).toHaveAttribute(
              'href',
              localizeHref(
                owned ? `/entitlements/${acquisitionProblems.owned.entitlementId}` : `/orders/${problem.orderId}`,
              ),
            );
            await expect(view.queryByRole('button', { name: m.offer_buy() })).toBeNull();
            await expect(view.queryByRole('button', { name: m.offer_retry() })).toBeNull();
            await expect(view.queryByRole('button', { name: m.offer_review_terms() })).toBeNull();
            await expect(view.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
            await expect(starts).toBe(1);
          },
        );
      } finally {
        window.fetch = originalFetch;
      }
    },
  };
}

export const AlreadyOwned: Story = { ...recoveryStory(acquisitionProblems.owned), name: 'Already purchased' };
export const AcquisitionPending: Story = {
  ...recoveryStory(acquisitionProblems.pending),
  name: 'Existing payment in progress',
};
const phone = {
  parameters: { viewport: { options: { phone: { name: 'Phone 390', styles: { width: '390px', height: '844px' } } } } },
  globals: {},
};
export const AlreadyOwnedMobile: Story = { ...AlreadyOwned, ...phone };
export const AcquisitionPendingMobile: Story = { ...AcquisitionPending, ...phone };
