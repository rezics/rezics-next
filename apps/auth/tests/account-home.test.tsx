import { afterAll, afterEach, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccountIdentityResult, AccountIdentitySource } from '../src/account-identity';
import { loadAccountIdentity } from '../src/account-identity';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  getComputedStyle: dom.getComputedStyle.bind(dom),
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const),
);
for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
const { AccountHome } = await import('../src/account-home-view');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

type Mounted = {
  host: HTMLDivElement;
  render: (source: AccountIdentitySource) => Promise<void>;
};
const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];
const originalFetch = globalThis.fetch;

async function flush(action: () => void = () => {}) {
  await act(async () => {
    action();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(source: AccountIdentitySource): Promise<Mounted> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await flush(() => root.render(<AccountHome source={source} />));
  return {
    host,
    render: async (nextSource) => flush(() => root.render(<AccountHome source={nextSource} />)),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function identity(accountId: string, email: string | null): AccountIdentityResult {
  return { kind: 'ready', accountId, email };
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await flush(() => root.unmount());
    host.remove();
  }
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true, writable: true });
  window.history.replaceState(null, '', '/');
});

afterAll(async () => {
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  await dom.happyDOM.close();
});

test('the admitted identity read keeps its closed result states and same-origin request', async () => {
  const replies = [
    new Response(JSON.stringify({ account_id: 'own-account', email: 'person@example.test' }), { status: 200 }),
    new Response(JSON.stringify({ account_id: 'own-account', email: null }), { status: 200 }),
    new Response(null, { status: 401 }),
    new Response(null, { status: 403 }),
    new Response(null, { status: 503 }),
    new Response(JSON.stringify({ account_id: 'own-account', email: null, extra: true }), { status: 200 }),
    new Response('{', { status: 200 }),
  ];
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init });
    return replies.shift()!;
  }) as typeof fetch;

  const results = [];
  for (let index = 0; index < 7; index++) results.push(await loadAccountIdentity(new AbortController().signal));
  expect(results).toEqual([
    identity('own-account', 'person@example.test'),
    identity('own-account', null),
    { kind: 'signed-out' },
    { kind: 'denied' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
    { kind: 'unavailable' },
  ]);
  expect(requests).toHaveLength(7);
  expect(String(requests[0]!.input)).toBe('/account-identity');
  expect(requests.every(({ init }) => init?.method === 'POST' && init.credentials === 'same-origin')).toBe(true);
  expect(requests.every(({ init }) => init?.cache === 'no-store' && init.redirect === 'error' && init.body === '{}')).toBe(
    true,
  );
});

test('signed-out, denied, unavailable and missing-email states stay distinct', async () => {
  const signedOut = await mount(async () => ({ kind: 'signed-out' }));
  expect(signedOut.host.querySelector('[role="status"]')?.textContent).toContain('You are signed out');
  for (const href of ['/login', '/signup', '/recovery'])
    expect(signedOut.host.querySelector(`a[href="${href}"]`)).not.toBeNull();
  for (const href of ['/security', '/account/rename', '/account/delete'])
    expect(signedOut.host.querySelector(`a[href="${href}"]`)).not.toBeNull();
  expect(signedOut.host.textContent).toContain('does not promise an action is available');

  const denied = await mount(async () => ({ kind: 'denied' }));
  expect(denied.host.querySelector('[role="status"]')?.textContent).toContain('was refused');
  expect(denied.host.querySelector('button')).toBeNull();

  const unavailable = await mount(async () => ({ kind: 'unavailable' }));
  expect(unavailable.host.querySelector('[role="status"]')?.textContent).toContain('status is unknown');
  expect(unavailable.host.querySelector('button')?.textContent).toContain('Retry account check');

  const missingEmail = await mount(async () => identity('sample-account', null));
  expect(missingEmail.host.textContent).toContain('No email address is available');
  expect(missingEmail.host.textContent).not.toContain('verified');
});

test('independent home instances own separate reads and displayed identities', async () => {
  const firstRead = deferred<AccountIdentityResult>();
  const first = await mount(() => firstRead.promise);
  const second = await mount(async () => identity('second-account', 'second@example.test'));
  expect(first.host.querySelector('[role="status"]')?.textContent).toContain('Checking');
  expect(second.host.textContent).toContain('second@example.test');
  firstRead.resolve(identity('first-account', 'first@example.test'));
  await flush();
  expect(first.host.textContent).toContain('first@example.test');
  expect(first.host.textContent).not.toContain('second@example.test');
  expect(second.host.textContent).toContain('second@example.test');
  expect(second.host.textContent).not.toContain('first@example.test');
});

test('replacing a source aborts its read and ignores a late result', async () => {
  const previousRead = deferred<AccountIdentityResult>();
  let previousSignal: AbortSignal | undefined;
  const page = await mount((signal) => {
    previousSignal = signal;
    return previousRead.promise;
  });
  await page.render(async () => identity('replacement-account', 'replacement@example.test'));
  expect(previousSignal?.aborted).toBe(true);
  expect(page.host.textContent).toContain('replacement@example.test');
  previousRead.resolve(identity('retired-account', 'retired@example.test'));
  await flush();
  expect(page.host.textContent).toContain('replacement@example.test');
  expect(page.host.textContent).not.toContain('retired@example.test');
});

test('Retry focuses status, and pagehide/return clears and renews the observation', async () => {
  let retries = 0;
  const retryPage = await mount(async () =>
    retries++ === 0 ? { kind: 'unavailable' } : identity('retried-account', 'retry@example.test'),
  );
  await flush();
  await flush(() => retryPage.host.querySelector<HTMLButtonElement>('button')!.click());
  expect(retries).toBe(2);
  expect(document.activeElement).toBe(retryPage.host.querySelector('[role="status"]'));
  expect(retryPage.host.textContent).toContain('retry@example.test');

  let reads = 0;
  const renewed = deferred<AccountIdentityResult>();
  const returning = await mount(async () =>
    reads++ === 0 ? identity('before-return', 'before@example.test') : renewed.promise,
  );
  await flush();
  expect(returning.host.textContent).toContain('before@example.test');
  await flush(() => window.dispatchEvent(new Event('pagehide')));
  expect(returning.host.textContent).not.toContain('before@example.test');
  const pageshow = new Event('pageshow');
  Object.defineProperty(pageshow, 'persisted', { value: true });
  await flush(() => window.dispatchEvent(pageshow));
  expect(reads).toBe(2);
  expect(returning.host.textContent).not.toContain('before@example.test');
  renewed.resolve(identity('after-return', 'after@example.test'));
  await flush();
  expect(returning.host.textContent).toContain('after@example.test');
});
