import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useLayoutEffect, useState } from 'react';
import { PageReadError } from '../src/features/pages/page-read-failure';
import { m } from '../src/paraglide/messages.js';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/subjects/one' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useLoaderData } =
  await import('@tanstack/react-router');
const { CurrentReadingHead, CurrentReadingOutlet, currentReadingTags, publicReadingWithdrawn } =
  await import('../src/shell/current-reading');
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('withdrawal keeps infrastructure and removes every reader-owned metadata form', () => {
  const tags = [
    { tag: 'meta', attrs: { charSet: 'utf-8' } },
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width' } },
    { tag: 'link', attrs: { rel: 'stylesheet', href: '/assets/app.css' } },
    { tag: 'title', children: 'Retired title' },
    { tag: 'meta', attrs: { name: 'description', content: 'Retired description' } },
    { tag: 'meta', attrs: { property: 'og:image', content: '/retired-card' } },
    { tag: 'link', attrs: { rel: 'canonical', href: '/retired' } },
    { tag: 'link', attrs: { rel: 'preload', as: 'image', href: '/retired-cover' } },
    { tag: 'script', attrs: { type: 'application/ld+json' }, children: '{"name":"retired"}' },
  ] as Parameters<typeof currentReadingTags>[0];
  expect(currentReadingTags(tags, false)).toEqual(tags);
  expect(currentReadingTags(tags, true)).toEqual(tags.slice(0, 3));
  for (const pathname of ['/en', '/ja/subjects/one/title', '/fr/collections/one', '/de/search/list', '/es/@reader']) {
    expect(publicReadingWithdrawn({ pathname, isLoading: true, matches: [{ status: 'success' }] })).toBe(true);
    expect(publicReadingWithdrawn({ pathname, isLoading: false, matches: [{ status: 'error' }] })).toBe(true);
    expect(publicReadingWithdrawn({ pathname, isLoading: false, matches: [{ status: 'success' }] })).toBe(false);
  }
  expect(publicReadingWithdrawn({ pathname: '/en/settings', isLoading: true, matches: [] })).toBe(false);
});

test('the production router boundary withdraws content, metadata and callbacks and admits only the replacement', async () => {
  let load = async () => ({ label: 'Old reading', cursor: 'old-native-frontier' });
  let callback: (() => Promise<void>) | undefined;
  const late = deferred<string>();
  const retired: string[] = [];
  function Reading() {
    const data = useLoaderData({ strict: false }) as { label: string; cursor: string };
    const [completion, setCompletion] = useState('');
    useLayoutEffect(() => {
      let live = true;
      callback = async () => {
        const result = await late.promise;
        if (live) setCompletion(result);
      };
      return () => {
        live = false;
        retired.push(data.cursor);
      };
    }, [data]);
    return (
      <section>
        <h1>{data.label}</h1>
        <a href={`?cursor=${data.cursor}`}>Next</a>
        <p>{completion}</p>
      </section>
    );
  }
  const rootRoute = createRootRoute({
    component: () => (
      <>
        <CurrentReadingHead />
        <CurrentReadingOutlet />
      </>
    ),
    errorComponent: () => <p role="alert">Native owner unavailable</p>,
  });
  const reading = createRoute({
    getParentRoute: () => rootRoute,
    path: '/subjects/$id',
    loader: () => load(),
    component: Reading,
    errorComponent: () => <p role="alert">Native owner unavailable</p>,
    head: ({ loaderData }) => ({
      meta: [{ title: loaderData?.label }, { name: 'description', content: loaderData?.label }],
      links: [{ rel: 'canonical', href: '/subjects/one' }],
    }),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([reading]),
    history: createMemoryHistory({ initialEntries: ['/subjects/one'] }),
    defaultPendingMs: 10_000,
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await router.load();
    await act(async () => {
      root.render(<RouterProvider router={router} />);
    });
    expect(host.textContent).toContain('Old reading');
    expect(document.title).toBe('Old reading');
    const oldCallback = callback!;
    const oldCompletion = oldCallback();
    const replacement = deferred<{ label: string; cursor: string }>();
    load = () => replacement.promise;
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = router.invalidate({ sync: true });
    });
    expect(host.textContent).not.toContain('Old reading');
    expect(host.querySelector('a[href*="old-native-frontier"]')).toBeNull();
    expect(document.title).not.toBe('Old reading');
    expect(document.querySelector('meta[name="description"]')).toBeNull();
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(retired).toContain('old-native-frontier');
    await act(async () => {
      late.resolve('Retired completion');
      await oldCompletion;
      replacement.resolve({ label: 'Current reading', cursor: 'new-native-frontier' });
      await refresh;
    });
    expect(host.textContent).toContain('Current reading');
    expect(host.textContent).not.toContain('Retired completion');
    expect(document.title).toBe('Current reading');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('?cursor=new-native-frontier');
    load = async () => {
      throw new PageReadError('dependency_unavailable', 503, '1');
    };
    await act(async () => {
      await router.invalidate({ sync: true });
    });
    expect(host.textContent).toContain('Native owner unavailable');
    expect(host.textContent).not.toContain('Current reading');
    expect(document.title).toBe(m.dependency_unavailable_heading());
    expect(document.querySelector('meta[name="description"]')).toBeNull();
    load = async () => ({ label: 'Recovered reading', cursor: 'recovered-native-frontier' });
    await act(async () => {
      await router.invalidate({ sync: true });
    });
    expect(host.textContent).toContain('Recovered reading');
    expect(document.title).toBe('Recovered reading');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('?cursor=recovered-native-frontier');
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
