import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { Route } from '../src/routes/signup';
import type { RegistrationPage } from '../src/registration-page';
creationFixture();
const originalScroll = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
beforeAll(() => Object.defineProperty(globalThis, 'scrollTo', { value: dom.scrollTo.bind(dom), configurable: true }));
afterAll(() => {
  if (originalScroll) Object.defineProperty(globalThis, 'scrollTo', originalScroll);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
const append = document.head.appendChild.bind(document.head);
document.head.appendChild = <T extends Node>(node: T): T => {
  if (node instanceof dom.HTMLScriptElement) (node as unknown as HTMLScriptElement).type = 'application/x-test';
  return append(node);
};
let serial = 0;
async function setup() {
  const root = createRootRoute({ component: Outlet });
  const registrationPage: Extract<RegistrationPage, { kind: 'registration' }> = {
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
    siteKey: 'key',
    scriptUrl: `https://challenge.test/signup-${++serial}.js`,
  };
  let config: RegistrationPage = registrationPage;
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => root,
    loader: () => config,
  } as never);
  const query = '?state=original&resource=one&resource=two';
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [`/signup${query}`] }),
  });
  await router.load();
  const page = await open(<RouterProvider router={router} />, {});
  let token!: (value: string) => void;
  window.turnstile = {
    ready: (callback) => callback(),
    render: (_element, options) => {
      token = options.callback;
      return 'widget';
    },
    reset: () => {},
    remove: () => {},
  };
  await flush(() =>
    document
      .querySelector<HTMLScriptElement>(`script[src="${registrationPage.scriptUrl}"]`)!
      .dispatchEvent(new dom.Event('load') as unknown as Event),
  );
  const input = (name: string) => page.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const edit = (name: string, value: string) => flush(() => fill(input(name), value));
  const choose = (label: string) => flush(() => button(document.body, label)!.click());
  const navigate = () => flush(() => router.history.replace('/signup?state=new'));
  const unload = () => {
    const event = new dom.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event as unknown as Event);
    return event.defaultPrevented;
  };
  const submit = () => flush(() => send(page.host));
  const ready = async () => {
    await edit('handle', 'Reader_1');
    await edit('email', 'reader@example.test');
    await edit('password', 'private-password');
    await edit('confirm', 'private-password');
    await flush(() => token('fresh-token'));
    await submit();
  };
  return {
    ...page,
    query,
    router,
    registrationPage,
    setPage: async (next: RegistrationPage) => {
      config = next;
      await router.invalidate();
    },
    input,
    edit,
    choose,
    navigate,
    unload,
    submit,
    ready,
    token: (value: string) => flush(() => token(value)),
  };
}
test('empty and whitespace-only details do not warn; Stay preserves invalid input, errors and focus', async () => {
  const p = await setup();
  p.input('handle').focus();
  expect(p.unload()).toBe(false);
  await p.edit('handle', '  ');
  await p.edit('email', '  ');
  expect(p.unload()).toBe(false);
  await p.edit('handle', 'bad!');
  await p.edit('password', ' ');
  await p.submit();
  const error = p.input('handle').getAttribute('aria-describedby');
  expect(error).toBe('signup-handle-error');
  expect(p.unload()).toBe(true);
  await flush(() => p.host.querySelector<HTMLAnchorElement>('a[href^="/login"]')!.click());
  const dialog = document.querySelector('[role="alertdialog"]')!;
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  await p.choose('Stay');
  expect(p.router.history.location.search).toBe(p.query);
  expect(p.input('handle').value).toBe('bad!');
  expect(p.input('password').value).toBe(' ');
  expect(p.input('handle').getAttribute('aria-describedby')).toBe(error);
  expect(document.activeElement).toBe(p.input('handle'));
  await p.edit('handle', '');
  await p.edit('email', '');
  expect(p.unload()).toBe(true); // Even a whitespace password is private entered data.
  await p.navigate();
  await p.choose('Leave');
  expect(p.input('password').value).toBe('');
  expect(p.unload()).toBe(false);
});
test('Stay retains a pending creation and retry key; Leave fences late creation and clears secrets', async () => {
  const p = await setup();
  await p.ready();
  const secret = p.input('password');
  await p.navigate();
  await p.choose('Stay');
  expect(p.input('password').value).toBe('private-password');
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(p.host.querySelector('input[name="handle"]')).toBeNull();
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('reader_1');
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).not.toContain('private-password');
  expect(p.calls).toHaveLength(1); // A failed request consumes its token.
  await p.token('retry-token');
  await p.choose('Retry original attempt');
  expect(p.calls[1]!.body.key).toBe(p.calls[0]!.body.key);
  expect(p.calls[1]!.body.handle).toBe(p.calls[0]!.body.handle);
  expect(p.calls[1]!.body.email).toBe(p.calls[0]!.body.email);
  expect(p.calls[1]!.body.password).toBe(p.calls[0]!.body.password);
  expect(p.calls[1]!.body.turnstile_token).toBe('retry-token');
  await p.navigate();
  await p.choose('Leave');
  expect(secret.isConnected).toBe(false);
  expect(p.input('password').value).toBe('');
  await flush(() => p.calls[1]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(2); // Leave retired the old callback, so late 201 cannot start sign-in.
  expect(p.input('password').value).toBe('');
  expect(p.unload()).toBe(false);
});

test('a failed registration-page refresh preserves an unresolved attempt without reopening editable fields', async () => {
  const p = await setup();
  await p.ready();
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  const retained = p.host.querySelector('#signup-uncertain-panel')?.textContent ?? '';
  expect(retained).toContain('reader_1');
  expect(p.calls).toHaveLength(1);

  await p.setPage({ kind: 'unavailable', reason: 'dependency', actions: { register: false, continue: false } });
  expect(p.host.querySelector('input[name="handle"]')).toBeNull();
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('reader_1');
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).not.toContain('private-password');

  await p.setPage(p.registrationPage);
  expect(p.host.querySelector('input[name="handle"]')).toBeNull();
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('Reader_1');
  expect(p.calls).toHaveLength(1); // Revalidation and challenge loading never replay creation.
});

test('a newly signed-in viewer closes pending signup advice and fences its late creation result', async () => {
  const p = await setup();
  await p.ready();
  const signup = p.calls[0]!;
  await p.setPage({
    kind: 'already-signed-in',
    viewer: { account_id: 'replacement-account' },
    requirements: p.registrationPage.requirements,
    verification: { configured: true },
    actions: { register: false, continue: true },
  });
  expect(document.body.textContent).toContain('You are already signed in');
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  await flush(() => signup.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(1); // A stale 201 cannot start sign-in or redirect this viewer.
  expect(document.body.textContent).toContain('You are already signed in');
});
