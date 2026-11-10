import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedPage } from '../features/pages/home-feed-read';
import { discoveryCollectionCard } from '../kernel/fake/discovery-collection-card';
import { getLocale } from '../paraglide/runtime.js';

const id = '00000000-0000-7000-8000-000000000001';
const spaceId = '00000000-0000-7000-8000-000000000002';
const page: FeedPage = {
  feedItems: [
    {
      id: 'collection:1',
      source: 'discovery',
      occurredAt: null,
      key: { owner: 'commerce', kind: 'collection', route: 0, id },
      summary: {
        id,
        title: 'Books to revisit',
        description: 'A small selection for slow reading.',
        card: discoveryCollectionCard({
          id,
          title: 'Books to revisit',
          description: 'A small selection for slow reading.',
        }),
      },
      destination: { kind: 'collection', id, title: 'Books to revisit' },
    },
    {
      id: 'space:1',
      source: 'discovery',
      occurredAt: null,
      key: { owner: 'content', kind: 'space', route: 0, id: spaceId },
      summary: { id: spaceId, title: 'Reading room', address: 'reading-room', summary: '', realm: null },
      destination: { kind: 'space', id: spaceId, title: 'Reading room', address: 'reading-room' },
    },
  ],
  next: null,
  asOf: '2026-11-04T00:00:00Z',
  sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
};

function PublicOwners({ prepared = false }: { prepared?: boolean }) {
  const [stream, setStream] = useState<'home' | 'following'>('home');
  return (
    <div className="p-4">
      <HomeFeed
        result={{ state: 'ready', page }}
        locale={getLocale()}
        signedIn={prepared}
        stream={stream}
        onSelect={setStream}
      />
    </div>
  );
}
const meta = {
  title: 'Discovery/Home public owners',
  id: 'pages-discovery-home-public-owners',
  component: PublicOwners,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof PublicOwners>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Anonymous: Story = {};
export const PreparedPrivateStateUnavailable: Story = { args: { prepared: true } };
