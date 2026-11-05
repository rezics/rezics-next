import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type { LibraryNavigationRead } from '../src/library/pins-read';
import type { PinMutation } from '../src/library/pins-actions';
import type { usePinControlActions } from '../src/library/pin-control';
import type { MenuProps } from '@rezics/ui/menu';
import type { DynamicCollectionPage as DynamicPage } from '../src/library/dynamic-collection';

// UNRUN: composed deferred assertions for integration. Use the installed DOM fixture,
// real session/exposure cache and real owning hooks; only transports are deferred.
let actualSubject: string | undefined = 'A';
let preparation: 'active' | 'absent' = 'active';
let preparations = 0;
const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'kernel',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        preparations++;
        return { status: preparation, subject: actualSubject, accessToken: 'private-credential', csrfToken: 'csrf' };
      },
    }),
  },
};
const request = () =>
  new Request('https://site.test/en/library', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
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
function response(subject: string, ids: string[] = [], revision = 7, limit: 8 | 100 = 100): LibraryNavigationRead {
  const origin = { sessionSubject: subject, credentialAgrees: true, requestedLimit: limit };
  return {
    origin,
    pins: {
      state: 'loaded',
      origin,
      revision,
      next: null,
      canUpdate: true,
      canRemove: true,
      pins: ids.map((collectionId) => ({ collectionId, target: null })),
    },
    collections: [{ id: `private-${subject}`, title: `Private ${subject}`, curator: null }],
    collectionsState: 'loaded',
  };
}

test('Prepared navigation origin, independent admissions, retired callbacks and exact uncertain pin intent compose in the actual current workflow', async () => {
  // A sibling file's global mock.restore() may run before this deferred-import harness.
  mock.module('cloudflare:workers', () => ({ env }));
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/collections/b' });
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
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const reads = await import('../src/library/pins-read');
  const nativeCalls: string[] = [];
  let exposed = true;
  let preparing = false;
  const native = {
    'openapi.json': {
      get: async () => {
        nativeCalls.push('openapi');
        return {
          data: {
            paths: exposed
              ? {
                  pins: {
                    get: { operationId: 'library_pin.list' },
                    put: { operationId: 'library_pin.put' },
                    delete: { operationId: 'library_pin.delete' },
                  },
                }
              : {},
          },
        };
      },
    },
    libraryPins: {
      get: async ({ query }: { query: { limit: number } }) => {
        nativeCalls.push(`pins:${query.limit}`);
        return preparing ? { status: 202 } : { data: { pins: [], revision: 7, next: null } };
      },
    },
    collections: {
      get: async () => {
        nativeCalls.push('collections');
        return { data: { collections: [], next: null } };
      },
    },
  };
  const sameRequest = request();
  const loaded = await reads.loadLibraryNavigation(native as never, sameRequest, env as never, 100);
  expect(loaded).toMatchObject({
    origin: { sessionSubject: 'A', credentialAgrees: true, requestedLimit: 100 },
    pins: { state: 'loaded', pins: [], origin: { sessionSubject: 'A', requestedLimit: 100 } },
  });
  expect(preparations).toBe(1);
  expect(nativeCalls).toEqual(['openapi', 'collections', 'pins:100']);
  expect(JSON.stringify(loaded)).not.toContain('private-credential');
  preparing = true;
  expect((await reads.loadLibraryNavigation(native as never, request(), env as never, 8)).pins).toMatchObject({
    state: 'preparing',
    origin: { sessionSubject: 'A', requestedLimit: 8 },
  });
  exposed = false;
  expect((await reads.loadLibraryNavigation(native as never, request(), env as never, 8)).pins).toMatchObject({
    state: 'closed',
    origin: { sessionSubject: 'A', requestedLimit: 8 },
  });
  const beforeRefusal = nativeCalls.length;
  preparation = 'absent';
  expect(await reads.loadLibraryNavigation(native as never, sameRequest, env as never)).toMatchObject({
    origin: { sessionSubject: null, credentialAgrees: false },
    pins: { state: 'closed' },
    collections: [],
  });
  preparation = 'active';
  actualSubject = undefined;
  await reads.loadLibraryNavigation(native as never, request(), env as never);
  await reads.loadLibraryNavigation(
    native as never,
    new Request('https://site.test/en/library', {
      headers: { authorization: 'Bearer asserted-viewer' },
    }),
    env as never,
  );
  expect(nativeCalls).toHaveLength(beforeRefusal); // No OpenAPI, pins or owner read after refused/missing identity.

  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRoot } = await import('react-dom/client');
  const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery } = await import('../src/session/query');
  const { viewerExposureQuery, viewerExposureLifetime } = await import('../src/kernel/viewer-exposure');
  const { workspaceAdmission } = await import('../src/reader/workspace-admission');
  const { useCurrentLibraryNavigation } = await import('../src/library/pins-current');
  const { usePinControlActions: useActions, PinControlNotice } = await import('../src/library/pin-control');
  const { LibraryNavigation } = await import('../src/library/library-nav');
  const actions = await import('../src/library/pins-actions');
  const { m } = await import('../src/paraglide/messages.js');
  const pendingReads: ReturnType<typeof deferred<LibraryNavigationRead>>[] = [];
  const read = spyOn(reads, 'readLibraryNavigationPage').mockImplementation(() => {
    const work = deferred<LibraryNavigationRead>();
    pendingReads.push(work);
    return work.promise;
  });
  const writes: Array<{
    input: Parameters<typeof actions.pinCollection>[0];
    operation: 'put' | 'delete';
    work: ReturnType<typeof deferred<PinMutation>>;
  }> = [];
  const put = spyOn(actions, 'pinCollection').mockImplementation((input) => {
    const work = deferred<PinMutation>();
    writes.push({ input, operation: 'put', work });
    return work.promise;
  });
  const remove = spyOn(actions, 'unpinCollection').mockImplementation((input) => {
    const work = deferred<PinMutation>();
    writes.push({ input, operation: 'delete', work });
    return work.promise;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = (subject: string, csrfToken = 'csrf') => ({ state: 'signed-in' as const, subject, csrfToken });
  const viewer = viewerExposureLifetime(client);
  const stopViewer = viewer.subscribeCache(() => {});
  const admit = (admitted: string[]) => {
    const snapshot = viewer.getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Missing current viewer observation');
    client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
  };
  client.setQueryData(sessionQuery.queryKey, session('A'));
  admit(['personal_library', 'collections']);
  const currentAdmission = workspaceAdmission(client, ['library_pin.list', 'collection.list']);
  expect(currentAdmission.read().allowed).toEqual([true, true]);
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  const invalidate = spyOn(router, 'invalidate').mockResolvedValue(undefined);
  const cache = spyOn(client, 'invalidateQueries').mockResolvedValue(undefined);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let address = 'first';
  let navigation!: ReturnType<typeof useCurrentLibraryNavigation>;
  let control!: ReturnType<typeof usePinControlActions>;
  function Probe() {
    navigation = useCurrentLibraryNavigation('en', 100, address);
    control = useActions({
      collectionId: 'b',
      pins: navigation.data.pins,
      mode: 'list',
      origin: navigation.pinsOrigin,
    });
    return (
      <>
        <LibraryNavigation current="tracked" pins={navigation.data.pins} collections={navigation.data.collections} />
        <PinControlNotice notice={control.notice} />
      </>
    );
  }
  const tick = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const show = async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <RouterContextProvider router={router}>
              <Probe />
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
    await tick();
  };
  const settle = async (index: number, value: LibraryNavigationRead) => {
    await act(async () => pendingReads[index]!.resolve(value));
    await tick();
  };
  const select = (label: string) => {
    const entry = control.entries.find((entry) => entry.type !== 'separator' && entry.label === label);
    if (!entry || entry.type === 'separator' || !('onSelect' in entry) || !entry.onSelect)
      throw new Error(`Missing ${label}`);
    expect(entry.disabled).toBe(false);
    return entry.onSelect;
  };
  const refetch = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: navigation.pinsOrigin.queryKey, exact: true });
    });
    await tick();
  };
  const menu = await import('@rezics/ui/menu');
  let pinMenu: MenuProps | undefined;
  const OriginalMenu = menu.Menu;
  const observeMenu = spyOn(menu, 'Menu').mockImplementation((props) => {
    if (props.title === m.library_pin_actions()) pinMenu = props;
    return OriginalMenu(props);
  });
  try {
    await show(); // A remains unresolved while B becomes immediately usable.
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, session('B'));
      admit(['personal_library', 'collections']);
    });
    expect(currentAdmission.read().allowed).toEqual([true, true]);
    await tick();
    expect(pendingReads).toHaveLength(2);
    await settle(1, response('B', ['a', 'x', 'b', 'c']));
    expect(navigation.data.collections).toEqual(response('B').collections);
    const oldMove = select(m.library_pin_move_up());
    await act(async () => {
      oldMove();
      oldMove();
    });
    expect(writes).toHaveLength(1);
    await settle(0, response('A', ['old-A']));
    expect(navigation.data.collections).toEqual(response('B').collections);
    expect(control.pending).toBe(true);
    // Cache replacement is observed synchronously, before React can commit C's render.
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, session('C'));
      oldMove();
      admit(['personal_library', 'collections']);
    });
    expect(writes).toHaveLength(1);
    await tick();
    await settle(2, response('C'));
    await act(async () => select(m.library_pin_pin())());
    expect(writes).toHaveLength(2);
    await act(async () => writes[0]!.work.resolve({ ok: false, reason: 'denied' }));
    expect(invalidate).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
    expect(control.pending).toBe(true);
    expect(control.notice).toBe('');
    await act(async () => writes[1]!.work.resolve({ ok: false, reason: 'full' }));
    expect(control.notice).toBe(m.library_pin_limit());

    const oldPin = select(m.library_pin_pin());
    await act(async () => {
      // Viewer ABA is observed even when both replacements precede the next render.
      client.setQueryData(sessionQuery.queryKey, session('D'));
      client.setQueryData(sessionQuery.queryKey, session('C'));
      admit(['personal_library', 'collections']);
      oldPin();
    });
    await tick();
    expect(writes).toHaveLength(2);
    expect(navigation.data.collections).toEqual([]);
    await settle(3, response('C', ['b']));
    await act(async () => {
      admit(['collections']);
      admit(['personal_library', 'collections']);
    });
    await tick();
    expect(navigation.data.pins.state).not.toBe('loaded');
    expect(navigation.data.collections).toEqual(response('C').collections); // Collections has its independent accepted origin.
    await settle(4, response('C', ['b']));
    address = 'second';
    await show();
    address = 'first';
    await show();
    expect(navigation.data.collections).toEqual([]);
    await settle(5, response('C', ['old-address']));
    expect(navigation.data.pins.state).not.toBe('loaded');
    await settle(6, response('C', ['wrong-limit'], 7, 8));
    expect(navigation.data.pins.state).toBe('unavailable');
    await refetch();
    await settle(7, response('C', ['a', 'x', 'b', 'c']));

    const move = select(m.library_pin_move_up());
    const unpin = select(m.library_pin_unpin());
    await act(async () => {
      move();
      move();
      unpin();
    });
    expect(writes).toHaveLength(3);
    const exact = writes[2]!.input.data;
    expect(exact).toEqual({ collectionId: 'b', revision: 7, after: 'a', idempotencyKey: exact.idempotencyKey });
    await act(async () => writes[2]!.work.reject(new Error('Uncertain response')));
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, session('C', 'rotated-csrf'));
      admit(['personal_library', 'collections']);
    });
    await refetch();
    await settle(8, response('C', ['b', 'c'], 42));
    expect(writes).toHaveLength(3); // Refresh/rotation never automatically replays a command.
    await act(async () => select(m.library_pin_move_up())());
    expect(writes[3]!.input.data).toEqual(exact);
    expect(writes[3]!.operation).toBe(writes[2]!.operation);
    expect(new Headers(writes[3]!.input.headers).get('X-CSRF-Token')).toBe('csrf');
    await act(async () => writes[3]!.work.resolve({ ok: true, revision: 8 }));
    expect(cache).toHaveBeenCalledWith({ queryKey: navigation.pinsOrigin.queryKey, exact: true });
    expect(control.pending).toBe(false);

    // Unrelated owner Collections admission cannot revoke this same-viewer removal of a null target.
    const personalLibraryRead = pendingReads.length;
    await act(async () => admit(['personal_library']));
    await tick();
    await settle(personalLibraryRead, response('C', ['b', 'c'], 42));
    await act(async () => select(m.library_pin_unpin())());
    expect(writes[4]!.operation).toBe('delete');
    expect(writes[4]!.input.data).toEqual({
      collectionId: 'b',
      revision: 42,
      idempotencyKey: writes[4]!.input.data.idempotencyKey,
    });
    await act(async () => writes[4]!.work.resolve({ ok: true, revision: 43 }));
    expect(control.pending).toBe(false);

    await act(async () => admit(['personal_library', 'collections']));
    await tick();

    const { DynamicCollectionPage } = await import('../src/library/dynamic-collection-page');
    const embedded = response('A');
    let publicPage: DynamicPage = {
      id: 'b',
      title: 'Public members',
      description: null,
      curator: null,
      members: [],
      next: null,
      preparing: false,
      unavailable: false,
      retryAfterMs: 1000,
      following: true,
      pins: embedded.pins,
      navigationCollections: embedded.collections,
    };
    const showDynamic = async () => {
      await act(async () =>
        root.render(
          <StrictMode>
            <QueryClientProvider client={client}>
              <RouterContextProvider router={router}>
                <DynamicCollectionPage page={publicPage} />
              </RouterContextProvider>
            </QueryClientProvider>
          </StrictMode>,
        ),
      );
      await tick();
    };
    const dynamicPin = () => {
      const entry = pinMenu?.entries.find((entry) => entry.type !== 'separator' && entry.label === m.library_pin_pin());
      if (!entry || entry.type === 'separator' || !('onSelect' in entry) || !entry.onSelect)
        throw new Error('Missing dynamic pin action');
      expect(entry.disabled).toBe(false);
      return entry.onSelect;
    };
    const dynamicRead = pendingReads.length;
    await showDynamic();
    expect(host.textContent).toContain('Public members');
    expect(host.textContent).not.toContain('Private A'); // Embedded pins/owner shortcuts cannot lend A's authority to C.
    await settle(dynamicRead, response('C'));
    await act(async () => dynamicPin()());
    const dynamicIntent = writes[5]!.input.data;
    const refreshRead = pendingReads.length;
    await act(async () => {
      void client.refetchQueries({ queryKey: ['library-navigation'], type: 'active' });
    });
    await tick();
    await settle(refreshRead, response('C', [], 99));
    publicPage = { ...publicPage }; // Keep the public retry/member remount, retain the outer originating pin action.
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, session('C', 'next-csrf'));
      admit(['personal_library', 'collections']);
    });
    await showDynamic();
    await act(async () => writes[5]!.work.reject(new Error('Unknown native result')));
    await act(async () => dynamicPin()());
    expect(writes[6]!.input.data).toEqual(dynamicIntent);
    expect(writes[6]!.operation).toBe(writes[5]!.operation);
    expect(new Headers(writes[6]!.input.headers).get('X-CSRF-Token')).toBe('rotated-csrf');
    await act(async () => writes[6]!.work.resolve({ ok: true, revision: 8 }));

    const loadedRead = pendingReads.length;
    await show();
    const beforeRefusal = response('C', ['a', 'x', 'b', 'c']);
    expect(pendingReads).toHaveLength(loadedRead + 1);
    await settle(loadedRead, beforeRefusal);
    expect(navigation.data.pins).toMatchObject({ state: 'loaded' });
    expect(host.querySelectorAll('[data-library-pin]').length).toBeGreaterThan(0);
    expect(navigation.pinsOrigin.isCurrent()).toBe(true);

    const refusalRead = pendingReads.length;
    await refetch();
    await settle(refusalRead, {
      ...beforeRefusal,
      pins: { state: 'denied', origin: beforeRefusal.origin },
    });
    expect(navigation.data.pins).toMatchObject({ state: 'denied' });
    expect(navigation.data.collections).toEqual(beforeRefusal.collections);
    expect(host.textContent).toContain(m.library_pin_denied());
    expect(host.querySelectorAll('[data-library-pin]')).toHaveLength(0);
    expect(navigation.pinsOrigin.isCurrent()).toBe(false);
    expect(control.entries).toHaveLength(0);
    expect(control.canUpdate).toBe(false);
  } finally {
    await act(async () => root.unmount());
    stopViewer();
    client.clear();
    host.remove();
    for (const spy of [read, put, remove, invalidate, cache, observeMenu]) spy.mockRestore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
