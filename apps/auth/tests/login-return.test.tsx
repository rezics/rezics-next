import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { createBrowserHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as browser from '@simplewebauthn/browser';
import * as passkeys from '../src/passkeys';
import { Route } from '../src/routes/login';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
creationFixture();
const scroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (scroll) Object.defineProperty(globalThis, 'scrollTo', scroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
let time = Date.now();
const advice = (account: string | null = null, password = true) => ({
  methods: { password, passkey: true },
  viewer: account
    ? { kind: 'signed-in', account_id: account, email: `${account}@example.test` }
    : { kind: 'signed-out' },
  continuation: { href: '/security', requires_sign_in: false },
});
async function setup(autofill = false) {
  window.history.replaceState(null, '', '/login?scope=&scope=openid&sig=opaque%2Bsignature');
  const prompt = Promise.withResolvers<any>();
  for (const spy of [
    spyOn(Date, 'now').mockReturnValue((time += 300_000)),
    spyOn(passkeys, 'passkeysSupported').mockReturnValue(true),
    spyOn(passkeys, 'passkeyAutofillSupported').mockResolvedValue(autofill),
    spyOn(browser, 'startAuthentication').mockReturnValue(prompt.promise),
  ])
    cleanup.push(() => spy.mockRestore());
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  cleanup.push(() => assign.mockRestore());
  const p = await open(null, {});
  const calls: { path: string; body: any; resolve: (r: Response) => void }[] = [];
  globalThis.fetch = ((path, init) => {
    const pending = Promise.withResolvers<Response>();
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)), resolve: pending.resolve });
    if (calls.length === 1) pending.resolve(Response.json(advice()));
    return pending.promise;
  }) as typeof fetch;
  const parent = createRootRoute();
  const login = Route.update({ id: '/login', path: '/login', getParentRoute: () => parent } as never);
  const history = createBrowserHistory({ window: dom });
  cleanup.push(() => history.destroy());
  const router = createRouter({ history, routeTree: parent.addChildren([login]) });
  await router.load();
  await p.render(<RouterProvider router={router} />);
  const click = (label: string) => flush(() => button(p.host, label)!.click());
  const reply = (body: object, status = 200) => flush(() => calls.at(-1)!.resolve(Response.json(body, { status })));
  const hide = () =>
    flush(() => {
      window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
      // The browser may freeze immediately, before an async React flush.
      expect(p.host.querySelector('input')).toBeNull();
      expect(p.host.textContent).not.toContain('private@example.test');
    });
  const restore = () =>
    flush(() =>
      window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
    );
  const enter = () =>
    flush(() => {
      fill(p.host.querySelector('#login-email')!, 'private@example.test');
      fill(p.host.querySelector('#login-password')!, 'private-password');
    });
  return { ...p, calls, prompt, assign, click, reply, hide, restore, enter };
}

test('retained password dispatch clears private DOM synchronously, ignores late success, and reads current advice only', async () => {
  const p = await setup();
  await p.enter();
  await flush(() => send(p.host));
  const command = p.calls.at(-1)!;
  await p.hide();
  expect(p.host.textContent).toContain('outcome could not be confirmed');
  expect(document.activeElement?.textContent).toContain('Earlier sign-in');
  await p.restore();
  expect(p.calls.map((c) => c.path)).toEqual(['/signin/page', '/signin', '/signin/page']);
  expect(p.calls.at(-1)!.body).toEqual(p.calls[0]!.body);
  await flush(() => command.resolve(Response.json({})));
  expect(p.assign).not.toHaveBeenCalled();
  await p.reply(advice('replacement', false));
  expect(p.host.textContent).toContain('replacement@example.test');
  expect(p.host.textContent).toContain('outcome could not be confirmed');
  expect(p.host.querySelector<HTMLInputElement>('#login-password')?.value).toBeUndefined();
  await p.click('Continue');
  expect(p.assign).toHaveBeenCalledWith('https://auth.test/security');
  expect(p.calls).toHaveLength(3);
});

test('unknown survives repeated read failure, replacement viewer, and a later credential refusal; dismissal sends nothing', async () => {
  const p = await setup();
  await p.enter();
  await flush(() => send(p.host));
  await p.reply({ error: 'unavailable' }, 503);
  await p.hide();
  await p.restore();
  await p.reply({ error: 'unavailable' }, 503);
  await p.click('Retry');
  await p.reply({ error: 'unavailable' }, 503);
  await p.click('Retry');
  await p.reply(advice('other'));
  await p.click('Use another account');
  await p.enter();
  await flush(() => send(p.host));
  await p.reply({ error: 'authentication_denied' }, 401);
  expect(p.host.textContent).toContain('outcome could not be confirmed');
  const count = p.calls.length;
  await p.click('Dismiss earlier sign-in notice');
  expect(p.calls).toHaveLength(count);
  expect(p.host.textContent).not.toContain('Earlier sign-in');
});

test.each(['options', 'prompt', 'dispatched'] as const)(
  'explicit passkey %s return never resumes a retired ceremony',
  async (phase) => {
    const p = await setup();
    await p.click('Sign in with a passkey');
    const options = p.calls.at(-1)!;
    if (phase !== 'options') await p.reply({ challenge: 'private-challenge' });
    if (phase === 'dispatched') await flush(() => p.prompt.resolve({ private: 'assertion' }));
    const pending = p.calls.at(-1)!;
    await p.hide();
    expect(p.host.textContent).toContain(
      phase === 'options'
        ? 'options were being prepared'
        : phase === 'prompt'
          ? 'waiting for a passkey'
          : 'outcome could not be confirmed',
    );
    await p.restore();
    await p.reply(advice());
    await flush(() => {
      options.resolve(Response.json({ challenge: 'late' }));
      p.prompt.resolve({ private: 'late-assertion' });
      if (phase === 'dispatched') pending.resolve(Response.json({}));
    });
    expect(p.assign).not.toHaveBeenCalled();
    expect(p.calls.filter((c) => c.path === '/signin/passkey')).toHaveLength(phase === 'dispatched' ? 1 : 0);
    expect(p.host.textContent).not.toContain('private-challenge');
  },
);

test.each([false, true])(
  'method ownership excludes races for explicit=%s and autofill after dispatch',
  async (autofill) => {
    const p = await setup(autofill);
    await p.enter();
    if (!autofill) await p.click('Sign in with a passkey');
    await p.reply({ challenge: 'challenge' });
    await flush(() => p.prompt.resolve({ id: 'assertion' }));
    await flush(() => {
      send(p.host);
      send(p.host);
    });
    expect(p.calls.filter((c) => c.path === '/signin')).toHaveLength(0);
    expect(button(p.host, 'Sign in')!.disabled).toBe(true);
    await p.reply({ error: 'authentication_denied' }, 401);
    await flush(() => send(p.host));
    expect(p.calls.filter((c) => c.path === '/signin')).toHaveLength(1);
    await p.reply({ error: 'authentication_denied' }, 401);
  },
);

test('an acknowledgement before pagehide stays historical and return never navigates automatically', async () => {
  const p = await setup();
  await p.enter();
  await flush(() => send(p.host));
  await p.reply({});
  expect(p.assign).toHaveBeenCalledTimes(1);
  await p.hide();
  await p.restore();
  await p.reply(advice('current'));
  expect(p.host.textContent).toContain('Authentication was acknowledged');
  expect(p.assign).toHaveBeenCalledTimes(1);
  expect(p.calls).toHaveLength(3);
});
