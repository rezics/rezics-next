import { describe, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { PinMutation } from '../src/library/pins-actions';
import type { LibraryPinsRead } from '../src/library/pins-read';
import type { PinControlMode, usePinControlActions } from '../src/library/pin-control';
import { m } from '../src/paraglide/messages.js';

// UNRUN: deferred-result regressions for integration. Reuse Puck's installed DOM fixture;
// substitute only observed session/admission and the pin operation transports.
let viewer: { state: 'unknown' | 'signed-in' | 'signed-out'; subject?: string | null; csrfToken: string | null };
let putAdmitted = true;
let removeAdmitted = true;
mock.module('../src/session/query', () => ({ useSession: () => viewer }));
mock.module('../src/kernel/exposure', () => ({
  useOperation: (operation: string) => (operation === 'library_pin.put' ? putAdmitted : removeAdmitted),
}));
mock.module('../src/threads/composer', () => ({ csrfHeaders: () => ({ 'X-CSRF-Token': viewer.csrfToken }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Input = {
  data: { collectionId: string; revision: number; after?: string | null; idempotencyKey: string };
  headers: unknown;
};
const calls: Array<Input & ReturnType<typeof deferred<PinMutation>> & { operation: 'put' | 'delete' }> = [];
function transport(operation: 'put' | 'delete', input: Input) {
  const call = { ...input, ...deferred<PinMutation>(), operation };
  calls.push(call);
  return call.promise;
}
mock.module('../src/library/pins-actions', () => ({
  pinCollection: (input: Input) => transport('put', input),
  unpinCollection: (input: Input) => transport('delete', input),
}));

type Control = ReturnType<typeof usePinControlActions>;
type Props = { collectionId: string; pins: LibraryPinsRead; mode: PinControlMode };
type Action = 'pin' | 'unpin' | 'up' | 'down';
function loaded(ids: string[] = [], revision = 7): LibraryPinsRead {
  return {
    state: 'loaded',
    pins: ids.map((collectionId) => ({ collectionId, target: null })),
    revision,
    next: null,
    canUpdate: true,
    canRemove: true,
  };
}
const labels = () => ({
  pin: m.library_pin_pin(),
  unpin: m.library_pin_unpin(),
  up: m.library_pin_move_up(),
  down: m.library_pin_move_down(),
});
let observed: Control;
const { usePinControlActions: useActions, PinControlNotice } = await import('../src/library/pin-control');
function Probe(props: Props) {
  observed = useActions(props);
  return (
    <div data-pending={observed.pending}>
      <PinControlNotice notice={observed.notice} />
    </div>
  );
}
const invoke = async (callback: () => void) => {
  await act(async () => callback());
};
async function complete(
  call: (typeof calls)[number],
  outcome: 'success' | 'conflict' | 'full' | 'unavailable' | 'reject',
) {
  await act(async () => {
    if (outcome === 'reject') call.reject(new Error('Response lost'));
    else call.resolve(outcome === 'success' ? { ok: true, revision: 8 } : { ok: false, reason: outcome });
  });
}

async function mount(initial: Props = { collectionId: 'b', pins: loaded(), mode: 'collection' }) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/collections/b' });
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
  viewer = { state: 'signed-in', subject: 'reader-one', csrfToken: 'csrf' };
  putAdmitted = removeAdmitted = true;
  calls.length = 0;
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } =
    await import('@tanstack/react-router');
  const { createRoot } = await import('react-dom/client');
  const { setLocale, locales } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const callbacks = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
    const waits = {
      navigation: null as ReturnType<typeof deferred<void>> | null,
      cache: null as ReturnType<typeof deferred<void>> | null,
    };
    const navigation = spyOn(router, 'invalidate').mockImplementation(
      () => waits.navigation?.promise ?? Promise.resolve(),
    );
    const cache = spyOn(client, 'invalidateQueries').mockImplementation(
      () => waits.cache?.promise ?? Promise.resolve(),
    );
    return { client, router, navigation, cache, waits };
  };
  const groups = [callbacks()];
  let current = groups[0]!;
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let props = initial;
  let unmounted = false;
  const show = async (next = props) => {
    props = next;
    await act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={current.client}>
            <RouterContextProvider router={current.router}>
              <Probe {...props} />
            </RouterContextProvider>
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  };
  const select = (action: Action) => {
    const entry = observed.entries.find((entry) => entry.type !== 'separator' && entry.label === labels()[action]);
    if (!entry || entry.type === 'separator' || !('onSelect' in entry) || !entry.onSelect)
      throw new Error(`Missing ${action} control`);
    return entry;
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    unmounted = true;
  };
  await show();
  return {
    host,
    groups,
    show,
    select,
    unmount,
    get props() {
      return props;
    },
    get control() {
      return observed;
    },
    click: async (action: Action) => {
      const entry = select(action);
      expect(entry.disabled).toBe(false);
      await invoke(entry.onSelect!);
    },
    async replaceCallbacks() {
      current = callbacks();
      groups.push(current);
      await show();
    },
    rotateLocale() {
      setLocale(locales.find((locale) => locale !== 'en') ?? 'en', { reload: false });
    },
    async close() {
      if (!unmounted) await unmount();
      for (const group of groups) {
        group.navigation.mockRestore();
        group.cache.mockRestore();
        group.client.clear();
      }
      setLocale('en', { reload: false });
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

describe('Pin mutation completions cannot cross the originating viewer or Collection lifetime', () => {
  test('viewer and Collection replacement leave new controls usable and suppress every late result and retained callback', async () => {
    for (const boundary of ['viewer', 'collection'] as const)
      for (const outcome of ['success', 'conflict', 'full', 'unavailable', 'reject'] as const) {
        const h = await mount();
        try {
          const oldSelect = h.select('pin').onSelect!;
          await h.click('pin');
          const old = calls[0]!;
          if (boundary === 'viewer') viewer = { ...viewer, subject: 'reader-two' };
          await h.show({ ...h.props, collectionId: boundary === 'collection' ? 'replacement' : 'b' });
          expect(h.control.pending).toBe(false);
          expect(h.control.notice).toBe('');
          await invoke(oldSelect);
          expect(calls).toHaveLength(1);
          await h.click('pin');
          const current = calls[1]!;
          expect(current.data.idempotencyKey).not.toBe(old.data.idempotencyKey);
          expect(current.data.collectionId).toBe(h.props.collectionId);
          await complete(old, outcome);
          expect(h.control.pending).toBe(true);
          expect(h.control.notice).toBe('');
          expect(h.groups[0]!.navigation).not.toHaveBeenCalled();
          expect(h.groups[0]!.cache).not.toHaveBeenCalled();
          await invoke(h.select('pin').onSelect!);
          expect(calls).toHaveLength(2);
          await complete(current, 'full');
          expect(h.control.pending).toBe(false);
          expect(h.control.notice).toBe(m.library_pin_limit());
        } finally {
          await h.close();
        }
      }
  });

  test('observed authority loss and unmount retire IO and callbacks, including an ABA return to the same subject', async () => {
    for (const boundary of [
      'unknown',
      'signed-out',
      'missing-viewer',
      'csrf',
      'pins',
      'put',
      'delete',
      'capability',
      'unmount',
    ] as const)
      for (const outcome of ['success', 'conflict', 'reject'] as const) {
        const removing = boundary === 'delete';
        const h = await mount({ collectionId: 'b', pins: loaded(removing ? ['b'] : []), mode: 'collection' });
        try {
          const action = removing ? 'unpin' : 'pin';
          const oldSelect = h.select(action).onSelect!;
          await h.click(action);
          const old = calls[0]!;
          if (boundary === 'unmount') await h.unmount();
          else {
            if (boundary === 'unknown' || boundary === 'signed-out') viewer = { ...viewer, state: boundary };
            if (boundary === 'missing-viewer') viewer = { ...viewer, subject: null };
            if (boundary === 'csrf') viewer = { ...viewer, csrfToken: null };
            if (boundary === 'put') putAdmitted = false;
            if (boundary === 'delete') removeAdmitted = false;
            await h.show({
              ...h.props,
              pins:
                boundary === 'pins'
                  ? { state: 'unavailable' }
                  : boundary === 'capability'
                    ? { ...loaded(), canUpdate: false }
                    : h.props.pins,
            });
            expect(h.control.pending).toBe(false);
            for (const entry of h.control.entries)
              if (entry.type !== 'separator' && 'onSelect' in entry && entry.onSelect) await invoke(entry.onSelect);
          }
          await invoke(oldSelect);
          expect(calls).toHaveLength(1);
          if (boundary !== 'unmount') {
            viewer = { state: 'signed-in', subject: 'reader-one', csrfToken: 'new-csrf' };
            putAdmitted = removeAdmitted = true;
            await h.show({ ...h.props, pins: loaded(removing ? ['b'] : []) });
            await h.click(action);
          }
          await complete(old, outcome);
          expect(h.groups[0]!.navigation).not.toHaveBeenCalled();
          expect(h.groups[0]!.cache).not.toHaveBeenCalled();
          if (boundary !== 'unmount') {
            expect(h.control.pending).toBe(true);
            expect(h.control.notice).toBe('');
            await complete(calls[1]!, 'full');
          }
        } finally {
          await h.close();
        }
      }
  });

  test('refresh rejection and finally from a retired success or conflict cannot unlock or paint its replacement', async () => {
    for (const outcome of ['success', 'conflict'] as const) {
      const h = await mount();
      try {
        const group = h.groups[0]!;
        group.waits.navigation = deferred<void>();
        group.waits.cache = deferred<void>();
        await h.click('pin');
        await complete(calls[0]!, outcome);
        expect(group.navigation).toHaveBeenCalledTimes(1);
        expect(group.cache).toHaveBeenCalledWith({ queryKey: ['library-navigation'] });
        if (outcome === 'conflict') expect(h.control.notice).toBe(m.library_pin_conflict());
        await h.show({ ...h.props, collectionId: 'replacement' });
        await h.click('pin');
        await act(async () => {
          group.waits.navigation!.reject(new Error('Refresh lost'));
          group.waits.cache!.resolve();
        });
        expect(h.control.pending).toBe(true);
        expect(h.control.notice).toBe('');
        await invoke(h.select('pin').onSelect!);
        expect(calls).toHaveLength(2);
        await complete(calls[1]!, 'unavailable');
      } finally {
        await h.close();
      }
    }
  });

  test('duplicate starts and uncertain retries retain exact action, revision, placement and key across ordinary refreshes', async () => {
    const h = await mount({ collectionId: 'b', pins: loaded(['a', 'x', 'b', 'c']), mode: 'list' });
    try {
      const move = h.select('up').onSelect!;
      const remove = h.select('unpin').onSelect!;
      await invoke(() => {
        move();
        move();
        remove();
      });
      expect(calls).toHaveLength(1);
      const intent = calls[0]!.data;
      expect(intent).toEqual({ collectionId: 'b', revision: 7, after: 'a', idempotencyKey: intent.idempotencyKey });
      viewer = { ...viewer, csrfToken: 'rotated-csrf' };
      h.rotateLocale();
      await h.show({ ...h.props, pins: loaded(['b', 'c'], 42), mode: 'navigation' });
      await h.replaceCallbacks();
      expect(h.control.pending).toBe(true);
      await complete(calls[0]!, 'reject');
      expect(h.control.notice).toBe(m.error_message());
      expect(h.select('unpin').disabled).toBe(true);
      await invoke(remove);
      expect(calls).toHaveLength(1);
      await h.click('up');
      expect(calls[1]!.data).toEqual(intent);
      expect(calls[1]!.headers).toEqual({ 'X-CSRF-Token': 'csrf' });
      await complete(calls[1]!, 'unavailable');
      expect(calls).toHaveLength(2); // No automatic replay or refresh on uncertainty.
      await h.click('up');
      expect(calls[2]!.data).toEqual(intent);
      expect(calls[2]!.headers).toEqual(calls[0]!.headers);
      expect(calls[2]!.operation).toBe(calls[0]!.operation);
      await complete(calls[2]!, 'success');
      expect(h.control.pending).toBe(false);
      expect(h.control.notice).toBe('');
      expect(h.groups[0]!.navigation).not.toHaveBeenCalled();
      expect(h.groups[1]!.navigation).toHaveBeenCalledTimes(1);
      await h.click('unpin');
      expect(calls[3]!.data).toEqual({
        collectionId: 'b',
        revision: 42,
        idempotencyKey: calls[3]!.data.idempotencyKey,
      });
      expect(calls[3]!.data.idempotencyKey).not.toBe(intent.idempotencyKey);
      expect(calls[3]!.operation).toBe('delete');
      expect(calls[3]!.headers).toEqual({ 'X-CSRF-Token': 'rotated-csrf' });
      const removal = calls[3]!;
      await complete(removal, 'unavailable');
      viewer = { ...viewer, csrfToken: 'later-csrf' };
      await h.show({ ...h.props, pins: loaded([], 84) });
      await h.click('unpin');
      expect(calls[4]!.operation).toBe('delete');
      expect(calls[4]!.data).toEqual(removal.data);
      expect(calls[4]!.headers).toEqual(removal.headers);
      await complete(calls[4]!, 'success');
    } finally {
      await h.close();
    }
  });

  test('explicit retries recheck their own PUT and DELETE admission', async () => {
    for (const [action, operation] of [
      ['up', 'put'],
      ['unpin', 'delete'],
    ] as const) {
      const h = await mount({ collectionId: 'b', pins: loaded(['a', 'b']), mode: 'list' });
      try {
        const retry = h.select(action).onSelect!;
        await h.click(action);
        await complete(calls[0]!, 'unavailable');
        if (operation === 'put') putAdmitted = false;
        else removeAdmitted = false;
        await h.show();
        await invoke(retry);
        expect(calls).toHaveLength(1);
        expect(h.control.pending).toBe(false);
      } finally {
        await h.close();
      }
    }
  });

  test('a viewer change retires the uncertain command before an explicit retry', async () => {
    const h = await mount();
    try {
      await h.click('pin');
      const original = calls[0]!;
      await complete(original, 'unavailable');
      const retry = h.select('pin').onSelect!;
      viewer = { state: 'signed-in', subject: 'reader-two', csrfToken: 'new-csrf' };
      await h.show();
      await invoke(retry);
      expect(calls).toHaveLength(1);
      await h.click('pin');
      expect(calls[1]!.data.idempotencyKey).not.toBe(original.data.idempotencyKey);
      expect(calls[1]!.headers).toEqual({ 'X-CSRF-Token': 'new-csrf' });
      await complete(calls[1]!, 'success');
    } finally {
      await h.close();
    }
  });

  test('healthy pin, unpin and bounded list reorders preserve native after semantics, menu modes and definitive messages', async () => {
    const h = await mount();
    try {
      for (const [action, ids, after] of [
        ['pin', [], undefined],
        ['up', ['a', 'b', 'c'], null],
        ['down', ['b', 'a', 'c'], 'a'],
        ['up', ['a', 'x', 'b'], 'a'],
        ['unpin', ['b'], undefined],
      ] as const) {
        const revision = 10 + calls.length;
        await h.show({ collectionId: 'b', pins: loaded([...ids], revision), mode: 'list' });
        await h.click(action);
        const call = calls.at(-1)!;
        expect(call.operation).toBe(action === 'unpin' ? 'delete' : 'put');
        expect(call.data).toEqual({
          collectionId: 'b',
          revision,
          ...(after === undefined ? {} : { after }),
          idempotencyKey: call.data.idempotencyKey,
        });
        await complete(call, 'success');
        expect(h.control.pending).toBe(false);
        expect(h.control.notice).toBe('');
      }
      for (const mode of ['collection', 'navigation'] as const) {
        await h.show({ ...h.props, pins: loaded(['a', 'b', 'c']), mode });
        expect(h.control.entries.filter((entry) => entry.type !== 'separator').map((entry) => entry.label)).toEqual([
          m.library_pin_unpin(),
        ]);
      }
      await h.show({ ...h.props, pins: loaded(['b', 'a']), mode: 'list' });
      expect(
        h.control.entries.some((entry) => entry.type !== 'separator' && entry.label === m.library_pin_move_up()),
      ).toBe(false);
      await h.click('down');
      const conflict = calls.at(-1)!;
      await complete(conflict, 'conflict');
      expect(h.control.notice).toBe(m.library_pin_conflict());
      await h.click('down');
      expect(calls.at(-1)!.data.idempotencyKey).not.toBe(conflict.data.idempotencyKey);
      await complete(calls.at(-1)!, 'full');
      expect(h.control.notice).toBe(m.library_pin_limit());
      expect(h.groups[0]!.navigation).toHaveBeenCalledTimes(6);
      expect(h.groups[0]!.cache).toHaveBeenCalledTimes(6);
    } finally {
      await h.close();
    }
  });
});
