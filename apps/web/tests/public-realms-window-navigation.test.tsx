import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { profilePage } from '../src/stories/pages/accounts-public-profile/fixtures';
import { m } from '../src/paraglide/messages.js';

let transport: typeof fetch;
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => new Request('https://rezics.test/'),
}));
mock.module('../src/kernel/client', () => ({
  kernelClient: () => createKernelClient('https://kernel.test', { fetch: (...args) => transport(...args) }),
}));

export async function setup(entry = '/en/@mira/realms?keep=a%20b&keep=%2f#reading') {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://rezics.test${entry}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const [{ Route }, { createRoot }, { realmsVisit }] = await Promise.all([
    import('../src/routes/@{$handle}_.$view'),
    import('react-dom/client'),
    import('../src/accounts/public-profile/realm-windows/visit'),
  ]);
  const page = profilePage();
  page.account!.handle = 'mira';
  const calls: Array<string | null> = [];
  let state = 200;
  let published = true;
  let gate: { promise: Promise<void>; release: () => void } | undefined;
  transport = (async (input, init) => {
    const request = new Request(input, init);
    expect(request.headers.has('authorization')).toBe(false);
    const url = new URL(request.url);
    if (request.method === 'POST') {
      const copy = structuredClone(page);
      for (const read of Object.values(copy.reads)) {
        const body = read.body as { accounts?: Array<{ publicViews: { realms: boolean } }> };
        for (const account of body.accounts ?? []) account.publicViews.realms = published;
      }
      return Response.json({ ...copy, account: copy.account!.id });
    }
    if (url.pathname.startsWith('/v1/realms/'))
      return Response.json({ realm: { title: 'Current Realm', summary: 'Disclosed summary' } });
    if (url.pathname.endsWith('/realms')) {
      const cursor = url.searchParams.get('cursor');
      expect(url.searchParams.get('limit')).toBe('20');
      calls.push(cursor);
      const held = gate;
      gate = undefined;
      if (held) await held.promise; // Deliberately ignore cancellation to test retired responses.
      if (state !== 200) return Response.json({}, { status: state });
      const index = cursor === null ? 0 : Number(cursor.slice(1));
      return Response.json({
        realms: index === 12 ? [] : [{ id: 'current', role: 'member' }],
        next: index === 12 ? null : `c${index + 1}`,
      });
    }
    return Response.json({ accounts: [] });
  }) as typeof fetch;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  Route.update({ id: '/@{$handle}_/$view', path: '/en/@{$handle}/$view', getParentRoute: () => rootRoute } as never);
  const history = createMemoryHistory({ initialEntries: [entry] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([Route]),
    history,
    context: { queryClient },
    defaultPendingMs: 10000,
    parseSearch: (value) => Object.fromEntries(new URLSearchParams(value)),
    stringifySearch: (value) => {
      const text = new URLSearchParams(value as Record<string, string>).toString();
      return text ? `?${text}` : '';
    },
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    await router.load();
    root.render(createElement(RouterProvider, { router }));
  });
  const link = (label: string) => [...host.querySelectorAll('a')].find((node) => node.textContent === label);
  const click = async (label: string, focus = false) => {
    const node = link(label) ?? [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
    expect(node).toBeDefined();
    await act(async () => {
      if (focus) node.focus();
      node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  return {
    host,
    calls,
    router,
    link,
    click,
    visit: () => realmsVisit(router),
    queryClient,
    state: (value: number) => {
      state = value;
    },
    publish: (value: boolean) => {
      published = value;
    },
    hold: () => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
      return release;
    },
    close: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.happyDOM.abort();
    },
  };
}

test('production route remounts reread Next, Previous and First with bounded admitted-only coordinates and exact addresses', async () => {
  const app = await setup();
  try {
    const article = app.host.querySelector('article');
    expect(app.link(m.music_context_previous_page())).toBeUndefined();
    await app.click(m.public_account_next(), true);
    expect(app.host.querySelector('article')).not.toBe(article);
    expect(app.host.ownerDocument.activeElement).toBe(app.host.querySelector('article'));
    expect(app.link(m.music_context_previous_page())?.getAttribute('href')).toBe(
      '/en/@mira/realms?keep=a%20b&keep=%2f#reading',
    );
    await app.click(m.music_context_previous_page());
    expect(app.calls).toEqual([null, 'c1', null]);
    for (let index = 0; index < 12; index++) await app.click(m.public_account_next());
    expect(app.visit().coordinates).toEqual(['c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12']);
    expect(app.host.textContent).toContain(m.public_account_realms_empty());
    expect(app.link(m.public_account_next())).toBeUndefined();
    await app.click(m.public_account_start_again());
    expect(app.calls.at(-1)).toBeNull();
    expect(app.router.state.location.href).toBe('/en/@mira/realms?keep=a%20b&keep=%2f#reading');
    expect(app.link('Current Realm')?.getAttribute('href')).toBe('/en/realms/current');
    expect(app.visit().coordinates).toEqual([undefined]);
    expect(app.queryClient.getQueryCache().getAll()).toHaveLength(0);
  } finally {
    await app.close();
  }
});
