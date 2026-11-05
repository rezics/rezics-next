import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { ProgressIndex } from '../src/library/progress-reads';
import type { ProgressAuthority } from '../src/library/progress-index-origin';

// UNRUN: composed presentation outcomes; browser geometry and native acceptance remain separate.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  CSS: window.CSS,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await window.happyDOM.close();
});

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({}) }));
mock.module('@rezics/ui/entity-picker', () => ({ EntityPicker: () => null }));
mock.module('@rezics/ui/menu', () => ({ Menu: ({ trigger }: { trigger: ReactNode }) => trigger }));
const request = mock(() => {
  throw new Error('Presentation must not request data or dispatch an operation');
});
mock.module('../src/library/progress-server', () => ({
  startProgressSession: request,
  finishProgressSession: request,
  readProgressChoices: request,
  readCurrentViewerProgressIndex: request,
}));
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
const sessionQuery = { queryKey: ['session'] as const, enabled: false };
type Viewer = { state: 'signed-in'; subject: string; csrfToken: string };
mock.module('../src/session/query', () => ({
  sessionQuery,
  useSession: () => useQuery<Viewer>(sessionQuery).data ?? { state: 'unknown', subject: null, csrfToken: null },
}));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { ProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, localizeUrl, deLocalizeUrl } = await import('../src/paraglide/runtime.js');

type Session = ProgressIndex['sessions'][number];
const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
function session(n: number, changes: Partial<Session> = {}): Session {
  return {
    id: id(n),
    subjectId: id(1),
    versionSubjectId: null,
    versionSubject: null,
    subject: { id: id(1), type: 'schema:Book', types: ['schema:Book'], label: 'Historical reading', cover: null },
    mode: 'scalar_amount',
    unit: 'old:unit~' + 'x'.repeat(110),
    amount: '0.123456',
    total: null,
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 7,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    ...changes,
  };
}
const tick = (run: () => unknown) =>
  act(async () => {
    await run();
  });
async function mount(sessions: Session[], locale: 'en' | 'de' = 'en', authority?: ProgressAuthority) {
  setLocale(locale, { reload: false });
  request.mockClear();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'credential' });
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const snapshot = lifetime.getSnapshot();
  if (snapshot.state !== 'signed-in') throw new Error('Expected signed-in observation');
  client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
    subject: 'reader',
    admitted: ['reading_progress'],
  });
  const cursor = 'earlier/opaque+==';
  const next = 'next/opaque+==';
  const page: ProgressIndex = {
    signedIn: true,
    subjectId: id(1),
    selectedSubject: null,
    sessions,
    next,
    idempotencyKey: id(99),
  };
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({
      initialEntries: [`/${locale}/library/progress?subjectId=${id(1)}&cursor=${encodeURIComponent(cursor)}`],
    }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  await router.load();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await tick(() =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <ProgressIndexPage page={page} cursor={cursor} {...(authority ? { authority } : {})} />
        </RouterContextProvider>
      </QueryClientProvider>,
    ),
  );
  return {
    host,
    router,
    next,
    cursor,
    close: async () => {
      await tick(() => root.unmount());
      host.remove();
      stop();
      client.clear();
    },
  };
}

test('Missing historical unit meaning is readable before exact, labelled native details without inferred ratios', async () => {
  const sessions = [
    session(4),
    session(2, { amount: '0', unit: '' }),
    session(3, { mode: 'cursor_position', amount: null, position: '0' }),
    session(9, { mode: 'cursor_position', amount: null, position: '42.123456' }),
    session(5, { mode: 'cursor_position', amount: null, locator: 'Ch. 3, 9' }),
    session(6, { mode: 'cursor_position', amount: null, locator: '' }),
    session(7, { mode: 'completed_units', amount: null, completedUnitCount: 2 }),
    session(8, { mode: 'completed_units', amount: null, completedUnitCount: 0 }),
  ];
  const original = structuredClone(sessions);
  const h = await mount(sessions);
  try {
    const rows = [...h.host.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(sessions.length);
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual(
      sessions.map((row) => `/en/library/progress/${row.id}`),
    );
    expect(rows.map((row) => row.querySelector('[data-slot="progress-row"] span')?.textContent)).toEqual([
      '0.123456',
      '0',
      '0',
      '42.123456',
      'Ch. 3, 9',
      m.home_continue_in_progress(),
      '2',
      '0',
    ]);
    for (const [index, row] of rows.entries()) {
      const details = row.querySelector('details')!;
      expect(details.open).toBe(false);
      expect(details.previousElementSibling?.textContent?.trim()).toBe(
        m.library_progress_index_reader_history_unavailable(),
      );
      expect(details.querySelector('summary')?.textContent).toBe(m.library_progress_details());
      expect(details.querySelector('dt')?.textContent).toBe(
        `${m.library_progress_mode()} / ${m.library_progress_unit()}`,
      );
      expect(details.querySelector('code')?.textContent).toBe(`${sessions[index]!.mode} / ${sessions[index]!.unit}`);
      expect(details.textContent).toContain(m.library_history_unavailable());
      expect(details.textContent).toContain(m.library_progress_unit_unspecified());
      expect(row.querySelector('[role="progressbar"]')).toBeNull();
      expect(row.textContent).not.toMatch(/%|1\s*[-–]\s*2/);
    }
    const summary = rows[0]!.querySelector('summary')!;
    summary.focus();
    expect(document.activeElement).toBe(summary);
    expect(sessions).toEqual(original);
    expect(request).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Known unit labels, accepted totals and explicit progress semantics stay unchanged', async () => {
  const h = await mount([session(2, { amount: '3', total: '12', unitLabel: 'chapters' })]);
  try {
    expect(h.host.textContent).toContain('3 / 12 chapters');
    expect(h.host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('25');
    expect(h.host.querySelector('details')).toBeNull();
    expect(h.host.textContent).not.toContain(m.library_progress_index_reader_history_unavailable());
    expect(request).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Named keyboard pagination retains locale, exact scope and opaque next; first removes only the cursor and stale clicks stay guarded', async () => {
  for (const locale of ['en', 'de'] as const) {
    let current = true;
    const authority: ProgressAuthority = {
      key: {},
      isCurrent: () => current,
      permits: () => true,
      rowCurrent: () => true,
      headers: () => ({ 'x-csrf-token': 'credential' }),
    };
    const h = await mount([], locale, authority);
    try {
      const nav = h.host.querySelector('nav')!;
      expect(nav.getAttribute('aria-label')).toBe(m.library_progress_index_reader_pagination());
      expect(h.host.textContent).toContain(m.library_progress_page_empty());
      const links = [...nav.querySelectorAll('a')];
      expect(links.map((link) => link.textContent)).toEqual([
        m.library_collections_first_page(),
        m.library_progress_more(),
      ]);
      for (const [index, link] of links.entries()) {
        const destination = new URL(link.href);
        expect(destination.pathname).toBe(`/${locale}/library/progress`);
        expect([...destination.searchParams]).toEqual(
          index
            ? [
                ['subjectId', id(1)],
                ['cursor', h.next],
              ]
            : [['subjectId', id(1)]],
        );
        link.focus();
        expect(document.activeElement).toBe(link);
      }
      current = false;
      for (const link of links) {
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        await tick(() => link.dispatchEvent(click as unknown as MouseEvent));
        expect(click.defaultPrevented).toBe(true);
      }
      expect(h.router.state.location.search).toEqual({ subjectId: id(1), cursor: h.cursor });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  }
});
