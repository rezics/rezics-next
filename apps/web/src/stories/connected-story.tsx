import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Preview } from '@storybook/react-vite';
import { InboxAmbientProvider } from '../inbox/adapters/ambient-view.tsx';
import { SettingsAmbientProvider } from '../settings/adapters/ambient-view.tsx';
import { createPerformanceAmbient } from '../session/performance-ambient';
import { RecentSearchBinding } from '../session/recent-search-binding';
import { PageVisitBinding } from '../subject/page-visit-binding';

function StoryQueryClient({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } }));
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function StoryPerformanceAmbient({ children }: { children: ReactNode }) {
  const [ambient] = useState(createPerformanceAmbient);
  return (
    <SettingsAmbientProvider ambient={ambient.settings}>
      <InboxAmbientProvider ambient={ambient.inbox}>
        <RecentSearchBinding>
          <PageVisitBinding>{children}</PageVisitBinding>
        </RecentSearchBinding>
      </InboxAmbientProvider>
    </SettingsAmbientProvider>
  );
}

/** Supply missing query context and preview hosts; nested story providers retain their own state. */
export function ConnectedStory({ storyId, children }: { storyId: string; children: ReactNode }) {
  const client = useContext(QueryClientContext);
  const tree = <StoryPerformanceAmbient>{children}</StoryPerformanceAmbient>;
  return client ? tree : <StoryQueryClient key={storyId}>{tree}</StoryQueryClient>;
}

export const connectedStoryProviders = {
  decorators: [
    (Story, context) => (
      <ConnectedStory storyId={context.id}>
        <Story />
      </ConnectedStory>
    ),
  ],
} satisfies Preview;
