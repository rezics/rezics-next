import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { AuthShell } from '../src/frame';
import { initializeDocumentLocale, observeLocaleComponent } from '../src/locale-observation';
import { Route } from '../src/routes/signup';
import type { RegistrationPage } from '../src/registration-page';
import { m } from '../src/paraglide/messages.js';

creationFixture();
const originalScroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (originalScroll) Object.defineProperty(globalThis, 'scrollTo', originalScroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
let serial = 0;
async function setup() {
  initializeDocumentLocale('en');
  const root = createRootRoute({
    component: observeLocaleComponent(() => (
      <AuthShell>
        <Outlet />
      </AuthShell>
    )),
  });
  const initial: Extract<RegistrationPage, { kind: 'registration' }> = {
    kind: 'registration',
    viewer: null,
    requirements: {
      handle: { minLength: 3, maxLength: 64 },
      email: { maxLength: 254 },
      password: { minLength: 8, maxLength: 128 },
      verification: { provider: 'turnstile', required: true },
    },
    verification: { configured: true },
    actions: { register: true, continue: false },
    siteKey: 'fixture',
    scriptUrl: `https://challenge.test/locale-${++serial}.js`,
  };
  let page: RegistrationPage = initial;
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => root,
    loader: () => page,
  } as never);
  route.options.component = observeLocaleComponent(route.options.component!);
  const query = '?client_id=reader&state=a%2fb+z&scope=&scope=openid&unknown=1&unknown=2';
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/signup${query}`] }),
  });
  await router.load();
  const append = document.head.appendChild.bind(document.head);
  spies.push(
    spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      if (node instanceof dom.HTMLScriptElement) (node as unknown as HTMLScriptElement).type = 'application/x-test';
      return append(node);
    }),
  );
  const p = await open(<RouterProvider router={router} />, {});
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  spies.push(assign);
  let token!: (value: string) => void;
  window.turnstile = {
    ready: (callback) => callback(),
    render: (_element, options) => {
      token = options.callback;
      return 'widget';
    },
    reset() {},
    remove() {},
  };
  await flush(() =>
    document
      .querySelector(`script[src="${initial.scriptUrl}"]`)!
      .dispatchEvent(new dom.Event('load') as unknown as Event),
  );
  const input = (name: string) => p.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const locale = async (value: string) => {
    await flush(() => {
      const control = p.host.querySelector('select')!;
      control.value = value;
      control.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
    });
    await flush(() => p.host.querySelector<HTMLButtonElement>('.auth-locale-actions button')!.click());
  };
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const draft = () =>
    flush(() => {
      fill(input('handle'), 'Reader_1');
      fill(input('email'), 'reader@example.test');
      fill(input('password'), 'private-password');
      fill(input('confirm'), 'private-password');
      token('fixture-token');
    });
  return {
    ...p,
    router,
    query,
    initial,
    input,
    choose,
    locale,
    unload,
    draft,
    assign,
    token: () => flush(() => token('fresh-token')),
    replaceViewer: () =>
      flush(async () => {
        page = {
          kind: 'already-signed-in',
          viewer: { account_id: 'replacement' },
          requirements: initial.requirements,
          verification: { configured: true },
          actions: { register: false, continue: true },
        };
        await router.invalidate();
      }),
  };
}

test('language preserves draft, pending write, sticky unknown and exact retry through the real departure boundary', async () => {
  const p = await setup();
  await p.draft();
  const password = p.input('password');
  await p.locale('ja');
  expect(p.input('password')).toBe(password);
  expect(password.value).toBe('private-password');
  expect(p.unload()).toBe(true);
  expect(p.calls).toHaveLength(0);
  await flush(() => send(p.host));
  const original = p.calls[0]!.body;
  await p.locale('fr');
  expect(p.calls).toHaveLength(1);
  expect(p.calls[0]!.body).toEqual(original);
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  await p.locale('de');
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('reader_1');
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).not.toContain('private-password');
  expect(p.input('password')).toBeNull();
  expect(p.unload()).toBe(true);
  expect(p.router.history.location.search).toBe(p.query);
  expect(p.host.querySelector('a[href^="/login?"]')?.getAttribute('href')).toBe(`/login${p.query}`);
  await flush(() => {
    void p.router.navigate({ to: `/signup${p.query}&next=1` });
  });
  await p.choose(m.auth_organization_departure_stay());
  await p.token();
  await p.choose(m.auth_signup_retry_original());
  expect(p.calls[1]!.body).toEqual({ ...original, turnstile_token: 'fresh-token' });
  await p.locale('es');
  expect(p.calls).toHaveLength(2);
  await flush(() => {
    void p.router.navigate({ to: `/signup${p.query}&next=1` });
  });
  await p.choose(m.auth_organization_departure_leave());
  await flush(() => p.calls[1]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(2);
  expect(p.assign).not.toHaveBeenCalled();
  expect(p.input('password').value).toBe('');
});

test('replacement viewer remains authoritative over a late creation after language selection', async () => {
  const p = await setup();
  await p.draft();
  await flush(() => send(p.host));
  await p.locale('ko');
  await p.replaceViewer();
  await p.locale('zh-Hant');
  await flush(() => p.calls[0]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.input('password')).toBeNull();
  expect(p.calls).toHaveLength(1);
  expect(p.assign).not.toHaveBeenCalled();
  expect(p.unload()).toBe(false);
});
