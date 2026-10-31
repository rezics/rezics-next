import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHomeFeedWindow, homeFeedViewer } from '../src/features/pages/home-feed-read';
import { HomeFeed } from '../src/features/pages/home-feed';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';
import { setLocale } from '../src/paraglide/runtime.js';

let request = new Request('https://rezics.example/en');
let sessionReads = 0;
const headers: Record<string, string> = {};
const env = {
  KERNEL_ORIGIN: 'https://kernel.example', PUBLIC_ORIGIN: 'https://rezics.example',
  AUTH_ISSUER: 'https://auth.example', API_RESOURCE: 'https://kernel.example',
  WEBSITE_SCOPES: 'openid', WEBSITE_CLIENT_ID: 'web', WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credentialIfFresh: async () => {
    sessionReads++;
    return { status: 'active', accessToken: 'private-token', subject: 'viewer-a', csrfToken: 'csrf-a' };
  } }) },
};
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => request, setResponseHeader: (name: string, value: string) => { headers[name] = value; } }));
const { homePageQuery, readPrivateHomePage, readPublicHomePage } = await import('../src/features/pages/home-queries');
const { Home } = await import('../src/routes/index');
const liveFetch = globalThis.fetch;
afterAll(() => { globalThis.fetch = liveFetch; mock.restore(); });

test('The default home route renders a bounded mixed discovery Following and Continue stream with honest source states and private session isolation', async () => {
  setLocale('en', { reload: false });
  const calls: Request[] = [];
  // Selected HTTP source response for a consumer regression, not proof of native producer acceptance.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    calls.push(call);
    expect(new URL(call.url).pathname).toBe('/v1/feedItems');
    expect(new URL(call.url).searchParams.get('limit')).toBe('20');
    const personal = call.headers.has('authorization');
    expect(personal ? sessionReads > 0 : true).toBe(true);
    const url = new URL(call.url);
    const state = url.searchParams.get('stream') === 'following' ? 'following' : 'mixed';
    const page = homeFeedStoryPage('en', personal, state, url.searchParams.get('cursor') ?? undefined);
    if (personal && !url.searchParams.has('cursor') && state === 'mixed') page.sources.following = 'unavailable';
    return Response.json(page, { headers: { 'cache-control': personal ? 'private, no-store' : 'public, max-age=60' } });
  }) as typeof fetch;

  const client = new QueryClient();
  const loaded = await client.fetchQuery(homePageQuery('en'));
  const publicHtml = renderToStaticMarkup(<QueryClientProvider client={client}><Home /></QueryClientProvider>);
  expect(publicHtml).toContain('The Little Prince');
  expect(publicHtml).not.toContain('Letters from B-612');
  expect(publicHtml).not.toContain('data-feed-source="continue"');
  expect(sessionReads).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.has('authorization')).toBe(false);

  request = new Request('https://rezics.example/en', { headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` } });
  const viewer = homeFeedViewer({ state: 'signed-in', subject: 'viewer-a', csrfToken: 'csrf-a' })!;
  const window = createHomeFeedWindow(loaded.feed, (input) => readPrivateHomePage({ data: { locale: 'en', viewer: viewer.subject, ...input } }));
  await window.load({ stream: 'home' });
  expect(headers['Cache-Control']).toBe('private, no-store');
  const mixed = window.snapshot().result;
  expect(mixed.state).toBe('ready');
  if (mixed.state !== 'ready') throw new Error('Expected mixed feed');
  const html = renderToStaticMarkup(<HomeFeed result={mixed} locale="en" signedIn />);
  const orderedIds = [...html.matchAll(/data-feed-id="([^"]+)"/g)].map((match) => match[1]);
  expect(orderedIds).toEqual(mixed.page.feedItems.map((item) => item.id));
  expect(orderedIds.length).toBeLessThanOrEqual(20);
  expect(html).toContain('following:unavailable');
  expect(html).toContain('data-feed-source="continue"');
  expect(html).toContain('/en/library/progress/01a17ff1-e427-757d-9bbc-52f0787cfc0e');
  expect(html).not.toContain('No recent activity');
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
  expect(homeFeedViewer({ state: 'signed-in', subject: 'viewer-b', csrfToken: 'csrf-b' })!.scope).not.toBe(viewer.scope);
  expect(homeFeedViewer({ state: 'signed-in', subject: 'viewer-a', csrfToken: 'rotated' })!.scope).not.toBe(viewer.scope);
  expect(homeFeedViewer({ state: 'signed-out', subject: 'viewer-a', csrfToken: 'csrf-a' })).toBeNull();
  window.clear();
  expect(window.snapshot().input).toEqual({ stream: 'home' });
  expect(window.snapshot().result).toEqual(loaded.feed);
  const personalReads = sessionReads;
  request = new Request('https://rezics.example/en');
  const anonymous = await readPublicHomePage({ data: { locale: 'en' } });
  expect(anonymous).toEqual(loaded.feed);
  expect(sessionReads).toBe(personalReads);
  // The only hydrated/cache result is still the original public page, never the private continuation.
  expect(client.getQueryData(homePageQuery('en').queryKey)).toEqual(loaded);
  expect(client.getQueryCache().getAll()).toHaveLength(1);
  client.clear();
});
