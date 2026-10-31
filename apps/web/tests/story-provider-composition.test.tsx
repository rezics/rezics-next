import { expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { composeStory } from '@storybook/react-vite';
import { ConnectedStory, connectedStoryProviders } from '../src/stories/connected-story';
import { setLocale } from '../src/paraglide/runtime.js';

// Use the same runtime adapters as the local Storybook, without a native service or kernel substitute.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));

const history = await import('../src/stories/search-history.stories');
const subject = await import('../src/stories/subject.stories');

test('Connected Storybook examples render their named state through real default providers', () => {
  setLocale('en', { reload: false });
  const LocalQueries = composeStory(history.LocalQueries, history.default, connectedStoryProviders, 'LocalQueries');
  const ImportedScores = composeStory(
    subject.ImportedScores,
    subject.default,
    connectedStoryProviders,
    'ImportedScores',
  );

  const local = renderToStaticMarkup(<LocalQueries />);
  expect(local).toContain('Kokoro');
  expect(local).toContain('Remove Kokoro');
  const imported = renderToStaticMarkup(<ImportedScores />);
  expect(imported).toContain('Clannad');
  expect(imported).toContain('VNDB');
  expect(imported).toContain('8.4');
  expect(imported).toContain('267');

  const clients: QueryClient[] = [];
  function ObserveClient() {
    clients.push(useQueryClient());
    return null;
  }
  const owned = new QueryClient();
  owned.setQueryData(['prepared'], 'deliberate story state');
  renderToStaticMarkup(
    <ConnectedStory storyId="first">
      <ObserveClient />
    </ConnectedStory>,
  );
  renderToStaticMarkup(
    <ConnectedStory storyId="second">
      <ObserveClient />
    </ConnectedStory>,
  );
  renderToStaticMarkup(
    <QueryClientProvider client={owned}>
      <ConnectedStory storyId="owned">
        <ObserveClient />
      </ConnectedStory>
    </QueryClientProvider>,
  );
  renderToStaticMarkup(
    <ConnectedStory storyId="nested">
      <QueryClientProvider client={owned}>
        <ObserveClient />
      </QueryClientProvider>
    </ConnectedStory>,
  );
  expect(clients[0]).not.toBe(clients[1]);
  expect(clients.slice(2)).toEqual([owned, owned]);
  expect(owned.getQueryData(['prepared'])).toBe('deliberate story state');
  for (const client of clients) client.clear();
});
