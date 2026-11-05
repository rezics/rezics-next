import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, useState, type ReactNode } from 'react';
import type { ProgressDetailOrigin } from '../src/library/progress-session';
import type { ProgressChange, ProgressSessionPage as Page } from '../src/library/progress-reads';

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
  scrollTo: window.scrollTo.bind(window),
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
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ProgressSessionPage } = await import('../src/library/progress-session');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, getLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');

type LoadedPage = Extract<Page, { signedIn: true }>;
const stamp = '2026-10-02T23:59:59.123Z';
const cursors = {
  changes: 'changes/current+?q=原文#一% &==',
  units: 'units/current+?q=原文#二% &==',
  logs: 'logs/current+?q=原文#三% &==',
};
function change(id: string, values: Partial<ProgressChange> = {}): ProgressChange {
  return {
    id,
    revision: 2,
    createdAt: stamp,
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
    session: {
      id: '0192f3a0-6c1e-7b2a-9d4e-000000000801',
      subjectId: '0192f3a0-6c1e-7b2a-9d4e-000000000802',
      versionSubjectId: null,
      subject: null,
      versionSubject: null,
      mode: 'completed_units',
      unit: 'historic-unit-x',
      unitLabel: 'segments',
      meaning: 'known',
      recordingState: 'unavailable',
      amount: null,
      total: null,
      locator: null,
      position: null,
      completedUnitCount: 0,
      state: 'completed',
      revision: 7,
      startedAt: stamp,
      completedAt: stamp,
      changes: [],
      changesNext: null,
      units: [],
      unitsNext: null,
      ...values,
    },
  };
}
async function mount(initial: LoadedPage, originating?: ProgressDetailOrigin) {
  window.history.replaceState({}, '', '/en/library/progress');
  setLocale('en', { reload: false });
  admitted.clear();
  admitted.add('progress_session.changes');
  admitted.add('progress_session.units');
  unexpectedRequest.mockClear();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-out', csrfToken: null });
  let shown = initial;
  let renderPage: () => void;
  const route = createRootRoute({
    component: function Page() {
      const [, render] = useState(0);
      renderPage = () => render((value) => value + 1);
      return <ProgressSessionPage page={shown} logsCursor={cursors.logs} originating={originating} />;
    },
  });
  const detail = createRoute({
    getParentRoute: () => route,
    path: '/library/progress/$id',
    validateSearch: (search: Record<string, unknown>) => search,
  });
  const router = createRouter({
    routeTree: route.addChildren([detail]),
    history: createMemoryHistory({ initialEntries: [`/en/library/progress/${initial.session.id}`] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  await router.load();
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
  const show = (p = initial) =>
    act(async () => {
      shown = p;
      renderPage();
    });
  const view = within(host as unknown as HTMLElement);
  const region = (kind: 'changes' | 'units') =>
    view.getByRole('region', {
      name: kind === 'changes' ? m.library_progress_changes() : m.library_progress_units(),
    });
  return {
    host,
    router,
    view,
    region,
    show,
    user: userEvent.setup({ document: window.document as unknown as Document }),
    rows: () => [...region('changes').querySelectorAll(':scope > ol > li')],
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
      client.clear();
      window.history.replaceState({}, '', '/en/library/progress');
      setLocale('en', { reload: false });
    },
  };
}
function facts(element: Element) {
  return [...element.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent]);
}

test('Short facts, zero, missing values and explicit completion/abandonment stay scannable in native order', async () => {
  const initial = page({
    changes: [
      change('zero', { amount: '0.000000', locator: '  Part 2\n original  ', position: '0' }),
      change('absent'),
      change('complete', { action: 'complete' }),
      change('abandon', { action: 'abandon' }),
      change('blank', { locator: '' }),
    ],
    units: ['third', 'first', 'first'],
  });
  const before = JSON.stringify(initial);
  const h = await mount(initial);
  try {
    expect(h.rows().map((row) => row.querySelector('h3')!.textContent)).toEqual([
      m.library_progress_change_recorded(),
      m.library_progress_change_recorded(),
      m.library_progress_state_completed(),
      m.library_progress_state_abandoned(),
      m.library_progress_change_recorded(),
    ]);
    expect(facts(h.rows()[0]!)).toEqual([
      [m.library_progress_amount(), '0.000000'],
      [m.library_progress_locator(), '  Part 2\n original  '],
      [m.library_progress_position(), '0'],
    ]);
    expect(facts(h.rows()[4]!)).toEqual([[m.library_progress_locator(), '']]);
    for (const row of h.rows().slice(1, 4)) expect(row.querySelector('dl')).toBeNull();
    expect(h.region('changes').querySelector('details, a, button, code, [role="progressbar"]')).toBeNull();
    expect(h.rows().every((row) => row.getAttribute('data-slot') === 'list-row')).toBe(true);
    expect(h.rows().map((row) => row.querySelector('time')?.getAttribute('datetime'))).toEqual(Array(5).fill(stamp));
    expect([...h.region('units').querySelectorAll(':scope > ul > li')].map((row) => row.textContent)).toEqual([
      'third',
      'first',
      'first',
    ]);
    expect(h.region('units').querySelector('summary')).toBeNull();
    expect(h.region('changes').textContent).not.toContain('historic-unit-x');
    expect(JSON.stringify(initial)).toBe(before);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Long text and added/removed occurrences have bounded previews with complete, separate keyboard disclosures', async () => {
  const literal = `  <original & exact>\n${'原文📚/unbroken:'.repeat(100)}\n  `;
  const original = change('long', {
    amount: '0',
    locator: literal,
    position: ` position ${literal}`,
    add: ['same', literal, 'same', '3', '1', 'last added'],
    remove: ['9', '9', literal, 'last removed', '2'],
  });
  const initial = page({
    changes: [original, change('second', { locator: literal })],
    units: [literal, literal, 'short'],
  });
  const before = JSON.stringify(initial);
  const h = await mount(initial);
  try {
    const rows = h.rows();
    const preview = rows[0]!.querySelector('[data-history-preview]')!;
    expect(preview.textContent!.length).toBeLessThan(1000);
    expect(preview.textContent).not.toContain(literal);
    expect(preview.querySelectorAll('li')).toHaveLength(4);
    const detail = rows[0]!.querySelector('details')!;
    expect(detail.open).toBe(false);
    const summary = detail.querySelector('summary')!;
    expect(summary.textContent).toBe(m.library_progress_history_reader_change_details({ number: 1 }));
    expect(summary.className).toContain('focus-visible:outline');
    expect(rows[1]!.querySelector('summary')!.textContent).toBe(
      m.library_progress_history_reader_change_details({ number: 2 }),
    );
    await act(async () => {
      summary.focus();
      await h.user.click(summary);
    });
    expect(window.document.activeElement).toBe(summary);
    expect(detail.open).toBe(true);
    const fullFacts = facts(detail);
    expect(fullFacts.slice(0, 3)).toEqual([
      [m.library_progress_amount(), '0'],
      [m.library_progress_locator(), literal],
      [m.library_progress_position(), original.position],
    ]);
    const fullLists = [...detail.querySelectorAll('dd ul')].map((ul) =>
      [...ul.querySelectorAll('li')].map((li) => li.textContent),
    );
    expect(fullLists).toEqual([original.add, original.remove]);
    expect(detail.querySelector('dd.line-clamp-2, li.line-clamp-2')).toBeNull();
    expect(detail.querySelector('dd')!.className).toContain('[overflow-wrap:anywhere]');
    expect(rows[1]!.querySelector('details')!.open).toBe(false);
    const unitRows = [...h.region('units').querySelectorAll(':scope > ul > li')];
    expect(unitRows).toHaveLength(3);
    const first = unitRows[0]!.querySelector('summary')!;
    const second = unitRows[1]!.querySelector('summary')!;
    expect(first.textContent).not.toBe(second.textContent);
    await act(async () => {
      first.focus();
      await h.user.click(first);
    });
    expect(first.closest('details')!.open).toBe(true);
    expect(second.closest('details')!.open).toBe(false);
    expect(first.nextElementSibling!.textContent).toBe(literal);
    expect(first.nextElementSibling!.className).toContain('whitespace-pre-wrap');
    expect(unitRows[2]!.querySelector('summary')).toBeNull();
    const replacement = {
      ...initial,
      changesCursor: 'another-changes-page',
      unitsCursor: 'another-page',
      session: { ...initial.session, units: [literal, 'new'] },
    };
    await h.show(replacement);
    expect(h.region('changes').querySelector('details')!.open).toBe(false);
    expect(h.region('units').querySelector('details')!.open).toBe(false);
    expect(JSON.stringify(initial)).toBe(before);
    expect(unexpectedRequest).not.toHaveBeenCalled();
  } finally {
    await h.close();
  }
});

test('Change identity follows change.id on reorder, while duplicate unit occurrences never share expansion', async () => {
  const text = 'recorded '.repeat(80);
  const initial = page({
    changes: [change('a', { locator: text }), change('b', { locator: text })],
    units: [text, text],
  });
  const h = await mount(initial);
  try {
    const [a, b] = h.rows();
    await act(async () => h.user.click(a!.querySelector('summary')!));
    await h.show({ ...initial, session: { ...initial.session, changes: [...initial.session.changes].reverse() } });
    expect(h.rows()).toEqual([b, a]);
    expect(a!.querySelector('details')!.open).toBe(true);
    expect(b!.querySelector('details')!.open).toBe(false);
    const units = [...h.region('units').querySelectorAll('details')];
    await act(async () => h.user.click(units[1]!.querySelector('summary')!));
    expect(units.map((value) => value.open)).toEqual([false, true]);
  } finally {
    await h.close();
  }
});

test('First/later empty pages are honest and each first/next link preserves the other two exact cursors', async () => {
  for (const cursor of [false, true])
    for (const next of [false, true]) {
      const initial = {
        ...page({ changesNext: next ? 'next-changes/+? &==' : null, unitsNext: next ? 'next-units/+? &==' : null }),
        ...(cursor ? { changesCursor: cursors.changes, unitsCursor: cursors.units } : {}),
      };
      const h = await mount(initial);
      try {
        for (const kind of ['changes', 'units'] as const) {
          const region = h.region(kind);
          const empty = kind === 'changes' ? m.library_progress_changes_empty() : m.library_progress_units_empty();
          const pageEmpty =
            kind === 'changes'
              ? m.library_progress_history_reader_changes_page_empty()
              : m.library_progress_history_reader_units_page_empty();
          expect(region.textContent).toContain(cursor || next ? pageEmpty : empty);
          if (cursor || next) expect(region.textContent).not.toContain(empty);
          const first = within(region).queryByRole('link', { name: m.library_collections_first_page() });
          const more = within(region).queryByRole('link', { name: m.library_progress_more() });
          expect(!!first).toBe(cursor);
          expect(!!more).toBe(next);
          for (const link of [first, more].filter((value) => value !== null)) {
            const url = new URL(link.getAttribute('href')!, window.location.href);
            expect(url.pathname).toBe(`/en/library/progress/${initial.session.id}`);
            expect(url.searchParams.get('logs')).toBe(cursors.logs);
            expect(url.searchParams.get(kind)).toBe(
              link === first ? null : kind === 'changes' ? initial.session.changesNext : initial.session.unitsNext,
            );
            const other = kind === 'changes' ? 'units' : 'changes';
            expect(url.searchParams.get(other)).toBe(cursor ? cursors[other] : null);
          }
        }
        expect(unexpectedRequest).not.toHaveBeenCalled();
      } finally {
        await h.close();
      }
    }
});

test('Absent operations hide only their navigation and retired origin/capture/locale reject each recovery and continuation', async () => {
  for (const retirement of ['origin', 'capture', 'locale'] as const)
    for (const index of [0, 1, 2, 3])
      for (const type of ['click', 'auxclick']) {
        let current = true;
        const initial = {
          ...page({ changesNext: 'next-changes', unitsNext: 'next-units' }),
          changesCursor: cursors.changes,
          unitsCursor: cursors.units,
        };
        const origin: ProgressDetailOrigin = {
          viewer: 'owner',
          address: { id: initial.session.id, ...cursors },
          isCurrent: () => getLocale() === 'en' && (retirement === 'origin' ? current : true),
          ...(retirement === 'capture' ? { capture: () => ({ isCurrent: () => current, headers: () => null }) } : {}),
          refresh: unexpectedRequest,
        };
        const h = await mount(initial, origin);
        try {
          const links = [...h.region('changes').querySelectorAll('a'), ...h.region('units').querySelectorAll('a')];
          expect(links).toHaveLength(4);
          if (retirement === 'locale') {
            window.history.replaceState({}, '', '/ja/library/progress');
            setLocale('ja', { reload: false });
            expect(getLocale()).toBe('ja');
          } else current = false;
          await act(async () => {
            // A dispatch may render new handlers; each stale callback gets its own retained render.
            const event = new window.MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              button: type === 'click' ? 0 : 1,
            });
            links[index]!.dispatchEvent(event as unknown as MouseEvent);
            expect({ retirement, type, prevented: event.defaultPrevented }).toEqual({
              retirement,
              type,
              prevented: true,
            });
          });
          expect(h.router.state.location.search).toEqual({});
          expect(unexpectedRequest).not.toHaveBeenCalled();
          setLocale('en', { reload: false });
          current = true;
          admitted.delete('progress_session.changes');
          await h.show();
          expect(h.region('changes').querySelectorAll('a')).toHaveLength(0);
          expect(h.region('units').querySelectorAll('a')).toHaveLength(2);
          admitted.delete('progress_session.units');
          await h.show();
          expect(h.region('units').querySelectorAll('a')).toHaveLength(0);
        } finally {
          await h.close();
        }
      }
});

test('Admitted first-page recovery navigates independently for changes and units', async () => {
  for (const kind of ['changes', 'units'] as const) {
    const initial = { ...page(), changesCursor: cursors.changes, unitsCursor: cursors.units };
    const h = await mount(initial);
    try {
      const first = within(h.region(kind)).getByRole('link', { name: m.library_collections_first_page() });
      await act(async () => h.user.click(first));
      expect(h.router.state.location.pathname).toBe(`/library/progress/${initial.session.id}`);
      expect(h.router.state.location.search).toEqual({
        logs: cursors.logs,
        [kind === 'changes' ? 'units' : 'changes']: kind === 'changes' ? cursors.units : cursors.changes,
      });
      expect(unexpectedRequest).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  }
});
