import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, type ReactNode } from 'react';
import type {
  ProgressFailure,
  ProgressFinishInput,
  ProgressIndex,
  ProgressRecorded,
} from '../src/library/progress-reads';

// UNRUN: composed presentation assertions for controller execution; no browser or native proof.
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
  FocusEvent: window.FocusEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
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

const admitted = new Set<string>();
const finish = mock(
  async (_input: {
    data: ProgressFinishInput;
    headers?: HeadersInit;
  }): Promise<ProgressFailure | ProgressRecorded> => ({ ok: false, reason: 'conflict' }),
);
const unexpectedRead = () => {
  throw new Error('Session rows must use the supplied page');
};
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
// Supply admission and transport boundaries; render the installed ContentItem, cover, progress, menu and buttons.
mock.module('../src/kernel/exposure', () => ({
  useOperation: (operation: string) => admitted.has(operation),
  Exposure: ({ operation, children }: { operation: string; children: ReactNode }) =>
    admitted.has(operation) ? <Fragment>{children}</Fragment> : null,
}));
mock.module('../src/library/progress-server', () => ({
  finishProgressSession: finish,
  startProgressSession: unexpectedRead,
  readProgressChoices: unexpectedRead,
  readCurrentViewerProgressIndex: unexpectedRead,
}));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { ProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');

const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
type Session = ProgressIndex['sessions'][number];
const subject = {
  id: id(1),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: '海辺のカフカ', language: 'ja' },
  typeLabel: 'Novel',
  cover: null,
};
const session = (n: number, changes: Partial<Session> = {}): Session => ({
  id: id(n),
  subjectId: subject.id,
  subject,
  versionSubjectId: null,
  versionSubject: null,
  mode: 'scalar_amount',
  unit: 'pages',
  unitLabel: 'pages',
  amount: '0.123456',
  total: '9.654321',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision: 7,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  ...changes,
});

async function mount(sessions: Session[]) {
  setLocale('en', { reload: false });
  admitted.clear();
  for (const operation of ['read', 'complete', 'abandon']) admitted.add(`progress_session.${operation}`);
  finish.mockClear();
  const page: ProgressIndex = {
    signedIn: true,
    subjectId: '',
    selectedSubject: null,
    sessions,
    next: null,
    idempotencyKey: crypto.randomUUID(),
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/progress'] }),
  });
  await router.load();
  const show = () =>
    act(async () =>
      root.render(
        <StrictMode>
          <RouterContextProvider router={router}>
            <ProgressIndexPage page={page} />
          </RouterContextProvider>
        </StrictMode>,
      ),
    );
  await show();
  const body = within(window.document.body as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const click = (element: Element) =>
    act(async () => {
      await user.click(element as HTMLElement);
    });
  return {
    host,
    router,
    show,
    body,
    user,
    click,
    rows: () => [...host.querySelectorAll('ol > li')],
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Shared Progress heading names its exact session link in the displayed language and admission removes that destination', async () => {
  const item = session(20);
  const h = await mount([item]);
  try {
    expect(h.host.querySelectorAll('h1')).toHaveLength(1);
    const row = h.rows()[0]!;
    const heading = within(row as unknown as HTMLElement).getByRole('heading', { level: 2, name: subject.label.value });
    const link = within(row as unknown as HTMLElement).getByRole('link', { name: subject.label.value, exact: true });
    expect(link.getAttribute('href')).toBe(`/en/library/progress/${encodeURIComponent(item.id)}`);
    expect(link.getAttribute('aria-labelledby')).toBe(heading.id);
    expect(heading.getAttribute('lang')).toBe('ja');
    expect(link.getAttribute('lang')).toBe('ja');
    expect(row.querySelectorAll('h2')).toHaveLength(1);
    expect(row.querySelector('[data-slot="cover"]')).not.toBeNull();
    expect(row.textContent).toContain('Novel');
    expect(row.querySelector('[data-slot="progress-row"]')?.textContent).toContain('0.123456 / 9.654321 pages');
    expect(row.querySelector('a button, a a')).toBeNull();

    admitted.delete('progress_session.read');
    await h.show();
    expect(within(row as unknown as HTMLElement).queryByRole('link')).toBeNull();
    expect(within(row as unknown as HTMLElement).getByRole('heading', { level: 2 }).textContent).toBe(
      subject.label.value,
    );
    expect(h.body.getByRole('button', { name: m.library_collection_actions() })).toBeDefined();
  } finally {
    await h.close();
  }
});

test('Shared Progress preserves duplicate-subject sessions, literal positions, unknown shares and completed counts without ranges', async () => {
  const unknown = session(20, {
    mode: 'cursor_position',
    unit: 'chapters',
    amount: null,
    total: null,
    locator: 'Ch. 3, 9',
  });
  delete unknown.unitLabel;
  const completed = session(21, {
    mode: 'completed_units',
    unit: 'track',
    unitLabel: 'tracks',
    amount: null,
    total: null,
    completedUnitCount: 2,
    state: 'completed',
  });
  const h = await mount([unknown, completed]);
  try {
    const rows = h.rows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual([
      `/en/library/progress/${unknown.id}`,
      `/en/library/progress/${completed.id}`,
    ]);
    expect(rows.map((row) => row.querySelector('h2')?.textContent)).toEqual([subject.label.value, subject.label.value]);
    expect(rows[0]!.querySelector('[data-slot="progress-row"]')?.textContent).toContain('Ch. 3, 9');
    expect(rows[0]!.querySelector('code')?.textContent).toBe('cursor_position / chapters');
    expect(rows[0]!.textContent).toContain(m.library_history_unavailable());
    expect(rows[0]!.textContent).toContain(m.library_progress_state_active());
    expect(rows[1]!.querySelector('[data-slot="progress-row"]')?.textContent).toContain('2 tracks');
    expect(rows[1]!.textContent).not.toMatch(/1\s*[-–]\s*2/);
    expect(rows[1]!.textContent).toContain(m.library_progress_state_completed());
    expect(h.body.queryByRole('progressbar')).toBeNull();
  } finally {
    await h.close();
  }
});

test('Shared Progress menu and guarded confirmation act on the chosen session without primary navigation', async () => {
  const item = session(21);
  const h = await mount([session(20), item]);
  const redirects = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    admitted.delete('progress_session.read');
    await h.show();
    const row = h.rows()[1]!;
    const trigger = within(row as unknown as HTMLElement).getByRole('button', { name: m.library_collection_actions() });
    const open = () => h.click(trigger);
    const choose = (name: string) => h.click(h.body.getByRole('menuitem', { name, exact: true }));
    const confirm = () => h.body.getByRole('button', { name: m.library_progress_confirm_abandon(), exact: true });
    expect(row.querySelector('a')).toBeNull();
    expect(trigger.closest('[data-slot="list-row-control"]')).not.toBeNull();
    await open();
    expect(h.body.getByRole('menuitem', { name: m.library_progress_open_subject() }).getAttribute('href')).toBe(
      subjectHref({ id: subject.id, label: subject.label.value }, 'en').href,
    );
    await choose(m.library_progress_complete());
    await h.click(h.body.getByRole('button', { name: m.library_progress_cancel(), exact: true }));
    expect(h.body.queryByRole('button', { name: m.library_progress_confirm_complete() })).toBeNull();
    expect(finish).not.toHaveBeenCalled();

    admitted.delete('progress_session.abandon');
    await h.show();
    await open();
    await choose(m.library_progress_abandon());
    expect(h.body.queryByRole('button', { name: m.library_progress_confirm_abandon() })).toBeNull();
    admitted.add('progress_session.abandon');
    await h.show();
    await open();
    await choose(m.library_progress_abandon());
    expect(confirm().closest('[data-slot="list-row-control"]')).not.toBeNull();
    confirm().focus();
    await act(async () => {
      await h.user.keyboard('{Enter}');
    });
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0]![0]).toEqual({
      data: { sessionId: item.id, revision: 7, idempotencyKey: expect.any(String), action: 'abandon' },
      headers: { 'x-csrf-token': 'csrf' },
    });
    expect(within(row as unknown as HTMLElement).getByRole('alert').textContent).toBe(m.library_progress_conflict());
    expect(h.rows()[0]!.querySelector('[role="alert"]')).toBeNull();
    admitted.delete('progress_session.abandon');
    await h.show();
    await h.click(confirm());
    expect(finish).toHaveBeenCalledTimes(1);
    admitted.add('progress_session.abandon');
    await h.show();
    finish.mockResolvedValueOnce({ ok: true, session: { ...item, state: 'abandoned', revision: 8 } });
    await h.click(confirm());
    expect(finish.mock.calls[1]![0]).toEqual(finish.mock.calls[0]![0]);
    expect(row.textContent).toContain(m.library_progress_state_abandoned());
    expect(row.querySelector('[role="alert"]')).toBeNull();
    expect(h.body.queryByRole('button', { name: m.library_progress_confirm_abandon() })).toBeNull();
    admitted.delete('progress_session.complete');
    await h.show();
    expect(h.body.queryByRole('button', { name: m.library_collection_actions() })).toBeNull();
    expect(redirects).not.toHaveBeenCalled();
    expect(window.location.href).toBe('https://rezics.test/en/library/progress');
    expect(h.router.state.location.href).toBe('/en/library/progress');
  } finally {
    redirects.mockRestore();
    await h.close();
  }
});
