import { mock } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../../.storybook/react-start';
import { arcId } from '../../src/features/catalogue/story-arc-reader/examples';

// Installed before the reader loads; test files import this helper instead of another test file.
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

export async function ui() {
  const { StoryArcReader } = await import('../../src/features/catalogue/story-arc-reader/view');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.example/en/subjects/${arcId}/harbour-arc` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out' });
  const render = async (props: Parameters<typeof StoryArcReader>[0]) => {
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(StoryArcReader, props))),
    );
  };
  const click = async (label: string, scope: ParentNode = host, detail = 0) => {
    const button = Array.from(scope.querySelectorAll('button')).find((node) =>
      node.textContent?.trim().startsWith(label),
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    button.focus();
    await act(async () => button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail })));
    return button;
  };
  const close = async () => {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  };
  return { host, client, render, click, close };
}
