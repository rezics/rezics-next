import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, StrictMode, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { boundaries, env as sharedEnv, installManagedModuleMocks, requests } from './fixtures/managed-module-mocks';
import type { SessionEnv } from '../src/session/client';
import type { ManagedAccountsResult } from '../src/settings/managed-accounts-read';
import type { DetailResult } from '../src/settings/managed-account-detail-read';
import type { ManagedAuthNavigation, ManagedAccountActionsResult } from '../src/settings/managed-account-actions-read';
import type { AccountRenameResult } from '../src/settings/account-rename-actions';

// Actual QueryClient, mounted production callers, original server handlers and generated HTTP client.
// The DOM/server plumbing and HTTP responses are fixtures. All regressions in this file are authored, UNRUN.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: window.matchMedia.bind(window),
  scrollTo: window.scrollTo.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
// Each file owns its globals while its tests run; test files load together in one process.
const install = () => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
};
install();
beforeAll(install);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const viewerId = '019a0000-0000-7000-8000-000000000001';
const targetId = '019a0000-0000-7000-8000-000000000002';
const otherId = '019a0000-0000-7000-8000-000000000003';
const token = 'A'.repeat(22);
const session = (subject = viewerId, csrfToken: string | null = token) => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
let nativeSession = session();
const env = Object.assign(sharedEnv, {
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://api.test',
  WEBSITE_SCOPES: 'openid account:read account:update',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  KERNEL_ORIGIN: 'https://kernel.test',
  AUTH_MANAGEMENT_PAGE_ROUTES: '["/account/rename","/organizations/members","/organizations/delete"]',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => ({ status: 'active', ...nativeSession, accessToken: 'original-native-reader' }),
    }),
  },
}) as unknown as SessionEnv;
const pending: { request: Request; response: ReturnType<typeof deferred<Response>> }[] = [];
const native = createKernelClient('https://kernel.test', {
  fetch: async (url, init) => {
    const request = new Request(url, init);
    expect(request.headers.get('authorization')).toBe('Bearer original-native-reader');
    expect(init?.cache).toBe('no-store');
    const response = deferred<Response>();
    pending.push({ request, response });
    return response.promise;
  },
});
// Module mocks are process-wide: each file re-registers its own before its tests, after other files have loaded.
const installMocks = () => installManagedModuleMocks();
installMocks();
beforeAll(installMocks);
const originalKernel = { ...(await import('../src/kernel/client')) };
const installKernelMock = () => mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => native }));
installKernelMock();
beforeAll(() => {
  installMocks();
  installKernelMock();
});
const { createRoot } = await import('react-dom/client');
const { sessionQuery } = await import('../src/session/query');
const { ManagedSessionReader } = await import('../src/settings/managed-session-reader');
const { ManagedAccountsInventory } = await import('../src/settings/managed-accounts-read');
const { ManagedAccountReader } = await import('../src/settings/managed-account-detail-read');
const { ManagedAccountActionsRead } = await import('../src/settings/managed-account-actions-read');
const { AccountRenameRegion, AccountSafetySection, readCurrentAccountRename } =
  await import('../src/settings/account-safety');
const { ManagedAccountsSection } = await import('../src/settings/managed-accounts');
const { ManagedAccountDetail } = await import('../src/settings/managed-account-detail');
const { ManagedAccountActions } = await import('../src/settings/managed-account-actions');
const { closedProfileEditing } = await import('../src/settings/editable-profile-source');
const identity = (id = viewerId) => ({
  id,
  kind: 'actor' as const,
  handle: 'private-handle',
  displayName: 'Private account',
});
const inventory = () => ({
  account: identity(),
  viewer: { state: 'current' as const, account: identity() },
  organizations: {
    state: 'ready' as const,
    items: [
      {
        account: { ...identity(targetId), kind: 'organization' as const },
        role: 'owner' as const,
        navigation: { state: 'admitted' as const },
      },
    ],
    next: 'org/+==',
  },
  responsibilities: {
    items: [
      {
        reservationId: otherId,
        accountId: targetId,
        account: null,
        state: 'reconciling' as const,
        navigation: { state: 'concealed' as const },
      },
    ],
    next: 'ops/+==',
  },
});
const detail = (accountId = targetId) => ({
  account: { ...identity(accountId), kind: 'organization' as const },
  self: false,
  role: 'owner' as const,
  operator: null,
  relation: null,
  members: {
    state: 'ready' as const,
    items: [{ accountId: viewerId, account: identity(), role: 'owner' as const }],
    next: 'members/+==',
  },
  responsibilities: {
    items: [{ reservationId: otherId, accountId: otherId, account: identity(otherId), state: 'reconciling' as const }],
    next: 'ops/+==',
  },
  authActions: {
    state: 'ready',
    operations: [
      {
        operationId: 'auth.organization.membership',
        action: 'organization:membership',
        resource: { route: 0, id: accountId },
      },
    ],
  },
});
const actionResult = (): ManagedAccountActionsResult => ({
  state: 'ready',
  accountId: targetId,
  viewerId,
  actions: {
    profile: { state: 'available' },
    rename: { state: 'denied' },
    members: { state: 'denied' },
    transfer: { state: 'denied' },
    delete: { state: 'denied' },
  },
});
const renameResult: AccountRenameResult = {
  context: { accountId: viewerId, handle: 'private-handle', available: true, href: 'https://auth.test/account/rename' },
};
function lose(client: QueryClient, kind: 'error' | 'remove' | 'loss' | 'subject' | 'token') {
  if (kind === 'error')
    client
      .getQueryCache()
      .find({ queryKey: sessionQuery.queryKey, exact: true })!
      .setState({ status: 'error', error: new Error('session unavailable') });
  if (kind === 'remove') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
  if (kind === 'loss')
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  if (kind === 'subject') client.setQueryData(sessionQuery.queryKey, session(otherId));
  if (kind === 'token') client.setQueryData(sessionQuery.queryKey, session(viewerId, 'B'.repeat(22)));
}

for (const kind of ['error', 'remove', 'loss', 'subject'] as const) {
  test(`all four actual readers retire synchronously on ${kind}, ignore late outcomes and refuse retained callbacks after recovery`, async () => {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, session());
    const owner = new ManagedSessionReader(client, viewerId, targetId);
    const release = owner.attach();
    const invResult = deferred<ManagedAccountsResult>();
    const detResult = deferred<DetailResult>();
    const actResult = deferred<ManagedAccountActionsResult>();
    const renResult = deferred<AccountRenameResult>();
    const calls = [0, 0, 0, 0];
    const inv = new ManagedAccountsInventory(
      viewerId,
      () => {
        calls[0]++;
        return invResult.promise;
      },
      owner.isCurrent,
    );
    const det = new ManagedAccountReader(
      viewerId,
      targetId,
      () => {
        calls[1]++;
        return detResult.promise;
      },
      token,
      owner.isCurrent,
    );
    const actions = new ManagedAccountActionsRead(
      { viewerId, accountId: targetId },
      () => {
        calls[2]++;
        return actResult.promise;
      },
      owner.isCurrent,
    );
    const rename = new AccountRenameRegion(
      () => {
        calls[3]++;
        return renResult.promise;
      },
      viewerId,
      owner.isCurrent,
    );
    const leave = rename.mount();
    const reads = [inv.load(), det.load(), actions.load(), rename.reload()];
    await Promise.resolve();
    expect(calls).toEqual([1, 1, 1, 1]);
    lose(client, kind);
    if (kind === 'error') expect(client.getQueryData(sessionQuery.queryKey)).toEqual(session()); // retained data is not success
    client.setQueryData(sessionQuery.queryKey, session()); // no intervening render
    expect(owner.isCurrent()).toBe(false);
    expect(inv.snapshot().account).toBeNull();
    expect(det.snapshot().detail).toBeUndefined();
    expect(actions.snapshot().result).toBeNull();
    expect(rename.snapshot().context).toBeNull();
    invResult.resolve({ ok: true, page: inventory() });
    detResult.resolve({ ok: true, viewerId, value: detail() });
    actResult.resolve(actionResult());
    renResult.resolve(renameResult);
    await Promise.all(reads);
    await Promise.all([
      inv.load(),
      inv.more('organizations'),
      inv.more('responsibilities'),
      inv.firstPage('organizations'),
      det.load(),
      det.load('members', 'old'),
      det.load('responsibilities', 'old'),
      actions.load(),
      actions.retry(),
      rename.reload(),
    ]);
    expect(calls).toEqual([1, 1, 1, 1]);
    expect(inv.snapshot().account).toBeNull();
    expect(det.snapshot().authNavigation).toBeUndefined();
    expect(actions.snapshot().result).toBeNull();
    expect(rename.snapshot().failures).toBeUndefined();
    const fresh = new ManagedSessionReader(client, viewerId, targetId);
    const leaveFresh = fresh.attach();
    const recovered = new ManagedAccountsInventory(
      viewerId,
      async () => ({ ok: true, page: inventory() }),
      fresh.isCurrent,
    );
    await recovered.load();
    expect(recovered.snapshot().account?.id).toBe(viewerId);
    leaveFresh();
    leave();
    release();
    client.clear();
  });
}

test('read custody ignores CSRF while token-bound navigation retires across an away/back transition and subscription replay', async () => {
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, session());
  const read = new ManagedSessionReader(client, viewerId, targetId);
  const navigation = new ManagedSessionReader(client, viewerId, targetId, token);
  let leave = read.attach();
  const leaveNavigation = navigation.attach();
  leave();
  leave = read.attach();
  await Promise.resolve();
  expect(read.isCurrent()).toBe(true);
  lose(client, 'token');
  client.setQueryData(sessionQuery.queryKey, session());
  expect(read.isCurrent()).toBe(true);
  expect(navigation.isCurrent()).toBe(false);
  leave();
  await Promise.resolve();
  read.attach();
  expect(read.isCurrent()).toBe(false);
  leaveNavigation();
  client.clear();
});

test('rename checks the actual asynchronous import boundary and original token, then drops late success and failure', async () => {
  for (const at of ['before-import', 'during-import', 'during-read'] as const) {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, session());
    const owner = new ManagedSessionReader(client, viewerId, viewerId, token);
    const leave = owner.attach();
    const module = deferred<typeof import('../src/settings/account-rename-actions')>();
    const outcome = deferred<AccountRenameResult>();
    let imports = 0;
    const headers: Headers[] = [];
    const original = await import('../src/settings/account-rename-actions');
    const loaded = {
      ...original,
      readAccountRename: ((input: { headers: HeadersInit }) => {
        headers.push(new Headers(input.headers));
        return outcome.promise;
      }) as typeof original.readAccountRename,
    };
    if (at === 'before-import') lose(client, 'error');
    const read = readCurrentAccountRename(token, owner.isCurrent, () => {
      imports++;
      return module.promise;
    });
    if (at === 'during-import') {
      lose(client, 'loss');
      client.setQueryData(sessionQuery.queryKey, session());
    }
    module.resolve(loaded);
    await Promise.resolve();
    await Promise.resolve();
    if (at === 'during-read') {
      expect(headers[0]?.get('X-CSRF-Token')).toBe(token);
      lose(client, 'subject');
    }
    outcome.resolve(renameResult);
    expect(await read).toEqual({ context: null });
    expect(imports).toBe(at === 'before-import' ? 0 : 1);
    expect(headers).toHaveLength(at === 'during-read' ? 1 : 0);
    leave();
    client.clear();
  }
});

for (const late of ['success', 'failure'] as const) {
  test(`both inventory and detail feed requests discard delayed ${late} after session retirement, preserving independent original cursors`, async () => {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, session());
    const owner = new ManagedSessionReader(client, viewerId, targetId);
    const leave = owner.attach();
    const inventoryReplies = [deferred<ManagedAccountsResult>(), deferred<ManagedAccountsResult>()];
    const detailReplies = [deferred<DetailResult>(), deferred<DetailResult>()];
    const inventoryCalls: object[] = [];
    const detailCalls: object[] = [];
    const inv = new ManagedAccountsInventory(
      viewerId,
      (input) => {
        inventoryCalls.push(input);
        if (!input.organizationsCursor && !input.operatorsCursor)
          return Promise.resolve({ ok: true, page: inventory() });
        return inventoryReplies[input.organizationsCursor ? 0 : 1]!.promise;
      },
      owner.isCurrent,
    );
    const det = new ManagedAccountReader(
      viewerId,
      targetId,
      (input) => {
        detailCalls.push(input);
        if (!input.section) return Promise.resolve({ ok: true, viewerId, value: detail() });
        return detailReplies[input.section === 'members' ? 0 : 1]!.promise;
      },
      token,
      owner.isCurrent,
    );
    await inv.load();
    await det.load();
    const reads = [
      inv.more('organizations'),
      inv.more('responsibilities'),
      det.load('members', 'members/+=='),
      det.load('responsibilities', 'ops/+=='),
    ];
    expect(inventoryCalls).toEqual([{}, { organizationsCursor: 'org/+==' }, { operatorsCursor: 'ops/+==' }]);
    expect(detailCalls).toEqual([
      { viewerId, accountId: targetId },
      { viewerId, accountId: targetId, section: 'members', cursor: 'members/+==' },
      { viewerId, accountId: targetId, section: 'responsibilities', cursor: 'ops/+==' },
    ]);
    lose(client, 'error');
    client.setQueryData(sessionQuery.queryKey, session());
    for (const reply of inventoryReplies)
      reply.resolve(
        late === 'success'
          ? { ok: true, page: inventory() }
          : { ok: false, kind: 'unavailable', status: 409, code: 'stale_cursor', retryAfter: '7' },
      );
    for (const reply of detailReplies)
      reply.resolve(
        late === 'success'
          ? { ok: true, viewerId, value: detail() }
          : { ok: false, failure: { status: 503, code: 'dependency_unavailable', retryAfter: '7', transient: true } },
      );
    await Promise.all(reads);
    expect(inv.snapshot().account).toBeNull();
    expect(inv.snapshot().organizations).toMatchObject({ items: [], next: null, failure: null, busy: false });
    expect(inv.snapshot().responsibilities).toMatchObject({ items: [], next: null, failure: null, busy: false });
    expect(det.snapshot()).toEqual({
      pending: false,
      members: { page: undefined, pending: false },
      responsibilities: { page: undefined, pending: false },
    });
    await Promise.all([
      inv.load(),
      inv.more('organizations'),
      inv.more('responsibilities'),
      inv.firstPage('organizations'),
      inv.firstPage('responsibilities'),
      det.load(),
      det.load('members'),
      det.load('members', 'members/+=='),
      det.load('responsibilities'),
      det.load('responsibilities', 'ops/+=='),
    ]);
    expect(inventoryCalls).toHaveLength(3);
    expect(detailCalls).toHaveLength(3);
    leave();
    client.clear();
  });
}

test('synchronous loss and recovery during pending publication refuses actual IO, including deferred action and rename dispatch', async () => {
  for (const surface of ['inventory', 'detail', 'actions', 'safety'] as const) {
    const client = new QueryClient();
    client.setQueryData(sessionQuery.queryKey, session());
    const owner = new ManagedSessionReader(client, viewerId, targetId, token);
    const leave = owner.attach();
    let calls = 0;
    let lost = false;
    const retire = () => {
      if (lost) return;
      lost = true;
      lose(client, 'error');
      client.setQueryData(sessionQuery.queryKey, session());
    };
    const inv = new ManagedAccountsInventory(
      viewerId,
      async () => {
        calls++;
        return { ok: true, page: inventory() };
      },
      owner.isCurrent,
    );
    const det = new ManagedAccountReader(
      viewerId,
      targetId,
      async () => {
        calls++;
        return { ok: true, viewerId, value: detail() };
      },
      token,
      owner.isCurrent,
    );
    const actions = new ManagedAccountActionsRead(
      { viewerId, accountId: targetId },
      async () => {
        calls++;
        return actionResult();
      },
      owner.isCurrent,
    );
    const rename = new AccountRenameRegion(
      async () => {
        calls++;
        return renameResult;
      },
      viewerId,
      owner.isCurrent,
    );
    const reader =
      surface === 'inventory' ? inv : surface === 'detail' ? det : surface === 'actions' ? actions : rename;
    const unsubscribe = reader.subscribe(retire);
    if (surface === 'inventory') await inv.load();
    if (surface === 'detail') await det.load();
    if (surface === 'actions') await actions.load();
    if (surface === 'safety') {
      rename.mount();
      await rename.reload();
    }
    expect(calls).toBe(0);
    expect(owner.isCurrent()).toBe(false);
    unsubscribe();
    leave();
    client.clear();
  }
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
type Surface = 'inventory' | 'detail' | 'actions' | 'safety';
async function mounted(surface: Surface, initialNavigation?: ManagedAuthNavigation) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session());
  nativeSession = session();
  pending.length = 0;
  boundaries.length = 0;
  let select!: (id: string) => void;
  let observe!: (navigation: ManagedAuthNavigation) => void;
  const content = () => {
    const [selected, setSelected] = useState(targetId);
    const [navigation, setNavigation] = useState(initialNavigation);
    select = setSelected;
    observe = setNavigation;
    return surface === 'inventory'
      ? h(ManagedAccountsSection)
      : surface === 'detail'
        ? h(ManagedAccountDetail, { accountId: selected, backHref: '/en/settings#account' })
        : surface === 'actions'
          ? h(ManagedAccountActions, {
              accountId: selected,
              nativeAccountKind: 'organization',
              self: false,
              operated: false,
              authNavigation: navigation,
              authCsrfToken: token,
            })
          : h(AccountSafetySection, {
              state: 'signed-in',
              accountId: viewerId,
              csrfToken: token,
              securityHref: 'https://auth.test/security',
              onReload() {},
            });
  };
  const route = createRootRoute({ component: content });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/settings'] }) });
  await router.load();
  const root = createRoot(host);
  const paint = async () => {
    await act(async () => {
      root.render(h(StrictMode, null, h(QueryClientProvider, { client }, h(RouterProvider, { router }))));
      await tick();
    });
  };
  await paint();
  return {
    client,
    paint,
    select: async (id: string) => {
      await act(async () => {
        select(id);
        await tick();
      });
    },
    observe: async (navigation: ManagedAuthNavigation) => {
      await act(async () => {
        observe(navigation);
        await tick();
      });
    },
    close: async () => {
      await act(async () => {
        root.unmount();
        await tick();
      });
      client.clear();
    },
  };
}
function responseFor(request: Request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith('/managedAccounts')) return inventory();
  if (path.endsWith('/management')) return detail(path.split('/').at(-2)!);
  if (path.endsWith('/profile'))
    return {
      profile: {
        ...identity(),
        bio: null,
        links: [],
        avatar: null,
        publicViews: { posts: true, reviews: true, collections: true, realms: true },
      },
      editing: closedProfileEditing({ id: viewerId, kind: 'actor' }, viewerId),
    };
  return {}; // viewerActions body is supplied from the exact request selection in answer().
}
async function answer(entries = [...pending], status = 200) {
  await act(async () => {
    for (const entry of entries) {
      let body: unknown = responseFor(entry.request);
      if (new URL(entry.request.url).pathname.endsWith('/viewerActions')) {
        const input = (await entry.request.clone().json()) as { resources: { id: string }[] };
        body = {
          resources: input.resources.map((resource) => ({
            type: 'access.account',
            id: resource.id,
            viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
          })),
        };
      }
      entry.response.resolve(
        Response.json(status === 200 ? body : { code: 'dependency_unavailable', retryable: true }, {
          status,
          headers: { 'retry-after': '7' },
        }),
      );
    }
    await tick();
  });
}

for (const surface of ['inventory', 'detail', 'actions', 'safety'] as const) {
  for (const kind of ['error', 'remove', 'loss', 'subject'] as const) {
    test(`${surface} production caller removes private output on ${kind} and recovers with one fresh bounded read`, async () => {
      const view = await mounted(surface);
      try {
        const initial = [...pending];
        expect(initial).toHaveLength(surface === 'safety' ? 2 : 1); // StrictMode must coalesce the mount read.
        await answer(initial);
        expect(host.innerHTML).toContain(surface === 'actions' ? '/profile' : 'private-handle');
        const oldLinks = [...host.querySelectorAll<HTMLAnchorElement>('a')].filter((link) =>
          /managedAccount=|\/profile|\/account\/rename/.test(link.href),
        );
        await act(async () => {
          lose(view.client, kind);
          for (const link of oldLinks)
            expect(link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
          await tick();
        });
        expect(host.innerHTML).not.toContain('private-handle');
        expect(host.innerHTML).not.toContain('managedAccount=');
        if (surface === 'actions') expect(host.querySelector('a')).toBeNull();
        const count = pending.length;
        await act(async () => {
          view.client.setQueryData(sessionQuery.queryKey, session());
          await tick();
        });
        const fresh = pending.slice(count);
        expect(fresh).toHaveLength(surface === 'safety' ? 2 : 1);
        await answer(fresh);
        expect(host.innerHTML).toContain(surface === 'actions' ? '/profile' : 'private-handle');
        if (surface === 'safety') {
          expect(
            boundaries.every((request) => request.method === 'POST' && request.headers.get('X-CSRF-Token') === token),
          ).toBe(true);
          expect(host.querySelector('form')?.getAttribute('action')).toBe('/auth/sign-out');
          expect(host.innerHTML).toContain('https://auth.test/security');
          expect(host.innerHTML).toContain('https://auth.test/account/delete');
        } else expect(boundaries.every((request) => request.method === 'GET')).toBe(true);
      } finally {
        await view.close();
      }
    });
  }
  for (const late of ['success', 'failure'] as const) {
    test(`${surface} production caller drops delayed ${late} after synchronous session away/back before React commits`, async () => {
      const view = await mounted(surface);
      try {
        const old = [...pending];
        await act(async () => {
          lose(view.client, 'error');
          view.client.setQueryData(sessionQuery.queryKey, session());
          await tick();
        });
        const fresh = pending.slice(old.length);
        expect(fresh).toHaveLength(surface === 'safety' ? 2 : 1);
        await answer(old, late === 'success' ? 200 : 503);
        expect(host.innerHTML).not.toContain('private-handle');
        expect(host.innerHTML).not.toContain('data-retry-after="7"');
        await answer(fresh);
        expect(host.innerHTML).toContain(surface === 'actions' ? '/profile' : 'private-handle');
      } finally {
        await view.close();
      }
    });
  }
}

test('detail and action production callers retire exact selected targets before their late native outcomes', async () => {
  for (const surface of ['detail', 'actions'] as const) {
    const view = await mounted(surface);
    try {
      const old = [...pending];
      await view.select(otherId);
      const fresh = pending.slice(old.length);
      expect(fresh).toHaveLength(1);
      await answer(old);
      expect(host.innerHTML).not.toContain('private-handle');
      expect(host.innerHTML).not.toContain(`${targetId}/profile`);
      await answer(fresh);
      expect(host.innerHTML).toContain(surface === 'actions' ? otherId : 'private-handle');
    } finally {
      await view.close();
    }
  }
});

for (const surface of ['inventory', 'detail', 'actions', 'safety'] as const) {
  test(`${surface} production unmount drops an outstanding native success and never dispatches a continuation`, async () => {
    const view = await mounted(surface);
    const old = [...pending];
    const count = boundaries.length;
    await view.close();
    await answer(old);
    expect(host.innerHTML).toBe('');
    expect(boundaries).toHaveLength(count);
    expect(pending).toHaveLength(old.length);
  });
}

test('inventory production custody retires loaded pages on a CSRF replacement and reads once with the new credential', async () => {
  const view = await mounted('inventory');
  try {
    await answer();
    const count = pending.length;
    await act(async () => {
      lose(view.client, 'token');
      await tick();
    });
    expect(host.innerHTML).not.toContain('private-handle');
    expect(host.querySelector('a[href*="managedAccount="]')).toBeNull();
    const fresh = pending.slice(count);
    expect(fresh).toHaveLength(1);
    await answer(fresh);
    expect(host.innerHTML).toContain('private-handle');
  } finally {
    await view.close();
  }
});

test('production Auth navigation cannot lend an old proof to a new owner after a token away/back transition', async () => {
  const proof: ManagedAuthNavigation = {
    viewerId,
    accountId: targetId,
    actions: {
      rename: { state: 'denied' },
      transfer: { state: 'denied' },
      delete: { state: 'denied' },
      members: { state: 'available', href: `https://auth.test/organizations/members?account=${targetId}` },
    },
  };
  const view = await mounted('actions', proof);
  try {
    await answer();
    const old = host.querySelector<HTMLAnchorElement>('a[href*="organizations/members"]')!;
    expect(old).not.toBeNull();
    const count = pending.length;
    await act(async () => {
      lose(view.client, 'token');
      view.client.setQueryData(sessionQuery.queryKey, session());
      expect(old.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
      await tick();
    });
    expect(host.querySelector('a[href*="organizations/members"]')).toBeNull();
    await answer(pending.slice(count));
    expect(host.querySelector('a[href*="organizations/members"]')).toBeNull();
    await view.observe({ ...proof, actions: { ...proof.actions } });
    expect(host.querySelector('a[href*="organizations/members"]')).not.toBeNull();
  } finally {
    await view.close();
  }
});

test('detail production GET remains available with no CSRF while Auth navigation remains closed', async () => {
  const view = await mounted('detail');
  try {
    const old = [...pending];
    await act(async () => {
      view.client.setQueryData(sessionQuery.queryKey, session(viewerId, null));
      await tick();
    });
    const fresh = pending.slice(old.length);
    expect(fresh).toHaveLength(1);
    await answer(fresh);
    expect(host.innerHTML).toContain('private-handle');
    expect(host.querySelector('a[href*="auth.test"]')).toBeNull();
  } finally {
    await view.close();
  }
});

for (const failure of [false, true]) {
  test(`disposed readers refuse every retained control and drop late ${failure ? 'rejections' : 'successes'}`, async () => {
    const invOutcome = deferred<ManagedAccountsResult>();
    const detOutcome = deferred<DetailResult>();
    const actOutcome = deferred<ManagedAccountActionsResult>();
    const renOutcome = deferred<AccountRenameResult>();
    const calls = [0, 0, 0, 0];
    const inv = new ManagedAccountsInventory(viewerId, () => {
      calls[0]++;
      return invOutcome.promise;
    });
    const det = new ManagedAccountReader(viewerId, targetId, () => {
      calls[1]++;
      return detOutcome.promise;
    });
    const actions = new ManagedAccountActionsRead({ viewerId, accountId: targetId }, () => {
      calls[2]++;
      return actOutcome.promise;
    });
    const rename = new AccountRenameRegion(() => {
      calls[3]++;
      return renOutcome.promise;
    }, viewerId);
    const leave = rename.mount();
    const reads = [inv.load(), det.load(), actions.load(), rename.reload()];
    await Promise.resolve();
    inv.dispose();
    det.clear();
    actions.dispose();
    leave();
    await Promise.resolve(); // A real unmount, after the synchronous replay window, is terminal.
    if (failure)
      for (const outcome of [invOutcome, detOutcome, actOutcome, renOutcome])
        outcome.reject(new Error('late private error'));
    else {
      invOutcome.resolve({ ok: true, page: inventory() });
      detOutcome.resolve({ ok: true, viewerId, value: detail() });
      actOutcome.resolve(actionResult());
      renOutcome.resolve(renameResult);
    }
    await Promise.all(reads);
    rename.mount();
    await Promise.all([
      inv.load(),
      inv.more('organizations'),
      inv.more('responsibilities'),
      inv.firstPage('organizations'),
      inv.firstPage('responsibilities'),
      det.load(),
      det.load('members'),
      det.load('members', 'old'),
      det.load('responsibilities'),
      det.load('responsibilities', 'old'),
      actions.load(),
      actions.retry(),
      rename.reload(),
    ]);
    expect(calls).toEqual([1, 1, 1, 1]);
    expect(inv.snapshot().account).toBeNull();
    expect(det.snapshot().detail).toBeUndefined();
    expect(actions.snapshot().result).toBeNull();
    expect(rename.snapshot()).toEqual({ context: null, loading: false, retryAt: 0 });
  });
}

afterAll(() => {
  mock.module('../src/kernel/client', () => originalKernel);
  mock.restore();
  host.remove();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.happyDOM.abort();
});
