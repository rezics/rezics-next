// UNRUN: mounted owner-route integration and actual ZoneEditorSession retirement regression.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { Loaded, Mutation, Preview, Result, Transport, ZoneOwned } from '../src/features/zones/editor/model';
import type { OwnerReadObservation } from '../src/features/zones/editor/owner-lifetime';
import type { CommandOutcome, ListOutcome } from '../src/features/zones/manage/model';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/my/zones' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
  Element: window.Element,
  Node: window.Node,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Viewer = { state: 'signed-in' | 'signed-out' | 'unknown'; subject?: string; csrfToken: string | null };
type ReadData = { id: string; locale: string; expectedReader?: string; admission?: string };
type ReadChoicesData = { locale: string; cursor: string; expectedReader?: string; admission?: string };
type PreviewData = ReadData & { route: string };
type WriteData = Mutation & { locale: string; expectedReader?: string; admission?: string };
type OwnedReadArgs<T> = { data: T; headers?: Record<string, string> };

let backendViewer: Viewer = { state: 'signed-in', subject: 'A', csrfToken: null };
let nextEditorRead: ReturnType<typeof deferred<Loaded>> | undefined;
let nextEditorWrite: 'unavailable' | undefined;
let delayedPreview: ReturnType<typeof deferred<Preview>> | undefined;
let delayedChoices: ReturnType<typeof deferred<Loaded['options']['collections']>> | undefined;
const editorReads: ReadData[] = [];
const editorWrites: { data: WriteData; csrf: string | undefined }[] = [];
const editorPreviews: PreviewData[] = [];
const editorChoices: ReadChoicesData[] = [];
const editorFixtureModule = await import('../src/features/zones/editor/fixture');
const editorFixture = editorFixtureModule.zoneEditorFixture();
let editorLoaded = structuredClone(editorFixture.initial);
if (editorLoaded.options.collections.kind === 'ready') editorLoaded.options.collections.value.next = 'cursor-first';

function responseObservation(data: { expectedReader?: string; admission?: string }): OwnerReadObservation | undefined {
  if (
    backendViewer.state !== 'signed-in' ||
    !backendViewer.subject ||
    data.expectedReader !== backendViewer.subject ||
    !data.admission
  )
    return undefined;
  return { reader: backendViewer.subject, admission: data.admission };
}

function loadedFor(id: string, ownerObservation?: OwnerReadObservation): Loaded {
  const loaded = structuredClone(editorLoaded);
  if (loaded.resource.kind === 'ready') loaded.resource.value.zone.id = id;
  return { ...loaded, ...(ownerObservation ? { ownerObservation } : {}) };
}

const editorServer = {
  readConfiguration: async ({ data }: OwnedReadArgs<ReadData>): Promise<Loaded> => {
    editorReads.push(data);
    const observation = responseObservation(data);
    if (!observation)
      return {
        resource: { kind: 'failure', status: 401, code: 'unauthorized' },
        permissions: { configure: false, publish: false, available: false },
        options: {
          scopes: { kind: 'failure', status: 401, code: 'unauthorized' },
          collections: { kind: 'failure', status: 401, code: 'unauthorized' },
        },
      };
    const pending = nextEditorRead;
    nextEditorRead = undefined;
    return pending ? pending.promise : loadedFor(data.id, observation);
  },
  writeConfiguration: async ({ data, headers }: OwnedReadArgs<WriteData>): Promise<Result<ZoneOwned>> => {
    editorWrites.push({ data, csrf: headers?.['X-CSRF-Token'] });
    const observation = responseObservation(data);
    if (
      !observation ||
      !backendViewer.csrfToken ||
      headers?.['X-CSRF-Token'] !== backendViewer.csrfToken ||
      !/^[A-Za-z0-9_-]{22}$/.test(headers?.['X-CSRF-Token'] ?? '')
    )
      return { kind: 'failure', status: 403, code: 'forbidden' };
    if (nextEditorWrite === 'unavailable') {
      nextEditorWrite = undefined;
      return { kind: 'failure', status: 503, code: 'dependency_unavailable', ownerObservation: observation };
    }
    if (editorLoaded.resource.kind !== 'ready') return { kind: 'failure', status: 404, code: 'not_found' };
    const saved = editorLoaded.resource.value;
    const revision = (BigInt(saved.zone.revision) + 1n).toString();
    const zone: ZoneOwned = {
      ...saved.zone,
      id: data.id,
      revision,
      ...(data.operation === 'publish' ? { visibility: data.body.visibility } : {}),
    };
    if (data.operation === 'save') {
      editorLoaded = {
        ...editorLoaded,
        resource: { kind: 'ready', value: { ...saved, zone, configuration: structuredClone(data.body.configuration), mounts: [...data.body.mounts] } },
      };
    } else editorLoaded = { ...editorLoaded, resource: { kind: 'ready', value: { ...saved, zone } } };
    return { kind: 'ready', value: zone, ownerObservation: observation };
  },
  readSavedPreview: async ({ data }: OwnedReadArgs<PreviewData>): Promise<Preview> => {
    editorPreviews.push(data);
    const observation = responseObservation(data);
    if (!observation) return { kind: 'failure', status: 401, code: 'unauthorized' };
    if (delayedPreview) {
      const pending = delayedPreview;
      delayedPreview = undefined;
      return pending.promise;
    }
    return { kind: 'preparing', retryAfter: '1', ownerObservation: observation };
  },
  readMountChoices: async ({ data }: OwnedReadArgs<ReadChoicesData>) => {
    editorChoices.push(data);
    const observation = responseObservation(data);
    if (!observation) return { kind: 'failure' as const, status: 401, code: 'unauthorized' };
    if (delayedChoices) {
      const pending = delayedChoices;
      delayedChoices = undefined;
      return pending.promise;
    }
    return {
      kind: 'ready' as const,
      value: { items: [{ id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81', title: 'Later collection' }], next: null },
      ownerObservation: observation,
    };
  },
};

mock.module('../src/features/zones/editor/server', () => editorServer);
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
  useParams,
  useRouter,
  useNavigate,
  useLoaderData,
} = await import('@tanstack/react-router');
const { sessionQuery, useSession } = await import('../src/session/query');
const { captureOwnerRead, OwnerLifetime, useOwnerLifetime } = await import('../src/features/zones/editor/owner-lifetime');
const { ZoneEditorRoute, loadZoneEditor } = await import('../src/features/zones/editor/route');
const { ZoneEditorSession } = await import('../src/features/zones/editor/model');
const { ZonesOwnerWorkspace } = await import('../src/features/zones/manage/workspace');
const { CreateZone } = await import('../src/features/zones/manage/create');
const { readOwnedZones, changeOwnedZone, createOwnedZone } = await import('../src/features/zones/manage/request');
const { fixtureZone, fixtureZoneId, zonesFixture } = await import('../src/features/zones/manage/fixtures');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

const csrfA = 'AAAAAAAAAAAAAAAAAAAAAA';
const csrfB = 'BBBBBBBBBBBBBBBBBBBBBB';
const csrfC = 'CCCCCCCCCCCCCCCCCCCCCC';
const sessionEnv = {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'site',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        accessToken: `access-${backendViewer.subject ?? 'signed-out'}`,
        subject: backendViewer.subject ?? 'A',
        csrfToken: backendViewer.csrfToken,
      }),
    }),
  },
} as never;
function request(method: 'GET' | 'POST', token: string | null) {
  return new Request('https://site.test/my/zones', {
    method,
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.test',
      ...(method === 'POST' ? { 'X-CSRF-Token': token ?? '' } : {}),
    },
  });
}

const managed = zonesFixture('uncertain');
const listCalls: { reader: string; admission: string }[] = [];
async function readList(expected: OwnerReadObservation): Promise<ListOutcome> {
  listCalls.push({ reader: expected.reader, admission: expected.admission });
  return readOwnedZones(
    managed.client,
    request('GET', backendViewer.csrfToken),
    sessionEnv,
    { deleted: false },
    expected,
  );
}
const lifecycleCalls: { command: import('../src/features/zones/manage/model').LifecycleCommand; capture?: OwnerReadObservation }[] = [];
async function changeZone(
  command: import('../src/features/zones/manage/model').LifecycleCommand,
  capture?: import('../src/features/zones/editor/owner-lifetime').OwnerCapture,
): Promise<CommandOutcome> {
  lifecycleCalls.push({ command, ...(capture ? { capture: capture.observation } : {}) });
  if (!capture) return { kind: 'stale' };
  return changeOwnedZone(managed.client, request('POST', capture.csrfToken), sessionEnv, command, capture.observation);
}
const createCalls: { command: import('../src/features/zones/manage/model').CreateCommand; capture?: OwnerReadObservation }[] = [];
let delayedCreateOutcome: ReturnType<typeof deferred<CommandOutcome>> | undefined;
async function createZone(
  command: import('../src/features/zones/manage/model').CreateCommand,
  capture?: import('../src/features/zones/editor/owner-lifetime').OwnerCapture,
): Promise<CommandOutcome> {
  createCalls.push({ command: structuredClone(command), ...(capture ? { capture: capture.observation } : {}) });
  if (!capture) return { kind: 'stale' };
  if (delayedCreateOutcome) {
    const pending = delayedCreateOutcome;
    delayedCreateOutcome = undefined;
    return pending.promise;
  }
  return createOwnedZone(managed.client, request('POST', capture.csrfToken), sessionEnv, command, capture.observation);
}

const rootRoute = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()({
  component: () => <Outlet />,
});
function ZonesListPage() {
  const location = useLocation();
  const router = useRouter();
  const { outcome, requestedOwner } = useLoaderData({ strict: false }) as {
    outcome: ListOutcome;
    requestedOwner: OwnerReadObservation | null;
  };
  const { lifetime, snapshot } = useOwnerLifetime(
    location.pathname + JSON.stringify(location.search),
    requestedOwner,
  );
  const current = !!snapshot.capture && requestedOwner?.reader === snapshot.capture.observation.reader &&
    requestedOwner?.admission === snapshot.capture.observation.admission;
  const visible = current ? outcome : null;
  return (
    <ZonesOwnerWorkspace
      key={`${location.pathname}:${snapshot.incarnation}`}
      locale="en"
      input={{ deleted: false }}
      outcome={visible}
      owner={lifetime}
      onChange={changeZone}
      onReload={() => router.invalidate()}
    />
  );
}
const listRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my/zones',
  loader: async ({ context }) => {
    const requestedOwner = captureOwnerRead(context.queryClient);
    const outcome = requestedOwner ? await readList(requestedOwner) : { kind: 'signed-out' as const };
    return { outcome, requestedOwner };
  },
  component: ZonesListPage,
});
function CreateRoutePage() {
  const { state } = useSession();
  const location = useLocation();
  const { lifetime, snapshot } = useOwnerLifetime(location.pathname + JSON.stringify(location.search));
  const navigate = useNavigate();
  return (
    <CreateZone
      key={`${location.pathname}:${snapshot.incarnation}`}
      locale="en"
      session={state}
      owner={lifetime}
      onCreate={createZone}
      onNavigate={(href) => {
        navigations.push(href);
        const id = href.split('/').at(-2)!;
        void navigate({ to: '/my/zones/$id/edit', params: { id } });
      }}
    />
  );
}
const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/my/zones/new', component: CreateRoutePage });
function EditRoutePage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { initial, requestedOwner } = useLoaderData({ strict: false }) as Awaited<ReturnType<typeof loadZoneEditor>>;
  return <ZoneEditorRoute id={id} locale="en" initial={initial} requestedOwner={requestedOwner} />;
}
const editRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my/zones/$id/edit',
  loader: ({ params, context }) => loadZoneEditor(params.id, 'en', context.queryClient),
  component: EditRoutePage,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([listRoute, newRoute, editRoute]),
  history: createMemoryHistory({ initialEntries: ['/my/zones'] }),
  context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
});
const queryClient = router.options.context.queryClient;
const navigations: string[] = [];

const settle = async (action: () => void | Promise<void>) =>
  act(async () => {
    await action();
  });
const flush = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
async function until(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  throw new Error('Mounted Zone journey did not settle');
}
function button(host: HTMLElement, label: string, occurrence = 0): HTMLButtonElement {
  const matches = [...host.querySelectorAll('button')].filter((node) => node.textContent?.trim() === label);
  const match = matches[occurrence];
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
function confirmTrash() {
  const dialog = document.querySelector('[role="alertdialog"]');
  const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
    (node) => node.textContent?.trim() === m.zones_owner_trash_action({}, { locale: 'en' }),
  );
  if (!confirm) throw new Error('Missing Zone trash confirmation');
  confirm.click();
}
function setInput(host: HTMLElement, selector: string, value: string) {
  const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!target) throw new Error(`Missing input: ${selector}`);
  target.value = value;
  target.dispatchEvent(new window.Event(target instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
function signedIn(subject: string, csrfToken: string | null): Viewer {
  return { state: 'signed-in', subject, csrfToken };
}

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('mounted My Zones to publish journey keeps async state in its original reader visit', async () => {
  setLocale('en', { reload: false });
  backendViewer = signedIn('A', null);
  queryClient.setQueryData(sessionQuery.queryKey, backendViewer);
  const apiCallsBefore = managed.calls.length;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await settle(() => root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  ));
  await until(() => host.textContent?.includes(m.zones_owner_title({}, { locale: 'en' })) ?? false);

  expect(listCalls).toHaveLength(1);
  expect(managed.calls.length - apiCallsBefore).toBe(1);
  expect(button(host, m.zones_owner_trash_action({}, { locale: 'en' })).disabled).toBe(true);

  backendViewer = signedIn('A', csrfA);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => router.invalidate());
  await until(
    () => !!host.querySelector('button') && !button(host, m.zones_owner_trash_action({}, { locale: 'en' })).disabled,
  );
  await settle(() => button(host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
  await settle(confirmTrash);
  await until(() => lifecycleCalls.length === 1);
  await until(() => host.textContent?.includes(m.zones_owner_unavailable({}, { locale: 'en' })) ?? false);
  await settle(() => button(host, m.zones_owner_retry({}, { locale: 'en' })).click());
  await until(() => lifecycleCalls.length === 2);
  expect(lifecycleCalls[1]!.command).toEqual(lifecycleCalls[0]!.command);
  const lifecycleRequests = managed.calls.filter((call) => call.path === `/v1/zones/${fixtureZoneId}`);
  expect(lifecycleRequests.slice(-2).map((call) => [call.key, call.match, call.method])).toEqual([
    [lifecycleRequests.at(-2)!.key, '"3"', 'DELETE'],
    [lifecycleRequests.at(-2)!.key, '"3"', 'DELETE'],
  ]);

  await settle(() => router.navigate({ to: '/my/zones/new' }));
  await until(() => !!host.querySelector('#zone-starter'));
  await settle(() => setInput(host, '#zone-starter', 'book'));
  await settle(() => setInput(host, '#zone-label-en', 'Field Notes'));
  await settle(() => button(host, m.zones_create_submit({}, { locale: 'en' })).click());
  await until(() => createCalls.length === 1);
  await until(() => navigations.length === 1);
  expect(createCalls[0]!.command.key).toMatch(/^[0-9a-f-]{36}$/);
  expect(navigations).toEqual([`/en/my/zones/${fixtureZoneId}/edit`]);
  await until(() => host.querySelector('#zone-label-en') !== null);

  const loadedLabel = host.querySelector<HTMLInputElement>('#zone-label-en')!.value;
  await settle(() => setInput(host, '#zone-label-en', 'Same-reader draft to retire'));
  backendViewer = signedIn('A', null);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => router.invalidate());
  await until(() => host.querySelector('#zone-label-en') !== null);
  expect(host.querySelector<HTMLInputElement>('#zone-label-en')?.value).toBe(loadedLabel);
  expect(button(host, m.zone_editor_save()).disabled).toBe(true);
  expect(button(host, m.zone_editor_publish()).disabled).toBe(true);
  expect(button(host, m.zone_editor_preview()).disabled).toBe(false);
  expect(button(host, m.zone_editor_more()).disabled).toBe(false);
  await settle(() => button(host, m.zone_editor_preview()).click());
  await until(() => editorPreviews.length === 1);
  expect(editorPreviews[0]!.expectedReader).toBe('A');
  await until(() => host.textContent?.includes(m.zone_preparing_message()) ?? false);
  await settle(() => button(host, m.zone_editor_more()).click());
  await until(() => editorChoices.length === 1);
  expect(editorChoices[0]!.expectedReader).toBe('A');
  await until(() => host.textContent?.includes('Later collection') ?? false);

  backendViewer = signedIn('A', csrfB);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => router.invalidate());
  await until(() => !!host.querySelector('#zone-label-en') && button(host, m.zone_editor_save()).disabled);
  await settle(() => setInput(host, '#zone-label-en', 'Saved notes'));
  nextEditorWrite = 'unavailable';
  await settle(() => button(host, m.zone_editor_save()).click());
  await until(() => editorWrites.length === 1 && !host.querySelector('[aria-busy="true"]'));
  expect(editorWrites[0]!.csrf).toBe(csrfB);
  await settle(() => button(host, m.zone_editor_save()).click());
  await until(() => editorWrites.length === 2 && host.textContent?.includes(m.zone_editor_saved()) === true);
  expect(editorWrites[1]!.data.key).toBe(editorWrites[0]!.data.key);
  expect(editorWrites[1]!.data.revision).toBe(editorWrites[0]!.data.revision);

  await settle(() => setInput(host, '#zone-label-en', 'Uncertain draft to retire'));
  nextEditorWrite = 'unavailable';
  await settle(() => button(host, m.zone_editor_save()).click());
  await until(() => editorWrites.length === 3 && !host.querySelector('[aria-busy="true"]'));
  const retiredRetryKey = editorWrites[2]!.data.key;
  backendViewer = signedIn('A', csrfC);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => router.invalidate());
  await until(
    () =>
      host.querySelector<HTMLInputElement>('#zone-label-en')?.value === 'Saved notes' &&
      button(host, m.zone_editor_save()).disabled,
  );
  await settle(() => setInput(host, '#zone-label-en', 'Saved notes refreshed'));
  await settle(() => button(host, m.zone_editor_save()).click());
  await until(() => editorWrites.length === 4 && !host.querySelector('[aria-busy="true"]'));
  expect(editorWrites[3]!.data.key).not.toBe(retiredRetryKey);
  expect(editorWrites[3]!.csrf).toBe(csrfC);

  await settle(() => setInput(host, '#zone-visibility', 'public'));
  await settle(() => button(host, m.zone_editor_publish()).click());
  await until(() => host.textContent?.includes(m.zone_editor_published()) ?? false);
  expect(editorWrites.at(-1)!.data.operation).toBe('publish');
  expect(editorWrites.at(-1)!.csrf).toBe(csrfC);

  const oldReader = queryClient.getQueryData(sessionQuery.queryKey) as Viewer;
  backendViewer = signedIn('B', null);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => router.invalidate());
  await until(() => host.querySelector('#zone-label-en') !== null);
  expect(host.querySelector<HTMLInputElement>('#zone-label-en')?.value).toBe('Saved notes refreshed');
  expect(button(host, m.zone_editor_save()).disabled).toBe(true);
  expect(oldReader.subject).toBe('A');

  await settle(() => router.navigate({ to: '/my/zones/new' }));
  await until(() => !!host.querySelector('#zone-starter'));
  backendViewer = signedIn('B', csrfB);
  await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
  await settle(() => setInput(host, '#zone-starter', 'book'));
  await settle(() => setInput(host, '#zone-label-en', 'Late draft'));
  const lateCreate = deferred<CommandOutcome>();
  delayedCreateOutcome = lateCreate;
  await settle(() => button(host, m.zones_create_submit({}, { locale: 'en' })).click());
  await until(() => createCalls.length === 2);
  await settle(() => router.navigate({ to: '/my/zones' }));
  await until(() => host.textContent?.includes(m.zones_owner_title({}, { locale: 'en' })) ?? false);
  lateCreate.resolve({ kind: 'saved', zone: fixtureZone(), ownerObservation: createCalls.at(-1)!.capture });
  await flush();
  expect(navigations).toHaveLength(1);
  await settle(() => root.unmount());
});

test('ZoneEditorSession ignores delayed results after error, removal, replacement, ABA, and unmount', async () => {
  const phases = ['load', 'write', 'retry-read', 'preview', 'choices'] as const;
  const retirements = ['error', 'remove', 'replace', 'aba', 'unmount'] as const;
  const results = ['success', 'failure'] as const;
  const observers = new QueryClient();
  observers.setQueryData(sessionQuery.queryKey, signedIn('A', csrfA));
  const shared = new OwnerLifetime(observers, 'shared-observers');
  const first = shared.subscribe(() => {});
  const second = shared.subscribe(() => {});
  const sharedCapture = shared.capture()!;
  first();
  expect(shared.isCurrent(sharedCapture)).toBe(true);
  second();
  expect(shared.capture()).toBeNull();
  observers.clear();

  for (const phase of phases) {
    for (const retirement of retirements) {
      for (const resultKind of results) {
        const client = new QueryClient();
        client.setQueryData(sessionQuery.queryKey, signedIn('A', csrfA));
        const lifetime = new OwnerLifetime(client, `${phase}:${retirement}:${resultKind}`);
        const unsubscribe = lifetime.subscribe(() => {});
        const capture = lifetime.capture()!;
        const initial = structuredClone(editorFixture.initial);
        initial.ownerObservation = capture.observation;
        initial.options.collections = {
          kind: 'ready',
          value: { items: [], next: 'next-page' },
          ownerObservation: capture.observation,
        };
        const loading = deferred<Loaded>();
        const writing = deferred<Result<ZoneOwned>>();
        const previewing = deferred<Preview>();
        const choosing = deferred<Loaded['options']['collections']>();
        let readCalls = 0;
        const transport: Transport = {
          load: () => {
            readCalls += 1;
            return loading.promise;
          },
          mutate: () => writing.promise,
          preview: () => previewing.promise,
          collections: () => choosing.promise,
        };
        const session = new ZoneEditorSession(transport, initial, () => '11111111-1111-4111-8111-111111111111', {
          isCurrent: () => lifetime.isCurrent(capture),
          observation: capture.observation,
          retire: () => lifetime.retire(capture),
        });
        if (phase === 'write' || phase === 'retry-read') {
          const draft = structuredClone(session.snapshot().draft!);
          draft.configuration.labels.en = 'Retired draft';
          session.edit(draft);
        }
        const running =
          phase === 'load'
            ? session.refresh()
            : phase === 'write' || phase === 'retry-read'
              ? session.save()
              : phase === 'preview'
                ? session.preview('')
                : session.moreCollections();
        const pendingState = session.snapshot();
        const failure = {
          kind: 'failure' as const,
          status: 503,
          code: 'dependency_unavailable',
          ownerObservation: capture.observation,
        };
        if (phase === 'retry-read') {
          writing.resolve(failure);
          await Promise.resolve();
          expect(readCalls).toBe(1);
        }
        if (retirement === 'error') {
          client.getQueryCache().find({ queryKey: sessionQuery.queryKey })!.setState({
            status: 'error',
            error: new Error('session read failed'),
          });
        } else if (retirement === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey });
        else if (retirement === 'replace') client.setQueryData(sessionQuery.queryKey, signedIn('B', null));
        else if (retirement === 'aba') {
          client.setQueryData(sessionQuery.queryKey, signedIn('B', csrfB));
          client.setQueryData(sessionQuery.queryKey, signedIn('A', csrfC));
        } else unsubscribe();

        const ready = structuredClone(initial);
        ready.ownerObservation = capture.observation;
        let freshLifetime = lifetime;
        let freshUnsubscribe: (() => void) | undefined;
        if (retirement === 'unmount') {
          client.setQueryData(sessionQuery.queryKey, signedIn('C', csrfC));
          freshLifetime = new OwnerLifetime(client, `${phase}:${retirement}:${resultKind}:fresh`);
          freshUnsubscribe = freshLifetime.subscribe(() => {});
        } else if (!lifetime.capture()) {
          client.setQueryData(sessionQuery.queryKey, signedIn('C', csrfC));
        }
        const freshCapture = freshLifetime.capture()!;
        const freshRead = structuredClone(initial);
        freshRead.ownerObservation = freshCapture.observation;
        if (freshRead.resource.kind === 'ready')
          freshRead.resource.value.configuration.labels.en = 'Fresh reader configuration';
        if (freshRead.options.collections.kind === 'ready')
          freshRead.options.collections.ownerObservation = freshCapture.observation;
        const freshTransport: Transport = {
          load: async () => freshRead,
          mutate: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
          preview: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
          collections: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
        };
        const freshSession = new ZoneEditorSession(freshTransport, freshRead, undefined, {
          isCurrent: () => freshLifetime.isCurrent(freshCapture),
          observation: freshCapture.observation,
          retire: () => freshLifetime.retire(freshCapture),
        });
        const freshState = freshSession.snapshot();
        if (phase === 'load')
          loading.resolve(
            resultKind === 'success'
              ? ready
              : { ...ready, resource: failure },
          );
        else if (phase === 'write')
          writing.resolve(
            resultKind === 'success'
              ? { kind: 'ready', value: ready.resource.kind === 'ready' ? ready.resource.value.zone : fixtureZone(), ownerObservation: capture.observation }
              : failure,
          );
        else if (phase === 'retry-read')
          loading.resolve(
            resultKind === 'success'
              ? ready
              : { ...ready, resource: failure },
          );
        else if (phase === 'preview')
          previewing.resolve(
            resultKind === 'success'
              ? { kind: 'preparing', retryAfter: '1', ownerObservation: capture.observation }
              : failure,
          );
        else
          choosing.resolve(
            resultKind === 'success'
              ? { kind: 'ready', value: { items: [{ id: 'old', title: 'Old private choice' }], next: null }, ownerObservation: capture.observation }
              : failure,
          );
        await running;
        expect(session.snapshot()).toBe(pendingState);
        expect(freshSession.snapshot()).toBe(freshState);
        expect(freshSession.snapshot().busy).toBe(false);
        expect(freshSession.snapshot().saved?.configuration.labels.en).toBe('Fresh reader configuration');
        expect(readCalls).toBe(phase === 'load' || phase === 'retry-read' ? 1 : 0);
        expect(lifetime.isCurrent(capture)).toBe(false);
        if (retirement === 'replace' || retirement === 'aba') expect(lifetime.capture()).not.toBe(capture);
        if (retirement !== 'unmount') unsubscribe();
        freshUnsubscribe?.();
        client.clear();
      }
    }
  }
});
