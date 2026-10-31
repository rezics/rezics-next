import { describe, expect, mock, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { getServerAsyncLocalStorage, locales, overwriteServerAsyncLocalStorage } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

// Controlled transport boundaries exercise the installed session query, without a native service or database.
let requests = 0;
let requestFails = false;
let nativeRead: () => Promise<boolean | { signedIn: boolean; subject: string; csrfToken: string }> = async () => false;
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => {
    requests++;
    if (requestFails) throw new Error('initial session transport failed');
    return new Request('https://site.test/fr/settings?from=account#display', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  },
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'settings-recovery-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ signedIn: () => nativeRead() }) },
  },
}));

const { sessionQuery } = await import('../src/session/query');
const { SettingsPageView, SettingsSessionRecovery, retrySettingsSession } = await import('../src/settings/settings-page');
type PageProps = Parameters<typeof SettingsPageView>[0];
type Session = NonNullable<PageProps['requestSession']>;
const prepared: PageProps['page'] = {
  signedIn: true,
  accountId: 'current-viewer',
  preferences: { spoilerLevel: 2, suitability: 'show', version: 37 },
  notifications: { reply: false, mention: true },
  csrfToken: 'old-loader-token',
  securityHref: 'https://auth.test/security',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

async function pageMarkup(client: QueryClient, requestSession?: Session, path = '/fr/settings?from=account#display') {
  const root = createRootRoute({
    component: () => createElement(SettingsPageView, {
      page: prepared,
      csrfToken: 'ignored-prop',
      ...(requestSession ? { requestSession } : {}),
    }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
}
const fallback = (props: Parameters<typeof SettingsSessionRecovery>[0]) =>
  renderToStaticMarkup(createElement(SettingsSessionRecovery, props));
const retryButtons = (html: string) => html.match(new RegExp(`<button\\b[^>]*>${m.settings_retry()}</button>`, 'g')) ?? [];
const noPrivateSections = (html: string) => {
  expect(html).not.toMatch(/id="(?:reading|notifications|privacy|verification|profile|public-activity)"/);
  expect(html).not.toMatch(/name="(?:csrf_token|expectedVersion|idempotencyKey)"/);
  expect(html).not.toContain('/auth/sign-out');
  expect(html).not.toContain('old-loader-token');
};

describe('Recover Settings after an initial session read failure without weakening native identity, exact recovery or draft invariants', () => {
  test('pending and hydration remain neutral; settled errors and unavailable sessions offer one localized explicit retry with Display retained', async () => {
    const previous = getServerAsyncLocalStorage();
    const storage = new AsyncLocalStorage<{ locale: (typeof locales)[number] }>();
    overwriteServerAsyncLocalStorage(storage);
    try {
      for (const locale of locales) {
        await storage.run({ locale }, async () => {
          for (const sessionRead of [undefined, { status: 'pending', fetchStatus: 'fetching' }] as const) {
            const html = fallback({ state: 'unknown', sessionRead, onRetry() {} });
            expect(html).toContain('role="status" aria-busy="true"');
            expect(html).toContain(m.settings_sections_loading());
            expect(html).toContain(m.settings_display_heading());
            expect(retryButtons(html)).toHaveLength(0);
            noPrivateSections(html);
          }
          const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
          expect(m.settings_session_unavailable()).toBe(catalog.settings_session_unavailable);
          for (const state of ['unknown', 'unavailable'] as const) {
            for (const retrying of [false, true]) {
              const html = fallback({
                state,
                sessionRead: { status: 'error', fetchStatus: retrying ? 'fetching' : 'idle' },
                retrying,
                onRetry() {},
              });
              expect(html).toContain(m.settings_session_unavailable());
              expect(html).toContain(m.settings_display_heading());
              const buttons = retryButtons(html);
              expect(buttons).toHaveLength(1);
              expect(buttons[0]!.includes('disabled=""')).toBe(retrying);
              noPrivateSections(html);
            }
          }
        });
      }
    } finally {
      overwriteServerAsyncLocalStorage(previous);
    }
  });

  test('a rejected initial read and failed retry stay actionable; concurrent retries coalesce through route invalidation and signed-out recovery', async () => {
    const client = new QueryClient();
    const before = requests;
    let invalidations = 0;
    const route = deferred<void>();
    const invalidate = async () => {
      invalidations++;
      expect(client.getQueryData(sessionQuery.queryKey)?.state).toBe('signed-out');
      await route.promise;
    };
    requestFails = true;
    try {
      await expect(client.fetchQuery(sessionQuery)).rejects.toThrow('initial session transport failed');
      expect(requests - before).toBe(1);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(retrySettingsSession(client, invalidate)).rejects.toThrow('initial session transport failed');
        const html = fallback({ state: 'unknown', sessionRead: client.getQueryState(sessionQuery.queryKey), onRetry() {} });
        expect(retryButtons(html)).toHaveLength(1);
        expect(retryButtons(html)[0]).not.toContain('disabled');
      }
      expect(requests - before).toBe(3);
      expect(invalidations).toBe(0);
      requestFails = false;
      const read = deferred<boolean>();
      nativeRead = () => read.promise;
      const retry = retrySettingsSession(client, invalidate);
      expect(retrySettingsSession(client, invalidate)).toBe(retry);
      expect(client.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
      expect(client.getQueryData(sessionQuery.queryKey)).toBeUndefined();
      read.resolve(false);
      // Wait for the shared read to finish while the guarded route remains pending.
      await client.fetchQuery(sessionQuery);
      expect(retrySettingsSession(client, invalidate)).toBe(retry);
      route.resolve();
      await retry;
      expect(requests - before).toBe(4);
      expect(invalidations).toBe(1);
      const html = await pageMarkup(client, client.getQueryData(sessionQuery.queryKey));
      expect(html).toContain('/auth/sign-in?return_to=%2Ffr%2Fsettings%3Ffrom%3Daccount%23display');
      expect(retryButtons(html)).toHaveLength(0);
      noPrivateSections(html);
      expect(client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([sessionQuery.queryKey]);
      expect(sessionQuery.retry).toBe(false);
      expect(sessionQuery.staleTime).toBe(Infinity);
      expect(sessionQuery.refetchOnWindowFocus).toBe(false);
      expect(sessionQuery.refetchOnReconnect).toBe(false);
    } finally {
      requestFails = false;
      client.clear();
    }
  });

  test('native unavailability and missing identity never start private page recovery; a fresh current viewer uses its real subject and token', async () => {
    const client = new QueryClient();
    const before = requests;
    let invalidations = 0;
    const invalidate = async () => {
      invalidations++;
    };
    try {
      nativeRead = async () => {
        throw new Error('native session unavailable');
      };
      await client.fetchQuery(sessionQuery);
      expect(client.getQueryData(sessionQuery.queryKey)?.state).toBe('unavailable');
      await retrySettingsSession(client, invalidate);
      expect(requests - before).toBe(2); // Infinity freshness does not turn Retry into a cache hit.
      expect(invalidations).toBe(0);
      nativeRead = async () => true;
      await retrySettingsSession(client, invalidate);
      expect(invalidations).toBe(0);
      nativeRead = async () => ({ signedIn: true, subject: 'other-viewer', csrfToken: 'other-token' });
      await retrySettingsSession(client, invalidate);
      const other = await pageMarkup(client, client.getQueryData(sessionQuery.queryKey));
      noPrivateSections(other);
      nativeRead = async () => ({ signedIn: true, subject: 'current-viewer', csrfToken: 'current-token' });
      await retrySettingsSession(client, invalidate);
      const current = await pageMarkup(client, client.getQueryData(sessionQuery.queryKey));
      expect(current).toContain('id="reading"');
      expect(current).toContain('id="notifications"');
      expect(current).toContain('name="csrf_token" value="current-token"');
      expect(current).not.toContain('old-loader-token');
      expect(current).not.toContain('other-token');
      expect(current).not.toContain('ignored-prop');
      expect(invalidations).toBe(2);
      expect(requests - before).toBe(5);
      expect(client.isFetching()).toBe(0); // Rendering adds no session, preferences or capability request.
    } finally {
      client.clear();
    }
  });

  test('server rendering retains the request-session guard and managed navigation without private reads or a second retry', async () => {
    const client = new QueryClient();
    const before = requests;
    try {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'current-viewer', csrfToken: 'cached-token' });
      const hydration = await pageMarkup(client);
      expect(hydration).toContain(m.settings_sections_loading());
      expect(hydration).toContain(m.settings_display_heading());
      noPrivateSections(hydration);
      expect(hydration).not.toContain('cached-token');
      const html = await pageMarkup(client, { state: 'unavailable', csrfToken: null },
        '/fr/settings?managedAccount=019a0000-0000-7000-8000-000000000002&view=accounts#account');
      expect(html).toContain(m.settings_session_unavailable());
      expect(html).toContain(m.managed_detail_title());
      expect(html).toContain('/fr/settings?view=accounts#account');
      expect(retryButtons(html)).toHaveLength(1);
      noPrivateSections(html);
      expect(client.isFetching()).toBe(0);
      expect(requests).toBe(before);
    } finally {
      client.clear();
    }
  });
});
