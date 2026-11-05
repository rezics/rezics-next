import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import { getLocale } from '../paraglide/runtime.js';

const space = (id: string, address: string, realm?: { id: string; title: string | null } | null): FeedItem => ({
  id: `discovery:content:${id}`,
  source: 'discovery',
  occurredAt: null,
  key: { owner: 'content', kind: 'space', route: 0, id },
  summary: { id, title: 'Reading room', address, summary: '', ...(realm === undefined ? {} : { realm }) },
  destination: { kind: 'space', id, title: 'Reading room', address },
});

const realmId = '00000000-0000-7000-8000-000000000021';
const page: FeedPage = {
  feedItems: [
    space('00000000-0000-7000-8000-000000000011', 'atlas-reading-room', { id: realmId, title: 'Atlas' }),
    space('00000000-0000-7000-8000-000000000012', 'carrier-not-selected'),
    space('00000000-0000-7000-8000-000000000013', 'no-carrier', null),
    space('00000000-0000-7000-8000-000000000014', 'title-withheld', { id: realmId, title: null }),
    space('00000000-0000-7000-8000-000000000015', 'empty-title', { id: realmId, title: '' }),
  ],
  next: null,
  asOf: '2026-11-04T00:00:00Z',
  sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
};

function SpaceCarrierReading() {
  return <HomeFeed result={{ state: 'ready', page }} locale={getLocale()} />;
}

const meta = {
  title: 'Pages/Discovery/Home Space carrier reading',
  component: SpaceCarrierReading,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof SpaceCarrierReading>;
export default meta;
type Story = StoryObj<typeof meta>;
export const DisclosedCarrierAndMissingFacts: Story = {};
