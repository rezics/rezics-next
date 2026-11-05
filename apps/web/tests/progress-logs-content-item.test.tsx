import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
import { profileSession } from '../src/kernel/fake/progress-profiles';
import recording from '../src/kernel/recorded/library-published-logs.json';
import type { PublishedLog, PublishedLogPage } from '../src/library/logs-read';
import type { ProgressSessionPage } from '../src/library/progress-reads';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
afterAll(() => mock.restore());

// UNRUN: composed assertions over installed shared UI; acceptance, native and browser proof remain deferred.
test('Published progress log items preserve immutable supplied snapshots and admitted exact destinations', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/progress/current' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { ProgressLogs } = await import('../src/library/logs-progress');
  const { subjectOf } = await import('../src/library/reads');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
  const { fullDateTime } = await import('../src/threads/byline');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { within } = await import(require.resolve('@testing-library/dom'));
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const recorded = recording.publishedLogs[0]!;
  const first: PublishedLog = { ...recorded, sessionState: 'active', subject: subjectOf(recorded.subject) };
  const deleted: PublishedLog = {
    ...first,
    id: 'snapshot/opaque+?locale=ja#二%',
    account: null,
    note: `  A retained snapshot.\n\n${'Every supplied word stays in this note. '.repeat(25)}\n  `,
    publishedAt: '2026-10-20T09:05:00.000Z',
  };
  const progress: ProgressSessionPage = {
    signedIn: true,
    idempotencyKey: '10203040-5060-4070-8090-102030405060',
    session: {
      ...profileSession,
      mode: 'scalar_amount',
      state: 'active',
      changes: [],
      changesNext: null,
      units: [],
      unitsNext: null,
    },
  };
  const next = 'signed/next+?from=else&locale=fr#三%';
  const search = { changes: 'changes/opaque+?q=二%', units: 'units/opaque+==', logs: 'old/logs+==' };
  const page: PublishedLogPage = { signedIn: true, logs: [first, deleted], next };
  let show!: (page: PublishedLogPage) => void;
  const route = createRootRoute();
  const sessionRoute = createRoute({
    getParentRoute: () => route,
    path: '/library/progress/$id',
    component: function LogsFixture() {
      const [logs, setLogs] = useState(page);
      show = setLogs;
      return <ProgressLogs progress={progress} logs={logs} search={search} />;
    },
  });
  const router = createRouter({
    routeTree: route.addChildren([sessionRoute]),
    history: createMemoryHistory({ initialEntries: [`/en/library/progress/${profileSession.id}`] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  client.setQueryData(exposureQuery.queryKey, ['reading_progress']);
  client.setQueryData(['exposure', 'anonymous'], []);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    const region = within(host as unknown as HTMLElement).getByRole('region', { name: m.library_logs_heading() });
    const rows = [...region.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(2);
    const author = `${first.account!.displayName} @${first.account!.handle}`;
    const heading = within(rows[0]!).getByRole('heading', { level: 3, name: author });
    const primary = within(rows[0]!).getByRole('link', { name: author });
    expect(primary.getAttribute('href')).toBe(`/en/logs/${encodeURIComponent(first.id)}`);
    expect(primary.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.closest('[aria-hidden="true"], .sr-only')).toBeNull();
    expect(rows[0]!.querySelectorAll('a')).toHaveLength(1);
    expect(rows[0]!.querySelector('[data-content-item-slot="preview"] p')?.textContent).toBe(first.note);
    const fallback = within(rows[1]!).getByRole('heading', { level: 3, name: m.library_account_deleted() });
    expect(within(rows[1]!).getByRole('link', { name: fallback.textContent! }).getAttribute('href')).toBe(
      `/en/logs/${encodeURIComponent(deleted.id)}`,
    );
    const note = rows[1]!.querySelector('[data-content-item-slot="preview"] p')!;
    expect(note.textContent).toBe(deleted.note);
    expect(note.classList.contains('whitespace-pre-wrap')).toBe(true);
    for (const [index, log] of [first, deleted].entries()) {
      const time = rows[index]!.querySelector('time')!;
      expect(time.getAttribute('datetime')).toBe(log.publishedAt);
      expect(time.getAttribute('title')).toBe(fullDateTime(log.publishedAt, 'en'));
      expect(time.textContent).not.toBe('');
      expect(rows[index]!.querySelector('img, [role="progressbar"], a a, a button')).toBeNull();
    }
    const more = within(region).getByRole('link', { name: m.library_logs_more() });
    const continuation = new URL(more.getAttribute('href')!, window.location.origin);
    expect(continuation.pathname).toBe(`/en/library/progress/${profileSession.id}`);
    expect([...continuation.searchParams]).toEqual([
      ['logs', next],
      ['changes', search.changes],
      ['units', search.units],
    ]);

    await act(async () => show({ ...page, logs: [deleted, first] }));
    expect(region.querySelectorAll('ol > li')[0]).toBe(rows[1]);
    expect(region.querySelectorAll('ol > li')[1]).toBe(rows[0]);
    await act(async () => {
      client.setQueryData(exposureQuery.queryKey, []);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(region.querySelectorAll('a, [role="link"]')).toHaveLength(0);
    expect(within(region).getByRole('heading', { level: 3, name: author })).toBe(heading);
    expect(note.textContent).toBe(deleted.note);
    await act(async () => show({ ...page, logs: [], next: null }));
    expect(region.textContent).toContain(m.library_progress_log_reader_page_empty());
    expect(region.textContent).not.toContain(m.library_logs_empty());
    expect(region.querySelector('ol')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    overwriteGetLocale(previousLocale);
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
