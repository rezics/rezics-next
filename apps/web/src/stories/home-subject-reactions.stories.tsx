import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { HomeFeed } from '../features/pages/home-feed';
import type { FeedItem, FeedPage } from '../features/pages/home-feed-read';
import { getLocale } from '../paraglide/runtime.js';
import { homeFeedStoryPage } from '../kernel/fake/home-feed-stories';

type Scenario = 'selected' | 'signed-out' | 'unavailable';

function HomeSubjectReactionStory({ scenario }: { scenario: Scenario }) {
  const [retryCount, setRetryCount] = useState(0);
  const client = useMemo(() => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      ['session'],
      scenario === 'signed-out'
        ? { state: 'signed-out', subject: null, csrfToken: null }
        : { state: 'signed-in', subject: 'feed-story-reader', csrfToken: 'feed-story-csrf' },
    );
    return queryClient;
  }, [scenario]);
  const result = useMemo(() => {
    const recorded = homeFeedStoryPage();
    const source = recorded.feedItems.find((item) => item.destination.kind === 'subject')!;
    const id = source.destination.kind === 'subject' ? source.destination.id : '';
    const subjectReactions =
      scenario === 'unavailable'
        ? {
            target: { targetKind: 'subject', targetId: id },
            counts: { state: 'unavailable' },
            viewer: { state: 'unavailable' },
            action: 'unavailable',
          }
        : {
            target: { targetKind: 'subject', targetId: id },
            counts: {
              state: 'available',
              values: { like: 12, love: 5, laugh: 2, insightful: 4, sad: 1 },
              asOf: { epoch: 1, position: '18' },
            },
            ...(scenario === 'signed-out' ? {} : { viewer: { state: 'available', kind: 'love' } }),
            action: scenario === 'signed-out' ? 'sign_in' : 'allowed',
          };
    const summary = { ...source.summary, subjectReactions } as unknown as typeof source.summary;
    const row = { ...source, summary } as FeedItem;
    return {
      state: 'ready' as const,
      page: { ...recorded, feedItems: [row] } as FeedPage,
    };
  }, [scenario]);
  return (
    <QueryClientProvider client={client}>
      <div className="space-y-3 p-4">
        {scenario === 'unavailable' ? <output aria-live="polite">Retry requests: {retryCount}</output> : null}
        <HomeFeed
          result={result}
          locale={getLocale()}
          signedIn={scenario !== 'signed-out'}
          {...(scenario === 'unavailable' ? { onRetry: () => setRetryCount((count) => count + 1) } : {})}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Discovery/Home Subject reactions',
  id: 'pages-discovery-home-subject-reactions',
  component: HomeSubjectReactionStory,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
    docs: {
      description: {
        component:
          'Feed-local Subject reaction states rendered through the established Home story provider and its recorded native owner summaries.',
      },
    },
  },
} satisfies Meta<typeof HomeSubjectReactionStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedInSelected: Story = {
  args: { scenario: 'selected' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
};
export const SignedOut: Story = {
  args: { scenario: 'signed-out' },
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
};
export const ProjectionUnavailable: Story = {
  args: { scenario: 'unavailable' },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
};
