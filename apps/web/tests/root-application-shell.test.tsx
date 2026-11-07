import { afterAll, expect, mock, test } from 'bun:test';
import { act } from 'react';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url', () => ({
  default: '/manrope.woff2',
}));

const { Window } = await import('happy-dom');
const window = new Window({ url: 'https://site.test/en' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });

let currentSession: { state: 'signed-out' | 'signed-in'; subject?: string; csrfToken: string | null } = {
  state: 'signed-out',
  csrfToken: null,
};
mock.module('../src/shell/community-navigation-actions', () => ({
  readShellCommunities: async () => {
    if (currentSession.state !== 'signed-in' || !currentSession.subject) return null;
    const subject = currentSession.subject;
    return {
      subject,
      locale: 'en',
      items: [{ id: subject, kind: 'space', title: `${subject} followed space`, path: `/spaces/${subject}` }],
      more: false,
    };
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
const { Root } = await import('../src/routes/__root');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterAll(async () => {
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  mock.restore();
});

test('the installed root shell renders anonymously and follows admitted viewer replacement', async () => {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  currentSession = { state: 'signed-out', csrfToken: null };
  client.setQueryData(sessionQuery.queryKey, currentSession);
  client.setQueryData(['exposure', 'anonymous'], { state: 'ready', admitted: ['personal_library'] });

  const route = createRootRouteWithContext<{
    queryClient: InstanceType<typeof QueryClient>;
    credentialMode: 'anonymous' | 'session';
  }>()({
    component: () => (
      <Root>
        <h1>Ordinary root page</h1>
      </Root>
    ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en'] }),
    context: { queryClient: client, credentialMode: 'anonymous' },
  });
  const host = window.document;
  const root = createRoot(host);
  const render = () => (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const admit = (subject: string) => {
    const snapshot = viewerExposureLifetime(client).getSnapshot();
    if (snapshot.state !== 'signed-in' || snapshot.observation.subject !== subject)
      throw new Error(`Expected the installed reader observation for ${subject}`);
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject,
      state: 'ready',
      admitted: ['personal_library'],
    });
  };

  try {
    await act(async () => {
      root.render(render());
      await router.load();
      await settle();
    });
    expect(host.querySelector('h1')?.textContent).toBe('Ordinary root page');
    expect(host.querySelector('a[href^="/auth/sign-in?"]')).not.toBeNull();
    expect(host.querySelector('a[href="/en/spaces/anonymous"]')).toBeNull();

    await act(async () => {
      currentSession = { state: 'signed-in', subject: 'viewer-a', csrfToken: 'csrf-a' };
      client.setQueryData(sessionQuery.queryKey, currentSession);
      admit('viewer-a');
      await settle();
    });
    expect(host.querySelector('a[href="/en/spaces/viewer-a"]')?.textContent).toContain('viewer-a followed space');

    await act(async () => {
      currentSession = { state: 'signed-in', subject: 'viewer-b', csrfToken: 'csrf-b' };
      client.setQueryData(sessionQuery.queryKey, currentSession);
      admit('viewer-b');
      await settle();
    });
    expect(host.querySelector('a[href="/en/spaces/viewer-b"]')?.textContent).toContain('viewer-b followed space');
    expect(host.querySelector('a[href="/en/spaces/viewer-a"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
  }
});
