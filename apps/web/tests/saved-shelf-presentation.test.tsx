import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';

let serverRequest: Request | undefined;
let cloudflareEnv: unknown = {};
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    if (!serverRequest) throw new Error('No current request');
    return serverRequest;
  },
  setResponseHeader() {},
}));
mock.module('cloudflare:workers', () => ({
  get env() {
    return cloudflareEnv;
  },
}));

test('native shelf defaults resolve within limits, URL choices win, and replaced viewers retire the snapshot', async () => {
  const { resolveShelfPresentation, unsupportedShelfColumns, unsupportedShelfSorts } =
    await import('../src/library/shelf-preferences');
  const { shelfColumnIds, shelfDisplay, shelfHref, validateShelfSearch } = await import('../src/library/shelf-params');
  const { parsePreferenceChange, shelfPreferenceColumns } = await import('../src/settings/preferences');
  const { ShelfPreferenceSnapshotOwner } = await import('../src/settings/shelf-preferences-current');
  const idempotencyKey = '0192f3a0-6c1e-7b2a-9d4e-000000000799';

  for (const size of [1, 16, 32]) {
    const scopes = Array.from({ length: size - 1 }, (_, index) => `https://types.example/${index}`);
    const layouts = Object.fromEntries([['all', 'list'], ...scopes.map((scope) => [scope, 'table'])]) as Record<
      string,
      'grid' | 'list' | 'table'
    >;
    const target = scopes.at(-1) ?? 'https://types.example/not-saved';
    const shelf = {
      layouts,
      sorts: {
        all: { field: 'added', direction: 'asc' },
        planned: { field: 'title', direction: 'desc' },
      },
      gridSize: 'large' as const,
      tableColumns: ['title', 'creator', 'progress', 'rating', 'started'] as const,
    };
    const implicit = resolveShelfPresentation(validateShelfSearch({ type: target, cursor: 'older-order' }), shelf);
    expect(implicit.display.layout).toBe(size === 1 ? 'list' : 'table');
    expect(implicit.display.size).toBe('l');
    expect(implicit.display.columns).toBe('title,progress');
    expect(implicit.sort).toEqual({ orderBy: 'createdAt', direction: 'asc' });
    expect(implicit.cursorInvalidated).toBe(true);
    expect(implicit.search.cursor).toBeUndefined();
    expect(Object.keys(layouts)).toHaveLength(size);
    expect(
      parsePreferenceChange({
        expectedVersion: 1,
        idempotencyKey,
        shelf: { layouts, tableColumns: shelfPreferenceColumns },
      }),
    ).toBeDefined();
  }

  const tooManyScopes = Object.fromEntries([
    ['all', 'grid'],
    ...Array.from({ length: 32 }, (_, index) => [`https://types.example/${index}`, 'list']),
  ]);
  expect(
    parsePreferenceChange({
      expectedVersion: 1,
      idempotencyKey,
      shelf: { layouts: tooManyScopes },
    }),
  ).toBeUndefined();

  const shelf = {
    layouts: { all: 'list', 'https://schema.org/Book': 'table' as const },
    sorts: {
      all: { field: 'added' as const, direction: 'asc' as const },
      planned: { field: 'title' as const, direction: 'desc' as const },
    },
    gridSize: 'large' as const,
    tableColumns: ['title', 'creator', 'progress', 'rating', 'started'] as const,
  };
  const urlChoice = validateShelfSearch({
    type: 'https://schema.org/Book',
    layout: 'grid',
    size: 's',
    columns: 'title,status',
    orderBy: 'finishedAt',
    direction: 'asc',
    cursor: 'current-order',
  });
  const explicit = resolveShelfPresentation(urlChoice, shelf);
  expect(explicit.display).toMatchObject({ layout: 'grid', size: 's', columns: 'title,status' });
  expect(explicit.sort).toEqual({ orderBy: 'finishedAt', direction: 'asc' });
  expect(explicit.search.cursor).toBe('current-order');
  expect(explicit.cursorInvalidated).toBe(false);
  expect(unsupportedShelfColumns(shelf)).toEqual(['creator', 'rating', 'started']);
  expect(unsupportedShelfSorts(shelf)).toEqual([{ tab: 'planned', field: 'title' }]);
  expect(shelfColumnIds).not.toContain('creator' as never);

  const explicitDefaults = validateShelfSearch({
    layout: 'grid',
    size: 'm',
    columns: shelfColumnIds.join(','),
  });
  const defaultsHref = shelfHref('en', { ...explicitDefaults, ...shelfDisplay(explicitDefaults) });
  expect(defaultsHref).toContain('layout=grid');
  expect(defaultsHref).toContain('size=m');
  expect(defaultsHref).toContain(`columns=${encodeURIComponent(shelfColumnIds.join(','))}`);

  const snapshot = {
    generation: 'first',
    accountId: 'alice',
    csrfToken: 'token-a',
    shelf: { layouts: { all: 'table' as const } },
  };
  const viewer = { state: 'signed-in', subject: 'alice', csrfToken: 'token-a' };
  const custody = new ShelfPreferenceSnapshotOwner();
  expect(custody.resolve(snapshot, viewer)).toEqual(snapshot.shelf);
  expect(custody.resolve(snapshot, { ...viewer, csrfToken: 'token-b' })).toEqual({});
  expect(custody.resolve(snapshot, viewer)).toEqual({});
  const fresh = { ...snapshot, generation: 'fresh' };
  expect(custody.resolve(fresh, viewer)).toEqual({});
  const nextVisit = new ShelfPreferenceSnapshotOwner();
  expect(nextVisit.resolve(fresh, viewer)).toEqual(snapshot.shelf);
  expect(nextVisit.resolve(fresh, { ...viewer, subject: 'bob' })).toEqual({});
  expect(nextVisit.resolve(fresh, viewer)).toEqual({});
  const readiness = new ShelfPreferenceSnapshotOwner();
  expect(readiness.resolve(fresh, viewer)).toEqual(snapshot.shelf);
  expect(readiness.resolve(fresh, { state: 'unknown', subject: null, csrfToken: null })).toEqual({});
  expect(readiness.resolve(fresh, viewer)).toEqual({});
});

test('mounted Settings shelf editing uses native versioned adapters and retains conflict and uncertain drafts', async () => {
  const accountId = 'alice';
  const csrfToken = 'a'.repeat(22);
  const accessToken = 'reader-access-token';
  const sessionCookie = 'a'.repeat(43);
  const credential = async () => ({ status: 'active', subject: accountId, accessToken, csrfToken });
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'shelf-presentation-test',
    WEBSITE_CLIENT_KEY: 'not-used-by-session-read',
    SITE_ORIGINS: 'https://site.test',
    SESSIONS: {
      idFromName: (value: string) => value,
      get: () => ({ credential, credentialIfFresh: credential }),
    },
  };
  const requestFor = (method: string) =>
    new Request('https://site.test/en/settings', {
      method,
      headers: {
        cookie: `__Host-rezics_session=${sessionCookie}`,
        origin: 'https://site.test',
        ...(method === 'GET' ? {} : { 'X-CSRF-Token': csrfToken }),
      },
    });
  let currentRequest = requestFor('GET');
  serverRequest = currentRequest;
  const problem = (status: number, code: string) =>
    Response.json(
      {
        type: `https://rezics.com/problems/${code}`,
        title: code,
        status,
        code,
        retryable: status >= 500,
        effect_status: status === 409 ? 'not_applied' : 'unknown',
        request_id: `${code}-${status}`,
      },
      { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'private, no-store' } },
    );
  const initialShelf = {
    layouts: { all: 'list', 'https://schema.org/Book': 'grid' },
    sorts: {
      all: { field: 'added', direction: 'asc' },
      planned: { field: 'title', direction: 'desc' },
    },
    gridSize: 'large',
    tableColumns: ['title', 'creator', 'progress', 'rating', 'started'],
  };
  let current: Record<string, unknown> = {
    version: 4,
    spoilerLevel: 1,
    suitability: 'show',
    notifications: { reply: true, mention: true },
    shelf: initialShelf,
  };
  let conflictNext = true;
  let unknownNext = true;
  const receipts = new Map<string, Record<string, unknown>>();
  const patches: Array<{ body: Record<string, unknown>; key: string | null }> = [];
  const merge = (target: unknown, patchValue: unknown): unknown => {
    if (!patchValue || typeof patchValue !== 'object' || Array.isArray(patchValue)) return patchValue;
    const result: Record<string, unknown> =
      target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
    for (const [key, value] of Object.entries(patchValue)) {
      if (value === null) delete result[key];
      else result[key] = merge(result[key], value);
    }
    return result;
  };

  cloudflareEnv = sessionEnv;
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/settings', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFieldSetElement: window.HTMLFieldSetElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLSelectElement: window.HTMLSelectElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname !== '/v1/accounts/alice/preferences') return Response.json({ code: 'not_found' }, { status: 404 });
    if (request.method === 'GET') return Response.json(current, { headers: { 'cache-control': 'private, no-store' } });
    const body = (await request.json()) as Record<string, unknown>;
    const key = request.headers.get('idempotency-key');
    patches.push({ body, key });
    if (key && receipts.has(key)) return Response.json(receipts.get(key));
    if (conflictNext) {
      conflictNext = false;
      current = { ...current, version: 5, notifications: { reply: true, mention: false } };
      return problem(409, 'conflict');
    }
    if (body.expectedVersion !== current.version) return problem(409, 'conflict');
    const { expectedVersion: _expectedVersion, ...patchValue } = body;
    current = merge(current, patchValue) as Record<string, unknown>;
    current.version = Number(current.version) + 1;
    const receipt = structuredClone(current);
    if (key) receipts.set(key, receipt);
    if (unknownNext) {
      unknownNext = false;
      return problem(503, 'dependency_unavailable');
    }
    return Response.json(receipt, { headers: { 'cache-control': 'private, no-store' } });
  }) as typeof fetch;

  try {
    const { kernelClient } = await import('../src/kernel/client');
    const { loadSettingsPage, changePreferences } = await import('../src/settings/preferences');
    const { accountPreferenceIO } = await import('../src/settings/settings-page');
    const { ShelfPreferencesCard } = await import('../src/settings/shelf-preferences');
    const { SettingsSessionContext, SettingsSessionOwner } = await import('../src/settings/settings-session-owner');
    const { sessionQuery } = await import('../src/session/query');
    const { resolveShelfPresentation, unsupportedShelfColumns, unsupportedShelfSorts } =
      await import('../src/library/shelf-preferences');
    const { validateShelfSearch } = await import('../src/library/shelf-params');
    const { m } = await import('../src/paraglide/messages.js');
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
    const { createRoot } = await import('react-dom/client');
    const kernel = kernelClient('en');
    const transport = {
      read: async () => {
        currentRequest = requestFor('GET');
        serverRequest = currentRequest;
        return loadSettingsPage(kernel, currentRequest, sessionEnv);
      },
      saveReading: async (input: never, token: string) => {
        expect(token).toBe(csrfToken);
        currentRequest = requestFor('PATCH');
        serverRequest = currentRequest;
        return changePreferences(kernel, currentRequest, sessionEnv, input);
      },
      saveNotifications: async () => ({ ok: false as const, reason: 'unavailable' as const }),
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    queryClient.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken });
    const owner = new SettingsSessionOwner(queryClient, csrfToken, accountId);
    let confirmedVersion = 0;
    const preferences = accountPreferenceIO(
      accountId,
      owner.credential,
      (version) => {
        confirmedVersion = version;
      },
      transport as never,
      owner.readCurrent,
    );
    const initial = await preferences.shelf.read();
    expect(initial.signedIn && 'preferences' in initial ? initial.preferences.version : -1).toBe(4);
    expect(
      initial.signedIn && 'preferences' in initial ? unsupportedShelfColumns(initial.preferences.shelf!) : [],
    ).toEqual(['creator', 'rating', 'started']);
    expect(
      initial.signedIn && 'preferences' in initial ? unsupportedShelfSorts(initial.preferences.shelf!) : [],
    ).toEqual([{ tab: 'planned', field: 'title' }]);
    const initialPreferences = initial.signedIn && 'preferences' in initial ? initial.preferences : undefined;
    if (!initialPreferences) throw new Error('Native preference fixture did not load');
    const io = preferences.shelf;

    function MountedCard() {
      const [version, setVersion] = useState(initialPreferences.version);
      return createElement(ShelfPreferencesCard, {
        initial: initialPreferences.shelf ?? {},
        version,
        csrfToken,
        io,
        onVersionChange: (next) => {
          confirmedVersion = next;
          setVersion(next);
        },
      });
    }

    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host);
    const render = async () => {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(SettingsSessionContext.Provider, { value: owner }, createElement(MountedCard)),
          ),
        ),
      );
    };
    const button = (label: string) =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
        (node) => node.textContent?.trim() === label,
      )!;
    const click = async (label: string) => {
      const control = button(label);
      expect(control).toBeDefined();
      await act(async () => {
        control.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const select = async (index: number, value: string) => {
      const control = host.querySelectorAll<HTMLSelectElement>('select')[index]!;
      await act(async () => {
        control.value = value;
        control.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
    };
    try {
      await render();
      expect(host.querySelectorAll('select')).toHaveLength(8);
      expect(host.textContent).toContain(m.settings_shelf_columns_unavailable({ columns: 'creator, rating, started' }));
      expect(host.textContent).toContain(
        m.settings_shelf_order_unavailable({ tab: m.library_state_planned(), field: 'title' }),
      );

      await select(0, 'table');
      await click(m.settings_shelf_save());
      expect(host.textContent).toContain(m.settings_shelf_conflict());
      expect((host.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('table');
      await click(m.settings_shelf_reload());
      expect(host.textContent).toContain(m.settings_shelf_review());
      expect((host.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('table');
      await click(m.settings_shelf_save());
      expect(host.querySelector('[role="status"]')?.textContent).toBe(m.settings_saved());
      expect(patches[0]?.body).toEqual({ expectedVersion: 4, shelf: { layouts: { all: 'table' } } });
      expect(patches[1]?.body).toEqual({ expectedVersion: 5, shelf: { layouts: { all: 'table' } } });
      expect(patches[0]?.key).toBeTruthy();
      expect(patches[1]?.key).not.toBe(patches[0]?.key);
      expect(current.spoilerLevel).toBe(1);
      expect(current.suitability).toBe('show');
      expect(current.notifications).toEqual({ reply: true, mention: false });
      expect((current.shelf as typeof initialShelf).layouts).toEqual({
        all: 'table',
        'https://schema.org/Book': 'grid',
      });
      expect((current.shelf as typeof initialShelf).sorts.planned).toEqual({ field: 'title', direction: 'desc' });
      expect((current.shelf as typeof initialShelf).tableColumns).toEqual(initialShelf.tableColumns);
      expect(confirmedVersion).toBe(6);

      const refreshed = await preferences.shelf.read();
      if (!refreshed.signedIn || !('preferences' in refreshed)) throw new Error('Native preference readback failed');
      const implicit = resolveShelfPresentation(
        validateShelfSearch({ type: 'https://schema.org/Book', cursor: 'cursor-from-old-order' }),
        refreshed.preferences.shelf,
      );
      expect(implicit.display.layout).toBe('grid');
      expect(implicit.sort).toEqual({ orderBy: 'createdAt', direction: 'asc' });
      expect(implicit.cursorInvalidated).toBe(true);
      expect(implicit.search.cursor).toBeUndefined();
      const explicit = resolveShelfPresentation(
        validateShelfSearch({
          type: 'https://schema.org/Book',
          layout: 'list',
          size: 's',
          columns: 'title,status',
          orderBy: 'finishedAt',
          direction: 'asc',
          cursor: 'explicit-address-cursor',
        }),
        refreshed.preferences.shelf,
      );
      expect(explicit.display).toMatchObject({ layout: 'list', size: 's', columns: 'title,status' });
      expect(explicit.sort).toEqual({ orderBy: 'finishedAt', direction: 'asc' });
      expect(explicit.search.cursor).toBe('explicit-address-cursor');
      expect(patches).toHaveLength(2);

      await select(1, 'small');
      await click(m.settings_shelf_save());
      expect(host.textContent).toContain(m.settings_shelf_uncertain());
      await select(0, 'list');
      await click(m.settings_shelf_retry());
      expect(patches).toHaveLength(4);
      expect(patches[3]?.key).toBe(patches[2]?.key);
      expect(patches[3]?.body).toEqual(patches[2]?.body);
      expect(host.textContent).toContain(m.settings_shelf_review());
      expect((host.querySelectorAll('select')[0] as HTMLSelectElement).value).toBe('list');
      expect(confirmedVersion).toBe(7);
      await click(m.settings_shelf_save());
      expect(patches[4]?.body).toEqual({ expectedVersion: 7, shelf: { layouts: { all: 'list' } } });
      expect(confirmedVersion).toBe(8);

      await click(m.settings_shelf_reset());
      expect(patches[5]?.body).toEqual({ expectedVersion: 8, shelf: null });
      expect(Object.hasOwn(current, 'shelf')).toBe(false);
      expect(current.spoilerLevel).toBe(1);
      expect(current.suitability).toBe('show');
      expect(current.notifications).toEqual({ reply: true, mention: false });
      expect(confirmedVersion).toBe(9);
    } finally {
      await act(async () => root.unmount());
      owner.retire();
      queryClient.clear();
      globalThis.fetch = originalFetch;
      serverRequest = undefined;
      cloudflareEnv = {};
      mock.restore();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    }
  } catch (error) {
    throw error;
  }
});
