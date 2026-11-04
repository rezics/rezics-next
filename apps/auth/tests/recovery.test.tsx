import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';

// Reuse the installed DOM fixture used by turnstile-lifetime.test.tsx, without a browser or server.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/recovery' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement,
  Element: dom.Element,
  Node: dom.Node,
  Document: dom.Document,
  DocumentFragment: dom.DocumentFragment,
  scrollTo: dom.scrollTo.bind(dom),
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { createBrowserHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/recovery');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});
async function flush(action: () => void) {
  await act(async () => {
    action();
  });
}
async function open(fragment = '') {
  window.history.replaceState(null, '', `/recovery${fragment}`);
  window.sessionStorage.clear();
  const rootRoute = createRootRoute({ component: Outlet });
  const recovery = Route.update({ id: '/recovery', path: '/recovery', getParentRoute: () => rootRoute } as never);
  const away = createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ history, routeTree: rootRoute.addChildren([recovery, away]) });
  const calls: unknown[] = [];
  let closed = false;
  let release!: (response: Response) => void;
  globalThis.fetch = (async (_path, init) => {
    if (_path === '/recovery/page')
      return Response.json(
        recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
      );
    calls.push(JSON.parse(String(init?.body)));
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  await router.load();
  await flush(() => root.render(createElement(StrictMode, null, createElement(RouterProvider, { router }))));
  return {
    host,
    calls,
    router,
    async submit(value: string) {
      await flush(() => {
        const input = host.querySelector<HTMLInputElement>('input[name="email"], input[name="new_password"]')!;
        Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
      });
      await flush(() =>
        host
          .querySelector('form')!
          .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
      );
    },
    async respond(status = 200) {
      await flush(() =>
        release(Response.json(status === 200 ? { success: true } : { code: 'invalid_recovery' }, { status })),
      );
    },
    async close() {
      if (closed) return;
      closed = true;
      await flush(() => root.unmount());
      history.destroy();
      host.remove();
    },
  };
}
const link = '#account_id=account&token=private-token';
test('current recovery keeps non-disclosing email results and invalid-link recovery usable', async () => {
  const page = await open();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    for (const email of ['reader@example.test', 'unknown@example.test']) {
      await page.submit(email);
      await page.respond();
      expect(page.host.querySelector('[role="status"]')!.textContent).toContain('Your recovery request was accepted');
    }
    await act(async () => {
      await page.router.navigate({ to: '/recovery', hash: link.slice(1) });
    });
    expect(window.location.hash).toBe('');
    await page.submit('new private password');
    await page.respond(401);
    expect(page.host.querySelector('a[href="/recovery"]')!.textContent).toContain('recovery link');
    await act(async () => {
      page.router.history.replace('/recovery');
      await page.router.load();
    });
    await flush(() =>
      [...page.host.querySelectorAll('button')]
        .find((button) => button.textContent === 'Request a new recovery link')!
        .click(),
    );
    await page.submit('retry@example.test');
    await page.respond();
    expect(page.host.querySelector('[role="status"]')).not.toBeNull();
    await act(async () => {
      await page.router.navigate({ to: '/recovery', hash: link.slice(1) });
    });
    await page.submit('new private password');
    await page.respond();
    expect(assign).toHaveBeenCalledWith('/login');
    expect(window.sessionStorage.getItem('auth.recovery.complete')).toBe('1');
  } finally {
    assign.mockRestore();
    await page.close();
  }
});
for (const fragment of ['', link])
  for (const boundary of ['unmount', 'replace', 'pagehide'])
    for (const status of [200, 401]) {
      test(`${fragment ? 'password' : 'email'} ${status} response belongs only to its current page after ${boundary}`, async () => {
        const page = await open(fragment);
        try {
          await page.submit(fragment ? 'private password' : 'private@example.test');
          await flush(() =>
            page.host
              .querySelector('form')!
              .dispatchEvent(new dom.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event),
          );
          expect(page.calls).toHaveLength(1);
          if (boundary === 'unmount') await page.close();
          else if (boundary === 'replace')
            await act(async () => {
              page.router.history.replace('/recovery');
              await page.router.load();
            });
          else
            await flush(() =>
              window.dispatchEvent(Object.assign(new dom.Event('pagehide'), { persisted: true }) as unknown as Event),
            );
          await page.respond(status);
          expect(window.location.pathname).toBe('/recovery');
          expect(window.sessionStorage.getItem('auth.recovery.complete')).toBeNull();
          expect(Boolean(page.host.querySelector('[role="status"]'))).toBe(boundary === 'replace');
          expect(Boolean(page.host.querySelector('[role="alert"]'))).toBe(false);
          if (boundary === 'pagehide')
            await flush(() =>
              window.dispatchEvent(Object.assign(new dom.Event('pageshow'), { persisted: true }) as unknown as Event),
            );
          if (boundary !== 'unmount') {
            expect(page.host.querySelector('input')).toBeNull();
            expect(page.host.textContent).toContain('result is unknown');
            await flush(() =>
              [...page.host.querySelectorAll('button')]
                .find((button) => button.textContent === 'Request a new recovery link')!
                .click(),
            );
            expect(page.host.querySelector<HTMLInputElement>('input')!.value).toBe('');
            expect(page.host.querySelector('input[name="new_password"]')).toBeNull();
            await page.submit('return@example.test');
            await page.respond();
            expect(page.calls).toHaveLength(2);
            expect(page.host.querySelector('[role="status"]')).not.toBeNull();
          }
        } finally {
          await page.close();
        }
      });
    }

test('unknown completion retains an immutable submission for explicit retry and warns until retirement', async () => {
  const page = await open(link);
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  try {
    await page.submit('original private password');
    await page.respond(503);
    expect(page.calls).toHaveLength(1);
    expect(page.host.textContent).toContain('The result is unknown');
    expect(page.host.querySelector<HTMLInputElement>('[name=new_password]')!.readOnly).toBe(true);
    const warning = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(warning as unknown as Event);
    expect(warning.defaultPrevented).toBe(true);
    await page.submit('edited private password');
    expect(page.calls[1]).toEqual(page.calls[0]);
    await page.respond(401);
    expect(page.host.textContent).toContain('The result is unknown');
    expect(assign).not.toHaveBeenCalled();
    await page.submit('another edited password');
    expect(page.calls[2]).toEqual(page.calls[0]);
    await page.respond();
    expect(assign).toHaveBeenCalledWith('/login');
    expect(window.sessionStorage.getItem('auth.recovery.complete')).toBe('1');
    expect(window.sessionStorage.length).toBe(1);
  } finally {
    assign.mockRestore();
    await page.close();
  }
});
