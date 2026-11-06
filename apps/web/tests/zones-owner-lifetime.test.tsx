// UNRUN: mounted owner-route integration and actual ZoneEditorSession retirement regression.
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type {
  LifecycleMutation,
  LifecycleReading,
  Loaded,
  Mutation,
  Preview,
  Result,
  Transport,
  ZoneOwned,
} from '../src/features/zones/editor/model';
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: (...args: Parameters<typeof window.scrollTo>) => window.scrollTo(...args),
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
type LifecycleData = Omit<LifecycleMutation, 'csrf'> & {
  locale: string;
  expectedReader?: string;
  admission?: string;
};
type OwnedReadArgs<T> = { data: T; headers?: Record<string, string> };

let backendViewer: Viewer = { state: 'signed-in', subject: 'A', csrfToken: null };
let nextEditorRead: ReturnType<typeof deferred<Loaded>> | undefined;
let nextEditorWrite: 'unavailable' | undefined;
let heldEditorWrite: ReturnType<typeof deferred<Result<ZoneOwned>>> | undefined;
let nextEditorLifecycle: 'unavailable' | undefined;
let heldEditorLifecycle: ReturnType<typeof deferred<Result<LifecycleReading>>> | undefined;
let delayedPreview: ReturnType<typeof deferred<Preview>> | undefined;
let delayedChoices: ReturnType<typeof deferred<Loaded['options']['collections']>> | undefined;
const editorReads: ReadData[] = [];
const editorWrites: { data: WriteData; csrf: string | undefined }[] = [];
const editorLifecycles: { data: LifecycleData; csrf: string | undefined }[] = [];
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
    if (heldEditorWrite) {
      const pending = heldEditorWrite;
      heldEditorWrite = undefined;
      return pending.promise;
    }
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
        resource: {
          kind: 'ready',
          value: {
            ...saved,
            zone,
            configuration: structuredClone(data.body.configuration),
            mounts: [...data.body.mounts],
          },
        },
      };
    } else editorLoaded = { ...editorLoaded, resource: { kind: 'ready', value: { ...saved, zone } } };
    return { kind: 'ready', value: zone, ownerObservation: observation };
  },
  writeLifecycle: async ({ data, headers }: OwnedReadArgs<LifecycleData>): Promise<Result<LifecycleReading>> => {
    editorLifecycles.push({ data, csrf: headers?.['X-CSRF-Token'] });
    const observation = responseObservation(data);
    if (
      !observation ||
      !backendViewer.csrfToken ||
      headers?.['X-CSRF-Token'] !== backendViewer.csrfToken ||
      !/^[A-Za-z0-9_-]{22}$/.test(headers?.['X-CSRF-Token'] ?? '')
    )
      return { kind: 'failure', status: 403, code: 'forbidden' };
    if (heldEditorLifecycle) {
      const pending = heldEditorLifecycle;
      heldEditorLifecycle = undefined;
      return pending.promise;
    }
    if (nextEditorLifecycle === 'unavailable') {
      nextEditorLifecycle = undefined;
      return { kind: 'failure', status: 503, code: 'dependency_unavailable', ownerObservation: observation };
    }
    if (editorLoaded.resource.kind !== 'ready') return { kind: 'failure', status: 404, code: 'not_found' };
    const saved = editorLoaded.resource.value;
    if (data.revision !== saved.zone.revision)
      return { kind: 'failure', status: 412, code: 'precondition_failed', ownerObservation: observation };
    const revision = (BigInt(saved.zone.revision) + 1n).toString();
    const deleted = data.operation === 'delete';
    const zone: ZoneOwned = {
      ...saved.zone,
      id: data.id,
      revision,
      deletedAt: deleted ? '2026-11-06T00:00:00.000Z' : null,
      restoreUntil: deleted ? '2026-12-06T00:00:00.000Z' : null,
    };
    editorLoaded = { ...editorLoaded, resource: { kind: 'ready', value: { ...saved, zone } } };
    return {
      kind: 'ready',
      value: { revision: zone.revision, deletedAt: zone.deletedAt, restoreUntil: zone.restoreUntil },
      ownerObservation: observation,
    };
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
const { captureOwnerRead, OwnerLifetime, useOwnerLifetime } =
  await import('../src/features/zones/editor/owner-lifetime');
const { ZoneEditorRoute, loadZoneEditor } = await import('../src/features/zones/editor/route');
const { ZoneEditorSession } = await import('../src/features/zones/editor/model');
const { ZonesOwnerWorkspace } = await import('../src/features/zones/manage/workspace');
const { CreateZone } = await import('../src/features/zones/manage/create');
const { ZonesRouteError } = await import('../src/features/zones/manage/route-feedback');
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
const lifecycleCalls: {
  command: import('../src/features/zones/manage/model').LifecycleCommand;
  capture?: OwnerReadObservation;
}[] = [];
async function changeZone(
  command: import('../src/features/zones/manage/model').LifecycleCommand,
  capture?: import('../src/features/zones/editor/owner-lifetime').OwnerCapture,
): Promise<CommandOutcome> {
  lifecycleCalls.push({ command, ...(capture ? { capture: capture.observation } : {}) });
  if (!capture) return { kind: 'stale' };
  return changeOwnedZone(managed.client, request('POST', capture.csrfToken), sessionEnv, command, capture.observation);
}
const createCalls: {
  command: import('../src/features/zones/manage/model').CreateCommand;
  capture?: OwnerReadObservation;
}[] = [];
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
  const { lifetime, snapshot } = useOwnerLifetime(location.pathname + JSON.stringify(location.search), requestedOwner);
  const current =
    !!snapshot.capture &&
    requestedOwner?.reader === snapshot.capture.observation.reader &&
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
let routeFeedbackLoads = 0;
const routeFeedbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/my/zones/recovery',
  loader: async () => {
    if (routeFeedbackLoads++ === 0) throw new Error('Temporary route failure');
  },
  errorComponent: ZonesRouteError,
  component: () => <p>Fresh authorized page</p>,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([listRoute, newRoute, editRoute, routeFeedbackRoute]),
  history: createMemoryHistory({ initialEntries: ['/my/zones'] }),
  context: { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
});
const queryClient = router.options.context.queryClient;
const navigations: string[] = [];

async function withActBudget<T>(work: () => Promise<T>, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Mounted Zone journey did not settle')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const settle = async (action: () => void | Promise<void>) =>
  withActBudget(() =>
    act(async () => {
      await action();
    }),
  );
const flush = async () =>
  withActBudget(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
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
// Resolve only the starter label's own native control inside this existing visit.
function starterSelector(host: HTMLElement): string {
  const label = [...host.querySelectorAll('label')].find(
    (node) => node.textContent?.trim() === m.zones_create_starter({}, { locale: 'en' }),
  );
  return `select[id="${label?.htmlFor ?? ''}"]`;
}
function setInput(host: HTMLElement, selector: string, value: string) {
  const target = host.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!target) throw new Error(`Missing input: ${selector}`);
  target.value = value;
  target.dispatchEvent(
    new window.Event(target instanceof window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }),
  );
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
  try {
    await settle(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
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
    await until(() => !!host.querySelector(starterSelector(host)));
    await settle(() => setInput(host, starterSelector(host), 'book'));
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
    await until(() => !!host.querySelector(starterSelector(host)));
    backendViewer = signedIn('B', csrfB);
    await settle(() => queryClient.setQueryData(sessionQuery.queryKey, backendViewer));
    await settle(() => setInput(host, starterSelector(host), 'book'));
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
  } finally {
    try {
      root.unmount();
    } catch {
      /* already unmounted */
    }
    host.remove();
  }
}, 30_000);

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
          lifecycle: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
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
          client
            .getQueryCache()
            .find({ queryKey: sessionQuery.queryKey })!
            .setState({
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
          lifecycle: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
          preview: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
          collections: async () => ({ kind: 'failure', status: 503, code: 'dependency_unavailable' }),
        };
        const freshSession = new ZoneEditorSession(freshTransport, freshRead, undefined, {
          isCurrent: () => freshLifetime.isCurrent(freshCapture),
          observation: freshCapture.observation,
          retire: () => freshLifetime.retire(freshCapture),
        });
        const freshState = freshSession.snapshot();
        if (phase === 'load') loading.resolve(resultKind === 'success' ? ready : { ...ready, resource: failure });
        else if (phase === 'write')
          writing.resolve(
            resultKind === 'success'
              ? {
                  kind: 'ready',
                  value: ready.resource.kind === 'ready' ? ready.resource.value.zone : fixtureZone(),
                  ownerObservation: capture.observation,
                }
              : failure,
          );
        else if (phase === 'retry-read')
          loading.resolve(resultKind === 'success' ? ready : { ...ready, resource: failure });
        else if (phase === 'preview')
          previewing.resolve(
            resultKind === 'success'
              ? { kind: 'preparing', retryAfter: '1', ownerObservation: capture.observation }
              : failure,
          );
        else
          choosing.resolve(
            resultKind === 'success'
              ? {
                  kind: 'ready',
                  value: { items: [{ id: 'old', title: 'Old private choice' }], next: null },
                  ownerObservation: capture.observation,
                }
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

test('mounted editor lifecycle stays on its captured owner visit after replacement', async () => {
  const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
  try {
    const pending = deferred<Result<LifecycleReading>>();
    heldEditorLifecycle = pending;
    const before = editorLifecycles.length;
    await settle(() => button(visit.host, 'Delete zone').click());
    await until(() => editorLifecycles.length === before + 1);
    backendViewer = signedIn('B', csrfB);
    await settle(() => visit.client.setQueryData(sessionQuery.queryKey, backendViewer));
    pending.resolve({
      kind: 'ready',
      value: { revision: '2', deletedAt: '2026-11-06T00:00:00.000Z', restoreUntil: '2026-12-06T00:00:00.000Z' },
      ownerObservation: {
        reader: editorLifecycles[before]!.data.expectedReader!,
        admission: editorLifecycles[before]!.data.admission!,
      },
    });
    await flush();
    expect(visit.host.textContent).not.toContain('Restore zone');
  } finally {
    await visit.close();
  }
});

// UNRUN: connected original-visit regressions. These retain real rendered handlers and
// invoke them in the SAME stack as a cache/route change, before React can run effects.
const { getLocale } = await import('../src/paraglide/runtime.js');
const { notifyManager } = await import('@tanstack/react-query');
type BrowserCapture = NonNullable<Parameters<typeof createZone>[1]>;
type CreateInput = Parameters<typeof createZone>[0];
type LifecycleInput = Parameters<typeof changeZone>[0];
function retainHandler(element: Element, name = 'onClick'): () => void {
  const key = Object.keys(element).find((key) => key.startsWith('__reactProps$'));
  const handler = key && Reflect.get(element, key)?.[name];
  if (typeof handler !== 'function') throw new Error(`Missing mounted React ${name}`);
  return () => {
    const nativeEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    handler({
      nativeEvent,
      target: element,
      currentTarget: element,
      get defaultPrevented() {
        return nativeEvent.defaultPrevented;
      },
      preventDefault: () => nativeEvent.preventDefault(),
      stopPropagation: () => nativeEvent.stopPropagation(),
      isPropagationStopped: () => false,
      isDefaultPrevented: () => nativeEvent.defaultPrevented,
      persist: () => {},
    });
  };
}
function trashConfirmation(): HTMLButtonElement {
  const node = [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(
    (node) => node.textContent?.trim() === m.zones_owner_trash_action({}, { locale: 'en' }),
  );
  if (!node) throw new Error('Missing mounted trash confirmation');
  return node;
}
async function mountedVisit(path: string, strict = false, scenario: 'list' | 'trash' | 'uncertain' = 'list') {
  setLocale('en', { reload: false });
  backendViewer = signedIn('A', csrfA);
  editorLoaded = structuredClone(editorFixture.initial);
  if (editorLoaded.options.collections.kind === 'ready') editorLoaded.options.collections.value.next = 'bounded-next';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, backendViewer);
  const native = zonesFixture(scenario);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const state = {
    owner: null as InstanceType<typeof OwnerLifetime> | null,
    creates: [] as { input: CreateInput; capture: BrowserCapture }[],
    changes: [] as { input: LifecycleInput; capture: BrowserCapture }[],
    navigations: [] as string[],
    reloads: 0,
    reads: 0,
    admissions: [] as OwnerReadObservation[],
    commandGate: undefined as ReturnType<typeof deferred<CommandOutcome>> | undefined,
    readGate: undefined as ReturnType<typeof deferred<ListOutcome>> | undefined,
    reloadGate: undefined as ReturnType<typeof deferred<void>> | undefined,
    stopped: false,
  };
  const base = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()({ component: Outlet });
  const search = (input: Record<string, unknown>) => ({
    ...(String(input.trash) === '1' ? { trash: '1' } : {}),
    ...(typeof input.marker === 'string' && input.marker ? { marker: input.marker } : {}),
  });
  function List() {
    const location = useLocation();
    const { outcome, requestedOwner } = useLoaderData({ strict: false }) as {
      outcome: ListOutcome;
      requestedOwner: OwnerReadObservation | null;
    };
    const { lifetime } = useOwnerLifetime(
      JSON.stringify([getLocale(), location.pathname, location.search]),
      requestedOwner,
    );
    state.owner = lifetime;
    return (
      <ZonesOwnerWorkspace
        locale={getLocale()}
        input={{ deleted: String((location.search as { trash?: unknown }).trash) === '1' }}
        owner={lifetime}
        outcome={outcome}
        onChange={async (input, capture) => {
          if (!capture) throw new Error('Missing command capture');
          state.changes.push({ input: structuredClone(input), capture });
          const gate = state.commandGate;
          state.commandGate = undefined;
          const result = await changeOwnedZone(
            native.client,
            request('POST', capture.csrfToken),
            sessionEnv,
            input,
            capture.observation,
          );
          return gate ? gate.promise : result;
        }}
        onReload={() => {
          state.reloads++;
          const gate = state.reloadGate;
          state.reloadGate = undefined;
          return gate ? gate.promise : visitRouter.invalidate();
        }}
      />
    );
  }
  function Create() {
    const location = useLocation();
    const { lifetime } = useOwnerLifetime(JSON.stringify([getLocale(), location.pathname, location.search]));
    state.owner = lifetime;
    return (
      <CreateZone
        locale={getLocale()}
        session="signed-in"
        owner={lifetime}
        onCreate={async (input, capture) => {
          if (!capture) throw new Error('Missing create capture');
          state.creates.push({ input: structuredClone(input), capture });
          const gate = state.commandGate;
          state.commandGate = undefined;
          const result = await createOwnedZone(
            native.client,
            request('POST', capture.csrfToken),
            sessionEnv,
            input,
            capture.observation,
          );
          return gate ? gate.promise : result;
        }}
        onNavigate={(href) => {
          state.navigations.push(href);
          void visitRouter.navigate({ to: '/my/zones/$id/edit', params: { id: href.split('/').at(-2)! } });
        }}
      />
    );
  }
  function Edit() {
    const { id } = useParams({ strict: false }) as { id: string };
    const location = useLocation();
    const data = useLoaderData({ strict: false }) as Awaited<ReturnType<typeof loadZoneEditor>>;
    return (
      <ZoneEditorRoute
        id={id}
        locale={getLocale()}
        initial={data.initial}
        requestedOwner={data.requestedOwner}
        readMatchesRoute={
          data.loadedFor.id === id &&
          data.loadedFor.locale === getLocale() &&
          data.loadedFor.search === JSON.stringify(location.search)
        }
      />
    );
  }
  const list = createRoute({
    getParentRoute: () => base,
    path: '/my/zones',
    validateSearch: search,
    loaderDeps: ({ search }) => search,
    loader: async ({ context, deps, abortController }) => {
      state.reads++;
      const requestedOwner = captureOwnerRead(context.queryClient, abortController.signal);
      if (requestedOwner) state.admissions.push(requestedOwner);
      const gate = state.readGate;
      state.readGate = undefined;
      const result = requestedOwner
        ? await readOwnedZones(
            native.client,
            request('GET', backendViewer.csrfToken),
            sessionEnv,
            { deleted: deps.trash === '1' },
            requestedOwner,
          )
        : { kind: 'signed-out' as const };
      return { outcome: gate ? await gate.promise : result, requestedOwner };
    },
    component: List,
  });
  const create = createRoute({
    getParentRoute: () => base,
    path: '/my/zones/new',
    validateSearch: search,
    component: Create,
  });
  const edit = createRoute({
    getParentRoute: () => base,
    path: '/my/zones/$id/edit',
    validateSearch: search,
    loaderDeps: ({ search }) => search,
    loader: ({ params, context, deps, abortController }) =>
      loadZoneEditor(params.id, getLocale(), context.queryClient, deps, abortController.signal),
    component: Edit,
  });
  const other = createRoute({ getParentRoute: () => base, path: '/elsewhere', component: () => <p>Other visit</p> });
  const visitRouter = createRouter({
    routeTree: base.addChildren([list, create, edit, other]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: { queryClient: client },
  });
  await settle(() =>
    root.render(
      <QueryClientProvider client={client}>
        {strict ? (
          <StrictMode>
            <RouterProvider router={visitRouter} />
          </StrictMode>
        ) : (
          <RouterProvider router={visitRouter} />
        )}
      </QueryClientProvider>,
    ),
  );
  await until(() =>
    path.includes('/edit')
      ? !!host.querySelector('#zone-label-en')
      : path.includes('/new')
        ? !!host.querySelector(starterSelector(host))
        : !!host.querySelector('article'),
  );
  return {
    state,
    client,
    native,
    host,
    root,
    router: visitRouter,
    async close() {
      if (!state.stopped)
        await settle(() => {
          root.unmount();
          state.stopped = true;
        });
      client.clear();
      host.remove();
    },
  };
}
type MountedVisit = Awaited<ReturnType<typeof mountedVisit>>;
type SessionChange = 'equal-query' | 'csrf-only' | 'aba' | 'error' | 'remove';
function changeSessionBeforeEffects(visit: MountedVisit, change: SessionChange) {
  const query = visit.client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true })!;
  const original = query.state;
  if (change === 'equal-query') {
    // Actual new Query, byte-identical session data, timestamps AND update count.
    visit.client.getQueryCache().remove(query);
    visit.client.getQueryCache().build(visit.client, sessionQuery, original);
  } else if (change === 'csrf-only') {
    backendViewer = signedIn('A', csrfB);
    query.setState({ data: backendViewer });
  } else if (change === 'aba')
    notifyManager.batch(() => {
      query.setState({ data: signedIn('B', csrfB) });
      query.setState(original);
    });
  else if (change === 'error') query.setState({ status: 'error', error: new Error('session unavailable') });
  else visit.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
}
async function fillCreate(visit: MountedVisit, label = 'Original private draft') {
  await settle(() => setInput(visit.host, starterSelector(visit.host), 'book'));
  await settle(() => setInput(visit.host, '#zone-label-en', label));
}
function totals(visit: MountedVisit) {
  return [
    visit.native.calls.length,
    visit.state.reloads,
    visit.state.navigations.length,
    editorReads.length,
    editorWrites.length,
    editorPreviews.length,
    editorChoices.length,
  ];
}

for (const change of ['equal-query', 'csrf-only', 'aba', 'error', 'remove'] as const) {
  test(`UNRUN mounted create and uncertain retry refuse ${change} synchronously`, async () => {
    for (const uncertain of [false, true]) {
      const visit = await mountedVisit('/my/zones/new', false, 'uncertain');
      try {
        await fillCreate(visit);
        const originalSubmit = retainHandler(visit.host.querySelector('form')!, 'onSubmit');
        if (uncertain) {
          await settle(originalSubmit);
          await until(() => visit.host.textContent?.includes(m.zones_create_uncertain({}, { locale: 'en' })) ?? false);
          expect(visit.state.creates).toHaveLength(1);
        }
        const callback = uncertain
          ? retainHandler(button(visit.host, m.zones_owner_retry({}, { locale: 'en' })))
          : originalSubmit;
        const before = totals(visit);
        await settle(() => {
          changeSessionBeforeEffects(visit, change);
          callback();
          originalSubmit(); // A separately retained pre-busy submit cannot reconstruct the command.
        });
        expect(totals(visit)).toEqual(before);
        expect(visit.host.textContent).not.toContain('Original private draft');
        expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Original private draft');
        expect(visit.host.textContent).not.toContain(m.zones_create_uncertain({}, { locale: 'en' }));
        // A fresh admission, including one that returns to the very same reader, is usable.
        backendViewer = signedIn('A', csrfC);
        await settle(() => visit.client.setQueryData(sessionQuery.queryKey, backendViewer));
        await until(() => !!visit.host.querySelector(starterSelector(visit.host)));
        await fillCreate(visit, 'Fresh private site');
        await settle(() => button(visit.host, m.zones_create_submit({}, { locale: 'en' })).click());
        await until(() => visit.state.creates.length === (uncertain ? 2 : 1));
        expect(visit.state.creates.at(-1)!.capture.csrfToken).toBe(csrfC);
        if (uncertain) {
          expect(visit.state.creates[1]!.input.key).not.toBe(visit.state.creates[0]!.input.key);
          expect(visit.state.creates[1]!.capture.observation.admission).not.toBe(
            visit.state.creates[0]!.capture.observation.admission,
          );
        }
      } finally {
        await visit.close();
      }
    }
  });

  test(`UNRUN mounted list confirmation, retry and refresh refuse ${change} before effects`, async () => {
    for (const action of ['confirmation', 'retry', 'refresh', 'restore'] as const) {
      const visit = await mountedVisit(
        action === 'restore' ? '/my/zones?trash=1' : '/my/zones',
        false,
        action === 'restore' ? 'trash' : action === 'retry' ? 'uncertain' : 'list',
      );
      try {
        let callback: () => void;
        if (action === 'confirmation' || action === 'retry') {
          await settle(() => button(visit.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
          callback = retainHandler(trashConfirmation());
          if (action === 'retry') {
            await settle(callback);
            await until(
              () => visit.host.textContent?.includes(m.zones_owner_unavailable({}, { locale: 'en' })) ?? false,
            );
            callback = retainHandler(button(visit.host, m.zones_owner_retry({}, { locale: 'en' })));
          }
        } else
          callback = retainHandler(
            button(
              visit.host,
              action === 'restore'
                ? m.zones_owner_restore({}, { locale: 'en' })
                : m.zones_owner_refresh({}, { locale: 'en' }),
            ),
          );
        const before = totals(visit);
        await settle(() => {
          changeSessionBeforeEffects(visit, change);
          callback();
        });
        expect(totals(visit)).toEqual(before);
        expect(visit.host.querySelector('[data-slot="content-item"]')).toBeNull();
        expect(visit.host.textContent).not.toContain(fixtureZone().labels.en!);
        expect(document.querySelector('[role="alertdialog"]')).toBeNull();
        expect(visit.host.textContent).not.toContain(m.zones_owner_unavailable({}, { locale: 'en' }));
        backendViewer = signedIn('A', csrfC);
        await settle(() => visit.client.setQueryData(sessionQuery.queryKey, backendViewer));
        await settle(() => visit.router.invalidate());
        await until(() => !!visit.host.querySelector('article'));
        const count = visit.state.reloads;
        await settle(() => button(visit.host, m.zones_owner_refresh({}, { locale: 'en' })).click());
        expect(visit.state.reloads).toBe(count + 1);
      } finally {
        await visit.close();
      }
    }
  });

  test(`UNRUN connected editor callbacks and drafts retire on ${change} without transport`, async () => {
    const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
    try {
      const preview = retainHandler(button(visit.host, m.zone_editor_preview()));
      const choices = retainHandler(button(visit.host, m.zone_editor_more()));
      const refresh = retainHandler(button(visit.host, m.zone_editor_refresh()));
      await settle(() => setInput(visit.host, '#zone-visibility', 'public'));
      const publish = retainHandler(button(visit.host, m.zone_editor_publish()));
      await settle(() => setInput(visit.host, '#zone-label-en', 'Old secret editor draft'));
      const save = retainHandler(button(visit.host, m.zone_editor_save()));
      const before = totals(visit);
      await settle(() => {
        changeSessionBeforeEffects(visit, change);
        preview();
        choices();
        refresh();
        save();
        publish();
      });
      expect(totals(visit).slice(0, 3)).toEqual(before.slice(0, 3));
      // Only the route's one bounded replacement initial read is allowed; no old callback transport.
      expect(editorWrites.length).toBe(before[4]!);
      expect(editorPreviews.length).toBe(before[5]!);
      expect(editorChoices.length).toBe(before[6]!);
      expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Old secret editor draft');
      backendViewer = signedIn('A', csrfC);
      await settle(() => visit.client.setQueryData(sessionQuery.queryKey, backendViewer));
      await settle(() => visit.router.invalidate());
      await until(() => !!visit.host.querySelector('#zone-label-en'));
      await settle(() => setInput(visit.host, '#zone-label-en', 'Current editor work'));
      await settle(() => button(visit.host, m.zone_editor_save()).click());
      await until(() => editorWrites.length === before[4]! + 1);
      expect(editorWrites.at(-1)!.csrf).toBe(csrfC);
    } finally {
      await visit.close();
    }
  });
}

for (const strict of [false, true]) {
  test(`UNRUN healthy reader rerenders and ${strict ? 'StrictMode replay' : 'ordinary mounts'} preserve exact uncertain commands`, async () => {
    const create = await mountedVisit('/my/zones/new', strict, 'uncertain');
    try {
      await fillCreate(create, 'Unchanged request body');
      const submit = retainHandler(create.host.querySelector('form')!, 'onSubmit');
      await settle(submit);
      await until(() => create.host.textContent?.includes(m.zones_create_uncertain({}, { locale: 'en' })) ?? false);
      const retry = retainHandler(button(create.host, m.zones_owner_retry({}, { locale: 'en' })));
      const before = totals(create);
      await settle(() => {
        // A healthy cache notification and unrelated Query must not retire the reader.
        create.client
          .getQueryCache()
          .find({ queryKey: sessionQuery.queryKey, exact: true })!
          .setState({ fetchStatus: 'idle' });
        create.client.setQueryData(['unrelated-zone-control'], 1);
        submit(); // Pre-uncertainty callback cannot issue a second command/key.
      });
      expect(totals(create)).toEqual(before);
      await settle(retry);
      await until(() => create.state.creates.length === 2 && create.state.navigations.length === 1);
      expect(create.state.creates[1]!.input).toEqual(create.state.creates[0]!.input);
      expect(create.state.creates[1]!.capture).toBe(create.state.creates[0]!.capture);
      const writes = create.native.calls.filter((call) => call.method === 'POST');
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]); // Native body, key, authorization, URL and method.
    } finally {
      await create.close();
    }
    const list = await mountedVisit('/my/zones', strict, 'uncertain');
    try {
      await settle(() => button(list.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
      await settle(() => trashConfirmation().click());
      await until(() => list.host.textContent?.includes(m.zones_owner_unavailable({}, { locale: 'en' })) ?? false);
      await settle(() => button(list.host, m.zones_owner_retry({}, { locale: 'en' })).click());
      await until(() => list.state.changes.length === 2);
      expect(list.state.changes[1]!.input).toEqual(list.state.changes[0]!.input);
      expect(list.state.changes[1]!.capture).toBe(list.state.changes[0]!.capture);
      const writes = list.native.calls.filter((call) => call.method === 'DELETE');
      expect(writes).toHaveLength(2);
      expect(writes[1]).toEqual(writes[0]);
    } finally {
      await list.close();
    }
    const editor = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`, strict);
    try {
      await settle(() => setInput(editor.host, '#zone-label-en', 'Immutable saved body'));
      const start = editorWrites.length;
      nextEditorWrite = 'unavailable';
      await settle(() => button(editor.host, m.zone_editor_save()).click());
      await until(() => editorWrites.length === start + 1 && !editor.host.querySelector('[aria-busy="true"]'));
      const original = structuredClone(editorWrites[start]!);
      await settle(() => editor.client.setQueryData(['healthy-rerender'], 1));
      await settle(() => button(editor.host, m.zone_editor_save()).click());
      await until(() => editorWrites.length === start + 2);
      expect(editorWrites[start + 1]).toEqual(original); // Native ID, revision, body, key, locale, admission and CSRF.
      expect(editor.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).toBe('Immutable saved body');
    } finally {
      await editor.close();
    }
  });
}

for (const change of ['equal-query', 'csrf-only', 'aba'] as const) {
  for (const result of ['success', 'failure', 'throw'] as const) {
    test(`UNRUN late create/list ${result} after ${change} cannot navigate, reload, focus or clear new busy state`, async () => {
      for (const surface of ['create', 'list', 'restore'] as const) {
        const visit = await mountedVisit(
          surface === 'create' ? '/my/zones/new' : surface === 'restore' ? '/my/zones?trash=1' : '/my/zones',
          false,
          surface === 'restore' ? 'trash' : 'list',
        );
        const gate = deferred<CommandOutcome>();
        try {
          visit.state.commandGate = gate;
          if (surface === 'create') {
            await fillCreate(visit);
            await settle(() => button(visit.host, m.zones_create_submit({}, { locale: 'en' })).click());
          } else if (surface === 'list') {
            await settle(() => button(visit.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
            await settle(() => trashConfirmation().click());
          } else await settle(() => button(visit.host, m.zones_owner_restore({}, { locale: 'en' })).click());
          await until(
            () =>
              visit.state.creates.length + visit.state.changes.length === 1 &&
              visit.native.calls.some((call) => call.method !== 'GET'),
          );
          const oldCapture = (visit.state.creates[0] ?? visit.state.changes[0])!.capture;
          await settle(() => changeSessionBeforeEffects(visit, change));
          let fresh: ReturnType<typeof deferred<CommandOutcome>> | undefined;
          if (surface === 'create') {
            await until(() => !!visit.host.querySelector(starterSelector(visit.host)));
            await fillCreate(visit, 'New pending draft');
            fresh = deferred<CommandOutcome>();
            visit.state.commandGate = fresh;
            await settle(() => button(visit.host, m.zones_create_submit({}, { locale: 'en' })).click());
            await until(() => visit.state.creates.length === 2);
          }
          const before = totals(visit);
          let focus = 0;
          const originalFocus = window.HTMLElement.prototype.focus;
          window.HTMLElement.prototype.focus = function (...args) {
            focus++;
            return originalFocus.apply(this, args);
          };
          try {
            if (result === 'throw') gate.reject(new Error('Original private command lost'));
            else
              gate.resolve(
                result === 'success'
                  ? { kind: 'saved', zone: fixtureZone(), ownerObservation: oldCapture.observation }
                  : { kind: 'unavailable', ownerObservation: oldCapture.observation },
              );
            await flush();
            expect(totals(visit)).toEqual(before);
            expect(focus).toBe(0);
            expect(visit.host.textContent).not.toContain(m.zones_create_saved({}, { locale: 'en' }));
            expect(visit.host.textContent).not.toContain(m.zones_owner_trashed({}, { locale: 'en' }));
            expect(visit.host.textContent).not.toContain(m.zones_owner_restored({}, { locale: 'en' }));
            if (surface === 'create') {
              expect(visit.host.querySelector('form')?.getAttribute('aria-busy')).toBe('true');
              expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).toBe('New pending draft');
            }
          } finally {
            window.HTMLElement.prototype.focus = originalFocus;
          }
          if (fresh) {
            const newCapture = visit.state.creates[1]!.capture;
            fresh.resolve({ kind: 'unavailable', ownerObservation: newCapture.observation });
            await flush();
            expect(visit.host.querySelector('form')?.getAttribute('aria-busy')).toBe('false');
            expect(visit.state.creates[1]!.input.key).not.toBe(visit.state.creates[0]!.input.key);
          }
        } finally {
          await visit.close();
        }
      }
    });
  }
}

for (const phase of ['write', 'retry-read', 'preview', 'choices', 'read'] as const) {
  for (const result of ['success', 'failure', 'throw'] as const) {
    test(`UNRUN connected late editor ${phase}/${result} stays hidden and cannot start secondary work`, async () => {
      const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
      const writing = deferred<Result<ZoneOwned>>();
      const reading = deferred<Loaded>();
      const previewing = deferred<Preview>();
      const choosing = deferred<Loaded['options']['collections']>();
      try {
        if (phase === 'write' || phase === 'retry-read') {
          await settle(() => setInput(visit.host, '#zone-label-en', 'Private retired write'));
          heldEditorWrite = writing;
          await settle(() => button(visit.host, m.zone_editor_save()).click());
        } else if (phase === 'read') {
          nextEditorRead = reading;
          await settle(() => button(visit.host, m.zone_editor_refresh()).click());
        } else if (phase === 'preview') {
          delayedPreview = previewing;
          await settle(() => button(visit.host, m.zone_editor_preview()).click());
        } else {
          delayedChoices = choosing;
          await settle(() => button(visit.host, m.zone_editor_more()).click());
        }
        const call =
          phase === 'write' || phase === 'retry-read'
            ? editorWrites.at(-1)!.data
            : phase === 'preview'
              ? editorPreviews.at(-1)!
              : phase === 'choices'
                ? editorChoices.at(-1)!
                : editorReads.at(-1)!;
        const ownerObservation = { reader: call.expectedReader!, admission: call.admission! };
        const failure = { kind: 'failure' as const, status: 503, code: 'old_private_failure', ownerObservation };
        if (phase === 'retry-read') {
          nextEditorRead = reading;
          const count = editorReads.length;
          writing.resolve(failure);
          await until(() => editorReads.length === count + 1);
        }
        await settle(() => changeSessionBeforeEffects(visit, 'equal-query'));
        await until(() => !!visit.host.querySelector('#zone-label-en'));
        await settle(() => setInput(visit.host, '#zone-label-en', 'Replacement live draft'));
        // Keep a replacement command busy while the original finishes.
        const freshWrite = deferred<Result<ZoneOwned>>();
        heldEditorWrite = freshWrite;
        await settle(() => button(visit.host, m.zone_editor_save()).click());
        const before = totals(visit);
        const old = loadedFor(fixtureZoneId, ownerObservation);
        if (old.resource.kind === 'ready') old.resource.value.configuration.labels.en = 'Old private result';
        const pending =
          phase === 'write' ? writing : phase === 'preview' ? previewing : phase === 'choices' ? choosing : reading;
        if (result === 'throw') pending.reject(new Error('Old private read rejected'));
        else if (phase === 'write')
          writing.resolve(result === 'success' ? { kind: 'ready', value: fixtureZone(), ownerObservation } : failure);
        else if (phase === 'preview')
          previewing.resolve(
            result === 'success' ? { kind: 'preparing', retryAfter: 'private-old-delay', ownerObservation } : failure,
          );
        else if (phase === 'choices')
          choosing.resolve(
            result === 'success'
              ? {
                  kind: 'ready',
                  value: { items: [{ id: 'old', title: 'Old private choice' }], next: null },
                  ownerObservation,
                }
              : failure,
          );
        else reading.resolve(result === 'success' ? old : { ...old, resource: failure });
        await flush();
        expect(totals(visit)).toEqual(before);
        expect(visit.host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
        expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).toBe('Replacement live draft');
        for (const hidden of ['Old private result', 'Old private choice', 'old_private_failure', 'private-old-delay'])
          expect(visit.host.textContent).not.toContain(hidden);
        const freshCall = editorWrites.at(-1)!.data;
        freshWrite.resolve({
          kind: 'ready',
          value: fixtureZone(),
          ownerObservation: {
            reader: freshCall.expectedReader!,
            admission: freshCall.admission!,
          },
        });
        await until(() => visit.host.querySelector('article')?.getAttribute('aria-busy') === 'false');
      } finally {
        await visit.close();
      }
    });
  }
}

for (const transition of ['route', 'id', 'search', 'locale', 'unmount'] as const) {
  test(`UNRUN retained private callbacks retire on ${transition}, including a return to the same address`, async () => {
    for (const surface of ['create', 'list', 'editor'] as const) {
      const start =
        surface === 'create' ? '/my/zones/new' : surface === 'list' ? '/my/zones' : `/my/zones/${fixtureZoneId}/edit`;
      const visit = await mountedVisit(start);
      try {
        const callbacks: (() => void)[] = [];
        if (surface === 'create') {
          await fillCreate(visit, 'Old address draft');
          callbacks.push(retainHandler(visit.host.querySelector('form')!, 'onSubmit'));
        } else if (surface === 'list') {
          callbacks.push(retainHandler(button(visit.host, m.zones_owner_refresh({}, { locale: 'en' }))));
          await settle(() => button(visit.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
          callbacks.push(retainHandler(trashConfirmation()));
        } else {
          callbacks.push(
            retainHandler(button(visit.host, m.zone_editor_preview())),
            retainHandler(button(visit.host, m.zone_editor_more())),
            retainHandler(button(visit.host, m.zone_editor_refresh())),
          );
        }
        let before: number[] = [];
        const invoke = () => {
          before = totals(visit);
          for (const callback of callbacks) callback();
          expect(totals(visit)).toEqual(before);
        };
        if (transition === 'unmount')
          await settle(() => {
            visit.root.unmount();
            visit.state.stopped = true;
            invoke();
          });
        else if (transition === 'locale') {
          await settle(() => {
            setLocale('ja', { reload: false });
            invoke();
          });
          setLocale('en', { reload: false });
          // Returning to the original locale never revives its retired work.
          await settle(invoke);
        } else {
          const stop = visit.router.subscribe('onBeforeNavigate', invoke);
          try {
            if (transition === 'search')
              await settle(() => visit.router.navigate({ to: start, search: { marker: 'replacement' } }));
            else if (transition === 'id' && surface === 'editor')
              await settle(() =>
                visit.router.navigate({
                  to: '/my/zones/$id/edit',
                  params: { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e71' },
                }),
              );
            else await settle(() => visit.router.navigate({ to: '/elsewhere' }));
          } finally {
            stop();
          }
          // Invoke once more after the original controls have genuinely left the tree.
          await settle(invoke);
          await settle(() => visit.router.navigate({ to: start }));
          await settle(invoke);
          expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Old address draft');
        }
      } finally {
        setLocale('en', { reload: false });
        await visit.close();
      }
    }
  });
}

test('UNRUN original loader completions cannot install private data on an equal-counter replacement Query', async () => {
  for (const surface of ['list', 'editor'] as const) {
    const visit = await mountedVisit(surface === 'list' ? '/my/zones' : `/my/zones/${fixtureZoneId}/edit`);
    try {
      let reload: Promise<unknown> | undefined;
      const listGate = deferred<ListOutcome>();
      const editorGate = deferred<Loaded>();
      if (surface === 'list') visit.state.readGate = listGate;
      else nextEditorRead = editorGate;
      const count = surface === 'list' ? visit.state.reads : editorReads.length;
      // Start a real router loader. Its completion carries its original requested reader.
      await settle(() => {
        reload = visit.router.invalidate();
      });
      await until(() => (surface === 'list' ? visit.state.reads : editorReads.length) === count + 1);
      const oldObservation =
        surface === 'list'
          ? visit.state.admissions.at(-1)!
          : {
              reader: editorReads.at(-1)!.expectedReader!,
              admission: editorReads.at(-1)!.admission!,
            };
      await settle(() => changeSessionBeforeEffects(visit, 'equal-query'));
      if (surface === 'list')
        listGate.resolve({
          kind: 'ready',
          page: {
            zones: [{ ...fixtureZone(), labels: { en: 'Secret old loader list' } }],
            next: null,
          },
          ownerObservation: oldObservation,
        });
      else {
        const old = loadedFor(fixtureZoneId, oldObservation);
        if (old.resource.kind === 'ready') old.resource.value.configuration.labels.en = 'Secret old loader editor';
        editorGate.resolve(old);
      }
      await settle(async () => {
        await reload;
      });
      expect(visit.host.textContent).not.toContain('Secret old loader list');
      expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Secret old loader editor');
      if (surface === 'list') await settle(() => visit.router.invalidate());
      await until(() =>
        surface === 'list' ? !!visit.host.querySelector('article') : !!visit.host.querySelector('#zone-label-en'),
      );
      expect(visit.host.textContent).not.toContain('Secret old loader list');
      expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Secret old loader editor');
    } finally {
      await visit.close();
    }
  }
});

test('UNRUN editor uncertain retries cannot adopt a replacement token or Query before effects', async () => {
  for (const change of ['equal-query', 'csrf-only', 'aba'] as const) {
    const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
    try {
      await settle(() => setInput(visit.host, '#zone-label-en', 'Frozen original editor command'));
      nextEditorWrite = 'unavailable';
      const count = editorWrites.length;
      await settle(() => button(visit.host, m.zone_editor_save()).click());
      await until(() => editorWrites.length === count + 1 && !visit.host.querySelector('[aria-busy="true"]'));
      const original = structuredClone(editorWrites[count]!);
      const retry = retainHandler(button(visit.host, m.zone_editor_save()));
      await settle(() => {
        changeSessionBeforeEffects(visit, change);
        retry();
      });
      expect(editorWrites.length).toBe(count + 1);
      await until(() => !!visit.host.querySelector('#zone-label-en'));
      expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe(
        'Frozen original editor command',
      );
      await settle(() => setInput(visit.host, '#zone-label-en', 'Fresh explicit editor command'));
      await settle(() => button(visit.host, m.zone_editor_save()).click());
      await until(() => editorWrites.length === count + 2);
      const fresh = editorWrites[count + 1]!;
      expect(fresh.data.key).not.toBe(original.data.key);
      expect(fresh.data.admission).not.toBe(original.data.admission);
      expect(fresh.data.id).toBe(original.data.id);
      expect(fresh.data.operation === 'save' && fresh.data.body.configuration.labels.en).toBe(
        'Fresh explicit editor command',
      );
    } finally {
      await visit.close();
    }
  }
});

test('UNRUN queued focus and a late list refresh finally cannot affect a new admission', async () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalFocus = window.HTMLElement.prototype.focus;
  const queued: FrameRequestCallback[] = [];
  let focuses = 0;
  globalThis.requestAnimationFrame = (callback) => {
    queued.push(callback);
    return queued.length;
  };
  window.HTMLElement.prototype.focus = function (...args) {
    focuses++;
    return originalFocus.apply(this, args);
  };
  try {
    for (const surface of ['create', 'list'] as const) {
      const visit = await mountedVisit(
        surface === 'create' ? '/my/zones/new' : '/my/zones',
        false,
        surface === 'create' ? 'uncertain' : 'list',
      );
      try {
        if (surface === 'create') {
          await fillCreate(visit);
          await settle(() => button(visit.host, m.zones_create_submit({}, { locale: 'en' })).click());
          await until(() => visit.host.textContent?.includes(m.zones_create_uncertain({}, { locale: 'en' })) ?? false);
        } else {
          visit.state.reloadGate = deferred<void>();
          await settle(() => button(visit.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
          await settle(() => trashConfirmation().click());
          await until(() => visit.state.reloads === 1);
        }
        expect(queued.length).toBeGreaterThan(0);
        await settle(() => changeSessionBeforeEffects(visit, 'csrf-only'));
        const before = totals(visit);
        const beforeFocus = focuses;
        await settle(() => {
          for (const callback of queued.splice(0)) callback(0);
        });
        expect(focuses).toBe(beforeFocus);
        expect(totals(visit)).toEqual(before);
      } finally {
        await visit.close();
        queued.length = 0;
      }
    }
    const visit = await mountedVisit('/my/zones');
    try {
      const original = deferred<void>();
      visit.state.reloadGate = original;
      await settle(() => button(visit.host, m.zones_owner_refresh({}, { locale: 'en' })).click());
      await settle(() => changeSessionBeforeEffects(visit, 'csrf-only'));
      await settle(() => visit.router.invalidate());
      await until(() => !!visit.host.querySelector('article'));
      const fresh = deferred<void>();
      visit.state.reloadGate = fresh;
      await settle(() => button(visit.host, m.zones_owner_refresh({}, { locale: 'en' })).click());
      const before = totals(visit);
      original.reject(new Error('Old refresh failed'));
      await flush();
      expect(totals(visit)).toEqual(before);
      expect(visit.host.querySelector('article')?.getAttribute('aria-busy')).toBe('true');
      expect(visit.host.textContent).not.toContain(m.zones_owner_unavailable({}, { locale: 'en' }));
      fresh.resolve();
      await flush();
      expect(visit.host.querySelector('article')?.getAttribute('aria-busy')).toBe('false');
    } finally {
      await visit.close();
    }
  } finally {
    globalThis.requestAnimationFrame = originalRaf;
    window.HTMLElement.prototype.focus = originalFocus;
  }
});

test('UNRUN same-counter CSRF loss retains fresh preview/choices reads, and gain starts fresh write continuity', async () => {
  const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
  try {
    await settle(() => setInput(visit.host, '#zone-visibility', 'public'));
    const oldPublish = retainHandler(button(visit.host, m.zone_editor_publish()));
    const count = editorWrites.length;
    await settle(() => {
      backendViewer = signedIn('A', null);
      visit.client
        .getQueryCache()
        .find({ queryKey: sessionQuery.queryKey, exact: true })!
        .setState({ data: backendViewer });
      oldPublish();
    });
    await until(() => !!visit.host.querySelector('#zone-label-en'));
    expect(editorWrites.length).toBe(count);
    expect(button(visit.host, m.zone_editor_publish()).disabled).toBe(true);
    const previewCount = editorPreviews.length;
    const choiceCount = editorChoices.length;
    await settle(() => button(visit.host, m.zone_editor_preview()).click());
    await until(() => editorPreviews.length === previewCount + 1 && !visit.host.querySelector('[aria-busy="true"]'));
    await settle(() => button(visit.host, m.zone_editor_more()).click());
    await until(() => editorChoices.length === choiceCount + 1);
    expect(visit.host.textContent).toContain('Later collection');
    const readAdmission = editorChoices.at(-1)!.admission;
    await settle(() => {
      backendViewer = signedIn('A', csrfC);
      visit.client
        .getQueryCache()
        .find({ queryKey: sessionQuery.queryKey, exact: true })!
        .setState({ data: backendViewer });
      oldPublish();
    });
    expect(editorWrites.length).toBe(count);
    await until(() => !!visit.host.querySelector('#zone-label-en'));
    await settle(() => setInput(visit.host, '#zone-visibility', 'public'));
    await settle(() => button(visit.host, m.zone_editor_publish()).click());
    await until(() => editorWrites.length === count + 1);
    expect(editorWrites.at(-1)!.csrf).toBe(csrfC);
    expect(editorWrites.at(-1)!.data.admission).not.toBe(readAdmission);
  } finally {
    await visit.close();
  }
});

for (const transition of ['route', 'search', 'locale', 'unmount'] as const) {
  test(`UNRUN in-flight private continuations stay retired after ${transition}`, async () => {
    for (const phase of ['create', 'lifecycle', 'write', 'retry-read', 'preview', 'choices'] as const) {
      for (const result of ['success', 'failure'] as const) {
        const visit = await mountedVisit(
          phase === 'create'
            ? '/my/zones/new'
            : phase === 'lifecycle'
              ? '/my/zones'
              : `/my/zones/${fixtureZoneId}/edit`,
        );
        const command = deferred<CommandOutcome>();
        const writing = deferred<Result<ZoneOwned>>();
        const reading = deferred<Loaded>();
        const previewing = deferred<Preview>();
        const choosing = deferred<Loaded['options']['collections']>();
        try {
          let observation: OwnerReadObservation;
          if (phase === 'create') {
            visit.state.commandGate = command;
            await fillCreate(visit);
            await settle(() => button(visit.host, m.zones_create_submit({}, { locale: 'en' })).click());
            await until(() => visit.state.creates.length === 1);
            observation = visit.state.creates[0]!.capture.observation;
          } else if (phase === 'lifecycle') {
            visit.state.commandGate = command;
            await settle(() => button(visit.host, m.zones_owner_trash_action({}, { locale: 'en' })).click());
            await settle(() => trashConfirmation().click());
            await until(() => visit.state.changes.length === 1);
            observation = visit.state.changes[0]!.capture.observation;
          } else {
            if (phase === 'write' || phase === 'retry-read') {
              // A clean publish is effectful without a dirty-navigation confirmation.
              heldEditorWrite = writing;
              await settle(() => setInput(visit.host, '#zone-visibility', 'public'));
              await settle(() => button(visit.host, m.zone_editor_publish()).click());
            } else if (phase === 'preview') {
              delayedPreview = previewing;
              await settle(() => button(visit.host, m.zone_editor_preview()).click());
            } else {
              delayedChoices = choosing;
              await settle(() => button(visit.host, m.zone_editor_more()).click());
            }
            const call =
              phase === 'preview'
                ? editorPreviews.at(-1)!
                : phase === 'choices'
                  ? editorChoices.at(-1)!
                  : editorWrites.at(-1)!.data;
            observation = { reader: call.expectedReader!, admission: call.admission! };
            if (phase === 'retry-read') {
              nextEditorRead = reading;
              const reads = editorReads.length;
              writing.resolve({
                kind: 'failure',
                status: 503,
                code: 'dependency_unavailable',
                ownerObservation: observation,
              });
              await until(() => editorReads.length === reads + 1);
            }
          }
          if (transition === 'unmount')
            await settle(() => {
              visit.root.unmount();
              visit.state.stopped = true;
            });
          else if (transition === 'locale')
            await settle(() => {
              setLocale('ja', { reload: false });
              // Force a real route notification while preserving its address.
              visit.client.setQueryData(['locale-rerender'], 'ja');
            });
          else if (transition === 'search')
            await settle(() =>
              visit.router.navigate({
                to: visit.router.state.location.pathname,
                search: { marker: 'replacement' },
              }),
            );
          else await settle(() => visit.router.navigate({ to: '/elsewhere' }));
          const before = totals(visit);
          const failure = {
            kind: 'failure' as const,
            status: 503,
            code: 'retired_result',
            ownerObservation: observation,
          };
          if (phase === 'create' || phase === 'lifecycle')
            command.resolve(
              result === 'success'
                ? { kind: 'saved', zone: fixtureZone(), ownerObservation: observation }
                : { kind: 'unavailable', ownerObservation: observation },
            );
          else if (phase === 'write')
            writing.resolve(
              result === 'success' ? { kind: 'ready', value: fixtureZone(), ownerObservation: observation } : failure,
            );
          else if (phase === 'retry-read') {
            const old = loadedFor(fixtureZoneId, observation);
            reading.resolve(result === 'success' ? old : { ...old, resource: failure });
          } else if (phase === 'preview')
            previewing.resolve(
              result === 'success'
                ? { kind: 'preparing', retryAfter: 'retired-preview', ownerObservation: observation }
                : failure,
            );
          else
            choosing.resolve(
              result === 'success'
                ? {
                    kind: 'ready',
                    value: { items: [{ id: 'old', title: 'Retired private mount' }], next: null },
                    ownerObservation: observation,
                  }
                : failure,
            );
          await flush();
          expect(totals(visit)).toEqual(before);
          for (const hidden of ['retired_result', 'retired-preview', 'Retired private mount'])
            expect(visit.host.textContent).not.toContain(hidden);
          if (transition === 'unmount') expect(visit.host.textContent).toBe('');
        } finally {
          setLocale('en', { reload: false });
          await visit.close();
        }
      }
    }
  });
}

test('UNRUN stale leave controls cannot reset or proceed after a CSRF-only admission change', async () => {
  const visit = await mountedVisit(`/my/zones/${fixtureZoneId}/edit`);
  try {
    await settle(() => setInput(visit.host, '#zone-label-en', 'Old dirty confirmation'));
    await settle(() => {
      void visit.router.navigate({ to: '/elsewhere' });
    });
    await until(() => visit.host.textContent?.includes(m.zone_editor_leave()) ?? false);
    const stay = retainHandler(button(visit.host, m.zone_editor_stay()));
    const discard = retainHandler(button(visit.host, m.zone_editor_discard()));
    const address = visit.router.state.location.href;
    const before = totals(visit);
    await settle(() => {
      changeSessionBeforeEffects(visit, 'csrf-only');
      stay();
      discard();
    });
    expect(visit.router.state.location.href).toBe(address);
    expect(visit.state.navigations).toHaveLength(before[2]!);
    expect(visit.host.textContent).not.toContain(m.zone_editor_leave());
    expect(visit.host.querySelector<HTMLInputElement>('#zone-label-en')?.value).not.toBe('Old dirty confirmation');
  } finally {
    await visit.close();
  }
});

test('unavailable Zone routes retry once at the requested location', async () => {
  setLocale('en', { reload: false });
  backendViewer = signedIn('A', csrfA);
  queryClient.setQueryData(sessionQuery.queryKey, backendViewer);
  routeFeedbackLoads = 0;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await settle(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await settle(() => router.navigate({ to: '/my/zones/recovery' as never }));
  await until(() => host.textContent?.includes(m.zones_owner_unavailable({}, { locale: 'en' })) ?? false);
  const address = router.state.location.href,
    retry = button(host, m.zones_owner_retry({}, { locale: 'en' }));
  expect(retry.type).toBe('button');
  await settle(() => {
    retry.click();
    retry.click();
  });
  await until(() => host.textContent?.includes('Fresh authorized page') ?? false);
  expect(routeFeedbackLoads).toBe(2);
  expect(router.state.location.href).toBe(address);
  await settle(() => root.unmount());
  host.remove();
});
