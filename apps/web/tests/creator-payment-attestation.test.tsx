import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { act, createElement, useState } from 'react';
import * as start from '../.storybook/react-start';
import { creatorStatementFixture as statement } from '../src/kernel/fake/creator-statements';
import { CreatorPaymentAttempt } from '../src/checkout/creator-payment-attestation-state';
import { m } from '../src/paraglide/messages.js';

const subject = statement.creatorAccountId;
const csrf = 'c'.repeat(22);
let credential = 'current-creator';
let viewer = subject;
const env = {
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  KERNEL_ORIGIN: 'https://kernel.test',
  SITE_ORIGINS: 'https://site.test',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => ({
        status: 'active',
        subject: viewer,
        accessToken: credential,
        csrfToken: csrf,
      }),
    }),
  },
};
const request = () =>
  new Request('https://site.test/en/creator/statements', {
    method: 'POST',
    headers: {
      cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
      origin: 'https://site.test',
      'X-CSRF-Token': csrf,
    },
  });
mock.module('cloudflare:workers', () => ({ env }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createIsomorphicFn() {
    let server: (...args: unknown[]) => unknown = () => undefined;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client() {
        return (...args: unknown[]) => server(...args);
      },
    };
    return chain;
  },
}));
start.setStoryRequestContext({ visitor: 'Signed In', url: 'https://site.test/en/creator/statements' });
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => start.requestForStory(request()),
  setResponseHeader: () => {},
}));
const { paymentAttestationInput, submitPaymentAttestation } =
  await import('../src/checkout/creator-payment-attestation');
const input = {
  statementId: statement.id,
  subject,
  paidReference: '  BANK/Exact é  ',
  idempotencyKey: crypto.randomUUID(),
};
const paid = {
  id: statement.id,
  state: 'paid' as const,
  paidReference: input.paidReference,
  paidAt: '2026-11-01T12:00:00Z',
  revision: 3,
};
const calls: Request[] = [];
let response: () => Response = () => Response.json({ statement: paid });
const client = createKernelClient('https://kernel.test', {
  fetch: (async (url, init) => {
    calls.push(new Request(url, init));
    return response();
  }) as typeof fetch,
});

test('validate exact references and reject blank, oversized, changed identity and unadopted financial fields', () => {
  expect(paymentAttestationInput(input)).toEqual(input);
  expect(paymentAttestationInput({ ...input, paidReference: 'x'.repeat(256) }).paidReference).toHaveLength(256);
  for (const change of [
    { paidReference: ' \n\t' },
    { paidReference: 'x'.repeat(257) },
    { statementId: 'bad' },
    { idempotencyKey: 'bad' },
    { subject: '' },
    { amount: 50 },
  ])
    expect(() => paymentAttestationInput({ ...input, ...change })).toThrow();
});

test('native markPaid binds route, reference, original key, current session and exact response; failures stay distinct', async () => {
  calls.length = 0;
  for (const name of ['creator', 'operator']) {
    viewer = name === 'creator' ? subject : '019a2100-0000-7000-8000-000000000098';
    credential = `current-${name}`;
    expect(await submitPaymentAttestation(client, request(), env as never, { ...input, subject: viewer })).toEqual({
      kind: 'saved',
      statement: paid,
    });
    const call = calls.at(-1)!;
    expect([call.method, new URL(call.url).pathname]).toEqual([
      'POST',
      `/v1/payoutStatements/${statement.id}:markPaid`,
    ]);
    expect(await call.json()).toEqual({ paidReference: input.paidReference });
    expect(call.headers.get('authorization')).toBe(`Bearer current-${name}`);
    expect(call.headers.get('idempotency-key')).toBe(input.idempotencyKey);
    expect([call.cache, call.redirect]).toEqual(['no-store', 'manual']);
  }
  const count = calls.length;
  viewer = '019a2100-0000-7000-8000-000000000099';
  expect(await submitPaymentAttestation(client, request(), env as never, input)).toEqual({ kind: 'denied' });
  expect(calls).toHaveLength(count);
  viewer = subject;
  for (const [status, kind] of [
    [400, 'rejected'],
    [401, 'denied'],
    [403, 'denied'],
    [404, 'denied'],
    [409, 'conflict'],
    [422, 'conflict'],
    [503, 'uncertain'],
  ] as const) {
    response = () => Response.json({ code: 'native_refusal' }, { status });
    expect(await submitPaymentAttestation(client, request(), env as never, input)).toEqual({ kind });
  }
  for (const change of [
    { id: viewer },
    { paidReference: input.paidReference.trim() },
    { paidAt: 'bad' },
    { state: 'open' },
    { revision: 0 },
  ]) {
    response = () => Response.json({ statement: { ...paid, ...change } });
    expect(await submitPaymentAttestation(client, request(), env as never, input)).toEqual({
      kind: 'uncertain',
    });
  }
  response = () => {
    throw new Error('response lost');
  };
  expect(await submitPaymentAttestation(client, request(), env as never, input)).toEqual({
    kind: 'uncertain',
  });
});

test('lost responses, double submission and retired authority retain one immutable original until an explicit replay', async () => {
  const attempt = new CreatorPaymentAttempt(statement.id, subject);
  let current = true;
  const sent: unknown[] = [];
  let finish!: (value: { kind: 'saved'; statement: typeof paid }) => void;
  const execute = (value: unknown) => {
    sent.push(value);
    return new Promise<{ kind: 'saved'; statement: typeof paid }>((resolve) => {
      finish = resolve;
    });
  };
  const pending = attempt.submit(input.paidReference, execute, () => current);
  await attempt.submit('different', execute, () => current);
  expect(sent).toHaveLength(1);
  current = false;
  finish({ kind: 'saved', statement: paid });
  await pending;
  expect(attempt.result).toEqual({ kind: 'uncertain' });
  await attempt.submit('different', execute, () => current);
  expect(sent).toHaveLength(1);
  current = true;
  await attempt.submit(
    'different',
    async (value) => {
      sent.push(value);
      return { kind: 'saved', statement: paid };
    },
    () => current,
  );
  expect(sent[0]).toBe(sent[1]);
  expect(attempt.request?.paidReference).toBe(input.paidReference);
  expect(attempt.result?.kind).toBe('saved');
  await attempt.submit('different', execute, () => current);
  expect(sent).toHaveLength(2);
});

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/creator/statements' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
const { createRoot } = await import('react-dom/client');
const { CreatorPaymentAttestation } = await import('../src/checkout/creator-payment-attestation-form');
const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the actual form retries captured evidence after a paid read, confirms only the command response, then refreshes once', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let writes = 0,
    refreshes = 0;
  const transport = mock(async (_url: unknown, init?: RequestInit) => {
    writes++;
    expect(JSON.parse(String(init?.body))).toEqual({
      paidReference: input.paidReference,
    });
    if (writes === 1) throw new Error('response lost');
    return Response.json({ statement: paid });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = transport as unknown as typeof fetch;
  let token: string | null = csrf;
  const props = {
    statement,
    subject,
    locale: 'en',
    guard: { isCurrent: () => true, csrfToken: () => token },
    refresh: async () => {
      refreshes++;
      return false;
    },
  };
  try {
    await act(async () => {
      root.render(createElement(CreatorPaymentAttestation, props));
    });
    const field = host.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        field,
        input.paidReference,
      );
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const submit = async () => {
      await act(async () => {
        host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      });
    };
    await submit();
    expect(writes).toBe(1);
    expect(refreshes).toBe(0);
    expect(field.disabled).toBe(true);
    const key = host.querySelector('dl')!.textContent;
    token = null;
    await act(async () => root.render(createElement(CreatorPaymentAttestation, props)));
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    await submit();
    expect(writes).toBe(1);
    const refresh = [...host.querySelectorAll('button')].find((button) => button.type === 'button')!;
    expect(refresh.disabled).toBe(false);
    await act(async () => refresh.click());
    expect(refreshes).toBe(1);
    token = 'replacement-token';
    await act(async () => {
      root.render(
        createElement(CreatorPaymentAttestation, {
          ...props,
          statement: { ...statement, ...paid },
        }),
      );
    });
    expect(host.textContent).toContain('The response is unknown');
    await submit();
    expect(writes).toBe(2);
    expect(refreshes).toBe(2);
    expect(host.textContent).toContain('The external payment reference was recorded');
    expect(host.textContent).toContain('current statement evidence could not be refreshed');
    expect(host.textContent).toContain(key!);
    expect(transport.mock.calls[0]![1]?.headers).toEqual(transport.mock.calls[1]![1]?.headers);
    expect(field.disabled).toBe(true);
    await submit();
    expect([writes, refreshes]).toEqual([2, 2]);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    host.remove();
  }
});

test('the actual statement Refresh asks before reloading, and discarding the draft sends no payment command', async () => {
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const href = `/en/creator/statements/${statement.id}`;
  const originalHref = window.location.href;
  window.history.replaceState({}, '', href);
  const assigned: string[] = [];
  const assignDescriptor = Object.getOwnPropertyDescriptor(window.location, 'assign');
  Object.defineProperty(window.location, 'assign', {
    configurable: true,
    writable: true,
    value: (destination: string | URL) => assigned.push(String(destination)),
  });
  const originalFetch = globalThis.fetch;
  let writes = 0;
  let refreshes = 0;
  let token: string | null = csrf;
  globalThis.fetch = (async () => {
    writes++;
    return Response.json({ statement: paid });
  }) as typeof fetch;
  const rootRoute = createRootRoute({ component: Outlet });
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements',
    component: () => null,
  });
  let rerenderSession!: () => void;
  function StatementFixture() {
    const [, update] = useState(0);
    rerenderSession = () => update((version) => version + 1);
    return createElement(CreatorStatementPage, {
      id: statement.id,
      locale: 'en',
      page: { kind: 'ready', statement, lines: { kind: 'ready', lines: [], next: null } },
      payment: createElement(CreatorPaymentAttestation, {
        statement,
        subject,
        locale: 'en',
        guard: { isCurrent: () => true, csrfToken: () => token },
        refresh: async () => {
          refreshes++;
          return true;
        },
      }),
    });
  }
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/creator/statements/$id',
    component: StatementFixture,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [`/creator/statements/${statement.id}`] }),
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const dialog = () => document.querySelector('[role="alertdialog"]');
  const button = (label: string) =>
    [...document.querySelectorAll('button')].find((item) => item.textContent === label)!;
  try {
    await act(async () => {
      await router.load();
      root.render(createElement(RouterProvider, { router }));
    });
    const field = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(
        field,
        input.paidReference,
      );
      field.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const refresh = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (anchor) => anchor.textContent?.trim() === m.statements_refresh(),
    )!;
    expect(refresh.href).toBe(`https://site.test${href}`);
    const clickRefresh = async () =>
      await act(async () => {
        refresh.click();
        await Promise.resolve();
      });

    await clickRefresh();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain(m.payment_reference_draft_navigation_title());
    expect(field.getAttribute('aria-invalid')).toBe('false');
    await act(async () => button(m.payment_reference_draft_navigation_stay()).click());
    expect(field.value).toBe(input.paidReference);
    expect(field.getAttribute('aria-invalid')).toBe('false');
    expect(document.activeElement).toBe(field);

    await clickRefresh();
    expect(dialog()).not.toBeNull();
    await act(async () => {
      token = null;
      rerenderSession();
    });
    expect(dialog()).toBeNull();
    expect(assigned).toEqual([refresh.href]);
    const retiredUnload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(retiredUnload);
    expect(retiredUnload.defaultPrevented).toBe(false);

    await act(async () => {
      token = csrf;
      rerenderSession();
    });
    await act(async () => {
      refresh.click();
      refresh.click();
      await Promise.resolve();
    });
    expect(dialog()).not.toBeNull();
    await act(async () => button(m.payment_reference_draft_navigation_discard()).click());
    expect(assigned).toEqual([refresh.href, refresh.href]);
    const unload = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    expect([writes, refreshes]).toEqual([0, 0]);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState({}, '', originalHref);
    if (assignDescriptor) Object.defineProperty(window.location, 'assign', assignDescriptor);
    else Reflect.deleteProperty(window.location, 'assign');
  }
});
