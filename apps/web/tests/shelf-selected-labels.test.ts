import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode, useReducer } from 'react';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { PersonalLibraryEntry } from '../src/library/entries-read';
import type { Release } from '../src/subject/definitions';

// Constructed native-shaped HTTP inputs exercise the default composition; they are not native proof.
test('selected loaded entries use ordinary paged label search and serialized assignment, retain exact unknown recovery and stop at a changed page or owner', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/library', width: 1280, height: 900 });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
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
    'library_label.list',
    'library_label.assign',
    'library_operation.preview',
    'library_operation.confirm',
    'library_operation.get',
    'library_operation.outcomes',
  ];
  let owner = id(700);
  const credential = async () => ({ status: 'active', subject: owner, accessToken: owner, csrfToken });
  const sessionEnv = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'library_entry:read library_entry:list library_entry:update',
    WEBSITE_CLIENT_ID: 'selected-labels-test',
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
  const bffWrites: Request[] = [];
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
            if (options.method === 'POST') bffWrites.push(currentRequest.clone());
            return execute(input as never);
          };
        },
      };
    },
  }));
  mock.module('@tanstack/react-start/server', () => ({ getRequest: () => currentRequest, setResponseHeader() {} }));
  mock.module('cloudflare:workers', () => ({ env: sessionEnv }));
  const { libraryStateOptions } = await import('../src/library/profiles');
  const options = libraryStateOptions(definitions.release as unknown as Release, 'schema:Book', 'en');
  const stamp = '2026-01-01T00:00:00.000Z';
  const raw = (n: number) => ({
    subjectId: id(n),
    state: options[0]!.id,
    revision: 2,
    incarnationId: id(900 + n),
    createdAt: stamp,
    updatedAt: stamp,
    lastActivityAt: stamp,
    subject: {
      id: id(n),
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: `Work ${n}`, language: 'en' },
      cover: null,
    },
  });
  const source = [raw(1), raw(2), raw(3), { ...raw(4), subject: null }];
  const label = { id: id(800), name: 'Books to revisit', revision: 3 };
  const catalogue = Array.from({ length: 20 }, (_, n) => ({ id: id(810 + n), name: `Reading ${n}`, revision: 1 }));
  const reads: URL[] = [];
  const calls: { request: Request; body: unknown }[] = [];
  const stateCalls: { request: Request; body: unknown }[] = [];
  const bulkCalls: { request: Request; body: unknown }[] = [];
  const operation = (phase: string) => ({
    id: 'bulk-1',
    route: 1,
    action: 'set_status',
    selectionKind: 'explicit',
    state: options[1]!.id,
    collectionId: null,
    phase,
    selectionComplete: true,
    occurrencesComplete: true,
    cancelRequested: false,
    counts: {
      scannedCandidates: 1,
      selectedSubjects: 1,
      scannedOccurrences: 0,
      capturedOccurrences: 0,
      targets: 1,
      pending: 0,
      reconciling: 0,
      applied: 0,
      no_effect: 0,
      conflict: 0,
      denied: 0,
      failed: 0,
      cancelled: 0,
    },
    summary: null,
    admittedAt: stamp,
    targetBoundAt: stamp,
    expiresAt: stamp,
    resultsExpireAt: stamp,
    finishedAt: null,
    reason: null,
  });
  let mode: 'partial' | 'success' | 'held' | 'unknown' = 'partial';
  let releaseWrite: (() => void) | undefined;
  let releaseSearch: (() => void) | undefined;
  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === '/v1/definitions/active') return Response.json({ digest: definitions.digest });
    if (url.pathname.startsWith('/v1/definitions/releases/')) return Response.json(definitions);
    if (url.pathname === '/v1/platform/exposure') return Response.json({ admitted });
    if (req.method === 'GET') {
      reads.push(url);
      if (url.pathname === '/v1/libraryEntries') return Response.json({ libraryEntries: source, next: 'entry-next' });
      if (url.pathname === '/v1/libraryOperations/bulk-1') return Response.json({ operation: operation('preview') });
      if (url.pathname === '/v1/libraryOperations/bulk-1/outcomes') return Response.json({ outcomes: [], next: null });
      if (url.pathname === '/v1/libraryLabels') {
        expect(req.headers.get('authorization')).toBe(`Bearer ${owner}`);
        expect(url.searchParams.get('limit')).toBe('20');
        if (url.searchParams.get('q') === 'stale') {
          await new Promise<void>((resolve) => {
            releaseSearch = resolve;
          });
          return Response.json({ labels: [{ ...label, id: id(999), name: 'Wrong stale label' }], next: null });
        }
        if (url.searchParams.get('q')) return Response.json({ labels: [label], next: null });
        if (url.searchParams.get('cursor') === 'signed-label-next')
          return Response.json({ labels: [label], next: null });
        return Response.json({ labels: catalogue, next: 'signed-label-next' });
      }
      throw new Error(`Unexpected fanout read: ${url.pathname}`);
    }
    if (req.method === 'PUT' && url.pathname === `/v1/libraryEntries/${id(1)}`) {
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        const body = (await req.clone().json()) as { state: string; revision: number; incarnationId: string };
        stateCalls.push({ request: req.clone(), body });
        return Response.json({
          libraryEntry: { subjectId: id(1), ...body, revision: body.revision + 1, updatedAt: stamp },
        });
      } finally {
        active--;
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/libraryOperations') {
      bulkCalls.push({ request: req.clone(), body: await req.clone().json() });
      return Response.json({ operation: operation('preview') }, { status: 201 });
    }
    if (req.method === 'POST' && url.pathname === '/v1/libraryOperations/bulk-1:confirm') {
      bulkCalls.push({ request: req.clone(), body: await req.clone().json() });
      return Response.json({ operation: operation('queued') });
    }
    expect(req.method).toBe('POST');
    expect(url.pathname).toBe(`/v1/libraryLabels/${label.id}:assign`);
    active++;
    maximumActive = Math.max(maximumActive, active);
    const body = (await req.clone().json()) as { subjectId: string };
    calls.push({ request: req.clone(), body });
    try {
      if (calls.length === 1 || mode === 'held')
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
      if (mode === 'unknown' || (mode === 'partial' && body.subjectId === id(2)))
        return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
      return Response.json({ assignment: { id: id(1000 + calls.length), revision: 1 } });
    } finally {
      active--;
    }
  }) as typeof fetch;
  const { readPersonalLibrary } = await import('../src/library/entries-actions');
  const { ShelfEntries } = await import('../src/library/shelf-view');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: owner, csrfToken });
  client.setQueryData(exposureQuery.queryKey, admitted);
  let entries: PersonalLibraryEntry[] = [];
  let refreshView: (() => void) | undefined;
  const route = createRootRoute({
    component: () => {
      const [, refresh] = useReducer((value: number) => value + 1, 0);
      refreshView = refresh;
      return createElement(ShelfEntries, { entries, locale: 'en', layout: 'grid', size: 'm' });
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
    Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((node) => node.textContent === text)!;
  const click = async (node: HTMLElement) => {
    await act(async () => {
      node.click();
    });
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  };
  const input = async (value: string) => {
    await act(async () => {
      const node = document.querySelector<HTMLInputElement>('[role="dialog"] input:not([type="checkbox"])')!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(node, value);
      node.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    });
  };
  const outcome = (status: string) => host.querySelectorAll(`[data-label-outcome="${status}"]`);
  const choose = async () => {
    const row = Array.from(document.querySelectorAll('[role="dialog"] li')).find(
      (node) => node.textContent === label.name,
    )!;
    await click(row.querySelector<HTMLElement>('[role="checkbox"]')!);
  };
  const open = async () => {
    await click(button(m.library_selected_labels_open()));
    await settle();
  };
  try {
    const page = await readPersonalLibrary({ data: {} });
    expect(page.signedIn).toBe(true);
    entries = page.entries;
    const initial = entries;
    await router.load();
    await render();
    await settle();
    expect(reads.map((url) => url.pathname)).toEqual(['/v1/libraryEntries']);
    expect(calls).toHaveLength(0);
    await click(button(m.library_selection_page()));
    expect(host.textContent).toContain(m.library_selection_count({ count: 3 }));
    await act(async () => {
      const select = host.querySelector<HTMLSelectElement>('select')!;
      select.value = options[1]!.id;
      select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    });
    expect(button(m.library_selection_apply()).disabled).toBe(false);
    await open();
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(20);
    await click(document.querySelector<HTMLElement>('[role="dialog"] [role="checkbox"]')!);
    expect(button(m.library_selected_labels_apply()).disabled).toBe(false);
    await click(button(m.library_label_more()));
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(1);
    expect(button(m.library_selected_labels_apply()).disabled).toBe(true);
    expect(reads.at(-1)!.searchParams.get('cursor')).toBe('signed-label-next');
    // A query invalidates its previous result immediately, including a response arriving after another query.
    await input('stale');
    await settle();
    expect(releaseSearch).toBeDefined();
    await input('Books');
    await settle();
    await act(async () => {
      releaseSearch!();
    });
    expect(document.body.textContent).not.toContain('Wrong stale label');
    await choose();
    expect(document.body.textContent).toContain(m.library_selected_labels_confirm({ name: label.name, count: 3 }));
    const apply = button(m.library_selected_labels_apply());
    await act(async () => {
      apply.click();
      apply.click();
    });
    expect(calls).toHaveLength(1);
    expect(active).toBe(1);
    expect(button(m.library_selection_applying()).disabled).toBe(true);
    expect(button(m.library_selected_labels_open()).disabled).toBe(true);
    await click(button(m.library_selection_applying()));
    expect(calls).toHaveLength(1);
    expect(stateCalls).toHaveLength(0);
    await act(async () => {
      releaseWrite!();
    });
    expect(calls.map((call) => call.body)).toEqual([{ subjectId: id(1) }, { subjectId: id(2) }]);
    expect(outcome('assigned')).toHaveLength(1);
    expect(outcome('unknown')).toHaveLength(1);
    expect(outcome('not-attempted')).toHaveLength(1);
    expect(host.textContent).toContain(m.library_selection_count({ count: 3 }));
    expect(calls[0]!.request.headers.get('idempotency-key')).not.toBe(calls[1]!.request.headers.get('idempotency-key'));
    expect(calls.every((call) => call.request.headers.get('authorization') === `Bearer ${owner}`)).toBe(true);
    expect(bffWrites.every((req) => req.headers.get('X-CSRF-Token') === csrfToken)).toBe(true);
    const unknown = calls[1]!;
    mode = 'success';
    await click(button(m.library_selected_labels_retry()));
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)!.body).toEqual(unknown.body);
    expect(calls.at(-1)!.request.url).toBe(unknown.request.url);
    expect(calls.at(-1)!.request.headers.get('idempotency-key')).toBe(unknown.request.headers.get('idempotency-key'));
    expect(outcome('assigned')).toHaveLength(2);
    expect(outcome('unknown')).toHaveLength(0);
    expect(outcome('not-attempted')).toHaveLength(1);
    // A later state command still carries the pre-assignment identity and key; unsent label targets stay unsent.
    expect(calls.some((call) => (call.body as { subjectId: string }).subjectId === id(3))).toBe(false);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Work 2"][aria-pressed]')!);
    await click(host.querySelector<HTMLButtonElement>('[aria-label="Work 3"][aria-pressed]')!);
    await click(button(m.library_bulk_status_review()));
    expect(bulkCalls).toHaveLength(1);
    expect(bulkCalls[0]!.body).toEqual({
      action: 'set_status',
      state: options[1]!.id,
      selection: { kind: 'explicit', targets: [{ subjectId: id(1) }] },
    });
    expect(stateCalls).toHaveLength(0);
    expect(button(m.library_bulk_status_confirm())).toBeDefined();
    expect(bulkCalls[0]!.request.headers.get('authorization')).toBe(`Bearer ${owner}`);
    await click(button(m.library_selection_page()));
    mode = 'held';
    await open();
    await click(button(m.library_label_more()));
    await choose();
    await click(button(m.library_selected_labels_apply()));
    expect(calls).toHaveLength(4);
    entries = [{ ...initial[0]!, subjectId: id(9), incarnationId: id(909), subject: raw(9).subject }];
    await render();
    expect(button(m.library_selection_page()).disabled).toBe(true);
    expect(host.querySelectorAll('[data-label-outcome]')).toHaveLength(0);
    mode = 'success';
    await act(async () => {
      releaseWrite!();
    });
    expect(calls).toHaveLength(4);
    expect(button(m.library_selection_page()).disabled).toBe(false);
    expect(host.querySelectorAll('[data-label-outcome]')).toHaveLength(0);
    // A retained unknown command also cannot be carried into another owner's render.
    await click(button(m.library_selection_page()));
    mode = 'unknown';
    await open();
    await click(button(m.library_label_more()));
    await choose();
    await click(button(m.library_selected_labels_apply()));
    expect(outcome('unknown')).toHaveLength(1);
    const oldRetry = button(m.library_selected_labels_retry());
    const beforeOwnerChange = calls.length;
    owner = id(701);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: owner, csrfToken });
    });
    await render();
    await click(oldRetry);
    expect(calls).toHaveLength(beforeOwnerChange);
    expect(host.querySelectorAll('[data-label-outcome]')).toHaveLength(0);
    expect(button(m.library_selected_labels_retry())).toBeUndefined();
    expect(maximumActive).toBe(1);
    expect(reads.filter((url) => url.pathname === '/v1/libraryEntries')).toHaveLength(1);
    expect(reads.every((url) => ['/v1/libraryEntries', '/v1/libraryLabels'].includes(url.pathname))).toBe(true);
  } finally {
    releaseWrite?.();
    releaseSearch?.();
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
