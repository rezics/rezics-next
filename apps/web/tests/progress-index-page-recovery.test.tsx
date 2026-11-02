import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { CurrentViewerProgressIndex } from '../src/library/progress-server';
import type {
  ProgressFailure,
  ProgressFinishInput,
  ProgressIndex,
  ProgressRecorded,
  ProgressStarted,
  ProgressStartInput,
} from '../src/library/progress-reads';
import type { EntityPickerProps } from '@rezics/ui/entity-picker';

// UNRUN: focused composed outcomes for controller execution; no native or browser proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://rezics.test/en/library/progress', width: 390, height: 844 });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const { QueryClient, QueryClientProvider, useQuery } = await import('@tanstack/react-query');
const sessionQuery = { queryKey: ['session'] as const, enabled: false };
type Viewer = { state: 'signed-in'; subject: string; csrfToken: string };
const viewer = (subject = 'A', csrfToken = `${subject}-credential`): Viewer => ({
  state: 'signed-in',
  subject,
  csrfToken,
});
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('../src/session/query', () => ({
  sessionQuery,
  useSession: () => useQuery<Viewer>(sessionQuery).data ?? { state: 'unknown', subject: null, csrfToken: null },
}));
mock.module('../src/threads/composer', () => ({
  csrfHeaders: () => {
    throw new Error('Use current authority');
  },
}));
mock.module('@rezics/ui/entity-picker', () => ({
  EntityPicker: ({ value }: EntityPickerProps) => <div>{value?.map((item) => item.title).join(', ')}</div>,
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect?: () => void }[] }) => (
    <div>
      {entries
        .filter((entry) => entry.onSelect)
        .map((entry) => (
          <button key={entry.label} onClick={entry.onSelect}>
            {entry.label}
          </button>
        ))}
    </div>
  ),
}));
type Kind = 'start' | 'complete' | 'abandon';
type Result = ProgressFailure | ProgressStarted | ProgressRecorded;
const writes: {
  data: ProgressStartInput | ProgressFinishInput;
  headers?: HeadersInit;
  work: ReturnType<typeof deferred<Result>>;
}[] = [];
const reads: { data: unknown; work: ReturnType<typeof deferred<CurrentViewerProgressIndex>> }[] = [];
function command(input: { data: ProgressStartInput | ProgressFinishInput; headers?: HeadersInit }) {
  const work = deferred<Result>();
  writes.push({ ...input, work });
  return work.promise;
}
const choices = mock(() => {
  throw new Error('Recovery must not look up profiles');
});
mock.module('../src/library/progress-server', () => ({
  startProgressSession: command,
  finishProgressSession: command,
  readProgressChoices: choices,
  readCurrentViewerProgressIndex: (input: { data: unknown }) => {
    const work = deferred<CurrentViewerProgressIndex>();
    reads.push({ ...input, work });
    return work.promise;
  },
}));
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { CurrentViewerProgressIndexPage, ProgressIndexPage } = await import('../src/library/progress-page');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale, localizeUrl, deLocalizeUrl } = await import('../src/paraglide/runtime.js');
const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const subject = (owner: string) => ({
  id: id(1),
  type: 'schema:Book',
  types: ['schema:Book'],
  label: `Private ${owner} — A long subject title with enough text to wrap on a narrow progress list`,
  cover: null,
  typeLabel: 'Book',
});
type Session = ProgressIndex['sessions'][number];
function session(owner = 'A', changes: Partial<Session> = {}): Session {
  return {
    id: id(20),
    subjectId: id(1),
    subject: subject(owner),
    versionSubjectId: null,
    versionSubject: null,
    mode: 'scalar_amount',
    unit: 'original:page~unknown',
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
function envelope({
  owner = 'A',
  locale = 'en',
  subjectId = id(1),
  cursor = 'earlier/opaque+==',
  sessions = [],
  next = null,
}: {
  owner?: string;
  locale?: string;
  subjectId?: string;
  cursor?: string | null;
  sessions?: Session[];
  next?: string | null;
} = {}): CurrentViewerProgressIndex {
  return {
    viewer: owner,
    locale,
    requested: { subjectId, cursor },
    page: {
      signedIn: true,
      subjectId,
      selectedSubject: subjectId ? subject(owner) : null,
      sessions,
      next,
      idempotencyKey: crypto.randomUUID(),
      progressChoices: [
        { mode: 'scalar_amount', units: [{ id: 'page', label: 'pages', step: 'any', total: 'optional' }] },
      ],
    },
  };
}
const tick = (run: () => unknown = () => {}) =>
  act(async () => {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
function propsOf<T>(element: Element): T {
  return Object.entries(element).find(([key]) => key.startsWith('__reactProps$'))![1] as T;
}
async function mount(initial = envelope(), standalone = false) {
  setLocale(initial.locale as Parameters<typeof setLocale>[0], { reload: false });
  writes.length = reads.length = 0;
  choices.mockClear();
  let loader = initial;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  const lifetime = viewerExposureLifetime(client);
  const stop = lifetime.subscribe(() => {});
  const admit = (admitted = ['reading_progress']) => {
    const snapshot = lifetime.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected current viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  admit();
  const params = new URLSearchParams({ subjectId: initial.requested.subjectId });
  if (initial.requested.cursor) params.set('cursor', initial.requested.cursor);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: [`/${initial.locale}/library/progress?${params}`] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  });
  await router.load();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const redirects: string[] = [];
  const redirect = spyOn(window.location, 'assign').mockImplementation((href) => {
    redirects.push(String(href));
  });
  const show = () =>
    tick(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              {standalone ? (
                <ProgressIndexPage page={loader.page} />
              ) : (
                <CurrentViewerProgressIndexPage
                  loader={loader}
                  requested={{
                    ...(initial.requested.subjectId ? { subjectId: initial.requested.subjectId } : {}),
                    ...(initial.requested.cursor ? { cursor: initial.requested.cursor } : {}),
                  }}
                />
              )}
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  await show();
  const view = within(host);
  const user = userEvent.setup({ document });
  const click = (element: HTMLElement) =>
    tick(async () => {
      await user.click(element);
    });
  const callback = (kind: Kind) => {
    if (kind === 'start') {
      const props = propsOf<{ onSubmit: (event: { preventDefault(): void }) => unknown }>(host.querySelector('form')!);
      return () => {
        void props.onSubmit({ preventDefault() {} });
      };
    }
    return propsOf<{ onClick: () => unknown }>(
      view.getByRole('button', {
        name: kind === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon(),
        exact: true,
      }),
    ).onClick;
  };
  return {
    host,
    view,
    user,
    router,
    client,
    redirects,
    click,
    callback,
    admit,
    rotate: (owner: string, token?: string) => {
      client.setQueryData(sessionQuery.queryKey, viewer(owner, token));
      admit();
    },
    refresh: async (value: CurrentViewerProgressIndex) => {
      const query = client
        .getQueryCache()
        .findAll({ queryKey: ['library', 'progress', 'current-viewer'] })
        .at(-1)!;
      await tick(() => client.setQueryData(query.queryKey, value));
      loader = structuredClone(value);
      await show();
    },
    prepare: async (kind: Kind) => {
      if (kind !== 'start')
        await click(
          view.getByRole('button', {
            name: kind === 'complete' ? m.library_progress_complete() : m.library_progress_abandon(),
            exact: true,
          }),
        );
      return callback(kind);
    },
    close: async () => {
      await tick(() => root.unmount());
      host.remove();
      stop();
      client.clear();
      redirect.mockRestore();
    },
  };
}

test('Progress index later-page recovery preserves subject scope and unknown native unit facts remain available in optional details.', async () => {
  for (const locale of ['en', 'ja'])
    for (const subjectId of ['', id(1)])
      for (const cursor of [null, 'earlier/opaque+=='])
        for (const next of [null, 'next/opaque+==']) {
          const initial = envelope({ locale, subjectId, cursor, next });
          const h = await mount(initial);
          try {
            expect(h.host.textContent).toContain(
              cursor || next ? m.library_progress_page_empty() : m.library_progress_empty(),
            );
            if (cursor || next) expect(h.host.textContent).not.toContain(m.library_progress_empty());
            const first = h.view.queryByRole('link', { name: m.library_collections_first_page(), exact: true });
            const more = h.view.queryByRole('link', { name: m.library_progress_more(), exact: true });
            expect(!!first).toBe(!!cursor);
            expect(!!more).toBe(!!next);
            for (const link of [first, more].filter((link): link is HTMLElement => link !== null)) {
              const target = new URL(link.getAttribute('href')!, 'https://rezics.test');
              expect(target.pathname).toBe(`/${locale}/library/progress`);
              expect(target.searchParams.get('subjectId')).toBe(subjectId);
              expect(target.searchParams.get('cursor')).toBe(link === first ? null : next);
            }
            expect(reads).toHaveLength(0);
            expect(writes).toHaveLength(0);
            expect(choices).not.toHaveBeenCalled();
            if (first) {
              await h.click(first);
              expect(h.router.state.location.search).toEqual({ subjectId });
            }
          } finally {
            await h.close();
          }
        }
});

test('Unknown-unit disclosure keeps exact scalar, literal cursor and completed-count readings in returned session order', async () => {
  const sessions = [
    session('A', { id: id(23), revision: 9 }),
    session('A', { id: id(21), mode: 'cursor_position', unit: 'unmapped:chapter', amount: null, locator: 'Ch. 3, 9' }),
    session('A', { id: id(22), mode: 'completed_units', unit: 'unmapped:track', amount: null, completedUnitCount: 2 }),
  ];
  const original = structuredClone(sessions);
  const h = await mount(envelope({ sessions, next: 'next/opaque+==' }));
  try {
    const rows = [...h.host.querySelectorAll('ol > li')];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.querySelector('a')?.getAttribute('href'))).toEqual(
      sessions.map((row) => `/en/library/progress/${row.id}`),
    );
    expect(rows.map((row) => row.querySelector('[data-slot="progress-row"]')?.textContent)).toEqual([
      expect.stringContaining('0.123456'),
      expect.stringContaining('Ch. 3, 9'),
      expect.stringContaining('2'),
    ]);
    for (const [index, row] of rows.entries()) {
      const details = row.querySelector('details')!;
      expect(details.hasAttribute('open')).toBe(false);
      expect(row.querySelector('summary')?.textContent).toBe(m.library_progress_details());
      expect(details.querySelector('dt')?.textContent).toBe(
        `${m.library_progress_mode()} / ${m.library_progress_unit()}`,
      );
      expect(details.querySelector('code')?.textContent).toBe(`${sessions[index]!.mode} / ${sessions[index]!.unit}`);
      expect(details.textContent).toContain(m.library_history_unavailable());
      expect(row.textContent).toContain(m.library_progress_unit_unspecified());
      expect(row.querySelector('code')?.closest('details')).toBe(details);
      expect(row.textContent).toContain(m.library_progress_state_active());
    }
    expect(h.view.queryByRole('progressbar')).toBeNull();
    expect(h.host.textContent).not.toMatch(/1\s*[-–]\s*2|\d%/);
    await h.click(rows[0]!.querySelector('summary')!);
    expect(rows[0]!.querySelector('details')!.open).toBe(true);
    expect(h.router.state.location.pathname).toBe('/library/progress');
    expect(reads).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(sessions).toEqual(original);
  } finally {
    await h.close();
  }

  const first = await mount(envelope({ cursor: null }), true);
  try {
    expect(first.host.textContent).toContain(m.library_progress_empty());
    expect(first.view.queryByRole('link', { name: m.library_collections_first_page() })).toBeNull();
  } finally {
    await first.close();
  }
});

test('First and next page controls reject retired locale, admission and returned-page provenance before commit', async () => {
  for (const boundary of ['locale', 'admission', 'provenance']) {
    const initial = envelope({ next: 'next/opaque+==' });
    const h = await mount(initial);
    try {
      const navigation = [m.library_collections_first_page(), m.library_progress_more()].map((name) =>
        h.view.getByRole('link', { name, exact: true }),
      );
      await tick(() => {
        if (boundary === 'locale') setLocale('de', { reload: false });
        else if (boundary === 'admission') h.admit([]);
        else {
          const query = h.client
            .getQueryCache()
            .findAll({ queryKey: ['library', 'progress', 'current-viewer'] })
            .at(-1)!;
          h.client.setQueryData(query.queryKey, { ...initial, requested: { ...initial.requested, subjectId: id(9) } });
        }
        for (const link of navigation) {
          const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          link.dispatchEvent(click as unknown as MouseEvent);
          expect(click.defaultPrevented).toBe(true);
        }
        expect(reads).toHaveLength(0);
      });
      expect(h.router.state.location.search).toEqual(initial.requested);
      expect(writes).toHaveLength(0);
    } finally {
      await h.close();
    }
  }
});

test('Current private authority and original uncertain mutation intent remain exact across refresh, retirement and late completion.', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const) {
    const initial = envelope({ sessions: [session()], next: 'next/opaque+==' });
    const h = await mount(initial);
    try {
      if (kind === 'start')
        await tick(() =>
          propsOf<{ onChange: (event: { target: { value: string } }) => void }>(
            h.host.querySelector('[name="total"]')!,
          ).onChange({ target: { value: '0.123456' } }),
        );
      const submit = await h.prepare(kind);
      await tick(() => {
        submit();
        submit();
      });
      expect(writes).toHaveLength(1);
      const first = writes[0]!;
      const original = structuredClone(first.data);
      expect(first.headers).toEqual({ 'x-csrf-token': 'A-credential' });
      expect(original).toEqual(
        kind === 'start'
          ? {
              subjectId: id(1),
              mode: 'scalar_amount',
              unit: 'page',
              total: '0.123456',
              idempotencyKey: initial.page.idempotencyKey,
            }
          : { sessionId: id(20), revision: 7, action: kind, idempotencyKey: expect.any(String) },
      );
      await tick(() => first.work.reject(new Error('Unknown commit result')));
      expect(h.host.querySelector('[role="alert"]')).not.toBeNull();
      await h.refresh({ ...initial, page: { ...initial.page, idempotencyKey: crypto.randomUUID() } });
      await tick(() => h.rotate('A', 'A-current'));
      await tick(h.callback(kind));
      expect(writes).toHaveLength(2);
      expect(writes[1]!.data).toBe(first.data);
      expect(writes[1]!.data).toEqual(original);
      expect(writes[1]!.headers).toBe(first.headers);
      const retired = h.callback(kind);
      const navigation = [m.library_collections_first_page(), m.library_progress_more()].map((name) =>
        h.view.getByRole('link', { name, exact: true }),
      );
      await tick(() => {
        h.rotate('B');
        for (const link of navigation) {
          const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
          link.dispatchEvent(click as unknown as MouseEvent);
          expect(click.defaultPrevented).toBe(true);
        }
        retired();
      });
      expect(writes).toHaveLength(2);
      expect(h.host.textContent).not.toContain('Private A');
      expect(reads).toHaveLength(1);
      expect(reads[0]!.data).toEqual({ subjectId: id(1), cursor: initial.requested.cursor });
      const current = envelope({ owner: 'B', sessions: [session('B')], next: 'next-B' });
      await tick(() => reads[0]!.work.resolve(current));
      await tick(() =>
        writes[1]!.work.resolve(
          kind === 'start'
            ? { ok: true, id: id(90) }
            : {
                ok: true,
                session: { ...session(), revision: 8, state: kind === 'complete' ? 'completed' : 'abandoned' },
              },
        ),
      );
      await tick(retired);
      expect(h.host.textContent).toContain('Private B');
      expect(h.host.textContent).not.toContain('Private A');
      expect(h.host.textContent).toContain(m.library_progress_state_active());
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      expect(h.redirects).toEqual([]);
      expect(writes).toHaveLength(2);
    } finally {
      await h.close();
    }
  }
});
