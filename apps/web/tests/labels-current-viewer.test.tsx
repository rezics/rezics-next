import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, useState, type ComponentProps } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { LabelsCurrentRead } from '../src/library/labels-read-route';
import type { LabelInput, LabelResult } from '../src/library/labels-read';
import type { MenuProps } from '@rezics/ui/menu';

// One focused mounted/deferred management journey. Controlled BFF responses exercise the actual
// route and handlers, not native authority or browser/visual proof.
const operations = [
  'personal_library',
  'library_label.list',
  'library_label.create',
  'library_label.rename',
  'library_label.delete',
];
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let actualSubject: string | undefined = 'A';
let preparations = 0;
const responseHeaders = new Headers();
const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  KERNEL_ORIGIN: 'https://kernel.test',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        preparations++;
        return {
          status: preparation,
          subject: actualSubject,
          accessToken: `secret-${actualSubject}`,
          csrfToken: `prepared-${actualSubject}`,
        };
      },
      // Deliberately differs from the successful preparation: this cannot supply old A's CSRF.
      signedIn: async () => ({ signedIn: true, subject: 'replacement', csrfToken: 'replacement-csrf' }),
    }),
  },
};
const request = () =>
  new Request('https://site.test/en/library/labels', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
function installRouteMocks() {
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => ({
    ...start,
    getRequest: () => currentRequest,
    setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
  }));
  mock.module('cloudflare:workers', () => ({ env }));
}
installRouteMocks();
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
type Search = { q?: string; cursor?: string };
function response(subject: string, search: Search = {}, revision = 7): LabelsCurrentRead {
  return {
    sessionSubject: subject,
    requested: { query: search.q ?? null, cursor: search.cursor ?? null, locale: 'en' },
    page: {
      signedIn: true,
      state: 'loaded',
      operations: [...operations],
      csrfToken: `prepared-${subject}`,
      ...(search.q === undefined ? {} : { query: search.q }),
      createKey: crypto.randomUUID(),
      undoKey: crypto.randomUUID(),
      next: `next-${subject}`,
      labels: [
        {
          id: `label-${subject}`,
          name: `Private ${subject}`,
          revision,
          renameKey: crypto.randomUUID(),
          deleteKey: crypto.randomUUID(),
        },
      ],
    },
  };
}

test('The actual private Labels route retires replaced-viewer names, dialogs, pending work and Undo while preserving exact current management intents', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library/labels' });
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
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: window.scrollTo.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    const reads = await import('../src/library/labels-read-route');
    const kernel = await import('../src/kernel/client');
    const { Route } = await import('../src/routes/library/labels');
    const { LABELS_WINDOW_QUERY_KEY, labelsWindowOwner } = await import('../src/library/labels-window-navigation');
    const { libraryWorkspaceAdmission } = await import('../src/library/library-workspace-admission');
    const { browserObservation } = await import('../src/session/observation');
    const { sessionQueryKey } = await import('../src/session/browser-state');
    const nativeCalls: Request[] = [];
    let failure: { status: number; code: string } | undefined;
    let admitted = [...operations];
    const client = createKernelClient('https://kernel.test', {
      fetch: (async (input, init) => {
        const call = new Request(input, init);
        nativeCalls.push(call);
        if (new URL(call.url).pathname === '/v1/platform/exposure') return Response.json({ admitted });
        return failure
          ? Response.json({ code: failure.code }, { status: failure.status })
          : Response.json({ labels: [{ id: 'label-A', name: 'Private A', revision: 7 }], next: 'opaque-next' });
      }) as typeof fetch,
    });
    const native = spyOn(kernel, 'kernelClient').mockReturnValue(client);
    try {
      const load = Route.options.loader as unknown as (input: {
        deps: { cursor?: string; query?: string };
      }) => Promise<{ kind: 'loaded'; result: LabelsCurrentRead }>;
      const routeData = await load({ deps: { cursor: 'exact+/cursor==', query: ' Private%_ ' } });
      expect(routeData).toMatchObject({
        kind: 'loaded',
        address: { valid: true, cursor: 'exact+/cursor==', query: ' Private%_ ' },
        result: {
          sessionSubject: 'A',
          requested: { cursor: 'exact+/cursor==', query: ' Private%_ ', locale: 'en' },
          page: { csrfToken: 'prepared-A', state: 'loaded', labels: [{ name: 'Private A' }] },
        },
      });
      const loaded = routeData.result;
      expect(preparations).toBe(1);
      const list = nativeCalls.find((call) => new URL(call.url).pathname === '/v1/libraryLabels')!;
      expect(new URL(list.url).searchParams.get('limit')).toBe('100');
      expect(new URL(list.url).searchParams.get('q')).toBe(' Private%_ ');
      expect(new URL(list.url).searchParams.get('cursor')).toBe('exact+/cursor==');
      expect(list.headers.get('authorization')).toBe('Bearer secret-A');
      expect(nativeCalls).toHaveLength(2);
      expect(responseHeaders.get('cache-control')).toBe('private, no-store');
      expect(responseHeaders.get('set-cookie')).toContain('Max-Age=0');
      expect(JSON.stringify(loaded)).not.toContain('secret-A');
      expect(await reads.readLabelsPage({ data: {} })).toMatchObject({
        signedIn: true,
        labels: [{ name: 'Private A' }],
      });

      const { prepareSession } = await import('../src/session/request');
      await prepareSession(currentRequest, env as never); // This original Request now retains A credentials.
      const before = nativeCalls.length;
      preparation = 'absent';
      expect(await reads.readLabelsCurrent({ data: { query: 'private' } })).toMatchObject({
        sessionSubject: null,
        requested: null,
        page: { signedIn: false, labels: [], operations: [], csrfToken: '', next: null },
      });
      preparation = 'unavailable';
      expect(await reads.readLabelsCurrent({ data: {} })).toMatchObject({
        sessionSubject: null,
        requested: null,
        page: { state: 'unavailable', labels: [] },
      });
      preparation = 'active';
      actualSubject = undefined;
      expect((await reads.readLabelsCurrent({ data: {} })).sessionSubject).toBeNull();
      actualSubject = 'A';
      currentRequest = new Request('https://site.test/en/library/labels', {
        headers: { authorization: 'Bearer browser-assertion' },
      });
      expect((await reads.readLabelsCurrent({ data: {} })).sessionSubject).toBeNull();
      currentRequest = new Request('https://site.test/en/library/labels');
      expect((await reads.readLabelsCurrent({ data: {} })).sessionSubject).toBeNull();
      expect(nativeCalls).toHaveLength(before);
      currentRequest = request();
      for (const [status, code, state] of [
        [404, 'not_found', 'denied'],
        [503, 'index_not_ready', 'preparing'],
        [503, 'dependency_unavailable', 'unavailable'],
      ] as const) {
        failure = { status, code };
        expect(await reads.readLabelsCurrent({ data: {} })).toMatchObject({
          sessionSubject: 'A',
          page: { state, labels: [] },
        });
      }
      failure = undefined;
      admitted = ['personal_library'];
      expect(await reads.readLabelsCurrent({ data: {} })).toMatchObject({
        sessionSubject: 'A',
        page: { state: 'closed', labels: [] },
      });
      expect(() => reads.readLabelsCurrent({ data: { cursor: 'x'.repeat(4097) } })).toThrow('Invalid label cursor');
      expect(() => reads.readLabelsPage({ data: { query: false } as never })).toThrow('Invalid label prefix');
    } finally {
      native.mockRestore();
    }

    const { createRoot, hydrateRoot } = await import('react-dom/client');
    const { renderToString } = await import('react-dom/server');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
    const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } =
      await import('@tanstack/react-router');
    const menu = await import('@rezics/ui/menu');
    const dialogs = await import('@rezics/ui/shadcn/dialog');
    const inputs = await import('@rezics/ui/shadcn/input');
    const notifications = await import('@rezics/ui/shadcn/toast');
    const { undoToast } = await import('@rezics/ui/undo-toast');
    const actions = await import('../src/library/labels-actions');
    const { m } = await import('../src/paraglide/messages.js');
    const menus: MenuProps[] = [];
    const fields: ComponentProps<typeof inputs.Input>[] = [];
    const dialogProps: ComponentProps<typeof dialogs.DialogContent>[] = [];
    const toastEntries: Parameters<typeof notifications.toast.add>[0][] = [];
    const OriginalMenu = menu.Menu;
    const OriginalInput = inputs.Input;
    const OriginalDialog = dialogs.DialogContent;
    const originalAdd = notifications.toast.add;
    const menuRead = spyOn(menu, 'Menu').mockImplementation((props) => {
      menus.push(props);
      return <OriginalMenu {...props} />;
    });
    const inputRead = spyOn(inputs, 'Input').mockImplementation((props) => {
      fields.push(props);
      return <OriginalInput {...props} />;
    });
    const dialogRead = spyOn(dialogs, 'DialogContent').mockImplementation((props) => {
      dialogProps.push(props);
      return <OriginalDialog {...props} />;
    });
    const toastRead = spyOn(notifications.toast, 'add').mockImplementation((props) => {
      toastEntries.push(props);
      return originalAdd(props);
    });
    const pendingReads: {
      data: Parameters<typeof reads.readLabelsCurrent>[0]['data'];
      work: ReturnType<typeof deferred<LabelsCurrentRead>>;
    }[] = [];
    const transport = spyOn(reads, 'readLabelsCurrent').mockImplementation((input) => {
      const work = deferred<LabelsCurrentRead>();
      pendingReads.push({ data: input.data, work });
      return work.promise;
    });
    const writes: { data: LabelInput; csrf: string | null; work: ReturnType<typeof deferred<LabelResult>> }[] = [];
    const write = spyOn(actions, 'manageLabel').mockImplementation((input) => {
      const work = deferred<LabelResult>();
      writes.push({ data: structuredClone(input.data), csrf: new Headers(input.headers).get('X-CSRF-Token'), work });
      return work.promise;
    });
    let search: Search = { q: 'Private', cursor: 'exact+/page==' };
    let initial = response('A', search);
    const loader = spyOn(Route, 'useLoaderData').mockImplementation(
      () =>
        ({
          kind: 'loaded',
          address: { valid: true, cursor: search.cursor ?? null, query: search.q ?? null },
          result: initial,
        }) as never,
    );
    const address = spyOn(Route, 'useSearch').mockImplementation(() => search);
    const Page = Route.options.component!;
    let rerenderRoute = () => {};
    function RouteView() {
      const [, setRevision] = useState(0);
      rerenderRoute = () => setRevision((revision) => revision + 1);
      return <Page />;
    }
    const router = createRouter({
      routeTree: createRootRoute({ component: RouteView }),
      history: createMemoryHistory({ initialEntries: ['/en/library/labels'] }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const observation = browserObservation(queryClient);
    const stopObservation = observation.subscribeCache(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    let root: ReturnType<typeof createRoot> | undefined;
    const hydrationErrors: unknown[] = [];
    const tree = () => (
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <notifications.Toaster>
            <RouterProvider router={router} />
          </notifications.Toaster>
        </QueryClientProvider>
      </StrictMode>
    );
    const session = (subject: string, csrfToken = `session-${subject}`) => ({ state: 'signed-in', subject, csrfToken });
    const show = async (
      viewer: { state: string; subject?: string; csrfToken: string | null },
      admitted = operations,
      reuseSession = false,
    ) => {
      menus.length = 0;
      await act(async () => {
        const currentSession = queryClient.getQueryData<typeof viewer>(sessionQueryKey);
        if (
          !reuseSession ||
          currentSession?.state !== viewer.state ||
          currentSession?.subject !== viewer.subject ||
          currentSession?.csrfToken !== viewer.csrfToken
        )
          queryClient.setQueryData(sessionQueryKey, viewer);
        const current = observation.getSnapshot();
        if (current.state === 'signed-in')
          queryClient.setQueryData(viewerExposureQuery(current.observation).queryKey, {
            subject: current.observation.subject,
            admitted,
          });
        if (!root) {
          const html = renderToString(tree());
          expect(html).toContain('Private A');
          expect(html).toContain('name="csrf_token" value="prepared-A"');
          host.innerHTML = html;
          root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
        } else {
          rerenderRoute();
          root.render(tree());
        }
      });
    };
    const settleRead = async (index: number, value: LabelsCurrentRead) => {
      await act(async () => pendingReads[index]!.work.resolve(value));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const settleWrite = async (index: number, value: LabelResult | Error) => {
      await act(async () =>
        value instanceof Error ? writes[index]!.work.reject(value) : writes[index]!.work.resolve(value),
      );
    };
    const select = (operation: 'rename' | 'delete') => {
      const entry = menus
        .flatMap((props) => props.entries ?? [])
        .findLast(
          (entry) =>
            (entry.type === 'item' || entry.type === 'destructive') &&
            entry.label === (operation === 'rename' ? m.library_label_rename() : m.library_label_delete()),
        );
      if (!entry || (entry.type !== 'item' && entry.type !== 'destructive'))
        throw new Error(`Missing ${operation} action`);
      return entry.onSelect!;
    };
    const changeName = async (value: string) => {
      const field = fields.findLast((field) => field.name === 'name' && field.onChange);
      if (!field?.onChange) throw new Error('Missing actual controlled rename input');
      await act(async () => field.onChange!({ target: { value } } as never));
    };
    const submit = async (operation: LabelInput['operation']) => {
      const form = [...document.querySelectorAll('form')].find((form) =>
        form.querySelector(`input[name="operation"][value="${operation}"]`),
      );
      if (!form) throw new Error(`Missing actual ${operation} form`);
      await act(async () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    };
    const retired = (subject: string) => {
      expect(document.body.textContent).not.toContain(`Private ${subject}`);
      expect(document.querySelector(`a[href*="label-${subject}"]`)).toBeNull();
      expect(document.querySelector(`a[href*="next-${subject}"]`)).toBeNull();
    };
    const busy = () =>
      expect(
        host.querySelector('input[name="operation"][value="create"]')!.closest('form')!.querySelector('button')!
          .disabled,
      ).toBe(true);
    const refetch = async () => {
      await act(async () => {
        void queryClient.refetchQueries({ queryKey: ['labels-current'], type: 'active' });
      });
    };
    try {
      await router.load();
      await show(session('A'));
      expect(pendingReads).toHaveLength(0); // Genuine loader provenance hydrates without an added read.
      const labelsAdmission = libraryWorkspaceAdmission(queryClient, [
        'library_label.list',
        'library_label.create',
        'library_label.rename',
        'library_label.delete',
      ]);
      const admittedA = labelsAdmission.read();
      const retainedA = {
        visitId: 'A-before-replacement',
        owner: labelsWindowOwner(queryClient, {
          locale: 'en',
          query: search.q ?? null,
          source: reads.readLabelsCurrent,
          viewer: admittedA.viewer,
          listEpoch: admittedA.dispatch[0]!,
        }),
        path: [null, 'A-cursor-one', 'A-cursor-two'],
        staged: null,
      };
      queryClient.setQueryData(LABELS_WINDOW_QUERY_KEY, retainedA);
      await act(async () => select('rename')());
      const oldSelect = select('delete');
      const oldFocus = dialogProps.at(-1)!.finalFocus as () => unknown;
      const oldField = fields.findLast((field) => field.name === 'name' && field.onChange)!;
      expect(dialogProps.at(-1)!.className).toContain('overflow-y-auto');
      expect(document.querySelector('[role="dialog"] button[type="submit"]')!.className).toContain('min-h-11');
      await changeName('Changed A');
      await submit('rename');
      expect(writes[0]).toMatchObject({
        data: {
          operation: 'rename',
          id: 'label-A',
          name: 'Changed A',
          revision: 7,
          idempotencyKey: initial.page.labels[0]!.renameKey,
        },
        csrf: 'session-A',
      });
      await show(session('B'));
      expect(queryClient.getQueryData(LABELS_WINDOW_QUERY_KEY)).toBeUndefined();
      retired('A');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(host.querySelector('input[name="q"]')).toBeNull();
      expect(oldFocus()).toBe(false);
      await act(async () => oldSelect());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await settleRead(0, response('B', search));
      expect(host.textContent).toContain('Private B');
      await act(async () => select('rename')());
      await changeName('B draft');
      await submit('rename');
      busy();
      await act(async () => oldField.onChange!({ target: { value: 'Retired A draft' } } as never));
      expect((document.querySelector('[role="dialog"] input[name="name"]') as HTMLInputElement).value).toBe('B draft');
      await settleWrite(0, { ok: true }); // A success/finally cannot refresh B or release B's lock/dialog.
      expect(pendingReads).toHaveLength(1);
      busy();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await settleWrite(1, new Error('Uncertain B write'));
      const uncertain = writes[1]!.data;
      initial = response('B', search, 19);
      initial.page.csrfToken = 'prepared-B-rotated';
      await show(session('B', 'session-B-rotated'));
      expect((document.querySelector('[role="dialog"] input[name="name"]') as HTMLInputElement).value).toBe('B draft');
      await submit('rename');
      expect(writes[2]!.data).toEqual(uncertain);
      expect(writes[2]!.csrf).toBe('session-B');
      initial = response('B', search, 23);
      await show(session('B', 'another-nonempty-csrf'));
      busy(); // Ordinary same-viewer loader/CSRF refresh preserves the outstanding attempt.
      await settleWrite(2, { ok: false, reason: 'conflict' });
      expect(pendingReads).toHaveLength(1); // The retired response cannot launch a fresh read.
      await submit('rename'); // Retry only after the replacement origin has admitted the same owner again.
      expect(writes[3]!.data).toEqual(uncertain);
      expect(writes[3]!.csrf).toBe('session-B');
      await settleWrite(3, { ok: false, reason: 'conflict' });
      expect(pendingReads[1]!.data).toEqual({ cursor: search.cursor, query: search.q });
      await settleRead(1, response('B', search, 24));
      expect(
        (document.querySelector('[role="dialog"] input[name="library_label_revision"]') as HTMLInputElement).value,
      ).toBe('7');
      await act(async () => {
        const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
          (button) => button.textContent === m.action_cancel(),
        )!;
        (cancel as HTMLButtonElement).click();
      });
      await act(async () => {
        const discard = [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (button) => button.textContent === m.library_label_draft_navigation_discard(),
        )!;
        (discard as HTMLButtonElement).click();
      });
      await act(async () => select('rename')());
      await changeName('Changed B draft');
      await submit('rename');
      expect(writes[4]!.data.name).toBe('Changed B draft');
      expect(writes[4]!.data.idempotencyKey).not.toBe(uncertain.idempotencyKey);
      expect(writes[4]!.data.revision).toBe(24);
      await settleWrite(4, { ok: true });
      await settleRead(2, response('B', search, 25));
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => select('delete')());
      expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
        m.library_label_delete_confirmation({ name: 'Private B' }),
      );
      const deleteKey = (document.querySelector('[role="dialog"] input[name="idempotencyKey"]') as HTMLInputElement)
        .value;
      await submit('delete');
      expect(writes[5]!.data).toEqual({
        operation: 'delete',
        id: 'label-B',
        revision: 25,
        name: 'Private B',
        idempotencyKey: deleteKey,
      });
      await settleWrite(5, { ok: true, revision: 73 }); // Keep A/B refresh IO pending while C starts using its route.
      await show(session('C'));
      retired('B');
      await settleRead(4, response('C', search));
      await act(async () => select('rename')());
      await submit('rename');
      busy();
      await settleRead(3, response('B', search));
      retired('B');
      busy();
      expect(toastEntries).toHaveLength(0);
      await show(session('D'));
      retired('C');
      await settleRead(5, response('D', search));
      await act(async () => select('rename')());
      await submit('rename');
      await settleWrite(6, new Error('Retired C failure'));
      busy();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      await settleWrite(7, { ok: false, reason: 'conflict' });
      await settleRead(6, response('D', search));
      await act(async () => {
        const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
          (button) => button.textContent === m.action_cancel(),
        )!;
        (cancel as HTMLButtonElement).click();
      });
      await act(async () => select('delete')());
      await submit('delete');
      const deleteInput = writes[8]!.data;
      expect(deleteInput).toMatchObject({ operation: 'delete', id: 'label-D', revision: 7, name: 'Private D' });
      await settleWrite(8, { ok: true, revision: 91 });
      const deleted = response('D', search);
      deleted.page.labels = [];
      await settleRead(7, deleted);
      const undo = toastEntries.at(-1)!;
      expect(undo.title).toBe(m.library_label_deleted({ name: 'Private D' }));
      const restoreForm = host.querySelector('input[name="operation"][value="restore"]')!.closest('form')!;
      const undoKey = (restoreForm.querySelector('input[name="idempotencyKey"]') as HTMLInputElement).value;
      await act(async () => undo.actionProps!.onClick!({} as never));
      expect(writes[9]!.data).toEqual({ operation: 'restore', id: 'label-D', revision: 91, idempotencyKey: undoKey });
      await settleWrite(9, { ok: true, revision: 92 });
      await settleRead(8, response('D', search, 92));
      expect(host.querySelector('input[name="operation"][value="restore"]')).toBeNull();
      await act(async () => select('delete')());
      await submit('delete');
      await settleWrite(10, { ok: true, revision: 93 });
      await settleRead(9, deleted);
      const retiredUndo = toastEntries.at(-1)!;
      await act(async () => {
        notifications.toast.add({ id: 'unrelated-label-test', title: 'Unrelated work', timeout: 0 });
      });
      await show(session('E'));
      retired('D');
      expect(document.body.textContent).toContain('Unrelated work');
      await settleRead(10, response('E', search));
      const beforeUndo = writes.length;
      await act(async () => retiredUndo.actionProps!.onClick!({} as never));
      expect(writes).toHaveLength(beforeUndo);
      expect(host.textContent).toContain('Private E');

      await act(async () => select('rename')());
      await show({ state: 'unknown', csrfToken: null });
      retired('E');
      expect(host.querySelector('[role="dialog"] input[name="name"]')).toBeNull();
      await show({ state: 'signed-out', csrfToken: null });
      retired('E');
      expect(host.textContent).toContain(m.library_sign_in());
      await show(session('F'));
      await settleRead(11, response('F', search));
      search = { q: 'other query', cursor: 'other+/cursor==' };
      await show(session('F'));
      retired('F');
      await settleRead(12, response('F', { ...search, q: 'wrong query' }));
      retired('F');
      await refetch();
      await settleRead(13, response('F', { ...search, cursor: 'wrong cursor' }));
      retired('F');
      await refetch();
      await settleRead(14, response('A', search));
      retired('A');
      retired('F');
      await refetch();
      const wrongLocale = response('F', search);
      wrongLocale.requested!.locale = 'ja';
      await settleRead(15, wrongLocale);
      retired('F');
      await refetch();
      await settleRead(16, response('F', search));
      expect(host.textContent).toContain('Private F');
      await act(async () => select('rename')());
      await submit('rename');
      await settleWrite(11, { ok: true });
      await settleRead(17, response('F', { ...search, cursor: 'wrong refresh cursor' }));
      retired('F');
      await show(
        session('F'),
        operations.filter((operation) => operation !== 'personal_library'),
      );
      retired('F');
      await show(session('F'), ['personal_library', 'library_label.list'], true);
      retired('F');
      const retry = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === m.subject_view_retry(),
      );
      expect(retry).toBeDefined();
      await act(async () => (retry as HTMLButtonElement).click());
      await settleRead(18, response('F', search));
      expect(host.textContent).toContain('Private F');
      expect(host.querySelector('input[name="operation"]')).toBeNull();
      expect(host.querySelector('input[name="q"]')!.getAttribute('value')).toBe(search.q!);

      search = { q: '  Private %_ + & ?  ', cursor: 'exact+/native-rejected==' };
      const rejectedRead = pendingReads.length;
      await show(session('F'));
      expect(pendingReads).toHaveLength(rejectedRead + 1);
      const rejected = response('F', search);
      rejected.page.state = 'unavailable';
      rejected.page.labels = [];
      rejected.page.next = null;
      rejected.page.feedback = {
        ok: false,
        reason: 'invalid_cursor',
        undo: { id: 'label-F', name: 'Original deleted name', revision: 52 },
        undoKey: 'original-native-undo-key',
      };
      await settleRead(rejectedRead, rejected);
      expect(host.textContent).toContain(m.library_labels_invalid_cursor());
      expect(host.textContent).not.toContain('Private F');
      expect(host.querySelector('input[name="operation"][value="create"]')).toBeNull();
      const recovery = [...host.querySelectorAll('button')].find(
        (button) => button.textContent === m.library_collections_first_page(),
      );
      expect(recovery).toBeDefined();
      const undoForm = [...host.querySelectorAll('form')].find((form) =>
        form.querySelector('input[name="operation"][value="restore"]'),
      )!;
      expect((undoForm.querySelector('input[name="undoId"]') as HTMLInputElement).value).toBe('label-F');
      expect((undoForm.querySelector('input[name="undoName"]') as HTMLInputElement).value).toBe(
        'Original deleted name',
      );
      expect((undoForm.querySelector('input[name="undoRevision"]') as HTMLInputElement).value).toBe('52');
      expect((undoForm.querySelector('input[name="undoKey"]') as HTMLInputElement).value).toBe(
        'original-native-undo-key',
      );
      expect(pendingReads).toHaveLength(rejectedRead + 1);

      initial = response('A', search); // A newly replaced loader also cannot keep a previously accepted F page.
      await show(session('F'), ['personal_library', 'library_label.list']);
      retired('A');
      retired('F');
      await show({ state: 'signed-in', subject: 'F', csrfToken: null });
      retired('F');
      await show({ state: 'signed-in', csrfToken: 'nonempty-but-no-subject' });
      retired('F');

      await show(session('G'));
      await settleRead(pendingReads.length - 1, response('G', search));
      await act(async () => select('rename')());
      await changeName('G first draft');
      const firstDraft = writes.length;
      await submit('rename');
      await settleWrite(firstDraft, new Error('Uncertain first draft'));
      await changeName('G changed draft');
      await submit('rename');
      expect(writes[firstDraft + 1]!.data).toEqual(writes[firstDraft]!.data);
      await settleWrite(firstDraft + 1, new Error('Uncertain changed draft'));
      await submit('rename');
      expect(writes[firstDraft + 2]!.data).toEqual(writes[firstDraft + 1]!.data);
      await settleWrite(firstDraft + 2, new Error('Still uncertain'));
      await act(async () => {
        const cancel = [...document.querySelectorAll('[role="dialog"] button')].find(
          (button) => button.textContent === m.action_cancel(),
        )!;
        (cancel as HTMLButtonElement).click();
      });
      await act(async () => {
        const discard = [...document.querySelectorAll('[role="alertdialog"] button')].find(
          (button) => button.textContent === m.library_label_draft_navigation_discard(),
        )!;
        (discard as HTMLButtonElement).click();
      });
      await act(async () => select('delete')());
      const finalDelete = writes.length;
      await submit('delete');
      await settleWrite(finalDelete, { ok: true, revision: 94 });
      const deletedG = response('G', search);
      deletedG.page.labels = [];
      await settleRead(pendingReads.length - 1, deletedG);
      let unrelatedUndos = 0;
      await act(async () => {
        undoToast('Another journey Undo', () => {
          unrelatedUndos++;
        });
      });
      const unrelatedUndo = toastEntries.at(-1)!;
      await show({ state: 'signed-out', csrfToken: null });
      retired('G');
      // The shared Undo ID now belongs to another journey; retiring G must leave it usable.
      expect(unrelatedUndo.title).toBe('Another journey Undo');
      await act(async () => unrelatedUndo.actionProps!.onClick!({} as never));
      expect(unrelatedUndos).toBe(1);
      await act(async () => queryClient.setQueryData(sessionQueryKey, session('B')));
      expect(queryClient.getQueryData(LABELS_WINDOW_QUERY_KEY)).toBeUndefined();
      await act(async () => queryClient.setQueryData(sessionQueryKey, session('A')));
      expect(queryClient.getQueryData(LABELS_WINDOW_QUERY_KEY)).toBeUndefined();
      expect(hydrationErrors).toEqual([]);
    } finally {
      if (root) await act(async () => root!.unmount());
      stopObservation();
      queryClient.clear();
      host.remove();
      for (const restore of [menuRead, inputRead, dialogRead, toastRead, transport, write, loader, address])
        restore.mockRestore();
    }
  } finally {
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
