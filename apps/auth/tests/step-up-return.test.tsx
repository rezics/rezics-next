import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { creationFixture, button, dom, fill, flush, open as mount, send } from './creation-page-fixture';
import { m } from '../src/paraglide/messages.js';
import {
  RENAME_REVIEW_STEP_UP_STORAGE_LIMIT,
  managementOperationStepUpUrl,
  pendingRenameReviewStepUpState,
  storePendingRenameReviewStepUp,
} from '../src/management-operation-step-up';
import { managementOperationProfile } from '../src/management-operations';

creationFixture();
const previousScrollTo = Object.getOwnPropertyDescriptor(globalThis, 'scrollTo');
Object.defineProperty(globalThis, 'scrollTo', { value: () => {}, configurable: true, writable: true });
afterAll(() => {
  if (previousScrollTo) Object.defineProperty(globalThis, 'scrollTo', previousScrollTo);
  else Reflect.deleteProperty(globalThis, 'scrollTo');
});
let cleanup = () => {};
afterEach(() => cleanup());
const { createRootRoute, createRoute, createRouter, createBrowserHistory, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/step-up');

async function settle() {
  await flush(() => Promise.resolve());
}

async function setup(search = '?return_to=%2Fsecurity') {
  window.history.replaceState(null, '', `/step-up${search}`);
  const parent = createRootRoute();
  const stepUp = Route.update({ id: '/step-up', path: '/step-up', getParentRoute: () => parent } as never);
  const away = createRoute({ getParentRoute: () => parent, path: '/away', component: () => 'Away' });
  const history = createBrowserHistory({ window: dom });
  const router = createRouter({ routeTree: parent.addChildren([stepUp, away]), history });
  await router.load();
  const assign = spyOn(window.location, 'assign').mockImplementation(() => {});
  const page = await mount(<RouterProvider router={router} />, {});
  cleanup = () => {
    history.destroy();
    assign.mockRestore();
  };
  return { ...page, router, assign };
}

function nativeAdvice(accountId = '00000000-0000-4000-8000-000000000002', email = 'current@example.test') {
  return Response.json(
    recoveryPage(
      'step-up',
      { minPasswordLength: 8, maxPasswordLength: 128 },
      { kind: 'signed-in', account_id: accountId, email },
    ),
  );
}

async function beginPendingPassword(page: Awaited<ReturnType<typeof setup>>) {
  await settle();
  fill(page.host.querySelector<HTMLInputElement>('[name=email]')!, 'former@example.test');
  fill(page.host.querySelector<HTMLInputElement>('[name=password]')!, 'private password');
  await flush(() => send(page.host));
  expect(page.calls.map((call) => call.path)).toEqual(['/signin']);
}

async function pagehide() {
  await flush(() => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event));
}

async function pageshow() {
  const event = new dom.Event('pageshow');
  Object.defineProperty(event, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(event as unknown as Event));
  await settle();
}

test('Retry reads only current advice; Continue rechecks it and navigates only after an explicit choice', async () => {
  const page = await setup();
  await beginPendingPassword(page);
  await pagehide();
  const original = globalThis.fetch;
  let reads = 0;
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/recovery/page') {
      reads++;
      if (reads === 1) return Promise.resolve(new Response('', { status: 503 }));
      if (reads === 2) return Promise.resolve(Response.json({ stage: 'step-up' }));
      return Promise.resolve(nativeAdvice());
    }
    return original(input, init);
  });
  await pageshow();
  expect(page.host.textContent).toContain(m.auth_failure_unavailable());
  expect(page.host.querySelector('[name=password]')).toBeNull();
  expect(page.assign).not.toHaveBeenCalled();

  await flush(() => button(page.host, m.auth_login_retry())!.click());
  await settle();
  expect(document.activeElement).toBe(page.host.querySelector('[role="alert"]'));
  expect(page.host.textContent).toContain(m.auth_failure_unavailable());
  await flush(() => button(page.host, m.auth_login_retry())!.click());
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_continue());
  expect(page.host.textContent).not.toContain('current@example.test');
  expect(page.assign).not.toHaveBeenCalled();

  await flush(() => button(page.host, m.auth_step_up_return_continue())!.click());
  await settle();
  expect(page.assign).toHaveBeenCalledTimes(1);
  expect(page.assign).toHaveBeenCalledWith('https://auth.test/security');
  expect(reads).toBe(4);
  expect(page.calls.map((call) => call.path)).toEqual(['/signin']);
  request.mockRestore();
  page.calls[0]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 }));
});

test('fresh advice retires a previously available Continue action while its review is pending', async () => {
  const page = await setup();
  await beginPendingPassword(page);
  await pagehide();

  const original = globalThis.fetch;
  const refresh = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  let reads = 0;
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/recovery/page') {
      reads++;
      if (reads === 1) return Promise.resolve(nativeAdvice());
      started.resolve();
      return refresh.promise;
    }
    return original(input, init);
  });

  await pageshow();
  expect(button(page.host, m.auth_step_up_return_continue())).toBeDefined();
  await flush(() => window.dispatchEvent(new dom.Event('focus') as unknown as Event));
  await started.promise;
  expect(button(page.host, m.auth_step_up_return_continue())).toBeUndefined();
  expect(page.host.textContent).toContain(m.auth_step_up_return_pending());

  refresh.resolve(nativeAdvice());
  await settle();
  expect(button(page.host, m.auth_step_up_return_continue())).toBeDefined();
  request.mockRestore();
  page.calls[0]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 }));
});

test('a failed Continue recheck requires a fresh advice read before authentication is offered', async () => {
  const page = await setup();
  await beginPendingPassword(page);
  await pagehide();
  const original = globalThis.fetch;
  let reads = 0;
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input) === '/recovery/page') {
      reads++;
      return reads === 2 ? Promise.resolve(new Response('', { status: 503 })) : Promise.resolve(nativeAdvice());
    }
    return original(input, init);
  });

  await pageshow();
  expect(button(page.host, m.auth_step_up_return_continue())).toBeDefined();
  await flush(() => button(page.host, m.auth_step_up_return_continue())!.click());
  await settle();
  expect(page.host.textContent).toContain(m.auth_failure_unavailable());
  expect(button(page.host, m.auth_step_up_return_continue())).toBeUndefined();
  expect(button(page.host, m.auth_step_up_return_start())).toBeUndefined();
  expect(page.assign).not.toHaveBeenCalled();

  await flush(() => button(page.host, m.auth_login_retry())!.click());
  await settle();
  expect(button(page.host, m.auth_step_up_return_start())).toBeDefined();
  expect(reads).toBe(3);
  request.mockRestore();
  page.calls[0]!.resolve(Response.json({ error: 'authentication_denied' }, { status: 401 }));
});

test('a replaced management marker fails its released read without consuming replacement state', async () => {
  const firstAccount = '00000000-0000-4000-8000-000000000011';
  const replacementAccount = '00000000-0000-4000-8000-000000000022';
  const search = new URL(managementOperationStepUpUrl('rename'), 'https://auth.test').search;
  expect(storePendingRenameReviewStepUp(firstAccount)).toBe(true);
  const page = await setup(search);
  await beginPendingPassword(page);
  await pagehide();

  const original = globalThis.fetch;
  const session = Promise.withResolvers<Response>();
  const observingSession = Promise.withResolvers<void>();
  const calls: string[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = String(input);
    calls.push(path);
    if (path === '/recovery/page') return Promise.resolve(nativeAdvice(replacementAccount, 'replacement@example.test'));
    if (path === '/session') {
      observingSession.resolve();
      return session.promise;
    }
    return original(input, init);
  });
  await pageshow();
  await observingSession.promise;
  expect(storePendingRenameReviewStepUp(replacementAccount)).toBe(true);
  const profile = managementOperationProfile('rename');
  session.resolve(
    Response.json({
      account_id: firstAccount,
      client_id: profile.client_id,
      scope: profile.scope,
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    }),
  );
  await settle();
  expect(calls).toEqual(['/recovery/page', '/session']);
  expect(page.host.textContent).toContain(m.auth_step_up_continuation_changed());
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  expect(page.host.textContent).not.toContain('former@example.test');
  expect(page.host.textContent).not.toContain('replacement@example.test');
  expect(button(page.host, m.auth_step_up_return_continue())).toBeUndefined();
  expect(pendingRenameReviewStepUpState()).toEqual({
    kind: 'pending',
    value: expect.objectContaining({ accountId: replacementAccount, phase: 'awaiting' }),
  });
  expect(page.assign).not.toHaveBeenCalled();

  page.calls[0]!.resolve(Response.json({ success: true }));
  await settle();
  expect(page.host.textContent).toContain(m.auth_step_up_return_unknown());
  expect(page.assign).not.toHaveBeenCalled();
  request.mockRestore();
});

test('an oversized rename-review marker refuses the old return before a native session read', async () => {
  const search = new URL(managementOperationStepUpUrl('rename'), 'https://auth.test').search;
  const raw = '['.repeat(RENAME_REVIEW_STEP_UP_STORAGE_LIMIT + 1);
  window.sessionStorage.setItem('rezics.management-operation.review-step-up', raw);
  const original = globalThis.fetch;
  const requests: string[] = [];
  const request = spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    requests.push(String(input));
    return original(input, init);
  });

  const page = await setup(search);
  await settle();
  await pageshow();
  await settle();

  expect(pendingRenameReviewStepUpState()).toEqual({ kind: 'invalid' });
  expect(requests).not.toContain('/session');
  expect(page.calls.map((call) => call.path)).not.toContain('/signin');
  expect(button(page.host, m.auth_step_up_return_continue())).toBeUndefined();
  expect(page.assign).not.toHaveBeenCalled();
  expect(window.sessionStorage.getItem('rezics.management-operation.review-step-up')).toBe(raw);
  request.mockRestore();
});
