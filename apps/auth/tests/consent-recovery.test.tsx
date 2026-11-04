import { afterAll, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, dom } from './creation-page-fixture';
creationFixture();
const originalScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (originalScrollTo) Object.defineProperty(globalThis, 'scrollTo', originalScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRoute, createRouter, createBrowserHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/consent');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

const unknown = 'An earlier approval result is unknown';
const flush = async (action: () => void) => {
  await act(async () => {
    action();
  });
};
test('mounted history survives loss of current review, replacement, new acknowledgement and local refusal', async () => {
  const calls: { url: string; init?: RequestInit; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((input, init) =>
    new Promise<Response>((resolve) => calls.push({ url: String(input), init, resolve }))) as typeof fetch;
  const body = {
    client_id: 'reader',
    display_name: 'Private former target',
    requested: ['openid'],
    scopes: ['openid', 'offline_access'],
    granted: ['offline_access'],
    pending_reduction: false,
    acting_account: { account_id: 'former-actor', email: 'former@example.test' },
    decisions: { allow: true, decline: true, switch_account: true },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const parent = createRootRoute();
  const route = Route.update({ id: '/consent', path: '/consent', getParentRoute: () => parent } as never);
  const outside = createRoute({
    getParentRoute: () => parent,
    path: '/security',
    component: () => <p>Security destination</p>,
  });
  window.history.replaceState(null, '', '/consent?client_id=reader&scope=openid');
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree: parent.addChildren([route, outside]), history });
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  const click = (label: string) => flush(() => button(label).click());
  const answer = (status: number, value: unknown = body) =>
    flush(() => calls.at(-1)!.resolve(Response.json(value, { status })));
  let historyVisible = true;
  const privateGone = () => {
    for (const text of ['former@example.test', 'former-actor', 'Private former target', 'offline_access'])
      expect(host.innerHTML).not.toContain(text);
    expect(button('Approve')).toBeUndefined();
    if (historyVisible) expect(host.textContent).toContain(unknown);
    else expect(host.textContent).not.toContain(unknown);
  };
  const retry = async () => {
    const count = calls.length;
    await flush(() => {
      button('Review current permissions').click();
      button('Review current permissions')?.click();
    });
    expect(calls).toHaveLength(count + 1);
    expect(calls.at(-1)!.init?.method).not.toBe('POST');
    expect(calls.at(-1)!.url).toBe('/consent/reader?scope=openid');
    privateGone();
  };
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  try {
    await answer(200);
    await flush(() => {
      button('Approve').click();
      button('Approve').click();
    });
    expect(calls).toHaveLength(2);
    expect(host.textContent).toContain('Sending approval');
    const switchAccount = host.querySelector<HTMLAnchorElement>('a[href^="/login?"]')!;
    switchAccount.focus();
    await flush(() => switchAccount.click());
    expect(document.querySelector('[role=alertdialog]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Stay');
    await flush(() =>
      document.activeElement!.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role=alertdialog]')).toBeNull();
    expect(document.activeElement).toBe(switchAccount);
    expect(calls).toHaveLength(2);
    expect(button('Approve').disabled).toBe(true);
    // Retire private DOM synchronously even while the POST is still in flight.
    await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
    privateGone();
    await flush(() => window.dispatchEvent(new dom.Event('pageshow')));
    expect(calls).toHaveLength(3);
    await flush(() =>
      calls[1]!.resolve(
        Response.json({
          client_id: 'reader',
          account_id: 'former-actor',
          requested: ['openid'],
          scope: ['offline_access', 'openid'],
        }),
      ),
    );
    expect(host.textContent).not.toContain('Access approved.');
    await answer(401, { code: 'authentication_denied' });
    privateGone();
    const signIn = host.querySelector<HTMLAnchorElement>('a[href^="/login?"]')!;
    expect(new URL(signIn.href).searchParams.get('return_to')).toBe('/consent?client_id=reader&scope=openid');
    await retry();
    await answer(404, {});
    privateGone();
    await retry();
    await answer(200, { malformed: true });
    privateGone();
    expect(host.querySelector('[role=alert]')).not.toBeNull();
    expect(document.activeElement).toBe(button('Review current permissions'));
    await retry();
    const replacement = {
      ...body,
      display_name: 'Current target',
      granted: [],
      acting_account: { account_id: 'replacement', email: 'current@example.test' },
    };
    await answer(200, replacement);
    expect(host.textContent).not.toContain('former@example.test');
    expect(host.textContent).not.toContain('offline_access');
    expect(host.textContent).toContain(unknown);
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Review permissions"]'));
    await click('Approve');
    await click('Hide this explanation');
    historyVisible = false;
    expect(button('Approve').disabled).toBe(true);
    expect(host.textContent).not.toContain(unknown);
    expect(dom.sessionStorage.length).toBe(2);
    await answer(200, { client_id: 'reader', account_id: 'replacement', requested: ['openid'], scope: ['openid'] });
    expect(host.textContent).toContain('Access approved.');
    expect(host.textContent).not.toContain(unknown);
    await retry();
    await answer(200, replacement);
    await click('Decline');
    expect(host.textContent).toContain('An earlier approval may still have taken effect.');
    expect(host.textContent).not.toContain(unknown);
    // Current readback and a local refusal never send an additional decision.
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(2);
    const exit = host.querySelector<HTMLAnchorElement>('a[href="/security"]')!;
    exit.focus();
    await flush(() => exit.click());
    expect(document.querySelector('[role=alertdialog]')?.textContent).toContain('Leaving does not cancel');
    await click('Stay');
    expect(document.activeElement).toBe(exit);
    expect(host.textContent).not.toContain(unknown);
    const unload = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await flush(() => exit.click());
    await click('Leave');
    expect(host.textContent).toContain('Security destination');
    expect(host.textContent).not.toContain('current@example.test');
  } finally {
    await flush(() => root.unmount());
    history.destroy();
    host.remove();
    dom.sessionStorage.clear();
  }
});
