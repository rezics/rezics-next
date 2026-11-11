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

let currentSession: { state: 'signed-out' | 'signed-in' | 'unavailable'; subject?: string; csrfToken: string | null } =
  {
    state: 'signed-out',
    csrfToken: null,
  };
let communityReads = 0;
mock.module('../src/shell/community-navigation-actions', () => ({
  readShellCommunities: async () => {
    communityReads++;
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
  let ready!: (value: typeof currentSession) => void;
  const prepared = new Promise<typeof currentSession>((resolve) => {
    ready = resolve;
  });
  const preparation = client.fetchQuery({ ...sessionQuery, queryFn: () => prepared });
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
    history: createMemoryHistory({ initialEntries: ['/en?q=Prince&cursor=next%2Fpage#shelf'] }),
    context: { queryClient: client, credentialMode: 'anonymous' },
  });
  const host = window.document;
  const root = createRoot(host);
  const render = () => (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const flushMenu = async () => {
    await frame();
    await frame();
    await settle();
  };
  const createTrigger = (surface: 'header' | 'phone') => {
    const scope = host.querySelector(surface === 'header' ? 'header' : '[data-phone-navigation]')!;
    return [...scope.querySelectorAll('button')].find(
      (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === 'Create',
    )!;
  };
  const openCreate = async (surface: 'header' | 'phone') => {
    const trigger = createTrigger(surface);
    await act(async () => {
      trigger.focus();
      trigger.click();
    });
    await act(flushMenu);
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(panel).not.toBeNull();
    return { trigger, panel };
  };
  const dismiss = async (trigger: HTMLElement) => {
    await act(async () => {
      host.activeElement?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(flushMenu);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.activeElement).toBe(trigger);
  };
  const signIn = '/auth/sign-in?return_to=%2Fen%3Fq%3DPrince%26cursor%3Dnext%252Fpage';
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
    expect(host.querySelector('[data-session-pending]')).not.toBeNull();
    expect(communityReads).toBe(0);
    window.happyDOM.setWindowSize({ width: 390, height: 844 });
    const preparing = await openCreate('phone');
    expect(preparing.panel.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(preparing.panel.querySelector('a')).toBeNull();
    await act(async () => {
      ready(currentSession);
      await preparation;
      await settle();
    });
    expect(preparing.panel.querySelector('a')?.getAttribute('href')).toBe(signIn);
    await dismiss(preparing.trigger);
    for (const surface of ['header', 'phone'] as const) {
      window.happyDOM.setWindowSize({ width: surface === 'header' ? 1280 : 390, height: 900 });
      const { trigger, panel } = await openCreate(surface);
      expect(panel.querySelector('a')?.getAttribute('href')).toBe(signIn);
      await dismiss(trigger);
    }
    expect(host.querySelector('a[href^="/auth/sign-in?"]')).not.toBeNull();
    expect(host.querySelector('a[href="/en/spaces/anonymous"]')).toBeNull();
    await act(async () => {
      currentSession = { state: 'unavailable', csrfToken: null };
      client.setQueryData(sessionQuery.queryKey, currentSession);
      await settle();
    });
    const failed = await openCreate('phone');
    expect(failed.panel.textContent).toContain('Account status unavailable');
    expect(failed.panel.querySelector('a')?.getAttribute('href')).toBe(signIn);
    expect(communityReads).toBe(0);
    await dismiss(failed.trigger);

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
    const focused = createTrigger('phone');
    focused.focus();
    await act(async () => {
      await router.navigate({ href: '/en?q=Next#shelf' });
      await settle();
    });
    expect(host.activeElement).toBe(focused);
  } finally {
    ready(currentSession);
    await preparation;
    await act(async () => root.unmount());
    client.clear();
  }
});
