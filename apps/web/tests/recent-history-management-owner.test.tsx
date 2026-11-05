import { expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import * as sync from '../src/search/recent-sync';
import type { RecentHistory } from '../src/search/recent-history';
import type { RecentItem } from '../src/search/recent';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const account = '019f0000-0000-7000-8000-734100000001';
let rows: RecentItem[] = [],
  revision = 0,
  nativeCalls = 0;
let finishRead: ((page: Awaited<ReturnType<sync.RecentSearchTransport['read']>>) => void) | undefined;
let holdRead = true;
const createAdapter = sync.createRecentSearchSyncAdapter;
mock.module('../src/search/recent-sync', () => ({
  ...sync,
  createRecentSearchSyncAdapter: (options: Parameters<typeof createAdapter>[0]) =>
    createAdapter({
      ...options,
      transport: {
        async read() {
          nativeCalls++;
          if (holdRead) {
            holdRead = false;
            return new Promise((resolve) => {
              finishRead = resolve;
            });
          }
          return {
            accountId: account,
            page: { recentSearches: [...rows], revision, next: null },
          };
        },
        async write({ pending, expectedRevision }) {
          nativeCalls++;
          expect(expectedRevision).toBe(revision);
          revision++;
          const { change } = pending;
          const id = crypto.randomUUID(),
            lastUsed = new Date().toISOString();
          if (change.kind === 'use') rows.push({ id, lastUsed, revision, entry: change.entry });
          else rows = change.kind === 'clear' ? [] : rows.filter((row) => row.id !== change.id);
          return { ok: true, value: { id, revision, lastUsed } };
        },
      },
    }),
}));

// Both mounted surfaces consume the actual command boundary and the same native journal implementation.
async function mountManagement() {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/search/history' });
  const keys = [
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'CustomEvent',
    'Event',
    'StorageEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'localStorage',
  ] as const;
  const globals = {
    window,
    IS_REACT_ACT_ENVIRONMENT: true,
    ...Object.fromEntries(keys.map((key) => [key, window[key]])),
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const [{ useRecentHistory }, { RecentPanel }, { RecentHistoryView }, { m }] = await Promise.all([
    import('../src/search/recent-history-hook'),
    import('../src/search/recent-panel'),
    import('../src/search/recent'),
    import('../src/paraglide/messages.js'),
  ]);
  const client = new QueryClient();
  const session = (subject = account, csrfToken = 'first') =>
    client.setQueryData(['session'], {
      state: 'signed-in',
      subject,
      csrfToken,
    });
  session();
  const history: RecentHistory[] = [];
  function Reader({ full }: { full: boolean }) {
    const current = useRecentHistory(`account:${account}`);
    history[Number(full)] = current;
    return (
      <div data-surface={full ? 'history' : 'recent'}>
        {full ? <RecentHistoryView {...current} history /> : <RecentPanel history={current} global={false} />}
      </div>
    );
  }
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <Reader full={false} />
            <Reader full />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  const reads = spyOn(window.localStorage, 'getItem'),
    writes = spyOn(window.localStorage, 'setItem');
  let events = 0;
  window.addEventListener('rezics-search-history-changed', () => events++);
  await render();
  const io = () => [reads.mock.calls.length, writes.mock.calls.length, events, nativeCalls];
  const surface = (index: number) =>
    host.querySelector<HTMLElement>(`[data-surface="${index ? 'history' : 'recent'}"]`)!;
  const remove = (index: number) => surface(index).querySelector<HTMLButtonElement>('[data-history-action]')!;
  const announcement = (index: number) => surface(index).querySelector('[aria-live="polite"]')!.textContent;
  return {
    window,
    host,
    history,
    session,
    render,
    async reopen() {
      await act(async () => root.render(null));
      await render();
    },
    io,
    surface,
    remove,
    announcement,
    m,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      reads.mockRestore();
      writes.mockRestore();
      for (const [key, descriptor] of saved)
        descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
      window.close();
    },
  };
}

test('installed readers alone manage Recent and History through native settlement and reopening', async () => {
  const h = await mountManagement();
  try {
    await act(async () => h.history[0]!.remember('Keep'));
    expect(h.history[1]!.entries.map((entry) => entry.query)).toEqual(['Keep']);
    for (const replacement of ['credentials', 'A/B/A']) {
      const retired = [...h.history];
      await act(async () => {
        if (replacement === 'A/B/A') h.session('019f0000-0000-7000-8000-734100000002');
        h.session(account, replacement);
        const before = h.io();
        for (let index = 0; index < 2; index++) {
          h.remove(index).focus();
          h.remove(index).click();
          retired[index]!.remember('Stale');
          retired[index]!.clear!();
          retired[index]!.retry!();
        }
        for (const type of ['focus', 'online']) h.window.dispatchEvent(new h.window.Event(type));
        h.window.dispatchEvent(new h.window.StorageEvent('storage', { key: null }));
        expect(h.io()).toEqual(before);
        if (finishRead) {
          finishRead({
            accountId: account,
            page: {
              revision: 0,
              next: null,
              recentSearches: [
                {
                  id: crypto.randomUUID(),
                  revision: 0,
                  lastUsed: new Date().toISOString(),
                  entry: {
                    kind: 'query',
                    text: 'Retired private query',
                    scope: { kind: 'realm', id: account },
                  },
                  display: {
                    name: 'Retired private label',
                    href: '/search',
                    avatar: null,
                  },
                },
              ],
            },
          });
          finishRead = undefined;
        }
      });
      expect(h.host.textContent).not.toContain('Retired private');
      for (let index = 0; index < 2; index++) expect(h.announcement(index)).toBe('');
      const before = h.io();
      await act(async () => {
        for (const old of retired) {
          old.remove('Keep');
          old.clear!();
          old.remember('Still stale');
          old.retry!();
        }
      });
      expect(h.io()).toEqual(before);
      expect(h.history[0]!.entries.map((entry) => entry.query)).toEqual(['Keep']);
    }
    await act(async () => {
      h.history[0]!.remember('Alpha');
      h.history[0]!.remember('Beta');
    });
    await act(async () => {
      h.remove(0).focus();
      h.remove(0).click();
    });
    expect(h.window.document.activeElement).toBe(h.remove(0));
    expect(h.announcement(0)).toBe(h.m.search_history_management_removed({ name: 'Beta' }));
    await act(async () => {
      h.remove(1).focus();
      h.remove(1).click();
    });
    expect(h.announcement(1)).toBe(h.m.search_history_management_removed({ name: 'Alpha' }));
    const clear = [...h.surface(1).querySelectorAll('button')].find(
      (button) => button.textContent === h.m.search_history_clear(),
    )!;
    await act(async () => {
      clear.focus();
      clear.click();
    });
    expect(h.announcement(1)).toBe(h.m.search_history_management_cleared());
    expect(h.window.document.activeElement).toBe(h.surface(1).querySelector('section'));
    expect(rows).toEqual([]);
    expect(h.history.every((current) => current.sync === 'synced' && !current.entries.length)).toBe(true);
    await h.reopen();
    await act(async () => h.history[1]!.retry!());
    expect(h.history.every((current) => !current.entries.length)).toBe(true);
  } finally {
    await h.close();
  }
});
