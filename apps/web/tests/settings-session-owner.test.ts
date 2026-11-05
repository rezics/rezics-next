import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';
import { settingsPreferencePage } from '../src/kernel/fake/settings-notifications';
import { NotificationEditor } from '../src/settings/notification-recovery';
import { CollectionPrivacyEditor, CollectionPrivacyPager } from '../src/settings/collection-privacy-recovery';
import {
  VerificationRecovery,
  verificationQueryKey,
  type VerificationSnapshot,
} from '../src/settings/verification-recovery';
import { readingMutation, sendReading } from '../src/settings/reading-preferences';
import type {
  CollectionVisibilityWrite,
  OwnedCollection,
  PreferenceWriteResult,
  NotificationWriteResult,
  SettingsPage,
} from '../src/settings/preferences';
import type { VerificationCommandResult } from '../src/settings/verification-core';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    throw new Error('Unexpected session read');
  },
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { SettingsSessionOwner } = await import('../src/settings/settings-session-owner');
const { accountPreferenceIO, SettingsPageView } = await import('../src/settings/settings-page');
const { collectionPrivacyIO } = await import('../src/settings/collection-privacy');
const { verificationRecoveryIO } = await import('../src/settings/verification');
const { SettingsNavigationDrafts } = await import('../src/settings/reading-navigation');
const { m } = await import('../src/paraglide/messages.js');

const identity = { state: 'signed-in' as const, subject: 'alice', csrfToken: 'original-token' };
const notifications = { reply: true, mention: false, thread_watch: true, board_activity: true };
const page = {
  signedIn: true as const,
  accountId: 'alice',
  securityHref: null,
  preferences: { spoilerLevel: 2 as const, suitability: 'show' as const, version: 4 },
  notifications,
  page: settingsPreferencePage(notifications, 4),
};
const collection: OwnedCollection = {
  id: 'owned',
  title: 'Reading',
  kind: 'curated',
  membershipKind: 'curated',
  visibility: 'private',
  revision: 7,
  allowedVisibilityActions: ['unlisted', 'public'],
};
const empty: VerificationSnapshot = {
  accountId: 'alice',
  verificationRequest: null,
  viewerActions: [{ action: 'account:update', operations: ['account.request_verification'] }],
  subjectTitle: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, identity);
  const owner = new SettingsSessionOwner(client, identity.csrfToken, identity.subject);
  const release = owner.mount();
  return {
    client,
    owner,
    release,
    close() {
      release();
      owner.retire();
      client.clear();
    },
  };
}
const transitions = {
  'retained data on query error': (client: QueryClient) => {
    client
      .getQueryCache()
      .find({ queryKey: sessionQuery.queryKey })!
      .setState({ status: 'error', error: new Error('session failed') });
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(identity);
  },
  'synchronous subject away and back': (client: QueryClient) => {
    client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob' });
    client.setQueryData(sessionQuery.queryKey, identity);
  },
  'synchronous signed-out and back': (client: QueryClient) => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    client.setQueryData(sessionQuery.queryKey, identity);
  },
  'token rotation and back': (client: QueryClient) => {
    client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: 'rotated-token' });
    client.setQueryData(sessionQuery.queryKey, identity);
  },
  'query removal and replacement': (client: QueryClient) => {
    client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    client.setQueryData(sessionQuery.queryKey, identity);
  },
  'unavailable and back': (client: QueryClient) => {
    client.setQueryData(sessionQuery.queryKey, { state: 'unavailable', csrfToken: null, subject: null });
    client.setQueryData(sessionQuery.queryKey, identity);
  },
};

for (const [name, transition] of Object.entries(transitions)) {
  test(
    name === 'retained data on query error'
      ? 'Retired Settings sessions cannot resume private reads writes drafts or late receipts from retained cache data'
      : `Retired Settings sessions cannot resume private reads writes drafts or late receipts from retained cache data: ${name}`,
    async () => {
      const h = setup();
      let dispatches = 0;
      let confirmed = 4;
      const preferences = accountPreferenceIO(
        'alice',
        h.owner.credential,
        (v) => {
          confirmed = v;
        },
        {
          read: async () => {
            dispatches++;
            return page;
          },
          saveReading: async () => {
            dispatches++;
            return { ok: true, preferences: page.preferences };
          },
          saveNotifications: async () => {
            dispatches++;
            return { ok: true, notifications: page.notifications, version: 5, page: page.page };
          },
        },
      );
      const row = new CollectionPrivacyEditor(
        collection,
        collectionPrivacyIO(h.owner, {
          read: async () => {
            dispatches++;
            return { ok: true, value: collection };
          },
          save: async () => {
            dispatches++;
            return { ok: false, reason: 'unavailable' };
          },
        }),
        h.owner.isCurrent,
      );
      const pager = new CollectionPrivacyPager(async () => {
        dispatches++;
        return { ok: true, value: { collections: [collection], next: 'cursor' } };
      }, h.owner.isCurrent);
      const verification = new VerificationRecovery(
        'alice',
        verificationRecoveryIO(h.owner, h.client, {
          read: async () => {
            dispatches++;
            return empty;
          },
          request: async () => {
            dispatches++;
            return { ok: false, status: 503, message: 'unknown' };
          },
          withdraw: async () => {
            dispatches++;
            return { ok: false, status: 503, message: 'unknown' };
          },
        }),
        h.owner.isCurrent,
      );
      const notification = new NotificationEditor(
        page.page,
        preferences.notifications,
        false,
        () => confirmed,
        h.owner.isCurrent,
      );
      const drafts = new SettingsNavigationDrafts();
      drafts.register({ kind: 'notifications', needsDecision: () => h.owner.isCurrent() });
      const leaving = drafts.block('/settings', '/inbox');
      const stop = h.owner.subscribe(drafts.refresh);
      try {
        transition(h.client);
        expect(h.owner.isCurrent()).toBe(false);
        expect(await leaving).toBe(false);
        await expect(preferences.reading.read()).rejects.toThrow('Settings viewer unavailable');
        expect(await preferences.reading.save({ expectedVersion: 4, spoilerLevel: 1, idempotencyKey: 'old' })).toEqual({
          ok: false,
          reason: 'forbidden',
        });
        await notification.edit('reply', false, 4);
        await notification.restore(4);
        await notification.reload();
        await row.edit('public');
        await row.reload();
        await row.retry();
        await pager.load();
        await pager.restart();
        await verification.reload();
        await verification.retry();
        await verification.withdraw(true);
        preferences.notifications.confirmed(99);
        expect(dispatches).toBe(0);
        expect(confirmed).toBe(4);
        expect(notification.snapshot().draft).toEqual(page.notifications);
        expect(row.snapshot().attempt).toBeNull();
        expect(drafts.needsDecision()).toBe(false);
        h.client.setQueryData(sessionQuery.queryKey, identity);
        const fresh = new SettingsSessionOwner(h.client, identity.csrfToken);
        const end = fresh.mount();
        expect(fresh.isCurrent()).toBe(true);
        expect(h.owner.isCurrent()).toBe(false);
        end();
        fresh.retire();
      } finally {
        stop();
        h.close();
      }
    },
  );
}

test('late Reading and Notifications receipts cannot confirm versions; exact dispatched inputs stay immutable and unresolved', async () => {
  const h = setup();
  const reading = deferred<PreferenceWriteResult>();
  const notices = deferred<NotificationWriteResult>();
  const sent: unknown[] = [];
  const tokens: string[] = [];
  let confirmations = 0;
  const io = accountPreferenceIO('alice', h.owner.credential, () => confirmations++, {
    read: async () => {
      throw new Error('A retired receipt must not trigger recovery GET');
    },
    saveReading: (input, token) => {
      sent.push(input);
      tokens.push(token);
      return reading.promise;
    },
    saveNotifications: (input, token) => {
      sent.push(input);
      tokens.push(token);
      return notices.promise;
    },
  });
  const original = readingMutation(page.preferences, { spoilerLevel: 1, suitability: 'blur' })!;
  const result = sendReading(io.reading, original, true, () => 4);
  const editor = new NotificationEditor(page.page, io.notifications, false, () => 4, h.owner.isCurrent);
  const sending = editor.edit('reply', false, 4);
  const attempt = editor.snapshot().pending!;
  const frozen = JSON.stringify(attempt);
  const before = editor.snapshot();
  try {
    transitions['token rotation and back'](h.client);
    reading.resolve({ ok: true, preferences: { spoilerLevel: 1, suitability: 'blur', version: 5 } });
    notices.resolve({
      ok: true,
      notifications: page.notifications,
      version: 5,
      page: settingsPreferencePage(page.notifications, 5),
    });
    expect(await result).toMatchObject({ kind: 'uncertain' });
    await sending;
    await editor.retry();
    editor.useCurrent();
    expect(editor.snapshot()).toBe(before);
    expect(editor.snapshot().pending).toBe(attempt);
    expect(JSON.stringify(attempt)).toBe(frozen);
    expect(Object.isFrozen(attempt.input)).toBe(true);
    expect(Object.isFrozen(attempt.input.notifications)).toBe(true);
    expect(sent).toEqual([original, attempt.input]);
    expect(tokens).toEqual(['original-token', 'original-token']);
    expect(confirmations).toBe(0);
  } finally {
    h.close();
  }
});

test('late preference and privacy page reads cannot replace old snapshots or release list reservations', async () => {
  const h = setup();
  const read = deferred<SettingsPage>();
  const list = deferred<{ ok: true; value: { collections: (typeof collection)[]; next: string | null } }>();
  let reads = 0;
  const io = accountPreferenceIO(
    'alice',
    h.owner.credential,
    () => {
      throw new Error('Late version');
    },
    {
      read: () => {
        reads++;
        return read.promise;
      },
      saveReading: async () => ({ ok: false, reason: 'unavailable' }),
      saveNotifications: async () => ({ ok: false, reason: 'unavailable' }),
    },
  );
  const editor = new NotificationEditor(page.page, io.notifications, false, () => 4, h.owner.isCurrent);
  const reload = editor.reload();
  const pager = new CollectionPrivacyPager(() => list.promise, h.owner.isCurrent);
  const load = pager.load();
  const before = editor.snapshot();
  const beforeList = pager.snapshot();
  try {
    transitions['retained data on query error'](h.client);
    read.resolve({ ...page, notifications: { reply: false }, preferences: { ...page.preferences, version: 20 } });
    list.resolve({ ok: true, value: { collections: [collection], next: 'private-cursor' } });
    await Promise.all([reload, load]);
    await editor.reload();
    await pager.restart();
    expect(editor.snapshot()).toBe(before);
    expect(pager.snapshot()).toBe(beforeList);
    expect(reads).toBe(1);
  } finally {
    h.close();
  }
});

test('privacy original retry is exact; retirement prevents late row writes and reads from clearing its reservation', async () => {
  const h = setup();
  const pending = deferred<CollectionVisibilityWrite>();
  const calls: unknown[] = [];
  const tokens: string[] = [];
  const row = new CollectionPrivacyEditor(
    collection,
    collectionPrivacyIO(h.owner, {
      read: async () => ({ ok: true, value: collection }),
      save: async (input, token) => {
        calls.push(input);
        tokens.push(token);
        if (calls.length === 1) throw new Error('lost response');
        return pending.promise;
      },
    }),
    h.owner.isCurrent,
  );
  const pager = new CollectionPrivacyPager(
    async () => ({ ok: true, value: { collections: [collection], next: 'next' } }),
    h.owner.isCurrent,
  );
  const unregister = pager.registerRow(row);
  try {
    await row.edit('public');
    const attempt = row.snapshot().attempt!;
    const bytes = JSON.stringify(attempt);
    await row.edit('unlisted');
    const retry = row.retry();
    const before = row.snapshot();
    expect(calls[1]).toBe(calls[0]);
    transitions['synchronous signed-out and back'](h.client);
    pending.resolve({ ok: true, collection: { ...collection, visibility: 'public', revision: 8 } });
    await retry;
    await row.reload();
    await pager.restart();
    expect(row.snapshot()).toBe(before);
    expect(row.snapshot().attempt).toBe(attempt);
    expect(JSON.stringify(attempt)).toBe(bytes);
    expect(tokens).toEqual(['original-token', 'original-token']);
    expect(pager.snapshot().restartBlocked).toBe(true);
  } finally {
    unregister();
    h.close();
  }
});

test('Verification original request remains immutable and a retired query cannot populate fresh-owner cache', async () => {
  const h = setup();
  const late = deferred<VerificationSnapshot>();
  const sent: unknown[] = [];
  const tokens: string[] = [];
  const transport = {
    read: async () => empty,
    request: async (
      _: string,
      input: Parameters<VerificationRecovery['submit']>[0] & { idempotencyKey: string },
      token: string,
    ): Promise<VerificationCommandResult> => {
      sent.push(input);
      tokens.push(token);
      throw new Error('lost response');
    },
    withdraw: async (): Promise<VerificationCommandResult> => {
      throw new Error('Unexpected withdrawal');
    },
  };
  const controller = new VerificationRecovery(
    'alice',
    verificationRecoveryIO(h.owner, h.client, transport),
    h.owner.isCurrent,
  );
  try {
    await controller.reload();
    await controller.submit({
      subject: 'agent',
      statement: 'Original evidence',
      links: [{ label: 'Site', url: 'https://example.test' }],
    });
    const attempt = controller.snapshot().attempt!;
    const bytes = JSON.stringify(attempt);
    await controller.retry();
    expect(sent[1]).toBe(sent[0]);
    expect(Object.isFrozen(attempt.input)).toBe(true);
    expect(Object.isFrozen((attempt.input as { links: unknown[] }).links)).toBe(true);
    const oldReader = verificationRecoveryIO(h.owner, h.client, { ...transport, read: () => late.promise });
    const pending = oldReader.read('alice').catch(() => null);
    transitions['synchronous subject away and back'](h.client);
    const fresh = new SettingsSessionOwner(h.client, identity.csrfToken);
    const release = fresh.mount();
    const current = { ...empty, subjectTitle: 'fresh status' };
    const freshReader = verificationRecoveryIO(fresh, h.client, { ...transport, read: async () => current });
    expect(await freshReader.read('alice')).toEqual(current);
    late.resolve({ ...empty, subjectTitle: 'late private status' });
    await pending;
    await controller.retry();
    await controller.reload();
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(JSON.stringify(attempt)).toBe(bytes);
    expect(sent).toHaveLength(2);
    expect(tokens).toEqual(['original-token', 'original-token']);
    expect(h.client.getQueryData(verificationQueryKey('alice'))).toEqual(current);
    release();
    fresh.retire();
  } finally {
    h.close();
  }
});

test('StrictMode reconnect keeps one lifetime; real disposal and an intervening loss cannot revive old callbacks', async () => {
  const h = setup();
  h.release();
  expect(h.owner.isCurrent()).toBe(false); // The effect replay gap cannot dispatch either.
  const reconnect = h.owner.mount();
  await Promise.resolve();
  expect(h.owner.isCurrent()).toBe(true);
  reconnect();
  await Promise.resolve();
  const afterUnmount = h.owner.mount();
  expect(h.owner.isCurrent()).toBe(false);
  await expect(h.owner.guard(async () => 'private')).rejects.toThrow('Settings viewer unavailable');
  afterUnmount();
  h.close();
});

// Actual page wiring, including its retained Reading/Notifications controllers and navigation provider.
test('the StrictMode Settings page retires synchronous away/back callbacks and recovers with a fresh owner', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings#notifications' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    HTMLFormElement: window.HTMLFormElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, identity);
  client.setQueryData(exposureQuery.queryKey, []);
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const exposureLifetime = viewerExposureLifetime(client);
  const stopExposure = exposureLifetime.subscribe(() => {});
  const exposureSnapshot = exposureLifetime.getSnapshot();
  if (exposureSnapshot.state !== 'signed-in') throw new Error('Expected a current viewer observation');
  const currentExposureKey = viewerExposureQuery(exposureSnapshot.observation).queryKey;
  client.setQueryData(currentExposureKey, { subject: 'alice', admitted: ['collections'], state: 'ready' });
  let writes = 0;
  const preferenceIO = {
    read: async () => page,
    saveReading: async (): Promise<PreferenceWriteResult> => {
      writes++;
      return { ok: false, reason: 'unavailable' };
    },
    saveNotifications: async (): Promise<NotificationWriteResult> => {
      writes++;
      return { ok: false, reason: 'unavailable' };
    },
  };
  const route = createRootRoute({
    component: () => createElement(SettingsPageView, { page, csrfToken: identity.csrfToken, preferenceIO }),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/settings#notifications'] }),
  });
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  let disposed = false;
  try {
    await act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
        ),
      );
    });
    expect(host.querySelector('#privacy')).not.toBeNull();
    expect(host.textContent).not.toContain(m.settings_sections_loading());
    await act(async () => {
      client.setQueryData(currentExposureKey, { subject: 'alice', admitted: [], state: 'denied' });
    });
    expect(host.querySelector('#privacy')).toBeNull();
    expect(host.textContent).toContain(m.settings_closed_title());
    await act(async () => {
      client.setQueryData(currentExposureKey, { subject: 'alice', admitted: [], state: 'unavailable' });
    });
    expect(host.textContent).toContain(m.settings_unavailable_title());
    const toggle = host.querySelector('[role="switch"]');
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toBe(1); // StrictMode reconnect did not retire the actual producer.
    await act(async () => {
      transitions['synchronous subject away and back'](client);
      toggle!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toBe(1);
    expect(host.textContent).toContain(m.settings_session_unavailable());
    expect(host.querySelector('[data-settings-panel]')).toBeNull();
    expect(host.querySelector('#display')).not.toBeNull();
    // A new mounted page can use the same successful observation; no old attempt is replayed.
    await act(async () => {
      root.render(null);
    });
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
    });
    const fresh = host.querySelector('[role="switch"]');
    expect(fresh).not.toBeNull();
    await act(async () => {
      fresh!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    expect(writes).toBe(2);
    await act(async () => {
      root.unmount();
      disposed = true;
    });
    fresh!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(writes).toBe(2);
  } finally {
    if (!disposed)
      await act(async () => {
        root.unmount();
      });
    host.remove();
    stopExposure();
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});

test('Verification late request settlement keeps the original unknown command and never dispatches a follow-up status read', async () => {
  const h = setup();
  const pending = deferred<VerificationCommandResult>();
  let reads = 0;
  const commands: { token: string; input: unknown }[] = [];
  const controller = new VerificationRecovery(
    'alice',
    verificationRecoveryIO(h.owner, h.client, {
      read: async () => {
        reads++;
        return empty;
      },
      request: async (_, input, token) => {
        commands.push({ input, token });
        return pending.promise;
      },
      withdraw: async () => {
        throw new Error('Unexpected withdrawal');
      },
    }),
    h.owner.isCurrent,
  );
  try {
    await controller.reload();
    const sending = controller.submit({ subject: 'agent', statement: 'Original', links: [] });
    const before = controller.snapshot();
    const attempt = before.attempt!;
    transitions['retained data on query error'](h.client);
    pending.resolve({ ok: false, outcome: 'refused', status: 403, message: 'another session' });
    await sending;
    await controller.reload();
    await controller.retry();
    expect(controller.snapshot()).toBe(before);
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(commands).toEqual([{ token: 'original-token', input: attempt.input }]);
    expect(reads).toBe(1);
    expect(h.client.getQueryState(verificationQueryKey('alice'))).toBeUndefined();
  } finally {
    h.close();
  }
});

test('a late privacy row read cannot adopt values or resolve an immutable uncertain command after retirement', async () => {
  const h = setup();
  const read = deferred<{ ok: true; value: typeof collection }>();
  let reads = 0;
  const row = new CollectionPrivacyEditor(
    collection,
    collectionPrivacyIO(h.owner, {
      save: async () => ({ ok: false, reason: 'unavailable' }),
      read: () => {
        reads++;
        return read.promise;
      },
    }),
    h.owner.isCurrent,
  );
  try {
    await row.edit('public');
    const attempt = row.snapshot().attempt!;
    const reloading = row.reload();
    const before = row.snapshot();
    transitions['token rotation and back'](h.client);
    read.resolve({ ok: true, value: collection });
    await reloading;
    await row.retry();
    await row.reload();
    expect(row.snapshot()).toBe(before);
    expect(row.snapshot().attempt).toBe(attempt);
    expect(row.needsListRestartProtection()).toBe(true);
    expect(reads).toBe(1);
  } finally {
    h.close();
  }
});

test('Reading production recovery retries the identical frozen command with its original token and rejects the retired callback', async () => {
  const h = setup();
  const calls: unknown[] = [];
  const tokens: string[] = [];
  let reads = 0;
  const receipt = { spoilerLevel: 1 as const, suitability: 'blur' as const, version: 5 };
  const io = accountPreferenceIO('alice', h.owner.credential, () => {}, {
    read: async () => {
      reads++;
      return { ...page, preferences: receipt };
    },
    saveReading: async (input, token) => {
      calls.push(input);
      tokens.push(token);
      return calls.length === 1 ? { ok: false, reason: 'unavailable' } : { ok: true, preferences: receipt };
    },
    saveNotifications: async () => {
      throw new Error('Unexpected notification write');
    },
  });
  try {
    const input = readingMutation(page.preferences, { spoilerLevel: 1, suitability: 'blur' })!;
    const bytes = JSON.stringify(input);
    expect(await sendReading(io.reading, input, false, () => 4)).toMatchObject({ kind: 'uncertain' });
    expect(await sendReading(io.reading, input, true, () => 4)).toMatchObject({
      kind: 'confirmed',
      preferences: receipt,
    });
    expect(calls[1]).toBe(calls[0]);
    expect(JSON.stringify(input)).toBe(bytes);
    expect(tokens).toEqual(['original-token', 'original-token']);
    expect(reads).toBe(1);
    transitions['token rotation and back'](h.client);
    expect(await sendReading(io.reading, input, true, () => 4)).toMatchObject({ kind: 'uncertain' });
    expect(calls).toHaveLength(2);
    expect(reads).toBe(1);
  } finally {
    h.close();
  }
});

test('Verification withdrawal uses the original explicit token and keeps its exact unknown attempt through retirement', async () => {
  const h = setup();
  const sent: unknown[] = [];
  const tokens: string[] = [];
  const current: VerificationSnapshot = {
    ...empty,
    viewerActions: [{ action: 'account:update', operations: ['account.withdraw_verification'] }],
    verificationRequest: {
      id: 'original-request',
      accountId: 'alice',
      accountKind: 'actor',
      requestedBy: 'alice',
      catalogueSubjectId: 'agent',
      statement: 'Evidence',
      links: [],
      state: 'pending',
      reason: null,
      problem: null,
      decisionReceiptId: null,
      decidedBy: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  };
  const controller = new VerificationRecovery(
    'alice',
    verificationRecoveryIO(h.owner, h.client, {
      read: async () => current,
      request: async () => {
        throw new Error('Unexpected request');
      },
      withdraw: async (_, input, token) => {
        sent.push(input);
        tokens.push(token);
        throw new Error('Lost withdrawal response');
      },
    }),
    h.owner.isCurrent,
  );
  try {
    await controller.reload();
    await controller.withdraw(true);
    const attempt = controller.snapshot().attempt!;
    const bytes = JSON.stringify(attempt);
    await controller.retry();
    expect(sent[1]).toBe(sent[0]);
    expect(attempt.requestId).toBe('original-request');
    transitions['synchronous signed-out and back'](h.client);
    await controller.retry();
    await controller.withdraw(true);
    expect(controller.snapshot().attempt).toBe(attempt);
    expect(JSON.stringify(attempt)).toBe(bytes);
    expect(tokens).toEqual(['original-token', 'original-token']);
    expect(sent).toHaveLength(2);
  } finally {
    h.close();
  }
});

function readOnlySetup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: null });
  const owner = new SettingsSessionOwner(client, null, 'alice');
  const release = owner.mount();
  return {
    client,
    owner,
    close() {
      release();
      owner.retire();
      client.clear();
    },
  };
}

test('Signed-in Settings readers work without CSRF while native writes and retired or injected callers retain exact authority', async () => {
  const h = readOnlySetup();
  const reads: string[] = [];
  const writes: string[] = [];
  let confirmed = 0;
  const io = accountPreferenceIO(
    'alice',
    h.owner.credential,
    (v) => {
      confirmed = v;
    },
    {
      read: async () => {
        reads.push('preferences');
        return page;
      },
      saveReading: async (_, token) => {
        writes.push(token);
        return { ok: false, reason: 'forbidden' };
      },
      saveNotifications: async (_, token) => {
        writes.push(token);
        return { ok: false, reason: 'forbidden' };
      },
    },
    h.owner.readCurrent,
  );
  const privacy = collectionPrivacyIO(h.owner, {
    read: async () => {
      reads.push('collection');
      return { ok: true, value: collection };
    },
    save: async (_, token) => {
      writes.push(token);
      return { ok: false, reason: 'forbidden' };
    },
  });
  const verification = verificationRecoveryIO(h.owner, h.client, {
    read: async () => {
      reads.push('verification');
      return empty;
    },
    request: async (_, __, token) => {
      writes.push(token);
      throw new Error('Unexpected request');
    },
    withdraw: async (_, __, token) => {
      writes.push(token);
      throw new Error('Unexpected withdrawal');
    },
  });
  const notifications = new NotificationEditor(
    page.page,
    io.notifications,
    false,
    () => 4,
    h.owner.readCurrent,
    h.owner.isCurrent,
  );
  const row = new CollectionPrivacyEditor(collection, privacy, h.owner.readCurrent, h.owner.isCurrent);
  const controller = new VerificationRecovery('alice', verification, h.owner.readCurrent, h.owner.isCurrent);
  try {
    expect(h.owner.readCurrent()).toBe(true);
    expect(h.owner.isCurrent()).toBe(false); // The existing writer contract is still token-requiring.
    expect(h.owner.credential()).toBeNull();
    expect(await io.reading.read()).toEqual(page);
    await notifications.reload();
    await row.reload();
    await controller.reload();
    expect(reads).toEqual(['preferences', 'preferences', 'collection', 'verification']);
    expect(notifications.snapshot().known.version).toBe(4);
    expect(controller.snapshot().current).toEqual(empty);
    expect(h.client.getQueryData(verificationQueryKey('alice'))).toEqual(empty);
    expect(confirmed).toBe(4);
    const beforeNotifications = notifications.snapshot();
    const beforeRow = row.snapshot();
    const beforeVerification = controller.snapshot();
    await notifications.edit('reply', false, 4);
    await notifications.restore(4);
    await notifications.submit(4);
    await notifications.retry();
    await row.edit('public');
    await row.submit();
    await row.retry();
    await controller.submit({ subject: 'agent', statement: 'Evidence', links: [] });
    await controller.withdraw(true);
    await controller.retry();
    expect(notifications.snapshot()).toBe(beforeNotifications);
    expect(row.snapshot()).toBe(beforeRow);
    expect(controller.snapshot()).toBe(beforeVerification);
    expect(await io.reading.save({ expectedVersion: 4, spoilerLevel: 1, idempotencyKey: 'no-token' })).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(
      await io.notifications.save({ expectedVersion: 4, notifications: null, idempotencyKey: 'no-token' }),
    ).toEqual({ ok: false, reason: 'forbidden' });
    await expect(
      privacy.save({ collectionId: 'owned', revision: 7, visibility: 'public', idempotencyKey: 'no-token' }),
    ).rejects.toThrow('Settings viewer unavailable');
    await expect(
      verification.request('alice', { subject: 'agent', statement: '', links: [], idempotencyKey: 'no-token' }),
    ).rejects.toThrow('Settings viewer unavailable');
    await expect(verification.withdraw('alice', { idempotencyKey: 'no-token' })).rejects.toThrow(
      'Settings viewer unavailable',
    );
    expect(writes).toEqual([]);
  } finally {
    h.close();
  }
});

for (const [name, transition] of Object.entries(transitions)) {
  test(`null-token private reads and their late results permanently retire: ${name}`, async () => {
    const h = readOnlySetup();
    const pendingPreferences = deferred<SettingsPage>();
    const pendingRow = deferred<{ ok: true; value: typeof collection }>();
    const pendingVerification = deferred<VerificationSnapshot>();
    const pendingList = deferred<{ ok: true; value: { collections: (typeof collection)[]; next: null } }>();
    let dispatched = 0;
    let confirmed = 0;
    const preferences = accountPreferenceIO(
      'alice',
      h.owner.credential,
      () => {
        confirmed++;
      },
      {
        read: () => {
          dispatched++;
          return pendingPreferences.promise;
        },
        saveReading: async () => {
          throw new Error('Unexpected write');
        },
        saveNotifications: async () => {
          throw new Error('Unexpected write');
        },
      },
      h.owner.readCurrent,
    );
    const notices = new NotificationEditor(
      page.page,
      preferences.notifications,
      false,
      () => 4,
      h.owner.readCurrent,
      h.owner.isCurrent,
    );
    const row = new CollectionPrivacyEditor(
      collection,
      collectionPrivacyIO(h.owner, {
        read: () => {
          dispatched++;
          return pendingRow.promise;
        },
        save: async () => {
          throw new Error('Unexpected write');
        },
      }),
      h.owner.readCurrent,
      h.owner.isCurrent,
    );
    const pager = new CollectionPrivacyPager(
      () =>
        h.owner.guardRead(() => {
          dispatched++;
          return pendingList.promise;
        }),
      h.owner.readCurrent,
    );
    const verification = new VerificationRecovery(
      'alice',
      verificationRecoveryIO(h.owner, h.client, {
        read: () => {
          dispatched++;
          return pendingVerification.promise;
        },
        request: async () => {
          throw new Error('Unexpected request');
        },
        withdraw: async () => {
          throw new Error('Unexpected withdrawal');
        },
      }),
      h.owner.readCurrent,
      h.owner.isCurrent,
    );
    const loading = [notices.reload(), row.reload(), pager.load(), verification.reload()];
    const before = [notices.snapshot(), row.snapshot(), pager.snapshot(), verification.snapshot()];
    try {
      // Do not reuse the token-bearing fixture's retained-data assertion for this null-token observation.
      if (name === 'retained data on query error') {
        h.client
          .getQueryCache()
          .find({ queryKey: sessionQuery.queryKey })!
          .setState({ status: 'error', error: new Error('session failed') });
        expect(h.client.getQueryData(sessionQuery.queryKey)).toEqual({ ...identity, csrfToken: null });
      } else transition(h.client);
      h.client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: null });
      expect(h.owner.readCurrent()).toBe(false);
      pendingPreferences.resolve(page);
      pendingRow.resolve({ ok: true, value: collection });
      pendingList.resolve({ ok: true, value: { collections: [collection], next: null } });
      pendingVerification.resolve(empty);
      await Promise.all(loading);
      await notices.reload();
      await row.reload();
      await pager.restart();
      await verification.reload();
      preferences.notifications.confirmed(40);
      expect([notices.snapshot(), row.snapshot(), pager.snapshot(), verification.snapshot()]).toEqual(before);
      expect(dispatched).toBe(4);
      expect(confirmed).toBe(0);
      expect(h.client.getQueryState(verificationQueryKey('alice'))).toBeUndefined();
      const fresh = new SettingsSessionOwner(h.client, null, 'alice');
      expect(await fresh.guardRead(async () => 'fresh read')).toBe('fresh read');
      expect(fresh.isCurrent()).toBe(false);
      fresh.retire();
    } finally {
      h.close();
    }
  });
}

test('a fresh token owner can write only with its own explicit credential after a null-token observation retires', async () => {
  const h = readOnlySetup();
  const tokens: string[] = [];
  try {
    h.client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: 'fresh-explicit-token' });
    const fresh = new SettingsSessionOwner(h.client, 'fresh-explicit-token', 'alice');
    const release = fresh.mount();
    const io = accountPreferenceIO(
      'alice',
      fresh.credential,
      () => {},
      {
        read: async () => page,
        saveReading: async (_, token) => {
          tokens.push(token);
          return { ok: true, preferences: page.preferences };
        },
        saveNotifications: async (_, token) => {
          tokens.push(token);
          return { ok: true, notifications: page.notifications, version: 4, page: page.page };
        },
      },
      fresh.readCurrent,
    );
    const row = collectionPrivacyIO(fresh, {
      read: async () => ({ ok: true, value: collection }),
      save: async (_, token) => {
        tokens.push(token);
        return { ok: false, reason: 'conflict' };
      },
    });
    const verification = verificationRecoveryIO(fresh, h.client, {
      read: async () => empty,
      request: async (_, __, token) => {
        tokens.push(token);
        return { ok: false, outcome: 'refused', status: 403, message: 'Refused' };
      },
      withdraw: async (_, __, token) => {
        tokens.push(token);
        return { ok: false, outcome: 'refused', status: 403, message: 'Refused' };
      },
    });
    expect(h.owner.readCurrent()).toBe(false);
    await expect(h.owner.guardRead(async () => 'stale')).rejects.toThrow('Settings viewer unavailable');
    await io.reading.save({ expectedVersion: 4, spoilerLevel: 1, idempotencyKey: 'fresh-reading' });
    await io.notifications.save({ expectedVersion: 4, notifications: null, idempotencyKey: 'fresh-notices' });
    await row.save({ collectionId: 'owned', revision: 7, visibility: 'public', idempotencyKey: 'fresh-row' });
    await verification.request('alice', {
      subject: 'agent',
      statement: '',
      links: [],
      idempotencyKey: 'fresh-request',
    });
    await verification.withdraw('alice', { idempotencyKey: 'fresh-withdraw' });
    expect(tokens).toEqual(Array(5).fill('fresh-explicit-token'));
    release();
    fresh.retire();
  } finally {
    h.close();
  }
});

test('null-token read custody survives StrictMode replay and permanently closes after real teardown', async () => {
  const h = readOnlySetup();
  const detach = h.owner.mount();
  detach();
  expect(h.owner.readCurrent()).toBe(true); // The original mounted consumer remains.
  h.close();
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: null });
  const owner = new SettingsSessionOwner(client, null, 'alice');
  const release = owner.mount();
  release();
  expect(owner.readCurrent()).toBe(false);
  const replay = owner.mount();
  await Promise.resolve();
  expect(await owner.guardRead(async () => 'read')).toBe('read');
  expect(owner.credential()).toBeNull();
  replay();
  await Promise.resolve();
  const staleReconnect = owner.mount();
  await expect(owner.guardRead(async () => 'late')).rejects.toThrow('Settings viewer unavailable');
  staleReconnect();
  client.clear();
});

async function mountedSettingsExample(
  run: (h: {
    host: HTMLElement;
    render: (node: import('react').ReactNode) => Promise<void>;
    click: (node: Element) => Promise<void>;
    choose: (node: HTMLSelectElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings#notifications' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    HTMLFormElement: window.HTMLFormElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(host as unknown as HTMLElement);
  try {
    await run({
      host: host as unknown as HTMLElement,
      render: async (node) => {
        await act(async () => {
          root.render(createElement(StrictMode, null, node));
        });
      },
      click: async (node) => {
        await act(async () => {
          node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        });
      },
      choose: async (node, value) => {
        await act(async () => {
          node.value = value;
          node.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
      },
    });
  } finally {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}

test('actual null-CSRF Settings composition retains reloads, disabled writers and independently owned managed inventory', async () => {
  await mountedSettingsExample(async ({ host, render, click }) => {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: null });
    client.setQueryData(exposureQuery.queryKey, []);
    let reads = 0;
    let inventoryReads = 0;
    let writes = 0;
    const preferenceIO = {
      read: async () => {
        reads++;
        return page;
      },
      saveReading: async (): Promise<PreferenceWriteResult> => {
        writes++;
        return { ok: false, reason: 'unavailable' };
      },
      saveNotifications: async (): Promise<NotificationWriteResult> => {
        writes++;
        return { ok: false, reason: 'unavailable' };
      },
    };
    const managedAccountsIO: import('../src/settings/managed-accounts-read').ManagedAccountsIO = async () => {
      inventoryReads++;
      return {
        ok: true,
        page: {
          account: { id: 'alice', kind: 'actor', displayName: 'Alice', handle: null },
          organizations: { state: 'ready', items: [], next: null },
          responsibilities: { items: [], next: null },
        },
      };
    };
    const route = createRootRoute({
      component: () =>
        createElement(SettingsPageView, {
          page,
          csrfToken: null,
          preferenceIO,
          managedAccountsIO,
        }),
    });
    const router = createRouter({
      routeTree: route,
      history: createMemoryHistory({ initialEntries: ['/en/settings#reading'] }),
    });
    await router.load();
    try {
      await render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
      expect(host.querySelector('#settings-reading-heading')).not.toBeNull();
      expect(host.textContent).not.toContain(m.settings_session_unavailable());
      expect(host.querySelectorAll('[role="radio"]')).toHaveLength(3);
      expect(
        [...host.querySelectorAll<HTMLButtonElement>('[role="radio"], [role="switch"]')].every((node) => node.disabled),
      ).toBe(true);
      expect(reads).toBe(0); // The installed loader supplies Reading's current snapshot.
      await act(async () => {
        await router.navigate({ hash: 'notifications' });
      });
      const notices = host.querySelector('[data-settings-panel="notifications"]')!;
      expect([...notices.querySelectorAll<HTMLButtonElement>('[role="switch"]')].every((node) => node.disabled)).toBe(
        true,
      );
      const noticeReload = [...notices.querySelectorAll('button')].find(
        (node) => node.textContent === m.settings_reload(),
      )!;
      await click(noticeReload);
      expect(reads).toBe(1);
      await act(async () => {
        await router.navigate({ hash: 'account' });
      });
      expect(inventoryReads).toBe(1); // StrictMode and null CSRF leave Account's own read owner usable.
      expect(host.querySelector('#settings-account-heading')).not.toBeNull();
      await act(async () => {
        await router.navigate({ hash: 'reading' });
      });
      expect(host.querySelector('#settings-reading-heading')).not.toBeNull();
      expect(inventoryReads).toBe(1);
      expect(writes).toBe(0);
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, { ...identity, subject: 'bob', csrfToken: null });
        client.setQueryData(sessionQuery.queryKey, { ...identity, csrfToken: null });
        noticeReload.click();
      });
      expect(reads).toBe(1);
      expect(host.querySelector('[data-settings-panel]')).toBeNull();
      expect(host.querySelector('#display')).not.toBeNull();
      expect(writes).toBe(0);
    } finally {
      await render(null);
      client.clear();
    }
  });
});

test('standalone injected CollectionRow has usable controls, exact uncertain retry and no callbacks after teardown', async () => {
  const { CollectionRow } = await import('../src/settings/collection-privacy');
  await mountedSettingsExample(async ({ host, render, choose, click }) => {
    const calls: unknown[] = [];
    let reads = 0;
    const io = {
      save: async (
        input: import('../src/settings/collection-privacy-recovery').VisibilityAttempt,
      ): Promise<CollectionVisibilityWrite> => {
        calls.push(input);
        if (calls.length === 1) throw new Error('Lost response');
        return { ok: true, collection: { ...collection, visibility: 'public', revision: 8 } };
      },
      read: async () => {
        reads++;
        return { ok: true as const, value: { ...collection, visibility: 'public' as const, revision: 8 } };
      },
    };
    await render(createElement('ul', null, createElement(CollectionRow, { collection, io })));
    const select = host.querySelector('select')!;
    expect(select.disabled).toBe(false);
    await choose(select, 'public');
    const original = calls[0];
    const bytes = JSON.stringify(original);
    await choose(select, 'unlisted');
    expect(calls).toHaveLength(1);
    const retry = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === m.settings_privacy_retry_original(),
    )!;
    expect(retry.disabled).toBe(false);
    await click(retry);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(original);
    expect(JSON.stringify(calls[1])).toBe(bytes);
    expect(Object.isFrozen(original)).toBe(true);
    expect(reads).toBe(1);
    expect(select.value).toBe('unlisted');
    expect(host.textContent).toContain(m.settings_privacy_review_title());
    await render(null);
    await choose(select, 'private');
    await click(retry);
    expect(calls).toHaveLength(2);
    expect(reads).toBe(1);
  });
});

for (const invalid of ['null-token', 'query-error', 'retired', 'missing-query', 'native-without-owner'] as const) {
  test(`CollectionRow injection cannot bypass installed authority: ${invalid}`, async () => {
    const { CollectionRow } = await import('../src/settings/collection-privacy');
    const { SettingsSessionContext } = await import('../src/settings/settings-session-owner');
    await mountedSettingsExample(async ({ host, render, choose }) => {
      const h = invalid === 'null-token' ? readOnlySetup() : setup();
      h.client.setQueryData(exposureQuery.queryKey, ['collections']);
      if (invalid === 'query-error') transitions['retained data on query error'](h.client);
      if (invalid === 'retired') transitions['synchronous subject away and back'](h.client);
      if (invalid === 'missing-query') h.client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      let calls = 0;
      const io = {
        save: async (): Promise<CollectionVisibilityWrite> => {
          calls++;
          return { ok: false, reason: 'unavailable' };
        },
        read: async () => {
          calls++;
          return { ok: true as const, value: collection };
        },
      };
      try {
        const row = createElement(
          'ul',
          null,
          createElement(CollectionRow, { collection, ...(invalid === 'native-without-owner' ? {} : { io }) }),
        );
        await render(
          invalid === 'native-without-owner'
            ? row
            : createElement(
                QueryClientProvider,
                { client: h.client },
                invalid === 'missing-query'
                  ? row
                  : createElement(SettingsSessionContext.Provider, { value: h.owner }, row),
              ),
        );
        const select = host.querySelector('select')!;
        expect(select.disabled).toBe(true);
        await choose(select, 'public'); // Even an injected DOM change cannot start a command.
        expect(calls).toBe(0);
        if (invalid === 'missing-query') {
          await act(async () => {
            h.client.setQueryData(sessionQuery.queryKey, identity);
          });
          await choose(select, 'unlisted');
          expect(select.disabled).toBe(true); // Installing an observation cannot revive this unowned mount.
          expect(calls).toBe(0);
        }
      } finally {
        await render(null);
        h.close();
      }
    });
  });
}

test('standalone row teardown drops a late replay receipt before it can start readback', async () => {
  const { CollectionRow } = await import('../src/settings/collection-privacy');
  await mountedSettingsExample(async ({ host, render, choose, click }) => {
    const replay = deferred<CollectionVisibilityWrite>();
    const sent: unknown[] = [];
    let reads = 0;
    await render(
      createElement(
        'ul',
        null,
        createElement(CollectionRow, {
          collection,
          io: {
            save: async (input) => {
              sent.push(input);
              if (sent.length === 1) throw new Error('Lost');
              return replay.promise;
            },
            read: async () => {
              reads++;
              return { ok: true, value: collection };
            },
          },
        }),
      ),
    );
    await choose(host.querySelector('select')!, 'public');
    const retry = [...host.querySelectorAll('button')].find(
      (node) => node.textContent === m.settings_privacy_retry_original(),
    )!;
    await click(retry);
    expect(sent[1]).toBe(sent[0]);
    await render(null);
    await act(async () => {
      replay.resolve({ ok: true, collection: { ...collection, visibility: 'public', revision: 8 } });
    });
    expect(reads).toBe(0);
    expect(sent).toHaveLength(2);
    expect(host.textContent).toBe('');
  });
});

test('read-only Reading composition preserves exported writer predicates and rejects injected foreign credentials', async () => {
  const { SettingsSessionContext, useSettingsCurrent, useSettingsReadCurrent } =
    await import('../src/settings/settings-session-owner');
  const { ReadingNavigation, useReadingNavigationCurrent } = await import('../src/settings/reading-navigation');
  function Probe({ token }: { token: string | null }) {
    const write = useSettingsCurrent(token, true);
    const read = useSettingsReadCurrent(token, true);
    const navigationWrite = useReadingNavigationCurrent();
    return createElement('output', null, `read:${read()}/write:${write()}/navigation:${navigationWrite()}`);
  }
  await mountedSettingsExample(async ({ host, render }) => {
    const h = readOnlySetup();
    try {
      for (const token of [null, 'injected-foreign-token']) {
        await render(
          createElement(
            QueryClientProvider,
            { client: h.client },
            createElement(
              SettingsSessionContext.Provider,
              { value: h.owner },
              createElement(
                ReadingNavigation,
                { csrfToken: null },
                createElement(Probe, { key: String(token), token }),
              ),
            ),
          ),
        );
        expect(host.textContent).toBe(`read:${token === null}/write:false/navigation:false`);
        expect(host.textContent).not.toContain(m.settings_reading_session_changed());
      }
      await act(async () => {
        h.owner.retire();
      });
      expect(host.textContent).toContain(m.settings_reading_session_changed());
      expect(host.querySelector('output')).toBeNull();
    } finally {
      await render(null);
      h.close();
    }
  });
});

test('a standalone injected row still obeys an inherited owner without a QueryClient provider', async () => {
  const { CollectionRow } = await import('../src/settings/collection-privacy');
  const { SettingsSessionContext } = await import('../src/settings/settings-session-owner');
  await mountedSettingsExample(async ({ host, render, choose }) => {
    const h = setup();
    let writes = 0;
    const io = {
      save: async (): Promise<CollectionVisibilityWrite> => {
        writes++;
        return { ok: false, reason: 'unavailable' };
      },
      read: async () => ({ ok: true as const, value: collection }),
    };
    try {
      await render(
        createElement(
          SettingsSessionContext.Provider,
          { value: h.owner },
          createElement('ul', null, createElement(CollectionRow, { collection, io })),
        ),
      );
      const select = host.querySelector('select')!;
      expect(select.disabled).toBe(false);
      await choose(select, 'public');
      expect(writes).toBe(1);
      await act(async () => {
        transitions['synchronous subject away and back'](h.client);
      });
      expect(select.disabled).toBe(true);
      await choose(select, 'unlisted');
      expect(writes).toBe(1);
    } finally {
      await render(null);
      h.close();
    }
  });
});
