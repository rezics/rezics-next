import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { Route } from '../src/routes/login';
import * as passkeys from '../src/passkeys';
import * as stepUp from '../src/step-up';
creationFixture();
const scroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() =>
  Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true, writable: true }),
);
afterAll(() => {
  if (scroll) Object.defineProperty(globalThis, 'scrollTo', scroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const advice = (account: string | null = 'a', required = false, href = '/security') => ({
  methods: { password: true, passkey: true },
  viewer: account
    ? { kind: 'signed-in', account_id: account, email: `${account}@example.test` }
    : { kind: 'signed-out' },
  continuation: { href, requires_sign_in: required },
});
async function setup(initial = advice(), query = '?return_to=%2Fsecurity', supported = true) {
  window.history.replaceState(null, '', `/login${query}`);
  for (const spy of [
    spyOn(passkeys, 'passkeysSupported').mockReturnValue(supported),
    spyOn(passkeys, 'passkeyAutofillSupported').mockResolvedValue(false),
  ])
    cleanup.push(() => spy.mockRestore());
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  const ceremony = Promise.withResolvers<passkeys.PasskeySignInResult>();
  const passkey = spyOn(passkeys, 'signInWithPasskey').mockReturnValue(ceremony.promise);
  cleanup.push(
    () => assign.mockRestore(),
    () => passkey.mockRestore(),
  );
  const p = await open(null, {});
  const transport = globalThis.fetch;
  const reads: { body: unknown; resolve: (r: Response) => void }[] = [];
  globalThis.fetch = ((path, init) => {
    if (path !== '/signin/page') return transport(path, init);
    const response = Promise.withResolvers<Response>();
    reads.push({ body: JSON.parse(String(init?.body)), resolve: response.resolve });
    if (reads.length === 1) response.resolve(Response.json(initial));
    return response.promise;
  }) as typeof fetch;
  const parent = createRootRoute();
  const login = Route.update({ id: '/login', path: '/login', getParentRoute: () => parent } as never);
  const history = createBrowserHistory({ window: dom });
  cleanup.push(() => history.destroy());
  const router = createRouter({ history, routeTree: parent.addChildren([login]) });
  await router.load();
  await p.render(<RouterProvider router={router} />);
  const click = (label: string) => flush(() => button(p.host, label)!.click());
  const enter = () =>
    flush(() => {
      fill(p.host.querySelector<HTMLInputElement>('#login-email')!, 'b@example.test');
      fill(p.host.querySelector<HTMLInputElement>('#login-password')!, 'private password');
    });
  const review = async (next: object | null) => {
    await click('Review current session');
    expect(p.host.textContent).not.toContain('a@example.test');
    await flush(() => reads.at(-1)!.resolve(next ? Response.json(next) : new Response('', { status: 503 })));
  };
  return { ...p, reads, assign, ceremony, passkey, click, enter, review };
}

test.each(['password', 'passkey'])(
  'requires_sign_in excludes Switch and Review during pending %s work',
  async (method) => {
    const p = await setup(advice('a', true));
    const oldSwitch = button(p.host, 'Use a different account')!;
    await p.enter();
    await flush(() => {
      if (method === 'password') send(p.host);
      else button(p.host, 'Sign in with a passkey')!.click();
      oldSwitch.click(); // React has not rendered disabled yet.
      button(p.host, 'Review current session')!.click();
    });
    expect(button(p.host, 'Continue')).toBeUndefined();
    expect(p.host.querySelector<HTMLInputElement>('#login-email')!.value).toBe('b@example.test');
    expect(p.reads).toHaveLength(1);
    expect(p.calls).toHaveLength(method === 'password' ? 1 : 0);
    await flush(() => {
      if (method === 'password') p.calls[0]!.resolve(Response.json({}));
      else p.ceremony.resolve({ ok: true });
    });
    expect(p.assign).toHaveBeenCalledTimes(1);
  },
);

test('switching A to B retires old Continue before render and during replacement; competing submits dispatch once', async () => {
  const p = await setup();
  const oldContinue = button(p.host, 'Continue')!;
  await flush(() => {
    button(p.host, 'Use a different account')!.click();
    oldContinue.click();
  });
  expect(p.assign).not.toHaveBeenCalled();
  expect(button(p.host, 'Continue')).toBeUndefined();
  expect(p.host.textContent).not.toContain('a@example.test');
  expect(document.activeElement?.id).toBe('login-email');
  await p.enter();
  await flush(() => {
    send(p.host);
    send(p.host);
    oldContinue.click();
    button(p.host, 'Sign in with a passkey')!.click();
  });
  expect(p.calls).toHaveLength(1);
  expect(p.passkey).not.toHaveBeenCalled();
  expect(p.assign).not.toHaveBeenCalled();
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 })));
  expect(p.host.querySelector('[role=alert]')?.textContent).toContain('email or password is incorrect');
  expect(document.activeElement?.getAttribute('role')).toBe('alert');
});

test('a same-turn Switch cannot submit the retired form credentials or open its passkey prompt', async () => {
  const p = await setup(advice('a', true));
  await p.enter();
  await flush(() => {
    button(p.host, 'Use a different account')!.click();
    send(p.host);
    button(p.host, 'Sign in with a passkey')!.click();
  });
  expect(p.calls).toHaveLength(0);
  expect(p.passkey).not.toHaveBeenCalled();
  expect(p.host.querySelector<HTMLInputElement>('#login-password')!.value).toBe('');
});

test.each(['a', 'b', null, 'unavailable'])(
  'unknown authentication review observes %s without resend or attribution',
  async (viewer) => {
    const p = await setup();
    await p.click('Use a different account');
    await p.enter();
    await flush(() => send(p.host));
    await flush(() => p.calls[0]!.resolve(new Response('', { status: 502 })));
    expect(p.host.textContent).toContain('outcome could not be confirmed');
    expect(button(p.host, 'Continue')).toBeUndefined();
    await p.review(viewer === 'unavailable' ? null : advice(viewer));
    expect(p.calls).toHaveLength(1);
    expect(p.reads).toHaveLength(2);
    expect(p.reads.map((r) => r.body)).toEqual([
      { query: '?return_to=%2Fsecurity' },
      { query: '?return_to=%2Fsecurity' },
    ]);
    expect(p.assign).not.toHaveBeenCalled();
    expect(p.host.textContent).toContain('A matching account does not confirm this attempt');
    if (viewer === 'b') expect(p.host.textContent).toContain('account has changed');
    if (viewer === null) expect(p.host.textContent).toContain('now signed out');
    if (viewer === 'unavailable') {
      expect(p.host.textContent).not.toContain('a@example.test');
      expect(button(p.host, 'Try loading sign-in again')).not.toBeNull();
    } else if (viewer) {
      await p.click('Continue');
      expect(p.assign).toHaveBeenCalledWith('/security');
    }
  },
);

test('review invalidates the old control, preserves exact native return encoding and does not chain reads', async () => {
  const href = '/authorize?scope=&scope=openid%20profile&state=%2f&state=';
  const p = await setup(advice('a', false, href), '?scope=&scope=openid%20profile&state=%2f&state=');
  const oldContinue = button(p.host, 'Continue')!;
  await flush(() => {
    button(p.host, 'Review current session')!.click();
    oldContinue.click();
  });
  expect(p.assign).not.toHaveBeenCalled();
  expect(p.reads).toHaveLength(2);
  await flush(() => p.reads[1]!.resolve(Response.json(advice('b', false, href))));
  expect(p.host.textContent).not.toContain('a@example.test');
  await p.click('Continue');
  expect(p.assign).toHaveBeenCalledWith(href);
  expect(p.calls).toHaveLength(0);
  expect(p.reads).toHaveLength(2);
});

test('late reviewed advice is retired by pagehide; restoration observes before exposing private controls', async () => {
  const p = await setup();
  await p.click('Review current session');
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  await flush(() => p.reads[1]!.resolve(Response.json(advice('b'))));
  expect(p.host.textContent).not.toContain('b@example.test');
  await flush(() =>
    window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
  );
  expect(button(p.host, 'Continue')).toBeUndefined();
  expect(p.reads).toHaveLength(3);
  await flush(() => p.reads[2]!.resolve(Response.json(advice('c'))));
  expect(p.host.textContent).toContain('c@example.test');
  expect(p.calls).toHaveLength(0);
});

test.each(['method', 'browser'])(
  '%s unavailability keeps password validation attached and focuses the first invalid field',
  async (kind) => {
    const p = await setup(
      { ...advice(null), methods: { password: true, passkey: kind !== 'method' } },
      '?return_to=%2Fsecurity',
      kind !== 'browser',
    );
    expect(button(p.host, 'Sign in with a passkey')).toBeUndefined();
    expect(p.host.textContent).toContain(
      kind === 'method' ? 'Passkey sign-in is unavailable here' : 'not supported by this browser',
    );
    await flush(() => send(p.host));
    expect(p.calls).toHaveLength(0);
    const email = p.host.querySelector<HTMLInputElement>('#login-email')!;
    expect(document.activeElement).toBe(email);
    expect(email.getAttribute('aria-describedby')).toBe('login-email-error');
    expect(p.host.querySelector('#login-password')?.getAttribute('aria-describedby')).toBe('login-password-error');
  },
);

test('an uncertain explicit passkey offers review without restarting autofill or another assertion', async () => {
  const p = await setup(advice('a', true));
  await p.click('Sign in with a passkey');
  await flush(() => p.ceremony.resolve({ ok: false, reason: 'unavailable' }));
  expect(p.host.textContent).toContain('outcome could not be confirmed');
  await p.review(advice('a'));
  expect(p.passkey).toHaveBeenCalledTimes(1);
  expect(p.calls).toHaveLength(0);
  expect(p.assign).not.toHaveBeenCalled();
});

test('session review for an account operation cannot bypass the installed step-up return helper', async () => {
  const confirm = spyOn(stepUp, 'confirmStepUp').mockResolvedValue({ ok: false, message: 'Retained review changed' });
  cleanup.push(() => confirm.mockRestore());
  const p = await setup(advice(), '?management_operation=rename&return_to=%2Faccount%2Frename');
  expect(button(p.host, 'Continue')).toBeUndefined();
  await p.review(advice('b'));
  expect(button(p.host, 'Continue')).toBeUndefined();
  await p.enter();
  await flush(() => send(p.host));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(p.calls).toHaveLength(0);
  expect(p.assign).not.toHaveBeenCalled();
  expect(p.host.textContent).toContain('Retained review changed');
});
