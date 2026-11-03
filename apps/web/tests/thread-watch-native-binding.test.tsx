import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { Window } from 'happy-dom';
import { ThreadWatch, type ThreadWatchProps } from '../src/threads/thread-watch';
import { m } from '../src/paraglide/messages.js';
import { createThreadWatchNative, nativeThreadWatch, type ThreadWatchTransport } from '../src/threads/thread-watch-native';
import { readThreadWatchRequest, setThreadWatchRequest } from '../src/threads/thread-watch-request';
import type { SessionEnv } from '../src/session/client';

const browser = new Window({ url: 'https://site.test/en/threads/thread-a/readable' });
const globals = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window: browser, document: browser.document, navigator: browser.navigator, HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement, Node: browser.Node, IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const csrfA = 'A'.repeat(22);
const csrfB = 'B'.repeat(22);
const sessionId = 'a'.repeat(43);
const session = (csrfToken = csrfA, subject = 'reader-a') => ({ state: 'signed-in', subject, csrfToken });
const baseline: ThreadWatchProps = {
  threadId: 'thread-a', session: 'signed-in', sessionKnown: true, viewerId: 'reader-a',
  sessionStamp: 'admission-a', admitted: true, returnTo: '/threads/thread-a/readable',
};
type Call = { method: string; path: string; authorization: string | null; key: string | null; cache: RequestCache; body: string };
let calls: Call[];
let credential: { csrfToken: string; subject: string; accessToken: string };
let credentialsRead: number;
let response: (call: Call) => Promise<Response> | Response;
let kernel: KernelClient;
let client: QueryClient;
let root: Root;
let host: HTMLDivElement;
let serverCalls: number;
let active: number;
let maxActive: number;

function environment(): Partial<SessionEnv> {
  return {
    SITE_ORIGINS: 'https://site.test', AUTH_ISSUER: 'https://auth.test', API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'thread:watch', WEBSITE_CLIENT_ID: 'web', WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: () => sessionId, get: () => ({ credential: async () => {
      credentialsRead++;
      return { status: 'active', ...credential };
    } }) },
  } as unknown as Partial<SessionEnv>;
}
function request(headers: HeadersInit) {
  return new Request('https://site.test/_serverFn/watch', { method: 'POST', headers: {
    ...Object.fromEntries(new Headers(headers)), cookie: `__Host-rezics_session=${sessionId}`, origin: 'https://site.test',
  } });
}
const transport: ThreadWatchTransport = {
  async readThreadWatch(input) {
    serverCalls++;
    return readThreadWatchRequest(input.data, request(input.headers), environment(), kernel);
  },
  async setThreadWatch(input) {
    serverCalls++;
    return setThreadWatchRequest(input.data, request(input.headers), environment(), kernel);
  },
};
// The mounted component has no injected native prop: its actual default adapter loads this server boundary.
// Keep the real authentication/CSRF request handlers and installed generated client beneath that boundary.
mock.module('../src/threads/thread-watch-transport', () => transport);

function render(props: ThreadWatchProps = baseline) {
  act(() => root.render(<QueryClientProvider client={client}><ThreadWatch {...props} /></QueryClientProvider>));
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
function button(label: string) { return [...host.querySelectorAll('button')].find((node) => node.textContent === label); }
async function click(label: string) {
  expect(button(label)).toBeDefined();
  act(() => button(label)!.click());
  await settle();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  calls = []; serverCalls = 0; credentialsRead = 0; active = 0; maxActive = 0;
  credential = { csrfToken: csrfA, subject: 'reader-a', accessToken: 'original-access' };
  response = (call) => call.method === 'GET' ? Response.json({ watching: false }) : new Response(null, { status: 204 });
  kernel = createKernelClient('https://kernel.test', { fetch: async (input, init) => {
    const req = new Request(input, init);
    const call = { method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization'),
      key: req.headers.get('idempotency-key'), cache: req.cache, body: await req.text() };
    calls.push(call); active++; maxActive = Math.max(maxActive, active);
    try { return await response(call); } finally { active--; }
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], session());
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); client.clear(); });

test('mounted default uses generated private GET and bodyless PUT/DELETE 204 with normal current credentials', async () => {
  render(); await settle();
  expect(button(m.thread_watch_watch())).toBeDefined();
  await click(m.thread_watch_watch());
  expect(host.textContent).toContain(m.thread_watch_confirm_started());
  await click(m.thread_watch_stop());
  expect(host.textContent).toContain(m.thread_watch_confirm_stopped());
  expect(calls.map(({ method, path, cache, key, body }) => ({ method, path, cache, key, body }))).toEqual(
    ['GET', 'PUT', 'DELETE'].map((method) => ({ method, path: '/v1/threads/thread-a/watch', cache: 'no-store', key: null, body: '' })),
  );
  expect(calls.every((call) => call.authorization === 'Bearer original-access')).toBe(true);
  expect(credentialsRead).toBe(3);
  expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([['session']]);
  expect(maxActive).toBe(1);
});

test('unknown write retries original target/method/owner; failed status recovery keeps that request', async () => {
  render(); await settle();
  response = () => { throw new TypeError('connection lost'); };
  await click(m.thread_watch_watch());
  expect(host.textContent).toContain(m.thread_watch_outcome_unknown());
  await click(m.thread_watch_check_again());
  expect(host.textContent).toContain(m.thread_watch_read_failed());
  const retry = button(m.thread_watch_retry_exact())!;
  act(() => { retry.click(); retry.click(); }); await settle();
  expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT', 'GET', 'PUT']);
  expect(calls.every((call) => call.path === '/v1/threads/thread-a/watch' && call.authorization === 'Bearer original-access')).toBe(true);
  response = () => Response.json({ watching: true });
  await click(m.thread_watch_check_again());
  expect(host.textContent).toContain(m.thread_watch_watching());
  expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
  expect(button(m.thread_watch_retry_exact())).toBeUndefined();
});

test('malformed status, native refusal and access loss never fabricate a confirmed setting', async () => {
  response = () => Response.json({ watching: false, revision: 'foreign' });
  render(); await settle();
  expect(host.textContent).toContain(m.thread_watch_read_failed());
  response = () => Response.json({ watching: true });
  await click(m.thread_watch_check_again());
  response = () => Response.json({ code: 'rate_limited' }, { status: 429 });
  await click(m.thread_watch_stop());
  expect(host.textContent).toContain(m.thread_watch_unavailable());
  expect(button(m.thread_watch_retry_exact())).toBeUndefined();
  response = () => Response.json({ code: 'forbidden' }, { status: 403 });
  await click(m.thread_watch_check_again());
  expect(host.textContent).toContain(m.thread_watch_access_lost());
  expect(button(m.thread_watch_watch())).toBeUndefined();
});

for (const change of ['token', 'away-back', 'readiness', 'target', 'source', 'access', 'unmount'] as const) {
  test(`${change} irreversibly retires an in-flight response and old action callbacks`, async () => {
    render(); await settle();
    const oldButton = button(m.thread_watch_watch())!;
    const pending = deferred<Response>();
    response = () => pending.promise;
    act(() => { oldButton.click(); oldButton.click(); });
    await settle();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    // Replacement visits use their own status read, never the old command response.
    response = () => Response.json({ watching: false });
    act(() => {
      if (change === 'token') {
        credential = { ...credential, csrfToken: csrfB, accessToken: 'replacement-access' };
        client.setQueryData(['session'], session(csrfB));
      } else if (change === 'away-back') {
        client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
        client.setQueryData(['session'], session());
      } else if (change === 'readiness') client.setQueryData(['session'], { state: 'unknown', csrfToken: null });
    });
    if (change === 'target') render({ ...baseline, threadId: 'thread-b' });
    if (change === 'source') render({ ...baseline, readAuthority: {} });
    if (change === 'access') render({ ...baseline, admitted: false });
    if (change === 'unmount') act(() => root.render(null));
    await settle();
    pending.resolve(new Response(null, { status: 204 })); await settle();
    act(() => oldButton.click()); await settle();
    expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
    if (change === 'token') {
      await click(m.thread_watch_watch());
      expect(calls.at(-1)?.authorization === 'Bearer replacement-access').toBe(true);
    }
  });
}

test('retirement during dynamic import dispatches nothing and cannot borrow replacement credentials', async () => {
  const loaded = deferred<ThreadWatchTransport>();
  const native = createThreadWatchNative(() => loaded.promise);
  render({ ...baseline, native }); await settle();
  act(() => client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null }));
  await settle();
  loaded.resolve(transport); await settle();
  expect(serverCalls).toBe(0);
  credential = { ...credential, csrfToken: csrfB, accessToken: 'replacement-access' };
  act(() => client.setQueryData(['session'], session(csrfB))); await settle();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.authorization === 'Bearer replacement-access').toBe(true);
});

for (const visits of [1, 10, 100]) {
  test(`${visits} sequential retired visits add one private read each and retain one subscription`, async () => {
    const cache = client.getQueryCache();
    const subscribe = cache.subscribe.bind(cache);
    let subscriptions = 0;
    let maximum = 0;
    cache.subscribe = (listener) => {
      subscriptions++; maximum = Math.max(maximum, subscriptions);
      const unsubscribe = subscribe(listener);
      return () => { subscriptions--; unsubscribe(); };
    };
    for (let visit = 0; visit < visits; visit++) {
      render({ ...baseline, threadId: `thread-${visit}`, readAuthority: {} }); await settle();
      expect(button(m.thread_watch_watch())).toBeDefined();
    }
    act(() => root.render(null)); await settle();
    expect(calls).toHaveLength(visits);
    expect(calls.every((call) => call.method === 'GET' && call.path.endsWith('/watch'))).toBe(true);
    expect(serverCalls).toBe(visits); expect(maxActive).toBe(1);
    expect(subscriptions).toBe(0); expect(maximum).toBe(1);
    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });
}

test('anonymous/SSR have no watch reads; generated-method absence is an unavailable seam; CSRF fences old owner', async () => {
  renderToString(<QueryClientProvider client={client}><ThreadWatch {...baseline} /></QueryClientProvider>);
  render({ ...baseline, session: 'signed-out', viewerId: undefined }); await settle();
  expect(serverCalls).toBe(0);
  expect(host.querySelector('a')?.getAttribute('href')).toContain('return_to');
  expect(nativeThreadWatch({ threads: () => ({}) } as unknown as KernelClient, 'thread-a')).toBeUndefined();
  credential = { ...credential, csrfToken: csrfB };
  const before = calls.length;
  let rejected = false;
  try { await transport.setThreadWatch({ data: { threadId: 'thread-a', viewerId: 'reader-a', watching: true }, headers: { 'X-CSRF-Token': csrfA } }); }
  catch { rejected = true; }
  expect(rejected).toBe(true);
  expect(calls).toHaveLength(before);
});

afterAll(async () => {
  await browser.happyDOM.waitUntilComplete(); await browser.happyDOM.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
