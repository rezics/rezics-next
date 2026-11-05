import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useLayoutEffect, useRef, type ReactNode, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { CopiesCurrentRead, CopyDetailCurrentRead, CopySubjectCurrentRead } from '../src/library/copies-actions';
import type { CopyItem, CopyWriteResult, CopyRemoveResult } from '../src/library/copies-read';
import type { SessionEnv } from '../src/session/client';

// UNRUN at this source boundary. Installed DOM, real route, CopyForm and UndoNotice;
// native services and visual/browser acceptance remain the controller's later proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const filterOptions = {
  kinds: { state: 'available', choices: [{ id: 'print', label: 'Historical print', meaning: 'available' }] },
  statuses: { state: 'unavailable', choices: [] },
};
const profile = { kinds: [{ id: 'print', label: 'Print', statuses: [{ id: 'shelf', label: 'On shelf' }] }] };
const release = {
  types: { Book: { library: { profileId: 'books' } } },
  properties: {},
  libraryProfiles: {
    books: {
      copies: {
        kinds: [{ id: 'print', labels: { en: 'Print' }, statuses: [{ id: 'shelf', labels: { en: 'On shelf' } }] }],
      },
    },
  },
};
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let preparedViewer = 'A';
let prepareCalls = 0;
let identityCalls = 0;
let refuseAfterPreparation = false;
const env = {
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SITE_ORIGINS: 'https://site.test',
  SESSIONS: {
    idFromName: (value: string) => value,
    get: () => ({
      credential: async () => {
        prepareCalls++;
        const status = preparation;
        if (refuseAfterPreparation) preparation = 'absent';
        return {
          status,
          subject: preparedViewer,
          accessToken: `credential-${preparedViewer}`,
          csrfToken: `csrf-${preparedViewer}`,
        };
      },
      signedIn: async () => {
        identityCalls++;
        return { signedIn: true, subject: 'B', csrfToken: 'csrf-B' };
      },
    }),
  },
};
const request = () =>
  new Request('https://site.test/en/library/copies', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn: () => ({
    server: (handler: (...args: never[]) => unknown) => ({ client: () => handler }),
  }),
}));
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
// Presentation portals and catalogue search use the existing lightweight test surfaces.
const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module('@rezics/ui/shadcn/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogContent: Part,
  DialogDescription: Part,
  DialogFooter: Part,
  DialogClose: Part,
  DialogTrigger: Part,
  DialogOverlay: Part,
  DialogPortal: Part,
  DialogHeader: Part,
  DialogTitle: Part,
}));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
}));
mock.module('@rezics/ui/responsive-dialog', () => ({
  ResponsiveDialog: ({
    open,
    children,
    onOpenChangeComplete,
    finalFocus,
  }: {
    open: boolean;
    children: ReactNode;
    onOpenChangeComplete?: (open: boolean) => void;
    finalFocus?: () => HTMLElement | false;
  }) => {
    const wasOpen = useRef(open);
    useLayoutEffect(() => {
      if (wasOpen.current && !open) {
        const target = finalFocus?.();
        if (target && target.isConnected) target.focus();
        onOpenChangeComplete?.(false);
      }
      wasOpen.current = open;
    }, [open]);
    return open ? <div role="dialog">{children}</div> : null;
  },
}));
mock.module('@rezics/ui/shadcn/alert-dialog', () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogCancel: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  AlertDialogContent: Part,
  AlertDialogDescription: Part,
  AlertDialogFooter: Part,
  AlertDialogHeader: Part,
  AlertDialogTitle: Part,
}));
mock.module('@rezics/ui/menu', () => ({
  Menu: ({ entries }: { entries: { label: string; onSelect: () => void }[] }) => (
    <>
      {entries.map((entry) => (
        <button key={entry.label} onClick={entry.onSelect}>
          {entry.label}
        </button>
      ))}
    </>
  ),
}));
mock.module('../src/library/copy-edition-picker', () => ({
  CopyEditionPicker: ({
    disabled,
    onChange,
  }: {
    disabled: boolean;
    onChange: (subject: { id: string; title: string; types: string[] } | null) => void;
  }) => (
    <select
      aria-label="Edition"
      disabled={disabled}
      defaultValue=""
      onChange={(event) => onChange({ id: event.currentTarget.value, title: 'Selected edition', types: ['Book'] })}
    >
      <option value="" />
      <option value={id(10)}>First</option>
      <option value={id(11)}>Second</option>
    </select>
  ),
}));
const actions = await import('../src/library/copies-actions');
const definitions = await import('../src/subject/definitions');
const names = spyOn(definitions, 'nameSubjectTypes').mockResolvedValue(undefined);
const released = spyOn(definitions, 'readRelease').mockResolvedValue(release);
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
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
function copy(viewer: string, n = 1): CopyItem {
  return {
    id: id(n),
    revision: 7,
    kind: 'print',
    status: 'shelf',
    kindLabel: 'Accepted print',
    statusLabel: 'Accepted shelf',
    meaning: 'known',
    statusEditing: { state: 'supported', statuses: [{ id: 'loan', label: 'On loan' }] },
    location: `Private location ${viewer}`,
    source: `Private source ${viewer}`,
    acquiredOn: '2020-02-29',
    disposedOn: '2025-03-01',
    note: `Private note ${viewer}`,
    idempotencyKey: id(100 + n),
    subject: { id: id(10), type: 'Book', types: ['Book'], label: `Private edition ${viewer}`, cover: null },
  };
}
type Search = { subjectId?: string; kind?: string; status?: string; cursor?: string; copyFailure?: string };
function response(viewer: string, search: Search = { subjectId: id(10), cursor: 'first' }): CopiesCurrentRead {
  return {
    sessionSubject: viewer,
    requested: {
      subjectId: search.subjectId ?? null,
      kind: search.kind ?? null,
      status: search.status ?? null,
      cursor: search.cursor ?? null,
      locale: 'en',
    },
    page: {
      signedIn: true,
      subjectId: search.subjectId ?? null,
      kind: search.kind ?? null,
      status: search.status ?? null,
      requestedCursor: search.cursor ?? null,
      copies: [copy(viewer)],
      next: `next-${viewer}`,
      addKey: id(90),
      sendKind: true,
      profile,
      csrfToken: `csrf-${viewer}`,
    },
  };
}
function forbiddenResponse(viewer: string, search: Search): CopiesCurrentRead {
  const value = response(viewer, search);
  value.page = { ...value.page, copies: [], next: null, inventoryState: 'forbidden' };
  return value;
}

test('Actual server exports certify only the exact native preparation, preserve bounded recovery and refuse missing/retained provenance', async () => {
  const { prepareSession, viewerCredential } = await import('../src/session/request');
  const calls: Request[] = [];
  const native = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    const url = new URL(call.url);
    if (url.pathname === '/v1/copies') {
      if (url.searchParams.has('cursor')) return Response.json({ code: 'invalid_cursor' }, { status: 400 });
      return Response.json({ copies: [{ ...copy('A'), subject: null }], next: 'next-A', filterOptions });
    }
    if (url.pathname === `/v1/copies/${id(1)}`) return Response.json({ copy: { ...copy('A'), subject: null } });
    if (url.pathname === `/v1/subjects/${id(10)}`)
      return Response.json({ subject: { id: id(10), type: 'Book', labels: { en: 'Prepared A edition' } } });
    throw new Error(`Unexpected native read: ${url}`);
  });
  try {
    currentRequest = request();
    preparation = 'active';
    refuseAfterPreparation = true;
    const before = prepareCalls;
    const value = await actions.readCopiesCurrent({
      data: { subjectId: id(10), cursor: 'bad/keyset+cursor' },
    });
    expect(value).toMatchObject({
      sessionSubject: 'A',
      requested: { subjectId: id(10), kind: null, status: null, cursor: 'bad/keyset+cursor', locale: 'en' },
      page: { kind: null, status: null, csrfToken: 'csrf-A', next: 'next-A' },
    });
    expect(value.page.copies[0]?.subject?.label).toBe('Prepared A edition');
    expect(prepareCalls - before).toBe(1);
    expect(identityCalls).toBe(0); // signedIn() would claim replacement B and must not stamp A.
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/copies',
      '/v1/copies',
      `/v1/subjects/${id(10)}`,
    ]);
    const listAddresses = calls.slice(0, 2).map((call) => new URL(call.url).searchParams);
    expect(listAddresses.map((query) => [query.get('subjectId'), query.get('kind'), query.get('status')])).toEqual([
      [id(10), null, null],
      [id(10), null, null],
    ]);
    expect(listAddresses[0]?.get('cursor')).toBe('bad/keyset+cursor');
    expect(listAddresses[1]?.has('cursor')).toBe(false);
    expect(
      calls.every(
        (call) =>
          call.headers.get('authorization') === 'Bearer credential-A' &&
          call.cache === 'no-store' &&
          call.redirect === 'manual',
      ),
    ).toBe(true);
    expect(JSON.stringify(value)).not.toContain('credential-A');
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(value.page.filterOptions).toEqual(filterOptions);
    refuseAfterPreparation = false;
    native.mockImplementation(async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      const url = new URL(call.url);
      if (url.pathname === '/v1/copies') {
        if (url.searchParams.get('kind') === 'old.print' || url.searchParams.get('status') === 'retired')
          return Response.json({ code: 'unsupported_filter' }, { status: 400 });
        if (url.searchParams.has('cursor')) return Response.json({ code: 'invalid_cursor' }, { status: 400 });
        return Response.json({ copies: [{ ...copy('A'), subject: null }], next: 'next-A', filterOptions });
      }
      if (url.pathname === `/v1/copies/${id(1)}`) return Response.json({ copy: { ...copy('A'), subject: null } });
      if (url.pathname === `/v1/subjects/${id(10)}`)
        return Response.json({ subject: { id: id(10), type: 'Book', labels: { en: 'Prepared A edition' } } });
      throw new Error(`Unexpected native read: ${url}`);
    });
    for (const filters of [{ kind: 'old.print' }, { status: 'retired' }]) {
      preparation = 'active';
      currentRequest = request();
      const before = prepareCalls;
      const copiesBefore = calls.filter((call) => new URL(call.url).pathname === '/v1/copies').length;
      const unavailable = await actions.readCopiesCurrent({
        data: { subjectId: id(10), ...filters, cursor: 'exact/selected+cursor' },
      });
      expect(unavailable).toMatchObject({
        sessionSubject: 'A',
        requested: { subjectId: id(10), ...filters, cursor: 'exact/selected+cursor', locale: 'en' },
        page: { ...filters, inventoryState: 'unavailable', copies: [], next: null, csrfToken: 'csrf-A' },
      });
      expect(unavailable.page.filterOptions).toBeUndefined();
      expect(prepareCalls - before).toBe(1);
      expect(calls.filter((call) => new URL(call.url).pathname === '/v1/copies')).toHaveLength(copiesBefore + 1);
    }
    preparation = 'active';
    currentRequest = request();
    const admitted = await actions.readCopiesCurrent({
      data: { subjectId: id(10), kind: 'print', status: 'shelf' },
    });
    expect(admitted).toMatchObject({
      sessionSubject: 'A',
      requested: { subjectId: id(10), kind: 'print', status: 'shelf', cursor: null, locale: 'en' },
      page: { kind: 'print', status: 'shelf', copies: [{ id: id(1) }], next: 'next-A', csrfToken: 'csrf-A' },
    });
    expect(admitted.page.filterOptions).toEqual(filterOptions);
    expect(admitted.page.inventoryState).toBeUndefined();

    // Real retained WeakMap credential, followed by real refusal on the original Request.
    refuseAfterPreparation = false;
    preparation = 'active';
    await prepareSession(currentRequest, env as unknown as Partial<SessionEnv>);
    preparation = 'absent';
    const count = calls.length;
    for (const read of [
      await actions.readCopiesCurrent({ data: { subjectId: id(10) } }),
      await actions.readCopyDetailCurrent({ data: { id: id(1) } }),
      await actions.readCopySubjectCurrent({ data: { id: id(10) } }),
    ]) {
      expect(read.sessionSubject).toBeNull();
      expect(JSON.stringify(read)).not.toContain('Private');
    }
    expect(viewerCredential(currentRequest)).toBe('Bearer credential-A');
    expect(calls).toHaveLength(count);
    preparation = 'unavailable';
    await expect(actions.readCopiesCurrent({ data: {} })).rejects.toThrow('session_unavailable');
    expect(await actions.readCopyDetailCurrent({ data: { id: id(1) } })).toMatchObject({
      sessionSubject: null,
      result: { ok: false, reason: 'unavailable' },
    });

    preparation = 'active';
    currentRequest = request();
    preparedViewer = 'B';
    expect(
      await actions.readCopyDetailCurrent({
        data: { id: id(1), subjectId: id(10), kind: 'print', status: 'shelf', cursor: 'point-source' },
      }),
    ).toMatchObject({
      sessionSubject: 'B',
      id: id(1),
      requested: { subjectId: id(10), kind: 'print', status: 'shelf', cursor: 'point-source', locale: 'en' },
    });
    expect(await actions.readCopySubjectCurrent({ data: { id: id(10), cursor: 'selected-source' } })).toMatchObject({
      sessionSubject: 'B',
      id: id(10),
      requested: { cursor: 'selected-source' },
      result: { state: 'ready', subject: { id: id(10) } },
    });
    currentRequest = new Request('https://site.test/en/library/copies', {
      headers: { authorization: 'Bearer explicit' },
    });
    expect((await actions.readCopiesCurrent({ data: {} })).sessionSubject).toBeNull();
    expect(await actions.readCopyDetailCurrent({ data: { id: id(1) } })).toMatchObject({
      sessionSubject: null,
      result: { ok: false },
    });
    expect(await actions.readCopySubjectCurrent({ data: { id: id(10) } })).toMatchObject({
      sessionSubject: null,
      result: { state: 'unavailable' },
    });
    // The original API still supports explicit credentials and original result shapes.
    expect(await actions.readCopyDetail({ data: { id: id(1) } })).toMatchObject({ ok: true, copy: { id: id(1) } });
    expect(await actions.readCopySubject({ data: id(10) })).toMatchObject({ state: 'ready' });
    expect((await actions.readCopiesPage({ data: {} })).signedIn).toBe(true);
  } finally {
    native.mockRestore();
    preparedViewer = 'A';
    preparation = 'active';
    currentRequest = request();
  }
});

test('three routed inventory windows retain admitted predecessors, retry the exact target, inspect and return through Commerce address', async () => {
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const {
    createRoute,
    createRootRoute,
    createMemoryHistory,
    RouterProvider,
    Outlet,
    Link,
    useRouterState,
    createRouter,
  } = await import('@tanstack/react-router');
  const actions = await import('../src/library/copies-actions');
  const { copiesAddress, copiesQuery } = await import('../src/library/copies-query');
  const { copyInventoryReturnHref } = await import('../src/library/copy-reading-context/navigation');
  const { CopiesCurrent } = await import('../src/library/copies-current');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { m } = await import('../src/paraglide/messages.js');

  const routeReads: Search[] = [];
  const listReads: (ReturnType<typeof deferred<CopiesCurrentRead>> & { data: Search })[] = [];
  const detailReads: (ReturnType<typeof deferred<CopyDetailCurrentRead>> & { data: Search & { id: string } })[] = [];
  const read = spyOn(actions, 'readCopiesCurrent').mockImplementation(({ data }) => {
    const call = { ...deferred<CopiesCurrentRead>(), data: data as Search };
    listReads.push(call);
    return call.promise;
  });
  const detail = spyOn(actions, 'readCopyDetailCurrent').mockImplementation(({ data }) => {
    const call = { ...deferred<CopyDetailCurrentRead>(), data: data as Search & { id: string } };
    detailReads.push(call);
    return call.promise;
  });
  const inventory = (search: Search, number: number, note?: string): CopiesCurrentRead => {
    const value = response('A', search);
    value.page.copies = [{ ...copy('A', number), note: note ?? `Copy from window ${number}` }];
    value.page.next = search.cursor === 'c2' ? null : search.cursor === 'c1' ? 'c2' : 'c1';
    return value;
  };
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const copiesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/copies',
    validateSearch: (search: Record<string, unknown>) => copiesQuery(search),
    loaderDeps: ({ search }) => search,
    loader: ({ deps }) => {
      const search = deps as Search;
      routeReads.push(search);
      return inventory(
        search,
        search.cursor === 'c1' ? 2 : search.cursor === 'c2' ? 3 : 1,
        routeReads.length > 1 ? 'Fresh return' : undefined,
      );
    },
    shouldReload: ({ cause }) => cause === 'enter',
    component: () => {
      const routeState = useRouterState({
        select: (state) => ({
          search: state.location.search as Search,
          initial: state.matches.find((match) => match.routeId === '/library/copies')?.loaderData as CopiesCurrentRead,
        }),
      });
      return <CopiesCurrent initial={routeState.initial} search={routeState.search} locale="en" />;
    },
  });
  const subjectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/subject',
    validateSearch: (search: Record<string, unknown>) => search,
    component: () => {
      const via = useRouterState({ select: (state) => (state.location.search as { via?: string }).via });
      const address = new URL(via ?? '/', window.location.origin);
      const search = Object.fromEntries(
        ['subjectId', 'kind', 'status', 'cursor'].flatMap((key) => {
          const value = address.searchParams.get(key);
          return value === null ? [] : [[key, value]];
        }),
      );
      return (
        <Link to="/library/copies" search={search}>
          Return to inventory
        </Link>
      );
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([copiesRoute, subjectRoute]),
    history: createMemoryHistory({ initialEntries: [`/library/copies?subjectId=${id(10)}`] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'A', csrfToken: 'csrf-A' });
  client.setQueryData(['exposure', 'anonymous'], []);
  const exposure = viewerExposureLifetime(client);
  const admitExposure = () => {
    const snapshot = exposure.getSnapshot();
    if (snapshot.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
        subject: snapshot.observation.subject,
        admitted: ['personal_library'],
      });
  };
  admitExposure();
  const release = exposure.subscribe(admitExposure);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const link = (label: string) => {
    const node = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === label);
    expect(node, `Missing link ${label} in ${host.textContent}`).toBeDefined();
    return node!;
  };
  const hasLink = (label: string) => [...host.querySelectorAll('a')].some((item) => item.textContent === label);
  const button = (label: string, region: ParentNode = host) => {
    const node = [...region.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
    expect(node, `Missing button ${label} in ${region.textContent}`).toBeDefined();
    return node!;
  };
  const clickButton = async (label: string, region: ParentNode = host) => {
    await act(async () => button(label, region).click());
    await tick();
  };
  const clickLink = async (label: string) => {
    await act(async () => link(label).click());
    await tick();
  };
  const accept = async (index: number, search: Search, note?: string, page: Partial<CopiesPageData> = {}) => {
    const value = inventory(search, search.cursor === 'c1' ? 2 : search.cursor === 'c2' ? 3 : 1, note);
    value.page = { ...value.page, ...page };
    await act(async () => listReads[index]!.resolve(value));
    await tick();
  };

  try {
    await tick();
    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(0, { subjectId: id(10), cursor: 'c1' });
    expect(host.textContent).toContain('Copy from window 2');
    expect(window.document.activeElement?.id).toBe('copies-inventory-heading');

    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c2');
    await act(async () => listReads.at(-1)!.reject(new Error('Target read failed')));
    await tick();
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.error_message());
    await clickButton(m.subject_view_retry());
    expect(listReads.at(-1)?.data.cursor).toBe('c2');
    await accept(2, { subjectId: id(10), cursor: 'c2' }, undefined, { copies: [] });
    expect(host.textContent).toContain(m.library_copy_page_empty());
    expect(link(m.library_label_previous_page())).toBeDefined();
    expect(link(m.library_collections_first_page())).toBeDefined();

    await clickLink(m.library_label_previous_page());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(3, { subjectId: id(10), cursor: 'c1' });
    expect(host.textContent).toContain('Copy from window 2');
    await clickLink(m.library_collections_first_page());
    expect(listReads.at(-1)?.data.cursor).toBeUndefined();
    await accept(4, { subjectId: id(10) });
    expect(host.textContent).toContain('Copy from window 1');
    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c1');
    await accept(5, { subjectId: id(10), cursor: 'c1' });

    await clickButton(m.library_copy_edit());
    expect(detailReads.at(-1)?.data).toMatchObject({ cursor: 'c1', id: id(2), subjectId: id(10) });
    await act(async () =>
      detailReads.at(-1)!.resolve({
        sessionSubject: 'A',
        requested: copiesAddress({ subjectId: id(10), cursor: 'c1' }, 'en'),
        id: id(2),
        result: { ok: true, copy: { ...copy('A', 2), note: 'Inspected current Copy' } },
      }),
    );
    await tick();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Inspected current Copy');
    const editor = host.querySelector('[role="dialog"]')!;
    await act(async () => button(m.library_copy_more(), editor).click());
    const note = [...editor.querySelectorAll<HTMLTextAreaElement>('textarea')].find((field) => field.value);
    expect(note).toBeDefined();
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(note, 'Unsaved change');
      note!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await clickLink(m.library_copy_more());
    expect(router.state.location.search).toMatchObject({ subjectId: id(10), cursor: 'c1' });
    const departure = host.querySelector('[role="alertdialog"]')!;
    expect(host.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(departure.textContent).toContain(m.library_copy_draft_navigation_description());
    expect(listReads).toHaveLength(6);
    await clickButton(m.library_copy_draft_navigation_stay(), departure);
    expect(router.state.location.search).toMatchObject({ subjectId: id(10), cursor: 'c1' });
    await clickButton(m.library_copy_cancel(), host.querySelector('[role="dialog"]')!);
    const discard = host.querySelector('[role="alertdialog"]')!;
    expect(discard.textContent).toContain(m.library_copy_draft_navigation_description());
    await clickButton(m.library_copy_draft_navigation_discard(), discard);
    expect(router.state.location.search).toMatchObject({ subjectId: id(10), cursor: 'c1' });

    const title = [...host.querySelectorAll<HTMLAnchorElement>('a')].find((node) => node.href.includes('/subjects/'))!;
    const via = new URL(title.href).searchParams.get('via');
    expect(via).toBe(copyInventoryReturnHref({ subjectId: id(10), cursor: 'c1' }, 'en'));
    await act(async () => router.navigate({ to: '/subject', search: { via } }));
    await tick();
    await clickLink('Return to inventory');
    expect(routeReads.at(-1)).toMatchObject({ subjectId: id(10), cursor: 'c1' });
    expect(host.textContent).toContain('Fresh return');
    expect(listReads.map((call) => call.data.cursor)).toEqual(['c1', 'c2', 'c2', 'c1', undefined, 'c1']);

    await clickLink(m.library_copy_more());
    expect(listReads.at(-1)?.data.cursor).toBe('c2');
    const restarted = inventory({ subjectId: id(10), cursor: 'c2' }, 1, 'Restarted first page');
    restarted.page = { ...restarted.page, cursorRestarted: true, next: 'after-restart' };
    await act(async () => listReads.at(-1)!.resolve(restarted));
    await tick();
    expect(host.textContent).toContain('Restarted first page');
    expect(hasLink(m.library_label_previous_page())).toBe(false);
    expect(hasLink(m.library_collections_first_page())).toBe(false);
  } finally {
    read.mockRestore();
    detail.mockRestore();
    release();
    await act(async () => root.unmount());
    router.history.destroy();
    client.clear();
    host.remove();
  }
});

test('The actual Copies route retires retained private rows and editor state on observed viewer replacement and fences originating detail lookup write and Undo continuations', async () => {
  const { createRoot, hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRouter, createRootRoute, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { Route } = await import('../src/routes/library/copies');
  const { requireSignedIn } = await import('../src/session/guard');
  const notices = await import('../src/library/copies-undo');
  const Page = Route.options.component!;
  expect(Route.options.beforeLoad).toBe(requireSignedIn);
  const lists: ReturnType<typeof deferred<CopiesCurrentRead>>[] = [];
  const listInputs: unknown[] = [];
  const details: (ReturnType<typeof deferred<CopyDetailCurrentRead>> & { data: unknown })[] = [];
  const editions: (ReturnType<typeof deferred<CopySubjectCurrentRead>> & { data: unknown })[] = [];
  const writes: (ReturnType<typeof deferred<CopyWriteResult>> & { input: Parameters<typeof actions.updateCopy>[0] })[] =
    [];
  const removals: (ReturnType<typeof deferred<CopyRemoveResult>> & {
    input: Parameters<typeof actions.deleteCopy>[0];
  })[] = [];
  const restores: (ReturnType<typeof deferred<CopyWriteResult>> & { input: Parameters<typeof actions.undoCopy>[0] })[] =
    [];
  const read = spyOn(actions, 'readCopiesCurrent').mockImplementation(({ data }) => {
    listInputs.push(data);
    const work = deferred<CopiesCurrentRead>();
    lists.push(work);
    return work.promise;
  });
  const detail = spyOn(actions, 'readCopyDetailCurrent').mockImplementation(({ data }) => {
    const work = { ...deferred<CopyDetailCurrentRead>(), data };
    details.push(work);
    return work.promise;
  });
  const edition = spyOn(actions, 'readCopySubjectCurrent').mockImplementation(({ data }) => {
    const work = { ...deferred<CopySubjectCurrentRead>(), data };
    editions.push(work);
    return work.promise;
  });
  const write = spyOn(actions, 'updateCopy').mockImplementation((input) => {
    const work = { ...deferred<CopyWriteResult>(), input };
    writes.push(work);
    return work.promise;
  });
  const create = spyOn(actions, 'createCopy').mockImplementation((input) => {
    const work = { ...deferred<CopyWriteResult>(), input };
    writes.push(work);
    return work.promise;
  });
  const remove = spyOn(actions, 'deleteCopy').mockImplementation((input) => {
    const work = { ...deferred<CopyRemoveResult>(), input };
    removals.push(work);
    return work.promise;
  });
  const restore = spyOn(actions, 'undoCopy').mockImplementation((input) => {
    const work = { ...deferred<CopyWriteResult>(), input };
    restores.push(work);
    return work.promise;
  });
  let retainedUndo: ComponentProps<typeof notices.UndoNotice>['restore'] | undefined;
  const NativeNotice = notices.UndoNotice;
  const notice = spyOn(notices, 'UndoNotice').mockImplementation((props) => {
    retainedUndo = props.restore;
    return <NativeNotice {...props} />;
  });
  let initial = response('A');
  let search: Search = { subjectId: id(10), cursor: 'first' };
  const loader = spyOn(Route, 'useLoaderData').mockImplementation(() => initial);
  const address = spyOn(Route, 'useSearch').mockImplementation(() => search);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let enrolledAdmission = true;
  const exposureLifetime = viewerExposureLifetime(client);
  const admitCurrent = () => {
    const snapshot = exposureLifetime.getSnapshot();
    if (snapshot.state === 'signed-in')
      client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
        subject: snapshot.observation.subject,
        admitted: enrolledAdmission ? ['personal_library'] : [],
      });
  };
  const releaseAdmission = exposureLifetime.subscribe(admitCurrent);
  // Foreign unpartitioned private data is never a fallback.
  client.setQueryData(['copies'], response('FOREIGN').page);
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/en/library/copies'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  let root: ReturnType<typeof createRoot> | undefined;
  const hydrationErrors: unknown[] = [];
  const tree = () => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <Page />
        </RouterContextProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  const viewer = (subject: string, csrfToken = `csrf-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
  const tick = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const show = async (session: { state: string; subject?: string; csrfToken: string | null }, admitted = true) => {
    await act(async () => {
      enrolledAdmission = admitted;
      client.setQueryData(['session'], session);
      admitCurrent();
      client.setQueryData(['exposure', 'anonymous'], []);
      if (!root) {
        const html = renderToString(tree());
        expect(html).toContain('Private note A');
        host.innerHTML = html;
        root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
      } else root.render(tree());
    });
    await tick();
  };
  const button = (label: string, region: ParentNode = host) => {
    const found = [...region.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
    expect(found).toBeDefined();
    return found!;
  };
  const click = (label: string, region: ParentNode = host) => act(async () => button(label, region).click());
  const form = () => host.querySelector<HTMLFormElement>('[role="dialog"] form')!;
  const submit = async (twice = false) =>
    act(async () => {
      const node = form();
      node.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      if (twice) node.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  const retainedSubmit = () => {
    const node = form();
    const key = Object.getOwnPropertyNames(button(m.library_copy_save(), node)).find((key) =>
      key.startsWith('__reactProps$'),
    )!;
    const props = Reflect.get(node, key) as {
      onSubmit: (event: { preventDefault(): void }) => Promise<void>;
    };
    expect(props.onSubmit).toBeFunction();
    return () => props.onSubmit({ preventDefault() {} });
  };
  const absent = (subject: string) => {
    for (const text of [
      `Private note ${subject}`,
      `Private location ${subject}`,
      `Private source ${subject}`,
      `Private edition ${subject}`,
    ])
      expect(document.body.textContent).not.toContain(text);
    expect([...host.querySelectorAll('a')].some((link) => link.href.includes(`next-${subject}`))).toBe(false);
  };
  const acceptList = async (subject: string) => {
    await act(async () => lists.at(-1)!.resolve(response(subject, search)));
    await tick();
  };
  const refetch = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: ['copies-current'], type: 'active' });
    });
  };
  const inspect = async (subject: string) => {
    await click(m.library_copy_edit());
    await act(async () =>
      details.at(-1)!.resolve({
        sessionSubject: subject,
        requested: response(subject, search).requested,
        id: id(1),
        result: { ok: true, copy: copy(subject) },
      }),
    );
  };
  const detailValue = (
    subject: string,
    result: CopyDetailCurrentRead['result'],
    requested = response(subject, search).requested,
  ): CopyDetailCurrentRead => ({ sessionSubject: subject, requested, id: id(1), result });
  const acceptDetail = async (
    result: CopyDetailCurrentRead['result'],
    subject = 'B',
    requested?: CopyDetailCurrentRead['requested'],
  ) => act(async () => details.at(-1)!.resolve(detailValue(subject, result, requested)));
  const fillNote = async (value: string) => {
    await click(m.library_copy_more(), form());
    const label = [...form().querySelectorAll('label')].find((label) => label.textContent === m.library_copy_note())!;
    const field = document.getElementById(label.htmlFor)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  try {
    await show(viewer('A'));
    expect(host.textContent).not.toContain('FOREIGN');
    search = { subjectId: id(10), cursor: 'opaque/cursor+exact' };
    await show(viewer('A'));
    await acceptList('A');
    await click(m.library_copy_compare_select());
    await click(m.library_copy_compare_open());
    expect(host.querySelectorAll('article[data-copy-comparison-id]')).toHaveLength(1);
    await inspect('A');
    await fillNote('Captured before list denial');
    await submit();
    const unanswered = writes.at(-1)!;
    const captured = unanswered.input.data;
    const capturedHeaders = new Headers(unanswered.input.headers);
    expect(captured).toEqual({
      id: id(1),
      revision: 7,
      idempotencyKey: id(101),
      location: 'Private location A',
      source: 'Private source A',
      acquiredOn: '2020-02-29',
      disposedOn: '2025-03-01',
      note: 'Captured before list denial',
    });
    await refetch();
    const countBeforeDenial = lists.length;
    await act(async () => lists.at(-1)!.resolve(forbiddenResponse('A', search)));
    await tick();
    absent('A');
    expect(host.textContent).toContain(m.library_copy_inventory_forbidden());
    expect(host.querySelectorAll('[data-slot="list-row"]')).toHaveLength(0);
    expect([...host.querySelectorAll('a')].some((node) => node.textContent === m.library_label_previous_page())).toBe(
      false,
    );
    expect(host.querySelectorAll('article[data-copy-comparison-id]')).toHaveLength(0);
    expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.library_copy_add())).toBe(false);
    expect(listInputs.at(-1)).toMatchObject(search);
    expect(lists).toHaveLength(countBeforeDenial);

    await act(async () => unanswered.reject(new Error('Uncertain before list denial')));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(m.library_copy_inventory_forbidden());
    await click(m.subject_view_retry(), dialog);
    const replay = writes.at(-1)!;
    expect(replay.input.data).toEqual(captured);
    expect(new Headers(replay.input.headers).get('x-csrf-token')).toBe(capturedHeaders.get('x-csrf-token'));
    await act(async () =>
      replay.resolve({ ok: true, copy: { ...copy('A'), note: 'Captured before list denial', revision: 8 } }),
    );
    await tick();
    expect(host.querySelectorAll('[data-slot="list-row"]')).toHaveLength(0);

    await click(m.subject_view_retry(), host);
    expect(listInputs.at(-1)).toMatchObject(search);
    await act(async () => lists.at(-1)!.resolve(response('A', search)));
    await tick();
    expect(host.textContent).toContain('Private note A');
    expect(host.querySelectorAll('[data-slot="list-row"]')).toHaveLength(1);
    for (const calls of [lists, listInputs, details, editions, writes]) calls.length = 0;
    search = { subjectId: id(10), cursor: 'first' };
    await show(viewer('A'));
    await acceptList('A');

    await click(m.library_copy_compare_select());
    await click(m.library_copy_compare_open());
    const comparisonTrigger = button(m.library_copy_compare_selected());
    const comparisonProps = Object.entries(button(m.library_copy_compare_close())).find(([key]) =>
      key.startsWith('__reactProps$'),
    )![1] as { onClick: () => void };
    expect(host.querySelectorAll('article[data-copy-comparison-id]')).toHaveLength(1);
    expect(details).toHaveLength(0);
    expect(editions).toHaveLength(0);
    expect(writes).toHaveLength(0);
    const oldInspect = Object.entries(button(m.library_copy_edit())).find(([key]) =>
      key.startsWith('__reactProps$'),
    )![1] as { onClick: () => void };
    await click(m.library_copy_edit());
    const oldDetail = details.at(-1)!;
    await refetch();
    await tick();
    const oldList = lists.at(-1)!;
    await show(viewer('B'));
    absent('A');
    expect(form()).toBeNull();
    await acceptList('B');
    expect(host.querySelectorAll('article[data-copy-comparison-id]')).toHaveLength(0);
    expect(comparisonTrigger.isConnected).toBe(false);
    await act(async () => comparisonProps.onClick());
    expect(document.activeElement).not.toBe(comparisonTrigger);
    const inspections = details.length;
    await act(async () => oldInspect.onClick());
    expect(details).toHaveLength(inspections);
    await click(m.library_copy_edit());
    await acceptDetail({ ok: false, reason: 'closed' });
    const closedEditor = host.querySelector('[role="dialog"]')!;
    expect(closedEditor.textContent).toContain(m.platform_closed_message());
    expect(closedEditor.querySelector('form')).toBeNull();
    await click(m.subject_view_retry(), closedEditor);
    await acceptDetail({ ok: true, copy: copy('B') });
    expect(form().textContent).toContain('Private note B');
    await submit(true);
    expect(writes).toHaveLength(1);
    await act(async () => {
      oldList.resolve(response('A'));
      oldDetail.resolve({
        sessionSubject: 'A',
        requested: response('A').requested,
        id: id(1),
        result: { ok: true, copy: copy('A') },
      });
    });
    absent('A');
    expect(button(m.library_copy_save(), form()).disabled).toBe(true);
    await act(async () => writes[0]!.resolve({ ok: true, copy: { ...copy('B'), revision: 8 } }));

    // Retain an originating write callback, then let B use the page while A's write is unresolved.
    await show(viewer('A'));
    await acceptList('A');
    expect(host.querySelectorAll('article[data-copy-comparison-id]')).toHaveLength(0);
    await act(async () => comparisonProps.onClick());
    expect(document.activeElement).not.toBe(comparisonTrigger);
    expect(button(m.library_copy_compare_select()).getAttribute('aria-pressed')).toBe('false');
    await inspect('A');
    const oldSubmit = retainedSubmit();
    await submit(true);
    const oldWrite = writes.at(-1)!;
    await show(viewer('B'));
    absent('A');
    await acceptList('B');
    await inspect('B');
    await fillNote(' Exact captured note.\n第二行 ');
    await submit(true);
    const uncertain = writes.at(-1)!;
    expect(uncertain.input.data).toEqual({
      id: id(1),
      revision: 7,
      idempotencyKey: id(101),
      location: 'Private location B',
      source: 'Private source B',
      acquiredOn: '2020-02-29',
      disposedOn: '2025-03-01',
      note: ' Exact captured note.\n第二行 ',
    });
    expect(new Headers(uncertain.input.headers).get('x-csrf-token')).toBe('csrf-B');
    await act(async () => {
      oldWrite.resolve({ ok: true, copy: { ...copy('A'), note: 'Obsolete successful write', revision: 8 } });
      await oldSubmit();
    });
    expect(writes.at(-1)).toBe(uncertain);
    expect(button(m.library_copy_save(), form()).disabled).toBe(true);
    expect(host.textContent).not.toContain('Obsolete successful write');
    await act(async () => uncertain.reject(new Error('Uncertain native outcome')));
    const originalForm = form();
    await show(viewer('B', 'rotated-csrf'));
    initial = response('B', search);
    initial.page.copies[0]!.revision = 99;
    initial.page.copies[0]!.idempotencyKey = id(999);
    await show(viewer('B', 'rotated-csrf'));
    await act(async () => lists.at(-1)!.resolve(initial));
    await tick();
    expect(form()).toBe(originalForm);
    const noteLabel = [...form().querySelectorAll('label')].find(
      (label) => label.textContent === m.library_copy_note(),
    )!;
    const noteField = document.getElementById(noteLabel.htmlFor)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
        noteField,
        'Edited after uncertainty',
      );
      noteField.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await submit(true);
    const retry = writes.at(-1)!;
    expect(retry.input.data).toEqual(uncertain.input.data);
    expect(new Headers(retry.input.headers).get('x-csrf-token')).toBe('csrf-B');
    await act(async () =>
      retry.resolve({ ok: true, copy: { ...copy('B'), note: ' Exact captured note.\n第二行 ', revision: 8 } }),
    );
    expect(form()).toBeNull();
    expect(host.textContent).toContain('Exact captured note.');

    // A late failure/finally cannot release a newer editor's lock or install its error.
    await show(viewer('A'));
    await acceptList('A');
    await inspect('A');
    await submit();
    const rejectedWrite = writes.at(-1)!;
    await show(viewer('B'));
    await acceptList('B');
    await inspect('B');
    await submit();
    const pendingB = writes.at(-1)!;
    await act(async () => rejectedWrite.reject(new Error('Obsolete failure')));
    expect(button(m.library_copy_save(), form()).disabled).toBe(true);
    expect(form().querySelector('[role="alert"]')).toBeNull();
    await act(async () => pendingB.resolve({ ok: true, copy: { ...copy('B'), revision: 8 } }));

    // Unknown, sign-out, admission and address replacement retire a draft and confirmation synchronously.
    await inspect('B');
    await click(m.library_copy_delete(), form());
    const retainedDelete = Object.entries(button(m.library_copy_delete_confirm(), form())).find(([key]) =>
      key.startsWith('__reactProps$'),
    )![1] as { onClick: () => void };
    await show({ state: 'unknown', csrfToken: null });
    absent('B');
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => retainedDelete.onClick());
    expect(removals).toHaveLength(0);
    await show({ state: 'signed-out', csrfToken: null });
    absent('B');
    await show(viewer('B'), false);
    absent('B');
    await show(viewer('B'));
    absent('B');
    await act(async () => lists.at(-1)!.resolve(response('A', search)));
    await tick();
    absent('A');
    absent('B');
    await refetch();
    await acceptList('B');
    await click(m.library_copy_edit());
    await act(async () =>
      details.at(-1)!.resolve({
        sessionSubject: 'A',
        requested: response('B', search).requested,
        id: id(1),
        result: { ok: true, copy: copy('A') },
      }),
    );
    absent('A');
    expect(form().textContent).toContain(m.library_copy_detail_unavailable());
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_edit());
    await acceptDetail({ ok: false, reason: 'closed' }, 'B', {
      ...response('B', search).requested,
      cursor: 'wrong-address',
    });
    expect(host.textContent).not.toContain(m.platform_closed_message());
    await click(m.library_copy_cancel(), form());
    await click(m.library_copy_edit());
    await act(async () =>
      details.at(-1)!.resolve({
        sessionSubject: 'B',
        requested: response('B', search).requested,
        id: id(1),
        result: { ok: true, copy: { ...copy('A', 2), note: 'Wrong detail id' } },
      }),
    );
    expect(host.textContent).not.toContain('Wrong detail id');
    await click(m.library_copy_cancel(), form());
    search = { cursor: 'other-page' };
    await show(viewer('B'));
    absent('B');
    await act(async () => lists.at(-1)!.resolve(response('B')));
    await tick();
    absent('B');
    await refetch();
    await acceptList('B');

    const priorFilterSearch: Search = {
      subjectId: id(10),
      kind: 'print',
      status: 'shelf',
      cursor: 'cursor-from-print',
    };
    search = priorFilterSearch;
    await show(viewer('B'));
    const delayedPriorFilter = lists.at(-1)!;
    search = { subjectId: id(10), kind: 'digital', status: 'shelf' };
    await show(viewer('B'));
    absent('B');
    const currentFilter = lists.at(-1)!;
    const currentFilterResponse = response('B', search);
    currentFilterResponse.page.copies[0]!.note = 'Current digital filter result';
    await act(async () => currentFilter.resolve(currentFilterResponse));
    await tick();
    expect(host.textContent).toContain('Current digital filter result');
    const staleFilterResponse = response('B', priorFilterSearch);
    staleFilterResponse.page.copies[0]!.note = 'Cross-filter cursor result';
    await act(async () => delayedPriorFilter.resolve(staleFilterResponse));
    await tick();
    expect(host.textContent).toContain('Current digital filter result');
    expect(host.textContent).not.toContain('Cross-filter cursor result');
    const next = [...host.querySelectorAll('a')].find((link) => link.textContent === m.library_copy_more());
    expect(next).toBeDefined();
    const nextAddress = new URL(next!.href);
    expect(nextAddress.searchParams.get('subjectId')).toBe(id(10));
    expect(nextAddress.searchParams.get('kind')).toBe('digital');
    expect(nextAddress.searchParams.get('status')).toBe('shelf');
    expect(nextAddress.searchParams.get('cursor')).toBe('next-B');

    // Explicit edition reads carry both source address and exact selected id; A IO never gates B.
    search = {};
    await show(viewer('A'));
    await acceptList('A');
    await click(m.library_copy_add());
    const choose = async (value: string) =>
      act(async () => {
        const select = form().querySelector('select[aria-label="Edition"]')! as HTMLSelectElement;
        select.value = value;
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    await choose(id(10));
    const oldEdition = editions.at(-1)!;
    const oldSelection = Object.entries(form().querySelector('select[aria-label="Edition"]')!).find(([key]) =>
      key.startsWith('__reactProps$'),
    )![1] as { onChange: (event: { currentTarget: { value: string } }) => void };
    await show(viewer('B'));
    await acceptList('B');
    await click(m.library_copy_add());
    await choose(id(11));
    const lookups = editions.length;
    await act(async () => oldSelection.onChange({ currentTarget: { value: id(11) } }));
    expect(editions).toHaveLength(lookups);
    await act(async () =>
      oldEdition.resolve({
        sessionSubject: 'A',
        requested: response('A', search).requested,
        id: id(10),
        result: { state: 'ready', subject: copy('A').subject!, profile },
      }),
    );
    expect(form().querySelector('button[type="submit"]')).toBeNull();
    const selectedSubject = { ...copy('B').subject!, id: id(11) };
    await act(async () =>
      editions.at(-1)!.resolve({
        sessionSubject: 'B',
        requested: { ...response('B', search).requested, locale: 'ja' },
        id: id(11),
        result: { state: 'ready', subject: selectedSubject, profile },
      }),
    );
    expect(form().querySelector('button[type="submit"]')).toBeNull();
    await choose(id(11));
    await act(async () =>
      editions.at(-1)!.resolve({
        sessionSubject: 'B',
        requested: response('B', search).requested,
        id: id(10),
        result: { state: 'ready', subject: selectedSubject, profile },
      }),
    );
    expect(form().querySelector('button[type="submit"]')).toBeNull();
    await choose(id(11));
    await act(async () =>
      editions.at(-1)!.resolve({
        sessionSubject: 'B',
        requested: response('B', search).requested,
        id: id(11),
        result: { state: 'ready', subject: selectedSubject, profile },
      }),
    );
    await submit(true);
    expect(writes.at(-1)!.input.data).toMatchObject({ subjectId: id(11), kind: 'print', status: 'shelf' });
    const pendingCreate = writes.at(-1)!;
    await show(viewer('A'));
    await acceptList('A');
    await act(async () => pendingCreate.reject(new Error('Retired create failure')));
    absent('B');

    // Real deletion/Undo callbacks retain immutable episode, CAS, key and originating lifetime.
    await inspect('A');
    await click(m.library_copy_delete(), form());
    await click(m.library_copy_delete_confirm(), form());
    expect(removals.at(-1)!.input.data).toEqual({ id: id(1), revision: 7, idempotencyKey: id(101) });
    const uncertainRemoval = removals.at(-1)!;
    await act(async () => uncertainRemoval.reject(new Error('Uncertain native deletion')));
    await click(m.library_copy_delete(), form());
    await click(m.library_copy_delete_confirm(), form());
    expect(removals.at(-1)!.input.data).toEqual(uncertainRemoval.input.data);
    await act(async () => removals.at(-1)!.resolve({ ok: true, undo: { deletionId: id(80), revision: 8 } }));
    const oldUndo = retainedUndo!;
    await click(m.editor_undo());
    const oldRestore = restores.at(-1)!;
    expect(oldRestore.input.data).toMatchObject({ id: id(1), deletionId: id(80), revision: 8 });
    await show(viewer('B'));
    await acceptList('B');
    await inspect('B');
    await click(m.library_copy_delete(), form());
    await click(m.library_copy_delete_confirm(), form());
    await act(async () => removals.at(-1)!.resolve({ ok: true, undo: { deletionId: id(81), revision: 8 } }));
    await click(m.editor_undo());
    const newRestore = restores.at(-1)!;
    await act(async () => {
      oldRestore.resolve({ ok: true, copy: copy('A') });
      await oldUndo(id(888));
    });
    absent('A');
    expect(restores.at(-1)).toBe(newRestore);
    expect(button(m.editor_undo()).disabled).toBe(true);
    await act(async () => newRestore.reject(new Error('Uncertain restore')));
    await show(viewer('B', 'rotated-undo-csrf'));
    await click(m.editor_undo());
    expect(restores.at(-1)!.input.data).toEqual(newRestore.input.data);
    expect(new Headers(restores.at(-1)!.input.headers).get('x-csrf-token')).toBe('rotated-undo-csrf');
    await act(async () => restores.at(-1)!.resolve({ ok: true, copy: { ...copy('B'), revision: 9 } }));
    expect(host.textContent).toContain('Private note B');
    await inspect('B');
    await submit();
    const signoutWrite = writes.at(-1)!;
    await show({ state: 'unavailable', csrfToken: null });
    absent('B');
    await act(async () => signoutWrite.resolve({ ok: true, copy: copy('B') }));
    absent('B');
    search = { subjectId: id(10), kind: 'old.print', status: 'retired', cursor: 'held-cursor' };
    initial = response('B', search);
    initial.page = { ...initial.page, copies: [], next: null, inventoryState: 'unavailable' };
    await show(viewer('B'));
    await act(async () => lists.at(-1)!.resolve(initial));
    expect(host.textContent).toContain(m.library_copy_inventory_unavailable());
    expect(host.textContent).not.toContain(m.library_copy_matching_empty());
    expect(host.querySelector<HTMLSelectElement>('[name="kind"]')!.value).toBe('old.print');
    expect(host.querySelector<HTMLSelectElement>('[name="status"]')!.value).toBe('retired');
    expect(
      [...host.querySelectorAll('a')].find((link) => link.textContent === m.library_copy_filter_reset())?.href,
    ).toContain(`subjectId=${id(10)}`);
    expect(hydrationErrors).toEqual([]);
  } finally {
    if (root) await act(async () => root!.unmount());
    releaseAdmission();
    client.clear();
    host.remove();
    for (const spy of [read, detail, edition, write, create, remove, restore, notice, loader, address])
      spy.mockRestore();
  }
  expect(names).toHaveBeenCalled();
  expect(released).toHaveBeenCalled();
});
