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
type Viewer = { state: 'signed-in'; subject: string; csrfToken: string | null };
const viewer = (subject = 'A', csrfToken: string | null = `${subject}-credential`): Viewer => ({
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
const { progressIndexAdmission } = await import('../src/library/progress-index-origin');
const serverFunctions = await import('../src/library/progress-server');
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { CurrentViewerProgressIndexPage } = await import('../src/library/progress-page');
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
async function mount(initial = envelope(), token: string | null = null) {
  setLocale(initial.locale as Parameters<typeof setLocale>[0], { reload: false });
  writes.length = reads.length = 0;
  choices.mockClear();
  let loader = initial;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, viewer('A', token));
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
              <CurrentViewerProgressIndexPage
                loader={loader}
                requested={{
                  ...(initial.requested.subjectId ? { subjectId: initial.requested.subjectId } : {}),
                  ...(initial.requested.cursor ? { cursor: initial.requested.cursor } : {}),
                }}
              />
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
    indexQuery: () =>
      client
        .getQueryCache()
        .findAll({ queryKey: ['library', 'progress', 'current-viewer'] })
        .at(-1)!,
    rotate: (owner: string, token?: string | null) => {
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

test('Null-CSRF readers load, retry and navigate captured sessions while new commands stay disabled', async () => {
  const initial = envelope({ sessions: [session('A', { amount: '0' })], next: 'next/opaque+==' });
  const h = await mount(initial);
  try {
    expect(progressIndexAdmission(h.client, 'progress_session.list', false)).toBe(true);
    for (const operation of ['create', 'complete', 'abandon'] as const)
      expect(progressIndexAdmission(h.client, `progress_session.${operation}`, true)).toBe(false);
    expect(h.host.textContent).toContain('Private A');
    expect(h.host.querySelector('details code')?.textContent).toBe('scalar_amount / original:page~unknown');
    expect(h.host.querySelector('[data-slot="progress-row"]')?.textContent).toContain('0');
    expect(h.host.querySelector('ol a')?.getAttribute('href')).toBe(`/en/library/progress/${id(20)}`);
    for (const kind of ['start', 'complete', 'abandon'] as const) {
      const submit = await h.prepare(kind);
      const label =
        kind === 'start'
          ? m.library_progress_start()
          : kind === 'complete'
            ? m.library_progress_confirm_complete()
            : m.library_progress_confirm_abandon();
      expect(h.view.getByRole('button', { name: label, exact: true }).hasAttribute('disabled')).toBe(true);
      await tick(submit);
    }
    expect(writes).toHaveLength(0);
    await tick(() => {
      void h.client.invalidateQueries({ queryKey: h.indexQuery().queryKey });
    });
    expect(reads[0]!.data).toEqual({ subjectId: id(1), cursor: initial.requested.cursor });
    await tick(() => reads[0]!.work.reject(new Error('Temporary list failure')));
    await h.click(h.view.getByRole('button', { name: m.library_progress_retry(), exact: true }));
    expect(reads).toHaveLength(2);
    await tick(() => reads[1]!.work.resolve(initial));
    expect(h.host.textContent).toContain('Private A');
    await h.click(h.view.getByRole('link', { name: m.library_progress_more(), exact: true }));
    expect(h.router.state.location.search).toEqual({ subjectId: id(1), cursor: initial.page.next });
    expect(writes).toHaveLength(0);
  } finally {
    await h.close();
  }
});

test('Token loss keeps uncertain start, complete and abandon custody; arrival requires explicit original-sender retry', async () => {
  for (const kind of ['start', 'complete', 'abandon'] as const) {
    const initial = envelope({ sessions: [session()] });
    const h = await mount(initial, 'A-original');
    const sender = kind === 'start' ? 'startProgressSession' : 'finishProgressSession';
    let replacement: ReturnType<typeof spyOn> | undefined;
    try {
      const submit = await h.prepare(kind);
      await tick(submit);
      const first = writes[0]!;
      const operands = structuredClone(first.data);
      await tick(() => h.rotate('A', null));
      expect(h.host.textContent).toContain('Private A');
      await tick(() => first.work.reject(new Error('Unknown commit result')));
      await tick(h.callback(kind));
      expect(writes).toHaveLength(1);
      await tick(() => h.rotate('A', 'A-renewed'));
      expect(writes).toHaveLength(1);
      replacement = spyOn(serverFunctions, sender).mockRejectedValue(new Error('Wrong sender'));
      await tick(h.callback(kind));
      expect(replacement).not.toHaveBeenCalled();
      expect(writes).toHaveLength(2);
      expect(writes[1]!.data).toBe(first.data);
      expect(writes[1]!.data).toEqual(operands);
      expect(writes[1]!.headers).toBe(first.headers);
      expect(writes[1]!.headers).toEqual({ 'x-csrf-token': 'A-original' });
      await tick(() => writes[1]!.work.resolve({ ok: false, reason: 'unavailable' }));
    } finally {
      replacement?.mockRestore();
      await h.close();
    }
  }
});

test('Null-CSRF readers reject stale responses and callbacks across session, subject and exposure ABA renewal', async () => {
  for (const boundary of ['signed-out', 'subject', 'unavailable', 'session-error', 'exposure'] as const) {
    const initial = envelope({ sessions: [session()], next: 'next/opaque+==' });
    const h = await mount(initial);
    try {
      const oldQuery = h.indexQuery();
      const submit = h.callback('start');
      const more = h.view.getByRole('link', { name: m.library_progress_more(), exact: true });
      await tick(() => {
        void h.client.invalidateQueries({ queryKey: oldQuery.queryKey });
      });
      const old = reads[0]!;
      await tick(() => {
        if (boundary === 'exposure') h.admit([]);
        else if (boundary === 'subject') h.rotate('B', null);
        else if (boundary === 'session-error')
          h.client
            .getQueryCache()
            .find({ queryKey: sessionQuery.queryKey })!
            .setState({ status: 'error', error: new Error('Session unavailable') });
        else h.client.setQueryData(sessionQuery.queryKey, { state: boundary, subject: null, csrfToken: null });
        // Restoration in the same batch must not revive the old read or callbacks.
        if (boundary === 'exposure') h.admit();
        else h.rotate('A', null);
        const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        more.dispatchEvent(click as unknown as MouseEvent);
        expect(click.defaultPrevented).toBe(true);
        submit();
      });
      const stale = envelope({ sessions: [session('STALE')] });
      await tick(() => old.work.resolve(stale));
      expect(oldQuery.state.data).not.toBe(stale);
      expect(h.host.textContent).not.toContain('Private STALE');
      expect(writes).toHaveLength(0);
    } finally {
      await h.close();
    }
  }
});
