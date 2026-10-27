import type { Meta, StoryObj } from '@storybook/react-vite';
import { PageStory, pagePaths, orderCanceledReady, orderFailedReady, orderPaidReady, orderPendingReady } from './page';

const meta = { title: 'Pages/Order', parameters: { layout: 'fullscreen' } } satisfies Meta;
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
