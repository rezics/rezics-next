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
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
const { Route } = await import('../src/routes/consent');
const { signInTarget } = await import('../src/sign-in');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

test('consent reviews and decisions belong to the current visit and survive sign-in for fresh review', async () => {
  const calls: { url: string; init?: RequestInit; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((input, init) =>
    new Promise<Response>((resolve) => calls.push({ url: String(input), init, resolve }))) as typeof fetch;
  const body = {
    client_id: 'reader+client',
    display_name: 'Reader <img src=x onerror=alert(1)>',
    scopes: ['openid', 'offline_access', 'library:read', 'library:write'],
    granted: ['openid', 'library:write'],
    pending_reduction: false,
    decisions: { allow: true, decline: true, switch_account: true },
  };
  const requestScope = 'openid offline_access library:read unknown openid';
  dom.sessionStorage.setItem(`auth.consent.pending:${JSON.stringify([body.client_id, 'library:read'])}`, 'pending');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const parent = createRootRoute();
  const route = Route.update({ id: '/consent', path: '/consent', getParentRoute: () => parent } as never);
  const path = (id = body.client_id, scope = requestScope) =>
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
  const answer = (index: number, status = 200, accountId = 'person-1', override?: unknown) =>
    flush(() => {
      const call = calls[index]!;
      const url = new URL(call.url, 'https://auth.test');
      const result =
        override ??
        (call.init?.method === 'POST'
          ? (() => {
              const submitted = JSON.parse(String(call.init?.body));
              return {
                client_id: submitted.client_id,
                scope: submitted.scope,
                account_id: submitted.reviewed_account_id,
                requested: submitted.reviewed_requested,
              };
            })()
          : {
              ...body,
              requested: [...new Set((url.searchParams.get('scope') ?? '').split(' ').filter(Boolean))],
              acting_account: { account_id: accountId, email: null },
            });
      call.resolve(Response.json(status === 200 ? result : { code: 'unavailable' }, { status }));
    });
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  const navigate = async (url: string) => {
    let navigation: Promise<void> | undefined;
    await flush(() => {
      navigation = router.navigate({ to: url });
    });
    const leave = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Leave');
    if (leave) await flush(() => leave.click());
    await flush(() => navigation!);
  };
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  try {
    await answer(0, 503);
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
    await flush(() => {
      button('Review current permissions')!.click();
      button('Review current permissions')?.click();
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      `/consent/reader%2Bclient?${new URLSearchParams({ scope: requestScope })}`,
      `/consent/reader%2Bclient?${new URLSearchParams({ scope: requestScope })}`,
    ]);
    expect(button('Approve')).toBeUndefined();
    await answer(1);
    expect(host.textContent).toContain(body.display_name);
    expect(host.textContent).toContain('REZICS account');
    await flush(() => button('Approve')!.click());
    expect(JSON.parse(String(calls[2]!.init?.body))).toEqual({
      client_id: body.client_id,
      scope: ['openid', 'library:write', 'offline_access', 'library:read'],
      reviewed_account_id: 'person-1',
      reviewed_scopes: body.granted,
      reviewed_requested: ['openid', 'offline_access', 'library:read', 'unknown'],
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
    await answer(9, 200, 'person-1', { client_id: 'wrong-client', scope: [] });
    expect(host.textContent).not.toContain('Access approved.');
    expect(button('Approve')).toBeUndefined();
    await answer(10);
    expect(host.textContent).toContain('An earlier approval result is unknown');
    await flush(() => button('Decline')!.click());
    expect(host.textContent).toContain('An earlier approval may still have taken effect.');
    expect(calls).toHaveLength(11);
    await navigate(path('unknown'));
    await navigate(path(body.client_id, 'library:read'));
    await answer(11);
    expect(button('Approve')).toBeUndefined();
    await answer(12, 200, 'person-2');
    expect(host.textContent).not.toContain('An earlier approval result is unknown');
    expect(host.textContent).toContain('An earlier submission for this client and request is unresolved.');
    await flush(() => button('Approve')!.click());
    await answer(13, 503);
    expect(host.textContent).toContain('An earlier approval result is unknown');
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    await flush(() => button('Approve')!.click());
    await answer(14);
    expect(host.textContent).toContain('Access approved.');
    await flush(() => void window.dispatchEvent(new dom.Event('pagehide')));
    await flush(() => void window.dispatchEvent(new dom.Event('pageshow')));
    expect(host.textContent).not.toContain('Access approved.');
    expect(button('Approve')).toBeUndefined();
    await answer(15, 200, 'person-2');
    expect(host.textContent).toContain('An earlier approval result is unknown');
    await navigate(path('unknown'));
    await flush(() => root.unmount());
    expect(calls[16]!.init?.signal?.aborted).toBe(true);
    await answer(16);
    expect(host.textContent).toBe('');
    dom.sessionStorage.removeItem(`auth.consent.pending:${JSON.stringify([body.client_id, 'library:read'])}`);
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
