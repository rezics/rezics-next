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
mock.module('../src/features/pages/subject-queries', () => ({
  ...queries,
  subjectRequestReader: async ({ data }: { data: { realm?: string } }) => (data.realm ? reader : null),
}));
mock.module('../src/features/catalogue/subject-sources-actions', () => ({
  loadSubjectSources: async ({ data }: { data: unknown }) => {
    calls.push(data);
    return read();
  },
  readCurrentSubjectSources: async () => read(),
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
    for (const mode of 'empty failed denied error pointer pointer-departure unfocused moved moved-back tab blur canonical reader global-reader retired revisit'.split(
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
      const realm = mode === 'global-reader' ? undefined : '00000000-0000-4000-8000-000000000301';
      const suffix = `?${realm ? `realm=${realm}&` : ''}intent=exact%20read#kept`;
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
        // The route admits its loader result after an asynchronous request fingerprint check.
        for (let attempt = 0; !host.querySelector('button') && attempt < 100; attempt++)
          await act(async () => {
            await new Promise((done) => setTimeout(done, 10));
          });
        expect(document.activeElement === outside, mode).toBe(true);
        const opener = host.querySelector('button')!;
        expect(opener, mode).not.toBeNull();
        expect(opener.textContent).toBe(m.sources_retry());
        expect(calls, mode).toHaveLength(1);
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
        expect(calls[1]).toEqual({ id: page.id, locale: 'en', realm, reader: realm ? 'alice' : null });
        // Suspense can retain the error article hidden alongside the visible pending presentation.
        const visibleArticles = Array.from(host.querySelectorAll('article')).filter(
          (article) => !article.closest('[style*="display: none"]'),
        );
        expect(visibleArticles, mode).toHaveLength(1);
        expect(visibleArticles[0]!.getAttribute('aria-busy'), `${mode}: ${host.innerHTML}`).toBe('true');
        if (mode === 'moved') outside.focus();
        if (mode === 'tab') document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
        if (mode === 'blur') window.dispatchEvent(new window.Event('blur'));
        if (mode === 'pointer-departure')
          document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
        if (['moved-back', 'tab', 'blur', 'pointer-departure'].includes(mode)) opener.blur();
        if (mode === 'retired') {
          await act(async () => root.unmount());
          mounted = false;
          outside.focus();
        }
        if (mode === 'reader' || mode === 'global-reader') {
          reader = 'bob';
          read = async () => ready;
          await act(async () => {
            client.setQueryData(sessionQuery.queryKey, session());
            await tick();
          });
          if (mode === 'global-reader') {
            reader = 'alice';
            await act(async () => {
              client.setQueryData(sessionQuery.queryKey, session());
              await tick();
            });
          }
        }
        if (mode === 'revisit') {
          // A-B-A: the pending keyboard retry must not return focus to the revisited address.
          const otherId = '00000000-0000-4000-8000-000000000004';
          const other = {
            ...page,
            id: otherId,
            title: { text: 'Another' },
            href: `/en/subjects/${otherId}/another`,
            sourcesHref: `/en/subjects/${otherId}/another/sources`,
          };
          read = async () => ({ kind: 'ready', page: other });
          await act(async () => {
            await router.navigate({ to: other.sourcesHref + suffix });
            await tick();
          });
          read = async () => ready;
          await act(async () => {
            await router.navigate({ to: page.sourcesHref + suffix });
            await tick();
          });
          outside.focus();
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
          expect(
            document.activeElement === host.querySelector('[data-slot="view-heading"] h1'),
            `${mode}: ${document.activeElement?.outerHTML}`,
          ).toBe(true);
          expect(
            Array.from(host.querySelectorAll('button')).some((button) => button.textContent === m.sources_retry()),
          ).toBe(false);
        } else if (mode === 'failed' || mode === 'denied') {
          expect(
            document.activeElement ===
              (opener.isConnected ? opener : host.querySelector('[data-slot="view-heading"] h1')),
            `${mode}: ${document.activeElement?.outerHTML}`,
          ).toBe(true);
          expect(host.querySelector('button')?.disabled).toBe(false);
        } else {
          expect(document.activeElement === host.querySelector('[data-slot="view-heading"] h1'), mode).toBe(false);
          if (['moved', 'retired', 'revisit'].includes(mode))
            expect(document.activeElement === outside, mode).toBe(true);
          if (['pointer', 'pointer-departure', 'moved-back', 'tab', 'blur'].includes(mode))
            expect(document.activeElement === document.body, mode).toBe(true);
          if (mode === 'unfocused') expect(document.activeElement === outside, mode).toBe(true);
        }
        if (mode === 'canonical') {
          expect(router.state.location.pathname).toEndWith('/renamed/sources');
          expect(Object.fromEntries(new URLSearchParams(router.state.location.searchStr))).toEqual({
            realm,
            intent: 'exact read',
          });
          expect(router.state.location.hash).toBe('kept');
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
}, 20_000);
