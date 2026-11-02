import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as routing from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import type { SourcesResult } from '../src/features/catalogue/subject-sources';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
let reader = 'alice';
let read: () => Promise<SourcesResult>;
const calls: unknown[] = [];
const queries = await import('../src/features/pages/subject-queries');
mock.module('../src/features/pages/subject-queries', () => ({ ...queries, subjectRequestReader: async () => reader }));
mock.module('../src/features/catalogue/subject-sources-actions', () => ({
  loadSubjectSources: async ({ data }: { data: unknown }) => {
    calls.push(data);
    return read();
  },
}));

test('actual Sources retry returns focus locally and retires focus across reader, address and route lifetimes', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en' });
  const keys =
    'window document navigator HTMLElement Element Node MutationObserver getComputedStyle IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key],
    });
  const { createRoot } = await import('react-dom/client');
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.sources');
  const { sessionQuery } = await import('../src/session/query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { catalogueSourcesFixture, sourceDefinitions } = await import('../src/kernel/fake/catalogue-sources');
  const { explainSubjectSources } = await import('../src/features/catalogue/subject-sources');
  setLocale('en', { reload: false });
  const page = explainSubjectSources(catalogueSourcesFixture('empty').read, 'en', sourceDefinitions);
  const ready = { kind: 'ready', page } as const;
  const unavailable = { kind: 'unavailable' } as const;
  const tick = () => new Promise((done) => setTimeout(done, 0));
  try {
    for (const mode of 'empty failed denied error pointer unfocused moved moved-back tab blur canonical reader retired'.split(
      ' ',
    )) {
      reader = 'alice';
      calls.length = 0;
      read = async () => {
        if (mode === 'error') throw new Error('Sources read failed');
        return unavailable;
      };
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const session = () => ({ state: 'signed-in', subject: reader, csrfToken: 'unchanged-current-token' });
      client.setQueryData(sessionQuery.queryKey, session());
      const parent = routing.createRootRoute({ component: routing.Outlet });
      const sources = Route.update({
        getParentRoute: () => parent,
        path: '/$locale/subjects/$id/$slug/sources',
      } as never);
      const suffix = '?realm=realm-a&intent=exact%20read#kept';
      const router = routing.createRouter({
        routeTree: parent.addChildren([sources]),
        history: routing.createMemoryHistory({ initialEntries: [page.sourcesHref + suffix] }),
        defaultPendingMs: 0,
        defaultPendingMinMs: 0,
      });
      await router.load();
      const host = window.document.createElement('main') as unknown as HTMLElement;
      const outside = window.document.createElement('button') as unknown as HTMLButtonElement;
      window.document.body.append(host, outside);
      outside.focus();
      const root = createRoot(host);
      let mounted = true;
      try {
        await act(async () => {
          root.render(h(QueryClientProvider, { client }, h(routing.RouterProvider, { router })));
          await tick();
        });
        expect(document.activeElement).toBe(outside);
        const opener = host.querySelector('button')!;
        expect(opener.textContent).toBe(m.sources_retry());
        let release!: (value: SourcesResult) => void;
        const held = new Promise<SourcesResult>((resolve) => {
          release = resolve;
        });
        read = () => held;
        await act(async () => {
          if (mode !== 'unfocused') opener.focus();
          opener.dispatchEvent(new window.MouseEvent('click', { bubbles: true, detail: mode === 'pointer' ? 1 : 0 }));
          opener.click();
          if (mode === 'moved-back') {
            outside.focus();
            opener.focus();
          }
          await tick();
        });
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual({ id: page.id, locale: 'en', realm: 'realm-a', reader: 'alice' });
        expect(host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
        if (mode === 'moved') outside.focus();
        if (mode === 'tab') document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        if (mode === 'blur') window.dispatchEvent(new window.Event('blur'));
        if (['moved-back', 'tab', 'blur'].includes(mode)) opener.blur();
        if (mode === 'retired') {
          await act(async () => root.unmount());
          mounted = false;
          outside.focus();
        }
        if (mode === 'reader') {
          reader = 'bob';
          read = async () => ready;
          await act(async () => {
            client.setQueryData(sessionQuery.queryKey, session());
            await tick();
          });
        }
        const returned =
          mode === 'canonical'
            ? {
                kind: 'ready' as const,
                page: {
                  ...page,
                  title: { text: 'Renamed' },
                  sourcesHref: page.sourcesHref.replace(/\/[^/]+\/sources$/, '/renamed/sources'),
                },
              }
            : mode === 'failed' || mode === 'denied'
              ? ({ kind: mode === 'denied' ? 'denied' : 'unavailable' } as const)
              : ready;
        read = async () => returned;
        await act(async () => {
          release(returned);
          await tick();
          await tick();
        });
        if (mode === 'empty' || mode === 'error') {
          expect(host.textContent).toContain(m.sources_empty());
          expect(document.activeElement).toBe(host.querySelector('[data-slot="view-heading"] h1'));
          expect(host.querySelector('button')).toBeNull();
        } else if (mode === 'failed' || mode === 'denied') {
          expect(document.activeElement).toBe(
            opener.isConnected ? opener : host.querySelector('[data-slot="view-heading"] h1'),
          );
          expect(host.querySelector('button')?.disabled).toBe(false);
        } else {
          expect(document.activeElement).not.toBe(host.querySelector('[data-slot="view-heading"] h1'));
          if (mode === 'moved' || mode === 'retired') expect(document.activeElement).toBe(outside);
          if (mode === 'pointer' || ['moved-back', 'tab', 'blur'].includes(mode))
            expect(document.activeElement).toBe(document.body);
          if (mode === 'unfocused') expect(document.activeElement).toBe(outside);
        }
        if (mode === 'canonical') {
          expect(router.state.location.pathname).toEndWith('/renamed/sources');
          expect(router.state.location.searchStr + router.state.location.hash).toBe(suffix.replace('#', ''));
        }
        expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session());
      } finally {
        if (mounted) await act(async () => root.unmount());
        client.clear();
        host.remove();
        outside.remove();
      }
    }
  } finally {
    mock.restore();
    await window.happyDOM.close();
    for (const [key, value] of saved) {
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
