import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('../src/search/realm-discovery-section', () => ({ SearchRealmDiscoverySection: () => null }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const { RecentPanel } = await import('../src/search/recent-panel');
const { readTrendingSearches, trendingResponse } = await import('../src/search/trending');
const { m } = await import('../src/paraglide/messages.js');
const viewer = (csrfToken = 'first') => ({ state: 'signed-in', subject: 'reader', csrfToken });
const page = (display: string, count = 1) => ({
  next: null,
  trendingSearches: Array.from({ length: count }, (_, i) => ({ query: `query-${i}`, display })),
});

test('mounted Search retries manually, respects delays and fences session/locale responses', async () => {
  const window = new Window({ url: 'https://site.test/en/search' });
  const calls: { url: string; signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => calls.push({ url, signal: init.signal!, resolve })),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  const selected: string[] = [];
  const render = (language = 'en') =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RecentPanel language={language} onQuery={(query) => selected.push(query)} />
        </QueryClientProvider>,
      ),
    );
  const region = () => host.querySelector('[data-trending-searches]')!;
  const retry = () =>
    Array.from(region().querySelectorAll('button')).find((button) => button.textContent === m.search_facet_retry())!;
  const click = (button = retry()) => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const settle = (body: unknown, status = 200, headers?: HeadersInit) =>
    act(async () => calls.at(-1)!.resolve(Response.json(body, { status, headers })));
  try {
    client.setQueryData(['session'], viewer());
    await render();
    expect(calls).toHaveLength(1);
    for (const code of ['semantic_not_ready', 'index_not_ready', 'dependency_unavailable']) {
      await settle({ code }, 503);
      expect(region().textContent).toContain(
        code === 'dependency_unavailable' ? m.trending_unavailable() : m.discovery_not_ready(),
      );
      const count = calls.length;
      await act(async () => {
        click();
        click();
      });
      expect(calls).toHaveLength(count + 1);
      expect(retry().disabled).toBe(true);
    }
    const clock = Date.now;
    let now = clock();
    Date.now = () => now;
    try {
      await settle({ code: 'index_not_ready' }, 503, { 'retry-after': '1' });
      expect(retry().disabled).toBe(true);
      const count = calls.length;
      await act(async () => click());
      expect(calls).toHaveLength(count);
      now += 1001;
      await render();
      expect(retry().disabled).toBe(false);
      expect(calls).toHaveLength(count);
      await act(async () => click());
    } finally {
      Date.now = clock;
    }
    await settle(page('Too many', 11));
    expect(region().textContent).toContain(m.trending_unavailable());
    await act(async () => click());
    await settle(page('Current term', 10));
    expect(region().querySelectorAll('li')).toHaveLength(10);
    await act(async () => click(region().querySelector('li button')!));
    expect(selected).toEqual(['query-0']);
    // Retire a displayed term before React flushes a batched A-B-A transition.
    const oldButton = region().querySelector('li button')!;
    await act(async () => {
      client.setQueryData(['session'], viewer('other'));
      client.setQueryData(['session'], viewer());
      click(oldButton);
    });
    expect(selected).toEqual(['query-0']);
    expect(region().textContent).not.toContain('Current term');
    for (const session of [
      viewer('rotated'),
      { state: 'unavailable', csrfToken: null },
      { state: 'signed-out', csrfToken: null },
    ]) {
      const old = calls.at(-1)!;
      const count = calls.length;
      await act(async () => {
        client.setQueryData(['session'], session);
        old.resolve(Response.json(page('Late session')));
      });
      expect(old.signal.aborted).toBe(true);
      expect(region().textContent).not.toContain('Late session');
      expect(calls.length).toBe(count + (session.state === 'unavailable' ? 0 : 1));
    }
    const old = calls.at(-1)!;
    await render('zh-Hans');
    await act(async () => old.resolve(Response.json(page('Late locale'))));
    expect(old.signal.aborted).toBe(true);
    expect(region().textContent).not.toContain('Late locale');
    expect(calls.at(-1)!.url).toContain('language=zh-Hans');
    await settle(page('Empty', 0));
    expect(region().textContent).toContain(m.trending_empty());
    expect(region().querySelector('button')).toBeNull();
  } finally {
    const pending = calls.at(-1)!;
    await act(async () => root.unmount());
    expect(pending.signal.aborted).toBe(true);
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('native retry timing survives the BFF error response with one current-credential request', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ code: 'semantic_not_ready' }, { status: 503, headers: { 'retry-after': '7' } });
    },
  });
  const response = await trendingResponse(new Request('https://site.test/api/search/trending?language=en'), {}, () =>
    readTrendingSearches(client, 'en', 'Bearer current', new AbortController().signal),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('7');
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current');
  expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('10');
});
