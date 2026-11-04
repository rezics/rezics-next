import { afterEach, expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture, button, dom, fill, flush, open as mount, send } from './creation-page-fixture';
import { m } from '../src/paraglide/messages.js';
import type { PasskeySignInResult } from '../src/passkeys';

creationFixture();
let cleanup = () => {};
afterEach(() => cleanup());
const { createRootRoute, createRoute, createRouter, createBrowserHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/step-up');
const passkeys = await import('../src/passkeys');

async function settle() {
  await flush(() => Promise.resolve());
}

async function setup() {
  window.history.replaceState(null, '', '/step-up?return_to=%2Fsecurity');
  const parent = createRootRoute();
  const stepUp = Route.update({ id: '/step-up', path: '/step-up', getParentRoute: () => parent } as never);
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree: parent.addChildren([stepUp, away]), history });
  await router.load();
  const supported = spyOn(passkeys, 'passkeysSupported').mockReturnValue(true);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  const page = await mount(<RouterProvider router={router} />, {});
  cleanup = () => {
    history.destroy();
    supported.mockRestore();
    assign.mockRestore();
  };
  return {
    ...page,
    router,
    assign,
    navigate: (href: string) => flush(() => void router.navigate({ href })),
  };
}

async function restoreFromCache() {
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  const event = new dom.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(event as unknown as Event));
  await settle();
}

function typeCredentials(host: HTMLElement, password: string) {
  fill(host.querySelector<HTMLInputElement>('[name=email]')!, 'former@example.test');
  fill(host.querySelector<HTMLInputElement>('[name=password]')!, password);
}

test('a dispatched password remains generically uncertain after cached form retirement and late success', async () => {
  const page = await setup();
  await settle();
  typeCredentials(page.host, 'private password');
  const secret = page.host.querySelector<HTMLInputElement>('[name=password]')!;
  await flush(() => {
    send(page.host);
    send(page.host);
  });
  expect(page.calls.map((call) => call.path)).toEqual(['/signin']);

  const original = globalThis.fetch;
  const advice = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/recovery/page')
      return Promise.resolve(
        Response.json(
          recoveryPage(
            'step-up',
            { minPasswordLength: 8, maxPasswordLength: 128 },
            { kind: 'signed-in', account_id: '00000000-0000-4000-8000-000000000001', email: 'replacement@example.test' },
          ),
        ),
      );
    return original(input, init);
  });
  await restoreFromCache();
  expect(secret.value).toBe('');
  expect(page.host.querySelector('[name=password]')).toBeNull();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  expect(page.host.textContent).not.toContain('former@example.test');
  expect(page.host.textContent).not.toContain('replacement@example.test');
  expect(page.assign).not.toHaveBeenCalled();

  page.calls[0]!.resolve(Response.json({ success: true }));
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  expect(page.assign).not.toHaveBeenCalled();
  advice.mockRestore();
});

test('Stay restores review focus and Leave retires the view without cancelling dispatched authentication', async () => {
  const page = await setup();
  await settle();
  typeCredentials(page.host, 'private password');
  await flush(() => send(page.host));
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
  const shown = new dom.Event('pageshow');
  Object.defineProperty(shown, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(shown as unknown as Event));
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());

  await page.navigate('/away');
  expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
  await flush(() => document.querySelector<HTMLButtonElement>('[data-stay]')!.click());
  expect(document.activeElement).toBe(page.host.querySelector('p[role=status][tabindex="-1"]'));
  await page.navigate('/away');
  await flush(() => document.querySelector<HTMLButtonElement>('[data-leave]')!.click());
  expect(page.router.history.location.pathname).toBe('/away');
  page.calls[0]!.resolve(Response.json({ success: true }));
  await settle();
  expect(page.assign).not.toHaveBeenCalled();
  expect(page.calls).toHaveLength(1);
});

test('a later credential refusal cannot settle an earlier unknown sign-in', async () => {
  const page = await setup();
  await settle();
  const original = globalThis.fetch;
  let attempts = 0;
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/signin') {
      attempts++;
      return attempts === 1
        ? Promise.reject(new TypeError('lost response'))
        : Promise.resolve(Response.json({ code: 'authentication_denied' }, { status: 401 }));
    }
    return original(input, init);
  });

  typeCredentials(page.host, 'first private password');
  await flush(() => send(page.host));
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  typeCredentials(page.host, 'second private password');
  await flush(() => send(page.host));
  await settle();
  expect(attempts).toBe(2);
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  expect(page.host.textContent).not.toContain(m.auth_step_up_return_refused());
  request.mockRestore();
});

test('a first known refusal stays distinct from a passkey cancelled before authentication dispatch', async () => {
  const page = await setup();
  await settle();
  const original = globalThis.fetch;
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/signin')
      return Promise.resolve(Response.json({ code: 'authentication_denied' }, { status: 401 }));
    return original(input, init);
  });
  typeCredentials(page.host, 'private password');
  await flush(() => send(page.host));
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_refused());
  expect(page.host.textContent).not.toContain(m.auth_step_up_return_unknown());
  request.mockRestore();
});

test('passkey prompt cancellation before the sign-in POST is recorded as unsent', async () => {
  const page = await setup();
  await settle();
  const signIn = spyOn(passkeys, 'signInWithPasskey').mockImplementation(async ({ isCurrent }) => {
    expect(isCurrent?.()).toBe(true);
    return { ok: false, reason: 'cancelled' } satisfies PasskeySignInResult;
  });
  await flush(() => button(page.host, m.auth_step_up_passkey())!.click());
  await settle();
  await restoreFromCache();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unsent());
  expect(page.host.textContent).not.toContain(m.auth_step_up_return_unknown());
  expect(page.calls).toHaveLength(0);
  const departure = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(departure as unknown as Event);
  expect(departure.defaultPrevented).toBe(false);
  signIn.mockRestore();
});
