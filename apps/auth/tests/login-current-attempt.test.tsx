import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { button, creationFixture, dom, fill, flush, open as mount } from './creation-page-fixture';
import { WebAuthnAbortService } from '@simplewebauthn/browser';
import { initializeDocumentLocale } from '../src/locale-observation';
import * as passkeys from '../src/passkeys';
import type { PasskeySignInResult } from '../src/passkeys';
import { nativeSignInProof } from './sign-in-fixture';

creationFixture();
const { Route } = await import('../src/routes/login');
const { Route: StepUpRoute } = await import('../src/routes/step-up');
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function open(path = '/login') {
  initializeDocumentLocale('en');
  window.history.replaceState(null, '', `${path}?return_to=%2Fsecurity`);
  const parent = createRootRoute();
  const route = createRoute({ path: '/login', getParentRoute: () => parent, component: Route.options.component });
  const stepUp = createRoute({
    path: '/step-up',
    getParentRoute: () => parent,
    component: StepUpRoute.options.component,
  });
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: parent.addChildren([route, stepUp, away]) });
  cleanup.push(() => history.destroy());
  const { host, calls, render } = await mount(null, {});
  const ceremonies: ReturnType<typeof Promise.withResolvers<PasskeySignInResult>>[] = [];
  const supported = spyOn(passkeys, 'passkeysSupported').mockReturnValue(true);
  const autofill = spyOn(passkeys, 'passkeyAutofillSupported').mockResolvedValue(true);
  const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation(() => {
    const call = Promise.withResolvers<PasskeySignInResult>();
    ceremonies.push(call);
    return call.promise;
  });
  const cancel = spyOn(WebAuthnAbortService, 'cancelCeremony');
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  for (const spy of [supported, autofill, signIn, cancel, assign]) cleanup.push(() => spy.mockRestore());
  await router.load();
  await render(<RouterProvider router={router} />);
  const submit = () =>
    host
      .querySelector('form')!
      .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  return {
    host,
    calls,
    ceremonies,
    assign,
    cancel,
    navigate: (to: string) =>
      flush(async () => {
        await router.navigate({ to });
      }),
    async leave() {
      await flush(() => {
        void router.navigate({ to: '/away' });
      });
      await flush(() => button(document.body, 'Leave')!.click());
    },
    submit,
    async password() {
      await flush(() => {
        fill(host.querySelector('input[name=email]')!, 'reader@example.test');
        fill(host.querySelector('input[name=password]')!, 'private password');
      });
      await flush(() => {
        submit();
        submit();
      });
    },
    startFreshConfirmation: () => flush(() => button(host, 'Start a new identity confirmation')!.click()),
  };
}

test('replacement and destination changes keep old password and autofill results out of the current form', async () => {
  const page = await open();
  await page.password();
  expect(page.calls).toHaveLength(1);
  expect(page.cancel).toHaveBeenCalled();
  await flush(() => page.ceremonies[0]!.resolve({ ok: false, reason: 'cancelled' }));
  await flush(() => page.ceremonies[0]!.resolve({ ok: true }));
  expect(button(page.host, 'Sign in')!.disabled).toBe(true);
  expect(page.assign).not.toHaveBeenCalled();
  await page.navigate('/login?client_id=reader&scope=openid&scope=&sig=old');
  expect(page.host.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
  await page.password();
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 })));
  const error = page.host.querySelector('[role="alert"]')!.textContent;
  await flush(() => page.calls[0]!.resolve(Response.json(nativeSignInProof(page.calls[0]!.body))));
  await flush(() => page.ceremonies[1]!.resolve({ ok: false, reason: 'unavailable' }));
  expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(error);
  expect(page.assign).not.toHaveBeenCalled();
  await page.password();
  await flush(() => page.calls[2]!.resolve(Response.json(nativeSignInProof(page.calls[2]!.body))));
  expect(page.assign).toHaveBeenCalledWith('https://auth.test/authorize?client_id=reader&scope=openid&scope=');
});

test('dismissed prompts recover, and departure or cached restoration retires pending work and clears credentials', async () => {
  const page = await open();
  await flush(() => button(page.host, 'Sign in with a passkey')!.click());
  await flush(() => page.ceremonies[1]!.resolve({ ok: false, reason: 'cancelled' }));
  expect(page.host.querySelector('[role="alert"]')?.textContent).toContain('cancelled before sign-in was sent');
  expect(button(page.host, 'Sign in')!.disabled).toBe(false);
  await page.password();
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  await flush(() =>
    window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
  );
  expect(page.calls).toHaveLength(1);
  expect(page.host.querySelector<HTMLInputElement>('#login-email')!.value).toBe('');
  expect(page.host.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
  await flush(() => page.calls[0]!.resolve(Response.json(nativeSignInProof(page.calls[0]!.body))));
  expect(page.assign).not.toHaveBeenCalled();
  await page.navigate('/away');
  await flush(() => page.ceremonies.at(-1)!.resolve({ ok: true }));
  expect(page.assign).not.toHaveBeenCalled();
  await page.navigate('/login');
  await page.password();
  expect(page.calls).toHaveLength(2);
  await flush(() => page.calls[1]!.resolve(Response.json(nativeSignInProof(page.calls[1]!.body))));
  expect(page.assign).toHaveBeenCalledWith('https://auth.test/security');
});

test('validation, replacement, failure and retry resume only the current authorization request', async () => {
  const page = await open('/step-up');
  await flush(page.submit);
  expect(page.calls).toHaveLength(0);
  expect(document.activeElement?.id).toBe('step-up-email');
  await flush(() => button(page.host, 'Verify with a passkey')!.click());
  await flush(() => page.ceremonies[0]!.resolve({ ok: false, reason: 'cancelled' }));
  expect(page.host.querySelector('[role=alert]')).toBeNull();
  expect(button(page.host, 'Verify your identity')!.disabled).toBe(false);
  await flush(() => button(page.host, 'Verify with a passkey')!.click());
  await page.password();
  expect(page.calls).toHaveLength(1);
  expect(page.cancel).toHaveBeenCalled();
  await flush(() => page.ceremonies[1]!.resolve({ ok: false, reason: 'cancelled' }));
  expect(button(page.host, 'Verify your identity')!.disabled).toBe(true);
  await page.navigate('/step-up?client_id=reader&scope=openid&scope=&sig=old&exp=1&prompt=login&max_age=60');
  expect(page.host.querySelector('#step-up-password')).toBeNull();
  expect(page.calls).toHaveLength(1);
  await page.startFreshConfirmation();
  expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
  await page.password();
  expect(page.calls).toHaveLength(2);
  await flush(() => page.calls[0]!.resolve(Response.json(nativeSignInProof(page.calls[0]!.body))));
  expect(page.assign).not.toHaveBeenCalled();
  expect(button(page.host, 'Verify your identity')!.disabled).toBe(true);
  await flush(() => page.calls[1]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 })));
  expect(page.host.querySelector('[role="alert"]')).not.toBeNull();
  expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
  await page.password();
  await flush(() => page.calls[2]!.resolve(Response.json(nativeSignInProof(page.calls[2]!.body))));
  expect(page.assign).toHaveBeenCalledWith(
    'https://auth.test/authorize?client_id=reader&scope=openid&scope=&max_age=60',
  );
});

test.each(['password', 'passkey'])(
  '%s departure and cached restoration discard callbacks without replaying sign-in',
  async (method) => {
    const page = await open('/step-up');
    const start = () =>
      method === 'password' ? page.password() : flush(() => button(page.host, 'Verify with a passkey')!.click());
    const complete = (index: number) =>
      flush(() => {
        if (method === 'password')
          page.calls[index]!.resolve(Response.json(nativeSignInProof(page.calls[index]!.body)));
        else page.ceremonies[index]!.resolve({ ok: true });
      });
    await start();
    await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
    await flush(() =>
      window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
    );
    expect(page.host.querySelector('#step-up-email')).toBeNull();
    expect(page.host.querySelector('#step-up-password')).toBeNull();
    expect(method === 'password' ? page.calls : page.ceremonies).toHaveLength(1);
    await page.startFreshConfirmation();
    expect(page.host.querySelector<HTMLInputElement>('#step-up-email')!.value).toBe('');
    expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
    expect(method === 'password' ? page.calls : page.ceremonies).toHaveLength(1);
    await start();
    await complete(0);
    expect(page.assign).not.toHaveBeenCalled();
    expect(button(page.host, 'Verify with a passkey')!.disabled).toBe(true);
    if (method === 'passkey') expect(page.cancel).toHaveBeenCalled();
    await complete(1);
    expect(page.assign).toHaveBeenCalledWith('https://auth.test/security');
    await page.navigate('/step-up?return_to=%2Fsecurity&sig=new');
    await page.startFreshConfirmation();
    await start();
    await page.leave();
    await complete(2);
    expect(page.assign).toHaveBeenCalledTimes(1);
  },
);
