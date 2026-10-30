import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, exposureStory, pagePaths, offerCjkReady, offerDelistedReady, offerPageReady } from './page';
import { setMappedCheckoutStory } from '../kernel/fake/checkout';

const meta = {
  title: 'Pages/Commerce/Offer',
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
  play: offerCjkReady,
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
  globals: { viewport: { value: 'phone' } },
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
  },
};
