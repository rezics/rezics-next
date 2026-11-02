import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import type { GatedOperation } from '../src/kernel/exposure';
import type { PublishedLog, PublishedLogPage } from '../src/library/logs-read';
import type { ProgressDetailOrigin } from '../src/library/progress-session';
import type { ProgressSessionPage } from '../src/library/progress-reads';
import { profileSession } from '../src/kernel/fake/progress-profiles';
import recording from '../src/kernel/recorded/library-published-logs.json';

// UNRUN: authored reader outcomes. Native, browser, Storybook and acceptance execution are deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/progress/current', width: 320, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const admitted = new Set<GatedOperation>();
const publish = mock(() => {
  throw new Error('Reader interactions must not publish');
});
mock.module('../src/kernel/exposure', () => ({
  useOperation: (operation: GatedOperation) => admitted.has(operation),
  Exposure: ({ operation, children }: { operation: GatedOperation; children: ReactNode }) =>
    admitted.has(operation) ? children : null,
}));
mock.module('../src/library/logs-server', () => ({ publishProgressLog: publish }));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => null }));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { ProgressLogs } = await import('../src/library/logs-progress');
const { subjectOf } = await import('../src/library/reads');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
const { fullDateTime } = await import('../src/threads/byline');
const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
const { within } = await import(require.resolve('@testing-library/dom'));
const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
const originalLocale = getLocale();
afterAll(async () => {
  setLocale(originalLocale, { reload: false });
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const sessionId = 'session/opaque+?locale=fr&owner=二#%';
const search = { changes: 'changes/+?=二&same=1#%', units: 'units/+== &三%', logs: 'logs/+==?cursor=四#%' };
const next = 'next/+?locale=de&cursor=五#%';
const progress: Extract<ProgressSessionPage, { signedIn: true }> = {
  signedIn: true,
  idempotencyKey: '10203040-5060-4070-8090-102030405060',
  session: {
    ...profileSession,
    id: sessionId,
    mode: 'scalar_amount',
    state: 'active',
    changes: [],
    changesNext: null,
    units: [],
    unitsNext: null,
  },
};
const recorded = recording.publishedLogs[0]!;
const log: PublishedLog = { ...recorded, sessionState: 'active', subject: subjectOf(recorded.subject) };
const page = (logs: PublishedLog[] = [], continuation: string | null = null): PublishedLogPage => ({
  signedIn: true,
  logs,
  next: continuation,
});

async function mount(initial: PublishedLogPage, requested: typeof search | Omit<typeof search, 'logs'> = search) {
  admitted.clear();
  admitted.add('published_log.list');
  admitted.add('published_log.read');
  publish.mockClear();
  let current = true;
  let ownerMounted = false;
  let episode = 0;
  const captures: (GatedOperation | undefined)[] = [];
  const origin: ProgressDetailOrigin = {
    viewer: 'owner',
    address: { id: sessionId, ...requested },
    isCurrent: () => ownerMounted && current,
    capture: (operation) => {
      captures.push(operation);
      const captured = episode;
      return { isCurrent: () => ownerMounted && current && captured === episode, headers: () => null };
    },
    refresh: async () => progress,
  };
  const route = createRootRoute();
  const router = createRouter({
    routeTree: route.addChildren([createRoute({ getParentRoute: () => route, path: '/library/progress/$id' })]),
    history: createMemoryHistory({
      initialEntries: [`/en/library/progress/${encodeURIComponent(sessionId)}?${new URLSearchParams(requested)}`],
    }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  function MountedOwner({ children }: { children: ReactNode }) {
    useLayoutEffect(() => {
      ownerMounted = true;
      return () => {
        ownerMounted = false;
      };
    }, []);
    return children;
  }
  const show = (logs = initial, at = requested, originating: ProgressDetailOrigin | undefined = origin) =>
    act(async () =>
      root.render(
        <StrictMode>
          <RouterContextProvider router={router}>
            <MountedOwner>
              <ProgressLogs progress={progress} logs={logs} search={at} originating={originating} />
            </MountedOwner>
          </RouterContextProvider>
        </StrictMode>,
      ),
    );
  await show();
  const region = () => within(host as unknown as HTMLElement).getByRole('region', { name: m.library_logs_heading() });
  const click = (target: Element, kind = 'click', modified = false) => {
    const event = new window.MouseEvent(kind, {
      bubbles: true,
      cancelable: true,
      button: kind === 'auxclick' ? 1 : 0,
      ctrlKey: modified,
    });
    target.dispatchEvent(event as unknown as MouseEvent);
    return event;
  };
  return {
    host,
    router,
    origin,
    captures,
    show,
    region,
    click,
    retire: () => {
      current = false;
    },
    rotate: () => {
      episode++;
    },
    user: userEvent.setup({ document: window.document as unknown as Document }),
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Progress-session published log readers bound long notes and distinguish empty later pages, with first-page recovery preserving the other session cursors and current authority.', async () => {
  for (const locale of ['en', 'ja'] as const) {
    setLocale(locale, { reload: false });
    for (const cursor of [undefined, search.logs])
      for (const continuation of [null, next]) {
        const requested = { changes: search.changes, units: search.units, ...(cursor ? { logs: cursor } : {}) };
        const h = await mount(page([], continuation), requested);
        try {
          const region = h.region();
          const view = within(region);
          expect(region.textContent).toContain(
            cursor || continuation ? m.library_progress_log_reader_page_empty() : m.library_logs_empty(),
          );
          if (cursor || continuation) expect(region.textContent).not.toContain(m.library_logs_empty());
          const first = view.queryByRole('link', { name: m.library_progress_log_reader_first_page(), exact: true });
          const more = view.queryByRole('link', { name: m.library_logs_more(), exact: true });
          expect(!!first).toBe(!!cursor);
          expect(!!more).toBe(!!continuation);
          for (const link of [first, more].filter((item): item is HTMLElement => !!item)) {
            const url = new URL(link.getAttribute('href')!, window.location.href);
            expect(decodeURIComponent(url.pathname.split('/library/progress/')[1]!)).toBe(sessionId);
            expect(url.pathname).toStartWith(`/${locale}/library/progress/`);
            expect(Object.fromEntries(url.searchParams)).toEqual({
              changes: search.changes,
              units: search.units,
              ...(link === more ? { logs: continuation } : {}),
            });
          }
          if (first) {
            await act(async () => {
              h.click(first);
            });
            expect(routerSearch(h.router)).toEqual({ changes: search.changes, units: search.units });
          } else if (more) {
            await act(async () => {
              h.click(more);
            });
            expect(routerSearch(h.router)).toEqual({
              changes: search.changes,
              units: search.units,
              logs: continuation,
            });
          }
          expect(publish).not.toHaveBeenCalled();
        } finally {
          await h.close();
        }
      }
  }
});

function routerSearch(router: Awaited<ReturnType<typeof mount>>['router']) {
  return router.state.location.search;
}

test('A true first log page without a logs cursor uses the global empty message and offers no pagination', async () => {
  setLocale('en', { reload: false });
  const requested = { changes: search.changes, units: search.units };
  const h = await mount(page([], null), requested);
  try {
    const region = h.region();
    expect(region.textContent).toContain(m.library_logs_empty());
    expect(region.textContent).not.toContain(m.library_progress_log_reader_page_empty());
    expect(region.querySelector('ol')).toBeNull();
    expect(within(region).queryByRole('link')).toBeNull();
    expect(routerSearch(h.router)).toEqual(requested);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('An empty later log page has only exact first-page recovery and rejects it after origin retirement', async () => {
  setLocale('en', { reload: false });
  const h = await mount(page([], null));
  try {
    const region = h.region();
    const view = within(region);
    expect(region.textContent).toContain(m.library_progress_log_reader_page_empty());
    expect(region.textContent).not.toContain(m.library_logs_empty());
    expect(region.querySelector('ol')).toBeNull();
    const first = view.getByRole('link', { name: m.library_progress_log_reader_first_page(), exact: true });
    const target = new URL(first.getAttribute('href')!, window.location.href);
    expect(decodeURIComponent(target.pathname.split('/library/progress/')[1]!)).toBe(sessionId);
    expect(target.pathname).toStartWith('/en/library/progress/');
    expect(Object.fromEntries(target.searchParams)).toEqual({ changes: search.changes, units: search.units });
    expect(view.queryByRole('link', { name: m.library_logs_more(), exact: true })).toBeNull();
    expect(region.querySelectorAll('a')).toHaveLength(1);
    const before = h.router.state.location.href;
    await act(async () => {
      h.retire();
      expect(h.click(first).defaultPrevented).toBe(true);
      for (const kind of ['click', 'auxclick', 'contextmenu'])
        expect(h.click(first, kind, true).defaultPrevented).toBe(true);
    });
    expect(h.router.state.location.href).toBe(before);
    expect(routerSearch(h.router)).toEqual(search);
    await h.show();
    expect(view.queryByRole('link')).toBeNull();
    expect(region.textContent).toContain(m.library_progress_log_reader_page_empty());
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Bounded notes expand by keyboard with exact whitespace and literal markup; ordered duplicate snapshots retain destinations and published times', async () => {
  setLocale('en', { reload: false });
  const exact = `  <script>literal & text</script>\n\n${'unbroken_二'.repeat(90)}\n  `;
  const long: PublishedLog = {
    ...log,
    account: { displayName: 'LongAccount'.repeat(25), handle: 'unbroken_handle'.repeat(20) },
    note: exact,
  };
  const deleted: PublishedLog = { ...log, id: 'deleted/+?二%', account: null, subject: null, note: null };
  const logs = [long, deleted, long];
  const original = JSON.stringify(logs);
  logs.forEach(Object.freeze);
  Object.freeze(logs);
  const h = await mount(page(logs, next));
  try {
    const rows = [...h.region().querySelectorAll('ol > li')];
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      const snapshot = logs[index]!;
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.className).toContain('[overflow-wrap:anywhere]');
      expect(row.querySelector('a')?.getAttribute('href')).toBe(`/en/logs/${encodeURIComponent(snapshot.id)}`);
      expect(row.querySelector('time')?.getAttribute('datetime')).toBe(snapshot.publishedAt);
      expect(row.querySelector('time')?.getAttribute('title')).toBe(fullDateTime(snapshot.publishedAt, 'en'));
      expect(row.querySelector('time')?.textContent).not.toBe('');
      expect(row.querySelector('script, img, [role="progressbar"], a button')).toBeNull();
    }
    expect(rows[1]!.querySelector('h3')?.textContent).toBe(m.library_account_deleted());
    expect(rows[1]!.querySelector('[data-content-item-slot="preview"]')).toBeNull();
    const note = rows[0]!.querySelector('p')!;
    const expand = within(rows[0]!).getByRole('button', { name: m.library_progress_log_reader_full_note() });
    expect(note.textContent).toBe(exact);
    expect(note.className).toContain('line-clamp-3');
    expect(note.className).toContain('whitespace-pre-wrap');
    expect(note.className).toContain('[overflow-wrap:anywhere]');
    expect(expand.getAttribute('aria-controls')).toBe(note.id);
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      expand.focus();
      await h.user.keyboard('{Enter}');
    });
    expect(window.document.activeElement).toBe(expand);
    expect(expand.getAttribute('aria-expanded')).toBe('true');
    expect(expand.textContent).toBe(m.library_progress_log_reader_collapse_note());
    expect(note.className).not.toContain('line-clamp');
    expect(note.textContent).toBe(exact);
    expect(rows[2]!.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      await h.user.keyboard(' ');
    });
    expect(expand.getAttribute('aria-expanded')).toBe('false');
    expect(note.textContent).toBe(exact);
    expect(JSON.stringify(logs)).toBe(original);
    expect(publish).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('First and forward navigation reject retired captures, including modified clicks, and disappear with unavailable admission or current authority', async () => {
  setLocale('en', { reload: false });
  for (const retirement of ['origin', 'capture', 'fallback'] as const) {
    const h = await mount(page([log], next));
    try {
      if (retirement === 'fallback') {
        const { capture, ...fallback } = h.origin;
        await h.show(page([log], next), search, fallback);
      }
      const links = [m.library_progress_log_reader_first_page(), m.library_logs_more()].map((name) =>
        within(h.region()).getByRole('link', { name, exact: true }),
      );
      const before = h.router.state.location.href;
      await act(async () => {
        if (retirement === 'capture') h.rotate();
        else h.retire();
        for (const link of links)
          for (const kind of ['click', 'auxclick', 'contextmenu'])
            expect(h.click(link, kind, true).defaultPrevented).toBe(true);
      });
      expect(h.router.state.location.href).toBe(before);
      expect(h.captures).toContain('published_log.list');
      if (retirement !== 'capture') {
        await h.show(page([log], next));
        expect(h.region().querySelectorAll('a[href*="/library/progress/"]')).toHaveLength(0);
      }
      admitted.delete('published_log.list');
      await h.show(page([log], next));
      expect(h.region().querySelectorAll('a[href*="/library/progress/"]')).toHaveLength(0);
      expect(h.region().querySelector('a[href*="/logs/"]')).not.toBeNull();
      admitted.delete('published_log.read');
      await h.show(page([log], next));
      expect(h.region().querySelector('a')).toBeNull();
      expect(h.region().querySelector('time')).not.toBeNull();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  }
});
