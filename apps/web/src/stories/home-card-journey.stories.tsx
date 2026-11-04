import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { reactionKinds } from '@rezics/ui/reactions';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import { getLocale } from '../paraglide/runtime.js';

const id = '00000000-0000-7000-8000-000000000419';
const title = 'Prepared public review';
const target = { targetKind: 'thread' as const, targetId: id };
const item: FeedItem = {
  id: 'prepared:review', source: 'discovery', occurredAt: null,
  key: { owner: 'content', kind: 'review', route: 0, id },
  summary: {
    id, kind: 'review', title, author: { displayName: 'Marisol-Fernández de la Cruz · 長谷川 鈴木', handle: 'reader' },
    excerpt: 'A public review with disclosed reaction counts.', reactionTarget: target, reactions: { like: 3, love: 1 },
    viewerReaction: 'love', reactionAdvice: { target, state: 'current', allowed: reactionKinds },
  },
  destination: { kind: 'thread', id, title },
};
const result = {
  state: 'ready' as const,
  page: {
    feedItems: [item], next: null, asOf: '2026-11-04T00:00:00Z',
    sources: { following: 'not_requested', discovery: 'ready', continue: 'not_requested' },
    reactionsAsOf: { epoch: 1, position: '1' },
  } satisfies FeedPage,
};

function Journey() {
  const client = useMemo(() => {
    const value = new QueryClient();
    value.setQueryData(['session'], { state: 'signed-in', subject: 'prepared-reader', csrfToken: 'prepared-csrf' });
    return value;
  }, []);
  return <QueryClientProvider client={client}><HomeFeed result={result} locale={getLocale()} signedIn /></QueryClientProvider>;
}

const meta = {
  title: 'Pages/Discovery/Home card action journey (prepared)', component: Journey,
  parameters: { layout: 'fullscreen', viewport: { options: {
    phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
    desktop1440: { name: 'Desktop 1440', styles: { width: '1440px', height: '900px' } },
  } } },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const JourneyPhone: Story = { globals: { viewport: { value: 'phone390' }, theme: 'light', locale: 'en' } };
