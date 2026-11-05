import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';

test('reply focus is delivered once, cancelled by movement or retirement, and honors a later request', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/thread', width: 1280, height: 900 });
  let richReady = false;
  let focuses = 0;
  let scrolls = 0;
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@rezics/ui', () => ({
    RichTextEditor: () => {
      const props = {
        className: richReady ? 'ProseMirror' : 'fallback-editor',
        contentEditable: true,
        ref: (node: HTMLElement | null) => {
          if (node) {
            node.focus = () => focuses++;
            node.scrollIntoView = () => scrolls++;
          }
        },
      };
      return richReady ? createElement('div', props) : createElement('section', props);
    },
  }));
  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    { createMemoryHistory, createRootRoute, createRouter, RouterProvider },
    { AuthoringDepartureProvider },
    { ThreadReplyComposer },
    { sessionQuery },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/threads/authoring-departure'),
    import('../src/threads/reply-context-composer'),
    import('../src/session/query'),
  ]);
  type Props = Parameters<typeof ThreadReplyComposer>[0];
  const initial: Props = {
    initialKey: 'reply-focus-key',
    containerId: 'thread-1',
    parentId: null,
    parents: new Map(),
    pending: false,
    onCancel: () => undefined,
    focusRequest: 1,
    onPendingChange: () => undefined,
    onSubmit: async () => ({ ok: true, value: {} as never }),
    onSuccess: () => undefined,
  };
  let update!: (props: Props, epoch?: number) => void;
  const Harness = () => {
    const [view, setView] = useState({ props: initial, epoch: 0 });
    update = (props, epoch = view.epoch) => setView({ props, epoch });
    return createElement(ThreadReplyComposer, { ...view.props, key: view.epoch });
  };
  const route = createRootRoute({
    component: () => createElement(AuthoringDepartureProvider, null, createElement(Harness)),
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'user-1', csrfToken: 'token-1' });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
    );
    expect(focuses).toBe(0);
    await act(async () => {
      window.document.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    });
    await act(async () => update({ ...initial, focusRequest: 2 }));
    expect(focuses).toBe(0);
    richReady = true;
    await act(async () => {
      update({ ...initial, focusRequest: 2 });
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(focuses).toBe(1);
    expect(scrolls).toBe(1);
    await act(async () =>
      update({ ...initial, focusRequest: 2, onSubmit: async () => ({ ok: true, value: {} as never }) }),
    );
    expect(focuses).toBe(1);
    await act(async () => update({ ...initial, focusRequest: 3 }));
    expect(focuses).toBe(2);
    expect(scrolls).toBe(2);
    richReady = false;
    await act(async () => update(initial, 1));
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    richReady = true;
    await act(async () => {
      update(initial, 1);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(focuses).toBe(2);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
