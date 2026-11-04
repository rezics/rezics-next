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
  let reads = 0;
  const readStartWaiters: (() => void)[] = [];
  const pendingReads: ((page: RegistrationPage) => void)[] = [];
  const route = Route.update({
    id: '/signup',
    path: '/signup',
    getParentRoute: () => root,
    loader: () => {
      if (reads++ === 0) return advice;
      readStartWaiters.shift()?.();
      return new Promise<RegistrationPage>((resolve) => pendingReads.push(resolve));
    },
  } as never);
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
  const ready = async () => {
    await flush(() => fill(input('handle'), 'Reader_1'));
    await flush(() => fill(input('email'), 'reader@example.test'));
    await flush(() => fill(input('password'), 'private-password'));
    await flush(() => fill(input('confirm'), 'private-password'));
    await flush(() => token('private-token'));
    await flush(() => send(page.host));
  };
  const startNextRead = () => {
    const started = Promise.withResolvers<void>();
    readStartWaiters.push(started.resolve);
    return started.promise;
  };
  const restored = async () => {
    await new Promise<void>((resolve) => {
      let unsubscribe = () => {};
      const finish = () => {
        if (!router.state.matches.some((match) => match.routeId === '/signup' && match.isFetching !== false)) {
          unsubscribe();
          resolve();
        }
      };
      unsubscribe = router.subscribe('onRendered', finish);
      finish();
    });
    await flush(() => {});
  };
  const transition = (type: 'pagehide' | 'pageshow') => {
    const event = new dom.Event(type);
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event as unknown as Event);
  };
  return {
    ...page,
    router,
    registrationPage,
    calls: page.calls,
    input,
    ready,
    token: (value: string) => flush(() => token(value)),
    startNextRead,
    restored,
    releaseRead: (next: RegistrationPage = advice) => flush(() => pendingReads.shift()!(next)),
    transition: (type: 'pagehide' | 'pageshow') => flush(() => transition(type)),
    focus: () => flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event)),
    setAdvice: (next: RegistrationPage) => {
      advice = next;
    },
    acknowledge: () => flush(() => button(document.body, 'I have reviewed this')!.click()),
  };
}

async function refreshAfterReturn(p: Awaited<ReturnType<typeof setup>>) {
  const started = p.startNextRead();
  await p.transition('pageshow');
  await started;
  await p.releaseRead();
  await p.restored();
}

async function retryAdvice(p: Awaited<ReturnType<typeof setup>>, next: RegistrationPage) {
  p.setAdvice(next);
  const started = p.startNextRead();
  await flush(() => button(document.body, 'Check current options again')!.click());
  await started;
  await p.releaseRead(next);
  await p.restored();
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
  const started = p.startNextRead();
  await p.transition('pageshow');
  await started;
  expect(p.host.textContent).toContain('Checking current account options');
  expect(p.host.querySelector('form')).toBeNull();
  await p.releaseRead();
  await p.restored();

  expect(p.host.textContent).toContain('Your earlier account creation may have completed');
  expect(p.host.querySelector('input[name="password"]')).toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)).not.toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/recovery${query}"]`)).not.toBeNull();
  await flush(() => p.calls[0]!.resolve(Response.json({ accountId: 'created' }, { status: 201 })));
  expect(p.calls.map((call) => call.path)).toEqual(['/signup']);
  expect(p.host.textContent).toContain('Your earlier account creation may have completed');

  await p.acknowledge();
  expect(p.host.querySelector('form')).not.toBeNull();
  expect(p.host.textContent).toContain('This is a new registration attempt');
  await flush(() =>
    document
      .querySelector<HTMLScriptElement>(`script[src="${p.registrationPage.scriptUrl}"]`)!
      .dispatchEvent(new dom.Event('load') as unknown as Event),
  );
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
  await flush(() => pendingSignIn.resolve(Response.json({ ok: true })));
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
  expect([...p.host.querySelectorAll('button')].some((item) => item.textContent?.includes('Retry original attempt'))).toBe(
    false,
  );
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
  await flush(() =>
    refused.calls[0]!.resolve(Response.json({ error: 'conflict', code: 'registration_conflict' }, { status: 409 })),
  );
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
  expect(p.host.textContent).toContain('Current account options are unavailable');
  expect(p.host.querySelector('form')).toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/login${query}"]`)).not.toBeNull();
  expect(p.host.querySelector<HTMLAnchorElement>(`a[href="/recovery${query}"]`)).not.toBeNull();

  await retryAdvice(p, signedInAdvice('current-account-one'));
  expect(p.host.textContent).toContain('This describes the current session');
  expect(p.host.textContent).toContain('does not show whether the earlier registration completed');
  expect(p.host.querySelector('form')).toBeNull();

  p.setAdvice(signedInAdvice('current-account-two'));
  const started = p.startNextRead();
  await p.focus();
  await started;
  await p.releaseRead(signedInAdvice('current-account-two'));
  await p.restored();
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
