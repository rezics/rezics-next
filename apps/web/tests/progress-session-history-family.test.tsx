import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, type ReactNode } from 'react';
import type { ProgressChange, ProgressSessionPage as Page } from '../src/library/progress-reads';

// UNRUN: composed history/hierarchy outcomes. Existing current-viewer/current-origin suites retain
// authority, exact uncertain command and late-result coverage; native/browser acceptance is deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress', width: 1280, height: 900 });
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
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
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

const admitted = new Set<string>();
const unexpectedRequest = mock(() => {
  throw new Error('History presentation must use its supplied immutable values');
});
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
mock.module('../src/kernel/exposure', () => ({
  useOperation: (operation: string) => admitted.has(operation),
  operationIsAdmitted: (operation: string) => admitted.has(operation),
  Exposure: ({ operation, children }: { operation: string; children: ReactNode }) =>
    admitted.has(operation) ? <Fragment>{children}</Fragment> : null,
}));
mock.module('../src/library/progress-server', () => ({
  readProgressSession: unexpectedRequest,
  recordProgressSession: unexpectedRequest,
  finishProgressSession: unexpectedRequest,
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ProgressSessionPage } = await import('../src/library/progress-session');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

type LoadedPage = Extract<Page, { signedIn: true }>;
function change(id: string, values: Partial<ProgressChange> = {}): ProgressChange {
  return {
    id,
    revision: 2,
    createdAt: '2026-10-02T23:59:59.123Z',
    action: null,
    amount: null,
    locator: null,
    position: null,
    add: [],
    remove: [],
    ...values,
  };
}
function page(values: Partial<LoadedPage['session']> = {}): LoadedPage {
  return {
    signedIn: true,
    idempotencyKey: '10203040-5060-4070-8090-102030405060',
    changesCursor: 'changes-current/+?== &記録',
    unitsCursor: 'units-current/+?== &単位',
    session: {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000000801',
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000802',
      versionSubjectId: null,
      subject: {
        id: '0192f3a0-6c1e-7b2a-9d4e-000000000802',
        type: 'book',
        types: ['book'],
        label: 'An original reading',
        cover: null,
      },
      versionSubject: null,
      mode: 'scalar_amount',
      unit: 'historic-unit-x',
      unitLabel: 'pages',
      meaning: 'known',
      recordingState: 'supported',
      amount: '4.750000',
      total: '100',
      locator: null,
      position: null,
      completedUnitCount: 0,
      state: 'active',
      revision: 7,
      startedAt: '2026-10-01T00:00:00Z',
      completedAt: null,
      changes: [],
      changesNext: 'changes-next/+?== &記録',
      units: [],
      unitsNext: null,
      ...values,
    },
  };
}
async function mount(
  initial: LoadedPage,
  returnContext?: {
    indexHref: string;
    indexSearch: { state?: string; cursor?: string };
    locale: string;
    sessionId: string;
    subjectId: string;
    startedAt: string;
    sourceReturnTo?: string;
  },
) {
  setLocale('en', { reload: false });
  admitted.clear();
  for (const operation of ['record', 'complete', 'abandon', 'create', 'changes', 'units'])
    admitted.add(`progress_session.${operation}`);
  unexpectedRequest.mockClear();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/en/library/progress', component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const show = (p = initial) =>
    act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              <ProgressSessionPage
                page={p}
                logsCursor="logs-current/+?== &公開"
                returnContext={returnContext}
              />
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  await show();
  const body = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const history = () => body.getByRole('region', { name: m.library_progress_changes(), exact: true });
  return {
    host,
    body,
    user,
    router,
    show,
    history,
    rows: () => [...history().querySelectorAll(':scope > ol > li')],
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
    },
  };
}
function definitions(row: Element) {
  return [...row.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
}

test('Amount history uses ordered shared documents and retains exact original decimals, locators, timestamps and lifecycle actions', async () => {
  const original = page({
    state: 'completed',
    changes: [
      change('zero', { amount: '0.000000', revision: 5 }),
      change('earlier', {
        amount: '999999999999.000001',
        locator: '  epubcfi(/6/2[original <chapter> & notes])\n ',
        position: '12.250001',
        createdAt: '2026-10-01T00:00:00.001Z',
      }),
      change('complete', { action: 'complete', revision: 7 }),
    ],
  });
  const before = JSON.stringify(original);
  for (const entry of original.session.changes) Object.freeze(entry);
  Object.freeze(original.session.changes);
  const h = await mount(original);
  try {
    const rows = h.rows();
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('h3')?.textContent)).toEqual([
      m.library_progress_change_recorded(),
      m.library_progress_change_recorded(),
      m.library_progress_state_completed(),
    ]);
    for (const [index, row] of rows.entries()) {
      expect(row.getAttribute('data-slot')).toBe('list-row');
      expect(row.querySelector('h3')?.getAttribute('data-content-item-slot')).toBe('title');
      expect(row.querySelector('[data-content-item-slot="metadata"] time')?.getAttribute('datetime')).toBe(
        original.session.changes[index]!.createdAt,
      );
      expect(row.querySelector('time')?.getAttribute('title')).toBeTruthy();
      expect(row.querySelector('a, button, [role="progressbar"]')).toBeNull();
    }
    expect(definitions(rows[0]!)).toEqual([[m.library_progress_amount(), '0.000000']]);
    expect(definitions(rows[1]!)).toEqual([
      [m.library_progress_amount(), '999999999999.000001'],
      [m.library_progress_locator(), original.session.changes[1]!.locator],
      [m.library_progress_position(), '12.250001'],
    ]);
    expect(rows[1]!.querySelectorAll('dd')[1]!.className).toContain('whitespace-pre-wrap');
    expect(rows[2]!.querySelector('dl')).toBeNull();
    expect(h.host.querySelector('header [data-slot="progress-row"]')?.textContent).toContain('4.750000 / 100 pages');
    expect(h.host.querySelector('header [data-progress-state]')?.textContent).toBe(
      m.library_progress_state_completed(),
    );
    expect(h.body.queryByRole('button', { name: m.library_progress_update() })).toBeNull();
    expect(JSON.stringify(original)).toBe(before);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Discrete history and sparse unit pages preserve each exact key and every independent continuation without inventing a percentage', async () => {
  const added = ['7', '1', '3', 'part~09'];
  const removed = ['part:005', '9'];
  const original = page({
    mode: 'completed_units',
    amount: null,
    total: null,
    unitLabel: 'units',
    completedUnitCount: 3,
    state: 'abandoned',
    changes: [change('set', { add: added, remove: removed }), change('abandon', { action: 'abandon' })],
    units: ['1', '3'],
    unitsNext: 'units-next/+?== &単位',
  });
  const h = await mount(original);
  try {
    const rows = h.rows();
    expect(rows).toHaveLength(2);
    expect(
      [...rows[0]!.querySelectorAll('dl > div')].map((group) => [
        group.querySelector('dt')!.textContent,
        [...group.querySelectorAll('dd li')].map((li) => li.textContent),
      ]),
    ).toEqual([
      [m.library_progress_units_added(), added],
      [m.library_progress_units_removed(), removed],
    ]);
    expect(rows[1]!.querySelector('h3')!.textContent).toBe(m.library_progress_state_abandoned());
    expect(h.history().textContent).not.toMatch(/%|1\s*[-–]\s*7/);
    expect(h.body.queryByRole('progressbar')).toBeNull();
    const units = h.body.getByRole('region', { name: m.library_progress_units(), exact: true });
    expect([...units.querySelectorAll(':scope > ul > li')].map((li) => li.textContent)).toEqual(['1', '3']);
    expect(units.querySelector('[data-slot="list-row"]')).toBeNull();
    const limitation = window.document.getElementById(units.getAttribute('aria-describedby')!);
    expect(limitation?.textContent).toBe(m.library_progress_structure_unverified());
    expect(limitation?.closest('details')).toBeNull();
    for (const [region, changes, unitCursor] of [
      [h.history(), original.session.changesNext, original.unitsCursor],
      [units, original.changesCursor, original.session.unitsNext],
    ] as const) {
      const href = within(region).getByRole('link', { name: m.library_progress_more() }).getAttribute('href')!;
      const url = new URL(href, window.location.href);
      expect(url.pathname).toBe(`/library/progress/${original.session.id}`);
      expect(Object.fromEntries(url.searchParams)).toEqual({
        changes,
        units: unitCursor,
        logs: 'logs-current/+?== &公開',
      });
    }
    admitted.delete('progress_session.changes');
    admitted.delete('progress_session.units');
    await h.show();
    expect(within(h.history()).queryByRole('link', { name: m.library_progress_more() })).toBeNull();
    expect(within(units).queryByRole('link', { name: m.library_progress_more() })).toBeNull();
    expect(h.rows()).toHaveLength(2);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Unknown meaning and recording limits stay beside the current value and recovery, with optional raw references in a keyboard reachable native disclosure', async () => {
  const original = page({
    meaning: 'unknown',
    recordingState: 'unavailable',
    mode: 'cursor_position',
    amount: null,
    total: null,
    locator: ' epubcfi(/6/2[old-chapter]) ',
    position: '12.250001',
    changes: [change('cursor', { locator: '  original:part~3  ', position: '0.000001' })],
  });
  delete original.session.unitLabel;
  const h = await mount(original);
  try {
    const header = h.host.querySelector('header')!;
    const meaning = within(header).getByText(m.library_progress_meaning_unknown());
    const alignment = within(header).getByText(m.library_progress_structure_unverified());
    expect(meaning.closest('details')).toBeNull();
    expect(alignment.closest('details')).toBeNull();
    expect(header.querySelector('dd')!.textContent).toBe(original.session.locator);
    const summary = within(header).getByText(m.library_progress_details());
    const details = summary.closest('details')!;
    expect(summary.tagName).toBe('SUMMARY');
    expect(details.hasAttribute('open')).toBe(false);
    expect(summary.className).toContain('focus-visible:outline');
    await act(async () => {
      await h.user.tab();
      await h.user.tab();
    });
    expect(window.document.activeElement).toBe(summary);
    expect(definitions(details)).toEqual([
      [m.library_progress_mode(), 'cursor_position'],
      [m.library_progress_unit(), 'historic-unit-x'],
    ]);
    const unavailable = h.body.getByText(m.library_progress_recording_unavailable());
    expect(unavailable.closest('details')).toBeNull();
    expect(unavailable.parentElement!.querySelector('button')!.textContent).toBe(m.library_progress_retry());
    expect(h.body.queryByRole('button', { name: m.library_progress_update() })).toBeNull();
    expect(h.body.getByRole('link', { name: m.library_progress_new_session() })).toBeDefined();
    expect(h.body.getByRole('button', { name: m.library_collection_actions() })).toBeDefined();
    expect(h.body.queryByRole('progressbar')).toBeNull();
    expect(definitions(h.rows()[0]!)).toEqual([
      [m.library_progress_locator(), '  original:part~3  '],
      [m.library_progress_position(), '0.000001'],
    ]);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('a reviewed correction returns to its selected index only after the draft choice', async () => {
  const original = page();
  const cursor = 'continued/+?== &記録';
  const indexSearch = { state: 'active', cursor };
  const returnContext = {
    indexHref: `/en/library/progress?${new URLSearchParams(indexSearch)}`,
    indexSearch,
    locale: 'en',
    sessionId: original.session.id,
    subjectId: original.session.subjectId,
    startedAt: original.session.startedAt,
  };
  const h = await mount(original, returnContext);
  try {
    await act(async () => h.user.click(h.body.getByRole('button', { name: m.library_progress_clear() })));
    const editor = h.body.getByRole('dialog');
    const returnLink = within(editor).getByRole('link', { name: m.library_progress_return_to_progress() });
    const target = new URL(returnLink.getAttribute('href')!, window.location.href);
    expect(target.searchParams.get('cursor')).toBe(cursor);
    expect(target.searchParams.get('state')).toBe('active');

    await act(async () => h.user.click(returnLink));
    let decision = h.body.getByRole('alertdialog');
    expect(within(decision).getByRole('heading', { name: m.library_progress_draft_navigation_title() })).toBeDefined();
    await act(async () => h.user.click(within(decision).getByRole('button', { name: m.library_progress_draft_navigation_stay() })));
    expect(h.body.getByRole('dialog')).toBeDefined();

    await act(async () => h.user.click(within(h.body.getByRole('dialog')).getByRole('link', { name: m.library_progress_return_to_progress() })));
    decision = h.body.getByRole('alertdialog');
    await act(async () =>
      h.user.click(within(decision).getByRole('button', { name: m.library_progress_draft_navigation_discard() })),
    );
    const state = h.router.state.location.state as { progressReturnSelection?: { sessionId?: string; subjectId?: string } };
    expect(state.progressReturnSelection).toEqual({
      locale: 'en',
      sessionId: original.session.id,
      subjectId: original.session.subjectId,
      startedAt: original.session.startedAt,
    });
    expect(h.router.state.location.search).toMatchObject(indexSearch);
  } finally {
    await h.close();
  }
});
