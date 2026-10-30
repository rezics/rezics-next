import type { Meta, StoryObj } from '@storybook/react-vite';
import { OrderPage } from '../checkout/order-page';
import type { CurrentEntitlement, OrderPageData } from '../checkout/order';
import { subjectCover } from '../checkout/subject-cover';
import paidRecording from '../kernel/recorded/order-paid.json';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, pagePaths, orderCanceledReady, orderFailedReady, orderPaidReady, orderPendingReady } from './page';

const meta = {
  title: 'Pages/Commerce/Order',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Paid: Story = {
  name: 'Buyer, paid',
  play: orderPaidReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
};
export const Pending: Story = {
  name: 'Buyer, pending',
  play: orderPendingReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-pending']} />,
};
export const Failed: Story = {
  name: 'Buyer, failed',
  play: orderFailedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-failed']} />,
};
export const Canceled: Story = {
  name: 'Buyer, canceled',
  play: orderCanceledReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-canceled']} />,
};

// Contract-shaped component examples; these do not establish current native authority.
function currentOrder(entitlement: CurrentEntitlement): OrderPageData {
  const order = paidRecording.order;
  return {
    ...order,
    settlement: 'paid',
    entitlement,
    subject: subjectCover(getLocale(), order.targetSubjectId, order.title, order.subject),
  };
}
export const Active: Story = {
  name: 'Buyer, current active access (component)',
  render: () => <OrderPage order={currentOrder({ kind: 'current', active: true })} />,
};
export const Refunded: Story = {
  name: 'Buyer, paid receipt with revoked access (component)',
  render: () => <OrderPage order={currentOrder({ kind: 'current', active: false })} />,
};
export const AccessUnavailable: Story = {
  name: 'Buyer, current access unavailable (component)',
  render: () => <OrderPage order={currentOrder({ kind: 'unavailable' })} />,
};
export const NoEntitlement: Story = {
  name: 'Buyer, no entitlement (component)',
  render: () => <OrderPage order={{ ...currentOrder({ kind: 'none' }), entitlementId: null }} />,
};
export const AccessRefresh: Story = {
  name: 'Buyer, payment confirmed and current access needs refresh (component)',
  render: () => <OrderPage order={currentOrder({ kind: 'refresh' })} />,
};
