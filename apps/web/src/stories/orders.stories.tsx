import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { OrdersPage } from '../checkout/orders-page';
import type { BuyerOrder, BuyerOrderPage } from '../checkout/orders';
import { receiptStoryMoney } from '../kernel/fake/checkout';
import paid from '../kernel/recorded/order-paid.json';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PendingPage } from '../shell/pending';
import { ErrorPage } from '../shell/shell';

const meta = {
  title: 'Commerce/Orders',
  id: 'pages-commerce-orders',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// UNRUN component examples. Recorded identity plus explicit money fixtures are not native list evidence.
const order: BuyerOrder = {
  ...paid.order,
  ...receiptStoryMoney,
  settlement: 'paid',
  offerRevision: 1,
  contentEdition: null,
};
const next = 'story-signed/+?=next&recorded';
function OrdersStory({
  page,
  continuation = false,
  previous,
}: {
  page: BuyerOrderPage;
  continuation?: boolean;
  previous?: string;
}) {
  return (
    <main className="min-h-screen min-w-0 bg-background p-4 sm:p-8">
      <OrdersPage
        page={page}
        locale={getLocale()}
        continuation={continuation}
        navigation={previous ? { previous, move: () => {} } : undefined}
      />
    </main>
  );
}

export const History: Story = {
  render: () => <OrdersStory page={{ orders: [order], next }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: m.orders_heading() })).toBeVisible();
    await expect(canvas.getByRole('link', { name: order.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders/${order.id}`,
    );
    await expect(canvas.getByText(m.orders_status_paid(), { exact: true })).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.buyer_history_next() })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders?cursor=${encodeURIComponent(next)}`,
    );
    await expect(canvas.queryByRole('link', { name: m.buyer_history_first() })).toBeNull();
  },
};
export const FirstPageEmpty: Story = {
  render: () => <OrdersStory page={{ orders: [], next: null }} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.orders_empty())).toBeVisible();
    await expect(canvas.queryByRole('navigation', { name: m.orders_pagination() })).toBeNull();
  },
};
export const LaterPageEmpty: Story = {
  render: () => <OrdersStory page={{ orders: [], next: null }} continuation previous="supplied-previous/+?=" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.orders_page_empty())).toBeVisible();
    await expect(canvas.queryByText(m.orders_empty())).toBeNull();
    await expect(canvas.getByRole('link', { name: m.buyer_history_first() })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders`,
    );
    await expect(canvas.getByRole('link', { name: m.buyer_history_previous() })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders?cursor=${encodeURIComponent('supplied-previous/+?=')}`,
    );
    await expect(canvas.queryByRole('link', { name: m.buyer_history_next() })).toBeNull();
  },
};
export const LaterPageEmptyWithNext: Story = {
  render: () => <OrdersStory page={{ orders: [], next }} continuation />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.orders_page_empty())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.buyer_history_first() })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders`,
    );
    await expect(canvas.getByRole('link', { name: m.buyer_history_next() })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders?cursor=${encodeURIComponent(next)}`,
    );
  },
};
export const LongTitlesWithContinuation: Story = {
  render: () => (
    <OrdersStory
      page={{
        orders: [
          {
            ...order,
            title:
              'The Little Prince: annotated edition with historical notes, illustrations, translations and extended commentary for readers',
          },
        ],
        next,
      }}
      continuation
    />
  ),
};
export const UnknownSettlementAndMoney: Story = {
  render: () => (
    <OrdersStory
      page={{
        orders: [
          {
            ...order,
            settlement: 'unknown',
            entitlementId: null,
            moneyUnit: null,
            taxBehavior: null,
          },
        ],
        next: null,
      }}
    />
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.orders_status_unknown(), { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.statements_amount_unavailable())).toBeVisible();
    await expect(canvas.getByText(m.orders_entitlement_pending())).toBeVisible();
  },
};
export const Unavailable: Story = {
  render: () => (
    <main className="p-4 sm:p-8">
      <ErrorPage />
    </main>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.error_message())).toBeVisible();
    await expect(canvas.queryByText(m.orders_empty())).toBeNull();
  },
};
export const UnknownViewer: Story = {
  render: () => (
    <main>
      <PendingPage />
    </main>
  ),
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[aria-busy="true"]')).toBeInTheDocument();
    await expect(within(canvasElement).queryByText(m.orders_empty())).toBeNull();
  },
};
