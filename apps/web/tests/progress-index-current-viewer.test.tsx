import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import { createKernelClient } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { isPlatformClosedError } from '../src/kernel/platform-closed';
import type { CurrentViewerProgressIndex } from '../src/library/progress-server';
import type { SessionEnv } from '../src/session/client';
import type { ProgressPickerSubject } from '../src/library/progress-picker';

// UNRUN: focused mounted/deferred regressions for controller execution. No native/browser proof.
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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
type Viewer = 'A' | 'B';
let browser: {
  state: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  subject: string | null;
  csrfToken: string | null;
};
let server: Viewer = 'A';
let admitted = true;
let locale = 'en';
let refusal = false;
let missingSubject = false;
let credentials = 0;
let naming = 0;
let releases = 0;
let deferLists = false;
type ListFailure = 'forbidden' | 'closed' | 'not_found' | 'invalid_cursor' | 'stale_cursor' | 'unavailable';
type ListOutcome = 'ok' | ListFailure;
let listOutcome: ListOutcome = 'ok';
const listFailures: Record<ListFailure, { status: number; code: string }> = {
  forbidden: { status: 403, code: 'forbidden' },
  closed: { status: 403, code: 'platform_closed' },
  not_found: { status: 404, code: 'not_found' },
  invalid_cursor: { status: 400, code: 'invalid_cursor' },
  stale_cursor: { status: 409, code: 'stale_cursor' },
  unavailable: { status: 500, code: 'internal_error' },
};
let listedRevision = 7;
let listedState = 'active';
let nextRelease: ReturnType<typeof deferred<typeof bundledRelease>> | undefined;
let envelopeOverride: ((value: CurrentViewerProgressIndex) => CurrentViewerProgressIndex) | undefined;
let retainedRequest: Request | undefined;
let actualRequest: Request;
const native = (viewer: Viewer, subjectId = id(1), revision = 7) => ({
  id: id(20),
  subjectId,
  versionSubjectId: null,
  mode: 'scalar_amount',
  unit: 'page',
  unitLabel: 'pages',
  total: '100',
  amount: viewer === 'A' ? '11' : '22',
  locator: null,
  position: null,
  completedUnitCount: 0,
  state: 'active',
  revision,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  subject: { id: subjectId, type: 'schema:Book', label: `${viewer} private ${subjectId}`, cover: null },
  versionSubject: null,
});
const calls: {
  request: Request;
  viewer: Viewer;
  body: Record<string, unknown> | null;
  work: ReturnType<typeof deferred<Response>>;
}[] = [];
const kernel = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const request = new Request(input, init);
    const viewer = request.headers.get('authorization') === 'Bearer credential-B' ? 'B' : 'A';
    const work = deferred<Response>();
    const call = {
      request,
      viewer,
      body: request.method === 'POST' ? ((await request.clone().json()) as Record<string, unknown>) : null,
      work,
    };
    calls.push(call);
    if (request.method === 'GET' && !deferLists) {
      const url = new URL(request.url);
      const failure = listOutcome === 'stale_cursor' && !url.searchParams.has('cursor') ? undefined : listOutcome;
      if (failure && failure !== 'ok') {
        const { status, code } = listFailures[failure];
        work.resolve(Response.json({ code }, { status }));
      } else {
        const subjectId = url.searchParams.get('subjectId')!;
        work.resolve(
          Response.json({
            progressSessions: [{ ...native(viewer, subjectId, listedRevision), state: listedState }],
            next: `next-${viewer}`,
          }),
        );
      }
    }
    return work.promise;
  },
});
const dispatched: { csrf: string | null; data: unknown }[] = [];
const env = {
  SITE_ORIGINS: 'https://rezics.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'kernel',
  WEBSITE_SCOPES: 'library',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'key',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      credential: async () => {
        credentials++;
        if (refusal) return { status: 'absent' };
        const viewer = name.startsWith('b') ? 'B' : 'A';
        return {
          status: 'active',
          accessToken: `credential-${viewer}`,
          subject: missingSubject ? undefined : viewer,
          csrfToken: browser.csrfToken,
        };
      },
    }),
  },
} as unknown as SessionEnv;
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', async () => ({
  ...(await import('../.storybook/react-start')),
  createServerFn: ({ method }: { method: string }) => {
    let validate = (value: unknown): unknown => value;
    const chain = {
      validator(fn: typeof validate) {
        validate = fn;
        return chain;
      },
      handler(fn: (input: { data: unknown }) => Promise<unknown>) {
        return async (input: { data?: unknown; headers?: HeadersInit } = {}) => {
          const headers = new Headers(input.headers);
          headers.set('cookie', `__Host-rezics_session=${(server === 'A' ? 'a' : 'b').repeat(43)}`);
          if (method === 'POST') headers.set('origin', 'https://rezics.test');
          actualRequest =
            retainedRequest ?? new Request(`https://rezics.test/${locale}/library/progress`, { method, headers });
          if (method === 'POST') dispatched.push({ csrf: headers.get('x-csrf-token'), data: input.data });
          const value = await fn({ data: validate(input.data) });
          return envelopeOverride && value && typeof value === 'object' && 'viewer' in value
            ? envelopeOverride(value as CurrentViewerProgressIndex)
            : value;
        };
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({ getRequest: () => actualRequest, setResponseHeader: () => {} }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => kernel, requestLocale: () => locale }));
mock.module('../src/subject/definitions', () => ({
  readRelease: async () => {
    releases++;
    const pending = nextRelease;
    nextRelease = undefined;
    return pending ? pending.promise : bundledRelease;
  },
  nameSubjectTypes: async (subjects: ({ typeLabel?: string } | null)[]) => {
    naming++;
    for (const subject of subjects) if (subject) subject.typeLabel = 'Named Book';
  },
}));
mock.module('../src/session/query', () => ({ sessionQuery: { queryKey: ['session'] }, useSession: () => browser }));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': browser.csrfToken }) }));
mock.module('../src/kernel/exposure', () => ({
  operationIsAdmitted: () => admitted,
  useOperation: () => admitted,
  Exposure: ({ children }: { children: ReactNode }) => (admitted ? children : null),
}));
const pickers: { label?: string; change: (value: ProgressPickerSubject[]) => unknown }[] = [];
mock.module('../src/library/progress-picker', () => ({
  pickerSubject: (subject: { id: string; type: string; label: string; typeLabel?: string }) => ({
    id: subject.id,
    type: subject.type,
    types: [subject.type],
    title: subject.label,
    typeLabel: subject.typeLabel,
  }),
  ProgressPicker: ({
    label,
    value,
    onValueChange,
  }: {
    label?: string;
    value: ProgressPickerSubject[];
    onValueChange: (value: ProgressPickerSubject[]) => unknown;
  }) => {
    pickers.push({ label, change: onValueChange });
    return <div data-picker={label ?? 'subject'}>{value.map((subject) => subject.title).join(', ')}</div>;
  },
}));
const selections: { label: string; onSelect: () => void }[] = [];
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { type: string; label: string; onSelect?: () => void }[] }) => (
    <div>
      {entries
        .filter((entry) => entry.onSelect)
        .map((entry) => {
          selections.push({ label: entry.label, onSelect: entry.onSelect! });
          return (
            <button key={entry.label} onClick={entry.onSelect}>
              {entry.label}
            </button>
          );
        })}
    </div>
  ),
}));
const buttons: { children: ReactNode; onClick?: () => void }[] = [];
mock.module('@rezics/ui/shadcn/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit';
  }) => {
    buttons.push({ children, onClick });
    return (
      <button type={type ?? 'button'} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  },
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { userEvent } = await import('storybook/test');
const { progressFormChoices } = await import('../src/library/progress-profile');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
  await import('@tanstack/react-router');
const { CurrentViewerProgressIndexPage } = await import('../src/library/progress-page');
const { readProgressIndex, readCurrentViewerProgressIndex } = await import('../src/library/progress-server');
const { prepareSession } = await import('../src/session/request');
const { sessionQuery } = await import('../src/session/query');
const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { viewerExposureLifetime } = await import('../src/session/observation');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
const tick = async (fn: () => unknown = () => {}) =>
  act(async () => {
    await fn();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
const setViewer = (viewer: Viewer = 'A', csrfToken = 'a'.repeat(22)) => {
  server = viewer;
  browser = { state: 'signed-in', subject: viewer, csrfToken };
};
function reset() {
  setViewer();
  admitted = true;
  locale = 'en';
  refusal = missingSubject = deferLists = false;
  listOutcome = 'ok';
  credentials = naming = releases = 0;
  envelopeOverride = undefined;
  retainedRequest = undefined;
  listedRevision = 7;
  listedState = 'active';
  nextRelease = undefined;
  calls.length = pickers.length = selections.length = buttons.length = dispatched.length = 0;
}
async function mount(hydrate = false, initialLoader?: CurrentViewerProgressIndex) {
  reset();
  let loader = initialLoader ?? (await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } }));
  let requested: { subjectId?: string; cursor?: string } = { subjectId: id(1) };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(sessionQuery.queryKey, browser);
  const lifetime = viewerExposureLifetime(client);
  const stopObservation = lifetime.subscribeCache(() => {});
  const seedExposure = () => {
    const current = lifetime.getSnapshot();
    if (current.state !== 'signed-in') return;
    const query = viewerExposureQuery(current.observation);
    if (!client.getQueryState(query.queryKey))
      client.setQueryData(query.queryKey, { subject: current.observation.subject, admitted: [] });
  };
  seedExposure();
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/library/progress'] }),
  });
  await router.load();
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <CurrentViewerProgressIndexPage loader={loader} requested={requested} />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const navigation: string[] = [];
  const redirect = spyOn(window.location, 'assign').mockImplementation((href) => {
    navigation.push(String(href));
  });
  let root: ReturnType<typeof createRoot>;
  const hydrationErrors: unknown[] = [];
  const serverHtml = hydrate ? renderToString(tree()) : '';
  if (hydrate) {
    host.innerHTML = serverHtml;
    await tick(() => {
      root = hydrateRoot(host as unknown as HTMLElement, tree(), {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
    });
  } else {
    root = createRoot(host as unknown as HTMLElement);
    await tick(() => root.render(tree()));
  }
  const show = () =>
    tick(() => {
      if (client.getQueryData(sessionQuery.queryKey) !== browser) client.setQueryData(sessionQuery.queryKey, browser);
      seedExposure();
      root.render(tree());
    });
  const submit = () =>
    tick(() => {
      const form = host.querySelector('form')!;
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const select = (label: string) => selections.findLast((entry) => entry.label === label)!.onSelect;
  const button = (label: string) => buttons.findLast((entry) => entry.children === label)!.onClick!;
  const finish = async (action: 'complete' | 'abandon' = 'complete') => {
    await tick(select(action === 'complete' ? m.library_progress_complete() : m.library_progress_abandon()));
    const callback = button(
      action === 'complete' ? m.library_progress_confirm_complete() : m.library_progress_confirm_abandon(),
    );
    await tick(() => {
      callback();
      callback();
    });
    return callback;
  };
  return {
    host,
    client,
    show,
    submit,
    finish,
    select,
    button,
    navigation,
    serverHtml,
    hydrationErrors,
    address: async (value: typeof requested) => {
      requested = value;
      await show();
    },
    loader: async (value: CurrentViewerProgressIndex) => {
      loader = value;
      await show();
    },
    replace: async (value: CurrentViewerProgressIndex, address: typeof requested) => {
      loader = value;
      requested = address;
      await show();
    },
    refresh: () =>
      tick(() => {
        void client.invalidateQueries({ queryKey: ['library', 'progress', 'current-viewer'] });
      }),
    close: async () => {
      await tick(() => root.unmount());
      stopObservation();
      host.remove();
      redirect.mockRestore();
      client.clear();
    },
  };
}
function listCall(viewer: Viewer) {
  return calls.findLast((call) => call.viewer === viewer && call.request.method === 'GET')!;
}
const writes = () => calls.filter((call) => call.request.method === 'POST');
async function resolveList(call: (typeof calls)[number], subjectId = id(1), revision = 7, state = 'active') {
  await tick(() =>
    call.work.resolve(
      Response.json({
        progressSessions: [{ ...native(call.viewer, subjectId, revision), state }],
        next: `next-${call.viewer}`,
      }),
    ),
  );
}
async function resolveListFailure(call: (typeof calls)[number], failure: ListFailure = 'forbidden') {
  const { status, code } = listFailures[failure];
  await tick(() => call.work.resolve(Response.json({ code }, { status })));
}
async function resolveWrite(
  call: (typeof calls)[number],
  state = new URL(call.request.url).pathname.endsWith(':abandon') ? 'abandoned' : 'completed',
) {
  await tick(() =>
    call.work.resolve(Response.json({ progressSession: { ...native(call.viewer), revision: 8, state } })),
  );
}

test('actual preparation provenance is one reader, and refusal/absent identity cannot assert private authority', async () => {
  reset();
  const page = await readCurrentViewerProgressIndex({ data: { subjectId: id(1), cursor: 'opaque/==' } });
  expect(page.viewer).toBe('A');
  expect(page.requested).toEqual({ subjectId: id(1), cursor: 'opaque/==' });
  expect(page.locale).toBe('en');
  expect(page.page.selectedSubject?.typeLabel).toBe('Named Book');
  expect(page.page.progressChoices?.[0]?.units[0]?.id).toBe('page');
  expect([credentials, naming, releases, calls.length]).toEqual([1, 1, 1, 1]);
  expect(new URL(calls[0]!.request.url).searchParams.get('cursor')).toBe('opaque/==');
  retainedRequest = actualRequest;
  // A prior successful preparation must not become a fallback after this reader refuses it.
  refusal = true;
  const refused = await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } });
  expect(refused).toMatchObject({
    viewer: null,
    requested: { subjectId: id(1), cursor: null },
    page: { signedIn: false, sessions: [], selectedSubject: null, next: null },
  });
  expect(refused.page.progressChoices).toBeUndefined();
  expect(calls).toHaveLength(1);
  refusal = false;
  missingSubject = true;
  retainedRequest = undefined;
  const unknown = await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } });
  expect(unknown.viewer).toBeNull();
  expect(unknown.page.sessions).toEqual([]);
  expect(unknown.page.selectedSubject).toBeNull();
  expect(unknown.page.progressChoices).toBeUndefined();
  missingSubject = false;
  locale = 'de';
  const localized = await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } });
  expect(localized.locale).toBe('de');
  expect(localized.page.progressChoices).toEqual(progressFormChoices(bundledRelease, 'schema:Book', 'de'));
  locale = 'en';
  // An unassociated explicit bearer and a retained request with its cookie removed fail closed too.
  retainedRequest = new Request('https://rezics.test/en/library/progress', {
    headers: { authorization: 'Bearer credential-A' },
  });
  expect((await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } })).viewer).toBeNull();
  retainedRequest = new Request('https://rezics.test/en/library/progress', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  await prepareSession(retainedRequest, env);
  retainedRequest.headers.delete('cookie');
  const absent = await readCurrentViewerProgressIndex({ data: {} });
  expect(absent).toMatchObject({
    viewer: null,
    requested: { subjectId: '', cursor: null },
    page: { signedIn: false, sessions: [], selectedSubject: null, next: null },
  });
});

test('an ordinary denied progress list renders permission on the initial page and current-viewer refresh', async () => {
  reset();
  listOutcome = 'forbidden';
  const direct = await readProgressIndex({ data: { subjectId: id(1) } });
  const initial = await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } });
  expect(direct).toMatchObject({ signedIn: true, viewerState: 'forbidden', selectedSubject: null, sessions: [], next: null });
  expect(initial).toMatchObject({ viewer: 'A', page: { signedIn: true, viewerState: 'forbidden', selectedSubject: null, sessions: [], next: null } });
  expect([initial.page.emptyKind, initial.page.progressChoices, naming, releases]).toEqual([undefined, undefined, 0, 0]);
  const h = await mount(true, initial);
  try {
    expect(h.serverHtml).toContain(m.library_progress_discovery_forbidden());
    expect(h.host.textContent).toContain(m.library_progress_discovery_forbidden());
    expect(h.hydrationErrors).toEqual([]);
    expect(h.host.querySelector('form, button, a, [data-picker]')).toBeNull();
    deferLists = true;
    await h.refresh();
    await resolveListFailure(listCall('A'));
    expect(h.host.textContent).toContain(m.library_progress_discovery_forbidden());
    expect(h.host.textContent).not.toContain(m.library_progress_discovery_empty_owner());
    expect(h.host.querySelector('form, button, a, [data-picker]')).toBeNull();
    expect(writes()).toHaveLength(0);
    deferLists = false;
    listOutcome = 'unavailable';
    await h.refresh();
    await tick();
    expect(h.host.textContent).toContain(m.library_progress_unavailable());
    expect(h.host.textContent).not.toContain(m.library_progress_discovery_forbidden());
  } finally {
    await h.close();
  }
});

test('closed, concealed, invalid/stale cursor and unavailable list outcomes retain their reader meaning', async () => {
  reset();
  listOutcome = 'closed';
  let closed: unknown;
  try {
    await readProgressIndex({ data: { subjectId: id(1) } });
  } catch (error) {
    closed = error;
  }
  expect(isPlatformClosedError(closed)).toBe(true);
  listOutcome = 'not_found';
  expect((await readProgressIndex({ data: { subjectId: id(1) } })).addressIssue).toBe('subjectId');
  listOutcome = 'invalid_cursor';
  expect((await readProgressIndex({ data: { subjectId: id(1), cursor: 'opaque/==' } })).addressIssue).toBe('cursor');
  listOutcome = 'stale_cursor';
  const staleFrom = calls.length;
  expect((await readProgressIndex({ data: { subjectId: id(1), cursor: 'opaque/==' } })).sessions).toHaveLength(1);
  expect(calls.slice(staleFrom).map(({ request }) => new URL(request.url).searchParams.get('cursor'))).toEqual([
    'opaque/==',
    null,
  ]);
  listOutcome = 'unavailable';
  await expect(readProgressIndex({ data: { subjectId: id(1) } })).rejects.toThrow('Kernel library read failed');
});

test('loader SSR hydrates without another list; observed B/unknown/sign-out/admission immediately retire all private UI', async () => {
  const h = await mount(true);
  try {
    expect(h.serverHtml).toContain('A private');
    expect(h.hydrationErrors).toEqual([]);
    expect(calls).toHaveLength(1);
    const oldChoice = pickers.findLast((picker) => !picker.label)!.change;
    const oldMenu = h.select(m.library_progress_complete());
    await tick(() => oldMenu());
    setViewer('B');
    deferLists = true;
    await h.show();
    expect(h.host.textContent).not.toContain('A private');
    expect(h.host.querySelector('form')).toBeNull();
    expect(h.host.querySelector('a')).toBeNull();
    await tick(() => {
      oldMenu();
      void oldChoice([{ id: id(9), type: 'schema:Book', types: ['schema:Book'], title: 'old selection' }]);
    });
    expect(releases).toBe(1);
    expect(writes()).toHaveLength(0);
    await resolveList(listCall('B'));
    expect(h.host.textContent).toContain('B private');
    expect(h.host.textContent).not.toContain('old selection');
    expect(h.host.querySelector('[name="total"]')?.getAttribute('value')).toBe('');
    for (const state of ['unknown', 'signed-out', 'unavailable'] as const) {
      browser = { state, subject: null, csrfToken: null };
      await h.show();
      expect(h.host.textContent).not.toContain('private');
      expect(h.host.querySelector('form, a, [data-picker]')).toBeNull();
    }
    setViewer('B');
    await h.show();
    await resolveList(listCall('B'));
    admitted = false;
    await h.show();
    expect(h.host.textContent).not.toContain('private');
    expect(h.host.querySelector('form, a, [data-picker]')).toBeNull();
  } finally {
    await h.close();
  }
});

test('B is usable while A read/start/finish is pending; late success/error/finally and retained callbacks cannot act on B', async () => {
  for (const action of ['start', 'complete', 'abandon'] as const) {
    const h = await mount();
    try {
      const stale = action === 'start' ? undefined : await h.finish(action);
      if (action === 'start') await h.submit();
      const old = writes()[0]!;
      expect(writes()).toHaveLength(1);
      deferLists = true;
      await h.refresh();
      const oldRead = listCall('A');
      setViewer('B');
      await h.show();
      const bRead = listCall('B');
      expect(bRead).not.toBe(oldRead);
      await resolveList(bRead);
      const bFinish = action === 'start' ? undefined : await h.finish(action);
      if (action === 'start') await h.submit();
      const current = writes()[1]!;
      expect(current.viewer).toBe('B');
      expect(current.body).toEqual(
        action === 'start' ? { subjectId: id(1), mode: 'scalar_amount', unit: 'page' } : { revision: 7 },
      );
      expect(current.request.headers.get('idempotency-key')).toBe(
        JSON.stringify(dispatched[1]!.data && (dispatched[1]!.data as { idempotencyKey: string }).idempotencyKey),
      );
      await resolveList(oldRead);
      if (action === 'start') await resolveWrite(old);
      else if (action === 'complete')
        await tick(() => old.work.resolve(Response.json({ code: 'forbidden' }, { status: 403 })));
      else await tick(() => old.work.reject(new Error('late A failure')));
      await tick(() => stale?.());
      expect(writes()).toHaveLength(2);
      expect(h.host.textContent).toContain('B private');
      expect(h.host.textContent).not.toContain('A private');
      expect(h.host.textContent).toContain(m.library_progress_state_active());
      expect(h.navigation).toEqual([]);
      expect(h.host.querySelector('[role="alert"]')).toBeNull();
      // A's finally cannot release B's synchronous duplicate guard.
      if (action === 'start') await h.submit();
      else await tick(() => bFinish!());
      expect(writes()).toHaveLength(2);
      await resolveWrite(current);
      if (action === 'start') expect(h.navigation[0]).toContain(`/library/progress/${id(20)}`);
      else
        expect(h.host.textContent).toContain(
          action === 'abandon' ? m.library_progress_state_abandoned() : m.library_progress_state_completed(),
        );
    } finally {
      await h.close();
    }
  }
});

test('wrong server viewer/subject/cursor/locale and late old-address results never disclose or restore a private page', async () => {
  const h = await mount();
  try {
    deferLists = true;
    await h.address({ subjectId: id(2), cursor: 'address-two' });
    const old = listCall('A');
    expect(h.host.textContent).not.toContain('private');
    await h.address({ subjectId: id(3), cursor: 'address-three' });
    const current = listCall('A');
    await resolveList(current, id(3));
    await resolveListFailure(old);
    expect(h.host.textContent).toContain(`A private ${id(3)}`);
    expect(h.host.textContent).not.toContain(`A private ${id(2)}`);
    expect(h.host.textContent).not.toContain(m.library_progress_discovery_forbidden());
    for (const wrong of [
      (value: CurrentViewerProgressIndex) => ({ ...value, viewer: 'B' }),
      (value: CurrentViewerProgressIndex) => ({ ...value, requested: { ...value.requested, subjectId: id(9) } }),
      (value: CurrentViewerProgressIndex) => ({ ...value, requested: { ...value.requested, cursor: 'wrong' } }),
      (value: CurrentViewerProgressIndex) => ({ ...value, locale: 'de' }),
    ]) {
      envelopeOverride = wrong;
      await h.refresh();
      await resolveList(listCall('A'), id(3));
      expect(h.host.textContent).not.toContain('private');
      expect(h.host.querySelector('form, a')).toBeNull();
      envelopeOverride = undefined;
      await h.refresh();
      await resolveList(listCall('A'), id(3));
      expect(h.host.querySelector('form')).not.toBeNull();
    }
  } finally {
    await h.close();
  }
});

test('same-viewer CSRF rotation and ordinary query/loader refresh preserve uncertain exact creation and row payload/key', async () => {
  for (const action of ['start', 'complete'] as const) {
    const h = await mount();
    try {
      if (action === 'start') {
        const version = pickers.findLast((picker) => !!picker.label)!.change;
        await tick(() => version([{ id: id(5), type: 'schema:Book', types: ['schema:Book'], title: 'Exact version' }]));
        const total = h.host.querySelector<HTMLInputElement>('[name="total"]')!;
        const user = userEvent.setup({ document: window.document as unknown as Document });
        await tick(() => user.type(total as unknown as HTMLInputElement, '90'));
        await h.submit();
      } else await h.finish();
      const original = writes()[0]!;
      const payload = original.body;
      const key = original.request.headers.get('idempotency-key');
      if (action === 'start')
        expect(payload).toEqual({
          subjectId: id(1),
          versionSubjectId: id(5),
          mode: 'scalar_amount',
          unit: 'page',
          total: '90',
        });
      setViewer('A', 'b'.repeat(22));
      await h.show();
      if (action === 'complete') {
        listedRevision = 8;
        listedState = 'completed';
      }
      deferLists = true;
      await h.refresh();
      await resolveList(listCall('A'), id(1), listedRevision, listedState);
      deferLists = false;
      await h.loader(await readCurrentViewerProgressIndex({ data: { subjectId: id(1) } }));
      deferLists = true;
      expect(writes()).toHaveLength(1);
      await tick(() => original.work.reject(new Error('reply lost after commit')));
      setViewer('A', 'c'.repeat(22));
      await h.show();
      if (action === 'start') {
        // Fresh editable values cannot overwrite the captured uncertain intent.
        await tick(() => pickers.findLast((picker) => !!picker.label)!.change([]));
        await h.submit();
      } else await h.finish();
      const retry = writes()[1]!;
      expect(retry.body).toEqual(payload);
      expect(dispatched.map((call) => call.csrf)).toEqual(['a'.repeat(22), 'c'.repeat(22)]);
      expect(dispatched[1]!.data).toEqual(dispatched[0]!.data);
      expect(retry.request.headers.get('idempotency-key')).toBe(key);
      expect(retry.request.headers.get('authorization')).toBe('Bearer credential-A');
      await resolveWrite(retry);
      if (action === 'start') expect(h.navigation).toHaveLength(1);
      else expect(h.host.textContent).toContain(m.library_progress_state_completed());
    } finally {
      await h.close();
    }
  }
});

test('a late originating choice lookup cannot replace or finish B choices', async () => {
  const h = await mount();
  try {
    const aChoices = deferred<typeof bundledRelease>();
    nextRelease = aChoices;
    await tick(() => {
      void pickers
        .findLast((picker) => !picker.label)!
        .change([{ id: id(9), type: 'schema:Book', types: ['schema:Book'], title: 'A selected privately' }]);
    });
    expect(h.host.querySelector('form')).toBeNull();
    setViewer('B');
    await h.show();
    expect(h.host.textContent).toContain('B private');
    const bChoices = deferred<typeof bundledRelease>();
    nextRelease = bChoices;
    await tick(() => {
      void pickers
        .findLast((picker) => !picker.label)!
        .change([{ id: id(2), type: 'schema:VideoGame', types: ['schema:VideoGame'], title: 'B selected game' }]);
    });
    await tick(() => aChoices.resolve(bundledRelease));
    expect(h.host.querySelector('form')).toBeNull();
    expect(h.host.textContent).not.toContain('A selected privately');
    expect(h.host.querySelector('[role="alert"]')).toBeNull();
    await tick(() => bChoices.resolve(bundledRelease));
    await h.submit();
    const expected = progressFormChoices(bundledRelease, 'schema:VideoGame', 'en')![0]!;
    expect(writes()[0]!.body).toEqual({ subjectId: id(2), mode: expected.mode, unit: expected.units[0]!.id });
    await resolveWrite(writes()[0]!);
    expect(h.navigation).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test('a fresh matching route loader seeds a new address without a duplicate list or surviving old creation', async () => {
  const h = await mount();
  try {
    await h.submit();
    const old = writes()[0]!;
    const loader = await readCurrentViewerProgressIndex({ data: { subjectId: id(2), cursor: 'route-address' } });
    const reads = calls.filter((call) => call.request.method === 'GET').length;
    await h.replace(loader, { subjectId: id(2), cursor: 'route-address' });
    expect(calls.filter((call) => call.request.method === 'GET')).toHaveLength(reads);
    expect(h.host.textContent).toContain(`A private ${id(2)}`);
    expect(h.host.querySelector<HTMLInputElement>('[name="idempotencyKey"]')!.value).toBe(loader.page.idempotencyKey);
    await h.submit();
    expect(writes()[1]!.body).toEqual({ subjectId: id(2), mode: 'scalar_amount', unit: 'page' });
    await resolveWrite(old);
    expect(h.navigation).toEqual([]);
    await resolveWrite(writes()[1]!);
    expect(h.navigation).toHaveLength(1);
  } finally {
    await h.close();
  }
});
