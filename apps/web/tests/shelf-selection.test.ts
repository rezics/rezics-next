import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode, useReducer } from 'react';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { PersonalLibraryEntry } from '../src/library/entries-read';
import type { Release } from '../src/subject/definitions';

// Source regression inputs at HTTP, not a native positive recording or a replacement mutation adapter.
test('the selected shelf reviews a persisted native status operation, confirms it deliberately, and recovers authoritative outcomes', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
  const csrfToken = 'a'.repeat(22);
  const admitted = [
    'personal_library',
    'reading_progress',
    'library_operation.preview',
    'library_operation.confirm',
    'library_operation.get',
    'library_operation.outcomes',
  ];
  let signedIn = true;
  let sessionReads = 0;
  const credential = async () => {
    sessionReads++;
    return signedIn
      ? { status: 'active', subject: id(700), accessToken: 'owner-token', csrfToken }
      : { status: 'absent' };
  };
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:read library_entry:update',
    WEBSITE_CLIENT_ID: 'selection-test',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: { idFromName: (value: string) => value, get: () => ({ credential, credentialIfFresh: credential }) },
  };
  const request = (method = 'GET', headers?: HeadersInit) =>
    new Request('https://site.test/en/library', {
      method,
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin: 'https://site.test',
        ...Object.fromEntries(new Headers(headers)),
      },
    });
  let currentRequest = request();
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => ({
    ...start,
    createServerFn(options: { method?: string } = {}) {
      const chain = start.createServerFn();
      return {
        ...chain,
        validator(validate: (input: unknown) => unknown) {
          chain.validator(validate);
          return this;
        },
        handler(handler: (...args: never[]) => unknown) {
          const execute = chain.handler(handler);
          return (input?: { headers?: HeadersInit }) => {
            currentRequest = request(options.method ?? 'GET', input?.headers);
            return execute(input as never);
          };
        },
      };
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => currentRequest, setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const { libraryStateOptions } = await import('../src/library/profiles');
  const { commonShelfStates, matchesShelfIntent, shelfStateIntent } = await import('../src/library/shelf-selection');
  const options = libraryStateOptions(definitions.release as unknown as Release, 'schema:Book', 'en');
  const before = options[0]!.id;
  const chosen = options[1]!.id;
  const stamp = '2026-01-01T00:00:00.000Z';
  const raw = (n: number, state = before) => ({
    subjectId: id(n),
    state,
    revision: 2,
    incarnationId: id(900 + n),
    createdAt: stamp,
    updatedAt: stamp,
    subject: {
      id: id(n),
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: `Work ${n}`, language: 'en' },
      cover: null,
    },
  });
  const source = [raw(1), raw(2), raw(3), raw(4, chosen), raw(5), { ...raw(6), subject: null }];
  const stateCalls: { request: Request; body: Record<string, unknown> }[] = [];
  const nativeCalls: { request: Request; body: Record<string, unknown> }[] = [];
  let confirmationAttempts = 0;
  const reads: string[] = [];
  const operationReads: string[] = [];
  const operation = (phase: string) => ({
    id: 'operation-1',
    route: 1,
    action: 'set_status',
    selectionKind: 'explicit',
    state: chosen,
    collectionId: null,
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: 5,
      selectedSubjects: 5,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 5,
      pending: 0,
      reconciling: 0,
      applied: 1,
      no_effect: 1,
      conflict: 1,
      denied: 1,
      failed: 1,
      cancelled: 0,
    },
    summary: null,
    admittedAt: stamp,
    targetBoundAt: stamp,
    expiresAt: stamp,
    resultsExpireAt: stamp,
    finishedAt: phase === 'completed' ? stamp : null,
    reason: null,
  });
  const targetOutcomes = [
    ['applied', null],
    ['conflict', 'revision_mismatch'],
    ['denied', 'target_denied'],
    ['no_effect', null],
    ['failed', 'dependency_unavailable'],
  ].map(([state, reason], index) => ({
    ordinal: String(index),
    subjectId: id(index + 1),
    memberId: null,
    state,
    reason,
    resultingMemberId: null,
  }));
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
    if (req.method === 'GET' && url.pathname === '/v1/libraryEntries') {
      reads.push(url.pathname);
      return Response.json({ libraryEntries: source, next: 'opaque-next' });
    }
    if (req.method === 'GET' && url.pathname === `/v1/libraryEntries/${id(2)}`) {
      reads.push(url.pathname);
      return Response.json({ libraryEntry: { ...raw(2), state: options[2]!.id, revision: 9, incarnationId: id(999) } });
    }
    if (req.method === 'POST' && url.pathname === '/v1/libraryOperations') {
      const body = (await req.clone().json()) as Record<string, unknown>;
      nativeCalls.push({ request: req.clone(), body });
      return Response.json({ operation: operation('preview') }, { status: 201 });
    }
    if (req.method === 'POST' && url.pathname === '/v1/libraryOperations/operation-1:confirm') {
      const body = (await req.clone().json()) as Record<string, unknown>;
      nativeCalls.push({ request: req.clone(), body });
      if (++confirmationAttempts === 1) throw new TypeError('confirmation response lost');
      return Response.json({ operation: operation('queued') });
    }
    if (req.method === 'GET' && url.pathname === '/v1/libraryOperations/operation-1') {
      operationReads.push(url.pathname);
      return Response.json({ operation: operation('completed') });
    }
    if (req.method === 'GET' && url.pathname === '/v1/libraryOperations/operation-1/outcomes') {
      operationReads.push(url.pathname);
      return Response.json({ outcomes: targetOutcomes, next: null });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/v1/libraryEntries/')) {
      const body = (await req.clone().json()) as Record<string, unknown>;
      stateCalls.push({ request: req.clone(), body });
      return Response.json({ code: 'unexpected_per_entry_write' }, { status: 500 });
    }
    return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
  }) as typeof fetch;
  const { readPersonalLibrary } = await import('../src/library/entries-actions');
  const { ShelfEntries } = await import('../src/library/shelf-view');
  const { PersonalShelfOrigin } = await import('../src/library/personal-shelf-origin');
  const originListeners = new Set<() => void>();
  let authorityCurrent = true;
  const shelfOrigin = {
    current: () => authorityCurrent,
    viewer: () => (authorityCurrent ? id(700) : null),
    capture: () => () => authorityCurrent,
    version: () => '0',
    watch: (listener: () => void) => {
      originListeners.add(listener);
      return () => originListeners.delete(listener);
    },
    headers: () => new Headers({ 'x-csrf-token': csrfToken }),
    epoch: () => '0',
    retains: () => authorityCurrent,
  };
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: id(700), csrfToken });
  client.setQueryData(exposureQuery.queryKey, admitted);
  let entries: PersonalLibraryEntry[] = [];
  let layout: 'grid' | 'list' | 'table' = 'grid';
  let remount = 0;
  let refreshView: (() => void) | undefined;
  const route = createRootRoute({
    component: () => {
      const [, refresh] = useReducer((value: number) => value + 1, 0);
      refreshView = refresh;
      return createElement(
        PersonalShelfOrigin.Provider,
        { value: shelfOrigin },
        createElement(ShelfEntries, { entries, locale: 'en', layout, size: 'm', key: remount }),
      );
    },
  });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/library'] }) });
  const render = async () => {
    await act(async () => {
      refreshView?.();
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })),
        ),
      );
    });
  };
  const button = (text: string) =>
    Array.from(host.querySelectorAll('button')).find((node) => node.textContent === text)!;
  const choose = async (state = chosen) => {
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select')!;
      select.value = state;
      select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    });
  };
  const apply = async () => {
    await act(async () => {
      button(m.library_bulk_status_review()).click();
    });
  };
  try {
    const page = await readPersonalLibrary({ data: {} });
    if (!page.signedIn) throw new Error('Expected owner page');
    entries = page.entries;
    const initial = entries;
    expect(commonShelfStates(entries.slice(0, 2))).toEqual(options);
    expect(
      commonShelfStates([
        initial[0]!,
        { ...initial[1]!, stateOptions: [{ ...options[0]!, label: { text: 'Different meaning', lang: 'en' } }] },
      ]),
    ).toEqual([]);
    expect(commonShelfStates([initial[0]!, { ...initial[1]!, stateOptions: [] }])).toEqual([]);
    const captured = shelfStateIntent(initial[0]!, chosen)!;
    expect(matchesShelfIntent({ ...initial[0]!, incarnationId: id(777) }, captured)).toBe(false);
    await router.load();
    await render();
    expect(nativeCalls).toHaveLength(0);
    expect(host.querySelector('[aria-label="' + m.library_selection_heading() + '"]')).toBeNull();
    expect(host.querySelectorAll('[role="checkbox"][aria-label^="Work "]')).toHaveLength(5);
    expect(host.querySelectorAll('a[data-slot="cover-card-title"]')).toHaveLength(6);
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    expect(host.textContent).toContain(m.library_selection_count({ count: 5 }));
    await choose();
    await apply();
    expect(nativeCalls).toHaveLength(1);
    expect(nativeCalls[0]!.body).toEqual({
      action: 'set_status',
      state: chosen,
      selection: {
        kind: 'explicit',
        targets: Array.from({ length: 5 }, (_, index) => ({ subjectId: id(index + 1) })),
      },
    });
    expect(nativeCalls[0]!.request.headers.get('authorization')).toBe('Bearer owner-token');
    expect(nativeCalls[0]!.request.headers.get('x-csrf-token')).toBe(csrfToken);
    expect(nativeCalls[0]!.request.headers.get('idempotency-key')).toBeTruthy();
    expect(stateCalls).toHaveLength(0);
    expect(host.textContent).toContain(
      m.library_bulk_status_review_summary({ count: 5, status: options[1]!.label.text }),
    );
    expect(button(m.library_bulk_status_confirm())).toBeDefined();

    // A requested status change retires the current review before confirmation.
    await choose(options[2]!.id);
    expect(button(m.library_bulk_status_confirm())).toBeUndefined();
    expect(host.textContent).toContain(m.library_bulk_status_review_required());
    await choose();
    await apply();
    expect(nativeCalls).toHaveLength(2);

    // A selection change also retires the review and requires another native preview.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Work 2"][aria-pressed]')!.click();
    });
    expect(button(m.library_bulk_status_confirm())).toBeUndefined();
    expect(host.textContent).toContain(m.library_bulk_status_review_required());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Work 2"][aria-pressed]')!.click();
    });
    await apply();
    expect(nativeCalls).toHaveLength(3);
    expect(button(m.library_bulk_status_confirm())).toBeDefined();

    // Confirmation is the only operation that starts native work, and an uncertain retry reuses its key/body.
    await act(async () => {
      button(m.library_bulk_status_confirm()).click();
    });
    expect(nativeCalls.filter(({ request }) => request.url.includes(':confirm'))).toHaveLength(1);
    expect(host.textContent).toContain(m.library_bulk_status_confirmation_uncertain());
    await act(async () => {
      button(m.library_bulk_status_retry_confirmation()).click();
    });
    const confirms = nativeCalls.filter(({ request }) => request.url.includes(':confirm'));
    expect(confirms).toHaveLength(2);
    expect(confirms[0]!.body).toEqual({});
    expect(confirms[1]!.body).toEqual(confirms[0]!.body);
    expect(confirms[1]!.request.headers.get('idempotency-key')).toBe(
      confirms[0]!.request.headers.get('idempotency-key'),
    );
    expect(confirms[1]!.request.headers.get('authorization')).toBe(confirms[0]!.request.headers.get('authorization'));
    expect(host.textContent).toContain(m.library_bulk_status_operation_id({ id: 'operation-1' }));
    expect(host.querySelectorAll('[data-bulk-status-outcome="applied"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-bulk-status-outcome="conflict"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-bulk-status-outcome="denied"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-bulk-status-outcome="no_effect"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-bulk-status-outcome="failed"]')).toHaveLength(1);
    expect(host.textContent).toContain(m.library_bulk_status_result_count({ status: m.library_bulk_status_applied(), count: 1 }));
    expect(host.textContent).toContain(m.library_bulk_status_result_count({ status: m.library_bulk_status_conflict(), count: 1 }));
    expect(host.textContent).toContain(m.library_bulk_status_result_count({ status: m.library_bulk_status_skipped(), count: 1 }));
    expect(stateCalls).toHaveLength(0);
    expect(initial.map(({ state }) => state)).toEqual([before, before, before, chosen, before, before]);

    // Recovery is read-only and does not submit another confirmation.
    const confirmCount = confirms.length;
    const recoveryReadCount = operationReads.length;
    await act(async () => {
      button(m.library_bulk_status_recover()).click();
    });
    expect(nativeCalls.filter(({ request }) => request.url.includes(':confirm'))).toHaveLength(confirmCount);
    expect(operationReads.length).toBeGreaterThan(recoveryReadCount);

    // Replacing the loaded page retires its prior selection and completion.
    entries = initial.map((entry) => ({ ...entry, incarnationId: id(800) }));
    remount++;
    await render();
    expect(host.querySelectorAll('[data-bulk-status-outcome]')).toHaveLength(0);
    expect(host.querySelector('select')).toBeNull();
    // All layouts use the same bounded selection, including the table's phone list fallback.
    for (const nextLayout of ['list', 'table'] as const) {
      layout = nextLayout;
      remount++;
      await render();
      await act(async () => {
        button(m.library_selection_page()).click();
      });
      expect(host.querySelector('[role="checkbox"][aria-label="Work 1"]')).not.toBeNull();
      expect(host.textContent).toContain(m.library_selection_count({ count: 5 }));
    }
    // A viewer that has left this shelf cannot read or apply its mounted completion.
    layout = 'grid';
    remount++;
    await render();
    await act(async () => button(m.library_selection_page()).click());
    await choose();
    await apply();
    const staleConfirm = button(m.library_bulk_status_confirm());
    expect(staleConfirm).toBeDefined();
    const confirmationCount = nativeCalls.filter(({ request }) => request.url.includes(':confirm')).length;
    authorityCurrent = false;
    await act(async () => {
      originListeners.forEach((listener) => listener());
      refreshView?.();
    });
    expect(host.textContent).not.toContain(m.library_bulk_status_operation_id({ id: 'operation-1' }));
    await act(async () => staleConfirm.click());
    expect(nativeCalls.filter(({ request }) => request.url.includes(':confirm'))).toHaveLength(confirmationCount);
    authorityCurrent = true;
    await render();
    // Selection is capped independently of the loaded input size and never discovers another page.
    entries = Array.from({ length: 101 }, (_, index) => ({
      ...initial[0]!,
      subjectId: id(2000 + index),
      subject: {
        ...initial[0]!.subject!,
        id: id(2000 + index),
        label: { value: `Bounded work ${index}`, language: 'en' },
      },
    }));
    await render();
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    expect(host.textContent).toContain(m.library_selection_count({ count: 100 }));
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="Bounded work 100"][aria-pressed]')!.click();
    });
    expect(host.textContent).toContain(m.library_selection_count({ count: 100 }));
    expect(reads).toEqual(['/v1/libraryEntries']);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
