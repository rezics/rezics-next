import { afterAll, beforeAll, expect, test } from 'bun:test';
import { act } from 'react';
import { creationFixture, dom } from './creation-page-fixture';
creationFixture();
const scroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (scroll) Object.defineProperty(globalThis, 'scrollTo', scroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
const { Route } = await import('../src/routes/consent');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
const flush = (action: () => void) => act(async () => action());
const query = (client: string, scope = 'openid') => `/consent?client_id=${client}&scope=${scope}`;
const review = (client: string, scope = 'openid') => ({
  client_id: client,
  display_name: `Application ${client}`,
  requested: [scope],
  scopes: ['openid', 'read'],
  granted: [],
  pending_reduction: false,
  acting_account: { account_id: `actor-${client}`, email: `${client}@example.test` },
  decisions: { allow: true, decline: true, switch_account: true },
});
const marker = (client: string) => `auth.consent.pending:${JSON.stringify([`actor-${client}`, client, 'openid'])}`;
async function mount() {
  overwriteGetLocale(() => 'en');
  const calls: { url: string; init?: RequestInit; resolve: (value: Response) => void }[] = [];
  globalThis.fetch = ((url, init) =>
    new Promise<Response>((resolve) => calls.push({ url: String(url), init, resolve }))) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const parent = createRootRoute();
  const route = Route.update({ id: '/consent', path: '/consent', getParentRoute: () => parent } as never);
  const history = createMemoryHistory({ initialEntries: [query('a')] });
  const router = createRouter({ routeTree: parent.addChildren([route]), history });
  await router.load();
  await flush(() => root.render(<RouterProvider router={router} />));
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!;
  const click = (label: string) => flush(() => button(label).click());
  const answer = (value: unknown, status = 200) => flush(() => calls.at(-1)!.resolve(Response.json(value, { status })));
  const go = async (href: string) => {
    await flush(() => {
      void router.navigate({ href });
    });
    if (button('Leave')) await click('Leave');
  };
  const notices = () => [...host.querySelectorAll('section[tabindex="-1"]')];
  return { host, calls, history, button, click, answer, go, notices, close: () => flush(() => root.unmount()) };
}

test('replacement retires held approval; first unknown and latest reply stay separate and dismiss independently', async () => {
  const v = await mount();
  try {
    await v.answer(review('a'));
    await v.click('Approve');
    const oldPost = v.calls.at(-1)!;
    expect(JSON.parse(String(oldPost.init?.body))).toEqual({
      client_id: 'a',
      scope: ['openid'],
      reviewed_account_id: 'actor-a',
      reviewed_scopes: [],
      reviewed_requested: ['openid'],
    });
    await v.go(query('b'));
    expect(v.host.textContent).not.toContain('a@example.test');
    expect(v.host.textContent).not.toContain('Application a');
    expect(v.button('Approve')).toBeUndefined();
    expect(v.notices()).toHaveLength(1);
    await v.answer(review('b'));
    await v.click('Approve');
    const bPost = v.calls.at(-1)!;
    await flush(() =>
      oldPost.resolve(
        Response.json({ client_id: 'a', account_id: 'actor-a', requested: ['openid'], scope: ['openid'] }),
      ),
    );
    expect(v.button('Approve').disabled).toBe(true);
    expect(window.sessionStorage.getItem(marker('a'))).toBe('pending');
    expect(window.sessionStorage.getItem(marker('b'))).toBe('pending');
    expect(v.host.textContent).not.toContain('Access approved.');
    await flush(() =>
      bPost.resolve(Response.json({ client_id: 'b', account_id: 'actor-b', requested: ['openid'], scope: ['openid'] })),
    );
    expect(v.host.textContent).toContain('Access approved.');
    expect(v.notices()).toHaveLength(2);
    expect(v.notices()[0]!.textContent).toContain('unknown');
    expect(v.notices()[1]!.textContent).toContain('acknowledged');
    expect(window.sessionStorage.getItem(marker('a'))).toBe('pending');
    expect(window.sessionStorage.getItem(marker('b'))).toBeNull();
    await v.click('Review current permissions');
    await v.answer(review('b'));
    await v.click('Approve');
    await v.answer({ code: 'stale_review' }, 409);
    expect(v.host.textContent).not.toContain('Access approved.');
    expect(v.notices()).toHaveLength(2);
    expect(v.notices()[1]!.textContent).toContain('refused');
    expect(v.host.querySelector('[role=alert]')?.textContent).toContain('changed');
    for (const notice of v.notices()) {
      for (const operand of ['a@example.test', 'actor-a', 'Application a', 'openid', 'client_id'])
        expect(notice.textContent).not.toContain(operand);
    }
    await flush(() => v.notices()[1]!.querySelector('button')!.click());
    expect(v.notices()).toHaveLength(1);
    await v.click('Hide this explanation');
    expect(v.notices()).toHaveLength(0);
    expect(window.sessionStorage.getItem(marker('a'))).toBe('pending');
    await v.click('Review current permissions');
    await v.answer(review('b'));
    expect(v.notices()).toHaveLength(0);
    expect(v.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(3);
  } finally {
    await v.close();
  }
});

test('same-client scope changes, invalid queries, Back/Forward, locale and cached return are read-only', async () => {
  const v = await mount();
  try {
    const oldRead = v.calls[0]!;
    await v.go(query('a', 'read'));
    expect(oldRead.init?.signal?.aborted).toBe(true);
    await flush(() => oldRead.resolve(Response.json(review('a'))));
    expect(v.button('Approve')).toBeUndefined();
    await v.answer(review('a', 'read'));
    expect(v.host.textContent).toContain('a@example.test');
    await v.click('Approve');
    await v.answer({}, 503);
    await v.go('/consent?client_id=a&client_id=b&scope=openid');
    const count = v.calls.length;
    expect(v.host.textContent).not.toContain('a@example.test');
    expect(v.host.textContent).not.toContain('Application a');
    expect(v.notices()).toHaveLength(1);
    await v.go('/consent?client_id=a&scope=openid&scope=read');
    expect(v.calls).toHaveLength(count);
    await flush(() => v.history.back());
    expect(v.calls).toHaveLength(count);
    await flush(() => v.history.back());
    expect(v.calls.at(-1)!.url).toBe('/consent/a?scope=read');
    await v.answer(review('a', 'read'));
    await flush(() => v.history.forward());
    if (v.button('Leave')) await v.click('Leave');
    expect(v.host.textContent).not.toContain('a@example.test');
    await v.go(query('b'));
    await v.answer(review('b'));
    await v.click('Hide this explanation');
    expect(v.notices()).toHaveLength(0);
    overwriteGetLocale(() => 'de');
    await flush(() => window.dispatchEvent(new dom.Event('pagehide')));
    expect(v.host.textContent).not.toContain('b@example.test');
    await flush(() => window.dispatchEvent(new dom.Event('pageshow')));
    await v.answer({}, 401);
    overwriteGetLocale(() => 'en');
    // Return re-renders the current locale; a failed Retry stays finite and query-bound.
    await flush(() => {
      window.dispatchEvent(new dom.Event('pagehide'));
      window.dispatchEvent(new dom.Event('pageshow'));
    });
    await v.answer({}, 503);
    const before = v.calls.length;
    await flush(() => {
      v.button('Review current permissions').click();
      v.button('Review current permissions')?.click();
    });
    expect(v.calls).toHaveLength(before + 1);
    expect(v.calls.at(-1)!.url).toBe('/consent/b?scope=openid');
    await v.answer(review('b'));
    await v.click('Decline');
    expect(v.notices()).toHaveLength(1);
    expect(v.notices()[0]!.textContent).toContain('Review declined');
    expect(v.calls.filter((call) => call.init?.method === 'POST')).toHaveLength(1);
  } finally {
    overwriteGetLocale(() => 'en');
    await v.close();
  }
});
