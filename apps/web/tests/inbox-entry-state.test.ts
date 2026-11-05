import { describe, expect, mock, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { getServerAsyncLocalStorage, locales, overwriteServerAsyncLocalStorage } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';

// Exercise the shared server read with controlled request/native-session boundaries, without a server or database.
let requests = 0;
let requestFails = false;
let nativeRead: () => Promise<boolean | { signedIn: boolean; subject: string; csrfToken: string }> = async () => false;
const headers: string[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => {
    requests++;
    if (requestFails) throw new Error('session read failed');
    return new Request('https://site.test/en/inbox', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  },
  setResponseHeader: (name: string, value: string) => headers.push(`${name}: ${value}`),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'entry-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ signedIn: () => nativeRead() }) },
  },
}));

const { sessionQuery } = await import('../src/session/query');
const { InboxEntryState, retryInboxSession } = await import('../src/inbox/inbox-entry-state');
const { currentInboxViewer, inboxViewerStore, forInboxViewer, inboxEntryState } =
  await import('../src/inbox/inbox-viewer');
const { inboxPageQuery, unreadCountQueryFor, markInboxViewerSeen } = await import('../src/inbox/inbox-query');
type EntryProps = Parameters<typeof InboxEntryState>[0];

async function eachLocale(check: (locale: (typeof locales)[number]) => Promise<void>) {
  const previous = getServerAsyncLocalStorage();
  const storage = new AsyncLocalStorage<{ locale: (typeof locales)[number] }>();
  overwriteServerAsyncLocalStorage(storage);
  try {
    for (const locale of locales) await storage.run({ locale }, () => check(locale));
  } finally {
    overwriteServerAsyncLocalStorage(previous);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

async function markup(props: EntryProps, path = '/en/inbox', client = new QueryClient()) {
  const root = createRootRoute({ component: () => createElement(InboxEntryState, props) });
  const child = createRoute({ getParentRoute: () => root, path: '$' });
  const router = createRouter({
    routeTree: root.addChildren([child]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
  );
}

describe('Offer actionable sign-in and session recovery on Inbox preserving native privacy and current viewer boundaries', () => {
  test('sign-in uses the shared Auth entry and the current relative locale, search and fragment in every launch locale', async () => {
    await eachLocale(async (locale) => {
      const returnTo = `/${locale}/inbox?from=header&filter=unread#latest`;
      const html = await markup({ state: 'signed-out' }, returnTo);
      expect(html).toContain(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
      expect(html).toContain(m.inbox_sign_in());
      expect(html.match(/<a\b/g)).toHaveLength(1);
      expect(html).not.toContain('<button');
      expect(html).not.toContain('<main');
    });
  });

  test('unknown hydration stays neutral, while settled failures offer one localized Retry disabled during a read', async () => {
    await eachLocale(async (locale) => {
      for (const sessionRead of [undefined, { status: 'pending', fetchStatus: 'fetching' }] as const) {
        const html = await markup({ state: 'unknown', sessionRead });
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-busy="true"');
        expect(html).toContain(m.inbox_loading());
        expect(html).not.toContain('<a');
        expect(html).not.toContain('<button');
      }
      const catalog = JSON.parse(await readFile(new URL(`../messages/${locale}.json`, import.meta.url), 'utf8'));
      expect(m.inbox_session_unavailable()).toBe(catalog.inbox_session_unavailable);
      for (const state of ['unavailable', 'unknown'] as const) {
        for (const fetchStatus of ['idle', 'fetching'] as const) {
          const html = await markup({ state, sessionRead: { status: 'error', fetchStatus } });
          expect(html).toContain(m.inbox_session_unavailable());
          expect(html).toContain(m.inbox_retry());
          expect(html.match(/<button\b/g)).toHaveLength(1);
          expect(html.includes('disabled=""')).toBe(fetchStatus === 'fetching');
          expect(html).not.toContain('<a');
          expect(html).not.toContain(m.inbox_empty());
        }
      }
    });
  });

  test('a rejected initial read and failed explicit retry stay recoverable; one pending server read deduplicates and can resolve signed out', async () => {
    const client = new QueryClient();
    const before = requests;
    requestFails = true;
    try {
      const initial = client.fetchQuery(sessionQuery);
      expect(inboxEntryState('unknown', client.getQueryState(sessionQuery.queryKey))).toBe('loading');
      await expect(initial).rejects.toThrow('session read failed');
      expect(inboxEntryState('unknown', client.getQueryState(sessionQuery.queryKey))).toBe('unavailable');
      expect(requests - before).toBe(1);
      expect(currentInboxViewer(client)).toBeNull();
      await expect(retryInboxSession(client)).rejects.toThrow('session read failed');
      expect(requests - before).toBe(2);
      expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
      expect(sessionQuery.retry).toBe(false);
      expect(sessionQuery.refetchOnWindowFocus).toBe(false);
      expect(sessionQuery.refetchOnReconnect).toBe(false);

      requestFails = false;
      const pending = deferred<boolean>();
      nativeRead = () => pending.promise;
      const retry = retryInboxSession(client);
      const duplicate = retryInboxSession(client);
      expect(client.getQueryState(sessionQuery.queryKey)?.fetchStatus).toBe('fetching');
      expect(currentInboxViewer(client)).toBeNull();
      expect(unreadCountQueryFor(currentInboxViewer(client)).enabled).toBe(false);
      pending.resolve(false);
      await Promise.all([retry, duplicate]);
      expect(requests - before).toBe(3);
      const session = client.getQueryData(sessionQuery.queryKey)!;
      expect(session.state).toBe('signed-out');
      expect(inboxEntryState(session.state, client.getQueryState(sessionQuery.queryKey))).toBe('signed-out');
      expect(
        client
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toEqual([sessionQuery.queryKey]);
      expect(headers).toContain('Cache-Control: private, no-store');
    } finally {
      requestFails = false;
      client.clear();
    }
  });

  test('native unavailable is explicitly reread despite infinite freshness, and only a recovered current viewer can read or mark', async () => {
    const client = new QueryClient();
    const store = inboxViewerStore(client);
    const unsubscribe = store.subscribe(() => {});
    let privateReads = 0;
    const before = requests;
    try {
      nativeRead = async () => {
        throw new Error('native session unavailable');
      };
      const unavailable = await client.fetchQuery(sessionQuery);
      expect(unavailable.state).toBe('unavailable');
      expect(inboxEntryState(unavailable.state, client.getQueryState(sessionQuery.queryKey))).toBe('unavailable');
      expect(await retryInboxSession(client)).toMatchObject({ state: 'unavailable' });
      expect(requests - before).toBe(2);
      expect(store.snapshot()).toBeNull();
      expect(privateReads).toBe(0);

      nativeRead = async () => ({ signedIn: true, subject: 'alice', csrfToken: 'same-token' });
      await retryInboxSession(client);
      const alice = store.snapshot()!;
      expect(alice.subject).toBe('alice');
      const oldPageKey = inboxPageQuery(alice, 'old-cursor').queryKey;
      const oldBadgeKey = unreadCountQueryFor(alice).queryKey;
      client.setQueryData(oldPageKey, {
        signedIn: true,
        state: 'ready',
        items: [{ text: 'old private row' }],
        next: 'old-next',
      });
      client.setQueryData(oldBadgeKey, {
        signedIn: true,
        state: 'ready',
        count: 7,
        capped: false,
        basis: 'current-visible-unread',
        witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
      });
      for (const state of ['unknown', 'signed-out', 'unavailable'] as const) {
        const sessionKey: readonly unknown[] = sessionQuery.queryKey;
        client.setQueryData(sessionKey, { state, subject: null, csrfToken: 'same-token' });
        expect(store.snapshot()).toBeNull();
        expect(unreadCountQueryFor(store.snapshot()).enabled).toBe(false);
        await expect(forInboxViewer(alice, async () => ++privateReads)).rejects.toThrow('Inbox viewer changed');
        await expect(
          markInboxViewerSeen(
            client,
            alice,
            { through: 'old-row', idempotencyKey: 'old-intent' },
            'same-token',
            async () => {
              privateReads++;
              return { signedIn: true };
            },
          ),
        ).rejects.toThrow('Inbox viewer changed');
      }
      expect(privateReads).toBe(0);
      await retryInboxSession(client);
      const recovered = store.snapshot()!;
      expect(recovered.subject).toBe('alice');
      expect(recovered.epoch).not.toBe(alice.epoch);
      expect(client.getQueryData(inboxPageQuery(recovered, 'old-cursor').queryKey)).toBeUndefined();
      expect(client.getQueryData(unreadCountQueryFor(recovered).queryKey)).toBeUndefined();
      expect(alice.isCurrent()).toBe(false);
      await client.fetchQuery(
        inboxPageQuery(recovered, undefined, async () => {
          privateReads++;
          return { signedIn: true, state: 'ready', items: [], next: null };
        }),
      );
      expect(privateReads).toBe(1);
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
