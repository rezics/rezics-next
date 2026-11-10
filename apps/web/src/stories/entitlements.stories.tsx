import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { EntitlementsPage } from '../checkout/entitlements-page';
import {
  activeEntitlement,
  setEntitlementStoryMode,
  type EntitlementStoryMode,
  type MappedEntitlementStoryMode,
} from '../kernel/fake/entitlements';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory } from './page';

const meta = {
  title: 'Commerce/Entitlements',
  id: 'pages-commerce-entitlements',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function EntitlementsStory({
  mode,
  path = '/entitlements',
}: {
  mode: EntitlementStoryMode | MappedEntitlementStoryMode;
  path?: string;
}) {
  setEntitlementStoryMode(mode);
  return <PageStory visitor="Signed In" path={path} />;
}
const ready = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await within(canvasElement).findByRole('heading', { level: 1, name: m.entitlements_heading() });
};

export const Active: Story = {
  render: () => <EntitlementsStory mode="active" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    const link = await canvas.findByRole('link', { name: m.entitlements_open({ title: 'The Little Prince' }) });
    await expect(link).toHaveAttribute('href', `/${getLocale()}/entitlements/${activeEntitlement.id}`);
    await userEvent.tab();
    await expect(await canvas.findByRole('link', { name: m.entitlements_next() })).toHaveAttribute(
      'href',
      `/${getLocale()}/entitlements?cursor=story-signed-cursor`,
    );
  },
};
export const Revoked: Story = { render: () => <EntitlementsStory mode="revoked" />, play: ready };
export const LegacyUnknownMapping: Story = { render: () => <EntitlementsStory mode="legacy" />, play: ready };
export const Empty: Story = {
  render: () => <EntitlementsStory mode="empty" />,
  async play({ canvasElement }) {
    await within(canvasElement).findByText(m.entitlements_empty());
  },
};
export const AnotherAccountDenied: Story = {
  render: () => <EntitlementsStory mode="denied" />,
  async play({ canvasElement }) {
    await within(canvasElement).findByText(m.entitlements_denied());
  },
};
export const Unavailable: Story = {
  render: () => <EntitlementsStory mode="unavailable" />,
  async play({ canvasElement }) {
    await within(canvasElement).findByText(m.entitlements_unavailable());
  },
};
export const Retry: Story = {
  render: () => <EntitlementsStory mode="retry" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.entitlements_retry() }));
    await canvas.findByText(m.entitlements_active());
    await expect(canvas.queryByText(m.entitlements_unavailable())).not.toBeInTheDocument();
  },
};
export const Preparing: Story = { render: () => <EntitlementsStory mode="preparing" />, play: ready };
export const StaleCursor: Story = { render: () => <EntitlementsStory mode="cursor-error" />, play: ready };
export const LongTitles: Story = { render: () => <EntitlementsStory mode="long" />, play: ready };
// UNRUN: later-page recovery uses the existing bounded route fixture; visual/native proof is deferred.
export const LaterPageEmpty: Story = {
  render: () => <EntitlementsStory mode="empty" path="/entitlements?cursor=story-signed-current" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.entitlements_page_empty())).toBeVisible();
    await expect(canvas.queryByText(m.entitlements_empty())).toBeNull();
    await expect(canvas.getByRole('link', { name: m.entitlements_restart() })).toHaveAttribute(
      'href',
      `/${getLocale()}/entitlements`,
    );
    await expect(canvas.queryByRole('link', { name: m.entitlements_next() })).toBeNull();
  },
};
export const LaterPageEmptyWithNext: Story = {
  // Explicit contract-shaped sparse response, rather than invented additional native history.
  render: () => (
    <main className="min-h-screen min-w-0 bg-background p-4 sm:p-8">
      <EntitlementsPage
        page={{ kind: 'ready', data: { entitlements: [], next: 'story-signed/+?=next' } }}
        locale={getLocale()}
        continuation
      />
    </main>
  ),
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(m.entitlements_page_empty())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.entitlements_restart() })).toHaveAttribute(
      'href',
      `/${getLocale()}/entitlements`,
    );
    await expect(canvas.getByRole('link', { name: m.entitlements_next() })).toHaveAttribute(
      'href',
      `/${getLocale()}/entitlements?cursor=${encodeURIComponent('story-signed/+?=next')}`,
    );
  },
};
export const LongTitlesContinuation: Story = {
  render: () => <EntitlementsStory mode="long" path="/entitlements?cursor=story-signed-current" />,
  play: ready,
};
export const MappedFixedEdition: Story = {
  render: () => <EntitlementsStory mode="mapped" />,
  async play(context) {
    await ready(context);
    const canvas = within(context.canvasElement);
    await canvas.findByText(m.benefit_heading());
    await expect(
      canvas.getByRole('link', { name: m.entitlements_open({ title: 'The Little Prince' }) }),
    ).toHaveAttribute('href', `/${getLocale()}/entitlements/${activeEntitlement.id}`);
    await expect(canvas.queryByRole('link', { name: m.benefit_open_reader() })).toBeNull();
  },
};
