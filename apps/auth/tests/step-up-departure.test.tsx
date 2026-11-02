import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { creationFixture, button, dom, fill, flush, open as mount, send } from './creation-page-fixture';
import type { PasskeySignInResult } from '../src/passkeys';

creationFixture();
let cleanup = () => {};
afterEach(() => cleanup());
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true, writable: true });
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const { createRootRoute, createRoute, createRouter, createBrowserHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/step-up');
const passkeys = await import('../src/passkeys');
const { WebAuthnAbortService } = await import('@simplewebauthn/browser');
const signInQuery =
  '?response_type=code&client_id=rezics-website&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid+offline_access&state=opaque%2Bstate%26next%3D%2Fevil&nonce=nonce%2Fone' +
  '&code_challenge=challenge&code_challenge_method=S256&resource=https%3A%2F%2Fapi.rezics.test' +
  '&resource=urn%3Asecond&empty=&prompt=login&prompt=select_account&max_age=600&exp=1893456000&sig=opaque-signature';

async function setup(query = signInQuery) {
  window.history.replaceState(null, '', `/step-up${query}`);
  const parent = createRootRoute();
  const stepUp = Route.update({ id: '/step-up', path: '/step-up', getParentRoute: () => parent } as never);
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree: parent.addChildren([stepUp, away]), history });
  await router.load();
  const supported = spyOn(passkeys, 'passkeysSupported').mockReturnValue(true);
  const ceremony = Promise.withResolvers<PasskeySignInResult>();
  const signInWithPasskey = spyOn(passkeys, 'signInWithPasskey').mockImplementation(() => ceremony.promise);
  const cancel = spyOn(WebAuthnAbortService, 'cancelCeremony');
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  const page = await mount(<RouterProvider router={router} />, {});
  const navigate = (href: string) => flush(() => void router.navigate({ href }));
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const dispose = () => {
    history.destroy();
    for (const spy of [supported, signInWithPasskey, cancel, assign]) spy.mockRestore();
  };
  cleanup = dispose;
  return {
    ...page,
    router,
    ceremony,
    cancel,
    assign,
    navigate,
    choose,
    unload,
    dispose,
  };
}

test('Stay keeps validation and masked input; replacement resets it and Leave clears the next draft', async () => {
  const page = await setup();
  expect(page.unload()).toBe(false);
  const email = page.host.querySelector<HTMLInputElement>('[name=email]')!;
  const password = page.host.querySelector<HTMLInputElement>('[name=password]')!;
  await flush(() => {
    fill(email, 'invalid');
    fill(password, 'private password');
    send(page.host);
  });
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(page.unload()).toBe(true);
  await page.navigate('/away');
  expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
  await page.choose('Stay');
  expect([email.value, password.value, password.type, email.getAttribute('aria-invalid')]).toEqual([
    'invalid',
    'private password',
    'password',
    'true',
  ]);
  expect(document.activeElement).toBe(email);
  await page.navigate('/step-up?return_to=%2Fsecurity&nonce=replaced');
  expect(page.router.history.location.pathname).toBe('/step-up');
  expect(page.host.querySelector<HTMLInputElement>('[name=email]')!.value).toBe('');
  expect(page.unload()).toBe(false);
  await flush(() => fill(page.host.querySelector('[name=email]')!, 'reader@example.test'));
  await page.navigate('/away');
  await page.choose('Leave');
  expect(page.router.history.location.pathname).toBe('/away');
});

test('Leave retires a dispatched password continuation without cancelling its sign-in', async () => {
  const page = await setup();
  await flush(() => {
    fill(page.host.querySelector('[name=email]')!, 'reader@example.test');
    fill(page.host.querySelector('[name=password]')!, 'private password');
    send(page.host);
  });
  expect(page.calls[0]?.path).toBe('/signin');
  expect(page.unload()).toBe(true);
  await page.navigate('/away');
  await page.choose('Leave');
  expect(page.cancel).not.toHaveBeenCalled();
  page.calls[0]!.resolve(Response.json({ success: true }));
  await flush(() => Promise.resolve());
  expect(page.assign).not.toHaveBeenCalled();
});

test('Leave cancels an unfinished browser passkey ceremony', async () => {
  const page = await setup();
  await flush(() => button(page.host, 'Verify with a passkey')!.click());
  expect(page.unload()).toBe(true);
  await page.navigate('/away');
  await page.choose('Leave');
  expect(page.cancel).toHaveBeenCalledTimes(1);
  expect(page.calls).toHaveLength(0);
  page.ceremony.resolve({ ok: false, reason: 'cancelled' });
});

test('successful confirmation releases a blocked departure and continues to its target', async () => {
  const page = await setup();
  await flush(() => {
    fill(page.host.querySelector('[name=email]')!, 'reader@example.test');
    fill(page.host.querySelector('[name=password]')!, 'private password');
    send(page.host);
  });
  await page.navigate('/away');
  expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
  page.calls[0]!.resolve(Response.json({ success: true }));
  await flush(() => Promise.resolve());
  expect(page.router.history.location.pathname).toBe('/step-up');
  expect(page.assign).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
  expect(page.unload()).toBe(false);
});
