import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { act, createElement } from 'react';
import * as start from '../.storybook/react-start';
import { creatorStatementFixture as statement } from '../src/kernel/fake/creator-statements';
import { CreatorPaymentAttempt } from '../src/checkout/creator-payment-attestation-state';

const subject = statement.creatorAccountId;
const csrf = 'c'.repeat(43);
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
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: request,
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
