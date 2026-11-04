import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HomeFeed, HomeFeedConsumer } from '../src/features/pages/home-feed';
import { homeFeedDestination } from '../src/features/pages/home-feed-destination';
import {
  HOME_FEED_HISTORY_KEY,
  type FeedInput,
  type FeedItem,
  type FeedPage,
  type HomeFeedResult,
} from '../src/features/pages/home-feed-read';
import { locales, setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

const id = '00000000-0000-7000-8000-000000000001';
const spaceId = '00000000-0000-7000-8000-000000000002';
const collection: FeedItem = {
  id: 'collection:1',
  source: 'discovery',
  occurredAt: null,
  key: { owner: 'commerce', kind: 'collection', route: 0, id },
  summary: { id, title: 'Curated books', description: 'A careful selection <script>.' },
  destination: { kind: 'collection', id, title: 'Curated books' },
};
const space: FeedItem = {
  id: 'space:1',
  source: 'discovery',
  occurredAt: null,
  key: { owner: 'content', kind: 'space', route: 0, id: spaceId },
  summary: { id: spaceId, title: 'Reading room', address: 'reading-room', summary: '', realm: null },
  destination: { kind: 'space', id: spaceId, title: 'Reading room', address: 'reading-room' },
};
const result = (feedItems = [collection, space]) => ({
  state: 'ready' as const,
  page: {
    feedItems,
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
  } satisfies FeedPage,
});

test('Home public owners keep supplied text, empty and unavailable context, exact links and no inferred follow actions in every locale', () => {
  for (const locale of locales) {
    setLocale(locale, { reload: false });
    const anonymous = renderToStaticMarkup(<HomeFeed result={result()} locale={locale} />);
    expect(anonymous).toContain('A careful selection &lt;script&gt;.');
    expect(anonymous).toContain('data-owner-description="empty"');
    expect(anonymous).toContain(`/${locale}/spaces/reading-room`);
    expect(anonymous).toContain(m.home_owner_carrier_none({}, { locale }));
    expect(anonymous).toContain(m.home_owner_follow_context({}, { locale }));
    expect(anonymous).not.toContain(m.library_follow_unavailable({}, { locale }));
    const prepared = renderToStaticMarkup(<HomeFeed result={result()} locale={locale} signedIn />);
    expect(prepared).toContain(m.library_follow_unavailable({}, { locale }));
    expect(prepared).not.toContain('data-slot="follow-control"');
    expect(prepared.indexOf('data-feed-id="collection:1"')).toBeLessThan(prepared.indexOf('data-feed-id="space:1"'));
  }
  setLocale('en', { reload: false });
  const unavailable = { ...collection, summary: { ...collection.summary, description: null } };
  expect(renderToStaticMarkup(<HomeFeed result={result([unavailable])} locale="en" />)).toContain(
    'data-owner-description="unavailable"',
  );
  const replaced = { ...collection, destination: { kind: 'collection' as const, id: spaceId, title: 'Replacement' } };
  expect(homeFeedDestination(replaced, 'en')).toBeUndefined();
  expect(renderToStaticMarkup(<HomeFeed result={result([replaced])} locale="en" />)).not.toContain(
    `/collections/${spaceId}`,
  );
});

test('mounted Home controls restore the exact owner return selection and same cursor on retry', async () => {
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'current' });
  const input: FeedInput = {
    stream: 'following',
    kind: 'collection',
    spaceId,
    ratingQuestionId: id,
    cursor: 'exact-native-frontier',
  };
  const descriptor = { version: 1, origin: 'https://site.test', pathname: '/en/', locale: 'en', input };
  window.history.replaceState({ [HOME_FEED_HISTORY_KEY]: descriptor, retained: 'entry' }, '', '/en/');
  const reads: FeedInput[] = [];
  const read = async (value: FeedInput): Promise<HomeFeedResult> => {
    reads.push(value);
    return reads.length === 1 ? { state: 'unavailable', code: 'dependency_unavailable' } : result();
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <HomeFeedConsumer
            initial={result()}
            locale="en"
            signedIn
            origin="https://site.test"
            read={read}
            readKinds={async () => ({ status: 'unavailable' })}
            readSpace={async () => ({
              status: 'ready',
              space: { spaceId, realmId: id, headRevisionId: id, title: 'Room', address: 'reading-room' },
            })}
            readQuestions={async () => ({ status: 'unavailable', code: 'unavailable' })}
            readQuestion={async () => ({
              status: 'ready',
              question: {
                id,
                revision: 1,
                label: 'Overall',
                grain: 'work',
                scale: { min: 0, max: 10, displayStep: 1 },
              },
            })}
          />
        </QueryClientProvider>,
      ),
    );
    expect(reads).toEqual([input]);
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_follow_retry(),
    )!;
    await act(async () => retry.click());
    expect(reads).toEqual([input, input]);
    const open = host.querySelector<HTMLAnchorElement>('[data-home-public-owner-actions] a')!;
    expect(open.getAttribute('href')).toBe(`/en/collections/${id}`);
    expect(window.history.state).toEqual({ [HOME_FEED_HISTORY_KEY]: descriptor, retained: 'entry' });
    // Returning to this history entry restores the same frontier through the existing page owner.
    await act(async () => window.dispatchEvent(new window.PopStateEvent('popstate')));
    expect(reads).toEqual([input, input]);
    expect(host.querySelector('[aria-pressed="true"]')?.textContent).toContain(m.home_feed_following());
    expect(host.textContent).toContain(m.library_follow_unavailable());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const key of Object.keys(globals)) {
      const old = previous.get(key);
      if (old) Object.defineProperty(globalThis, key, old);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
