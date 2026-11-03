import { afterAll, expect, mock, test } from 'bun:test';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import * as start from '../.storybook/react-start';
import type { WatchManagementIO, WatchRead } from '../src/settings/watch-native';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { sessionQuery } = await import('../src/session/query');
const { SettingsSessionOwner, SettingsSessionContext } = await import('../src/settings/settings-session-owner');
const { WatchesSection } = await import('../src/settings/watches');
const { m } = await import('../src/paraglide/messages.js');
const window = new Window({ url: 'https://site.test/en/settings#watches' });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
  HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  void window.happyDOM.close();
});

test('the mounted private view separates inaccessible targets, uncertain removal, sparse/empty pages and refresh failure', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'csrf' });
  const owner = new SettingsSessionOwner(client, 'csrf', 'alice');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let response: WatchRead = { kind: 'page', page: { watches: [
    { subscriptionId: 'hidden-owner-id', kind: 'board', target: null },
    { subscriptionId: 'readable-owner-id', kind: 'thread', target: { title: 'Readable thread', href: '/threads/a/readable' } },
  ], next: null } };
  let fail = false;
  let writes = 0;
  const io: WatchManagementIO = {
    read: async () => { if (fail) throw new Error('offline'); return response; },
    stop: async () => ({ kind: ++writes === 1 ? 'uncertain' : 'removed' }),
  };
  const click = async (text: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await act(async () => root.render(
      <StrictMode><QueryClientProvider client={client}><SettingsSessionContext.Provider value={owner}>
        <WatchesSection io={io} />
      </SettingsSessionContext.Provider></QueryClientProvider></StrictMode>,
    ));
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
    response = { kind: 'page', page: { watches: [], next: 'opaque' } };
    await click(m.settings_watches_refresh());
    expect(host.textContent).toContain(m.settings_watches_sparse());
    expect(host.textContent).not.toContain(m.settings_watches_empty());
    response = { kind: 'page', page: { watches: [], next: null } };
    await click(m.settings_watches_next());
    expect(host.textContent).toContain(m.settings_watches_end());
    await click(m.settings_watches_first());
    expect(host.textContent).toContain(m.settings_watches_empty());
    fail = true;
    await click(m.settings_watches_refresh());
    expect(host.textContent).toContain(m.settings_watches_failed_text());
    expect(host.textContent).not.toContain(m.settings_watches_empty());
    fail = false;
    response = { kind: 'unavailable' };
    await click(m.settings_retry());
    expect(host.textContent).toContain(m.settings_watches_unavailable());
    await act(async () => client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'bob', csrfToken: 'bob' }));
    expect(host.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    client.clear();
  }
});
