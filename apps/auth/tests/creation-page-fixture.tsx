import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { afterAll, afterEach, beforeAll, mock, spyOn } from 'bun:test';
import { dirname } from 'node:path';
import { act, useLayoutEffect, type ReactNode } from 'react';
const { Window } = require(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`))),
);
// Base UI may have been loaded by a preceding SSR test. Use the browser hook
// for mounted tests even when Bun has cached the server-side module.
const baseUi = Bun.resolveSync('@base-ui/react/alert-dialog', `${import.meta.dir}/../../../packages/ui`);
mock.module(Bun.resolveSync('@base-ui/utils/useIsoLayoutEffect', dirname(baseUi)), () => ({
  useIsoLayoutEffect: useLayoutEffect,
}));
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
  __AUTH_ORIGIN__: '',
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: globalThis.fetch,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  getComputedStyle: dom.getComputedStyle.bind(dom),
  scrollTo: dom.scrollTo.bind(dom),
});
for (const [key, value] of Object.entries(globals)) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
// Mounted tests exercise browser session reads through their local transport.
const nativeSession = await import('../src/account-session');
const { readJsonBounded } = await import('../src/private-auth-json');
const { securityResponseByteBudgets, securityScopeLimit } = await import('@rezics/auth-contract');
const readBrowserSession: typeof nativeSession.requestAccountSession = async (signal) => {
  const response = await fetch('/session', { signal, credentials: 'same-origin', cache: 'no-store' });
  if (response.status === 401) return { kind: 'signed-out' };
  if (response.status !== 200) return { kind: 'failure' };
  return nativeSession.parseAccountSession(
    await readJsonBounded(response, securityResponseByteBudgets(securityScopeLimit()).session, signal),
    securityScopeLimit(),
  );
};
// Load DOM-aware UI modules only after installing the browser fixture.
export const { fill, button, session } = await import('../src/stories/accounts-operations/story');
const { createRoot } = await import('react-dom/client');
const localeRuntime = await import('../src/paraglide/runtime.js');
export const flush = (action: () => void) => act(async () => action());
// Dialog focus and removal can finish on the frame after React commits.
export const flushFrame = () =>
  act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
const roots = new Set<ReturnType<typeof createRoot>>();
function installBrowser() {
  localeRuntime.overwriteGetLocale(() => 'en');
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
export function creationFixture() {
  // A cached fixture module may follow a file whose afterAll restored the host realm.
  // Install now as well as in the hook: document-level setup runs during file evaluation.
  const previousLocale = localeRuntime.getLocale;
  let sessionRead: { mockRestore(): void } | undefined;
  installBrowser();
  beforeAll(() => {
    installBrowser();
    sessionRead = spyOn(nativeSession, 'requestAccountSession').mockImplementation(readBrowserSession);
  });
  afterEach(async () => {
    try {
      await flush(() => {
        for (const root of roots) root.unmount();
      });
    } finally {
      roots.clear();
      document.body.replaceChildren();
      window.sessionStorage.clear();
      globalThis.fetch = globals.fetch;
    }
  });
  afterAll(() => {
    sessionRead?.mockRestore();
    localeRuntime.overwriteGetLocale(previousLocale);
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
}
export async function open(page: ReactNode, sessionBody: object) {
  const calls: { path: string; body: any; resolve: (response: Response) => void }[] = [];
  const sessionReads: { method: string; cookie: string | null }[] = [];
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
      const saved =
        operatorAccountId === null
          ? null
          : JSON.parse(window.sessionStorage.getItem('rezics.automated-create.attempt') ?? 'null');
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
    if (requestPath === '/session') {
      sessionReads.push({ method: init?.method ?? 'GET', cookie: new Headers(init?.headers).get('cookie') });
      return Promise.resolve(Response.json(sessionBody));
    }
    if (requestPath === '/account-management/deletion-page') return Promise.resolve(Response.json(sessionBody));
    const request = Promise.withResolvers<Response>();
    calls.push({ path: String(path), body: JSON.parse(String(init?.body)), resolve: request.resolve });
    return request.promise;
  }) as typeof fetch;
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  const render = (next: ReactNode) => flush(() => root.render(next));
  // Own the root before rendering, including a render that rejects during setup.
  roots.add(root);
  await render(page);
  return { host, calls, render, sessionReads };
}
export const send = (host: HTMLElement) => host.querySelector<HTMLFormElement>('form')!.requestSubmit();
export const leave = () => window.dispatchEvent(new dom.Event('pagehide') as unknown as Event);
export const nativeApprovalReference = 'bmF0aXZl.' + 'a'.repeat(43);
export const approval = () =>
  Response.json({ reference: nativeApprovalReference, expiresAt: new Date(Date.now() + 60000).toISOString() });

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

export async function chooseLocale(host: HTMLElement, value: string) {
  await flush(() => host.querySelector<HTMLButtonElement>('.auth-locale-choice [role=combobox]')!.click());
  await flush(() => document.querySelector<HTMLElement>(`[role=option][lang="${value}"]`)!.click());
}
