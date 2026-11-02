import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ReactNode } from 'react';
import * as bridge from '../.storybook/react-start';

// Complete connected campaign, authored UNRUN. Only platform credentials and native HTTP are
// deferred. These are the actual route loaders, server-function handlers, clients and consumers.
// JSON transfer/createRoot below is deliberately not a hydrateRoot/private-first-paint proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/boards/one/moderation' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  matchMedia: window.matchMedia.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const token = 'AAAAAAAAAAAAAAAAAAAAAA';
const seed = (csrfToken: string | null = token) => ({ state: 'signed-in' as const, subject: id(1), csrfToken });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let preparedToken: string | null;
let preparedSubject: string;
let preparationOutage: boolean;
let authenticated: boolean;
let credentialGate: ReturnType<typeof deferred<void>> | undefined;
let nativeGate: ReturnType<typeof deferred<void>> | undefined;
let commandGate: ReturnType<typeof deferred<Response>> | undefined;
let credentials: number;
let explicitAuthorization: boolean;
let request: Request;
const environment = {
  KERNEL_ORIGIN: 'https://kernel.test',
  SITE_ORIGINS: 'https://site.test',
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: '{}',
  SESSIONS: {
    idFromName: (name: string) => name,
    get: () => ({
      credential: async () => {
        credentials++;
        const result = {
          status: 'active',
          subject: preparedSubject,
          accessToken: 'opaque-native-credential',
          csrfToken: preparedToken,
        };
        await credentialGate?.promise;
        if (preparationOutage) throw new TypeError('Platform unavailable');
        return authenticated ? result : { status: 'absent' };
      },
    }),
  },
};
mock.module('cloudflare:workers', () => ({ env: environment }));
mock.module('@tanstack/react-start', () => ({
  ...bridge,
  createServerFn(options: { method: string }) {
    const local = bridge.createServerFn();
    const chain = {
      validator(validate: (input: unknown) => unknown) {
        local.validator(validate);
        return chain;
      },
      handler(handler: (...args: never[]) => unknown) {
        const invoke = local.handler(handler);
        return (input?: { data?: unknown; headers?: HeadersInit }) => {
          const headers = new Headers(input?.headers);
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          if (explicitAuthorization) headers.set('authorization', 'Bearer unprepared-credential');
          request = new Request(window.location.href, { method: options.method, headers });
          return invoke(input as never);
        };
      },
    };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => ({ ...bridge, getRequest: () => request }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, QueryObserver } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { ModerationReportsPage } = await import('../src/moderation/reports-page');
const { ModerationAppealsPage } = await import('../src/moderation/appeals-tab');
const { DecisionPageView } = await import('../src/moderation/decision-page');
const { ReporterStatusCurrent } = await import('../src/moderation/reporter-status-view');
const { Route: boardRoute } = await import('../src/routes/boards/$id_.moderation');
const { Route: decisionRoute } = await import('../src/routes/moderation/decisions.$id');
const { Route: reporterRoute } = await import('../src/routes/moderation/reports.$id');
const { prepareModerationReportRead } = await import('../src/moderation/reports-read');
const { loadModerationAppealsRequest } = await import('../src/moderation/appeals-read');
const { loadDecisionPageRequest } = await import('../src/moderation/decision-read');
const { loadReporterStatusRequest } = await import('../src/moderation/reporter-status-read');
const scope = {
  boardId: id(10),
  threadId: id(11),
  postId: id(12),
  status: 'pending' as const,
  targetKind: 'post' as const,
  order: 'oldest' as const,
  cursor: 'opaque+/cursor==',
};
const report = {
  id: id(20),
  target: { kind: 'post' as const, id: id(12) },
  revisionId: id(30),
  reason: 'other',
  evidence: 'PRIVATE submitted report evidence',
  createdAt: '2026-10-28T10:00:00.000Z',
  outcome: null,
  resolvedAt: null,
};
const appeal = {
  id: id(40),
  decisionId: id(50),
  appellantId: id(2),
  statement: 'PRIVATE complete appeal statement',
  createdAt: '2026-10-29T10:00:00.000Z',
  canResolve: true,
  decision: { statement: 'PRIVATE original decision statement', target: report.target },
};
const decision = {
  id: id(50),
  targetKind: 'post' as const,
  targetId: id(12),
  action: 'takedown' as const,
  statement: 'PRIVATE current decision statement',
  decidedAt: '2026-10-28T10:00:00.000Z',
  appealDeadline: '2027-04-28T10:00:00.000Z',
  appeal: null,
};
let reports = [report];
let appeals = [appeal];
let continuation: string | null;
let responseStatus: number;
let platformClosed: boolean;
let ownReporter: string;
let resolved: boolean;
const nativeReads: Request[] = [];
const nativeWrites: Request[] = [];
const originalFetch = globalThis.fetch;
const fetchNative: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = new Request(input, init);
    const path = new URL(current.url).pathname;
    expect(current.headers.get('authorization')).toBe('Bearer opaque-native-credential');
    if (current.method === 'POST' && path !== '/v1/media/presentations') {
      nativeWrites.push(current);
      if (commandGate) return commandGate.promise;
      resolved = true;
      return Response.json({}, { status: 200 });
    }
    nativeReads.push(current);
    expect(current.cache).toBe('no-store');
    const status = responseStatus;
    const closed = platformClosed;
    const body = path.endsWith('/reports')
      ? { reports, next: continuation }
      : path.endsWith('/appeals')
        ? { appeals, next: continuation }
        : path.startsWith('/v1/moderation-decisions/')
          ? decision
          : path.startsWith('/v1/reports/')
            ? { report: { ...report, reporterId: ownReporter, reason: 'other', targetAvailability: 'unavailable' } }
            : null;
    if (body) {
      await nativeGate?.promise;
      if (status !== 200)
        return Response.json(
          {
            code: closed ? 'platform_closed' : status === 409 ? 'stale_cursor' : 'forbidden',
            detail: 'NEVER DISCLOSE',
          },
          { status },
        );
      return Response.json(body);
    }
    return Response.json({ code: 'not_found', detail: 'PRIVATE target withheld' }, { status: 404 });
  },
  { preconnect: originalFetch.preconnect },
);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
let cache: InstanceType<typeof QueryClient>;
let abort: AbortController;
let root: ReturnType<typeof createRoot>;
let mounted: boolean;
let navigationCurrent: boolean;
let navigations: string[];
const navigationListeners = new Set<() => void>();
const navigation = {
  isCurrent: () => navigationCurrent,
  subscribe(listener: () => void) {
    navigationListeners.add(listener);
    return () => {
      navigationListeners.delete(listener);
    };
  },
};
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
type Kind = 'reports' | 'appeals' | 'decision' | 'reporter';
type ReportsPage = Awaited<ReturnType<typeof prepareModerationReportRead>>;
type AppealsPage = Awaited<ReturnType<typeof loadModerationAppealsRequest>>;
type DecisionPage = Awaited<ReturnType<typeof loadDecisionPageRequest>>;
type ReporterPage = Awaited<ReturnType<typeof loadReporterStatusRequest>>;
type Page = ReportsPage | AppealsPage | DecisionPage | ReporterPage;
const kinds: Kind[] = ['reports', 'appeals', 'decision', 'reporter'];
const location = { href: window.location.href, state: { __TSR_key: 'original-navigation' } };
async function load(kind: Kind, client = cache): Promise<Page> {
  // Execute the actual production loader, including preparation-before-await and the original signal.
  const route = kind === 'decision' ? decisionRoute : kind === 'reporter' ? reporterRoute : boardRoute;
  const loader = route.options.loader as unknown as (input: unknown) => Promise<Page>;
  return loader({
    params: { id: kind === 'decision' ? decision.id : kind === 'reporter' ? report.id : scope.boardId },
    deps: {
      status: scope.status,
      targetKind: scope.targetKind,
      order: scope.order,
      thread: scope.threadId,
      post: scope.postId,
      cursor: scope.cursor,
      ...(kind === 'appeals' ? { tab: 'appeals' } : {}),
    },
    context: { queryClient: client },
    abortController: abort,
    location,
  });
}
function view(kind: Kind, page: Page): ReactNode {
  if (kind === 'reports')
    return (
      <ModerationReportsPage
        page={page as ReportsPage}
        input={scope}
        navigation={navigation}
        onNext={(cursor) => navigations.push(cursor)}
      />
    );
  if (kind === 'appeals')
    return (
      <ModerationAppealsPage
        page={page as AppealsPage}
        input={scope}
        navigation={navigation}
        onNext={(cursor) => navigations.push(cursor)}
      />
    );
  if (kind === 'decision')
    return <DecisionPageView page={page as DecisionPage} navigation={navigation} now={Date.parse('2026-11-01')} />;
  return <ReporterStatusCurrent initial={page as ReporterPage} navigation={navigation} />;
}
async function paint(kind: Kind, page: Page, provider = cache) {
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={provider}>{view(kind, page)}</QueryClientProvider>
      </StrictMode>,
    );
    await tick();
  });
}
const evidence = (kind: Kind) =>
  kind === 'appeals' ? appeal.statement : kind === 'decision' ? decision.statement : report.evidence;
function hidden(kind: Kind) {
  expect(host.textContent).not.toContain(evidence(kind));
  expect(host.textContent).not.toContain('NEVER DISCLOSE');
  expect(host.querySelector('textarea')).toBeNull();
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
    await tick();
  });
}
async function type(text: string) {
  const field = host.querySelector('textarea')!;
  expect(field).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text);
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}
const createCache = (session = seed()) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, session);
  return client;
};
beforeEach(() => {
  preparedToken = token;
  preparedSubject = id(1);
  preparationOutage = false;
  authenticated = true;
  credentials = 0;
  credentialGate = undefined;
  nativeGate = undefined;
  commandGate = undefined;
  explicitAuthorization = false;
  reports = [report];
  appeals = [appeal];
  continuation = 'opaque-next+/==';
  responseStatus = 200;
  platformClosed = false;
  ownReporter = id(1);
  resolved = false;
  nativeReads.length = 0;
  nativeWrites.length = 0;
  navigationCurrent = true;
  navigationListeners.clear();
  navigations = [];
  cache = createCache();
  abort = new AbortController();
  globalThis.fetch = fetchNative;
  root = createRoot(host);
  mounted = true;
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  abort.abort();
  cache.clear();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const kind of kinds) {
  test(`${kind}: actual once-prepared origin, bounded native reads and default structural sharing remain healthy`, async () => {
    for (let n = 0; n < 3; n++) {
      const before = nativeReads.length;
      const next = await load(kind);
      expect(next.readerOrigin).toEqual({ subject: id(1), csrfFingerprint: await privateReaderFingerprint(token) });
      expect(credentials).toBe(n + 1);
      expect(JSON.stringify(next)).not.toContain(token);
      expect(JSON.stringify(next)).not.toContain('opaque-native-credential');
      cache.setQueryData(['private-moderation', kind], next);
      const committed = cache.getQueryData<Page>(['private-moderation', kind])!;
      await paint(kind, committed);
      expect(host.textContent).toContain(evidence(kind));
      const count = nativeReads.length;
      expect(count - before).toBe(kind === 'reports' ? 3 : kind === 'appeals' ? 2 : kind === 'decision' ? 3 : 1);
      await paint(kind, { ...committed });
      // Observer activity is ordinary; no session success is committed here. Keep this extra
      // observer disabled so it cannot introduce an identity read on a later mount.
      const observer = new QueryObserver(cache, { ...sessionQuery, enabled: false });
      const stop = observer.subscribe(() => {});
      await act(async () => {
        observer.setOptions({ ...sessionQuery, enabled: false });
      });
      expect(host.textContent).toContain(evidence(kind));
      stop();
      expect(nativeReads).toHaveLength(count);
      expect(nativeWrites).toHaveLength(0);
    }
  });

  test(`${kind}: same subject with different actual prepared CSRF is refused without extra authentication`, async () => {
    preparedToken = 'BBBBBBBBBBBBBBBBBBBBBA';
    const pending = load(kind);
    if (kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
    else {
      await paint(kind, await pending);
      hidden(kind);
    }
    expect(credentials).toBe(1);
    expect(nativeWrites).toHaveLength(0);
  });

  test(`${kind}: matching fingerprint cannot admit a different actual prepared subject`, async () => {
    preparedSubject = id(2);
    const pending = load(kind);
    if (kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
    else {
      await paint(kind, await pending);
      hidden(kind);
    }
    expect(credentials).toBe(1);
    expect(nativeWrites).toHaveLength(0);
  });

  test(`${kind}: unprepared explicit bearer has no origin and performs zero native reads`, async () => {
    explicitAuthorization = true;
    const pending = load(kind);
    if (kind === 'reports' || kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
    else {
      const page = await pending;
      expect(page.readerOrigin).toBeNull();
      await paint(kind, page);
      hidden(kind);
    }
    expect(credentials).toBe(0);
    expect(nativeReads).toHaveLength(0);
    expect(nativeWrites).toHaveLength(0);
  });

  test(`${kind}: anonymous actual preparation has no origin and performs zero native reads`, async () => {
    authenticated = false;
    const pending = load(kind);
    if (kind === 'reports' || kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
    else {
      await paint(kind, await pending);
      hidden(kind);
    }
    expect(credentials).toBe(1);
    expect(nativeReads).toHaveLength(0);
    expect(nativeWrites).toHaveLength(0);
  });

  for (const state of ['unknown', 'preparing', 'signed-out'] as const) {
    test(`${kind}: a ${state} original browser observation cannot borrow the prepared subject`, async () => {
      cache.setQueryData(['session'], { state, subject: null, csrfToken: null });
      const pending = load(kind);
      if (kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
      else {
        await paint(kind, await pending);
        hidden(kind);
      }
      expect(credentials).toBe(1);
      expect(nativeWrites).toHaveLength(0);
    });
  }

  test(`${kind}: a loaded receipt without actual origin cannot disclose or send a command`, async () => {
    const page = await load(kind);
    // Alter only the transported DTO. The production loader/lifetime performs admission.
    const missing = { ...page, readerOrigin: null } as Page;
    await paint(kind, missing);
    hidden(kind);
    expect(credentials).toBe(1);
    expect(nativeWrites).toHaveLength(0);
  });

  for (const refusal of [401, 403, 404, 'platform-closed'] as const) {
    test(`${kind}: native ${refusal} conceals evidence and native diagnostic bytes`, async () => {
      responseStatus = refusal === 'platform-closed' ? 403 : refusal;
      platformClosed = refusal === 'platform-closed';
      const pending = load(kind);
      if (kind === 'decision') await expect(pending).rejects.toBeDefined();
      else {
        await paint(kind, await pending);
        hidden(kind);
      }
      expect(nativeReads).toHaveLength(1);
      expect(credentials).toBe(1);
      expect(nativeWrites).toHaveLength(0);
    });
  }

  test(`${kind}: ordinary session fetch-start notifications preserve evidence until external success`, async () => {
    await paint(kind, await load(kind));
    const session = deferred<ReturnType<typeof seed>>();
    const count = nativeReads.length;
    let fetch!: Promise<ReturnType<typeof seed>>;
    await act(async () => {
      fetch = cache.fetchQuery({ queryKey: ['session'], queryFn: () => session.promise, staleTime: 0 });
    });
    expect(host.textContent).toContain(evidence(kind));
    expect(credentials).toBe(1);
    expect(nativeReads).toHaveLength(count);
    await act(async () => {
      session.resolve(seed());
      await fetch;
    });
    hidden(kind);
    expect(nativeReads).toHaveLength(count);
    expect(nativeWrites).toHaveLength(0);
  });

  test(`${kind}: abort before preparation performs zero authentication and native reads`, async () => {
    abort.abort();
    await expect(load(kind)).rejects.toBeDefined();
    expect(credentials).toBe(0);
    expect(nativeReads).toHaveLength(0);
  });

  test(`${kind}: abort while the actual credential is pending cannot create a mounted reader`, async () => {
    credentialGate = deferred<void>();
    const pending = load(kind);
    await tick();
    expect(credentials).toBe(1);
    abort.abort();
    credentialGate.resolve();
    await expect(pending).rejects.toBeDefined();
    expect(nativeWrites).toHaveLength(0);
    const count = nativeReads.length;
    abort = new AbortController();
    credentialGate = undefined;
    await paint(kind, await load(kind));
    expect(host.textContent).toContain(evidence(kind));
    expect(nativeReads.length - count).toBe(
      kind === 'reports' ? 3 : kind === 'appeals' ? 2 : kind === 'decision' ? 3 : 1,
    );
  });

  test(`${kind}: matching distinguished null admits reads and sends zero native commands`, async () => {
    // Accepted 924 explicitly replaces the old initial-missing-CSRF denial oracle. A later
    // transition to null remains retirement, tested separately below.
    preparedToken = null;
    cache.setQueryData(['session'], seed(null));
    const page = await load(kind);
    await paint(kind, page);
    expect(host.textContent).toContain(evidence(kind));
    expect(page.readerOrigin?.csrfFingerprint).toBe(await privateReaderFingerprint(null));
    const count = nativeReads.length;
    if (kind === 'reports') {
      await click(m.moderation_queue_review());
      await click(m.moderation_dismiss());
    }
    if (kind === 'appeals' || kind === 'decision') {
      await type('A read without a command token');
      const action = button(kind === 'appeals' ? m.moderation_appeal_uphold_action() : m.decision_appeal_submit());
      await act(async () => action.click());
    }
    expect(nativeWrites).toHaveLength(0);
    expect(nativeReads).toHaveLength(count);
    expect(credentials).toBe(1);
    await act(async () => cache.setQueryData(['session'], seed(null)));
    hidden(kind); // Equal external success, including equal null, retires this original owner.
  });

  test(`${kind}: independent server serialization binds a separately observed known browser cache`, async () => {
    const server = createCache();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')!;
    let transferred: Page;
    try {
      Reflect.deleteProperty(globalThis, 'window');
      // The bridge retains its test request URL independently of the global browser surface.
      transferred = JSON.parse(JSON.stringify(await load(kind, server)));
    } finally {
      Object.defineProperty(globalThis, 'window', descriptor);
    }
    await paint(kind, transferred!);
    expect(host.textContent).toContain(evidence(kind));
    expect(credentials).toBe(1);
    await act(async () => {
      cache.setQueryData(['session'], seed('BBBBBBBBBBBBBBBBBBBBBA'));
      cache.setQueryData(['session'], seed());
    });
    hidden(kind);
    // A copied server receipt in this already-observed browser cache must retain its original
    // retirement. Neither a new response root nor a new mount creates a new browser observation.
    const copied = JSON.parse(JSON.stringify(transferred!)) as Page;
    const count = nativeReads.length;
    await act(async () => {
      root.unmount();
      mounted = false;
    });
    root = createRoot(host);
    mounted = true;
    await paint(kind, copied);
    hidden(kind);
    expect(nativeReads).toHaveLength(count);
    expect(credentials).toBe(1);
    await paint(kind, await load(kind));
    expect(host.textContent).toContain(evidence(kind));
    server.clear();
  });

  for (const event of [
    'equal-success',
    'hidden-ABA',
    'error',
    'setState',
    'remove-recreate',
    'null-transition',
  ] as const) {
    function replace(): void | Promise<void> {
      const query = cache.getQueryCache().find({ queryKey: ['session'], exact: true })!;
      if (event === 'equal-success') cache.setQueryData(['session'], seed());
      if (event === 'hidden-ABA') {
        cache.setQueryData(['session'], seed('BBBBBBBBBBBBBBBBBBBBBA'));
        cache.setQueryData(['session'], seed());
      }
      if (event === 'error')
        return cache
          .fetchQuery({
            queryKey: ['session'],
            queryFn: async () => {
              throw new Error('Session failed');
            },
            staleTime: 0,
            retry: false,
          })
          .then(
            () => {},
            () => {},
          );
      if (event === 'setState') query.setState({ data: query.state.data });
      if (event === 'remove-recreate') {
        cache.removeQueries({ queryKey: ['session'], exact: true });
        cache.setQueryData(['session'], seed());
      }
      if (event === 'null-transition') cache.setQueryData(['session'], seed(null));
    }
    test(`${kind}: ${event} during actual preparation cannot admit private evidence`, async () => {
      credentialGate = deferred<void>();
      const pending = load(kind);
      await tick();
      expect(credentials).toBe(1);
      await replace();
      credentialGate.resolve();
      if (kind === 'decision') await expect(pending).rejects.toMatchObject({ isNotFound: true });
      else {
        const page = await pending;
        await paint(kind, page);
        hidden(kind);
      }
      expect(credentials).toBe(1);
      expect(nativeWrites).toHaveLength(0);
    });
    test(`${kind}: ${event} fences queued effects before a render and never revives`, async () => {
      const page = await load(kind);
      await paint(kind, page);
      if (kind === 'reports') await click(m.moderation_queue_review());
      if (kind === 'appeals' || kind === 'decision') await type('Original immutable command draft');
      const queued = button(
        kind === 'reports'
          ? m.moderation_dismiss()
          : kind === 'appeals'
            ? m.moderation_appeal_uphold_action()
            : kind === 'decision'
              ? m.decision_appeal_submit()
              : m.reporter_status_copy(),
      );
      const link = host.querySelector<HTMLAnchorElement>('a')!;
      const queuedNavigation = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      const count = nativeReads.length;
      let copies = 0;
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            copies++;
          },
        },
      });
      await act(async () => {
        const pendingReplacement = replace();
        if (pendingReplacement) await pendingReplacement;
        queued.click();
        link.dispatchEvent(queuedNavigation);
      });
      hidden(kind);
      expect(nativeWrites).toHaveLength(0);
      expect(copies).toBe(0);
      // A connected queued anchor is fenced by the actual capture handler; removed anchors
      // have already lost the page's navigation connection.
      if (link.isConnected) expect(queuedNavigation.defaultPrevented).toBe(true);
      expect(navigations).toEqual([]);
      expect(nativeReads).toHaveLength(count);
      await act(async () => cache.setQueryData(['session'], seed()));
      await paint(kind, page);
      hidden(kind);
      await paint(kind, await load(kind));
      expect(host.textContent).toContain(evidence(kind));
    });
  }

  for (const changed of ['provider', 'navigation', 'abort', 'unmount'] as const) {
    test(`${kind}: original ${changed} connection cannot be borrowed by a successor`, async () => {
      cache.setQueryData(['private-moderation', kind], await load(kind));
      const page = cache.getQueryData<Page>(['private-moderation', kind])!;
      await paint(kind, page);
      const count = nativeReads.length;
      if (changed === 'provider') {
        const replacement = createCache();
        await paint(kind, page, replacement);
        hidden(kind);
        await paint(kind, page);
        hidden(kind);
        replacement.clear();
      } else if (changed === 'navigation') {
        await act(async () => {
          navigationCurrent = false;
          for (const retire of navigationListeners) retire();
          navigationCurrent = true;
        });
        await paint(kind, page);
        hidden(kind);
      } else if (changed === 'abort') {
        await act(async () => abort.abort());
        await paint(kind, page);
        hidden(kind);
        abort = new AbortController();
      } else {
        await act(async () => {
          root.unmount();
          mounted = false;
        });
        root = createRoot(host);
        mounted = true;
        await paint(kind, page);
        hidden(kind);
      }
      expect(nativeReads).toHaveLength(count);
      expect(nativeWrites).toHaveLength(0);
      await paint(kind, await load(kind));
      expect(host.textContent).toContain(evidence(kind));
    });
  }

  test(`${kind}: changing the original target or scope within a generation retires instead of retargeting`, async () => {
    const page = await load(kind);
    await paint(kind, page);
    const changed =
      kind === 'reports' ? (
        <ModerationReportsPage
          page={page as ReportsPage}
          input={{ ...scope, order: 'newest', cursor: 'successor-cursor' }}
          navigation={navigation}
        />
      ) : kind === 'appeals' ? (
        <ModerationAppealsPage
          page={page as AppealsPage}
          input={{ ...scope, threadId: id(500), cursor: 'successor-cursor' }}
          navigation={navigation}
        />
      ) : kind === 'decision' ? (
        <DecisionPageView
          page={{ ...(page as DecisionPage), decision: { ...(page as DecisionPage).decision, targetId: id(500) } }}
          navigation={navigation}
        />
      ) : (
        <ReporterStatusCurrent initial={{ ...(page as ReporterPage), id: id(500) }} navigation={navigation} />
      );
    const count = nativeReads.length;
    await act(async () => {
      root.render(
        <StrictMode>
          <QueryClientProvider client={cache}>{changed}</QueryClientProvider>
        </StrictMode>,
      );
    });
    hidden(kind);
    await paint(kind, page);
    hidden(kind);
    expect(nativeReads).toHaveLength(count);
    expect(nativeWrites).toHaveLength(0);
    await paint(kind, await load(kind));
    expect(host.textContent).toContain(evidence(kind));
  });
}

for (const kind of ['reports', 'appeals'] as const) {
  test(`${kind}: sparse opaque continuation and loaded-only maximum20 keep exact scope and bounded enrichment`, async () => {
    if (kind === 'reports') reports = Array.from({ length: 20 }, (_, n) => ({ ...report, id: id(100 + n) }));
    else appeals = Array.from({ length: 20 }, (_, n) => ({ ...appeal, id: id(100 + n) }));
    await paint(kind, await load(kind));
    const list = nativeReads[0]!;
    const url = new URL(list.url);
    expect(url.pathname).toBe(
      kind === 'reports' ? `/v1/posts/${scope.postId}/reports` : `/v1/threads/${scope.threadId}/appeals`,
    );
    expect(Object.fromEntries(url.searchParams)).toEqual(
      kind === 'reports'
        ? { status: scope.status, targetKind: scope.targetKind, order: scope.order, cursor: scope.cursor, limit: '20' }
        : { cursor: scope.cursor, limit: '20' },
    );
    expect(nativeReads).toHaveLength(kind === 'reports' ? 3 : 2);
    reports = [];
    appeals = [];
    const page = await load(kind);
    await paint(kind, page);
    const count = nativeReads.length;
    expect(host.textContent).toContain(
      kind === 'reports' ? m.moderation_queue_empty_next() : m.moderation_appeals_read_sparse(),
    );
    await click(m.threads_next_page());
    expect(navigations).toEqual(['opaque-next+/==']);
    expect(nativeReads).toHaveLength(count);
    expect(nativeWrites).toHaveLength(0);
    hidden(kind);
  });
  test(`${kind}: a native oversized page is unavailable before target enrichment`, async () => {
    reports = Array.from({ length: 21 }, (_, n) => ({ ...report, id: id(100 + n) }));
    appeals = Array.from({ length: 21 }, (_, n) => ({ ...appeal, id: id(100 + n) }));
    await paint(kind, await load(kind));
    hidden(kind);
    expect(nativeReads).toHaveLength(1);
    expect(nativeWrites).toHaveLength(0);
  });
}

test('Reports explicit unavailable route recovery performs one original-scope preparation per click without an automatic loop', async () => {
  responseStatus = 503;
  let page = await load('reports');
  let recovery: Promise<Page> | undefined;
  const retry = () => {
    recovery = load('reports');
  };
  const render = () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={cache}>
          <ModerationReportsPage page={page as ReportsPage} input={scope} navigation={navigation} onRetry={retry} />
        </QueryClientProvider>
      </StrictMode>,
    );
  await act(async () => {
    render();
    await tick();
  });
  for (let n = 0; n < 3; n++) {
    const count = nativeReads.length;
    await act(async () => {
      await tick();
    });
    expect(nativeReads).toHaveLength(count);
    if (n === 2) responseStatus = 200;
    await act(async () => {
      button(m.moderation_queue_retry()).click();
      page = await recovery!;
      render();
      await tick();
    });
    expect(credentials).toBe(n + 2);
    expect(nativeReads).toHaveLength(count + (n === 2 ? 3 : 1));
    expect(new URL(nativeReads[count]!.url).searchParams.get('cursor')).toBe(scope.cursor);
  }
  expect(host.textContent).toContain(report.evidence);
  expect(nativeWrites).toHaveLength(0);
});

test('Reporter own-submission refusal blocks reference copying even when the native DTO shape is valid', async () => {
  ownReporter = id(2);
  let copies = 0;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async () => {
        copies++;
      },
    },
  });
  const page = await load('reporter');
  await paint('reporter', page);
  hidden('reporter');
  expect(host.querySelector('button')).toBeNull();
  expect(copies).toBe(0);
  expect(nativeReads).toHaveLength(1);
  expect(credentials).toBe(1);
});

for (const settlement of ['success', 'failure'] as const) {
  test(`Reporter late clipboard ${settlement} cannot change a successor or clear its pending copy`, async () => {
    await paint('reporter', await load('reporter'));
    const original = deferred<void>();
    const successor = deferred<void>();
    const references: string[] = [];
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (reference: string) => {
          references.push(reference);
          return references.length === 1 ? original.promise : successor.promise;
        },
      },
    });
    await click(m.reporter_status_copy());
    expect(references).toHaveLength(1);
    await act(async () => cache.setQueryData(['session'], seed()));
    hidden('reporter');
    await paint('reporter', await load('reporter'));
    await click(m.reporter_status_copy());
    expect(references).toHaveLength(2);
    expect(references[1]).toBe(references[0]);
    await act(async () => {
      if (settlement === 'success') original.resolve();
      else original.reject(new Error('Clipboard unavailable'));
      await tick();
    });
    expect(host.textContent).not.toContain(m.reporter_status_copied());
    expect(host.textContent).toContain(report.evidence);
    await act(async () => {
      successor.resolve();
      await tick();
    });
    expect(host.textContent).toContain(m.reporter_status_copied());
    expect(nativeReads).toHaveLength(2);
    expect(credentials).toBe(2);
    expect(nativeWrites).toHaveLength(0);
  });
}

for (const settlement of ['success', 'failure'] as const) {
  test(`Appeals original optional callback fences ${settlement}, finally and retry without changing exact intent`, async () => {
    const page = await load('appeals');
    await paint('appeals', page);
    await type('  Exact independent review statement.  ');
    commandGate = deferred<Response>();
    await click(m.moderation_appeal_reverse_action());
    expect(nativeWrites).toHaveLength(1);
    const first = nativeWrites[0]!;
    expect(await first.clone().json()).toEqual({
      outcome: 'reverse',
      statement: 'Exact independent review statement.',
    });
    expect(first.headers.get('idempotency-key')).not.toBeNull();
    const gate = commandGate;
    commandGate = undefined;
    await act(async () => cache.setQueryData(['session'], seed()));
    hidden('appeals');
    await paint('appeals', await load('appeals'));
    await type('Healthy successor draft');
    await act(async () => {
      if (settlement === 'success') gate.resolve(Response.json({}));
      else gate.reject(new TypeError('Failed to fetch'));
      await tick();
    });
    expect(host.querySelector('textarea')?.value).toBe('Healthy successor draft');
    expect(host.textContent).not.toContain(m.moderation_appeal_intent_uncertain());
    expect(nativeWrites).toHaveLength(1);
    await click(m.moderation_appeal_uphold_action());
    expect(nativeWrites).toHaveLength(2);
    expect(nativeWrites[1]!.headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'));
    expect(resolved).toBe(true);
  });
}

test('Appeals refresh hides old content and refreshes terminal empty pages within the original bounds', async () => {
  await paint('appeals', await load('appeals'));
  const urls = nativeReads.map((request) => request.url);
  appeals = [];
  continuation = null;
  nativeGate = deferred<void>();
  await act(async () => {
    const refresh = button(m.moderation_queue_refresh());
    refresh.click();
    refresh.click();
    await tick();
  });
  expect(nativeReads).toHaveLength(urls.length + 1);
  expect(host.textContent).toContain(m.moderation_appeals_read_loading());
  hidden('appeals');
  expect(host.querySelector('blockquote')).toBeNull();
  await act(async () => {
    nativeGate!.resolve();
    await tick();
  });
  expect(host.textContent).toContain(m.moderation_appeals_empty());
  const count = nativeReads.length;
  appeals = [appeal];
  await click(m.moderation_queue_refresh());
  expect(nativeReads.slice(count).map((request) => request.url)).toEqual(urls);
  expect(host.textContent).toContain(appeal.statement);
  expect(nativeWrites).toHaveLength(0);
});

test('Appeals refresh refuses a changed native origin under the original browser observation', async () => {
  await paint('appeals', await load('appeals'));
  preparedToken = 'BBBBBBBBBBBBBBBBBBBBBA';
  await click(m.moderation_queue_refresh());
  hidden('appeals');
  expect(host.querySelector('blockquote')).toBeNull();
  expect(host.querySelector('button')).toBeNull();
});

test('Appeals refresh waits for resolution recovery, preserving exact body/key and confirmed receipt across rerenders', async () => {
  const page = await load('appeals');
  await paint('appeals', page);
  await type('  Exact independent review statement.  ');
  commandGate = deferred<Response>();
  await click(m.moderation_appeal_reverse_action());
  const count = nativeReads.length;
  expect(button(m.moderation_queue_refresh()).disabled).toBe(true);
  await click(m.moderation_queue_refresh());
  await act(async () => {
    commandGate!.reject(new TypeError('Failed to fetch'));
    await tick();
  });
  expect(host.textContent).toContain(m.moderation_appeal_intent_uncertain());
  expect(button(m.moderation_queue_refresh()).disabled).toBe(true);
  await click(m.moderation_queue_refresh());
  const first = nativeWrites[0]!;
  commandGate = undefined;
  await click(m.moderation_appeal_intent_retry());
  expect(nativeWrites).toHaveLength(2);
  expect(await nativeWrites[1]!.clone().text()).toBe(await first.clone().text());
  expect(nativeWrites[1]!.headers.get('idempotency-key')).toBe(first.headers.get('idempotency-key'));
  expect(host.textContent).toContain(m.moderation_appeal_reversed());
  await paint('appeals', { ...page });
  expect(host.textContent).toContain(m.moderation_appeal_reversed());
  expect(host.textContent).not.toContain(m.moderation_appeal_intent_uncertain());
  appeals = [];
  await click(m.moderation_queue_refresh());
  expect(nativeReads).toHaveLength(count + 1);
  expect(nativeWrites).toHaveLength(2);
  expect(host.textContent).not.toContain(m.moderation_appeal_reversed());
});

for (const kind of ['appeals', 'reporter'] as const) {
  for (const [initial, settlement] of ['unavailable', ...(kind === 'appeals' ? ['ready'] : [])].flatMap((initial) =>
    ['success', 'failure'].map((settlement) => [initial, settlement]),
  )) {
    test(`${kind}: explicit ${initial} recovery keeps the original observation; late ${settlement} cannot clean up a successor`, async () => {
      preparationOutage = initial === 'unavailable';
      const page = await load(kind);
      await paint(kind, page);
      expect(credentials).toBe(1);
      expect(nativeReads).toHaveLength(initial === 'ready' ? 2 : 0);
      preparationOutage = false;
      nativeGate = deferred<void>();
      await click(
        kind === 'appeals'
          ? initial === 'ready'
            ? m.moderation_queue_refresh()
            : m.moderation_appeals_read_retry()
          : m.sources_retry(),
      );
      expect(credentials).toBe(2);
      const gate = nativeGate;
      nativeGate = undefined;
      await act(async () => cache.setQueryData(['session'], seed()));
      await paint(kind, await load(kind));
      expect(host.textContent).toContain(evidence(kind));
      const count = nativeReads.length;
      await act(async () => {
        if (settlement === 'success') gate.resolve();
        else gate.reject(new TypeError('Native response lost'));
        await tick();
      });
      expect(host.textContent).toContain(evidence(kind));
      expect(nativeReads).toHaveLength(count + (kind === 'appeals' && settlement === 'success' ? 1 : 0));
      expect(nativeWrites).toHaveLength(0);
    });
  }
  test(`${kind}: repeated explicit current unavailable recovery performs exactly one bounded read per click`, async () => {
    responseStatus = 503;
    const page = await load(kind);
    await paint(kind, page);
    for (let n = 0; n < 2; n++) {
      const before = nativeReads.length;
      await click(kind === 'appeals' ? m.moderation_appeals_read_retry() : m.sources_retry());
      expect(nativeReads).toHaveLength(before + 1);
      expect(credentials).toBe(n + 2);
    }
    responseStatus = 200;
    await click(kind === 'appeals' ? m.moderation_appeals_read_retry() : m.sources_retry());
    expect(host.textContent).toContain(evidence(kind));
    expect(credentials).toBe(4);
    expect(nativeWrites).toHaveLength(0);
    if (kind === 'appeals') {
      responseStatus = 503;
      await click(m.moderation_queue_refresh());
      hidden(kind);
      expect(host.textContent).toContain(m.moderation_appeals_read_unavailable());
    }
  });
}
