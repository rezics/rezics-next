import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { PageStory, pagePaths, offerCjkReady, offerDelistedReady, offerPageReady } from './page';

const viewports = {
  checkoutPhone: { name: '390', styles: { width: '390px', height: '844px' } },
  checkoutDesktop: { name: '1280', styles: { width: '1280px', height: '900px' } },
};
const meta = {
  title: 'Pages/Offer',
  parameters: { layout: 'fullscreen', viewport: { viewports, defaultViewport: 'checkoutPhone' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const SignedIn: Story = {
  name: 'Signed In',
  play: offerPageReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer']} />,
};
export const SignedOut: Story = {
  name: 'Signed Out',
  play: offerPageReady,
  render: () => <PageStory visitor="Signed Out" path={pagePaths['offer']} />,
};
export const LongCjkTitle: Story = {
  name: 'Long CJK Title',
  play: offerCjkReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer-cjk']} />,
};
export const ShortTitleDesktop: Story = {
  name: 'Short Title 1280',
  play: offerPageReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer']} />,
};
export const LongCjkTitleDesktop: Story = {
  name: 'Long CJK Title 1280',
  play: offerCjkReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer-cjk']} />,
};
export const Delisted: Story = {
  name: 'Delisted',
  play: offerDelistedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['offer-delisted']} />,
};

export const KernelUnavailable: Story = {
  name: 'Kernel Unavailable',
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
