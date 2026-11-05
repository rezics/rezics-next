import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
import type { ManagedWatch, WatchManagementIO, WatchRead } from '../src/settings/watch-native';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings#watches' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  void window.happyDOM.close();
});
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { SettingsSessionOwner, SettingsSessionContext } = await import('../src/settings/settings-session-owner');
const { WatchesSection } = await import('../src/settings/watches');
const { SettingsWatchesOwner } = await import('../src/settings/settings-page');
const { SettingsNavigationProvider, useSettingsNavigationDraft } = await import('../src/settings/reading-navigation');
const { createBrowserHistory, createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
const { m } = await import('../src/paraglide/messages.js');

test('the mounted private view separates inaccessible targets, uncertain removal, sparse/empty pages and refresh failure', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf' });
  const owner = new SettingsSessionOwner(client, 'csrf', 'alice');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const envelope = {
    viewer: { state: 'current' as const, accountId: 'alice' },
    actions: { remove: 'available' as const },
  };
  const row = (
    watch: Omit<ManagedWatch, 'command' | 'remove'> & Partial<Pick<ManagedWatch, 'command' | 'remove'>>,
  ): ManagedWatch => ({
    ...watch,
    command: watch.command ?? {
      watchId: watch.subscriptionId,
      kind: watch.kind,
      expectedRevision: watch.revision,
    },
    remove: watch.remove ?? 'available',
  });
  let response: WatchRead = {
    kind: 'page',
    page: {
      ...envelope,
      watches: [
        row({
          subscriptionId: 'hidden-owner-id',
          kind: 'thread',
          revision: 8,
          createdAt: '2026-11-02T10:00:00.000Z',
          target: null,
        }),
        row({
          subscriptionId: 'readable-owner-id',
          kind: 'thread',
          revision: 9,
          createdAt: '2026-11-03T10:00:00.000Z',
          target: { title: 'Readable thread', href: '/threads/a/readable' },
        }),
      ],
      next: null,
    },
  };
  let fail = false;
  let writes = 0;
  const io: WatchManagementIO = {
    read: async () => {
      if (fail) throw new Error('offline');
      return response;
    },
    stop: async () => {
      writes++;
      return writes === 1
        ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } }
        : writes === 2
          ? { kind: 'denied', problem: { status: 403, code: 'forbidden' } }
          : { kind: 'removed' };
    },
  };
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SettingsSessionContext.Provider value={owner}>
            <WatchesSection io={io} />
          </SettingsSessionContext.Provider>
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector('h2')?.textContent).toBe(m.settings_watches_heading());
    expect(host.textContent).toContain(m.settings_watches_access_lost());
    expect(host.textContent).not.toContain('hidden-owner-id');
    expect(host.querySelectorAll('a')).toHaveLength(1);
    await click(m.settings_watches_stop());
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    expect(host.textContent).not.toContain(m.settings_watches_removed());
    fail = true;
    await click(m.settings_watches_refresh());
    const retryButton = () =>
      [...host.querySelectorAll('button')].find((item) => item.textContent === m.settings_watches_retry_original())!;
    expect(host.textContent).toContain(m.settings_watches_failed_text());
    expect(retryButton().disabled).toBe(true);
    fail = false;
    response = { kind: 'page', page: { ...envelope, actions: { remove: 'denied' }, watches: [], next: null } };
    await click(m.settings_retry());
    expect(host.textContent).toContain(m.settings_watches_remove_denied());
    expect(retryButton().disabled).toBe(true);
    response = {
      kind: 'page',
      page: {
        ...envelope,
        watches: [
          row({
            subscriptionId: 'hidden-owner-id',
            kind: 'thread',
            revision: 10,
            createdAt: '2026-11-05T10:00:00.000Z',
            target: { title: 'Current thread', href: '/threads/current' },
          }),
        ],
        next: null,
      },
    };
    await click(m.settings_watches_refresh());
    expect(retryButton().disabled).toBe(false);
    await click(m.settings_watches_retry_original());
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    expect(host.textContent).toContain(m.settings_watches_denied());
    expect(host.querySelector('[data-response-code="forbidden"]')).toBeTruthy();
    expect(host.querySelector('a[href="/threads/current"]')).toBeNull();
    response = { kind: 'page', page: { ...envelope, actions: { remove: 'denied' }, watches: [], next: null } };
    await click(m.settings_retry());
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    expect(host.textContent).toContain(m.settings_watches_remove_denied());
    expect(retryButton().disabled).toBe(true);
    response = {
      kind: 'page',
      page: {
        ...envelope,
        watches: [
          row({
            subscriptionId: 'hidden-owner-id',
            kind: 'thread',
            revision: 10,
            createdAt: '2026-11-05T10:00:00.000Z',
            target: { title: 'Current thread', href: '/threads/current' },
          }),
        ],
        next: null,
      },
    };
    await click(m.settings_watches_refresh());
    expect(retryButton().disabled).toBe(false);
    await click(m.settings_watches_retry_original());
    expect(host.textContent).toContain(m.settings_watches_removed_current());
    expect(host.textContent).not.toContain(m.settings_watches_access_lost());
    expect(host.querySelector('a[href="/threads/current"]')?.textContent).toBe('Current thread');
    const currentStop = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === m.settings_watches_stop(),
    );
    expect(currentStop?.disabled).toBe(false);
    await click(m.settings_watches_stop());
    expect(host.textContent).toContain(m.settings_watches_removed());
    response = { kind: 'page', page: { ...envelope, watches: [], next: 'opaque' } };
    await click(m.settings_watches_refresh());
    expect(host.textContent).toContain(m.settings_watches_sparse());
    expect(host.textContent).not.toContain(m.settings_watches_empty());
    response = { kind: 'page', page: { ...envelope, watches: [], next: null } };
    await click(m.settings_watches_next());
    expect(host.textContent).toContain(m.settings_watches_end());
    await click(m.settings_watches_first());
    expect(host.textContent).toContain(m.settings_watches_empty());
    fail = true;
    await click(m.settings_watches_refresh());
    expect(host.textContent).toContain(m.settings_watches_failed_text());
    expect(host.textContent).not.toContain(m.settings_watches_empty());
    fail = false;
    response = { kind: 'unavailable', problem: { status: 503, code: 'dependency_unavailable' } };
    await click(m.settings_retry());
    expect(host.textContent).toContain(m.settings_watches_unavailable());
    expect(host.querySelector('[data-response-code="dependency_unavailable"]')).toBeTruthy();
    response = { kind: 'invalid_cursor', problem: { status: 400, code: 'invalid_cursor' } };
    await click(m.settings_retry());
    expect(host.textContent).toContain(m.settings_watches_invalid_cursor());
    response = { kind: 'page', page: { ...envelope, actions: { remove: 'denied' }, watches: [], next: null } };
    await click(m.settings_watches_restart());
    expect(host.textContent).toContain(m.settings_watches_remove_denied());
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob' }),
    );
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});

test('a disclosed later-page visit returns to its exact current window without scanning', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf' });
  const owner = new SettingsSessionOwner(client, 'csrf', 'alice');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  window.history.replaceState({}, '', '/en/settings#watches');
  const requests: { kind: string; cursor: string | null }[] = [];
  const attempted: Parameters<WatchManagementIO['stop']>[0][] = [];
  const watch = (subscriptionId: string, revision: number, target: ManagedWatch['target']): ManagedWatch => ({
    subscriptionId,
    kind: 'thread',
    revision,
    createdAt: '2026-11-03T10:00:00.000Z',
    command: { watchId: subscriptionId, kind: 'thread', expectedRevision: revision },
    remove: 'available',
    target,
  });
  const first = watch('first-window', 2, { title: 'First thread', href: '/threads/a/first' });
  const visited = watch('visited-window', 7, { title: 'Later thread', href: '/threads/a/later' });
  const concealedOnReturn = watch('concealed-on-return', 8, { title: 'Second target', href: '/threads/a/second' });
  const absentOnReturn = watch('absent-on-return', 9, { title: 'Third target', href: '/threads/a/third' });
  let laterRows: readonly ManagedWatch[] = [visited, concealedOnReturn, absentOnReturn];
  const io: WatchManagementIO = {
    read: async ({ kind, cursor }) => {
      requests.push({ kind, cursor });
      return {
        kind: 'page',
        page: {
          viewer: { state: 'current', accountId: 'alice' },
          actions: { remove: 'available' },
          watches: cursor === null ? [first] : laterRows,
          next: cursor === null ? 'later-window' : null,
        },
      };
    },
    stop: async (intent) => {
      attempted.push(intent);
      return attempted.length === 1
        ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } }
        : { kind: 'removed' };
    },
  };
  const base = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => base,
    path: '/settings',
    component: () => (
      <SettingsNavigationProvider>
        <SettingsWatchesOwner io={io} />
      </SettingsNavigationProvider>
    ),
  });
  const target = createRoute({
    getParentRoute: () => base,
    path: '/threads/$threadId/$slug',
    component: () => <p>Thread target</p>,
  });
  window.history.replaceState(null, '', '/settings#watches');
  const router = createRouter({
    routeTree: base.addChildren([settings, target]),
    history: createBrowserHistory({ window: window as unknown as globalThis.Window }),
  });
  const root = createRoot(host as unknown as HTMLElement);
  const link = (label: string) => {
    const found = [...host.querySelectorAll('a')].find((item) => item.textContent === label);
    expect(found).toBeDefined();
    return found!;
  };
  const button = (label: string) => {
    const found = [...window.document.querySelectorAll('button')].find((item) => item.textContent === label);
    expect(found).toBeDefined();
    return found!;
  };
  const back = async () => {
    await new Promise<void>((resolve) => {
      window.addEventListener('popstate', () => resolve(), { once: true });
      router.history.back();
    });
    await router.load();
  };
  const visitAndReturn = async (label: string) => {
    await act(async () => link(label).click());
    expect(host.textContent).toContain('Thread target');
    await act(async () => back());
    expect(router.state.location.pathname).toBe('/settings');
    expect(host.querySelector('h2')?.textContent).toBe(m.settings_watches_heading());
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <SettingsSessionContext.Provider value={owner}>
            <RouterProvider router={router} />
          </SettingsSessionContext.Provider>
        </QueryClientProvider>,
      );
    });
    await act(async () => button(m.settings_watches_next()).click());
    expect(requests).toEqual([
      { kind: 'thread', cursor: null },
      { kind: 'thread', cursor: 'later-window' },
    ]);
    expect(link('Later thread').getAttribute('href')).toBe('/threads/a/later');

    await act(async () => button(m.settings_watches_stop()).click());
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    await act(async () => link('Later thread').click());
    expect(window.document.querySelector('[role="alertdialog"]')?.textContent).toContain(m.settings_watches_leave_title());
    await act(async () => button(m.settings_profile_stay()).click());
    expect(router.state.location.pathname).toBe('/settings');
    expect((window.history.state as Record<string, unknown>).__rezicsSettingsWatchReturn).toBeUndefined();
    await act(async () => link('Later thread').click());
    await act(async () => button(m.settings_profile_leave()).click());
    expect(host.textContent).toContain('Thread target');
    await act(async () => back());
    expect(router.state.location.pathname).toBe('/settings');
    expect(host.querySelector('h2')?.textContent).toBe(m.settings_watches_heading());
    expect((window.history.state as Record<string, unknown>).__rezicsSettingsWatchReturn).toBeUndefined();

    expect(host.textContent).toContain(m.settings_watches_returned());
    expect(requests.at(-1)).toEqual({ kind: 'thread', cursor: 'later-window' });
    expect(button(m.settings_watches_previous())).toBeTruthy();
    expect(link('Later thread')).toBeTruthy();
    await act(async () => button(m.settings_watches_stop()).click());
    expect(attempted[0]).toMatchObject({ watchId: 'visited-window', kind: 'thread', expectedRevision: 7 });
    expect(attempted[1]).toMatchObject({ watchId: 'visited-window', kind: 'thread', expectedRevision: 7 });
    expect(attempted[1]?.idempotencyKey).not.toBe(attempted[0]?.idempotencyKey);

    laterRows = [watch('concealed-on-return', 8, null), absentOnReturn];
    await visitAndReturn('Second target');
    expect(host.textContent).toContain(m.settings_watches_return_missing());
    expect(link('Third target')).toBeTruthy();
    expect([...host.querySelectorAll('a')].some((item) => item.textContent === 'Second target')).toBe(false);

    laterRows = [];
    await visitAndReturn('Third target');
    expect(host.textContent).toContain(m.settings_watches_return_missing());
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(requests.slice(-2)).toEqual([
      { kind: 'thread', cursor: 'later-window' },
      { kind: 'thread', cursor: 'later-window' },
    ]);
  } finally {
    await act(async () => root.unmount());
    router.history.destroy();
    host.remove();
    client.clear();
  }
});

test('uncertain removal stays with the original viewer; replacement clears it before retry', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf' });
  const owner = new SettingsSessionOwner(client, 'csrf', 'alice');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let writes = 0;
  const io: WatchManagementIO = {
    read: async () => ({
      kind: 'page',
      page: {
        viewer: { state: 'current', accountId: 'alice' },
        actions: { remove: 'available' },
        watches: [
          {
            subscriptionId: 'hidden-owner-id',
            kind: 'thread',
            revision: 8,
            createdAt: '2026-11-02T10:00:00.000Z',
            command: { watchId: 'hidden-owner-id', kind: 'thread', expectedRevision: 8 },
            remove: 'available',
            target: null,
          },
        ],
        next: null,
      },
    }),
    stop: async () => {
      writes++;
      return { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } };
    },
  };
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <SettingsSessionContext.Provider value={owner}>
            <WatchesSection io={io} />
          </SettingsSessionContext.Provider>
        </QueryClientProvider>,
      ),
    );
    const stop = [...host.querySelectorAll('button')].find((item) => item.textContent === m.settings_watches_stop());
    expect(stop).toBeDefined();
    await act(async () => stop!.click());
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob' }),
    );
    expect(host.textContent).toBe('');
    expect(writes).toBe(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});

test('watch-only and mixed departure name recovery honestly, retain the original retry on Stay and retire on Leave', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf' });
  const owner = new SettingsSessionOwner(client, 'csrf', 'alice');
  const attempts: Parameters<WatchManagementIO['stop']>[0][] = [];
  let complete: (() => void) | undefined;
  const io: WatchManagementIO = {
    read: async () => ({
      kind: 'page',
      page: {
        viewer: { state: 'current', accountId: 'alice' },
        actions: { remove: 'available' },
        next: null,
        watches: [
          {
            subscriptionId: 'concealed',
            kind: 'thread',
            revision: 8,
            createdAt: '2026-11-03T10:00:00.000Z',
            command: { watchId: 'concealed', kind: 'thread', expectedRevision: 8 },
            remove: 'available',
            target: null,
          },
        ],
      },
    }),
    stop: async (intent) => {
      attempts.push(intent);
      if (attempts.length === 3)
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      return { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } };
    },
  };
  function Editors() {
    const [draft, setDraft] = useState<'reading' | 'profile' | null>(null);
    useSettingsNavigationDraft('reading', draft === 'reading', () => draft === 'reading');
    useSettingsNavigationDraft('profile', draft === 'profile', () => draft === 'profile');
    return (
      <>
        <button onClick={() => setDraft('reading')}>Reading draft</button>
        <button onClick={() => setDraft('profile')}>Profile draft</button>
        <WatchesSection io={io} />
        <button onClick={() => void router.navigate({ to: '/away' })}>Away</button>
      </>
    );
  }
  const base = createRootRoute();
  const settings = createRoute({
    getParentRoute: () => base,
    path: '/settings',
    component: () => (
      <SettingsNavigationProvider>
        <Editors />
      </SettingsNavigationProvider>
    ),
  });
  const away = createRoute({ getParentRoute: () => base, path: '/away', component: () => <p>Away page</p> });
  const router = createRouter({
    routeTree: base.addChildren([settings, away]),
    history: createMemoryHistory({ initialEntries: ['/settings#watches'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const button = (text: string) => {
    const found = [...window.document.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(found).toBeDefined();
    return found!;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <SettingsSessionContext.Provider value={owner}>
            <RouterProvider router={router} />
          </SettingsSessionContext.Provider>
        </QueryClientProvider>,
      );
    });
    await click(m.settings_watches_stop());
    await act(async () => {
      await router.navigate({ to: '/settings', hash: 'reading' });
    });
    expect(host.textContent).toContain(m.settings_watches_uncertain_text());
    expect(window.document.querySelector('[role="alertdialog"]')).toBeNull();
    for (const other of [null, 'Reading draft', 'Profile draft']) {
      if (other) await click(other);
      button('Away').focus();
      await click('Away');
      const dialogs = window.document.querySelectorAll('[role="alertdialog"]');
      expect(dialogs).toHaveLength(1);
      expect(dialogs[0]!.textContent).toContain(
        other ? m.settings_all_drafts_leave_title() : m.settings_watches_leave_title(),
      );
      expect(dialogs[0]!.textContent).toContain(
        other ? m.settings_other_drafts_leave_description() : m.settings_watches_leave_description(),
      );
      expect(window.document.activeElement).toBe(button(m.settings_profile_stay()));
      await click(m.settings_profile_stay());
      expect(router.state.location.pathname).toBe('/settings');
      expect(window.document.activeElement).toBe(button('Away'));
    }
    await click(m.settings_watches_retry_original());
    expect(attempts[1]).toBe(attempts[0]);
    await click(m.settings_watches_retry_original());
    await click('Away');
    await click(m.settings_profile_leave());
    expect(router.state.location.pathname).toBe('/away');
    await act(async () => complete!());
    expect(host.textContent).toBe('Away page');
    expect(owner.readCurrent()).toBe(false);
    expect(attempts).toHaveLength(3);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});
