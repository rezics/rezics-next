import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ZoneLifecycleControls } from '../src/features/catalogue/lifecycle-zone.tsx';
import {
  changeZoneLifecycle,
  changeZoneTakedown,
  type ZoneLifecycleClient,
  type ZoneLifecycleResult,
} from '../src/features/catalogue/lifecycle-zone-commands.ts';
import type {
  LifecycleMutation,
  LifecycleReading,
  Loaded,
  Mutation,
  Result,
  ZoneOwned,
} from '../src/features/zones/editor/model';
import type { OwnerReadObservation } from '../src/features/zones/editor/owner-lifetime';
import { zoneEditorFixture } from '../src/features/zones/editor/fixture';

const zoneId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11';
const csrf = 'AAAAAAAAAAAAAAAAAAAAAA';
const fixture = zoneEditorFixture();
let resource = structuredClone(fixture.initial);
if (resource.resource.kind === 'ready') {
  resource.resource.value.zone.id = zoneId;
  resource.resource.value.zone.revision = '1';
  resource.resource.value.zone.deletedAt = null;
  resource.resource.value.zone.restoreUntil = null;
}
const lifecycleCalls: { data: Omit<LifecycleMutation, 'csrf'> & { locale: string }; csrf: string | undefined }[] = [];
const mutateCalls: Mutation[] = [];
let nextLifecycle: 'unavailable' | undefined;
function observation(data: { expectedReader?: string; admission?: string }): OwnerReadObservation | undefined {
  return data.expectedReader && data.admission ? { reader: data.expectedReader, admission: data.admission } : undefined;
}
function currentLoaded(ownerObservation?: OwnerReadObservation): Loaded {
  const loaded = structuredClone(resource);
  return ownerObservation ? { ...loaded, ownerObservation } : loaded;
}
mock.module('../src/features/zones/editor/server', () => ({
  readConfiguration: async ({ data }: { data: { id: string; expectedReader?: string; admission?: string } }) => {
    const ownerObservation = observation(data);
    if (!ownerObservation) {
      return {
        resource: { kind: 'failure', status: 401, code: 'unauthorized' },
        permissions: { configure: false, publish: false, available: false },
        options: {
          scopes: { kind: 'failure', status: 401, code: 'unauthorized' },
          collections: { kind: 'failure', status: 401, code: 'unauthorized' },
        },
      };
    }
    const loaded = currentLoaded(ownerObservation);
    if (loaded.resource.kind === 'ready') loaded.resource.value.zone.id = data.id;
    return loaded;
  },
  writeConfiguration: async ({
    data,
  }: {
    data: Mutation & { expectedReader?: string; admission?: string };
  }): Promise<Result<ZoneOwned>> => {
    mutateCalls.push(data);
    const ownerObservation = observation(data);
    if (!ownerObservation || resource.resource.kind !== 'ready')
      return { kind: 'failure', status: 403, code: 'forbidden' };
    const saved = resource.resource.value;
    const revision = (BigInt(saved.zone.revision) + 1n).toString();
    const zone = { ...saved.zone, id: data.id, revision };
    const next =
      data.operation === 'save'
        ? { ...saved, zone, configuration: structuredClone(data.body.configuration), mounts: [...data.body.mounts] }
        : { ...saved, zone };
    resource = { ...resource, resource: { kind: 'ready', value: next } };
    return { kind: 'ready', value: zone, ownerObservation };
  },
  writeLifecycle: async ({
    data,
    headers,
  }: {
    data: Omit<LifecycleMutation, 'csrf'> & { locale: string; expectedReader?: string; admission?: string };
    headers?: Record<string, string>;
  }): Promise<Result<LifecycleReading>> => {
    lifecycleCalls.push({ data, csrf: headers?.['X-CSRF-Token'] });
    const ownerObservation = observation(data);
    if (!ownerObservation || headers?.['X-CSRF-Token'] !== csrf)
      return { kind: 'failure', status: 403, code: 'forbidden' };
    if (nextLifecycle === 'unavailable') {
      nextLifecycle = undefined;
      return { kind: 'failure', status: 503, code: 'dependency_unavailable', ownerObservation };
    }
    if (resource.resource.kind !== 'ready') return { kind: 'failure', status: 404, code: 'not_found' };
    const saved = resource.resource.value;
    if (data.revision !== saved.zone.revision)
      return { kind: 'failure', status: 412, code: 'precondition_failed', ownerObservation };
    const revision = (BigInt(saved.zone.revision) + 1n).toString();
    const deleted = data.operation === 'delete';
    const zone = {
      ...saved.zone,
      id: data.id,
      revision,
      deletedAt: deleted ? '2026-11-06T00:00:00.000Z' : null,
      restoreUntil: deleted ? '2026-12-06T00:00:00.000Z' : null,
    };
    resource = { ...resource, resource: { kind: 'ready', value: { ...saved, zone } } };
    return {
      kind: 'ready',
      value: { revision: zone.revision, deletedAt: zone.deletedAt, restoreUntil: zone.restoreUntil },
      ownerObservation,
    };
  },
  readSavedPreview: async () => ({ kind: 'failure' as const, status: 404, code: 'not_found' }),
  readMountChoices: async () => ({ kind: 'failure' as const, status: 404, code: 'not_found' }),
}));

test('owner delete and restore map native status without leaking configuration', async () => {
  const calls: { method: string; path: string }[] = [];
  const client: ZoneLifecycleClient = {
    zones(input) {
      return {
        async delete() {
          calls.push({ method: 'DELETE', path: `/v1/zones/${input.id}` });
          return {
            status: 200,
            data: {
              zone: {
                revision: '2',
                deletedAt: '2026-11-06T00:00:00.000Z',
                restoreUntil: '2026-12-06T00:00:00.000Z',
              },
            },
          };
        },
        $restore: {
          async post() {
            calls.push({ method: 'POST', path: `/v1/zones/${input.id}:restore` });
            return { status: 200, data: { zone: { revision: '3', deletedAt: null, restoreUntil: null } } };
          },
        },
      };
    },
  };
  const deleted = await changeZoneLifecycle(client, 'Bearer owner', {
    id: '018f1a2b-3c4d-7000-8000-000000000001',
    revision: '1',
    key: '11111111-1111-4111-8111-111111111111',
    operation: 'delete',
  });
  const restored = await changeZoneLifecycle(client, 'Bearer owner', {
    id: '018f1a2b-3c4d-7000-8000-000000000001',
    revision: '2',
    key: '22222222-2222-4222-8222-222222222222',
    operation: 'restore',
  });
  expect(deleted).toEqual({
    ok: true,
    operation: 'delete',
    revision: '2',
    deletedAt: '2026-11-06T00:00:00.000Z',
    restoreUntil: '2026-12-06T00:00:00.000Z',
  });
  expect(restored).toEqual({
    ok: true,
    operation: 'restore',
    revision: '3',
    deletedAt: null,
    restoreUntil: null,
  });
  expect(calls.map((call) => call.method)).toEqual(['DELETE', 'POST']);
  expect(JSON.stringify([deleted, restored])).not.toContain('configuration');
});

test('moderator takedown maps denial and the controls stay usable on a narrow layout', async () => {
  const denied = await changeZoneTakedown(
    {
      zones() {
        return {
          async delete() {
            return { status: 500, data: null };
          },
          $restore: {
            async post() {
              return { status: 500, data: null };
            },
          },
          $takedown: {
            async post() {
              return { status: 403, data: null };
            },
          },
        };
      },
    },
    'Bearer owner',
    {
      id: '018f1a2b-3c4d-7000-8000-000000000001',
      revision: '1',
      key: '11111111-1111-4111-8111-111111111111',
      pointers: ['/labels/en'],
      operation: 'takedown',
    },
  );
  expect(denied).toEqual({ ok: false, reason: 'denied' });
  const last: ZoneLifecycleResult = denied;
  const markup = renderToStaticMarkup(
    <div className="max-w-xs">
      <ZoneLifecycleControls
        deleted={false}
        withheld
        last={last}
        busy={false}
        onDelete={() => {}}
        onRestore={() => {}}
      />
    </div>,
  );
  expect(markup).toContain('Not allowed');
  expect(markup).toContain('Delete zone');
});

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: `https://site.test/en/my/zones/${zoneId}/edit` });
Object.defineProperty(window, 'scrollTo', { configurable: true, writable: true, value: () => {} });
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
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLoaderData,
} = await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { ZoneEditorRoute, loadZoneEditor } = await import('../src/features/zones/editor/route');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

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
  throw new Error('Mounted Zone lifecycle journey did not settle');
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const match = [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

test('Mounted Zone editor Delete1 Restore2 save and uncertain replay share the current reading', async () => {
  setLocale('en', { reload: false });
  resource = structuredClone(fixture.initial);
  if (resource.resource.kind === 'ready') {
    resource.resource.value.zone.id = zoneId;
    resource.resource.value.zone.revision = '1';
    resource.resource.value.zone.deletedAt = null;
    resource.resource.value.zone.restoreUntil = null;
  }
  lifecycleCalls.length = 0;
  mutateCalls.length = 0;
  nextLifecycle = undefined;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: csrf });
  const rootRoute = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()({
    component: () => <Outlet />,
  });
  const editRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/my/zones/$id/edit',
    loader: ({ params, context }) => loadZoneEditor(params.id, 'en', context.queryClient),
    component: function Edit() {
      const { initial, requestedOwner } = useLoaderData({ strict: false }) as Awaited<
        ReturnType<typeof loadZoneEditor>
      >;
      return <ZoneEditorRoute id={zoneId} locale="en" initial={initial} requestedOwner={requestedOwner} />;
    },
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([editRoute]),
    history: createMemoryHistory({ initialEntries: [`/my/zones/${zoneId}/edit`] }),
    context: { queryClient },
  });
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
    await until(() => !!host.querySelector('#zone-label-en'));
    await settle(() => {
      button(host, 'Delete zone').click();
      button(host, 'Delete zone').click();
    });
    await until(() => lifecycleCalls.length >= 1 && !host.querySelector('[aria-busy="true"]'));
    expect(new Set(lifecycleCalls.map((call) => `${call.data.key}:${call.data.revision}:${call.data.operation}`)).size).toBe(
      1,
    );
    expect(lifecycleCalls[0]!.data).toMatchObject({ id: zoneId, revision: '1', operation: 'delete' });
    expect(lifecycleCalls[0]!.csrf).toBe(csrf);
    expect(button(host, 'Restore zone').textContent).toBe('Restore zone');
    expect(host.textContent).toContain(m.zone_editor_saved_head({ revision: '2' }));
    await settle(() => button(host, 'Restore zone').click());
    await until(() => lifecycleCalls.some((call) => call.data.operation === 'restore') && !host.querySelector('[aria-busy="true"]'));
    const restore = lifecycleCalls.find((call) => call.data.operation === 'restore')!;
    expect(restore.data.revision).toBe('2');
    expect(restore.data.key).not.toBe(lifecycleCalls[0]!.data.key);
    expect(button(host, 'Delete zone')).toBeTruthy();
    expect(host.textContent).toContain(m.zone_editor_saved_head({ revision: '3' }));
    const name = host.querySelector<HTMLInputElement>('#zone-label-en')!;
    name.value = 'Saved before lifecycle';
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
    await settle(() => button(host, m.zone_editor_save()).click());
    await until(() => mutateCalls.length === 1 && !host.querySelector('[aria-busy="true"]'));
    expect(mutateCalls[0]!.revision).toBe('3');
    expect(host.textContent).toContain(m.zone_editor_saved_head({ revision: '4' }));
    const before = lifecycleCalls.length;
    nextLifecycle = 'unavailable';
    await settle(() => button(host, 'Delete zone').click());
    await until(() => lifecycleCalls.length === before + 1 && !host.querySelector('[aria-busy="true"]'));
    await settle(() => button(host, 'Delete zone').click());
    await until(() => lifecycleCalls.length === before + 2 && !host.querySelector('[aria-busy="true"]'));
    expect(lifecycleCalls[before]!.data).toEqual(lifecycleCalls[before + 1]!.data);
    expect(lifecycleCalls[before]!.csrf).toBe(lifecycleCalls[before + 1]!.csrf);
    expect(lifecycleCalls[before]!.data.revision).toBe('4');
    expect(button(host, 'Restore zone')).toBeTruthy();
    expect(host.textContent).toContain(m.zone_editor_saved_head({ revision: '5' }));
  } finally {
    await settle(() => root.unmount());
    host.remove();
  }
});
