import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';

// Reuse the mounted Auth DOM composition and consent browser fixture values, without a server.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/consent' });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  scrollTo: dom.scrollTo.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: globalThis.fetch,
})) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
const { Route } = await import('../src/routes/consent');
const { signInTarget } = await import('../src/sign-in');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
afterAll(async () => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test('consent reviews and decisions belong to the current visit and survive sign-in for fresh review', async () => {
  const calls: { url: string; init?: RequestInit; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((input, init) =>
    new Promise<Response>((resolve) => calls.push({ url: String(input), init, resolve }))) as typeof fetch;
  const body = {
    client_id: 'reader+client',
    display_name: 'Reader <img src=x onerror=alert(1)>',
    scopes: ['openid', 'offline_access', 'library:read', 'library:write'],
    granted: ['openid', 'library:write'],
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const parent = createRootRoute();
  const route = Route.update({ id: '/consent', path: '/consent', getParentRoute: () => parent } as never);
  const path = (id = body.client_id, scope = 'openid offline_access library:read unknown openid') =>
    `/consent?${new URLSearchParams({ client_id: id, scope })}`;
  const router = createRouter({
    routeTree: parent.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [path()] }),
  });
  const flush = async (action: () => void | Promise<void>) => {
    await act(async () => {
      await action();
    });
  };
  const answer = (index: number, status = 200) =>
    flush(() => calls[index]!.resolve(Response.json(status === 200 ? body : { code: 'unavailable' }, { status })));
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const navigate = (url: string) =>
    flush(async () => {
      await router.navigate({ to: url });
    });
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  try {
    await answer(0, 503);
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    await flush(() => {
      button('Try this action again')!.click();
      button('Try this action again')?.click();
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual(['/consent/reader%2Bclient', '/consent/reader%2Bclient']);
    expect(button('Approve')).toBeUndefined();
    await answer(1);
    expect(host.textContent).toContain(body.display_name);
    await flush(() => button('Approve')!.click());
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({
      client_id: body.client_id,
      scope: ['openid', 'library:write', 'offline_access', 'library:read'],
    });
    await answer(2);
    expect(host.textContent).toContain('You can return to the client.');
    await navigate(path(body.client_id, 'library:write'));
    await navigate(path('unknown'));
    expect(calls[3]!.init?.signal?.aborted).toBe(true);
    await answer(3);
    expect(button('Approve')).toBeUndefined();
    await answer(4, 404);
    expect(host.textContent).toContain('Client not found.');
    await navigate(path());
    await answer(5, 401);
    const login = new URL((host.querySelector('a[href^="/login?"]') as HTMLAnchorElement).href);
    const recovered = signInTarget(login.search, 'https://auth.test');
    expect(recovered).toBe(`https://auth.test${path()}`);
    expect(button('Approve')).toBeUndefined();
    await flush(() => void window.dispatchEvent(new dom.Event('pagehide')));
    await navigate(recovered.replace('https://auth.test', ''));
    await flush(() => void window.dispatchEvent(new dom.Event('pageshow')));
    await answer(6);
    await flush(() => button('Approve')!.click());
    await navigate(path(body.client_id, 'library:read'));
    await answer(7);
    expect(host.textContent).not.toContain('Access approved.');
    await answer(8);
    await flush(() => {
      button('Approve')!.click();
      button('Approve')!.click();
    });
    expect(calls).toHaveLength(10);
    await flush(() => void window.dispatchEvent(new dom.Event('pagehide')));
    expect(button('Approve')).toBeUndefined();
    await flush(() => void window.dispatchEvent(new dom.Event('pageshow')));
    expect(calls).toHaveLength(11);
    await answer(9);
    expect(host.textContent).not.toContain('Access approved.');
    expect(button('Approve')).toBeUndefined();
    await answer(10);
    expect(host.textContent).toContain('The approval result is unknown');
    await flush(() => button('Decline')!.click());
    expect(host.textContent).toContain('An earlier approval may still have taken effect.');
    expect(calls).toHaveLength(11);
    await navigate(path('unknown'));
    await navigate(path(body.client_id, 'library:read'));
    await answer(11);
    expect(button('Approve')).toBeUndefined();
    await answer(12);
    expect(host.textContent).toContain('The approval result is unknown');
    await flush(() => button('Approve')!.click());
    await answer(13, 503);
    expect(host.textContent).toContain('The approval result is unknown');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await flush(() => button('Approve')!.click());
    await answer(14);
    expect(host.textContent).toContain('Access approved.');
    await flush(() => void window.dispatchEvent(new dom.Event('pagehide')));
    await flush(() => void window.dispatchEvent(new dom.Event('pageshow')));
    expect(host.textContent).not.toContain('Access approved.');
    expect(button('Approve')).toBeUndefined();
    await answer(15);
    expect(host.textContent).not.toContain('The approval result is unknown');
    await navigate(path('unknown'));
    await flush(() => root.unmount());
    expect(calls[16]!.init?.signal?.aborted).toBe(true);
    await answer(16);
    expect(host.textContent).toBe('');
  } finally {
    await flush(() => root.unmount());
    host.remove();
  }
});

test('consent sign-in recovery only accepts the fixed review target and exact inputs', () => {
  const request = `/consent?${new URLSearchParams({ client_id: 'reader+client /?#', scope: ' openid  unknown ' })}`;
  expect(signInTarget(new URLSearchParams({ return_to: request }).toString(), 'https://auth.test')).toBe(
    `https://auth.test${request}`,
  );
  for (const return_to of [
    'https://evil.test/consent?client_id=x&scope=y',
    '//evil.test',
    '/consent?client_id=x&scope=y&redirect_uri=evil',
    '/consent?client_id=x&client_id=y',
    '/consent?client_id=x&scope=y#other',
  ]) {
    expect(signInTarget(new URLSearchParams({ return_to }).toString(), 'https://auth.test')).toBe(
      'https://auth.test/security',
    );
  }
});
