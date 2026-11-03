import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  activeEntitlement,
  mappedEntitlement,
  fixedEditionTerms,
  setEntitlementStoryMode,
  type EntitlementStoryMode,
  type MappedEntitlementStoryMode,
} from '../kernel/fake/entitlements';
import {
  resetEntitlementReaderUnavailable,
  setEntitlementReaderUnavailableEditionId,
} from '../kernel/fake/entitlement-reader-unavailable';
import { benefitReaderHref, capturedBenefit } from '../checkout/benefit';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';

const meta = {
  title: 'Pages/Commerce/Entitlement',
  parameters: {
    layout: 'fullscreen',
    viewport: {
      viewports: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function EntitlementStory({ mode }: { mode: EntitlementStoryMode | MappedEntitlementStoryMode }) {
  setEntitlementStoryMode(mode);
  return <PageStory visitor="Signed In" path={`/entitlements/${activeEntitlement.id}`} />;
}
const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  const canvas = within(canvasElement);
  await canvas.findByRole('heading', { level: 1, name: m.entitlements_detail_heading() });
};

// Authored disclosure interactions remain UNRUN at this source boundary.
async function accessDetails(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole('link', { name: m.order_receipt() })).toHaveAttribute(
    'href',
    `/${getLocale()}/orders/${activeEntitlement.orderId}`,
  );
  const summary = await canvas.findByText(m.entitlements_technical_details());
  const details = summary.closest('details')!;
  await expect(details).not.toHaveAttribute('open');
  await expect(within(details).getByText(activeEntitlement.orderId)).not.toBeVisible();
  summary.focus();
  await userEvent.keyboard('{Enter}');
  await expect(details).toHaveAttribute('open');
  await expect(within(details).getByRole('link', { name: activeEntitlement.orderId })).toHaveAttribute(
    'href',
    `/${getLocale()}/orders/${activeEntitlement.orderId}`,
  );
}

export const Active: Story = {
  render: () => <EntitlementStory mode="active" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_delivery_unknown());
    await accessDetails(context.canvasElement);
    await expect(canvas.getByRole('link', { name: activeEntitlement.orderId })).toHaveAttribute(
      'href',
      `/${getLocale()}/orders/${activeEntitlement.orderId}`,
    );
    await expect(canvas.queryByRole('button', { name: /download|use/i })).not.toBeInTheDocument();
  },
};
export const RefundedWithPaidOrder: Story = {
  render: () => <EntitlementStory mode="revoked" />,
  async play(context) {
    await ready(context);
    await within(context.canvasElement).findByText(m.entitlements_revoked());
    await within(context.canvasElement).findByText(m.entitlements_refund_consequence());
    await accessDetails(context.canvasElement);
    await within(context.canvasElement).findByText(/\(refund\)/);
  },
};
export const AnotherAccountDenied: Story = { render: () => <EntitlementStory mode="denied" />, play: ready };
export const LegacyUnknownMapping: Story = {
  render: () => <EntitlementStory mode="legacy" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.benefit_details_unknown());
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
    await accessDetails(context.canvasElement);
  },
};
export const Unavailable: Story = {
  render: () => <EntitlementStory mode="unavailable" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_unavailable());
    await canvas.findByRole('button', { name: m.entitlements_retry() });
    await expect(canvas.queryByText(m.entitlements_technical_details())).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.order_receipt() })).toBeNull();
  },
};
export const Preparing: Story = {
  render: () => <EntitlementStory mode="preparing" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_preparing());
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
    await expect(canvas.queryByText(m.entitlements_technical_details())).toBeNull();
  },
};
export const Retry: Story = {
  render: () => <EntitlementStory mode="retry" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.entitlements_retry() });
    retry.focus();
    await userEvent.keyboard('{Enter}');
    await canvas.findByText(m.entitlements_active());
  },
};
export const LongTitles: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <EntitlementStory mode="long" />,
  async play(context) {
    await ready(context);
    await within(context.canvasElement).findByText(m.benefit_details_unknown());
    await accessDetails(context.canvasElement);
  },
};

export const MappedFixedEdition: Story = {
  render: () => <EntitlementStory mode="mapped" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    const link = await canvas.findByRole('link', { name: m.benefit_open_reader() });
    await expect(link).toHaveAttribute(
      'href',
      benefitReaderHref(capturedBenefit(fixedEditionTerms, mappedEntitlement.targetSubjectId), true, getLocale()),
    );
    for (let step = 0; step < 45 && document.activeElement !== link; step++) await userEvent.tab();
    await expect(link).toHaveFocus();
    await accessDetails(context.canvasElement);
  },
};
export const MappedRefunded: Story = {
  render: () => <EntitlementStory mode="mapped-refunded" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_revoked());
    await canvas.findByText(m.entitlements_refund_consequence());
    await accessDetails(context.canvasElement);
    await canvas.findByText(/\(refund\)/);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
export const MappedDisputed: Story = {
  render: () => <EntitlementStory mode="mapped-disputed" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_dispute_consequence());
    await accessDetails(context.canvasElement);
    await canvas.findByText(/\(dispute\)/);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
export const ReaderUnavailable: Story = {
  name: 'Mapped entitlement opens unavailable reader',
  beforeEach: () => {
    setEntitlementReaderUnavailableEditionId(fixedEditionTerms.benefit.resource.id);
    return resetEntitlementReaderUnavailable;
  },
  render: () => <EntitlementStory mode="mapped" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: m.benefit_open_reader() });
    await expect(link).toHaveAttribute(
      'href',
      benefitReaderHref(capturedBenefit(fixedEditionTerms, mappedEntitlement.targetSubjectId), true, getLocale()),
    );
    await userEvent.click(link);
    await canvas.findByRole('heading', { level: 1, name: m.content_edition_heading() });
    await canvas.findByText(m.content_edition_unavailable());
    await expect(canvas.queryByRole('heading', { level: 1, name: m.entitlements_detail_heading() })).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.order_receipt() })).toBeNull();
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
