import { QueryClient, QueryClientContext, QueryClientProvider } from '@tanstack/react-query';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import type { Preview } from '@storybook/react-vite';

function StoryQueryClient({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000 } } }));
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Supply only missing query context. Story-owned providers and their prepared/error states take precedence. */
export function ConnectedStory({ storyId, children }: { storyId: string; children: ReactNode }) {
  const client = useContext(QueryClientContext);
  return client ? children : <StoryQueryClient key={storyId}>{children}</StoryQueryClient>;
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
