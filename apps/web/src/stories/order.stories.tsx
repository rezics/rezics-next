import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { OrderPage } from '../checkout/order-page';
import type { CurrentEntitlement, OrderPageData } from '../checkout/order';
import { subjectCover } from '../checkout/subject-cover';
import paidRecording from '../kernel/recorded/order-paid.json';
import pendingRecording from '../kernel/recorded/order-pending.json';
import { expect, userEvent, within } from 'storybook/test';
import type { ReconciliationSender } from '../checkout/order-reconcile';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { receiptStoryMoney, setMappedCheckoutStory, setReceiptMoneyStory } from '../kernel/fake/checkout';
import { setEntitlementStoryMode } from '../kernel/fake/entitlements';
import { AppShell } from '../shell/shell';
import {
  PageStory,
  PatternStory,
  pagePaths,
  pageReady,
  orderCanceledReady,
  orderFailedReady,
  orderPaidReady,
  orderPendingReady,
} from './page';

const meta = {
  title: 'Pages/Commerce/Order',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// Authored disclosure interactions remain UNRUN at this source boundary.
async function orderMain(canvasElement: HTMLElement) {
  await pageReady({ canvasElement });
  return within(within(canvasElement).getByRole('main'));
}
async function receiptDetails(canvasElement: HTMLElement, id: string, taxCode?: string) {
  const canvas = await orderMain(canvasElement);
  const summary = await canvas.findByText(m.order_technical_details());
  const details = summary.closest('details')!;
  await expect(details).not.toHaveAttribute('open');
  const reference = within(details).getByText(id);
  await expect(reference).not.toBeVisible();
  summary.focus();
  await userEvent.keyboard('{Enter}');
  await expect(details).toHaveAttribute('open');
  await expect(reference).toBeVisible();
  if (taxCode) await expect(within(details).getByText(taxCode)).toBeVisible();
}

export const Paid: Story = {
  name: 'Buyer, paid',
  async play(context) {
    await orderPaidReady(context);
    await receiptDetails(context.canvasElement, paidRecording.order.id);
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
};
export const Pending: Story = {
  name: 'Buyer, pending',
  async play(context) {
    await orderPendingReady(context);
    await expect(within(context.canvasElement).queryByText(m.order_paid_total())).toBeNull();
    await receiptDetails(context.canvasElement, pendingRecording.order.id);
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-pending']} />,
};
export const Failed: Story = {
  name: 'Buyer, failed',
  play: orderFailedReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-failed']} />,
};
export const FailedAfterReturn: Story = {
  name: 'Buyer, failed payment after checkout return',
  play: orderFailedReady,
  render: () => <PageStory visitor="Signed In" path={`${pagePaths['order-failed']}?checkout=success`} />,
};
export const Canceled: Story = {
  name: 'Buyer, canceled',
  play: orderCanceledReady,
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-canceled']} />,
};

// Contract-shaped component examples in the shared AppShell frame; these remain pattern evidence
// and do not establish current native authority or actual-route recordings.
function currentOrder(entitlement: CurrentEntitlement): OrderPageData {
  const order = paidRecording.order;
  return {
    ...order,
    settlement: 'paid',
    entitlement,
    money: receiptStoryMoney,
    subject: subjectCover(getLocale(), order.targetSubjectId, order.title, order.subject),
  };
}
function OrderPattern({ id, children }: { id: string; children: ReactNode }) {
  return (
    <PatternStory visitor="Signed In" path={`/orders/${id}`}>
      <AppShell>{children}</AppShell>
    </PatternStory>
  );
}
function CurrentReceipt({ entitlement }: { entitlement: CurrentEntitlement }) {
  const order = currentOrder(entitlement);
  return (
    <OrderPattern id={order.id}>
      <OrderPage order={{ ...order, ...(entitlement.kind === 'none' ? { entitlementId: null } : {}) }} />
    </OrderPattern>
  );
}
function currentReceiptReady(label: () => string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = await orderMain(canvasElement);
    await canvas.findByRole('heading', { name: m.order_paid(), level: 1 });
    await canvas.findByText(label());
    await canvas.findByText(m.order_paid_total());
    await receiptDetails(canvasElement, paidRecording.order.id, receiptStoryMoney.taxCode!);
  };
}
export const Active: Story = {
  name: 'Buyer, current active access (component)',
  render: () => <CurrentReceipt entitlement={{ kind: 'current', active: true }} />,
  play: currentReceiptReady(() => m.order_entitlement_active()),
};
export const Refunded: Story = {
  name: 'Buyer, paid receipt with revoked access (component)',
  render: () => <CurrentReceipt entitlement={{ kind: 'current', active: false }} />,
  play: currentReceiptReady(() => m.order_entitlement_revoked()),
};
export const AccessUnavailable: Story = {
  name: 'Buyer, current access unavailable (component)',
  render: () => <CurrentReceipt entitlement={{ kind: 'unavailable' }} />,
  play: currentReceiptReady(() => m.order_entitlement_unavailable()),
};
export const NoEntitlement: Story = {
  name: 'Buyer, no entitlement (component)',
  render: () => <CurrentReceipt entitlement={{ kind: 'none' }} />,
  play: currentReceiptReady(() => m.orders_entitlement_none()),
};
export const AccessRefresh: Story = {
  name: 'Buyer, payment confirmed and current access needs refresh (component)',
  render: () => <CurrentReceipt entitlement={{ kind: 'refresh' }} />,
  play: currentReceiptReady(() => m.order_entitlement_refresh()),
};

export const RecordedCharge: Story = {
  name: 'Buyer, recorded charge (constructed amounts)',
  beforeEach() {
    setReceiptMoneyStory(true);
    return () => setReceiptMoneyStory(false);
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
  async play(context) {
    await orderPaidReady(context);
    await within(context.canvasElement).findByText(m.order_recorded_tax());
    await receiptDetails(context.canvasElement, paidRecording.order.id, receiptStoryMoney.taxCode!);
  },
};

export const LongReceiptNarrow: Story = {
  name: 'Buyer, long receipt and unavailable access, phone (component)',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => {
    const order = currentOrder({ kind: 'unavailable' });
    const title =
      'A reader’s annotated edition with translations, illustrations and extensive historical notes — '.repeat(3);
    return (
      <OrderPattern id={order.id}>
        <OrderPage
          order={{
            ...order,
            subject: { ...order.subject, subject: { ...order.subject.subject, title } },
          }}
        />
      </OrderPattern>
    );
  },
  play: currentReceiptReady(() => m.order_entitlement_unavailable()),
};

export const UnknownSettlement: Story = {
  name: 'Buyer, unknown payment and unavailable access (component)',
  render: () => {
    const order = pendingRecording.order;
    return (
      <OrderPattern id={order.id}>
        <OrderPage
          order={{
            ...order,
            settlement: 'unknown',
            entitlement: { kind: 'unavailable' },
            money: receiptStoryMoney,
            canUseBenefit: false,
            subject: subjectCover(getLocale(), order.targetSubjectId, order.title, order.subject),
          }}
        />
      </OrderPattern>
    );
  },
  async play({ canvasElement }) {
    const canvas = await orderMain(canvasElement);
    await canvas.findByRole('heading', { name: m.order_pending(), level: 1 });
    await canvas.findByText(m.order_confirming());
    await canvas.findByText(m.order_entitlement_unavailable());
    await expect(canvas.queryByText(m.order_paid_total())).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
    await receiptDetails(canvasElement, pendingRecording.order.id, receiptStoryMoney.taxCode!);
  },
};

export const RecordedMoneyUnavailable: Story = {
  name: 'Buyer, paid with unrecorded amounts (component)',
  render: () => {
    const order = currentOrder({ kind: 'unavailable' });
    delete order.money;
    return (
      <OrderPattern id={order.id}>
        <OrderPage order={order} />
      </OrderPattern>
    );
  },
  async play({ canvasElement }) {
    const canvas = await orderMain(canvasElement);
    await canvas.findByRole('heading', { name: m.order_paid(), level: 1 });
    await canvas.findByText(m.order_paid_total_unavailable());
    await canvas.findByText(m.order_tax_unavailable());
    await canvas.findByText(m.order_entitlement_unavailable());
    await receiptDetails(canvasElement, paidRecording.order.id);
  },
};

export const MappedCurrentUse: Story = {
  name: 'Buyer, current fixed edition use (constructed responses)',
  beforeEach() {
    setMappedCheckoutStory(true);
    setEntitlementStoryMode('mapped');
    return () => {
      setMappedCheckoutStory(false);
      setEntitlementStoryMode('active');
    };
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: m.benefit_open_reader() });
    await canvas.findByText(m.order_entitlement_active());
  },
};

export const MappedRefundedPage: Story = {
  name: 'Buyer, paid receipt with refunded access (constructed responses)',
  beforeEach() {
    setMappedCheckoutStory(true);
    setEntitlementStoryMode('mapped-refunded');
    return () => {
      setMappedCheckoutStory(false);
      setEntitlementStoryMode('active');
    };
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.order_paid(), level: 1 });
    await canvas.findByText(m.order_entitlement_revoked());
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};

function ReconciliationPreview({ send }: { send: ReconciliationSender }) {
  const order = pendingRecording.order;
  return (
    <OrderPattern id={order.id}>
      <OrderPage
        order={{
          ...order,
          settlement: 'pending',
          canReconcile: true,
          entitlement: { kind: 'none' },
          subject: subjectCover(getLocale(), order.targetSubjectId, order.title, order.subject),
        }}
        reconcile={send}
      />
    </OrderPattern>
  );
}

// These operation-shaped component examples preserve the recorded pending order;
// their queued response establishes neither payment nor benefit authority.
// Refunded, long-receipt, unknown settlement/money, current-access and reconciliation
// actual-route cases wait on Commerce producer-owned matching responses.
export const ReconciliationQueued: Story = {
  name: 'Signed in, explicit status check queued (component)',
  render: () => (
    <ReconciliationPreview send={async ({ orderId }) => ({ kind: 'queued', orderId, reconciliation: 'queued' })} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = await orderMain(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.order_reconcile_action() }));
    await canvas.findByText(m.order_reconcile_queued());
    expect(canvas.queryByText(m.order_paid())).toBeNull();
  },
};
export const ReconciliationUnavailable: Story = {
  name: 'Signed in, status check unavailable (component)',
  render: () => <ReconciliationPreview send={async () => ({ kind: 'unavailable' })} />,
  play: async ({ canvasElement }) => {
    const canvas = await orderMain(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.order_reconcile_action() }));
    await canvas.findByText(m.order_reconcile_unavailable());
  },
};
export const ReconciliationDenied: Story = {
  name: 'Signed in, status check permission changed (component)',
  render: () => <ReconciliationPreview send={async () => ({ kind: 'denied' })} />,
  play: async ({ canvasElement }) => {
    const canvas = await orderMain(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.order_reconcile_action() }));
    await canvas.findByText(m.order_reconcile_denied());
  },
};
export const ReconciliationRetry: Story = {
  name: 'Signed in, lost status-check response and retry (component)',
  render: () => {
    let first = true;
    return (
      <ReconciliationPreview
        send={async ({ orderId }) => {
          if (first) {
            first = false;
            throw new Error('Response lost');
          }
          return { kind: 'queued', orderId, reconciliation: 'queued' };
        }}
      />
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = await orderMain(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.order_reconcile_action() }));
    await canvas.findByText(m.order_reconcile_error());
    await userEvent.click(await canvas.findByRole('button', { name: m.order_reconcile_retry() }));
    await canvas.findByText(m.order_reconcile_queued());
  },
};

export const MappedFixedEdition: Story = {
  name: 'Buyer, paid fixed edition and access record',
  beforeEach() {
    setMappedCheckoutStory(true);
    return () => setMappedCheckoutStory(false);
  },
  render: () => <PageStory visitor="Signed In" path={pagePaths['order-paid']} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { name: m.benefit_heading() });
    const link = await canvas.findByRole('link', { name: m.entitlements_detail_heading() });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/entitlements/${paidRecording.order.entitlementId}`);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
