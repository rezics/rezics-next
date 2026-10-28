import type { Meta, StoryObj } from '@storybook/react-vite';
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
