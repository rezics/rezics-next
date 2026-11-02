import { expect, mock, test } from 'bun:test';

const source = await Bun.file(new URL('../src/stories/moderation-appeals.stories.tsx', import.meta.url)).text();

// Guard story composition here; the canonical plays exercise the real localized DOM at integration.
test('Canonical pending and empty appeal Page stories use the existing shell and one main while retaining native response details and meaningful localized keyboard focus assertions', () => {
  expect([...source.matchAll(/export const (\w+)/g)].map((match) => match[1])).toEqual(['Pending', 'Empty']);
  expect(source).toContain("title: 'Pages/Moderation appeals'");
  expect(source).toContain('component: ModerationAppealsView');
  expect(source).toMatch(/<PatternStory\b[^>]*>\s*<AppShell>\s*<Story\s*\/>\s*<\/AppShell>\s*<\/PatternStory>/);
  expect(source).not.toMatch(/<main\b|\b(?:globals|defaultViewport|viewports)\s*:/);
  expect(source).toContain("canvas.findByRole('main')");
  expect(source).toContain("canvas.getByRole('heading', { level: 1 })");

  expect(source).toContain(`const pendingAppeal = {
  id: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
  appellantId: '0192f3a0-6c1e-7b2a-9d4e-000000000005',
  statement: 'I did not intend to share identifying information. Please review the decision independently.',
  createdAt: '2026-10-30T01:00:00.000Z',
  decision: {
    statement: 'The reply is withheld while its personal information is reviewed.',
    target: { kind: 'post', id: '0192f3a0-6c1e-7b2a-9d4e-000000000050' },
  },
  canResolve: true,
} satisfies Appeal;`);
  expect(source).toContain('key: `post:${pendingAppeal.decision.target.id}`');
  expect(source).toMatch(
    /const withheldTarget: ModerationTarget = \{\s*key: `post:\$\{pendingAppeal\.decision\.target\.id\}`,\s*kind: 'post',\s*value: null,\s*\};/,
  );

  const pending = source.slice(source.indexOf('export const Pending:'), source.indexOf('export const Empty:'));
  const empty = source.slice(source.indexOf('export const Empty:'));
  expect(pending).toContain('args: { appeals: [pendingAppeal], targets: [withheldTarget] }');
  expect(empty).toContain('args: { appeals: [], targets: [] }');
  expect(empty).toContain('view.getByText(m.moderation_appeals_empty())).toBeVisible()');
  for (const message of ['moderation_reports_tab', 'moderation_statement_label', 'moderation_appeal_uphold_action'])
    expect(pending).toContain(`name: m.${message}()`);

  expect(pending).toMatch(
    /main\.focus\(\);[\s\S]*userEvent\.tab\(\);\s*await expect\(reports\)\.toHaveFocus\(\);\s*await userEvent\.tab\(\);\s*await expect\(statement\)\.toHaveFocus\(\);/,
  );
  expect(pending).toMatch(
    /expect\(uphold\)\.toBeDisabled\(\);\s*await userEvent\.type\(statement, '[^']+'\);[\s\S]*expect\(uphold\)\.toBeEnabled\(\);\s*await userEvent\.tab\(\);\s*await expect\(uphold\)\.toHaveFocus\(\);/,
  );
  expect(pending).not.toMatch(/userEvent\.click|\.disabled\s*=/);
  for (const field of ['decision.statement', 'decision.target.id', 'statement'])
    expect(pending).toContain(`view.getByText(pendingAppeal.${field})).toBeInTheDocument()`);
  expect(pending).toContain("view.getByRole('blockquote').textContent).toBe(m.moderation_target_unavailable())");
});

test('Appeals Next preserves forms on Reports metadata and Stay, focuses admitted continuations only, and retires private rows and reads on session replacement', async () => {
  const { createElement, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  // Retain the actual session hook, server handlers and generated transport via the existing local bridge.
  const start = await import('@tanstack/react-start');
  const startServer = await import('@tanstack/react-start/server');
  const bridge = await import('../.storybook/react-start');
  const originalSession = { state: 'signed-in' as const, subject: 'reviewer', csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' };
  const replacementSession = { ...originalSession, csrfToken: 'BBBBBBBBBBBBBBBBBBBBBA' };
  const environment = {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => ({
          status: 'active',
          subject: originalSession.subject,
          accessToken: 'reviewer',
          csrfToken: originalSession.csrfToken,
        }),
      }),
    },
  };
  mock.module('cloudflare:workers', () => ({ env: environment }));
  mock.module('@tanstack/react-start', () => ({ ...start, ...bridge }));
  mock.module('@tanstack/react-start/server', () => ({
    ...startServer,
    ...bridge,
    getRequest: () =>
      new Request('https://site.test/en/boards/moderation?tab=appeals', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      }),
  }));
  const { ModerationAppealsPage } = await import('../src/moderation/appeals-tab');
  const { loadModerationAppeals } = await import('../src/moderation/appeals-read');
  const { prepareModerationAppealRead } = await import('../src/moderation/appeals-read-model');
  const { sessionQuery, useSession } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const browserSession: ReturnType<typeof useSession> = originalSession;
  const window = new Window({ url: 'https://site.test/en/boards/moderation?tab=appeals' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    DocumentFragment: window.DocumentFragment,
    ShadowRoot: window.ShadowRoot,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const input = { boardId: '0192f3a0-6c1e-7b2a-9d4e-000000000001' };
  const targetId = '0192f3a0-6c1e-7b2a-9d4e-000000000050';
  const row = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000002',
    decisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
    appellantId: 'private-author',
    statement: 'PRIVATE appeal statement',
    createdAt: '2026-10-30T01:00:00.000Z',
    decision: { statement: 'PRIVATE decision statement', target: { kind: 'post', id: targetId } },
    canResolve: true,
  };
  const calls: Request[] = [];
  let queueRows = [row];
  let queueNext: string | null = null;
  let expectedCursor: string | undefined;
  let mode: 'ready' | 'unavailable' | 'pending-success' | 'pending-failure' = 'ready';
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (requestInput: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(requestInput, init);
      calls.push(request);
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer reviewer');
      expect(request.cache).toBe('no-store');
      const path = new URL(request.url).pathname;
      if (path === `/v1/posts/${targetId}`)
        return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE TARGET' }, { status: 404 });
      expect(path).toBe(`/v1/boards/${input.boardId}/appeals`);
      expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
        limit: '20',
        ...(expectedCursor ? { cursor: expectedCursor } : {}),
      });
      if (mode === 'unavailable')
        return Response.json({ code: 'dependency_unavailable', detail: 'NEVER DISCLOSE' }, { status: 503 });
      const settlement = mode;
      if (gate) await gate;
      if (settlement === 'pending-failure') throw new TypeError('Read response lost');
      return Response.json({ appeals: queueRows, next: queueNext });
    },
    { preconnect() {} },
  ) as typeof fetch;
  const flush = () => act(async () => void (await new Promise((done) => setTimeout(done, 0))));
  const assertClosed = () => {
    expect(host.textContent).toContain(m.moderation_appeals_read_closed());
    expect(host.textContent).not.toContain('PRIVATE');
    expect(host.textContent).not.toContain('NEVER DISCLOSE');
    expect(host.querySelector('form')).toBeNull();
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('blockquote')).toBeNull();
    expect(host.querySelector('button')).toBeNull();
    expect(host.innerHTML).not.toContain(originalSession.csrfToken);
    expect(host.innerHTML).not.toContain(replacementSession.csrfToken);
  };
  try {
    const ready = await loadModerationAppeals({ data: input });
    expect(ready.viewerId).toBe(originalSession.subject);
    expect(ready.targets).toMatchObject([
      { key: `post:${targetId}`, kind: 'post', value: { moderationEvidence: { state: 'unavailable', post: null } } },
    ]);
    mode = 'unavailable';
    const unavailable = await loadModerationAppeals({ data: input });
    expect(unavailable.state).toBe('unavailable');
    const { createMemoryHistory, createRootRoute, createRouter, Outlet, RouterProvider } =
      await import('@tanstack/react-router');
    const { Route } = await import('../src/routes/boards/$id_.moderation');
    const { default: userEvent } = await import(
      Bun.resolveSync('@testing-library/user-event', dirname(Bun.resolveSync('storybook/test', import.meta.dir)))
    );
    const user = userEvent.setup({ document: window.document });
    const parent = createRootRoute({ component: Outlet });
    const route = Route.update({ getParentRoute: () => parent, path: '/boards/$id/moderation' } as never);
    const router = createRouter({
      routeTree: parent.addChildren([route]),
      context: { queryClient: cache },
      history: createMemoryHistory({ initialEntries: [`/boards/${input.boardId}/moderation?tab=appeals`] }),
    });
    host.tabIndex = -1;
    const stopShellFocus = router.subscribe('onResolved', () => host.focus());
    const button = (text: string) =>
      [...document.querySelectorAll('button')].find((node) => node.textContent === text)!;
    const keyboardNext = async () => {
      button(m.threads_next_page()).focus();
      await act(async () => user.keyboard('{Enter}'));
      await flush();
    };
    mode = 'ready';
    queueNext = 'next';
    cache.setQueryData(sessionQuery.queryKey, browserSession);
    await router.load();
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client: cache }, createElement(RouterProvider, { router }))),
    );
    await flush();
    const statement = host.querySelector('textarea')!;
    const draft = 'Independent review';
    await act(async () => user.type(statement, draft));
    statement.setSelectionRange(2, 7);
    const readsBeforeMetadata = calls.length;
    await act(async () =>
      router.navigate({
        to: '/boards/$id/moderation',
        params: { id: input.boardId },
        search: { tab: 'appeals', order: 'oldest', status: 'resolved', targetKind: 'thread' },
      }),
    );
    expect(calls).toHaveLength(readsBeforeMetadata);
    expect(host.querySelector('textarea')).toBe(statement);
    expect([statement.value, statement.selectionStart, statement.selectionEnd]).toEqual([draft, 2, 7]);
    await keyboardNext();
    await act(async () => user.click(button(m.thread_authoring_stay())));
    expect(host.querySelector('textarea')).toBe(statement);
    expect(statement.value).toBe(draft);
    expect(calls).toHaveLength(readsBeforeMetadata);
    await keyboardNext();
    queueRows = [];
    queueNext = 'empty';
    expectedCursor = 'next';
    await act(async () => user.click(button(m.thread_authoring_leave())));
    await flush();
    expect(host.textContent).toContain(m.moderation_appeals_read_sparse());
    expect(document.activeElement).toBe(host.querySelector('article'));
    await act(async () => user.tab());
    expect(document.activeElement).toBe(host.querySelector('a'));
    queueNext = null;
    expectedCursor = 'empty';
    await keyboardNext();
    expect(host.textContent).toContain(m.moderation_appeals_empty());
    expect(document.activeElement).toBe(host.querySelector('article'));
    queueNext = 'failure';
    expectedCursor = undefined;
    await act(async () =>
      router.navigate({ to: '/boards/$id/moderation', params: { id: input.boardId }, search: { tab: 'appeals' } }),
    );
    expect(document.activeElement).toBe(host);
    mode = 'unavailable';
    expectedCursor = 'failure';
    await keyboardNext();
    const retry = button(m.moderation_appeals_read_retry());
    mode = 'ready';
    queueNext = null;
    retry.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(host.textContent).toContain(m.moderation_appeals_empty());
    expect(document.activeElement).not.toBe(host.querySelector('article'));
    stopShellFocus();
    queueRows = [row];
    expectedCursor = undefined;
    // Exercise visible private rows and both settlements of a pending default-reader retry.
    for (const scenario of ['ready', 'pending-success', 'pending-failure'] as const) {
      cache.setQueryData(sessionQuery.queryKey, browserSession);
      // The original browser observation must precede the actual prepared read, even for an outage.
      mode = scenario === 'ready' ? 'ready' : 'unavailable';
      const prepared = await prepareModerationAppealRead(cache, input, (data) => loadModerationAppeals({ data }));
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: cache },
            createElement(ModerationAppealsPage, {
              key: scenario,
              page: prepared,
              input,
            }),
          ),
        ),
      );
      await flush();
      mode = scenario;
      if (scenario === 'ready') {
        expect(host.textContent).toContain(row.statement);
        expect(host.textContent).toContain(row.decision.statement);
        expect(host.querySelector('blockquote')!.textContent).toBe(m.moderation_target_unavailable());
        expect(host.querySelector('textarea')).not.toBeNull();
      } else {
        gate = new Promise<void>((done) => {
          release = done;
        });
        const retry = [...host.querySelectorAll('button')].find(
          (button) => button.textContent === m.moderation_appeals_read_retry(),
        );
        expect(retry).toBeDefined();
        const before = calls.length;
        await act(async () => retry!.click());
        await flush();
        expect(calls).toHaveLength(before + 1);
        expect(host.textContent).toContain(m.moderation_appeals_read_loading());
      }
      await act(async () => cache.setQueryData(sessionQuery.queryKey, replacementSession));
      await flush();
      assertClosed();
      // Restore the former session before settlement: neither callbacks nor cached rows may revive it.
      await act(async () => cache.setQueryData(sessionQuery.queryKey, browserSession));
      await flush();
      assertClosed();
      const beforeSettlement = calls.length;
      await act(async () => release?.());
      await flush();
      assertClosed();
      expect(calls).toHaveLength(beforeSettlement + (scenario === 'pending-success' ? 1 : 0));
      gate = undefined;
      release = undefined;
    }
  } finally {
    release?.();
    await act(async () => root.unmount());
    cache.clear();
    globalThis.fetch = originalFetch;
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
