import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { activeEntitlement, setEntitlementStoryMode, type EntitlementStoryMode } from '../kernel/fake/entitlements';
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

function EntitlementStory({ mode }: { mode: EntitlementStoryMode }) {
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
