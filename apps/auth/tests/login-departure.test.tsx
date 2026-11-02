import { afterEach, expect, spyOn, test } from 'bun:test';
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
const spies: { mockRestore: () => void }[] = [];
const histories: { destroy: () => void }[] = [];
afterEach(() => {
  for (const history of histories.splice(0)) history.destroy();
  for (const spy of spies.splice(0)) spy.mockRestore();
});
async function setup(query = '?client_id=reader&scope=openid&scope=&sig=old&exp=1&prompt=login') {
  window.history.replaceState(null, '', `/login${query}`);
  spies.push(
    spyOn(passkeys, 'passkeysSupported').mockReturnValue(true),
    spyOn(passkeys, 'passkeyAutofillSupported').mockResolvedValue(true),
  );
  const ceremony = Promise.withResolvers<passkeys.PasskeySignInResult>();
  spies.push(spyOn(passkeys, 'signInWithPasskey').mockReturnValue(ceremony.promise));
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  spies.push(assign);
  const parent = createRootRoute();
  const login = Route.update({ id: '/login', path: '/login', getParentRoute: () => parent } as never);
  const away = createRoute({ getParentRoute: () => parent, path: '/recovery', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: parent.addChildren([login, away]) });
  await router.load();
  const page = await open(<RouterProvider router={router} />, {});
  const navigate = (to = '/recovery') =>
    flush(() => {
      void router.navigate({ to });
    });
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const input = (name: string) => page.host.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  const enter = () =>
    flush(() => {
      fill(input('email'), 'reader@example.test');
      fill(input('password'), 'private password');
    });
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  histories.push(history);
  return { ...page, router, navigate, choose, input, enter, unload, assign, ceremony };
}
test('untouched form and background passkey autofill do not warn or continue after departure', async () => {
  const p = await setup();
  await flush(() => fill(p.input('email'), '   '));
  expect(p.unload()).toBe(false);
  await p.navigate();
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
  await flush(() => p.ceremony.resolve({ ok: true }));
  expect(p.assign).not.toHaveBeenCalled();
});
test('Stay preserves credentials, validation and focus; help links offer Leave without secrets in the dialog', async () => {
  const p = await setup();
  await flush(() => {
    fill(p.input('email'), 'invalid');
    fill(p.input('password'), 'private password');
    send(p.host);
  });
  const email = p.input('email');
  expect(p.unload()).toBe(true);
  await p.navigate();
  expect(document.querySelector('[role=alertdialog]')?.textContent).not.toContain('private password');
  await p.choose('Stay');
  expect(email.value).toBe('invalid');
  expect(email.getAttribute('aria-invalid')).toBe('true');
  expect(p.input('password').value).toBe('private password');
  expect(document.activeElement).toBe(email);
  await flush(() => p.host.querySelector<HTMLAnchorElement>('a[href="/recovery"]')!.click());
  await p.choose('Leave');
  expect(p.router.history.location.pathname).toBe('/recovery');
  expect(p.unload()).toBe(false);
  await p.navigate('/login');
  expect(p.input('password').value).toBe('');
  expect(p.input('email').value).toBe('');
});
test('Stay retains the same dispatched sign-in; completion while prompting uses its validated destination', async () => {
  const p = await setup();
  await p.enter();
  await flush(() => send(p.host));
  await p.navigate();
  await p.choose('Stay');
  expect(p.calls).toHaveLength(1);
  expect(button(p.host, 'Sign in')!.disabled).toBe(true);
  expect(p.input('password').value).toBe('private password');
  await p.navigate();
  await flush(() => p.calls[0]!.resolve(Response.json({})));
  expect(p.assign).toHaveBeenCalledWith('https://auth.test/authorize?client_id=reader&scope=openid&scope=');
  expect(p.unload()).toBe(false);
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
});
test.each(['password', 'passkey'])(
  'Leave retires an explicit %s sign-in without claiming server cancellation',
  async (method) => {
    const p = await setup();
    if (method === 'password') {
      await p.enter();
      await flush(() => send(p.host));
    } else await flush(() => button(p.host, 'Sign in with a passkey')!.click());
    expect(p.unload()).toBe(true);
    await p.navigate();
    await p.choose('Leave');
    await flush(() => {
      if (method === 'password') p.calls[0]!.resolve(Response.json({}));
      else p.ceremony.resolve({ ok: true });
    });
    expect(p.assign).not.toHaveBeenCalled();
    expect(p.unload()).toBe(false);
  },
);
test('replacement authentication revokes a pending attempt and its open departure choice immediately', async () => {
  const p = await setup();
  await p.enter();
  await flush(() => send(p.host));
  await p.navigate();
  await p.navigate('/login?client_id=new&scope=&sig=new');
  await flush(() => p.calls[0]!.resolve(Response.json({})));
  expect(p.input('password').value).toBe('');
  expect(p.assign).not.toHaveBeenCalled();
  expect(p.unload()).toBe(false);
  expect(document.querySelector('[role=alertdialog]')).toBeNull();
});
test('management authentication returns bypass the prompt with the exact request and validated target', async () => {
  const query = '?management_operation=rename&return_to=%2Faccount%2Frename';
  const confirm = spyOn(stepUp, 'confirmStepUp').mockResolvedValue({
    ok: true,
    target: 'https://auth.test/account/rename',
  });
  spies.push(confirm);
  const p = await setup(query);
  await p.enter();
  await flush(() => send(p.host));
  expect(confirm).toHaveBeenCalledWith(
    'reader@example.test',
    'private password',
    query,
    'https://auth.test',
    expect.any(Function),
  );
  expect(p.assign).toHaveBeenCalledWith('https://auth.test/account/rename');
  expect(p.unload()).toBe(false);
});
