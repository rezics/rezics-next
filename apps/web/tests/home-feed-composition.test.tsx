import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dirname } from 'node:path';
import { act } from 'react';
import { m } from '../src/paraglide/messages.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHomeFeedWindow, homeFeedViewer } from '../src/features/pages/home-feed-read';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedStoryPage, homeKindStoryPage, type HomeFeedStory } from '../src/kernel/fake/home-feed-stories';
import { setLocale } from '../src/paraglide/runtime.js';

let request = new Request('https://rezics.example/en');
let sessionReads = 0;
const headers: Record<string, string> = {};
const env = {
  KERNEL_ORIGIN: 'https://kernel.example',
  PUBLIC_ORIGIN: 'https://rezics.example',
  AUTH_ISSUER: 'https://auth.example',
  API_RESOURCE: 'https://kernel.example',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credentialIfFresh: async () => {
        sessionReads++;
        return { status: 'active', accessToken: 'private-token', subject: 'viewer-a', csrfToken: 'csrf-a' };
      },
    }),
  },
};
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => {
    headers[name] = value;
  },
}));
const { homePageQuery, readPrivateHomePage, readPublicHomePage } = await import('../src/features/pages/home-queries');
const { Home } = await import('../src/routes/index');
const liveFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = liveFetch;
  mock.restore();
});

test('The default home route renders a bounded mixed discovery Following and Continue stream with honest source states and private session isolation', async () => {
  setLocale('en', { reload: false });
  const calls: Request[] = [];
  let selected: HomeFeedStory = 'mixed';
  let pause: Promise<void> | undefined;
  let choicePause: Promise<void> | undefined;
  let feedStatus = 200;
  let choicesUnavailable = false;
  // Selected HTTP source response for a consumer regression, not proof of native producer acceptance.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    calls.push(call);
    const url = new URL(call.url);
    if (url.pathname === '/v1/subjects:search') {
      const body = (await call.json()) as {
        representation: string;
        languages: string[];
        kindPage: { limit: number; cursor?: string };
        limit?: number;
        cursor?: string;
        kindCountLeaf?: number;
      };
      expect(body.representation).toBe('discovery-v1');
      expect(body.languages).toEqual(['en']);
      expect(body.kindPage.limit).toBe(8);
      expect(body.cursor).toBeUndefined();
      expect(body.kindCountLeaf).toBeUndefined();
      expect(call.headers.has('authorization')).toBe(false);
      if (choicePause) await choicePause;
      if (choicesUnavailable) return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      const kinds = homeKindStoryPage(body.kindPage.cursor);
      return Response.json(
        body.kindPage.cursor
          ? { kinds, as_of: '2026-11-01T00:00:00Z' }
          : { hits: [], kinds, next: null, as_of: '2026-11-01T00:00:00Z' },
      );
    }
    expect(url.pathname).toBe('/v1/feedItems');
    expect(new URL(call.url).searchParams.get('limit')).toBe('20');
    const personal = call.headers.has('authorization');
    expect(personal ? sessionReads > 0 : true).toBe(true);
    if (pause) await pause;
    if (feedStatus !== 200)
      return Response.json(
        {
          code:
            feedStatus === 409 ? 'invalid_cursor' : feedStatus === 422 ? 'unsupported_query' : 'dependency_unavailable',
        },
        { status: feedStatus },
      );
    const state = url.searchParams.get('stream') === 'following' ? 'following' : selected;
    const page = homeFeedStoryPage(
      'en',
      personal,
      state,
      url.searchParams.get('cursor') ?? undefined,
      url.searchParams.get('kind') ?? undefined,
    );
    return Response.json(page, { headers: { 'cache-control': personal ? 'private, no-store' : 'public, max-age=60' } });
  }) as typeof fetch;

  const client = new QueryClient();
  const loaded = await client.fetchQuery(homePageQuery('en'));
  const publicHtml = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Home />
    </QueryClientProvider>,
  );
  expect(publicHtml).toContain('The Little Prince');
  expect(publicHtml).not.toContain('Letters from B-612');
  expect(publicHtml).not.toContain('data-feed-source="continue"');
  expect(sessionReads).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.has('authorization')).toBe(false);

  request = new Request('https://rezics.example/en', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  const viewer = homeFeedViewer({ state: 'signed-in', subject: 'viewer-a', csrfToken: 'csrf-a' })!;
  const window = createHomeFeedWindow(loaded.feed, (input) =>
    readPrivateHomePage({ data: { locale: 'en', viewer: viewer.subject, ...input } }),
  );
  await window.load({ stream: 'home' });
  expect(headers['Cache-Control']).toBe('private, no-store');
  const mixed = window.snapshot().result;
  expect(mixed.state).toBe('ready');
  if (mixed.state !== 'ready') throw new Error('Expected mixed feed');
  const html = renderToStaticMarkup(<HomeFeed result={mixed} locale="en" signedIn />);
  const orderedIds = [...html.matchAll(/data-feed-id="([^"]+)"/g)].map((match) => match[1]);
  expect(orderedIds).toEqual(mixed.page.feedItems.map((item) => item.id));
  expect(orderedIds.length).toBeLessThanOrEqual(20);
  expect(html).toContain('following:ready');
  expect(html).toContain('data-feed-source="continue"');
  expect(html).toContain('/en/library/progress/01a17ff1-e427-757d-9bbc-52f0787cfc0e');
  expect(html).not.toContain('No recent activity');
  selected = 'partial';
  await window.load({ stream: 'home' });
  const partial = renderToStaticMarkup(<HomeFeed result={window.snapshot().result} locale="en" signedIn />);
  expect(partial).toContain('following:unavailable');
  expect(partial).toContain('data-feed-source="continue"');
  expect(partial).not.toContain('No recent activity');
  selected = 'mixed';
  const cursor = mixed.page.next!;
  await window.load({ stream: 'home', cursor });
  expect(new URL(calls.at(-1)!.url).searchParams.get('cursor')).toBe(cursor);
  const next = window.snapshot().result;
  if (next.state !== 'ready') throw new Error('Expected continuation');
  expect(next.page.feedItems).toHaveLength(1);
  expect(next.page.feedItems[0]!.destination.kind).toBe('collection');
  expect(renderToStaticMarkup(<HomeFeed result={next} locale="en" signedIn />)).not.toContain('Letters from B-612');

  await window.load({ stream: 'following' });
  const following = window.snapshot().result;
  if (following.state !== 'ready') throw new Error('Expected Following');
  expect(following.page.feedItems.every((item) => item.source === 'following')).toBe(true);
  expect(new URL(calls.at(-1)!.url).searchParams.has('cursor')).toBe(false);

  // The route's viewer key changes synchronously; clearing also invalidates an older in-flight response.
  expect(homeFeedViewer({ state: 'signed-in', subject: 'viewer-b', csrfToken: 'csrf-b' })!.scope).not.toBe(
    viewer.scope,
  );
  expect(homeFeedViewer({ state: 'signed-in', subject: 'viewer-a', csrfToken: 'rotated' })!.scope).not.toBe(
    viewer.scope,
  );
  expect(homeFeedViewer({ state: 'signed-out', subject: 'viewer-a', csrfToken: 'csrf-a' })).toBeNull();
  let resume!: () => void;
  pause = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const pending = window.load({ stream: 'home' });
  window.clear();
  resume();
  await pending;
  pause = undefined;
  expect(window.snapshot().input).toEqual({ stream: 'home' });
  expect(window.snapshot().result).toEqual(loaded.feed);
  const countBeforeMismatch = calls.length;
  expect(await readPrivateHomePage({ data: { locale: 'en', viewer: 'viewer-b', stream: 'home' } })).toMatchObject({
    state: 'auth',
  });
  expect(calls).toHaveLength(countBeforeMismatch);
  const personalReads = sessionReads;
  request = new Request('https://rezics.example/en');
  const anonymous = await readPublicHomePage({ data: { locale: 'en' } });
  expect(anonymous).toEqual(loaded.feed);
  expect(sessionReads).toBe(personalReads);
  // The only hydrated/cache result is still the original public page, never the private continuation.
  expect(client.getQueryData(homePageQuery('en').queryKey)).toEqual(loaded);
  expect(client.getQueryCache().getAll()).toHaveLength(1);
  // Continue the same default-route regression through the real labelled control and production callbacks.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.example/en' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { sessionQuery } = await import('../src/session/query');
  const host = browser.document.createElement('div') as unknown as HTMLDivElement;
  browser.document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Home />
        </QueryClientProvider>,
      );
    });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const button = (text: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!;
  const click = (text: string) =>
    act(async () => {
      button(text).click();
    });
  const choose = (value: string) =>
    act(async () => {
      const control = host.querySelector('select')!;
      control.value = value;
      control.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
    });
  const lastFeed = () => [...calls].reverse().find((call) => new URL(call.url).pathname === '/v1/feedItems')!;
  const query = () => new URL(lastFeed().url).searchParams;
  try {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
    await render();
    const beforeChoices = calls.length;
    await click(m.home_kinds_load());
    expect(calls.length).toBe(beforeChoices + 1);
    expect(host.querySelector('label')?.htmlFor).toBe(host.querySelector('select')?.id);
    const nativeKind = homeKindStoryPage().values[0]!.id;
    await choose(nativeKind);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    expect(lastFeed().headers.has('authorization')).toBe(false);
    expect(sessionReads).toBe(personalReads);
    await click(m.library_next_page());
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().get('cursor')).toBe('illustrative-signed-frontier');
    // A sparse selected window is shown as received, never refilled or broadened.
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    feedStatus = 503;
    await choose('');
    expect(query().has('kind')).toBe(false);
    await choose(nativeKind);
    expect(host.textContent).toContain(m.home_feed_unavailable());
    await click(m.library_follow_retry());
    expect(query().get('kind')).toBe(nativeKind);
    feedStatus = 200;
    await click(m.library_follow_retry());
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(1);

    // One metadata page replaces another; the selected identity/label survives missing options.
    await click(m.home_kinds_next());
    expect(host.querySelectorAll('option')).toHaveLength(3); // All, retained Book, current Account.
    expect(host.querySelector('select')!.value).toBe(nativeKind);
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/subjects:search')).toHaveLength(2);
    await choose('');
    request = new Request('https://rezics.example/en', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'csrf-a', subject: 'viewer-a' });
    await render();
    await settle();
    await click(m.home_kinds_load());
    await choose(nativeKind);
    expect(query().get('kind')).toBe(nativeKind);
    expect(lastFeed().headers.get('authorization')).toBe('Bearer private-token');
    expect(headers['Cache-Control']).toBe('private, no-store');
    expect(host.querySelector('[data-feed-source="continue"]')).not.toBeNull();
    await click(m.library_next_page());
    await click(m.home_feed_following());
    expect(query().get('stream')).toBe('following');
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(button(m.library_next_page()).disabled).toBe(false); // Empty with next is not exhaustion.
    feedStatus = 409;
    await click(m.library_next_page());
    expect(host.textContent).toContain(m.home_feed_cursor());
    feedStatus = 200;
    await click(m.home_feed_restart());
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    await click(m.home_kinds_next());
    feedStatus = 422;
    await choose('account');
    expect(host.textContent).toContain(m.home_feed_request());
    expect(query().get('kind')).toBe('account');
    feedStatus = 200;
    await click(m.library_follow_retry());
    expect(query().get('kind')).toBe('account');
    await click(m.home_heading());
    await choose(nativeKind);
    choicesUnavailable = true;
    // Remount on rotation keeps old private rows out and starts a fresh choices window.
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'rotated', subject: 'viewer-a' });
    await render();
    await settle();
    await click(m.home_kinds_load());
    expect(host.textContent).toContain(m.home_kinds_unavailable());
    expect(host.textContent).toContain('Letters from B-612');
    choicesUnavailable = false;
    await click(m.home_kinds_retry());
    await choose(nativeKind);
    let releaseChoice!: () => void;
    choicePause = new Promise<void>((resolve) => {
      releaseChoice = resolve;
    });
    await click(m.home_kinds_next());
    await choose('');
    await act(async () => {
      releaseChoice();
    });
    choicePause = undefined;
    expect(host.querySelector('option[value="account"]')).toBeNull();
    expect(host.querySelector('select')!.value).toBe('');

    // Delayed old selection cannot restore its rows, even when the transport ignores abort.
    let releaseFeed!: () => void;
    pause = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    await choose(nativeKind);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    await choose('');
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    await act(async () => {
      releaseFeed();
    });
    pause = undefined;
    expect(host.textContent).toContain('Letters from B-612');
    // A late private read also cannot enter the public viewer after sign-out.
    pause = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    await choose(nativeKind);
    request = new Request('https://rezics.example/en');
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
    await render();
    await settle();
    await act(async () => {
      releaseFeed();
    });
    pause = undefined;
    expect(host.textContent).not.toContain('Letters from B-612');
    expect(host.querySelector('[data-feed-source="continue"]')).toBeNull();
    expect(client.getQueryData(homePageQuery('en').queryKey)).toEqual(loaded);
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((entry) => entry.queryKey[0] === 'home-page'),
    ).toHaveLength(1);
    expect(host.querySelector('select')!.value).toBe('');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
