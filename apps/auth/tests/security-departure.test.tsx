import { afterAll, afterEach, expect, test } from 'bun:test';
import { creationFixture, dom, flush, open } from './creation-page-fixture';
import type { SecurityActionResult } from '../src/security-reconciliation';
import type { SecuritySource } from '../src/security-reconciliation';

creationFixture();
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: () => {}, configurable: true, writable: true });
const { createBrowserHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { SecurityPage } = await import('../src/routes/security');
const { initial } = await import('../src/stories/accounts-security/security/security.stories');
const { populatedInventory } = await import('../src/stories/accounts-operations/story');
let destroyHistory: (() => void) | undefined;
afterEach(() => {
  destroyHistory?.();
  destroyHistory = undefined;
});
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});

const tick = () => flush(() => new Promise((resolve) => setTimeout(resolve, 0)));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function mount(securitySource: SecuritySource) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/security',
      component: () => (
        <SecurityPage
          initial={initial}
          inventorySource={populatedInventory}
          identitySource={async () => ({ kind: 'unavailable' })}
          securitySource={securitySource}
        />
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: '/next', component: () => <p>Next</p> }),
  ]);
  window.history.replaceState(null, '', '/security');
  const history = createBrowserHistory({ window: dom });
  destroyHistory = () => history.destroy();
  const router = createRouter({ routeTree, history });
  await router.load();
  window.confirm = () => true;
  const ui = await open(<RouterProvider router={router} />, { account_id: 'account' });
  await tick();
  return { ...ui, router };
}
async function startNavigation(router: ReturnType<typeof createRouter>, to: '/security' | '/next') {
  let navigation!: Promise<unknown>;
  await flush(async () => {
    navigation = router.navigate({ to } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { navigation };
}
async function setPassword(host: HTMLElement, value: string) {
  await flush(() => {
    const input = host.querySelector<HTMLInputElement>('#security-new-password')!;
    Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new dom.Event('input', { bubbles: true }));
  });
}

test('clean pages leave freely; Stay keeps a masked password and Leave clears it', async () => {
  const ui = await mount({ read: async () => ({ kind: 'unavailable' }), act: async () => ({ kind: 'denied' }) });
  const cleanUnload = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(cleanUnload);
  expect(cleanUnload.defaultPrevented).toBe(false);
  const clean = await startNavigation(ui.router, '/next');
  await flush(() => clean.navigation);
  expect(ui.router.state.location.pathname).toBe('/next');
  await flush(() => ui.router.navigate({ to: '/security' } as never));
  await tick();

  const secret = 'a new private password';
  await setPassword(ui.host, secret);
  const input = ui.host.querySelector<HTMLInputElement>('#security-new-password')!;
  input.focus();
  const dirtyUnload = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirtyUnload);
  expect(dirtyUnload.defaultPrevented).toBe(true);
  const { navigation: stayed } = await startNavigation(ui.router, '/next');
  const dialog = ui.host.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).not.toContain(secret);
  expect(document.activeElement).toBe(dialog.querySelector('[data-stay]'));
  await flush(() => dialog.querySelector<HTMLButtonElement>('[data-stay]')!.click());
  await tick();
  expect(ui.router.state.location.pathname).toBe('/security');
  expect(input.value).toBe(secret);
  expect(input.type).toBe('password');
  expect(document.activeElement).toBe(input);
  void stayed;

  const { navigation: leaving } = await startNavigation(ui.router, '/next');
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-leave]')!.click());
  await flush(() => leaving);
  expect(ui.router.state.location.pathname).toBe('/next');
  await flush(() => ui.router.navigate({ to: '/security' } as never));
  await tick();
  expect(ui.host.querySelector<HTMLInputElement>('#security-new-password')!.value).toBe('');
});

test('Leave retires an unresolved operation without replaying it after return', async () => {
  const action = deferred<SecurityActionResult>();
  let calls = 0;
  const ui = await mount({
    read: async () => ({ kind: 'unavailable' }),
    act: () => {
      calls++;
      return action.promise;
    },
  });
  const button = ui.host
    .querySelector<HTMLButtonElement>('#security-sessions-heading')
    ?.parentElement?.querySelector('button');
  expect(button).not.toBeNull();
  await flush(() => button!.click());
  expect(calls).toBe(1);
  const { navigation: leaving } = await startNavigation(ui.router, '/next');
  expect(ui.host.querySelector('[role="alertdialog"]')).not.toBeNull();
  await flush(() => ui.host.querySelector<HTMLButtonElement>('[data-leave]')!.click());
  await flush(() => leaving);
  expect(ui.router.state.location.pathname).toBe('/next');

  action.resolve({ kind: 'accepted', sessionEnded: false });
  await tick();
  await flush(() => ui.router.navigate({ to: '/security' } as never));
  await tick();
  expect(calls).toBe(1);
  expect(ui.host.querySelector('[role="alertdialog"]')).toBeNull();
});
