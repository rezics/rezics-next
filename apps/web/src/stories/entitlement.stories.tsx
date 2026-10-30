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
import { EntitlementPage } from '../checkout/entitlement-page';
import { ContentEditionPage } from '../content-editions/edition-view';
import { benefitReaderHref, capturedBenefit } from '../checkout/benefit';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, PatternStory } from './page';

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

export const Active: Story = {
  render: () => <EntitlementStory mode="active" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_delivery_unknown());
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
    await within(context.canvasElement).findByText(/\(refund\)/);
  },
};
export const AnotherAccountDenied: Story = { render: () => <EntitlementStory mode="denied" />, play: ready };
export const LegacyUnknownMapping: Story = { render: () => <EntitlementStory mode="legacy" />, play: ready };
export const Unavailable: Story = { render: () => <EntitlementStory mode="unavailable" />, play: ready };
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
export const LongTitles: Story = { render: () => <EntitlementStory mode="long" />, play: ready };

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
  },
};
export const MappedRefunded: Story = {
  render: () => <EntitlementStory mode="mapped-refunded" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.entitlements_revoked());
    await canvas.findByText(/\(refund\)/);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
export const MappedDisputed: Story = {
  render: () => <EntitlementStory mode="mapped-disputed" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(/\(dispute\)/);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
export const ReaderUnavailable: Story = {
  name: 'Active capture, reader unavailable (component)',
  render: () => (
    <PatternStory visitor="Signed In" path={`/entitlements/${mappedEntitlement.id}`}>
      <div className="space-y-12">
        <EntitlementPage page={{ kind: 'ready', data: mappedEntitlement }} locale={getLocale()} />
        <ContentEditionPage
          editionId={fixedEditionTerms.benefit.resource.id}
          page={{ state: 'unavailable', status: 503, reason: 'source' }}
        />
      </div>
    </PatternStory>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByText(m.benefit_reader_notice());
    await canvas.findByText(m.content_edition_unavailable());
    await expect(canvasElement.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
