import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmDiscoverySection } from '../../../community/realm-discovery';
import { m } from '../../../paraglide/messages.js';
import { DiscoveryFixture, discoveryRealm } from './fixtures';

const meta = {
  title: 'Patterns/Community/Realm Discovery',
  component: RealmDiscoverySection,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof RealmDiscoverySection>;
export default meta;
type Story = StoryObj;

export const Available: Story = {
  render: () => <DiscoveryFixture />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(
      await view.findByRole('link', { name: `${discoveryRealm.name} ${discoveryRealm.description}` }),
    ).toHaveAttribute('href', expect.stringContaining(`/realms/${discoveryRealm.realmId}`));
  },
};
export const Image: Story = { render: () => <DiscoveryFixture variant="image" /> };
export const Initials: Story = { render: () => <DiscoveryFixture variant="initials" sort="trending" /> };
export const Sparse: Story = {
  render: () => <DiscoveryFixture variant="sparse" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.realm_discovery_page_empty())).toBeVisible();
    await expect(view.queryByRole('link')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_discovery_continue() }));
    await expect(await view.findByText(discoveryRealm.name)).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_discovery_continue() })).toBeNull();
  },
};
export const Empty: Story = { render: () => <DiscoveryFixture variant="empty" /> };
export const Loading: Story = { render: () => <DiscoveryFixture variant="loading" /> };
export const Unavailable: Story = {
  render: () => <DiscoveryFixture variant="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.realm_discovery_unavailable())).toBeVisible();
    await expect(view.queryByRole('link')).toBeNull();
    await userEvent.click(view.getByRole('button', { name: m.realm_discovery_retry() }));
    await expect(await view.findByText(discoveryRealm.name)).toBeVisible();
    await expect(view.queryByText(m.realm_discovery_unavailable())).toBeNull();
    await expect(view.queryByText(m.realm_discovery_empty())).toBeNull();
  },
};
export const Closed: Story = {
  render: () => <DiscoveryFixture variant="closed" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.realm_discovery_closed())).toBeVisible();
    await expect(view.queryByRole('link')).toBeNull();
    await expect(view.queryByRole('button')).toBeNull();
  },
};
