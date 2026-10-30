import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, exposureStory, pagePaths, offerCjkReady, offerDelistedReady, offerPageReady } from './page';

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
