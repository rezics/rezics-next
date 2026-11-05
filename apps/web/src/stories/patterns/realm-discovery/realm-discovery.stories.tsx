import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  RealmDiscoverySection,
  type RealmDiscoveryCard,
  type RealmDiscoveryState,
} from '../../../community/realm-discovery';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
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
    await expect(await view.findByRole('link', { name: discoveryRealm.name })).toHaveAttribute(
      'href',
      expect.stringContaining(`/realms/${discoveryRealm.realmId}`),
    );
    await expect(view.getByText(discoveryRealm.description)).toBeVisible();
  },
};
export const Image: Story = { render: () => <DiscoveryFixture variant="image" /> };
export const Initials: Story = { render: () => <DiscoveryFixture variant="initials" sort="trending" /> };
const composedAvatarRealm: RealmDiscoveryCard = {
  ...discoveryRealm,
  name: 'Community gardeners',
  description: 'Share local growing advice and seasonal harvests.',
  avatar: {
    id: '0192f3a0-6c1e-7b2a-a003-000000000001',
    containerId: discoveryRealm.realmId,
    digest: 'b'.repeat(64),
    width: 320,
    height: 240,
    variants: [
      { format: 'avif', width: 96, height: 72 },
      { format: 'webp', width: 160, height: 120 },
    ],
    placeholder: { thumbhash: 'authored-placeholder', color: '#c7d9c1' },
    focalPoint: { x: 0.25, y: 0.75 },
    credit: {
      rightsHolder: 'Community contributor',
      via: { name: 'Commons source', url: 'https://commons.wikimedia.org/wiki/File:Garden.jpg' },
      license: 'CC BY-SA 4.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
    },
  },
};
const initialsRealm: RealmDiscoveryCard = {
  ...discoveryRealm,
  realmId: '0192f3a0-6c1e-7b2a-a004-000000000001',
  spaceId: '0192f3a0-6c1e-7b2a-a004-000000000002',
  name: 'Open Gardeners',
  description: '',
  avatar: null,
};
const composedRealms = [composedAvatarRealm, initialsRealm] as const;

function ComposedRowsFixture() {
  const [state, setState] = useState<RealmDiscoveryState>({
    kind: 'ready',
    realms: composedRealms,
    next: 'story-continuation',
  });
  return (
    <div className="mx-auto w-full max-w-xl p-4 sm:p-6">
      <RealmDiscoverySection
        sort="popular"
        state={state}
        locale={getLocale()}
        onNext={() => setState({ kind: 'unavailable' })}
        onRetry={() => setState({ kind: 'ready', realms: composedRealms, next: null })}
      />
    </div>
  );
}

export const ComposedRows: Story = {
  render: () => <ComposedRowsFixture />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const primary = await view.findByRole('link', { name: composedAvatarRealm.name });
    await expect(primary).toHaveAttribute('href', expect.stringContaining(`/realms/${composedAvatarRealm.realmId}`));
    await expect(view.getByText(composedAvatarRealm.description)).toBeVisible();
    await expect(view.getByRole('link', { name: 'Commons source' })).toHaveAttribute(
      'href',
      'https://commons.wikimedia.org/wiki/File:Garden.jpg',
    );
    await expect(view.getByText('CC BY-SA 4.0')).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="realm-discovery-initials"]')).toHaveTextContent('OG');
    await expect(await view.findByRole('link', { name: initialsRealm.name })).toBeVisible();

    await userEvent.click(view.getByRole('button', { name: m.realm_discovery_continue() }));
    await expect(await view.findByText(m.realm_discovery_unavailable())).toBeVisible();
    await userEvent.click(view.getByRole('button', { name: m.realm_discovery_retry() }));
    await expect(await view.findByRole('link', { name: composedAvatarRealm.name })).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_discovery_continue() })).toBeNull();
  },
};
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
