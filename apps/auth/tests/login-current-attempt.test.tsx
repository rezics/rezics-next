import { afterAll, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { PasskeySignInResult } from '../src/passkeys';
import { recoveryPage } from '../../../services/auth/src/recovery-page';

// Reuse the mounted Auth DOM fixture and story input helpers, without a server.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/login' });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  scrollTo: dom.scrollTo.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: globalThis.fetch,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { createRoot } = await import('react-dom/client');
const { createBrowserHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/login');
const { Route: StepUpRoute } = await import('../src/routes/step-up');
const passkeys = await import('../src/passkeys');
const { WebAuthnAbortService } = await import('@simplewebauthn/browser');
const { fill, button } = await import('../src/stories/accounts-operations/story');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
const flush = (action: () => void | Promise<void>) =>
  act(async () => {
    await action();
  });
afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

async function open(path = '/login') {
  window.history.replaceState(null, '', `${path}?return_to=%2Fsecurity`);
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host),
    parent = createRootRoute();
  const route = Route.update({ id: '/login', path: '/login', getParentRoute: () => parent } as never);
  const stepUp = StepUpRoute.update({ id: '/step-up', path: '/step-up', getParentRoute: () => parent } as never);
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: parent.addChildren([route, stepUp, away]) });
  const requests: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  const ceremonies: ReturnType<typeof Promise.withResolvers<PasskeySignInResult>>[] = [];
  globalThis.fetch = ((path, init) => {
    if (path === '/recovery/page')
      return Promise.resolve(
        Response.json(
          recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
        ),
      );
    if (path === '/signin/page')
      return Promise.resolve(
        Response.json({
          methods: { password: true, passkey: true },
          viewer: { kind: 'signed-out' },
          continuation: { href: '/security', requires_sign_in: false },
        }),
      );
    const call = Promise.withResolvers<Response>();
    requests.push(call);
    return call.promise;
  }) as typeof fetch;
  const supported = spyOn(passkeys, 'passkeysSupported').mockReturnValue(true);
  const autofill = spyOn(passkeys, 'passkeyAutofillSupported').mockResolvedValue(true);
  const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation(() => {
    const call = Promise.withResolvers<PasskeySignInResult>();
    ceremonies.push(call);
    return call.promise;
  });
  const cancel = spyOn(WebAuthnAbortService, 'cancelCeremony');
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  const submit = () =>
    host
      .querySelector('form')!
      .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event);
  return {
    host,
    requests,
    ceremonies,
    assign,
    cancel,
    navigate: (to: string) =>
      flush(async () => {
        await router.navigate({ to });
      }),
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
    async close() {
      await flush(() => root.unmount());
      history.destroy();
      host.remove();
      for (const spy of [supported, autofill, signIn, cancel, assign]) spy.mockRestore();
    },
  };
}

test('replacement and destination changes keep old password, prompt and autofill results out of the current form', async () => {
  const page = await open();
  try {
    await flush(() => button(page.host, 'Sign in with a passkey')!.click());
    await page.password();
    expect(page.requests).toHaveLength(1);
    expect(page.cancel).toHaveBeenCalled();
    await flush(() => page.ceremonies[0]!.resolve({ ok: false, reason: 'cancelled' }));
    await flush(() => page.ceremonies[1]!.resolve({ ok: true }));
    expect(button(page.host, 'Sign in')!.disabled).toBe(true);
    expect(page.assign).not.toHaveBeenCalled();
    await page.navigate('/login?client_id=reader&scope=openid&scope=&sig=old');
    expect(page.host.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
    await page.password();
    await flush(() => page.requests[1]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 })));
    const error = page.host.querySelector('[role="alert"]')!.textContent;
    await flush(() => page.requests[0]!.resolve(Response.json({})));
    await flush(() => page.ceremonies[2]!.resolve({ ok: false, reason: 'unavailable' }));
    expect(page.host.querySelector('[role="alert"]')!.textContent).toBe(error);
    expect(page.assign).not.toHaveBeenCalled();
    await page.password();
    await flush(() => page.requests[2]!.resolve(Response.json({})));
    expect(page.assign).toHaveBeenCalledWith('https://auth.test/authorize?client_id=reader&scope=openid&scope=');
  } finally {
    await page.close();
  }
});

test('dismissed prompts recover, and departure or cached restoration retires pending work and clears credentials', async () => {
  const page = await open();
  try {
    await flush(() => button(page.host, 'Sign in with a passkey')!.click());
    await flush(() => page.ceremonies[1]!.resolve({ ok: false, reason: 'cancelled' }));
    expect(page.host.querySelector('[role="alert"]')).toBeNull();
    expect(button(page.host, 'Sign in')!.disabled).toBe(false);
    await page.password();
    await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
    await flush(() =>
      window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
    );
    expect(page.requests).toHaveLength(1);
    expect(page.host.querySelector<HTMLInputElement>('#login-email')!.value).toBe('');
    expect(page.host.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
    await flush(() => page.requests[0]!.resolve(Response.json({})));
    expect(page.assign).not.toHaveBeenCalled();
    await page.navigate('/away');
    await flush(() => page.ceremonies.at(-1)!.resolve({ ok: true }));
    expect(page.assign).not.toHaveBeenCalled();
    await page.navigate('/login');
    await page.password();
    expect(page.requests).toHaveLength(2);
    await flush(() => page.requests[1]!.resolve(Response.json({})));
    expect(page.assign).toHaveBeenCalledWith('https://auth.test/security');
  } finally {
    await page.close();
  }
});

test('validation, replacement, failure and retry resume only the current authorization request', async () => {
  const page = await open('/step-up');
  try {
    await flush(page.submit);
    expect(page.requests).toHaveLength(0);
    expect(document.activeElement?.id).toBe('step-up-email');
    await flush(() => button(page.host, 'Verify with a passkey')!.click());
    await flush(() => page.ceremonies[0]!.resolve({ ok: false, reason: 'cancelled' }));
    expect(page.host.querySelector('[role=alert]')).toBeNull();
    expect(button(page.host, 'Verify your identity')!.disabled).toBe(false);
    await flush(() => button(page.host, 'Verify with a passkey')!.click());
    await page.password();
    expect(page.requests).toHaveLength(1);
    expect(page.cancel).toHaveBeenCalled();
    await flush(() => page.ceremonies[1]!.resolve({ ok: false, reason: 'cancelled' }));
    expect(button(page.host, 'Verify your identity')!.disabled).toBe(true);
    await page.navigate('/step-up?client_id=reader&scope=openid&scope=&sig=old&exp=1&prompt=login&max_age=60');
    expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
    await page.password();
    expect(page.requests).toHaveLength(2);
    await flush(() => page.requests[0]!.resolve(Response.json({})));
    expect(page.assign).not.toHaveBeenCalled();
    expect(button(page.host, 'Verify your identity')!.disabled).toBe(true);
    await flush(() => page.requests[1]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 })));
    expect(page.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
    await page.password();
    await flush(() => page.requests[2]!.resolve(Response.json({})));
    expect(page.assign).toHaveBeenCalledWith(
      'https://auth.test/authorize?client_id=reader&scope=openid&scope=&max_age=60',
    );
  } finally {
    await page.close();
  }
});

test.each(['password', 'passkey'])(
  '%s departure and cached restoration discard callbacks without replaying sign-in',
  async (method) => {
    const page = await open('/step-up');
    const start = () =>
      method === 'password' ? page.password() : flush(() => button(page.host, 'Verify with a passkey')!.click());
    const complete = (index: number) =>
      flush(() => {
        if (method === 'password') page.requests[index]!.resolve(Response.json({}));
        else page.ceremonies[index]!.resolve({ ok: true });
      });
    try {
      await start();
      await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
      await flush(() =>
        window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
      );
      expect(page.host.querySelector<HTMLInputElement>('#step-up-email')!.value).toBe('');
      expect(page.host.querySelector<HTMLInputElement>('#step-up-password')!.value).toBe('');
      expect(method === 'password' ? page.requests : page.ceremonies).toHaveLength(1);
      await start();
      await complete(0);
      expect(page.assign).not.toHaveBeenCalled();
      expect(button(page.host, 'Verify with a passkey')!.disabled).toBe(true);
      if (method === 'passkey') expect(page.cancel).toHaveBeenCalled();
      await complete(1);
      expect(page.assign).toHaveBeenCalledWith('https://auth.test/security');
      await page.navigate('/step-up?return_to=%2Fsecurity&sig=new');
      await start();
      await page.navigate('/away');
      await complete(2);
      expect(page.assign).toHaveBeenCalledTimes(1);
    } finally {
      await page.close();
    }
  },
);
