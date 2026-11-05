import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { PersonalLibraryCurrentRead, PersonalContinueRead } from '../src/library/personal-library-server';
import type { LibraryMutationResult, PersonalLibraryEntry } from '../src/library/entries-read';
import { nativeCollection } from './factories/collections';
import type { ShelfDisplay, ShelfSearch } from '../src/library/shelf-params';

// UNRUN: controller integration owns execution and native/visual proof. This fixture covers the server export
// and mounted composition with real shelf children against the generated kernel client.
type Preparation = { subject?: string; accessToken?: string; status: 'active' | 'absent' | 'unavailable' };
let preparations: Preparation[] = [];
let preparationCalls = 0;
const credential = async () => {
  preparationCalls++;
  return { csrfToken: 'csrf', accessToken: 'credential-A', subject: 'A', status: 'active', ...preparations.shift() };
};
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: { idFromName: (id: string) => id, get: () => ({ credential, credentialIfFresh: credential }) },
};
const headers = new Headers();
const request = () =>
  new Request('https://site.test/en/library', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
let serverReads = true;
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn: () => {
    let server: (...args: never[]) => unknown = () => undefined;
    let client: (...args: never[]) => unknown = () => undefined;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client(handler: typeof client) {
        client = handler;
        return (...args: never[]) => (serverReads ? server : client)(...args);
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => headers.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
const originalKernel = await import('../src/kernel/client');
const nativeClient = createKernelClient('https://kernel.test', {
  headers: { 'accept-language': 'en' },
  fetch: (input, init) => globalThis.fetch(input, init),
});
mock.module('../src/kernel/client', () => ({
  ...originalKernel,
  configuredKernelOrigin: () => env.KERNEL_ORIGIN,
  kernelClient: () => nativeClient,
  requestLocale: () => 'en',
}));
afterAll(() => mock.restore());
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
function entry(viewer: string, n: number): PersonalLibraryEntry {
  return {
    subjectId: id(n),
    state: 'planned',
    revision: 7,
    incarnationId: id(90),
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    stateLabel: 'Planned',
    stateOptions: [
      { id: 'planned', label: { text: 'Planned', lang: 'en' } },
      { id: 'completed', label: { text: 'Completed', lang: 'en' } },
    ],
    subject: { id: id(n), type: 'Book', types: ['Book'], label: `Private ${viewer} ${n}`, cover: null },
    changeKey: id(100 + n),
    removeKey: id(200 + n),
  };
}
function response(viewer: string, search: ShelfSearch = {}): PersonalLibraryCurrentRead {
  return {
    sessionSubject: viewer,
    requested: {
      type: search.type ?? null,
      state: search.state ?? null,
      cursor: search.cursor ?? null,
      orderBy: search.orderBy ?? 'lastActivity',
      direction: search.direction ?? 'desc',
      locale: 'en',
    },
    page: {
      signedIn: true,
      entries: [entry(viewer, 1), entry(viewer, 2)],
      next: `next-${viewer}`,
      sort: { orderBy: search.orderBy ?? 'lastActivity', direction: search.direction ?? 'desc' },
    },
    continueEntries: {
      state: 'loaded',
      entries: [{ subjectId: id(3), label: `Progress ${viewer}`, summary: null, progress: null }],
      next: null,
    },
    navigation: {
      pins: {
        state: 'loaded',
        revision: 1,
        next: null,
        pins: [{ collectionId: id(4), target: { id: id(4), title: `Pinned ${viewer}` } }],
      },
      collections: [
        { id: id(5), title: `Collection ${viewer}`, curator: null, membershipKind: 'dynamic', builtinKind: 'state' },
      ],
      collectionsState: 'loaded',
    },
  };
}

async function personalLibraryBoundaryJourney(windowsOnly = false) {
  serverReads = true;
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library' });
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
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const reads = await import('../src/library/personal-library-server');
  const calls: Request[] = [];
  let stale = false;
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    if (new URL(call.url).pathname.startsWith('/v1/definitions/')) return Response.json({}, { status: 503 });
    calls.push(call);
    expect(call.cache).toBe('no-store');
    expect(call.redirect).toBe('manual');
    const url = new URL(call.url);
    if (url.pathname === '/v1/libraryEntries') {
      expect(url.searchParams.get('limit')).toBe('20');
      if (stale && url.searchParams.has('cursor'))
        return Response.json({ code: 'invalid_cursor', status: 400 }, { status: 400 });
      return Response.json({ libraryEntries: [], next: null });
    }
    if (url.pathname === '/v1/libraryContinue') {
      expect(url.searchParams.get('limit')).toBe('6');
      return Response.json({ subjects: [], next: null });
    }
    if (url.pathname === '/v1/openapi.json')
      return Response.json({
        paths: {
          '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
        },
      });
    if (url.pathname === '/v1/libraryPins') {
      expect(url.searchParams.get('limit')).toBe('8');
      return Response.json({
        pins: [{ collectionId: id(4), target: { id: id(4), title: 'Private pin' } }],
        revision: 1,
        next: null,
      });
    }
    if (url.pathname === '/v1/collections') {
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.get('curatorAccountId')).toBeTruthy();
      return Response.json({ collections: [nativeCollection({ id: id(5), title: 'Private collection' })], next: null });
    }
    // Optional definitions naming has no fixture release; native readers still keep their failure semantics.
    return Response.json({}, { status: 503 });
  });
  try {
    const before = preparationCalls;
    const healthy = await reads.readPersonalLibraryCurrent({
      data: { state: 'planned', cursor: 'first+/==', type: 'core:Book' },
    });
    expect(healthy.sessionSubject).toBe('A');
    expect(healthy.requested).toEqual({
      state: 'planned',
      cursor: 'first+/==',
      type: 'core:Book',
      orderBy: 'createdAt',
      direction: 'desc',
      locale: 'en',
    });
    expect(preparationCalls - before).toBe(3);
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/libraryEntries')).toHaveLength(1);
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/libraryContinue')).toHaveLength(1);
    expect(calls.filter((call) => new URL(call.url).pathname === '/v1/collections')).toHaveLength(1);
    const privateCalls = calls.filter((call) =>
      ['/v1/libraryEntries', '/v1/libraryContinue', '/v1/libraryPins', '/v1/collections'].includes(
        new URL(call.url).pathname,
      ),
    );
    expect(privateCalls.every((call) => call.headers.get('authorization') === 'Bearer credential-A')).toBe(true);
    expect(headers.get('cache-control')).toBe('private, no-store');
    stale = true;
    const restartOffset = calls.length;
    const restarted = await reads.readPersonalLibraryCurrent({
      data: {
        type: 'core:Book',
        state: 'planned',
        orderBy: 'priority',
        direction: 'desc',
        cursor: 'stale',
      },
    });
    expect(restarted.page).toMatchObject({ cursorReset: true });
    expect(restarted.requested).toEqual({
      type: 'core:Book',
      state: 'planned',
      orderBy: 'priority',
      direction: 'desc',
      cursor: 'stale',
      locale: 'en',
    });
    const restartPages = calls
      .slice(restartOffset)
      .filter((call) => new URL(call.url).pathname === '/v1/libraryEntries')
      .map((call) => new URL(call.url));
    expect(restartPages).toHaveLength(2);
    expect(Object.fromEntries(restartPages[0]!.searchParams)).toMatchObject({
      type: 'core:Book',
      state: 'planned',
      orderBy: 'priority',
      direction: 'desc',
      cursor: 'stale',
      limit: '20',
    });
    expect(Object.fromEntries(restartPages[1]!.searchParams)).toEqual({
      view: 'FULL',
      limit: '20',
      state: 'planned',
      orderBy: 'priority',
      direction: 'desc',
      type: 'core:Book',
    });
    stale = false;
    for (const mixed of [
      [
        { status: 'active', subject: 'A' },
        { status: 'active', subject: 'B' },
        { status: 'active', subject: 'A' },
      ],
      [
        { status: 'active', subject: 'A' },
        { status: 'active', subject: 'A', accessToken: 'different-credential' },
        { status: 'active', subject: 'A' },
      ],
      [{ status: 'active', subject: 'A' }, { status: 'absent' }, { status: 'active', subject: 'A' }],
      [{ status: 'active', subject: 'A' }, { status: 'unavailable' }, { status: 'active', subject: 'A' }],
      [
        { status: 'active', subject: 'A' },
        { status: 'active', subject: '' },
        { status: 'active', subject: 'A' },
      ],
    ] satisfies Preparation[][]) {
      preparations = mixed;
      const refused = await reads.readPersonalLibraryCurrent({ data: {} });
      expect(refused.sessionSubject).toBeNull();
      expect(refused.page).toMatchObject({ entries: [], next: null });
      expect(refused.continueEntries.state).not.toBe('loaded');
      expect(refused.navigation.collections).toEqual([]);
      expect(refused.navigation.pins.state).not.toBe('loaded');
    }
    currentRequest = new Request('https://site.test/en/library', { headers: { authorization: 'Bearer asserted' } });
    expect((await reads.readPersonalLibraryCurrent({ data: {} })).sessionSubject).toBeNull();
    currentRequest = request();
    calls.length = 0;
    const refresh = await reads.readPersonalLibraryContinue({ data: { cursor: 'shelf-page' } });
    expect(refresh).toMatchObject({
      sessionSubject: 'A',
      requested: { cursor: 'shelf-page' },
      result: { state: 'loaded', entries: [], next: null },
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/libraryContinue']);
  } finally {
    native.mockRestore();
    serverReads = false;
  }

  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { PersonalLibraryCurrent } = await import('../src/library/personal-library-current');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { EntriesWindowNavigation } = await import('../src/library/entries-window-navigation');
  const windows = new EntriesWindowNavigation();
  const { Route } = await import('../src/routes/library/index');
  expect(String(Route.options.component)).toContain('LibraryPresentationBoundary');
  const actions = await import('../src/library/entries-actions');
  const labelActions = await import('../src/library/subject-slot-actions');
  const labelReads = await import('../src/library/labels-actions');
  const rows = await import('../src/library/shelf-rows');
  const toasts = await import('@rezics/ui/undo-toast');
  const { m } = await import('../src/paraglide/messages.js');
  let controls!: ReturnType<typeof rows.useShelfRows>;
  const originalRows = rows.useShelfRows;
  const observeRows = spyOn(rows, 'useShelfRows').mockImplementation((...args) => {
    controls = originalRows(...args);
    return controls;
  });
  const pendingReads: ReturnType<typeof deferred<PersonalLibraryCurrentRead>>[] = [];
  const transport = spyOn(reads, 'readPersonalLibraryCurrent').mockImplementation(() => {
    const work = deferred<PersonalLibraryCurrentRead>();
    pendingReads.push(work);
    return work.promise;
  });
  const continueReads: ReturnType<typeof deferred<PersonalContinueRead>>[] = [];
  const continueTransport = spyOn(reads, 'readPersonalLibraryContinue').mockImplementation(() => {
    const work = deferred<PersonalContinueRead>();
    continueReads.push(work);
    return work.promise;
  });
  const writes: {
    input: Parameters<typeof actions.savePersonalLibraryEntry>[0];
    work: ReturnType<typeof deferred<LibraryMutationResult>>;
  }[] = [];
  const write = spyOn(actions, 'savePersonalLibraryEntry').mockImplementation((input) => {
    const work = deferred<LibraryMutationResult>();
    writes.push({ input, work });
    return work.promise;
  });
  const remove = spyOn(actions, 'deletePersonalLibraryEntry').mockResolvedValue({
    ok: true,
    undo: { deletionId: id(80), revision: 8 },
  });
  const restore = spyOn(actions, 'restorePersonalLibraryEntryAction').mockResolvedValue({
    ok: false,
    reason: 'expired',
  });
  const assign = spyOn(labelActions, 'mutateSubjectLabelAction').mockResolvedValue({
    ok: false,
    reason: 'unavailable',
  });
  const picker = spyOn(labelReads, 'readSubjectLabelPage').mockResolvedValue({
    state: 'loaded',
    labels: [{ id: id(9), name: 'Label A private', revision: 1 }],
    next: null,
  });
  const undos: (() => void)[] = [];
  const toast = spyOn(toasts, 'undoToast').mockImplementation((_message, callback) => {
    undos.push(callback);
    return 'test-undo';
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopObservation = viewerExposureLifetime(client).subscribe(() => {});
  client.setQueryData(['library-navigation', 'en', 8, 'session'], {
    pins: response('STALE').navigation.pins,
    collections: [],
    collectionsState: 'loaded',
  });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library'] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  let initial = response('A');
  let search: ShelfSearch = {};
  let display: ShelfDisplay = { layout: 'list', size: 'm' };
  const hydrationErrors: unknown[] = [];
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <PersonalLibraryCurrent windows={windows} initial={initial} search={search} locale="en" display={display} />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const session = (subject: string, csrfToken = `csrf-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
  const show = async (
    viewer: { state: string; subject?: string; csrfToken: string | null },
    admitted = true,
    keepViewer = false,
  ) => {
    await act(async () => {
      if (!keepViewer || JSON.stringify(client.getQueryData(['session'])) !== JSON.stringify(viewer))
        client.setQueryData(['session'], viewer);
      const observation = viewerExposureLifetime(client).getSnapshot();
      if (viewer.state === 'signed-in')
        expect(observation).toMatchObject({ state: 'signed-in', observation: { subject: viewer.subject } });
      if (observation.state === 'signed-in')
        client.setQueryData(viewerExposureQuery(observation.observation).queryKey, {
          subject: observation.observation.subject,
          admitted: admitted
            ? ['personal_library', 'reading_progress', 'collections', 'library_label.list', 'library_label.assign']
            : [],
          state: admitted ? 'ready' : 'denied',
        });
      client.setQueryData(['exposure', 'anonymous'], []);
      if (!root) {
        const html = renderToString(tree());
        expect(html).toContain('Private A 1');
        expect(html).toContain('Progress A');
        host.innerHTML = html;
        root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
      } else root.render(tree());
    });
    const observation = viewerExposureLifetime(client).getSnapshot();
    if (viewer.state === 'signed-in')
      expect(observation).toMatchObject({ state: 'signed-in', observation: { subject: viewer.subject } });
    if (observation.state === 'signed-in')
      expect(client.getQueryData(viewerExposureQuery(observation.observation).queryKey)).toMatchObject({
        subject: observation.observation.subject,
        state: admitted ? 'ready' : 'denied',
      });
  };
  const tick = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const settle = async (index: number, value: PersonalLibraryCurrentRead) => {
    await act(async () => pendingReads[index]!.resolve(value));
    await tick();
  };
  const refetch = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: ['personal-library-current'], type: 'active' });
    });
  };
  const retired = (viewer: string) => {
    for (const value of [`Private ${viewer}`, `Progress ${viewer}`, `Pinned ${viewer}`, `Collection ${viewer}`])
      expect(document.body.textContent).not.toContain(value);
    expect(host.querySelector('input[name="subjectId"]')).toBeNull();
    expect([...host.querySelectorAll('a')].some((link) => link.href.includes(`next-${viewer}`))).toBe(false);
  };
  try {
    if (windowsOnly) {
      await show(session('A'));
      // Three real current-reader windows; sparse and empty pages retain native navigation.
      const navigation = spyOn(router, 'navigate').mockResolvedValue(undefined);
      const link = (label: string) => [...host.querySelectorAll('a')].find((a) => a.textContent === label);
      const moveWindow = async (label: string, cursor?: string, fail = false) => {
        await act(async () => link(label)!.click());
        expect(windows.pending).toBeDefined();
        search = {
          type: 'core:Book',
          state: 'planned',
          orderBy: 'createdAt',
          direction: 'desc',
          ...(cursor ? { cursor } : {}),
        };
        const index = pendingReads.length;
        await show(session('C', 'csrf-rotated-again'), true, true);
        if (fail) {
          await act(async () => pendingReads[index]!.reject(new Error('target unavailable')));
          await tick();
        } else {
          const value = response('C', search);
          value.page = { ...value.page, entries: [], next: cursor === 'third+/==' ? null : 'third+/==' };
          await settle(index, value);
        }
      };
      try {
        search = { type: 'core:Book', state: 'planned', orderBy: 'createdAt', direction: 'desc' };
        let index = pendingReads.length;
        await show(session('C', 'csrf-rotated-again'), true, true);
        await settle(index, response('C', search));
        const destination = host.querySelector(`a[href*="${id(1)}"]`)?.getAttribute('href');
        expect(destination).toBeTruthy();
        await moveWindow(m.library_next_page(), 'next-C');
        expect(link(m.library_window_previous())).toBeDefined();
        await moveWindow(m.library_next_page(), 'third+/==', true);
        expect(windows.previous).toBeNull();
        const retry = [...host.querySelectorAll('button')].find((b) => b.textContent === m.library_window_retry())!;
        index = pendingReads.length;
        await act(async () => retry.click());
        expect(transport.mock.calls.at(-1)![0].data.cursor).toBe('third+/==');
        const terminal = response('C', search);
        terminal.page = { ...terminal.page, entries: [], next: null };
        await settle(index, terminal);
        expect(link(m.library_next_page())).toBeUndefined();
        expect(link(m.library_window_first())).toBeDefined();
        expect(windows.previous).toBe('next-C');
        display = { layout: 'grid', size: 'm' };
        await show(session('C', 'csrf-rotated-again'), true, true);
        expect(windows.previous).toBe('next-C');
        await moveWindow(m.library_window_previous(), 'next-C');
        await moveWindow(m.library_window_first());
        expect(link(m.library_window_previous())).toBeUndefined();
        // Fresh later address has no invented predecessor, then private replacement cancels a staged move.
        search = { ...search, cursor: 'fresh-later' };
        index = pendingReads.length;
        await show(session('C', 'csrf-rotated-again'), true, true);
        await settle(index, response('C', search));
        expect(link(m.library_window_previous())).toBeUndefined();
        await act(async () => link(m.library_next_page())!.click());
        await show(session('D'));
        expect(windows.pending).toBeUndefined();
        expect(windows.previous).toBeUndefined();
      } finally {
        navigation.mockRestore();
      }
      return;
    }
    await show(session('A'));
    expect(host.textContent).toContain('Pinned A');
    expect(host.textContent).not.toContain('Pinned STALE');
    await act(async () => controls.selectPage());
    expect(controls.selected).toEqual([id(1), id(2)]);
    const openPicker = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_selected_labels_open(),
    );
    await act(async () => openPicker!.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 275));
    });
    expect(document.body.textContent).toContain('Label A private');
    await act(async () => controls.askRemove(id(1)));
    expect(document.body.textContent).toContain(m.library_remove_confirm());
    const obsoleteControls = controls;
    let batch!: Promise<void>;
    await act(async () => {
      controls.cancelRemove();
      batch = controls.changeSelectedState('completed');
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.input.data).toEqual({
      subjectId: id(1),
      state: 'completed',
      revision: 7,
      incarnationId: id(90),
      idempotencyKey: id(101),
    });
    await show(session('B'));
    retired('A');
    expect(document.body.textContent).not.toContain(m.library_remove_confirm());
    expect(document.body.textContent).not.toContain('Label A private');
    expect(pendingReads).toHaveLength(2);
    await settle(1, response('B'));
    expect(host.textContent).toContain('Private B 1');
    expect(controls.pending).toBe(false);
    expect(controls.selected).toEqual([]);
    await act(async () => {
      void controls.changeState(id(1), 'completed');
    });
    expect(writes).toHaveLength(2);
    expect(controls.pending).toBe(true);
    await settle(0, response('A'));
    await act(async () => {
      writes[0]!.work.resolve({
        ok: true,
        entry: { subjectId: id(1), state: 'completed', revision: 8, updatedAt: '2026-02-01' },
      });
      await batch;
    });
    retired('A');
    expect(writes).toHaveLength(2);
    expect(controls.pending).toBe(true); // A finally cannot release B.
    await act(async () => {
      await obsoleteControls.changeState(id(2), 'completed');
      await obsoleteControls.assignSelectedLabel({ id: id(9), name: 'Old label', revision: 1 });
      await obsoleteControls.remove();
    });
    expect(writes).toHaveLength(2);
    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    await show(session('B', 'rotated-csrf'));
    initial = response('B');
    await show(session('B', 'rotated-csrf'));
    await settle(2, response('B'));
    await act(async () => writes[1]!.work.reject(new Error('Uncertain native result')));
    expect(controls.rows[0]!.unknownIntent).toEqual(writes[1]!.input.data);
    await refetch();
    const refreshed = response('B');
    if (refreshed.page.signedIn) {
      refreshed.page.entries[0]!.revision = 99;
      refreshed.page.entries[0]!.changeKey = id(999);
    }
    await settle(3, refreshed);
    await act(async () => {
      void controls.retryState(id(1));
    });
    expect(writes[2]!.input.data).toEqual(writes[1]!.input.data);
    expect(new Headers(writes[2]!.input.headers).get('X-CSRF-Token')).toBe('rotated-csrf');
    await act(async () =>
      writes[2]!.work.resolve({
        ok: true,
        entry: { subjectId: id(1), state: 'completed', revision: 8, incarnationId: id(90), updatedAt: '2026-02-01' },
      }),
    );
    expect(controls.rows[0]!.entry.state).toBe('completed');
    await act(async () => controls.askRemove(id(1)));
    await act(async () => controls.remove());
    expect(remove.mock.calls[0]![0].data).toMatchObject({
      subjectId: id(1),
      revision: 8,
      incarnationId: id(90),
      idempotencyKey: id(201),
    });
    expect(undos).toHaveLength(1);
    await act(async () => {
      void controls.changeState(id(2), 'completed');
      undos[0]!();
    }); // Undo queues behind the active request.
    await show({ state: 'unknown', csrfToken: null });
    retired('B');
    await act(async () => undos[0]!());
    expect(restore).not.toHaveBeenCalled();
    await show(session('C'));
    await settle(4, response('C'));
    expect(controls.pending).toBe(false);
    await act(async () => {
      void controls.changeState(id(2), 'completed');
    });
    await act(async () => writes[3]!.work.reject(new Error('Retired failure')));
    expect(controls.pending).toBe(true);
    expect(host.textContent).toContain('Private C 1');
    await act(async () =>
      writes[4]!.work.resolve({
        ok: true,
        entry: { subjectId: id(2), state: 'completed', revision: 8, updatedAt: '2026-02-01' },
      }),
    );
    // Refresh uses the actual Continue retry path after a provenance-bearing failure is installed.
    initial = { ...response('C'), continueEntries: { state: 'unavailable' } };
    await show(session('C'));
    await settle(5, initial);
    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_follow_retry(),
    );
    expect(retry).toBeDefined();
    await act(async () => retry!.click());
    await act(async () =>
      continueReads[0]!.resolve({
        sessionSubject: 'A',
        requested: response('C').requested,
        result: response('A').continueEntries,
      }),
    );
    expect(host.textContent).not.toContain('Progress A');
    expect(host.querySelector('[data-continue-state="unavailable"]')).not.toBeNull();
    const secondRetry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.library_follow_retry(),
    );
    await act(async () => secondRetry!.click());
    await refetch();
    search = { cursor: 'other-page' };
    await show(session('C'));
    retired('C');
    await settle(7, response('C'));
    retired('C'); // Right viewer, wrong source is withheld.
    await settle(6, response('C'));
    retired('C'); // Late old-address read cannot restore it.
    await refetch();
    await settle(8, response('C', search));
    expect(host.textContent).toContain('Private C 1');
    await act(async () =>
      continueReads[1]!.resolve({
        sessionSubject: 'C',
        requested: response('C').requested,
        result: response('OBSOLETE').continueEntries,
      }),
    );
    expect(host.textContent).not.toContain('Progress OBSOLETE');
    const beforeDisplay = controls;
    display = { ...display };
    search = { ...search, columns: 'title', layout: 'table', size: 'l' };
    await show(session('C'));
    expect(controls.isCurrent()).toBe(true);
    expect(beforeDisplay.isCurrent()).toBe(true);
    await show({ state: 'signed-out', csrfToken: null });
    retired('C');
    await show(session('C'), false);
    retired('C');
    await show(session('C'));
    retired('C');
    await settle(9, { ...response('C', search), sessionSubject: 'A' });
    retired('C');
    retired('A');
    await refetch();
    await settle(10, response('C', search));
    expect(host.textContent).toContain('Private C 1');
    await act(async () => controls.selectPage());
    await act(async () => controls.assignSelectedLabel({ id: id(9), name: 'Current chosen label', revision: 1 }));
    const exactLabel = assign.mock.calls[0]![0].data;
    expect(exactLabel).toMatchObject({ intent: 'assign', subjectId: id(1), labelId: id(9) });
    expect(controls.rows[0]!.unknownLabelIntent?.labelName).toBe('Current chosen label');
    await show(session('C', 'csrf-rotated-again'));
    await refetch();
    await settle(11, response('C', search));
    assign.mockResolvedValue({ ok: true, assignment: { id: id(10), revision: 1 } });
    await act(async () => controls.retryLabel(id(1)));
    expect(assign.mock.calls[1]![0].data).toEqual(exactLabel);
    expect(new Headers(assign.mock.calls[1]![0].headers).get('X-CSRF-Token')).toBe('csrf-rotated-again');
    expect(controls.rows[0]!.unknownLabelIntent).toBeUndefined();
    await show({ state: 'unavailable', csrfToken: null });
    retired('C');
    expect(hydrationErrors).toEqual([]);
  } finally {
    if (root) await act(async () => root!.unmount());
    stopObservation();
    client.clear();
    host.remove();
    for (const spy of [observeRows, transport, continueTransport, write, remove, restore, assign, picker, toast])
      spy.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

test('The actual personal Library accepts only matching prepared-viewer and source results and retires obsolete private state and mutation continuations', () =>
  personalLibraryBoundaryJourney());
test('Tracked Library traverses three admitted windows, retries the exact failed target, and releases replaced private visits', () =>
  personalLibraryBoundaryJourney(true));
