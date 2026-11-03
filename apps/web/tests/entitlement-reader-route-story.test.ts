import { afterAll, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://rezics.test/en' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLAnchorElement: window.HTMLAnchorElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const originalFetch = globalThis.fetch;
const workers = await import('../.storybook/cloudflare-workers');
const start = await import('../.storybook/react-start');
mock.module('cloudflare:workers', () => workers);
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { ReaderUnavailable } = await import('../src/stories/entitlement.stories');
const { setLocale, getLocale } = await import('../src/paraglide/runtime.js');
const { createRoot } = await import('react-dom/client');

afterAll(async () => {
  globalThis.fetch = originalFetch;
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('ReaderUnavailable follows the localized entitlement link into the actual edition route', async () => {
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const context = {} as never;
  const cleanup = await ReaderUnavailable.beforeEach?.(context);
  try {
    const element = ReaderUnavailable.render?.({} as never, context);
    if (!element || !ReaderUnavailable.play) throw new Error('ReaderUnavailable must mount and exercise its PageStory');
    await act(async () => root.render(element as ReactNode));
    await ReaderUnavailable.play({ canvasElement: host } as never);
  } finally {
    await cleanup?.();
    await act(async () => root.unmount());
    host.remove();
    setLocale(oldLocale, { reload: false });
  }
});
