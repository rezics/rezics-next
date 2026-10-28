import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, orderCanceledReady, orderFailedReady, orderPaidReady, orderPendingReady } from './page';

const viewports = {
  checkoutPhone: { name: '390', styles: { width: '390px', height: '844px' } },
  checkoutDesktop: { name: '1280', styles: { width: '1280px', height: '900px' } },
};
const meta = {
  title: 'Pages/Order',
  parameters: { layout: 'fullscreen', viewport: { viewports, defaultViewport: 'checkoutPhone' } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Paid: Story = {
  name: 'Paid',
  play: orderPaidReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
};
export const Pending: Story = {
  name: 'Pending',
  play: orderPendingReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-pending']} />,
};
export const Failed: Story = {
  name: 'Failed',
  play: orderFailedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-failed']} />,
};
export const Canceled: Story = {
  name: 'Canceled',
  play: orderCanceledReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-canceled']} />,
};
export const PaidDesktop: Story = {
  name: 'Paid 1280',
  play: orderPaidReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
};
export const PendingDesktop: Story = {
  name: 'Pending 1280',
  play: orderPendingReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-pending']} />,
};
export const FailedDesktop: Story = {
  name: 'Failed 1280',
  play: orderFailedReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-failed']} />,
};
export const CanceledDesktop: Story = {
  name: 'Canceled 1280',
  play: orderCanceledReady,
  parameters: { viewport: { defaultViewport: 'checkoutDesktop' } },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-canceled']} />,
};
