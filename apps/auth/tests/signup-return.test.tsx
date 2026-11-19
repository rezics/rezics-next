import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { creationFixture, button, dom, fill, flush, open, send } from './creation-page-fixture';
import { Route } from '../src/routes/signup';
import * as registration from '../src/registration-page';
import type { RegistrationPage } from '../src/registration-page';
import { getLocale, overwriteGetLocale } from '../src/paraglide/runtime.js';
import { nativeSignInProof } from './sign-in-fixture';

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

const query = '?client_id=showcase&scope=openid&return_to=%2Fwork%2Fseeded&hint=%2Fraw%2Bbytes';
let serial = 0;
const unavailableAdvice: RegistrationPage = {
  kind: 'unavailable',
  reason: 'dependency',
  actions: { register: false, continue: false },
};
const signedInAdvice = (accountId: string): RegistrationPage => ({
  kind: 'already-signed-in',
  viewer: { account_id: accountId },
  requirements: {
    handle: { minLength: 3, maxLength: 64 },
    email: { maxLength: 254 },
    password: { minLength: 8, maxLength: 128 },
    verification: { provider: 'turnstile', required: true },
  },
  verification: { configured: true },
  actions: { register: false, continue: true },
});

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
    scriptUrl: `https://challenge.test/return-${++serial}.js`,
  };
  let advice: RegistrationPage = registrationPage;
  const pendingReads: ReturnType<typeof Promise.withResolvers<RegistrationPage>>[] = [];
  const read = spyOn(registration, 'readRegistrationPage')
    .mockResolvedValueOnce(registrationPage)
    .mockImplementation(() => {
      const pending = Promise.withResolvers<RegistrationPage>();
      pendingReads.push(pending);
      return pending.promise;
    });
  restoreAdvice = () => read.mockRestore();
  const route = createRoute({ getParentRoute: () => root, path: '/signup', component: Route.options.component });
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
  const ready = async () => {
    await flush(() => fill(input('handle'), 'Reader_1'));
    await flush(() => fill(input('email'), 'reader@example.test'));
    await flush(() => fill(input('password'), 'private-password'));
    await flush(() => fill(input('confirm'), 'private-password'));
    await flush(() => token('private-token'));
    await flush(() => send(page.host));
  };
  const transition = (type: 'pagehide' | 'pageshow') => {
    const event = new dom.Event(type);
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event as unknown as Event);
  };
  return {
    ...page,
    loadWidget,
    input,
    ready,
    token: (value: string) => flush(() => token(value)),
    releaseRead: (next: RegistrationPage = advice) => {
      expect(pendingReads).toHaveLength(1);
      return flush(() => pendingReads.shift()!.resolve(next));
    },
    transition: (type: 'pagehide' | 'pageshow') => flush(() => transition(type)),
    focus: () => flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event)),
    setAdvice: (next: RegistrationPage) => {
      advice = next;
    },
    acknowledge: () => flush(() => button(document.body, 'I have reviewed this')!.click()),
  };
}

async function refreshAfterReturn(p: Awaited<ReturnType<typeof setup>>) {
  await p.transition('pageshow');
  await p.releaseRead();
}

async function retryAdvice(p: Awaited<ReturnType<typeof setup>>, next: RegistrationPage) {
  p.setAdvice(next);
  await flush(() => button(document.body, 'Check account options again')!.click());
  await p.releaseRead(next);
}

test('persisted return keeps only an unknown outcome, fences late creation, and acknowledgement starts fresh', async () => {
  const p = await setup();
  await p.ready();
  expect(p.calls.map((call) => call.path)).toEqual(['/signup']);
  const oldKey = p.calls[0]!.body.key;

  await p.transition('pagehide');
  expect(p.host.querySelector('form')).toBeNull();
  expect(document.body.textContent).not.toContain('private-password');
  expect(document.body.textContent).not.toContain('reader@example.test');
  await p.transition('pageshow');
  expect(p.host.textContent).toContain('Checking account options');
  expect(p.host.querySelector('form')).toBeNull();
  await p.releaseRead();

  expect(p.host.textContent).toContain('Your earlier account creation may have completed');
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)).not.toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/recovery${query}"]`)).not.toBeNull();
  await flush(() => p.calls[0]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls.map((call) => call.path)).toEqual(['/signup']);
  expect(p.host.textContent).toContain('Your earlier account creation may have completed');

  await p.acknowledge();
  expect(p.host.querySelector('form')).not.toBeNull();
  expect(p.host.textContent).toContain('This is a new registration');
  await p.loadWidget();
  await flush(() => fill(p.input('handle'), 'Reader_2'));
  await flush(() => fill(p.input('email'), 'reader2@example.test'));
  await flush(() => fill(p.input('password'), 'another-private-password'));
  await flush(() => fill(p.input('confirm'), 'another-private-password'));
  await p.token('fresh-token');
  await flush(() => send(p.host));
  expect(p.calls).toHaveLength(2);
  expect(p.calls[1]!.body.key).not.toBe(oldKey);
});

test('confirmed creation with pending or failed automatic sign-in returns as creation, never as a retry', async () => {
  const p = await setup();
  await p.ready();
  await flush(() => p.calls[0]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls.map((call) => call.path)).toEqual(['/signup', '/signin']);
  const pendingSignIn = p.calls[1]!;

  await p.transition('pagehide');
  await refreshAfterReturn(p);
  expect(p.host.textContent).toContain('Your account was created');
  expect(p.host.textContent).not.toContain('Your earlier account creation may have completed');
  expect(p.host.querySelector('form')).toBeNull();
  await flush(() => pendingSignIn.resolve(Response.json(nativeSignInProof(pendingSignIn.body))));
  expect(p.calls.map((call) => call.path)).toEqual(['/signup', '/signin']);

  await p.transition('pagehide');
  await refreshAfterReturn(p);
  expect(p.host.textContent).toContain('Your account was created');
  expect(p.calls.map((call) => call.path)).toEqual(['/signup', '/signin']);
});

test('an already-unknown attempt returns generically without its exact-retry action', async () => {
  const p = await setup();
  await p.ready();
  await flush(() => p.calls[0]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(p.host.querySelector('#signup-uncertain-panel')?.textContent).toContain('reader_1');
  await p.transition('pagehide');
  await refreshAfterReturn(p);

  expect(p.host.textContent).toContain('Your earlier account creation may have completed');
  expect(p.host.textContent).not.toContain('Reader_1');
  expect(p.host.textContent).not.toContain('reader@example.test');
  expect(
    [...p.host.querySelectorAll('button')].some((item) => item.textContent?.includes('Retry original attempt')),
  ).toBe(false);
  expect(p.calls.map((call) => call.path)).toEqual(['/signup']);
});

test('an untouched draft returns only after fresh advice, without a warning', async () => {
  const draft = await setup();
  await flush(() => fill(draft.input('handle'), 'Reader_1'));
  await draft.transition('pagehide');
  await refreshAfterReturn(draft);
  expect(draft.host.querySelector<HTMLInputElement>('input[name="handle"]')?.value).toBe('');
  expect(draft.host.textContent).not.toContain('earlier account creation may have completed');
  expect(draft.calls).toHaveLength(0);
});

test('a known first refusal returns to a fresh form only after current advice', async () => {
  const refused = await setup();
  await refused.ready();
  await flush(() => refused.calls[0]!.resolve(Response.json({ error: 'registration_denied' }, { status: 409 })));
  expect(refused.host.textContent).toContain('We could not create this account');
  await refused.transition('pagehide');
  await refreshAfterReturn(refused);
  expect(refused.host.querySelector<HTMLInputElement>('input[name="handle"]')?.value).toBe('');
  expect(refused.host.textContent).not.toContain('earlier account creation may have completed');
  expect(refused.calls.map((call) => call.path)).toEqual(['/signup']);
});

test('unavailable advice keeps recovery choices and current viewer changes never settle creation', async () => {
  const p = await setup();
  await p.ready();
  await p.transition('pagehide');
  p.setAdvice(unavailableAdvice);
  await refreshAfterReturn(p);
  expect(p.host.textContent).toContain('Account options are unavailable');
  expect(p.host.querySelector('form')).toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)).not.toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/recovery${query}"]`)).not.toBeNull();

  await retryAdvice(p, signedInAdvice('current-account-one'));
  expect(p.host.textContent).toContain('An account is signed in');
  expect(p.host.textContent).toContain('does not show whether the earlier registration finished');
  expect(p.host.querySelector('form')).toBeNull();

  p.setAdvice(signedInAdvice('current-account-two'));
  await p.focus();
  await p.releaseRead(signedInAdvice('current-account-two'));
  expect(p.host.textContent).toContain('The signed-in account changed during this review');
  expect(p.host.textContent).toContain('does not resolve the earlier registration');
  expect(p.calls.map((call) => call.path)).toEqual(['/signup']);
});

test('failed automatic sign-in after confirmed creation restores the created outcome', async () => {
  const p = await setup();
  await p.ready();
  await flush(() => p.calls[0]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  await flush(() => p.calls[1]!.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
  expect(p.host.textContent).toContain('Your account was created');
  await p.transition('pagehide');
  await refreshAfterReturn(p);

  expect(p.host.textContent).toContain('Your account was created');
  expect(p.host.textContent).not.toContain('Your earlier account creation may have completed');
  expect(p.host.querySelector('form')).toBeNull();
  expect(p.calls.map((call) => call.path)).toEqual(['/signup', '/signin']);
});
