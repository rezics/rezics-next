import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { afterAll, afterEach, beforeAll, mock } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
const { Window } = require(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`))),
);
let currentSignal: AbortSignal | undefined;
const nativeEnv = { AUTH_SECURITY_SCOPE_CONFIGURATION: 'catalogue:20' };
// Start's compiled RPC bridge validates input; the fixture forwards the value unchanged.
type ServerFnInput = { data?: unknown; signal?: AbortSignal | undefined };
type ServerFnBuilder = {
  validator(validate: unknown): ServerFnBuilder;
  handler(handler: (context: ServerFnInput) => unknown): (options?: ServerFnInput) => unknown;
};
function serverFn(): ServerFnBuilder {
  const builder: ServerFnBuilder = {
    validator: () => builder,
    handler: (handler) => (options) => {
      currentSignal = options?.signal;
      return handler({ data: options?.data, signal: options?.signal });
    },
  };
  return builder;
}
mock.module('@tanstack/react-start', () => ({
  createServerFn: () => serverFn(),
  createServerOnlyFn: <T extends (...args: never[]) => unknown>(handler: T) => handler,
}));
mock.module('cloudflare:workers', () => ({ env: nativeEnv }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () =>
    new Request('https://auth.test/_serverFn/session', {
      headers: { origin: 'https://auth.test', cookie: 'auth_session=original' },
      ...(currentSignal ? { signal: currentSignal } : {}),
    }),
  setResponseHeader() {},
}));
(globalThis as { __AUTH_ORIGIN__?: string }).__AUTH_ORIGIN__ = '';
export const dom = new Window({ url: 'https://auth.test/organizations/new' });
const previous = new Map<string, PropertyDescriptor | undefined>();
const globals = Object.fromEntries(
  [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'Event',
    'HTMLInputElement',
    'Element',
    'Node',
    'NodeFilter',
    'MutationObserver',
    'ResizeObserver',
  ].map((key) => [key, (dom as unknown as Record<string, unknown>)[key]]),
);
Object.assign(globals, {
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: globalThis.fetch,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
});
for (const [key, value] of Object.entries(globals)) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// Bun does not compile Start's server-function bridge. Keep the native session
// parser/byte reader while supplying the test's local issuer transport.
const nativeSession = await import('../src/account-session');
const { readJsonBounded } = await import('../src/private-auth-json');
const { securityResponseByteBudgets, securityScopeLimit } = await import('@rezics/auth-contract');
mock.module('../src/account-session', () => ({
  ...nativeSession,
  requestAccountSession: async (signal: AbortSignal) => {
    const response = await fetch('/session', { signal });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status !== 200) return { kind: 'failure' };
    return nativeSession.parseAccountSession(
      await readJsonBounded(response, securityResponseByteBudgets(securityScopeLimit()).session, signal),
      securityScopeLimit(),
    );
  },
}));
// Load DOM-aware UI modules only after installing the browser fixture.
export const { fill, button, session } = await import('../src/stories/accounts-operations/story');
const { createRoot } = await import('react-dom/client');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');
export const flush = (action: () => void) => act(async () => action());
let close: (() => Promise<void>) | undefined;
export function creationFixture() {
  beforeAll(() => {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  });
  afterEach(async () => {
    await close?.();
    close = undefined;
    document.body.replaceChildren();
    window.sessionStorage.clear();
  });
  afterAll(async () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}
export async function open(page: ReactNode, sessionBody: object) {
  const calls: { path: string; body: any; resolve: (response: Response) => void }[] = [];
  globalThis.fetch = ((path, init) => {
    const requestPath = new URL(String(path), 'https://auth.test').pathname;
    if (requestPath === '/signin/page')
      return Promise.resolve(
        Response.json({
          methods: { password: true, passkey: true },
          viewer: { kind: 'signed-out' },
          continuation: { href: '/security', requires_sign_in: false },
        }),
      );
    if (requestPath === '/recovery/page')
      return Promise.resolve(
        Response.json(
          recoveryPage(JSON.parse(String(init?.body)).stage, { minPasswordLength: 8, maxPasswordLength: 128 }),
        ),
      );
    if (requestPath === '/account-management/automated/operator') {
      const { operatorAccountId } = JSON.parse(String(init?.body));
      const saved = JSON.parse(window.sessionStorage.getItem('rezics.automated-create.attempt') ?? 'null');
      if (operatorAccountId === null || saved?.operator.id === operatorAccountId) {
        const session = sessionBody as { account_id: string; client_id: string; scope: string[] };
        const ordinary =
          session.client_id !== 'rezics-auth-account-management' || !session.scope.includes('account:manage');
        const readiness = ordinary ? 'authentication-needed' : operatorAccountId ? 'review' : 'select-operator';
        return Promise.resolve(
          Response.json({
            viewer: { accountId: session.account_id },
            readiness,
            operator: readiness === 'review' ? saved.operator : null,
            handleRules: {
              minLength: 3,
              maxLength: 64,
              normalization: 'lowercase',
              pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
            },
            action: ordinary ? 'authenticate' : operatorAccountId ? 'confirm' : 'select-operator',
          }),
        );
      }
    }
    if (['/session', '/account-management/deletion-page'].includes(requestPath))
      return Promise.resolve(Response.json(sessionBody));
    const request = Promise.withResolvers<Response>();
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)), resolve: request.resolve });
    return request.promise;
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = (next: ReactNode) => flush(() => root.render(next));
  close = () => flush(() => root.unmount());
  await render(page);
  return { host, calls, render };
}
export const send = (host: HTMLElement) => host.querySelector<HTMLFormElement>('form')!.requestSubmit();
export const leave = () => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
export const approval = () =>
  Response.json({ reference: 'bmF0aXZl.' + 'a'.repeat(43), expiresAt: new Date(Date.now() + 60000).toISOString() });

/** Closed native selected-page fixture; identity remains admitted presentation only. */
export const automatedOperatorPage = (accountId: string, operator: object) =>
  Response.json({
    viewer: { accountId },
    readiness: 'review',
    operator,
    handleRules: {
      minLength: 3,
      maxLength: 64,
      normalization: 'lowercase',
      pattern: '[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]',
    },
    action: 'confirm',
  });
