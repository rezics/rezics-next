import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode, useReducer } from 'react';
import definitions from '../src/kernel/recorded/definitions-release.json';
import type { PersonalLibraryEntry } from '../src/library/entries-read';
import type { Release } from '../src/subject/definitions';

// Source regression inputs at HTTP, not a native positive recording or a replacement mutation adapter.
test('the actual selected shelf uses the default authorized per-entry action, reports partial outcomes and recovers unknown writes with the same intent', async () => {
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
  const admitted = ['personal_library', 'reading_progress'];
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
  type Mode = 'mixed' | 'closed' | 'denied' | 'malformed' | 'success';
  let mode: Mode = 'mixed';
  const calls: { request: Request; body: Record<string, unknown> }[] = [];
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let active = 0;
  let maximumActive = 0;
  let unknownCalls = 0;
  const reads: string[] = [];
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
    if (req.method !== 'PUT' || !url.pathname.startsWith('/v1/libraryEntries/'))
      return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
    active++;
    maximumActive = Math.max(active, maximumActive);
    const body = (await req.clone().json()) as Record<string, unknown>;
    calls.push({ request: req.clone(), body });
    try {
      if (calls.length === 1) {
        firstStarted!();
        await first;
      }
      if (mode === 'closed') return Response.json({ code: 'platform_closed' }, { status: 403 });
      if (mode === 'denied') return Response.json({ code: 'insufficient_scope' }, { status: 403 });
      if (mode === 'malformed') return Response.json({});
      if (mode === 'mixed' && url.pathname.endsWith(id(2))) return Response.json({ code: 'conflict' }, { status: 409 });
      if (mode === 'mixed' && url.pathname.endsWith(id(3)) && ++unknownCalls === 1)
        throw new TypeError('response lost after commit');
      if (mode === 'mixed' && url.pathname.endsWith(id(5)))
        return Response.json({ code: 'not_found' }, { status: 404 });
      return Response.json({
        libraryEntry: {
          subjectId: url.pathname.split('/').at(-1),
          state: body.state,
          revision: Number(body.revision) + 1,
          incarnationId: body.incarnationId,
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      });
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
      return createElement(ShelfEntries, { entries, locale: 'en', layout, size: 'm', key: remount });
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
      button(m.library_selection_apply()).click();
    });
  };
  const outcome = (status: string) => host.querySelectorAll(`[data-selection-outcome="${status}"]`);
  const retry = async (title: string) => {
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(`button[aria-label="${m.library_selection_retry_title({ title })}"]`)!
        .click();
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
    expect(calls).toHaveLength(0);
    expect(host.querySelector('[aria-label="' + m.library_selection_heading() + '"]')).toBeNull();
    expect(host.querySelectorAll('[role="checkbox"][aria-label^="Work "]')).toHaveLength(5);
    expect(host.querySelectorAll('a[data-slot="cover-card-title"]')).toHaveLength(6);
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    expect(host.textContent).toContain(m.library_selection_count({ count: 5 }));
    await choose();
    // Hold the first command while a duplicate Apply and row selections are attempted.
    await act(async () => {
      button(m.library_selection_apply()).click();
      await started;
    });
    expect(calls).toHaveLength(1);
    expect(host.querySelectorAll('[data-selection-outcome]')).toHaveLength(5);
    await act(async () => {
      button(m.library_selection_applying()).click();
      host.querySelector<HTMLButtonElement>('[aria-label="Work 2"][aria-pressed]')!.click();
    });
    expect(calls).toHaveLength(1);
    await act(async () => {
      releaseFirst!();
      await first;
    });
    expect(maximumActive).toBe(1);
    expect(calls).toHaveLength(4);
    expect(outcome('changed')).toHaveLength(1);
    expect(outcome('conflicted')).toHaveLength(1);
    expect(outcome('unknown')).toHaveLength(1);
    expect(outcome('unchanged')).toHaveLength(1);
    expect(outcome('failed')).toHaveLength(1);
    expect(outcome('not-attempted')).toHaveLength(0);
    expect(host.textContent).toContain(m.library_conflict());
    expect(host.textContent).toContain(m.library_selection_count({ count: 2 }));
    const unknown = calls.find((call) => call.request.url.endsWith(id(3)))!;
    expect(unknown.body).toEqual({ state: chosen, revision: 2, incarnationId: id(903) });
    expect(calls.every((call) => call.request.headers.get('authorization') === 'Bearer owner-token')).toBe(true);
    expect(new Set(calls.map((call) => call.request.headers.get('idempotency-key'))).size).toBe(4);
    // A refused replay leaves the original uncertain command recoverable, with its exact identity.
    mode = 'denied';
    await retry('Work 3');
    expect(outcome('unknown')).toHaveLength(1);
    expect(calls.at(-1)!.request.headers.get('idempotency-key')).toBe(unknown.request.headers.get('idempotency-key'));
    mode = 'mixed';
    await retry('Work 3');
    expect(outcome('changed')).toHaveLength(2);
    expect(outcome('unknown')).toHaveLength(0);
    const recovered = calls.at(-1)!;
    expect(recovered.body).toEqual(unknown.body);
    expect(recovered.request.headers.get('idempotency-key')).toBe(unknown.request.headers.get('idempotency-key'));
    expect(sessionReads).toBeGreaterThanOrEqual(6);
    expect(reads).toEqual(['/v1/libraryEntries', `/v1/libraryEntries/${id(2)}`]);
    // A deliberate later command on the conflicted row uses the actual reload's revision/incarnation.
    mode = 'success';
    await choose();
    await apply();
    expect(calls.at(-1)!.body).toEqual({ state: chosen, revision: 9, incarnationId: id(999) });
    expect(calls.at(-1)!.request.headers.get('idempotency-key')).not.toBe(initial[1]!.changeKey);
    // The mounted unknown intent is discarded on replacement page data; no automatic effect retries it.
    entries = initial.map((entry) => ({ ...entry, incarnationId: id(800) }));
    remount++;
    await render();
    expect(host.querySelectorAll('[data-selection-outcome]')).toHaveLength(0);
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
    // Current native authority loss stops unsent targets; successful earlier commands are never rolled back.
    for (const refusal of ['closed', 'denied'] as const) {
      mode = refusal;
      layout = 'grid';
      remount++;
      await render();
      await act(async () => {
        button(m.library_selection_page()).click();
      });
      await choose();
      const count = calls.length;
      await apply();
      expect(calls).toHaveLength(count + 1);
      expect(outcome('failed')).toHaveLength(1);
      expect(outcome('not-attempted')).toHaveLength(4);
      if (refusal === 'closed') {
        // Recovery uses the captured second target, even after selecting only another entry.
        await act(async () => {
          button(m.library_selection_clear()).click();
        });
        await act(async () => {
          host.querySelector<HTMLButtonElement>('[aria-label="Work 5"][aria-pressed]')!.click();
        });
        mode = 'success';
        await retry('Work 2');
        expect(calls).toHaveLength(count + 2);
        expect(calls.at(-1)!.request.url).toEndWith(id(2));
        expect(calls.at(-1)!.body).toEqual({
          state: chosen,
          revision: initial[1]!.revision,
          incarnationId: initial[1]!.incarnationId,
        });
        expect(calls.at(-1)!.request.headers.get('idempotency-key')).toBe(initial[1]!.changeKey);
        expect(outcome('changed')).toHaveLength(1);
        expect(outcome('not-attempted')).toHaveLength(3);
        expect(host.textContent).toContain(m.library_selection_count({ count: 1 }));
      }
    }
    signedIn = false;
    mode = 'success';
    remount++;
    await render();
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    await choose();
    const count = calls.length;
    await apply();
    expect(calls).toHaveLength(count);
    expect(outcome('failed')).toHaveLength(1);
    expect(outcome('not-attempted')).toHaveLength(4);
    signedIn = true;
    // A resolved response without a saved entry is unknown and keeps its original key.
    mode = 'malformed';
    entries = [initial[0]!];
    remount++;
    await render();
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    await choose();
    await apply();
    expect(outcome('unknown')).toHaveLength(1);
    const malformed = calls.at(-1)!;
    mode = 'success';
    await act(async () => {
      button(m.library_selection_retry()).click();
    });
    expect(calls.at(-1)!.request.headers.get('idempotency-key')).toBe(malformed.request.headers.get('idempotency-key'));
    expect(outcome('changed')).toHaveLength(1);
    // An unresolved command must never be retried against replacement incarnation data.
    mode = 'malformed';
    remount++;
    await render();
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    await choose();
    await apply();
    expect(outcome('unknown')).toHaveLength(1);
    const unknownCount = calls.length;
    entries = [{ ...initial[0]!, incarnationId: id(888), changeKey: crypto.randomUUID() }];
    await render();
    expect(calls).toHaveLength(unknownCount);
    expect(host.querySelectorAll('[data-selection-outcome]')).toHaveLength(0);
    expect(button(m.library_selection_retry())).toBeUndefined();
    // A replacement loader array clears selection without relying on the caller's React key.
    await act(async () => {
      button(m.library_selection_page()).click();
    });
    entries = [{ ...initial[0]!, incarnationId: id(888) }];
    await render();
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelectorAll('[data-selection-outcome]')).toHaveLength(0);
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
    expect(reads).toEqual(['/v1/libraryEntries', `/v1/libraryEntries/${id(2)}`]);
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
