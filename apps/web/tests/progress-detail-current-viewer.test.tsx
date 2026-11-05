import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import type { SessionEnv } from '../src/session/client';
import type { ProgressDetail, ProgressDetailAddress } from '../src/library/progress-detail-server';
import type { NativeProgressSession } from '../src/library/progress-reads';
import type { EpisodeLoad } from '../src/library/episode-checklist/load';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/progress/current', width: 1280, height: 900 });
window.document.head.innerHTML = '<link rel="canonical" href="https://site.test/en/library/progress/current">';
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
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
const address: ProgressDetailAddress = {
  id: id(20),
  changes: 'changes/opaque+==',
  units: 'units/opaque+==',
  logs: 'logs/opaque+==',
};
const stamp = '2026-04-02T15:04:05.000Z';
const token = (owner: string) => `${owner}${'a'.repeat(21)}`;
type Viewer = {
  state: 'signed-in' | 'signed-out' | 'unknown' | 'unavailable';
  subject?: string;
  csrfToken: string | null;
};
const viewer = (subject = 'A', csrfToken = token(subject)): Viewer => ({ state: 'signed-in', subject, csrfToken });
function detail(owner = 'A', at = address, revision = 7): Extract<ProgressDetail, { state: 'ready' }> {
  return {
    state: 'ready',
    viewer: owner,
    address: { ...at },
    progress: {
      signedIn: true,
      idempotencyKey: crypto.randomUUID(),
      changesCursor: at.changes,
      unitsCursor: at.units,
      session: {
        id: at.id,
        subjectId: id(1),
        versionSubjectId: null,
        subject: { id: id(1), type: 'book', types: ['book'], label: `Private ${owner}`, cover: null },
        versionSubject: null,
        mode: 'scalar_amount',
        unit: 'page',
        unitLabel: 'pages',
        meaning: 'known',
        recordingState: 'supported',
        inputRules: { min: '0', max: '100', step: '0.01', total: 'optional' },
        total: '100',
        amount: '2.5',
        locator: null,
        position: null,
        completedUnitCount: 1,
        state: 'active',
        revision,
        startedAt: stamp,
        completedAt: null,
        units: [`${owner}:sparse~9`],
        unitsNext: 'next-units',
        changes: [
          {
            id: 'change',
            revision,
            createdAt: stamp,
            action: null,
            amount: '2.5',
            locator: `${owner}:history`,
            position: null,
            add: [],
            remove: [],
          },
        ],
        changesNext: 'next-changes',
      },
    },
    logs: {
      signedIn: true,
      next: 'next-logs',
      logs: [
        {
          id: `public-${owner}`,
          sessionState: 'active',
          startedAt: stamp,
          completedAt: null,
          publishedAt: stamp,
          note: `Public snapshot ${owner}`,
          subject: null,
          account: { handle: owner, displayName: owner },
        },
      ],
    },
  };
}
function native(p = detail()): NativeProgressSession {
  return {
    ...p.progress.session,
    presentation: {
      meaning: 'known',
      structure: 'unverified',
      unitLabel: 'pages',
      recording: {
        state: 'supported',
        inputRules: { min: '0', max: '100', step: '0.01', total: 'optional' },
      },
    },
  };
}
let current = viewer();
let request = new Request('https://site.test/en/library/progress/current');
function requestFor(method = 'GET') {
  return new Request(request.url, {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.test',
      'x-csrf-token': current.csrfToken ?? '',
    },
  });
}
type Credential =
  | { status: 'active'; subject: string; accessToken: string; csrfToken: string }
  | { status: 'absent' | 'unavailable'; csrfToken?: string };
let preparations: Credential[] = [];
let prepared = 0;
const env: Partial<SessionEnv> = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => {
        prepared++;
        return (
          preparations.shift() ?? {
            status: 'active',
            subject: current.subject!,
            accessToken: current.subject!,
            csrfToken: current.csrfToken!,
          }
        );
      },
    }),
  } as unknown as SessionEnv['SESSIONS'],
};
const nativeReads: Request[] = [];
const writes: { request: Request; body: unknown; work: ReturnType<typeof deferred<Response>> }[] = [];
let readFailure: Response | null = null;
let listFailure: Response | null = null;
const client = createKernelClient('https://kernel.test', {
  fetch: async (input, init) => {
    const call = new Request(input, init);
    if (call.method === 'POST') {
      const work = deferred<Response>();
      writes.push({ request: call, body: await call.json(), work });
      return work.promise;
    }
    nativeReads.push(call);
    const url = new URL(call.url);
    if (readFailure && url.pathname !== '/v1/publishedLogs') return readFailure.clone();
    if (listFailure && url.pathname === '/v1/publishedLogs') return listFailure.clone();
    const owner = call.headers.get('authorization')!.replace('Bearer ', '');
    const p = detail(owner);
    if (url.pathname.endsWith('/changes')) return Response.json({ changes: [], next: 'changes-next' });
    if (url.pathname.endsWith('/completedUnits'))
      return Response.json({ completedUnits: [`${owner}:unit`], next: null });
    if (url.pathname === '/v1/publishedLogs') return Response.json({ publishedLogs: [], next: 'logs-next' });
    return Response.json({ progressSession: native(p) });
  },
});
const named: unknown[][] = [];
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({ ...start, getRequest: () => request }));
mock.module('../src/kernel/client', () => ({ kernelClient: () => client, requestLocale: () => 'en' }));
mock.module('../src/subject/definitions', () => ({
  nameSubjectTypes: async (subjects: unknown[]) => {
    named.push(subjects);
  },
  readRelease: async () => {
    throw new Error('No definition hydration belongs in this read');
  },
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'x-csrf-token': current.csrfToken ?? '' }) }));
const { readyVisit } = await import('../src/library/episode-checklist/controller');
const { emptyChecklistWork } = await import('../src/library/episode-checklist/cost');
mock.module('../src/library/episode-checklist/server', () => ({
  loadCanonicalEpisodeChecklist: async ({
    data,
  }: {
    data: { viewer: string; locale: string; subjectId: string; sessionId: string; revision: number };
  }): Promise<EpisodeLoad> => ({
    state: 'ready',
    work: emptyChecklistWork(),
    membership: { state: 'admitted', candidates: [], next: null, stream: 'inverse:schema:isPartOf' },
    visit: readyVisit(data, [], { membership: 'empty' }),
  }),
  inspectCanonicalEpisodes: () => {
    throw new Error('History is not a canonical episode operand');
  },
  continueCanonicalEpisodes: () => {
    throw new Error('History is not a canonical episode operand');
  },
  recordCanonicalEpisodes: () => {
    throw new Error('History is not a canonical episode operand');
  },
}));
const detailModule = await import('../src/library/progress-detail-server');
const actualDetail = detailModule.readProgressDetail;
const { prepareSession } = await import('../src/session/request');
const { CurrentProgressDetail } = await import('../src/library/progress-session');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
notifyManager.setScheduler(queueMicrotask);
afterAll(() => notifyManager.setScheduler((callback) => setTimeout(callback, 0)));
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterContextProvider, RouterProvider } =
  await import('@tanstack/react-router');
const { within, userEvent } = await import('storybook/test');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
const { progressReturnLocationState } = await import('../src/library/progress-start-draft-navigation');
setLocale('en', { reload: false });
const settle = async (action: () => void) =>
  act(async () => {
    action();
  });

async function mount(initial = detail(), hydrate = false, observed = viewer(initial.viewer), routed = false) {
  preparations = [];
  prepared = 0;
  nativeReads.length = writes.length = 0;
  readFailure = listFailure = null;
  current = observed;
  request = requestFor('POST');
  const reads: { data: ProgressDetailAddress; work: ReturnType<typeof deferred<ProgressDetail>> }[] = [];
  const read = spyOn(detailModule, 'readProgressDetail').mockImplementation(({ data }) => {
    const work = deferred<ProgressDetail>();
    reads.push({ data: { ...data }, work });
    return work.promise;
  });
  const navigation: string[] = [];
  const navigate = spyOn(window.location, 'assign').mockImplementation((url) => {
    navigation.push(String(url));
  });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], current);
  cache.setQueryData(['exposure', 'viewer'], ['reading_progress']);
  cache.setQueryData(['exposure', 'anonymous'], ['reading_progress']);
  let operations = ['reading_progress'];
  const lifetime = viewerExposureLifetime(cache);
  const expose = () => {
    const state = lifetime.getSnapshot();
    if (state.state === 'signed-in')
      cache.setQueryData(viewerExposureQuery(state.observation).queryKey, {
        subject: state.observation.subject,
        admitted: operations,
      });
  };
  const releaseExposure = lifetime.subscribe(expose);
  expose();
  const route = createRootRoute();
  let loaders = 0;
  const { Route } = await import('../src/routes/library/progress.$id');
  const routedDetail = Route.update({
    getParentRoute: () => route,
    path: '/library/progress/$id',
    id: '/library/progress/$id',
    beforeLoad: async () => {},
    loader: async () => {
      loaders++;
      return initial;
    },
  });
  const router = createRouter({
    routeTree: routed
      ? route.addChildren([
          routedDetail,
          createRoute({
            getParentRoute: () => route,
            path: '/library/progress',
            component: () => <p>Progress index</p>,
          }),
        ])
      : route,
    history: createMemoryHistory({
      initialEntries: [
        routed
          ? `/library/progress/${initial.address.id}?${new URLSearchParams(Object.entries(initial.address).filter(([key, value]) => key !== 'id' && value !== undefined) as [string, string][])}&history=%2Flibrary%2Fhistory%3Fcursor%3Doriginal%252F%252B%253D%253D#facts`
          : `/?${new URLSearchParams(Object.entries(initial.address).filter(([key, value]) => key !== 'id' && value !== undefined) as [string, string][])}`,
      ],
    }),
  });
  if (routed)
    router.history.replace(
      router.history.location.href,
      progressReturnLocationState({
        indexHref: '/en/library/progress?state=active&cursor=return%2F%2B%3D%3D',
        indexSearch: { state: 'active', cursor: 'return/+==' },
        locale: 'en',
        sessionId: initial.progress.session.id,
        subjectId: initial.progress.session.subjectId,
        startedAt: initial.progress.session.startedAt,
      }) as never,
    );
  await router.load();
  const host = document.createElement('div');
  document.body.append(host);
  let root: ReturnType<typeof createRoot>;
  let loaded: ProgressDetail = initial;
  let at = address;
  const tree = (visible = true) => (
    <StrictMode>
      <QueryClientProvider client={cache}>
        {routed ? (
          <RouterProvider router={router} />
        ) : (
          <RouterContextProvider router={router}>
            {visible && <CurrentProgressDetail loaded={loaded} address={at} />}
          </RouterContextProvider>
        )}
      </QueryClientProvider>
    </StrictMode>
  );
  const hydrationErrors: unknown[] = [];
  let html = '';
  await act(async () => {
    if (hydrate) {
      html = renderToString(tree());
      host.innerHTML = html;
      root = hydrateRoot(host, tree(), { onRecoverableError: (error) => hydrationErrors.push(error) });
    } else {
      root = createRoot(host);
      root.render(tree());
    }
  });
  const show = async (
    options: {
      session?: Viewer;
      page?: ProgressDetail;
      address?: ProgressDetailAddress;
      admitted?: boolean;
      visible?: boolean;
    } = {},
  ) =>
    act(async () => {
      if (options.session) {
        current = options.session;
        request = requestFor('POST');
        cache.setQueryData(['session'], current);
        expose();
      }
      if (options.page) loaded = options.page;
      if (options.address) at = options.address;
      if (options.admitted !== undefined) {
        operations = options.admitted ? ['reading_progress'] : [];
        expose();
      }
      root.render(tree(options.visible ?? true));
    });
  const body = within(document.body);
  const user = userEvent.setup({ document });
  const click = async (label: string) =>
    act(async () => {
      await user.click(body.getByRole('button', { name: label, exact: true }));
      if (label === m.library_progress_record())
        await user.click(body.getByRole('button', { name: m.library_progress_confirm_correction(), exact: true }));
    });
  const field = (label: string) => body.getByLabelText(label) as HTMLInputElement;
  const fill = async (label: string, value: string) => {
    await act(async () => user.clear(field(label)));
    for (const character of value) await act(async () => user.type(field(label), character));
  };
  const record = async (value = '4.75') => {
    await click(m.library_progress_update());
    await fill(m.library_progress_amount(), value);
    await click(m.library_progress_record());
  };
  const publish = async (note: string) => {
    await fill(m.library_logs_publish_note(), note);
    await click(m.library_logs_publish());
  };
  const resolveRead = async (p: ProgressDetail, index = reads.length - 1) =>
    settle(() => reads[index]!.work.resolve(p));
  const absent = (owner = 'A') => {
    expect(document.body.textContent).not.toContain(`Private ${owner}`);
    expect(document.body.textContent).not.toContain(`${owner}:sparse~9`);
    expect(document.body.textContent).not.toContain(`${owner}:history`);
    expect(document.body.textContent).not.toContain(`Public snapshot ${owner}`);
    expect(body.queryByRole('dialog')).toBeNull();
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('a[href*="/logs/"]')).toBeNull();
  };
  return {
    host,
    body,
    cache,
    router,
    loaders: () => loaders,
    show,
    click,
    field,
    fill,
    record,
    publish,
    reads,
    resolveRead,
    navigation,
    absent,
    html,
    hydrationErrors,
    close: async () => {
      await settle(() => root.unmount());
      host.remove();
      releaseExposure();
      cache.clear();
      read.mockRestore();
      navigate.mockRestore();
    },
  };
}
function retainedSubmit(form: HTMLFormElement) {
  // Happy DOM's form proxy enumerates controls, hiding React's own property keys.
  const key = Object.getOwnPropertyNames(form.querySelector('input,textarea,button')!).find((key) =>
    key.startsWith('__reactProps$'),
  )!;
  const props = Reflect.get(form, key) as {
    onSubmit: (event: { preventDefault(): void }) => void;
  };
  return () => props.onSubmit({ preventDefault() {} });
}
const recorded = (p: Extract<ProgressDetail, { state: 'ready' }>, amount = '4.75') =>
  Response.json({ progressSession: { ...native(p), revision: p.progress.session.revision + 1, amount } });

test('actual detail retires retained private UI on observed replacement, unknown, sign-out, unavailable and read admission loss', async () => {
  const h = await mount(detail(), true);
  try {
    expect(h.html).toContain('Private A');
    expect(h.hydrationErrors).toEqual([]);
    expect(h.host.querySelector('a[href*="/logs/public-A"]')).not.toBeNull();
    await h.fill(m.library_logs_publish_note(), 'A unpublished note');
    await h.click(m.library_progress_update());
    await h.fill(m.library_progress_amount(), '9.75');
    await h.show({ session: viewer('B') });
    h.absent();
    expect(h.reads.at(-1)!.data).toEqual(address);
    await h.resolveRead(detail('B'));
    expect(h.host.textContent).toContain('Private B');
    expect(h.field(m.library_logs_publish_note()).value).toBe('');
    for (const state of ['unknown', 'signed-out', 'unavailable'] as const) {
      await h.show({ session: { state, csrfToken: null } });
      h.absent('B');
      await h.show({ session: viewer('B') });
      expect(h.host.textContent).not.toContain('Private B');
      await h.resolveRead(detail('B'));
    }
    await h.show({ admitted: false });
    h.absent('B');
    await h.show({ admitted: true });
    await h.resolveRead(detail('B'));
    expect(h.host.textContent).toContain('Private B');
  } finally {
    await h.close();
  }
});

test('hydration retires loader-private data when the actual browser viewer is still unknown', async () => {
  const h = await mount(detail(), true, { state: 'unknown', csrfToken: null });
  try {
    expect(h.html).toContain('Private A');
    h.absent();
    expect(h.reads).toHaveLength(0);
    expect(h.hydrationErrors).toEqual([]);
    await h.show({ session: viewer('B') });
    await h.resolveRead(detail('B'));
    expect(h.host.textContent).toContain('Private B');
  } finally {
    await h.close();
  }
});

test('exact viewer, requested id, all independent cursors and returned session id gate result acceptance', async () => {
  const h = await mount();
  try {
    await h.show({ session: viewer('B') });
    await h.resolveRead(detail('A'));
    h.absent();
    for (const key of ['id', 'changes', 'units', 'logs'] as const) {
      const next = { ...address, [key]: key === 'id' ? id(21) : `${key}:new/==` };
      await h.show({ address: next });
      const wrong = detail('B', next);
      wrong.address = { ...next, [key]: address[key] };
      await h.resolveRead(wrong);
      h.absent('B');
    }
    const next = { ...address, id: id(22) };
    await h.show({ address: next });
    const wrongSession = detail('B', next);
    wrongSession.progress.session.id = address.id;
    await h.resolveRead(wrongSession);
    h.absent('B');
    await h.show({ address });
    await h.resolveRead(detail('B'));
    expect(h.host.textContent).toContain('Private B');
    const links = [...h.host.querySelectorAll('a')].map((link) => new URL(link.href, window.location.href));
    expect(
      links.some(
        (url) =>
          url.searchParams.get('changes') === 'next-changes' &&
          url.searchParams.get('units') === address.units &&
          url.searchParams.get('logs') === address.logs,
      ),
    ).toBe(true);
    expect(
      links.some(
        (url) =>
          url.searchParams.get('units') === 'next-units' &&
          url.searchParams.get('changes') === address.changes &&
          url.searchParams.get('logs') === address.logs,
      ),
    ).toBe(true);
    expect(
      links.some(
        (url) =>
          url.searchParams.get('logs') === 'next-logs' &&
          url.searchParams.get('changes') === address.changes &&
          url.searchParams.get('units') === address.units,
      ),
    ).toBe(true);
  } finally {
    await h.close();
  }
});

test('B detail, record and publication remain independently usable while A detail, record and publication are unresolved', async () => {
  const h = await mount();
  try {
    await h.publish('A note');
    const oldPublication = writes[0]!;
    await h.record();
    const oldRecord = writes[1]!;
    const oldSubmit = retainedSubmit(h.field(m.library_progress_amount()).closest('form')!);
    await h.show({ address: { ...address, logs: 'A:other-page' } });
    const oldDetail = h.reads.at(-1)!;
    await h.show({ session: viewer('B'), address });
    h.absent();
    await h.resolveRead(detail('B'));
    await h.publish('B note');
    const currentPublication = writes[2]!;
    await h.record('0');
    const currentRecord = writes[3]!;
    // A detached callback must not dispatch with B's current credential.
    await settle(oldSubmit);
    expect(writes).toHaveLength(4);
    await settle(() => oldDetail.work.resolve(detail('A', { ...address, logs: 'A:other-page' })));
    await settle(() => oldRecord.work.resolve(recorded(detail('A'))));
    await settle(() => oldPublication.work.resolve(Response.json({ publishedLog: { id: 'old-public' } })));
    expect(h.navigation).toEqual([]);
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    expect((h.host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('B note');
    expect(h.body.queryAllByRole('alert').map((alert) => alert.textContent)).toEqual([]);
    await h.click(m.library_progress_record());
    expect(writes).toHaveLength(4);
    await act(async () => {
      await userEvent.setup({ document }).keyboard('{Escape}');
    });
    expect(h.body.getAllByRole('alertdialog')).toHaveLength(1);
    await h.click(m.library_progress_draft_navigation_stay());
    await settle(() => currentPublication.work.resolve(Response.json({ publishedLog: { id: 'returned-public-B' } })));
    expect(h.navigation).toEqual(['/logs/returned-public-B']);
    await settle(() => currentRecord.work.resolve(Response.json({ code: 'conflict' }, { status: 409 })));
  } finally {
    await h.close();
  }
});

test('late history failures and publication failures/finally cannot alter a newer pending operation or navigate after unmount', async () => {
  const h = await mount();
  try {
    await h.publish('A note');
    const oldPublish = writes[0]!;
    await h.record();
    await settle(() => writes[1]!.work.resolve(recorded(detail())));
    const oldHistory = h.reads.at(-1)!;
    const oldPublishSubmit = retainedSubmit(h.field(m.library_logs_publish_note()).closest('form')!);
    await h.show({ session: viewer('B') });
    await h.resolveRead(detail('B'));
    await h.publish('B note');
    const currentPublish = writes[2]!;
    await h.record('9.25');
    const currentRecord = writes[3]!;
    await settle(() => oldHistory.work.reject(new Error('old history failure')));
    await settle(() => oldPublish.work.reject(new Error('old publication failure')));
    await settle(oldPublishSubmit);
    expect(h.body.queryAllByRole('alert').map((alert) => alert.textContent)).toEqual([]);
    expect(h.field(m.library_progress_amount()).value).toBe('9.25');
    expect(h.host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await h.click(m.library_progress_record());
    expect(writes).toHaveLength(4);
    await h.show({ visible: false });
    await settle(() => currentPublish.work.resolve(Response.json({ publishedLog: { id: 'unmounted-public' } })));
    await settle(() => currentRecord.work.resolve(recorded(detail('B'))));
    expect(h.navigation).toEqual([]);
    expect(h.host.textContent).toBe('');
  } finally {
    await h.close();
  }
});

test('a batched away/back viewer change retires retained callbacks and late failure/finally before rendering', async () => {
  const h = await mount();
  try {
    await h.record('4.75');
    const old = writes[0]!;
    const submit = retainedSubmit(h.field(m.library_progress_amount()).closest('form')!);
    await act(async () => {
      h.cache.setQueryData(['session'], viewer('B'));
      h.cache.setQueryData(['session'], viewer('A'));
      submit();
    });
    expect(writes).toHaveLength(1);
    expect(h.host.textContent).not.toContain('Private A');
    await h.resolveRead(detail('A', address, 20));
    await h.record('6.25');
    const currentWrite = writes[1]!;
    await settle(() => old.work.resolve(Response.json({ code: 'forbidden' }, { status: 403 })));
    expect(h.field(m.library_progress_amount()).value).toBe('6.25');
    expect(h.body.queryAllByRole('alert').map((alert) => alert.textContent)).toEqual([]);
    await h.click(m.library_progress_record());
    expect(writes).toHaveLength(2);
    expect(currentWrite.body).toEqual({ revision: 20, amount: '6.25' });
    await settle(() => currentWrite.work.reject(new Error('current unknown outcome')));
  } finally {
    await h.close();
  }
});

test('healthy exact native payload, key and locked draft survive token rotation and ordinary refresh after an unknown outcome', async () => {
  const initial = detail();
  const h = await mount(initial);
  try {
    await h.record('0');
    const first = writes[0]!;
    expect(first.body).toEqual({ revision: 7, amount: '0' });
    expect(first.request.headers.get('idempotency-key')).toBe(JSON.stringify(initial.progress.idempotencyKey));
    expect(first.request.headers.get('authorization')).toBe('Bearer A');
    await settle(() => first.work.reject(new Error('unknown commit outcome')));
    expect(h.field(m.library_progress_amount()).closest('fieldset')!.disabled).toBe(true);
    await h.show({ session: viewer('A', token('R')), page: detail('A', address, 12) });
    await h.click(m.library_progress_confirm_correction());
    expect(writes[1]!.body).toEqual(first.body);
    expect(writes[1]!.request.headers.get('idempotency-key')).toBe(first.request.headers.get('idempotency-key'));
    expect(h.field(m.library_progress_amount()).value).toBe('0');
    await settle(() => writes[1]!.work.resolve(recorded(initial, '0')));
    expect(h.reads.at(-1)!.data).toEqual(address); // Includes owner-list cursor, not an unlabelled session read.
    const authoritative = detail('A', address, 13);
    authoritative.progress.session.amount = '0';
    await h.resolveRead(authoritative);
    expect(h.body.queryByRole('dialog')).toBeNull();
    await h.record('4.75');
    expect(writes[2]!.body).toEqual({ revision: 13, amount: '4.75' });
    expect(writes[2]!.request.headers.get('idempotency-key')).not.toBe(first.request.headers.get('idempotency-key'));
    await settle(() => writes[2]!.work.resolve(Response.json({ code: 'conflict' }, { status: 409 })));
  } finally {
    await h.close();
  }
});

test('history provenance and latest-history fences reject wrong viewers and older revisions', async () => {
  const initial = detail();
  initial.progress.session.recordingState = 'unavailable';
  const h = await mount(initial);
  try {
    await h.click(m.library_progress_retry());
    const older = h.reads.at(-1)!;
    await h.click(m.library_progress_retry());
    await h.resolveRead(detail('A', address, 15));
    await h.click(m.library_progress_update());
    await h.fill(m.library_progress_amount(), '6.5');
    await settle(() => older.work.resolve(detail('B', address, 99)));
    expect(h.field(m.library_progress_amount()).value).toBe('6.5');
    await h.click(m.library_progress_record());
    expect(writes[0]!.body).toEqual({ revision: 15, amount: '6.5' });
    await settle(() => writes[0]!.work.resolve(recorded(detail('A', address, 15))));
    await h.resolveRead(detail('B', address, 99));
    h.absent();
  } finally {
    await h.close();
  }
});

test('publication retains its captured note and key through same-owner refresh and uncertain retry', async () => {
  const h = await mount();
  try {
    await h.publish('  captured note  ');
    const first = writes[0]!;
    expect(first.body).toEqual({ sessionId: address.id, note: 'captured note' });
    await settle(() => first.work.reject(new Error('unknown publication')));
    expect((h.field(m.library_logs_publish_note()) as unknown as HTMLTextAreaElement).readOnly).toBe(true);
    await h.show({ session: viewer('A', token('S')), page: detail('A', address, 8) });
    await h.click(m.library_logs_publish());
    expect(writes[1]!.body).toEqual(first.body);
    expect(writes[1]!.request.headers.get('idempotency-key')).toBe(first.request.headers.get('idempotency-key'));
    await h.click(m.library_logs_publish());
    expect(writes).toHaveLength(2);
    await settle(() => writes[1]!.work.resolve(Response.json({ publishedLog: { id: 'published-original-note' } })));
    expect(h.navigation).toEqual(['/logs/published-original-note']);
  } finally {
    await h.close();
  }
});

test('actual combined server export uses each reader preparation exactly once and refuses mixed, missing or refused provenance', async () => {
  current = viewer();
  request = requestFor();
  preparations = [];
  prepared = 0;
  nativeReads.length = 0;
  named.length = 0;
  readFailure = listFailure = null;
  const healthy = await actualDetail({ data: address });
  expect(healthy).toMatchObject({
    state: 'ready',
    viewer: 'A',
    address,
    progress: { signedIn: true },
    logs: { signedIn: true },
  });
  expect(prepared).toBe(2);
  expect(nativeReads).toHaveLength(4);
  expect(named).toHaveLength(1);
  expect(
    nativeReads.every(
      (call) =>
        call.headers.get('authorization') === 'Bearer A' && call.cache === 'no-store' && call.redirect === 'manual',
    ),
  ).toBe(true);
  const list = nativeReads.find((call) => new URL(call.url).pathname === '/v1/publishedLogs')!;
  expect(Object.fromEntries(new URL(list.url).searchParams)).toEqual({
    view: 'FULL',
    limit: '100',
    accountId: 'A',
    cursor: address.logs,
  });
  preparations = [
    { status: 'active', subject: 'A', accessToken: 'A', csrfToken: token('A') },
    { status: 'active', subject: 'B', accessToken: 'B', csrfToken: token('B') },
  ];
  expect(await actualDetail({ data: address })).toEqual({ state: 'refused', viewer: null, address });
  expect(named).toHaveLength(1); // No summary naming or combined disclosure across actual preparations.
  const retained = requestFor();
  await prepareSession(retained, env);
  request = retained;
  nativeReads.length = 0;
  preparations = [{ status: 'absent' }, { status: 'absent' }];
  expect(await actualDetail({ data: address })).toEqual({ state: 'refused', viewer: null, address });
  expect(nativeReads).toHaveLength(0); // No retained WeakMap credential fallback.
  request = new Request(request.url, { headers: { authorization: 'Bearer explicit-without-prepared-subject' } });
  expect(await actualDetail({ data: address })).toEqual({ state: 'refused', viewer: null, address });
  request = requestFor();
  preparations = [{ status: 'unavailable' }, { status: 'absent' }];
  await expect(actualDetail({ data: address })).rejects.toMatchObject({ problem: { code: 'session_unavailable' } });
  preparations = [];
  readFailure = Response.json({ code: 'not_found' }, { status: 404 });
  await expect(actualDetail({ data: address })).rejects.toMatchObject({ isNotFound: true });
  readFailure = Response.json({ code: 'platform_closed' }, { status: 403 });
  await expect(actualDetail({ data: address })).rejects.toMatchObject({ name: 'PlatformClosedError' });
  readFailure = null;
  listFailure = Response.json({}, { status: 202 });
  await expect(actualDetail({ data: address })).rejects.toMatchObject({ state: 'preparing' });
  listFailure = Response.json({ code: 'forbidden' }, { status: 403 });
  await expect(actualDetail({ data: address })).rejects.toMatchObject({ state: 'denied' });
  listFailure = null;
});

test('routed detail traverses independent native windows, retries an exact failed target, revisits facts and continues editing', async () => {
  const h = await mount(detail(), false, viewer(), true);
  const region = (section: 'changes' | 'units') =>
    within(
      h.body.getByRole('region', {
        name: section === 'changes' ? m.library_progress_changes() : m.library_progress_units(),
        exact: true,
      }),
    );
  const move = async (section: 'changes' | 'units', label: string) =>
    act(async () => {
      await h.body.getByRole('region', {
        name: section === 'changes' ? m.library_progress_changes() : m.library_progress_units(),
        exact: true,
      });
      await userEvent.setup({ document }).click(region(section).getByRole('link', { name: label, exact: true }));
    });
  const admit = async (empty = false) => {
    const at = h.reads.at(-1)!.data;
    const p = detail('A', at, 8);
    p.progress.session.changesNext =
      at.changes === address.changes ? 'next-changes' : at.changes === 'next-changes' ? 'third-changes' : null;
    p.progress.session.unitsNext =
      at.units === address.units ? 'next-units' : at.units === 'next-units' ? 'third-units' : null;
    if (empty) {
      p.progress.session.changes = [];
      p.progress.session.units = [];
    }
    await h.resolveRead(p);
  };
  try {
    for (const section of ['changes', 'units'] as const) {
      expect(region(section).queryByRole('link', { name: m.library_window_previous() })).toBeNull();
      await move(section, m.library_progress_more());
      const target = {
        ...address,
        [section]: `next-${section}`,
        ...(section === 'units' ? { changes: 'third-changes' } : {}),
      };
      expect(h.reads.at(-1)!.data).toEqual(target);
      await admit(true); // An empty page with native next remains traversable.
      await move(section, m.library_progress_more());
      await admit(true);
      expect(region(section).queryByRole('link', { name: m.library_progress_more() })).toBeNull();
      expect(region(section).getByRole('link', { name: m.library_window_previous() })).toBeTruthy();
    }
    expect(h.loaders()).toBe(1);
    const units = h.router.state.location.search.units;
    await move('changes', m.library_window_previous());
    const failed = { ...h.reads.at(-1)!.data };
    await settle(() => h.reads.at(-1)!.work.reject(new Error('native page failed')));
    await h.click(m.library_progress_retry());
    expect(h.reads.at(-1)!.data).toEqual(failed);
    await admit();
    await move('changes', m.library_window_previous());
    expect(h.reads.at(-1)!.data.changes).toBe(address.changes);
    expect(h.reads.at(-1)!.data.units).toBe(units);
    await admit();
    expect(region('changes').queryByRole('link', { name: m.library_window_previous() })).toBeNull();
    expect(region('changes').getByText('A:history')).toBeTruthy();
    await move('units', m.library_collections_first_page());
    expect(h.reads.at(-1)!.data).toEqual({ ...address, units: undefined });
    await admit();
    expect(h.router.state.location.hash).toBe('facts');
    expect(h.router.state.location.search.logs).toBe(address.logs);
    expect(h.router.state.location.search.history).toBe('/library/history?cursor=original%2F%2B%3D%3D');
    await h.record('4.75');
    expect(writes).toHaveLength(1);
    await settle(() => writes[0]!.work.resolve(recorded(detail())));
    expect(h.reads.at(-1)!.data.units).toBeUndefined();
    await admit();
    await act(async () =>
      userEvent
        .setup({ document })
        .click(h.body.getByRole('link', { name: m.library_progress_return_to_progress(), exact: true })),
    );
    expect(document.body.textContent).toContain('Progress index');
    expect(h.router.state.location.search).toEqual({ state: 'active', cursor: 'return/+==' });
    expect(h.router.state.location.state).toMatchObject({ progressReturnSelection: { sessionId: address.id } });
  } finally {
    await h.close();
  }
});

test('a native section restart clears only its predecessors; replacement retires paths and late movement', async () => {
  const h = await mount(detail(), false, viewer(), true);
  const more = async (section: 'changes' | 'units') =>
    act(async () =>
      userEvent.setup({ document }).click(
        within(
          h.body.getByRole('region', {
            name: section === 'changes' ? m.library_progress_changes() : m.library_progress_units(),
            exact: true,
          }),
        ).getByRole('link', { name: m.library_progress_more() }),
      ),
    );
  try {
    await more('units');
    await h.resolveRead(detail('A', h.reads.at(-1)!.data));
    await more('changes');
    const restarted = detail('A', h.reads.at(-1)!.data);
    delete restarted.progress.changesCursor;
    await h.resolveRead(restarted);
    const changes = within(h.body.getByRole('region', { name: m.library_progress_changes(), exact: true }));
    expect(changes.queryByRole('link', { name: m.library_window_previous() })).toBeNull();
    expect(changes.getByRole('status').textContent).toBe(m.library_progress_history_restarted());
    expect(
      within(h.body.getByRole('region', { name: m.library_progress_units(), exact: true })).getByRole('link', {
        name: m.library_window_previous(),
      }),
    ).toBeTruthy();
    await h.record();
    await settle(() => writes[0]!.work.resolve(recorded(detail())));
    expect(h.reads.at(-1)!.data.changes).toBeUndefined();
    expect(h.reads.at(-1)!.data.units).toBe('next-units');
    const refreshed = detail('A', h.reads.at(-1)!.data, 8);
    delete refreshed.progress.unitsCursor; // A later ordinary refresh can restart the sibling too.
    await h.resolveRead(refreshed);
    await h.record();
    await settle(() => writes[1]!.work.resolve(recorded(refreshed)));
    expect(h.reads.at(-1)!.data.units).toBeUndefined();
    await h.resolveRead(detail('A', h.reads.at(-1)!.data, 9));
    await more('changes');
    const late = h.reads.at(-1)!;
    await h.show({ session: viewer('B') });
    await settle(() => late.work.resolve(detail('A', late.data)));
    h.absent();
    await h.resolveRead(detail('B', h.reads.at(-1)!.data));
    expect(h.body.queryByRole('link', { name: m.library_window_previous() })).toBeNull();
  } finally {
    await h.close();
  }
});

test('Stay cancels history movement and cannot lend coordinates or focus to a later unrelated navigation', async () => {
  const h = await mount(detail(), false, viewer(), true);
  try {
    await h.fill(m.library_logs_publish_note(), 'draft');
    const before = h.reads.length;
    await act(async () => {
      within(h.body.getByRole('region', { name: m.library_progress_changes(), exact: true }))
        .getByRole('link', { name: m.library_progress_more() })
        .focus();
      await userEvent.setup({ document }).keyboard('{Enter}');
    });
    expect(h.body.getByRole('alertdialog')).toBeTruthy();
    await h.click(m.library_progress_draft_navigation_stay());
    expect(h.reads).toHaveLength(before);
    expect((h.body.getByLabelText(m.library_logs_publish_note()) as HTMLTextAreaElement).value).toBe('draft');
    await h.fill(m.library_logs_publish_note(), '');
    await act(async () =>
      h.router.navigate({
        to: '/library/progress/$id',
        params: { id: address.id },
        search: { ...h.router.state.location.search, changes: 'next-changes' },
        hash: (previous) => previous,
        state: (previous) => previous,
      }),
    );
    await h.resolveRead(detail('A', h.reads.at(-1)!.data));
    expect(h.body.queryByRole('link', { name: m.library_window_previous() })).toBeNull();
    expect(document.activeElement?.hasAttribute('data-progress-history-heading')).toBe(false);
  } finally {
    await h.close();
  }
});

test('equal route replacement retires a staged read and its predecessor coordinates', async () => {
  const h = await mount(detail(), false, viewer(), true);
  try {
    const changes = () => within(h.body.getByRole('region', { name: m.library_progress_changes(), exact: true }));
    await act(async () =>
      userEvent.setup({ document }).click(changes().getByRole('link', { name: m.library_progress_more() })),
    );
    const late = h.reads.at(-1)!;
    await act(async () =>
      h.router.navigate({
        to: '/library/progress/$id',
        params: { id: address.id },
        search: h.router.state.location.search,
        replace: true,
      }),
    );
    await settle(() => late.work.resolve(detail('A', late.data)));
    expect(h.host.textContent).not.toContain('A:history');
    await h.resolveRead(detail('A', h.reads.at(-1)!.data));
    expect(changes().queryByRole('link', { name: m.library_window_previous() })).toBeNull();
  } finally {
    await h.close();
  }
});

test('keyboard history movement focuses its admitted heading once and independent focus cancels late focus', async () => {
  const h = await mount(detail(), false, viewer(), true);
  try {
    const section = () => h.body.getByRole('region', { name: m.library_progress_changes(), exact: true });
    const enter = async () =>
      act(async () => {
        within(section()).getByRole('link', { name: m.library_progress_more() }).focus();
        await userEvent.setup({ document }).keyboard('{Enter}');
      });
    await enter();
    await h.resolveRead(detail('A', h.reads.at(-1)!.data));
    expect(document.activeElement?.getAttribute('data-progress-history-heading')).toBe('changes');
    await h.show();
    const heading = document.activeElement;
    await enter();
    const retry = h.body.getByRole('button', { name: m.library_progress_retry() });
    // The loading Retry is disabled; another user-owned focus target cancels the move.
    const other = document.createElement('button');
    document.body.append(other);
    other.focus();
    await h.resolveRead(detail('A', h.reads.at(-1)!.data));
    expect(document.activeElement === other).toBe(true);
    expect(heading?.isConnected).toBe(false);
    expect(retry.isConnected).toBe(false);
    other.remove();
  } finally {
    await h.close();
  }
});
