import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import {
  readRenameContinuation,
  saveRenameContinuation,
  RENAME_PROFILE,
  type RenameRead,
  type RenameResult,
  type RenameSource,
} from '../src/account-rename';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/account/rename' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  scrollTo: (_options?: unknown) => {},
  getComputedStyle: dom.getComputedStyle.bind(dom),
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { RenameAccountPage } = await import('../src/routes/account.rename');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
overwriteGetLocale(() => 'en');
const target = (accountId = 'account', handle: string | null = 'before') => ({
  accountId,
  handle,
  clientId: RENAME_PROFILE.client_id,
  scopes: ['account:update'],
});
const ready = (accountId = 'account'): RenameRead => ({ kind: 'ready', target: target(accountId) });
const source = (changes: Partial<RenameSource> = {}): RenameSource => ({
  readCurrent: async () => ready(),
  run: async () => ({ kind: 'denied' }),
  stepUp: async () => false,
  ...changes,
});
const flush = async (action: () => unknown) => act(async () => void (await action()));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  window.sessionStorage.clear();
});
afterAll(async () => {
  for (const [name, value] of previous) {
    if (value) Object.defineProperty(globalThis, name, value);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

async function mount(initial: RenameSource) {
  let replaceSource!: (next: RenameSource) => void;
  function Rename() {
    const [currentSource, setSource] = useState(initial);
    replaceSource = (next) => setSource(() => next);
    return <RenameAccountPage source={currentSource} />;
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/account/rename', component: Rename }),
    createRoute({ getParentRoute: () => rootRoute, path: '/next', component: () => <p>Next</p> }),
    createRoute({ getParentRoute: () => rootRoute, path: '/step-up', component: () => <p>Step-up</p> }),
  ]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/account/rename'] }) });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await flush(() => root.render(<RouterProvider router={router} />));
  close = async () => {
    await flush(() => root.unmount());
    host.remove();
  };
  return { host, router, replaceSource: (next: RenameSource) => flush(() => replaceSource(next)) };
}
const setHandle = (host: HTMLElement, value: string) =>
  flush(() => {
    const input = host.querySelector<HTMLInputElement>('#rename-handle')!;
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
  });
const confirm = (host: HTMLElement) => flush(() => host.querySelector<HTMLInputElement>('#rename-confirm')!.click());
const submit = (host: HTMLElement) =>
  flush(() => host.querySelector('form')!.dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true })));
async function startNavigation(router: ReturnType<typeof createRouter>, to: string) {
  let navigation!: Promise<unknown>;
  await act(async () => {
    navigation = router.navigate({ to } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { navigation };
}

test('clean navigation is quiet; Stay preserves the proposed handle and confirmation', async () => {
  const ui = await mount(source());
  const { navigation: clean } = await startNavigation(ui.router, '/next');
  await flush(() => clean);
  const { navigation: back } = await startNavigation(ui.router, '/account/rename');
  await flush(() => back);
  await setHandle(ui.host, 'after');
  await confirm(ui.host);
  const { navigation } = await startNavigation(ui.router, '/next');
  expect(ui.host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-stay]')!.click());
  await flush(() => navigation);
  const input = ui.host.querySelector<HTMLInputElement>('#rename-handle')!;
  expect(input.value).toBe('after');
  expect(ui.host.querySelector<HTMLInputElement>('#rename-confirm')!.checked).toBe(true);
  expect(document.activeElement).toBe(input);
});

test('Leave clears an unsent review before navigation', async () => {
  const ui = await mount(source());
  await setHandle(ui.host, 'after');
  await confirm(ui.host);
  const { navigation } = await startNavigation(ui.router, '/next');
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-leave]')!.click());
  await flush(() => navigation);
  expect(readRenameContinuation()).toBeNull();
  await flush(() => ui.router.navigate({ to: '/account/rename' } as never));
  expect(ui.host.querySelector<HTMLInputElement>('#rename-handle')!.value).toBe('');
});

test('Leave preserves the identity of an unresolved dispatched rename', async () => {
  const completion = deferred<RenameResult>();
  const ui = await mount(
    source({
      run: async (attempt) => {
        attempt.submitted = true;
        saveRenameContinuation(attempt);
        return completion.promise;
      },
    }),
  );
  await setHandle(ui.host, 'after');
  await confirm(ui.host);
  await submit(ui.host);
  const saved = readRenameContinuation();
  const { navigation } = await startNavigation(ui.router, '/next');
  expect(ui.host.textContent).toContain(m.auth_rename_departure_pending());
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-leave]')!.click());
  await flush(() => navigation);
  expect(readRenameContinuation()).toEqual(saved);
  completion.resolve({ kind: 'renamed', target: target('account', 'after') });
  await flush(() => Promise.resolve());
  expect(ui.host.textContent).toContain('Next');
});

test('step-up return is allowed and a replacement account revokes the old review', async () => {
  const ui = await mount(source({ run: async () => ({ kind: 'step-up' }), stepUp: async () => true }));
  await setHandle(ui.host, 'after');
  await confirm(ui.host);
  await submit(ui.host);
  const { navigation: stepUp } = await startNavigation(ui.router, '/step-up');
  await flush(() => stepUp);
  expect(ui.host.querySelector('[role="alertdialog"]')).toBeNull();
  const { navigation: returned } = await startNavigation(ui.router, '/account/rename');
  await flush(() => returned);
  expect(ui.host.textContent).toContain(m.auth_rename_reconfirm());
  const { navigation: leaving } = await startNavigation(ui.router, '/next');
  await ui.replaceSource(source({ readCurrent: async () => ready('replacement') }));
  await flush(() => leaving);
  await flush(() => ui.router.navigate({ to: '/account/rename' } as never));
  expect(ui.host.querySelector<HTMLInputElement>('#rename-handle')!.value).toBe('');
});
