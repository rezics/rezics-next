import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, Fragment, StrictMode, type ReactNode } from 'react';
import type { ProgressIndex } from '../src/library/progress-reads';

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

const unexpectedRead = () => {
  throw new Error('Session rows must use the supplied page');
};
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': 'csrf' }) }));
mock.module('../src/kernel/exposure', () => ({
  useOperation: () => true,
  Exposure: ({ children }: { operation: string; children: ReactNode }) => <Fragment>{children}</Fragment>,
}));
mock.module('../src/library/progress-server', () => ({
  finishProgressSession: unexpectedRead,
  startProgressSession: unexpectedRead,
  readProgressChoices: unexpectedRead,
  readCurrentViewerProgressIndex: unexpectedRead,
}));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { ProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { fullDateTime } = await import('../src/threads/byline');

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
const paperback = {
  id: id(2),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: 'Paperback 2014', language: 'en' },
  typeLabel: 'Edition',
  cover: null,
};
const hardcover = {
  id: id(3),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: { value: 'Hardcover 2018', language: 'en' },
  typeLabel: 'Edition',
  cover: null,
};
const withheldVersionId = id(4);
function session(n: number, changes: Partial<Session> = {}): Session {
  const row: Session = {
    id: id(n),
    subjectId: subject.id,
    subject,
    versionSubjectId: null,
    versionSubject: null,
    mode: 'scalar_amount',
    unit: 'pages',
    amount: '12',
    total: '310',
    locator: null,
    position: null,
    completedUnitCount: 0,
    state: 'active',
    revision: 7,
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    ...changes,
  };
  delete row.unitLabel;
  return row;
}

async function mount(sessions: Session[]) {
  setLocale('en', { reload: false });
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
  await act(async () =>
    root.render(
      <StrictMode>
        <RouterContextProvider router={router}>
          <ProgressIndexPage page={page} />
        </RouterContextProvider>
      </StrictMode>,
    ),
  );
  return {
    host,
    close: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test('Equal-subject sessions are distinguishable by supplied version and start while destinations and unknown-unit warnings stay intact', async () => {
  const first = session(20, {
    versionSubjectId: paperback.id,
    versionSubject: paperback,
    startedAt: '2026-01-01T09:00:00Z',
  });
  const second = session(21, {
    versionSubjectId: hardcover.id,
    versionSubject: hardcover,
    startedAt: '2026-03-15T18:30:00Z',
  });
  const withheld = session(22, {
    versionSubjectId: withheldVersionId,
    versionSubject: null,
    startedAt: '2026-04-02T12:00:00Z',
  });
  const unspecified = session(23, { startedAt: '2026-05-20T08:15:00Z' });
  const h = await mount([first, second, withheld, unspecified]);
  try {
    const rows = [...h.host.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual(
      [first, second, withheld, unspecified].map((row) => `/en/library/progress/${encodeURIComponent(row.id)}`),
    );
    const metadata = rows.map((row) => row.querySelector('[data-content-item-slot="metadata"]')!);
    expect(metadata[0]!.textContent).toContain(paperback.label.value);
    expect(metadata[0]!.textContent).toContain(fullDateTime(first.startedAt, 'en'));
    expect(metadata[1]!.textContent).toContain(hardcover.label.value);
    expect(metadata[1]!.textContent).toContain(fullDateTime(second.startedAt, 'en'));
    expect(metadata[0]!.textContent).not.toBe(metadata[1]!.textContent);
    expect(metadata[2]!.textContent).toContain(m.library_subject_unavailable());
    expect(rows[2]!.innerHTML).not.toContain(withheldVersionId);
    expect(metadata[3]!.textContent).toContain(fullDateTime(unspecified.startedAt, 'en'));
    expect(metadata[3]!.textContent).not.toContain(m.library_progress_no_version());
    expect(metadata[3]!.textContent).not.toContain(paperback.label.value);
    expect(metadata.map((slot) => slot.querySelector('time')?.dateTime)).toEqual(
      [first, second, withheld, unspecified].map((row) => row.startedAt),
    );
    for (const row of rows) {
      expect(row.querySelector('[data-slot="progress-row"]')?.textContent).toContain('12 / 310');
      expect(row.textContent).toContain(m.library_progress_state_active());
      const details = row.querySelector('details')!;
      expect(details.previousElementSibling?.textContent?.trim()).toBe(
        m.library_progress_index_reader_history_unavailable(),
      );
      expect(details.querySelector('code')?.textContent).toBe('scalar_amount / pages');
    }
  } finally {
    await h.close();
  }
});
