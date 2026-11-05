import { afterAll, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act } from 'react';
import { m } from '../src/paraglide/messages.js';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createHomeFeedWindow,
  homeFeedViewer,
  type FeedInput,
  type HomeFeedResult,
} from '../src/features/pages/home-feed-read';
import type { QuestionPointResult } from '../src/features/pages/home-feed-questions';
import {
  homeFeedStoryPage,
  homeKindStoryPage,
  homeQuestionStoryPage,
  homeStorySpace,
  type HomeFeedStory,
} from '../src/kernel/fake/home-feed-stories';
import { setLocale } from '../src/paraglide/runtime.js';
import homePageRecording from '../src/kernel/recorded/home-page.json';

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
// Server functions execute on the Worker even when a mounted browser component calls them.
const serverCall = new AsyncLocalStorage<boolean>();
mock.module('@tanstack/react-start', async () => {
  const story = await import('../.storybook/react-start');
  type Implementation = (...args: never[]) => unknown;
  return {
    ...story,
    createServerFn() {
      const chain = story.createServerFn();
      const handle = chain.handler;
      return Object.assign(chain, {
        handler<T extends Implementation>(handler: T): T {
          return handle(((...args: never[]) => serverCall.run(true, () => handler(...args))) as T);
        },
      });
    },
    createIsomorphicFn() {
      return {
        server(server: Implementation) {
          return {
            client(client: Implementation) {
              return (...args: never[]) =>
                (serverCall.getStore() || typeof window === 'undefined' ? server : client)(...args);
            },
          };
        },
      };
    },
  };
});
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => request,
  setResponseHeader: (name: string, value: string) => {
    headers[name] = value;
  },
}));
const { HomeFeed, HomeFeedConsumer } = await import('../src/features/pages/home-feed');
const { homePageQuery, readPrivateHomePage, readPublicHomePage, readHomeQuestions } =
  await import('../src/features/pages/home-queries');
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
  let questionStatus = 200;
  let pointStatus = 200;
  let questionRevision = 1;
  let emptyQuestionPage = false;
  let oversizedQuestions = false;
  let repeatedQuestionCursor = false;
  let directoryPause: Promise<void> | undefined;
  let pointPause: Promise<void> | undefined;
  const firstQuestion = homeQuestionStoryPage().ratingQuestions[0]!;
  const secondQuestion = homeQuestionStoryPage('illustrative-question-frontier').ratingQuestions[0]!;
  // Selected HTTP source response for a consumer regression, not proof of native producer acceptance.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    calls.push(call);
    const url = new URL(call.url);
    if (url.pathname === '/v1/pages:read') {
      expect(call.method).toBe('POST');
      expect(await call.json()).toEqual({ target: { route: '/' }, languages: ['en'] });
      expect(call.headers.has('authorization')).toBe(false);
      return Response.json(homePageRecording);
    }
    if (url.pathname === '/v1/rating-questions') {
      expect(url.searchParams.get('limit')).toBe('20');
      expect([...url.searchParams.keys()].sort()).toEqual(
        url.searchParams.has('cursor') ? ['cursor', 'limit'] : ['limit'],
      );
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      if (directoryPause) await directoryPause;
      if (questionStatus !== 200)
        return Response.json(
          {
            code:
              questionStatus === 409
                ? 'stale_cursor'
                : questionStatus === 400
                  ? 'invalid_cursor'
                  : 'dependency_unavailable',
          },
          { status: questionStatus },
        );
      const page = homeQuestionStoryPage(url.searchParams.get('cursor') ?? undefined);
      return Response.json({
        ...page,
        ...(repeatedQuestionCursor ? { next: url.searchParams.get('cursor') } : {}),
        ratingQuestions: oversizedQuestions
          ? Array.from({ length: 21 }, (_, index) => ({
              ...firstQuestion,
              id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
            }))
          : emptyQuestionPage
            ? []
            : page.ratingQuestions.map((question) => ({ ...question, revision: questionRevision })),
      });
    }
    if (url.pathname.startsWith('/v1/rating-questions/')) {
      expect([...url.searchParams.keys()]).toEqual([]); // No revision, counts or eligibility query.
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      const id = url.pathname.split('/').at(-1);
      const question = id === firstQuestion.id ? firstQuestion : secondQuestion;
      const revision = questionRevision;
      if (pointPause) await pointPause;
      if (pointStatus !== 200)
        return Response.json(
          { code: pointStatus === 404 ? 'not_found' : 'permission_denied' },
          { status: pointStatus },
        );
      return Response.json({ ...question, revision });
    }
    if (url.pathname.startsWith('/v1/spaceAddresses/')) {
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      return Response.json({ spaceId: homeStorySpace.spaceId });
    }
    if (url.pathname === `/v1/spaces/${homeStorySpace.spaceId}`) {
      expect(call.cache).toBe('no-store');
      expect(call.redirect).toBe('manual');
      return Response.json({ space: homeStorySpace, community: null });
    }
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
      url.searchParams.get('spaceId') ?? undefined,
      url.searchParams.get('ratingQuestionId') ?? undefined,
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
  expect(calls.map((call) => new URL(call.url).pathname).sort()).toEqual(['/v1/feedItems', '/v1/pages:read']);
  expect(calls.every((call) => !call.headers.has('authorization'))).toBe(true);

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
  const beforeInvalid = calls.length;
  await expect(
    Promise.resolve().then(() => readPublicHomePage({ data: { locale: 'en', kind: '' } })),
  ).rejects.toThrow();
  await expect(
    Promise.resolve().then(() =>
      readPrivateHomePage({ data: { locale: 'en', viewer: 'viewer-a', stream: 'home', kind: '界'.repeat(86) } }),
    ),
  ).rejects.toThrow();
  expect(calls).toHaveLength(beforeInvalid);
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
    HTMLInputElement: browser.HTMLInputElement,
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
    const nativeKind = host.querySelector<HTMLOptionElement>('option:not([value=""])')!.value;
    expect(nativeKind).toBe(homeKindStoryPage().values[0]!.id);
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
    await click(m.nav_home());
    await choose('');
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
    // Public selectors belong to this history entry; the new reader fetches its own rows.
    expect(host.querySelector('select')!.value).toBe(nativeKind);

    // Default Home selects a real bounded-directory rating question and carries its exact identity
    // through public and private mixed-feed requests while retiring stale choices rows and cursors.
    const selectSpace = async () => {
      const label = [...host.querySelectorAll('label')].find((node) => node.textContent === m.home_space_label())!;
      const input = host.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          'home-reading-room',
        );
        input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
        input.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
      });
      await click(m.home_space_lookup());
      await click(m.home_space_select());
    };
    const questionControl = () => host.querySelectorAll<HTMLSelectElement>('select')[1]!;
    const chooseQuestion = (id: string) =>
      act(async () => {
        questionControl().value = id;
        questionControl().dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
      });
    const questionCalls = () => calls.filter((call) => new URL(call.url).pathname === '/v1/rating-questions');
    const pointCalls = () => calls.filter((call) => new URL(call.url).pathname.startsWith('/v1/rating-questions/'));
    const feedCalls = () => calls.filter((call) => new URL(call.url).pathname === '/v1/feedItems');
    const beforeInvalidQuestion = calls.length;
    await expect(
      Promise.resolve().then(() => readPublicHomePage({ data: { locale: 'en', ratingQuestionId: 'invalid' } })),
    ).rejects.toThrow();
    await expect(
      Promise.resolve().then(() => readHomeQuestions({ data: { locale: 'en', questionId: '' } })),
    ).rejects.toThrow();
    expect(calls).toHaveLength(beforeInvalidQuestion);
    await click(m.home_kinds_load());
    await choose(nativeKind);
    await selectSpace();
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    let count = calls.length;
    await click(m.home_questions_load());
    expect(calls).toHaveLength(count + 1);
    expect(questionCalls()).toHaveLength(1);
    expect(pointCalls()).toHaveLength(0); // No per-option point reads.
    expect(questionControl().options).toHaveLength(2);
    expect(host.querySelector(`label[for="${questionControl().id}"]`)?.textContent).toBe(m.home_question_label());
    count = feedCalls().length;
    const publicSessionReads = sessionReads;
    await chooseQuestion(firstQuestion.id);
    expect(pointCalls()).toHaveLength(1);
    expect(feedCalls()).toHaveLength(count + 1); // One mixed load; no per-dimension requests/refill.
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    expect(query().has('revision')).toBe(false);
    expect(lastFeed().headers.has('authorization')).toBe(false);
    expect(pointCalls().at(-1)!.headers.has('authorization')).toBe(false);
    expect(host.textContent).toContain(firstQuestion.label);
    expect(sessionReads).toBe(publicSessionReads);
    const beforeAnonymousMetadata = sessionReads;
    await click(m.home_questions_next());
    expect(sessionReads).toBe(beforeAnonymousMetadata);
    expect(questionCalls()).toHaveLength(2);
    expect(new URL(questionCalls()[1]!.url).searchParams.get('cursor')).toBe('illustrative-question-frontier');
    expect(questionControl().options).toHaveLength(3); // All + one page + retained selected metadata.
    expect(questionControl().value).toBe(firstQuestion.id); // Absence from another page is not lost identity.
    expect(pointCalls()).toHaveLength(1);
    expect(button(m.home_questions_next()).disabled).toBe(true); // Actual next=null.
    await click(m.library_next_page());
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().get('cursor')).toBe('illustrative-signed-frontier');
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0); // Sparse is not refilled.
    const pointsBeforeRefresh = pointCalls().length;
    questionRevision = 2;
    await click(m.home_question_refresh());
    expect(pointCalls()).toHaveLength(pointsBeforeRefresh + 1);
    expect(query().has('cursor')).toBe(false);
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(host.textContent).toContain('Revision 2');

    // An actual point loss/refusal retains the selected identity, removes rows and offers refresh/clear.
    pointStatus = 404;
    count = feedCalls().length;
    await click(m.home_question_refresh());
    expect(host.textContent).toContain(m.home_questions_lost());
    expect(questionControl().value).toBe(firstQuestion.id);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(feedCalls()).toHaveLength(count);
    pointStatus = 403;
    await click(m.home_question_refresh());
    expect(host.textContent).toContain(m.home_questions_denied());
    expect(feedCalls()).toHaveLength(count);
    pointStatus = 200;
    await click(m.home_question_refresh());
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    await click(m.home_question_clear());
    expect(query().has('ratingQuestionId')).toBe(false);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    await chooseQuestion(secondQuestion.id);
    expect(query().get('ratingQuestionId')).toBe(secondQuestion.id);
    await click(m.home_question_clear());

    // A late selected feed cannot replace a newer cleared public selection, even if abort is ignored.
    let releaseQuestionFeed!: () => void;
    pause = new Promise<void>((resolve) => {
      releaseQuestionFeed = resolve;
    });
    count = feedCalls().length;
    await chooseQuestion(secondQuestion.id);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    pause = undefined;
    await click(m.home_question_clear());
    expect(feedCalls()).toHaveLength(count + 2);
    expect(query().has('ratingQuestionId')).toBe(false);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(1);
    await act(async () => {
      releaseQuestionFeed();
    });
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(1);
    expect(questionControl().value).toBe('');

    // A real metadata read observes changed revision and resets a selected feed frontier.
    // Start a fresh mounted directory because terminal pages do not invent more pages.
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'question-view', subject: 'viewer-a' });
    request = new Request('https://rezics.example/en', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    await render();
    await settle();
    await click(m.home_kinds_load());
    await choose(nativeKind);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(host.textContent).toContain(homeStorySpace.title);
    await click(m.home_questions_load());
    await chooseQuestion(firstQuestion.id);
    expect(lastFeed().headers.get('authorization')).toBe('Bearer private-token');
    expect(pointCalls().at(-1)!.headers.get('authorization')).toBe('Bearer private-token');
    expect(questionCalls().at(-1)!.headers.get('authorization')).toBe('Bearer private-token');
    expect(headers['Cache-Control']).toBe('private, no-store');
    await click(m.library_next_page());
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    await click(m.home_feed_following());
    expect(query().get('stream')).toBe('following');
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(button(m.library_next_page()).disabled).toBe(false); // Empty-with-next stays usable.
    feedStatus = 409;
    await click(m.library_next_page());
    feedStatus = 200;
    await click(m.home_feed_restart());
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('kind')).toBe(nativeKind);
    expect(query().has('cursor')).toBe(false);
    feedStatus = 503;
    await click(m.library_next_page());
    // A selected question's refusal is explained by its own control, not duplicated as a generic Home error.
    expect(host.textContent).not.toContain(m.home_feed_unavailable());
    expect(host.textContent).toContain(m.home_questions_unavailable());
    feedStatus = 200;
    await click(m.library_follow_retry());
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('cursor')).toBe('illustrative-signed-frontier');
    await click(m.nav_home());
    await click(m.library_next_page());
    questionStatus = 409;
    await click(m.home_questions_next());
    expect(host.textContent).toContain(m.home_questions_restart());
    questionStatus = 200;
    questionRevision = 3;
    count = feedCalls().length;
    await click(m.home_questions_restart_action());
    expect(new URL(questionCalls().at(-1)!.url).searchParams.has('cursor')).toBe(false);
    expect(feedCalls()).toHaveLength(count + 1);
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().has('cursor')).toBe(false);
    expect(host.textContent).toContain('Revision 3');
    emptyQuestionPage = true;
    await click(m.home_questions_next());
    expect(host.textContent).toContain(m.home_questions_empty());
    expect(questionControl().value).toBe(firstQuestion.id);
    emptyQuestionPage = false;

    // A kind change fences a pending exact refresh without silently clearing its selected question or Space.
    let releasePoint!: () => void;
    pointPause = new Promise<void>((resolve) => {
      releasePoint = resolve;
    });
    count = feedCalls().length;
    await click(m.home_question_refresh());
    await choose('');
    await act(async () => {
      releasePoint();
    });
    pointPause = undefined;
    expect(feedCalls()).toHaveLength(count);
    expect(questionControl().value).toBe(firstQuestion.id);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(host.textContent).toContain(m.home_questions_unavailable());
    await click(m.home_question_refresh());
    expect(query().has('kind')).toBe(false);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);
    expect(query().get('ratingQuestionId')).toBe(firstQuestion.id);
    expect(query().has('cursor')).toBe(false);
    await choose(nativeKind);

    // Delayed selected metadata cannot restore a cleared question; the old cursor retires immediately.
    pointPause = new Promise<void>((resolve) => {
      releasePoint = resolve;
    });
    await click(m.home_question_refresh());
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    await click(m.home_question_clear());
    await act(async () => {
      releasePoint();
    });
    pointPause = undefined;
    expect(questionControl().value).toBe('');
    expect(query().has('ratingQuestionId')).toBe(false);
    expect(query().get('spaceId')).toBe(homeStorySpace.spaceId);

    // A pending directory page is retired by selection; stale options cannot replace current metadata.
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'question-view-2',
      subject: 'viewer-a',
    });
    await render();
    await settle();
    await click(m.home_questions_load());
    let releaseDirectory!: () => void;
    directoryPause = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    await click(m.home_questions_next());
    await chooseQuestion(firstQuestion.id);
    await act(async () => {
      releaseDirectory();
    });
    directoryPause = undefined;
    expect(questionControl().querySelector(`option[value="${secondQuestion.id}"]`)).toBeNull();
    expect(questionControl().value).toBe(firstQuestion.id);

    let releaseSelectedFeed!: () => void;
    pause = new Promise<void>((resolve) => {
      releaseSelectedFeed = resolve;
    });
    await click(m.home_question_clear());
    await chooseQuestion(firstQuestion.id);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    await click(m.home_question_clear());
    await act(async () => {
      releaseSelectedFeed();
    });
    pause = undefined;
    expect(questionControl().value).toBe('');
    expect(query().has('ratingQuestionId')).toBe(false);

    // A delayed question-selected private feed cannot enter a different viewer's mounted window.
    pause = new Promise<void>((resolve) => {
      releaseSelectedFeed = resolve;
    });
    await chooseQuestion(firstQuestion.id);
    request = new Request('https://rezics.example/en');
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', csrfToken: 'viewer-b-csrf', subject: 'viewer-b' });
    await render();
    await settle();
    await act(async () => {
      releaseSelectedFeed();
    });
    pause = undefined;
    expect(questionControl().value).toBe(firstQuestion.id);
    expect(host.querySelector('[data-feed-source="continue"]')).toBeNull();
    request = new Request('https://rezics.example/en', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'question-view-3',
      subject: 'viewer-a',
    });
    await render();
    await settle();
    await click(m.home_questions_load());
    directoryPause = new Promise<void>((resolve) => {
      releaseDirectory = resolve;
    });
    await click(m.home_questions_next());
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'question-view-4',
      subject: 'viewer-a',
    });
    await render();
    await settle();
    await act(async () => {
      releaseDirectory();
    });
    directoryPause = undefined;
    // Rotation drops the old directory and revalidates only the selected public identity.
    expect(questionControl().options).toHaveLength(2);
    expect(questionControl().value).toBe(firstQuestion.id);
    expect(questionControl().querySelector(`option[value="${secondQuestion.id}"]`)).toBeNull();
    await click(m.home_questions_load());

    // Late private directory/point/feed results cannot reach another viewer or a public window.
    pointPause = new Promise<void>((resolve) => {
      releasePoint = resolve;
    });
    await chooseQuestion(firstQuestion.id);
    request = new Request('https://rezics.example/en');
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
    await render();
    await settle();
    await act(async () => {
      releasePoint();
    });
    pointPause = undefined;
    expect(questionControl().value).toBe(firstQuestion.id);
    expect(host.querySelector('[data-feed-source="continue"]')).toBeNull();
    expect(client.getQueryData(homePageQuery('en').queryKey)).toEqual(loaded);
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((entry) => entry.queryKey[0] === 'home-page'),
    ).toHaveLength(1);
    await click(m.home_question_clear());
    questionStatus = 403;
    await click(m.home_questions_load());
    expect(host.textContent).toContain(m.home_questions_denied());
    questionStatus = 404;
    await click(m.home_questions_retry());
    expect(host.textContent).toContain(m.home_questions_unavailable());
    questionStatus = 503;
    await click(m.home_questions_retry());
    expect(host.textContent).toContain(m.home_questions_unavailable());
    questionStatus = 200;
    oversizedQuestions = true;
    await click(m.home_questions_retry());
    expect(host.textContent).toContain(m.home_questions_unavailable());
    expect(questionControl().options).toHaveLength(1); // Oversized wire pages are refused, never truncated.
    oversizedQuestions = false;
    await click(m.home_questions_retry());
    expect(questionControl().options).toHaveLength(2);
    questionStatus = 400;
    await click(m.home_questions_next());
    expect(host.textContent).toContain(m.home_questions_invalid());
    questionStatus = 200;
    await click(m.home_questions_restart_action());
    expect(new URL(questionCalls().at(-1)!.url).searchParams.has('cursor')).toBe(false);
    expect(questionControl().options).toHaveLength(2);
    repeatedQuestionCursor = true;
    await click(m.home_questions_next());
    expect(host.textContent).toContain(m.home_questions_unavailable());
    expect(questionControl().options).toHaveLength(1);
    repeatedQuestionCursor = false;
    await click(m.home_questions_retry());
    expect(questionControl().options).toHaveLength(2);
    expect(button(m.home_questions_next()).disabled).toBe(true);
    const beforeMismatchMetadata = calls.length;
    expect(await readHomeQuestions({ data: { locale: 'en', viewer: 'viewer-b' } })).toEqual({
      status: 'auth',
      code: 'authentication_required',
    });
    expect(calls).toHaveLength(beforeMismatchMetadata);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15_000);

test('Default Home keeps question details optional and recovers partial, refused and expired selections in place', async () => {
  setLocale('en', { reload: false });
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.example/en' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLSelectElement: browser.HTMLSelectElement,
    HTMLButtonElement: browser.HTMLButtonElement,
    Element: browser.Element,
    Node: browser.Node,
    Document: browser.Document,
    ShadowRoot: browser.ShadowRoot,
    DocumentFragment: browser.DocumentFragment,
    MutationObserver: browser.MutationObserver,
    ResizeObserver: browser.ResizeObserver,
    Event: browser.Event,
    NodeFilter: browser.NodeFilter,
    KeyboardEvent: browser.KeyboardEvent,
    FocusEvent: browser.FocusEvent,
    MouseEvent: browser.MouseEvent,
    PointerEvent: browser.PointerEvent,
    CSS: browser.CSS,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const require = createRequire(import.meta.url);
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: browser.document });
  const { createRoot } = await import('react-dom/client');
  const host = browser.document.createElement('div');
  browser.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const initial: HomeFeedResult = {
    state: 'ready',
    page: { ...homeFeedStoryPage('en', true, 'partial'), next: 'illustrative-partial-frontier' },
  };
  const question = homeQuestionStoryPage().ratingQuestions[0]!;
  const feedInputs: FeedInput[] = [];
  let questionPoint: QuestionPointResult = { status: 'ready', question };
  const read = async (input: FeedInput): Promise<HomeFeedResult> => {
    feedInputs.push({ ...input });
    return input.cursor ? { state: 'cursor', code: 'invalid_cursor' } : initial;
  };
  const click = (label: string) =>
    act(async () => {
      const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
      if (!button) throw new Error(`Missing Home control: ${label}`);
      await user.click(button);
    });
  const select = (element: HTMLSelectElement, value: string) =>
    act(async () => {
      await user.selectOptions(element, value);
    });
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  try {
    await act(async () => {
      root.render(
        <HomeFeedConsumer
          initial={initial}
          locale="en"
          signedIn
          read={read}
          readKinds={async (cursor) => ({ status: 'ready', kinds: homeKindStoryPage(cursor) })}
          readSpace={async () => ({ status: 'unavailable' })}
          readQuestions={async (cursor) => ({ status: 'ready', page: homeQuestionStoryPage(cursor) })}
          readQuestion={async () => questionPoint}
          origin="https://rezics.example"
        />,
      );
    });
    await settle();
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(2);
    expect(host.querySelector('[data-feed-result-state] > [role="status"]')?.textContent).toBe(
      m.home_presentation_partial(),
    );

    await click(m.search_filters());
    await click(m.home_kinds_load());
    const kindSelect = host.querySelector<HTMLSelectElement>('select')!;
    await select(kindSelect, 'schema:Book');
    await click(m.home_questions_load());
    const questionSelect = host.querySelectorAll<HTMLSelectElement>('select')[1]!;
    await select(questionSelect, question.id);
    await settle();

    const selected = [...host.querySelectorAll<HTMLUListElement>('ul')].find(
      (list) => list.getAttribute('aria-label') === m.refinement_selected(),
    )!;
    expect(selected.textContent).toContain(question.label);
    expect(selected.textContent).toContain('Book');
    expect(selected.textContent).not.toContain('Revision 1'); // Metadata stays in the closed disclosure.
    const details = host.querySelector('details')!;
    expect(details.querySelector('summary')?.textContent).toBe(m.home_presentation_question_information());
    expect(details.open).toBe(false);
    const information = details.querySelector('p')!;
    expect(information.textContent).toContain(question.label);
    expect(information.textContent).toContain(m.home_question_work());
    expect(information.textContent).toContain('Revision 1');
    expect(information.textContent).toContain('Scale 0–100, step 5');
    await act(async () => user.click(details.querySelector('summary')!));
    expect(details.open).toBe(true);

    const beforeRetry = feedInputs.length;
    await click(m.library_follow_retry());
    await settle();
    expect(feedInputs).toHaveLength(beforeRetry + 1);
    expect(feedInputs.at(-1)).toMatchObject({ kind: 'schema:Book', ratingQuestionId: question.id });
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-feed-result-state] > [role="status"]')).toHaveLength(1);
    expect(host.querySelector('[data-feed-result-state] > [role="status"]')?.textContent).toBe(
      m.home_presentation_partial(),
    );

    questionPoint = { status: 'lost', code: 'not_found' };
    await click(m.home_question_refresh());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.home_questions_lost());
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(host.textContent).not.toContain(m.home_feed_unavailable());
    expect(selected.textContent).toContain(question.label);
    await click(m.home_question_clear());
    await settle();
    expect(questionSelect.value).toBe('');

    await click(m.library_next_page());
    expect(host.textContent).toContain(m.home_feed_cursor());
    expect(m.home_feed_cursor()).not.toMatch(/cursor/i);
    expect(selected.textContent).toContain('Book');
    await click(m.home_feed_restart());
    await settle();
    expect(feedInputs.at(-1)).toEqual({ stream: 'home', kind: 'schema:Book' });
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(2);
    expect(selected.textContent).toContain('Book');
  } finally {
    await act(async () => root.unmount());
    await browser.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// Authored, UNEXECUTED: Space agreement receiving/native/default acceptance remains independent.
test('Default Home resolves one exact Space and carries its identity through public and private mixed-feed requests while independently retiring changed head carrier and viewer generations', async () => {
  const { createHomeSpaceSelection, homeSpaceGeneration } = await import('../src/features/pages/home-feed-spaces');
  const { readHomeSpaceChoice } = await import('../src/features/pages/home-queries');
  const { homeStorySpace } = await import('../src/kernel/fake/home-feed-stories');
  const calls: Request[] = [];
  let space = { ...homeStorySpace, realmId: homeStorySpace.realmId as string | null };
  let pointStatus = 200;
  let feedStatus = 200;
  let pauseFeed: Promise<void> | undefined;
  let pausePoint: Promise<void> | undefined;
  request = new Request('https://rezics.example/en');
  const initial = { state: 'ready' as const, page: homeFeedStoryPage('en', false) };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = new Request(input, init);
    calls.push(call);
    expect(call.cache).toBe('no-store');
    expect(call.redirect).toBe('manual');
    const url = new URL(call.url);
    if (url.pathname.startsWith('/v1/spaceAddresses/')) return Response.json({ spaceId: space.spaceId });
    if (url.pathname === `/v1/spaces/${space.spaceId}`) {
      const observed = { ...space };
      const status = pointStatus;
      if (pausePoint) await pausePoint;
      return status === 200
        ? Response.json({ space: observed, community: null })
        : Response.json({ code: 'not_found' }, { status });
    }
    expect(url.pathname).toBe('/v1/feedItems');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('realmId')).toBe(false);
    expect(url.searchParams.has('zoneId')).toBe(false);
    const status = feedStatus;
    const personal = call.headers.has('authorization');
    const page = homeFeedStoryPage('en', personal, 'mixed', url.searchParams.get('cursor') ?? undefined);
    if (pauseFeed) await pauseFeed;
    return status === 200 ? Response.json(page) : Response.json({ code: 'stale_cursor' }, { status });
  }) as typeof fetch;
  const question = '01a1a000-0000-7000-8000-000000000821';
  const selectionInput = { stream: 'home' as const, kind: 'schema:Book', ratingQuestionId: question };
  let viewer: string | undefined;
  const feed = createHomeFeedWindow(initial, (input, signal) =>
    viewer
      ? readPrivateHomePage({ data: { locale: 'en', viewer, ...input }, signal })
      : readPublicHomePage({ data: { locale: 'en', ...input }, signal }),
  );
  await feed.load(selectionInput);
  let applied: Promise<void> = Promise.resolve();
  const selection = createHomeSpaceSelection(
    (input, signal) =>
      readHomeSpaceChoice({
        data: { locale: 'en', ...(viewer ? { viewer } : {}), ...input },
        signal,
      }),
    (selected, available) => {
      feed.retire(available ? undefined : { state: 'unavailable', code: 'space_unavailable' });
      if (!available) return;
      const { cursor: _cursor, spaceId: _spaceId, ...rest } = feed.snapshot().input;
      applied = feed.load({ ...rest, ...(selected ? { spaceId: selected.spaceId } : {}) });
    },
  );
  const lastFeed = () => [...calls].reverse().find((call) => new URL(call.url).pathname === '/v1/feedItems')!;
  const query = () => new URL(lastFeed().url).searchParams;
  const beforeInvalid = calls.length;
  for (const address of [
    'https://other.example/spaces/room',
    '/subjects/room',
    '/spaces/room/extra',
    '//other.example/spaces/room',
    '/spaces/room%2Fextra',
    '/other/../spaces/room',
    '/spaces/room/../other',
  ]) {
    await selection.lookup(address, 'https://rezics.example');
    expect(selection.snapshot().status).toBe('invalid');
    expect(await readHomeSpaceChoice({ data: { locale: 'en', address } })).toEqual({ status: 'invalid' });
  }
  expect(calls.length).toBe(beforeInvalid);
  let before = calls.length;
  await selection.lookup('https://rezics.example/spaces/Home-Reading-Room', 'https://rezics.example');
  expect(calls.length - before).toBe(2);
  expect(selection.snapshot().candidate?.spaceId).toBe(space.spaceId);
  expect(selection.snapshot().selected).toBeUndefined();
  selection.select();
  expect(feed.snapshot().result.state).toBe('loading');
  await applied;
  expect(query().get('spaceId')).toBe(space.spaceId);
  expect(query().get('kind')).toBe('schema:Book');
  expect(query().get('ratingQuestionId')).toBe(question);
  expect(lastFeed().headers.has('authorization')).toBe(false);
  const anonymousSessionReads = sessionReads;
  await selection.refresh();
  await applied;
  expect(sessionReads).toBe(anonymousSessionReads);

  viewer = 'viewer-a';
  request = new Request('https://rezics.example/en', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  await feed.load({ ...feed.snapshot().input, stream: 'following', cursor: 'next-private' });
  expect(lastFeed().headers.get('authorization')).toBe('Bearer private-token');
  expect(headers['Cache-Control']).toBe('private, no-store');
  expect(query().get('spaceId')).toBe(space.spaceId);
  expect(query().get('ratingQuestionId')).toBe(question);
  expect(query().get('kind')).toBe('schema:Book');
  feedStatus = 409;
  await feed.load(feed.snapshot().input);
  expect(feed.snapshot().result.state).toBe('cursor');
  expect(query().get('spaceId')).toBe(space.spaceId);
  feedStatus = 200;
  const { cursor: _cursor, ...restart } = feed.snapshot().input;
  await feed.load(restart);
  expect(query().has('cursor')).toBe(false);
  expect(query().get('spaceId')).toBe(space.spaceId);

  for (const change of ['head', 'realm'] as const) {
    await feed.load({ ...feed.snapshot().input, cursor: 'retire-me' });
    const oldGeneration = homeSpaceGeneration(selection.snapshot().selected!);
    if (change === 'head') space.headRevisionId = '01a1a000-0000-7000-8000-000000000822';
    else space.realmId = '01a1a000-0000-7000-8000-000000000823';
    before = calls.length;
    const refresh = selection.refresh();
    expect(feed.snapshot().result.state).toBe('unavailable');
    expect(feed.snapshot().input.cursor).toBeUndefined();
    await refresh;
    await applied;
    expect(homeSpaceGeneration(selection.snapshot().selected!)).not.toBe(oldGeneration);
    expect(selection.snapshot().changed).toBe(true);
    const reads = calls.slice(before);
    expect(reads.filter((call) => new URL(call.url).pathname.startsWith('/v1/spaces/'))).toHaveLength(1);
    expect(reads.filter((call) => new URL(call.url).pathname.includes('spaceAddresses'))).toHaveLength(0);
    expect(reads.filter((call) => new URL(call.url).pathname === '/v1/feedItems')).toHaveLength(1);
    expect(query().has('cursor')).toBe(false);
  }
  // A normal address lookup can also observe the selected carrier changing, without a new head.
  space.realmId = '01a1a000-0000-7000-8000-000000000825';
  await selection.lookup('home-reading-room', 'https://rezics.example');
  await applied;
  expect(selection.snapshot().selected?.realmId).toBe(space.realmId);
  expect(selection.snapshot().changed).toBe(true);
  expect(query().has('cursor')).toBe(false);
  // An unreadable carrier at the same head cannot broaden the selected feed.
  space.realmId = null;
  before = calls.length;
  await selection.refresh();
  expect(selection.snapshot().available).toBe(false);
  expect(selection.snapshot().selected?.spaceId).toBe(space.spaceId);
  expect(feed.snapshot().result.state).toBe('unavailable');
  expect(calls.length - before).toBe(1);
  space.realmId = homeStorySpace.realmId;
  await selection.retry();
  await applied;
  expect(selection.snapshot().available).toBe(true);
  pointStatus = 404;
  await selection.refresh();
  expect(selection.snapshot().available).toBe(false);
  pointStatus = 200;
  await selection.retry();
  await applied;

  let releasePoint!: () => void;
  pausePoint = new Promise<void>((resolve) => {
    releasePoint = resolve;
  });
  const oldPoint = selection.refresh();
  selection.clear();
  await applied;
  expect(query().has('spaceId')).toBe(false);
  expect(query().get('kind')).toBe('schema:Book');
  expect(query().get('ratingQuestionId')).toBe(question);
  releasePoint();
  await oldPoint;
  pausePoint = undefined;
  expect(selection.snapshot().selected).toBeUndefined();
  expect(query().has('spaceId')).toBe(false);

  await selection.lookup('home-reading-room', 'https://rezics.example');
  let releaseFeed!: () => void;
  pauseFeed = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  selection.select();
  const oldFeed = applied;
  selection.clear();
  const clearedFeed = applied;
  expect(feed.snapshot().result.state).toBe('loading');
  releaseFeed();
  await oldFeed;
  await clearedFeed;
  pauseFeed = undefined;
  expect(feed.snapshot().input.spaceId).toBeUndefined();

  // The production viewer remount's cleanup retires both in-flight private feed and Space metadata.
  pausePoint = new Promise<void>((resolve) => {
    releasePoint = resolve;
  });
  const oldLookup = selection.lookup('home-reading-room', 'https://rezics.example');
  await Promise.resolve();
  await Promise.resolve();
  pauseFeed = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  const privatePending = feed.load({ ...selectionInput, spaceId: space.spaceId });
  selection.retire();
  feed.clear();
  viewer = undefined;
  request = new Request('https://rezics.example/en');
  releasePoint();
  releaseFeed();
  await oldLookup;
  await privatePending;
  pausePoint = undefined;
  pauseFeed = undefined;
  expect(selection.snapshot().candidate).toBeUndefined();
  expect(feed.snapshot().result).toEqual(initial);
  expect(feed.snapshot().input).toEqual({ stream: 'home' });
  const beforeMismatch = calls.length;
  expect(await readHomeSpaceChoice({ data: { locale: 'en', viewer: 'viewer-b', spaceId: space.spaceId } })).toEqual({
    status: 'auth',
  });
  expect(calls.length).toBe(beforeMismatch);
  await expect(
    Promise.resolve().then(() => readPublicHomePage({ data: { locale: 'en', spaceId: 'invalid' } })),
  ).rejects.toThrow();
  await expect(
    Promise.resolve().then(() =>
      readPrivateHomePage({ data: { locale: 'en', viewer: 'viewer-a', stream: 'home', ratingQuestionId: 'invalid' } }),
    ),
  ).rejects.toThrow();
  expect(calls.length).toBe(beforeMismatch);

  // Reuse the existing regression's DOM setup and actual default route, not an alternate Home harness.
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const browser = new Window({ url: 'https://rezics.example/en' });
  const globals = {
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
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
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
  const loaded = await client.fetchQuery(homePageQuery('en'));
  const host = browser.document.createElement('div') as unknown as HTMLDivElement;
  browser.document.body.append(host);
  const root = createRoot(host);
  const click = (text: string) =>
    act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === text)!.click();
    });
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  try {
    setLocale('en', { reload: false });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Home />
        </QueryClientProvider>,
      );
    });
    const label = [...host.querySelectorAll('label')].find((node) => node.textContent === m.home_space_label())!;
    const input = host.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!;
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        'home-reading-room',
      );
      input.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
      input.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
    });
    before = calls.length;
    await click(m.home_space_lookup());
    await settle();
    expect(calls.length - before).toBe(2);
    expect(host.textContent).toContain(space.title);
    await click(m.home_space_select());
    await settle();
    expect(query().get('spaceId')).toBe(space.spaceId);
    const oldRealm = space.realmId;
    space.realmId = '01a1a000-0000-7000-8000-000000000824';
    pauseFeed = new Promise<void>((resolve) => {
      releaseFeed = resolve;
    });
    await click(m.home_space_refresh());
    await settle();
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    expect(host.textContent).toContain(m.home_space_changed());
    releaseFeed();
    await settle();
    pauseFeed = undefined;
    expect(query().has('cursor')).toBe(false);
    space.realmId = null;
    await click(m.home_space_refresh());
    await settle();
    expect(host.textContent).toContain(m.home_space_unavailable());
    expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(0);
    space.realmId = oldRealm;
    await click(m.home_space_retry());
    await settle();
    expect(query().get('spaceId')).toBe(space.spaceId);
    await click(m.home_space_clear());
    await settle();
    expect(query().has('spaceId')).toBe(false);
    expect(client.getQueryData(homePageQuery('en').queryKey)).toEqual(loaded);
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((entry) => entry.queryKey[0] === 'home-page'),
    ).toHaveLength(1);
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
