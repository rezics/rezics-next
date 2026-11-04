import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
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
    stop: async () =>
      writes++ === 0 ? { kind: 'uncertain', problem: { status: 503, code: 'deadline_exceeded' } } : { kind: 'removed' },
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
    await click(m.settings_watches_retry_original());
    expect(host.textContent).toContain(m.settings_watches_removed());
    expect(host.textContent).not.toContain(m.settings_watches_access_lost());
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
