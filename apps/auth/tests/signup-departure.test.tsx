import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import {
  creationFixture,
  button,
  createFixtureHistory,
  departureDialog,
  dom,
  fill,
  flush,
  flushFrame,
  open,
  send,
} from './creation-page-fixture';
import { Route } from '../src/routes/signup';
import * as registration from '../src/registration-page';
import type { RegistrationPage } from '../src/registration-page';
import { getLocale, overwriteGetLocale } from '../src/paraglide/runtime.js';
creationFixture();
let restoreAdvice: (() => void) | undefined;
let restoreBrowser: () => void;
beforeEach(() => {
  const locale = getLocale;
  overwriteGetLocale(() => 'en');
  const head = dom.document.head;
  const append = head.appendChild;
  const inertScripts = spyOn(head, 'appendChild').mockImplementation(function <T extends Node>(node: T): T {
    if (node instanceof dom.HTMLScriptElement) (node as HTMLScriptElement).type = 'application/x-test';
    return append.call(head, node) as T;
  });
  restoreBrowser = () => {
    inertScripts.mockRestore();
    delete window.turnstile;
    overwriteGetLocale(locale);
  };
});
afterEach(() => {
  restoreAdvice?.();
  restoreAdvice = undefined;
  restoreBrowser();
});
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
  const read = spyOn(registration, 'readRegistrationPage').mockImplementation(async () => config);
  restoreAdvice = () => read.mockRestore();
  const route = createRoute({ getParentRoute: () => root, path: '/signup', component: Route.options.component });
  const query = '?state=original&resource=one&resource=two';
  const login = createRoute({ getParentRoute: () => root, path: '/login', component: () => null });
  dom.history.replaceState(null, '', `/signup${query}`);
  const history = createFixtureHistory();
  const router = createRouter({ routeTree: root.addChildren([route, login]), history });
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
  const loadWidget = async () => {
    const script = dom.document.querySelector<HTMLScriptElement>(`script[src="${registrationPage.scriptUrl}"]`);
    expect(script, page.host.textContent ?? '').not.toBeNull();
    const previous = token;
    await flush(() => script!.dispatchEvent(new dom.Event('load') as unknown as Event));
    expect(token).toBeFunction();
    expect(token).not.toBe(previous);
  };
  await loadWidget();
  const input = (name: string) => page.host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const edit = (name: string, value: string) => flush(() => fill(input(name), value));
  const choose = (label: string) =>
    flush(() => {
      const control = button(document.body, label);
      expect(control, document.body.textContent ?? '').toBeDefined();
      control!.click();
    });
  const navigate = () =>
    flush(() => {
      void router.navigate({ to: '/signup?state=new', replace: true });
    });
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
      const reads = read.mock.calls.length;
      await flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event));
      expect(read).toHaveBeenCalledTimes(reads + 1);
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
  expect(error).toBe('signup-handle-hint signup-handle-error');
  expect(p.unload()).toBe(true);
  await flush(() => p.host.querySelector<HTMLAnchorElement>('a[href^="/login"]')!.click());
  const dialog = await departureDialog();
  expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
  expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
  await flushFrame();
  expect(document.activeElement?.textContent).toBe('Stay');
  await p.choose('Stay');
  await flushFrame();
  expect(p.router.history.location.search).toBe(p.query);
  expect(p.input('handle').value).toBe('bad!');
  expect(p.input('password').value).toBe(' ');
  expect(p.input('handle').getAttribute('aria-describedby')).toBe(error);
  expect(document.activeElement === p.input('handle'), 'Stay restores focus to the handle field').toBe(true);
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
  expect(secret.value).toBe('');
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  expect(p.host.textContent).toContain('Your earlier account creation may have completed');
  await flush(() => p.calls[1]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(2); // Leave retired the old callback, so late 201 cannot start sign-in.
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  expect(p.unload()).toBe(false);
  await p.choose('I have reviewed this');
  expect(p.input('password').value).toBe('');
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
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('reader_1');
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
  expect(document.body.textContent).toContain('An account is signed in');
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  await flush(() => signup.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(1); // A stale 201 cannot start sign-in or redirect this viewer.
  expect(document.body.textContent).toContain('An account is signed in');
});

test('malformed acknowledgement retains exact retry; admitted retry starts only one separate sign-in', async () => {
  const p = await setup();
  await p.ready();
  await flush(() => p.calls[0]!.resolve(new Response('{', { status: 201 })));
  expect(p.calls).toHaveLength(1);
  expect(p.host.querySelector('#signup-uncertain-panel')).not.toBeNull();
  await p.choose('Retry original attempt');
  expect(p.calls).toHaveLength(1);
  await p.token('new-verification');
  await p.choose('Retry original attempt');
  const { turnstile_token: _, ...original } = p.calls[0]!.body;
  expect(p.calls[1]!.body).toEqual({ ...original, turnstile_token: 'new-verification' });
  await flush(() => p.calls[1]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls).toHaveLength(3);
  expect(p.calls[2]!.body).toMatchObject({ email: original.email, password: original.password, client_id: 'login' });
  await flush(() => p.calls[2]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(p.host.querySelector('a[href^="/login"]')?.getAttribute('href')).toBe(`/login${p.query}`);
  expect(p.calls).toHaveLength(3);
});
