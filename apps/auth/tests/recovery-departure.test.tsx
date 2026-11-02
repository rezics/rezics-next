import { afterAll, expect, spyOn, test } from 'bun:test';
import { createBrowserHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement } from 'react';
import { button, creationFixture, dom, fill, flush, open, send } from './creation-page-fixture';

creationFixture();
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true, writable: true });
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const { Route } = await import('../src/routes/recovery');
const firstLink = '#account_id=first&token=first-token';
const secondLink = '#account_id=second&token=second-token';

async function setup(fragment = firstLink) {
  window.history.replaceState(null, '', `/recovery${fragment}`);
  const root = createRootRoute();
  const recovery = Route.update({ id: '/recovery', path: '/recovery', getParentRoute: () => root } as never);
  const away = createRoute({ getParentRoute: () => root, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: root.addChildren([recovery, away]) });
  await router.load();
  const page = await open(createElement(RouterProvider, { router }), {});
  return { ...page, router, async close() { await page.render(null); history.destroy(); } };
}

const unload = () => {
  const event = new dom.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event as unknown as Event);
  return event.defaultPrevented;
};

test('Stay keeps the current recovery attempt; replacing or leaving retires it and clears input', async () => {
  const page = await setup();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    let password = page.host.querySelector<HTMLInputElement>('input[name="new_password"]')!;
    await flush(() => fill(password, 'short'));
    await flush(() => send(page.host));
    const feedback = password.getAttribute('aria-describedby');
    expect(feedback).toBe('recovery-password-error');
    expect(unload()).toBe(true);
    await flush(() => void page.router.navigate({ to: '/away' }));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('A request already sent may still finish.');
    await flush(() => button(document.body, 'Stay')!.click());
    expect(password.value).toBe('short');
    expect(password.type).toBe('password');
    expect(password.getAttribute('aria-describedby')).toBe(feedback);

    await flush(() => fill(password, 'a sufficiently long password'));
    await flush(() => send(page.host));
    await flush(() => send(page.host));
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]!.body).toEqual({ account_id: 'first', token: 'first-token', new_password: 'a sufficiently long password' });
    await flush(() => page.router.navigate({ to: '/recovery', hash: secondLink.slice(1) }));
    password = page.host.querySelector<HTMLInputElement>('input[name="new_password"]')!;
    expect(password.value).toBe('');
    expect(window.location.hash).toBe('');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();

    await flush(() => fill(password, 'unsent secret'));
    await flush(() => void page.router.navigate({ to: '/away' }));
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    await flush(() => button(document.body, 'Leave')!.click());
    expect(page.host.querySelector('input[name="new_password"]')).toBeNull();
    expect(unload()).toBe(false);
    page.calls[0]!.resolve(Response.json({ success: true }));
    await flush(() => {});
    expect(assign).not.toHaveBeenCalled();
  } finally {
    assign.mockRestore();
    await page.close();
  }
});

test('a completed recovery request can leave without another prompt', async () => {
  const page = await setup('');
  try {
    await flush(() => fill(page.host.querySelector<HTMLInputElement>('input[name="email"]')!, 'reader@example.test'));
    await flush(() => send(page.host));
    page.calls[0]!.resolve(Response.json({ success: true }));
    await flush(() => {});
    expect(unload()).toBe(false);
    await flush(() => void page.router.navigate({ to: '/away' }));
    expect(page.router.history.location.pathname).toBe('/away');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  } finally {
    await page.close();
  }
});
