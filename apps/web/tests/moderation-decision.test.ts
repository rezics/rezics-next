import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import type { ModerationDecision } from '../src/moderation/decision-read';
import { m } from '../src/paraglide/messages.js';
import * as localStart from '../.storybook/react-start';

const start = await import('@tanstack/react-start');
const startServer = await import('@tanstack/react-start/server');
const environment: Record<string, unknown> = {};
let currentRequest = new Request('https://site.test/moderation/decisions/decision-1');
let requestViewer = 'author-1';
let requestEpoch = 'AAAAAAAAAAAAAAAAAAAAAA';
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env: environment }));
// Run the actual BFF handlers locally, selecting the real browser session hook only in the DOM.
mock.module('@tanstack/react-start', () => ({
  ...start,
  ...localStart,
  createServerFn(options: { method: string }) {
    const bridge = localStart.createServerFn();
    const chain = {
      validator(validate: (input: unknown) => unknown) {
        bridge.validator(validate);
        return chain;
      },
      handler(handler: (...args: never[]) => unknown) {
        const invoke = bridge.handler(handler);
        return (input?: { data?: unknown; headers?: HeadersInit }) => {
          const headers = new Headers(input?.headers);
          headers.set('cookie', `__Host-rezics_session=${'a'.repeat(43)}`);
          headers.set('origin', 'https://site.test');
          currentRequest = new Request('https://site.test/moderation/decisions/decision-1', {
            method: options.method,
            headers,
          });
          return invoke(input as never);
        };
      },
    };
    return chain;
  },
  createIsomorphicFn() {
    let server: Function;
    return {
      server(handler: Function) {
        server = handler;
        return {
          client:
            (client: Function) =>
            (...args: unknown[]) =>
              (typeof window === 'undefined' ? server : client)(...args),
        };
      },
    };
  },
}));
mock.module('@tanstack/react-start/server', () => ({
  ...startServer,
  getRequest: () => currentRequest,
  setResponseHeader: (key: string, value: string) => responseHeaders.set(key, value),
}));
const { loadDecisionPage, decisionReadAdapters } = await import('../src/moderation/decision-read');
const { submitDecisionAppeal } = await import('../src/moderation/appeal');
const { DecisionPageView } = await import('../src/moderation/decision-page');

const decidedAt = '2026-01-01T12:00:00.000Z';
const decision: ModerationDecision = {
  id: 'decision-1',
  targetKind: 'post' as const,
  targetId: 'post-1',
  action: 'takedown' as const,
  statement: 'This post violates the board rules.',
  decidedAt,
  appealDeadline: '2026-07-03T12:00:00.000Z',
  appeal: null,
  viewer: { affectedAuthor: true, observedAt: decidedAt, appeal: { state: 'permitted' as const } },
  targetContext: { state: 'concealed' as const },
};
const decisionWithProvenance = (change: Partial<ModerationDecision> = {}) =>
  Object.assign(
    { ...decision, ...change },
    {
      provenance: {
        actorId: 'author-1',
        session: { clientId: 'client-1', authnEpoch: 7 },
        source: { partition: 3, epoch: 9, position: '12' },
      },
    },
  );

test('the composed decision reader uses one native response and does not hydrate a target', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage('decision-1', {
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return decisionWithProvenance();
    },
  }, 'author-1');

  expect(page).toMatchObject({ decision, viewerId: 'author-1', nativeSourceFingerprint: expect.any(String) });
  expect(calls).toEqual(['decision:decision-1']);
});

test('a composed response without generated provenance stays on the typed unavailable seam', async () => {
  await expect(loadDecisionPage('decision-1', { decision: async () => decision })).rejects.toThrow(
    'Decision read unavailable',
  );
});

test('native provenance is complete before the decision source can be bound', async () => {
  for (const provenance of [
    { actorId: 'author-1' },
    {
      actorId: 'another-author',
      session: { clientId: 'client-1', authnEpoch: 7 },
      source: { partition: 3, epoch: 9, position: '12' },
    },
  ]) {
    const response = Object.assign({}, decision, { provenance });
    await expect(loadDecisionPage('decision-1', { decision: async () => response }, 'author-1')).rejects.toThrow(
      'Decision read unavailable',
    );
  }
});

test('decision reads retain supplied text while staying independent of unrelated fixture history', async () => {
  const history = new Proxy(Array.from({ length: 1000 }, (_, index) => index), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error('Unrelated history must not be enumerated');
      return Reflect.get(target, property, receiver);
    },
  });
  for (const size of [1, 8000]) {
    const title = 't'.repeat(size);
    const response = Object.assign(
      decisionWithProvenance({
        statement: 'r'.repeat(size),
        targetContext: {
          state: 'available' as const,
          kind: 'thread' as const,
          threadId: 'thread-1',
          postId: 'post-1',
          boardId: 'board-1',
          threadTitle: title,
          boardTitle: null,
        },
      }),
      { unrelatedHistory: history },
    );
    let calls = 0;
    const page = await loadDecisionPage('decision-1', {
      decision: async () => {
        calls++;
        return response;
      },
    }, 'author-1');
    expect(page?.decision.statement).toHaveLength(size);
    expect(calls).toBe(1);
  }
});

test('command acknowledgement and the separate current decision readback remain distinct', async () => {
  const calls: string[] = [];
  const pending = decisionWithProvenance({
    appeal: { id: 'appeal-1', outcome: null, statement: 'I disagree.', resolvedAt: null },
  });
  const result = await submitDecisionAppeal('decision-1', 'I disagree.', {
    appeal: async (id, statement) => {
      calls.push(`appeal:${id}:${statement}`);
      return { status: 201 };
    },
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return pending;
    },
  });

  expect(result).toMatchObject({
    state: 'acknowledged',
    readback: { state: 'available', decision: pending, nativeSourceFingerprint: expect.any(String) },
  });
  expect(calls).toEqual(['appeal:decision-1:I disagree.', 'decision:decision-1']);
});

test('a 422 length error preserves the draft while late and duplicate appeals use the next decision state', async () => {
  const draft = 'x'.repeat(2001);
  let next = decisionWithProvenance();
  const reader = { decision: async () => next };
  const tooLong = await submitDecisionAppeal('decision-1', draft, {
    appeal: async () => ({ status: 422 }),
    ...reader,
  });
  expect(tooLong).toMatchObject({ state: 'invalid', text: draft });

  next = decisionWithProvenance({ appeal: { id: 'appeal-1', outcome: null, statement: 'Earlier appeal', resolvedAt: null } });
  for (const status of [409, 422]) {
    const refreshed = await submitDecisionAppeal('decision-1', 'My reason', {
      appeal: async () => ({ status }),
      ...reader,
    });
    expect(refreshed).toMatchObject({ state: 'conflict', readback: { state: 'available', decision: next } });
  }
});

test('decision route is signed-in, noindex and private, and refused reads become not found', async () => {
  const route = await readFile(new URL('../src/routes/moderation/decisions.$id.tsx', import.meta.url), 'utf8');
  const read = await readFile(new URL('../src/moderation/decision-read.ts', import.meta.url), 'utf8');
  expect(route).toMatch(/beforeLoad:\s*requireSignedIn/);
  expect(route).toMatch(/noindex, nofollow/);
  expect(read).toMatch(/notFound\(/);
});

test('decision presentation shows reasons, target and times, with appeal UI only for the author before deadline', () => {
  const page = {
    decision: decisionWithProvenance(),
    nativeSourceFingerprint: 'presenter-source',
    viewerId: 'author-1',
  };
  const open = renderToStaticMarkup(createElement(DecisionPageView, { page, now: Date.parse(decidedAt) }));
  expect(open).toContain(decision.statement);
  expect(open).toContain(m.decision_target_concealed());
  expect(open).toContain('dateTime="' + decidedAt + '"');
  expect(open).toContain('dateTime="' + decision.appealDeadline + '"');
  expect(open).toContain('appeal-statement');
  expect(open).toContain('2,000');

  const late = renderToStaticMarkup(
    createElement(DecisionPageView, { page, now: Date.parse(decision.appealDeadline) + 1 }),
  );
  expect(late).not.toContain('appeal-statement');
  const otherReader = renderToStaticMarkup(
    createElement(
      DecisionPageView,
      {
        page: {
          ...page,
          decision: {
            ...page.decision,
            viewer: { ...page.decision.viewer, appeal: { state: 'unavailable', reason: 'not_affected_author' } },
          },
        },
        now: Date.parse(decidedAt),
      },
    ),
  );
  expect(otherReader).not.toContain('appeal-statement');
});

test('a private decision remains readable with concealed context, including after its appeal deadline', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage(decision.id, {
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return decisionWithProvenance();
    },
  }, 'author-1');
  expect(calls).toEqual(['decision:decision-1']);
  if (!page) throw new Error('The authorized decision must remain readable');
  for (const now of [Date.parse(decidedAt), Date.parse(decision.appealDeadline) + 1]) {
    const markup = renderToStaticMarkup(
      createElement(DecisionPageView, { page: { ...page, viewerId: 'author-1' }, now }),
    );
    expect(markup).toContain(decision.statement);
    expect(markup).toContain(m.decision_target_concealed());
    expect(markup.includes('appeal-statement')).toBe(now <= Date.parse(decision.appealDeadline));
  }
});

test('Moderation decision receipt and author appeal, one main and understandable current outcome', async () => {
  const { SidebarInset } = await import('@rezics/ui/shadcn/sidebar');
  for (const outcome of [null, 'reversed', 'upheld'] as const) {
    const appeal = {
      id: 'appeal-1',
      outcome,
      statement: outcome ? 'Independent review statement.' : null,
      resolvedAt: outcome ? decidedAt : null,
    };
    const markup = renderToStaticMarkup(
      createElement(
        SidebarInset,
        null,
        createElement(DecisionPageView, {
          page: {
            decision: decisionWithProvenance({
              appeal,
              viewer: { ...decision.viewer, appeal: { state: 'unavailable', reason: 'already_appealed' } },
            }),
            viewerId: 'author-1',
            nativeSourceFingerprint: 'presenter-source',
          },
          now: Date.parse(decidedAt),
        }),
      ),
    );
    expect(markup.match(/<main\b/g)).toHaveLength(1);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain('Original decision');
    expect(markup).toContain(decision.statement);
    expect(markup).toContain('Current content availability');
    expect(markup).toContain(m.decision_target_concealed());
    expect(markup).toContain(decision.id);
    expect(markup).not.toContain(decision.targetId);
    expect(markup).not.toContain('/threads/');
    expect(markup).not.toContain('appeal-statement');
    expect(markup).toContain(
      outcome === null
        ? 'Appeal awaiting review'
        : outcome === 'reversed'
          ? 'The decision was reversed.'
          : 'The decision was upheld.',
    );
    if (outcome) expect(markup).toContain('Independent review statement.');
  }
});

test('decision adapter uses only the composed exact endpoint and preserves native denial', async () => {
  let denied = false;
  const calls: string[] = [];
  const reads = decisionReadAdapters(
    {
      'moderation-decisions': ({ id }) => ({
        get: async () => {
          calls.push(`decision:${id}`);
          return denied ? { data: null, error: { status: 404 }, status: 404 } : { data: decision, error: null, status: 200 };
        },
      }),
    },
    'Bearer author',
  );
  expect(await reads.decision(decision.id)).toEqual(decision);
  denied = true;
  expect(await reads.decision(decision.id)).toBeNull();
  expect(calls).toEqual(['decision:decision-1', 'decision:decision-1']);
});

test('appeal denial, known conflict and uncertain confirmation stay distinct without optimistic native state', async () => {
  const { createModerationIntent } = await import('../src/moderation/command-intent');
  const intent = createModerationIntent();
  const command = { id: decision.id, statement: 'Keep this exact statement.' };
  const originalKey = intent.keyFor(command);
  for (const status of [401, 403, 404]) {
    expect(
      await submitDecisionAppeal(decision.id, command.statement, {
        appeal: async () => ({ status }),
        decision: async () => {
          throw new Error('Denied writes must not become success through a read');
        },
      }),
    ).toEqual({ state: 'denied' });
  }
  for (const status of [409, 422]) {
    expect(
      await submitDecisionAppeal(decision.id, command.statement, {
        appeal: async () => ({ status }),
        decision: async () => {
          throw new Error('Read unavailable');
        },
      }),
    ).toEqual({ state: 'conflict', readback: { state: 'unavailable' } });
  }
  expect(
    await submitDecisionAppeal(decision.id, command.statement, {
      appeal: async () => ({ status: 201 }),
      decision: async () => null,
    }),
  ).toEqual({ state: 'acknowledged', readback: { state: 'unavailable' } });
  expect(
    await submitDecisionAppeal(decision.id, command.statement, {
      appeal: async () => ({ status: 503 }),
      decision: async () => decision,
    }),
  ).toEqual({ state: 'failed' });
  expect(intent.keyFor(command)).toBe(originalKey);
});

test('The default private Decision page retires statements, appeal drafts and late command or refresh results across viewer and session changes independently of target visibility, and honestly recovers a transient current read', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/moderation/decisions/decision-1' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { readDecisionPage } = await import('../src/moderation/decision-read');
  const { prepareDecisionRead } = await import('../src/moderation/decision-read-model');
  const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const fetchBefore = globalThis.fetch;
  const calls: Request[] = [];
  const commands: { body: string; key: string | null; csrf: string | null }[] = [];
  let mode: 'ready' | 'unavailable' | 'denied' | 'final-denial' | 'platform-closed' = 'ready';
  let decisionReads = 0;
  let sourcePosition = '12';
  let loseFirstCommand = true;
  let gateRead: Promise<void> | null = null;
  let gateCommand: Promise<void> | null = null;
  let releaseRead!: () => void;
  let releaseCommand!: () => void;
  const decisions = new Map(
    [1, 2, 3].map((n) => [
      `decision-${n}`,
      decisionWithProvenance({
        id: `decision-${n}`,
        targetId: `post-${n}`,
        statement: `PRIVATE original decision ${n}`,
      }),
    ]),
  );
  Object.assign(environment, {
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
        credential: async () => ({
          status: 'active',
          subject: requestViewer,
          accessToken: requestViewer,
          csrfToken: requestEpoch,
        }),
      }),
    },
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push(request);
      const path = new URL(request.url).pathname;
      if (path.startsWith('/v1/posts/'))
        return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE TARGET' }, { status: 404 });
      const id = path.split('/').at(-1)!.replace(':appeal', '');
      const current = decisions.get(id)!;
      expect(current).toBeDefined();
      if (request.method === 'POST') {
        commands.push({
          body: await request.text(),
          key: request.headers.get('idempotency-key'),
          csrf: request.headers.get('X-CSRF-Token'),
        });
        if (loseFirstCommand) {
          loseFirstCommand = false;
          return Response.json({ code: 'dependency_unavailable', detail: 'NEVER DISCLOSE COMMAND' }, { status: 503 });
        }
        if (gateCommand) await gateCommand;
        decisions.set(id, {
          ...current,
          appeal: {
            id: 'appeal-1',
            outcome: null,
            statement: null,
            resolvedAt: null,
          },
        });
        return Response.json({ id: 'appeal-1' }, { status: 201 });
      }
      expect(request.cache).toBe('no-store');
      expect(['Bearer author-1', 'Bearer another-viewer']).toContain(request.headers.get('authorization'));
      const ordinal = ++decisionReads;
      if (gateRead) {
        const gate = gateRead;
        gateRead = null;
        await gate;
      }
      if (mode === 'unavailable')
        return Response.json({ code: 'dependency_unavailable', detail: 'NEVER DISCLOSE READ' }, { status: 503 });
      if (mode === 'platform-closed')
        return Response.json({ code: 'platform_closed', detail: 'NEVER DISCLOSE GATE' }, { status: 403 });
      if (mode === 'denied' || (mode === 'final-denial' && ordinal === 1))
        return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE DENIAL' }, { status: 404 });
      return Response.json(
        Object.assign({}, current, {
          provenance: {
            ...current.provenance,
            source: { ...current.provenance.source, position: sourcePosition },
          },
        }),
      );
    },
    { preconnect: fetchBefore.preconnect },
  );
  type Page = Awaited<ReturnType<typeof readDecisionPage>>;
  let page: Page;
  const load = (id: string) => prepareDecisionRead(cache, id, (id) => readDecisionPage({ data: { id } }));
  async function render(next = page) {
    page = next;
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(DecisionPageView, { page, now: Date.parse(decidedAt) }),
        ),
      ),
    );
  }
  async function session(subject: string | null, token: string | null, state = subject ? 'signed-in' : 'signed-out') {
    requestViewer = subject ?? '';
    requestEpoch = token ?? '';
    await act(async () => {
      cache.setQueryData(sessionQuery.queryKey, { state, subject, csrfToken: token });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  async function click(name: string) {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === name);
    expect(button, name).toBeDefined();
    await act(async () => {
      button!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const concealed = () => {
    expect(host.textContent).not.toContain('PRIVATE');
    expect(host.textContent).not.toContain('NEVER DISCLOSE');
    expect(host.querySelector('textarea')).toBeNull();
    expect(host.querySelector('a[href*="/threads/"]')).toBeNull();
  };
  try {
    await session('author-1', 'AAAAAAAAAAAAAAAAAAAAAA');
    page = await load(decision.id);
    // Accepted non-secret prepared provenance replaces the old raw-CSRF serialization oracle.
    expect(page).toMatchObject({
      viewerId: 'author-1',
      nativeSourceFingerprint: expect.any(String),
      readerOrigin: {
        subject: 'author-1',
        csrfFingerprint: await privateReaderFingerprint('AAAAAAAAAAAAAAAAAAAAAA'),
      },
    });
    expect(JSON.stringify(page)).not.toContain('AAAAAAAAAAAAAAAAAAAAAA');
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual(['/v1/moderation-decisions/decision-1']);
    await render();
    expect(host.textContent).toContain('PRIVATE original decision 1');
    expect(host.textContent).toContain(m.decision_target_concealed());

    sourcePosition = '13';
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    concealed();
    await click(m.moderation_decision_read_retry());
    expect(host.textContent).toContain('PRIVATE original decision 1');

    await act(async () => user.type(host.querySelector('textarea')!, 'PRIVATE refresh draft'));
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    await session('another-viewer', 'AgICAgICAgICAgICAgICAg');
    concealed();
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    concealed();
    await session('author-1', 'AAAAAAAAAAAAAAAAAAAAAA');
    concealed(); // Returning to the old session cannot restore its retired page or draft.
    expect(commands).toHaveLength(0);
    await click(m.moderation_decision_read_retry());
    expect(host.querySelector('textarea')?.value).toBe('');

    await act(async () => user.type(host.querySelector('textarea')!, 'PRIVATE exact appeal draft'));
    await click(m.decision_appeal_submit());
    expect(host.textContent).toContain(m.decision_appeal_uncertain());
    expect(host.querySelector('textarea')?.disabled).toBe(true);
    mode = 'unavailable';
    await click(m.decision_refresh());
    concealed();
    expect(host.textContent).toContain(m.moderation_decision_read_unavailable());
    expect(commands).toHaveLength(1);
    mode = 'ready';
    await click(m.moderation_decision_read_retry());
    expect(host.querySelector('textarea')?.value).toBe('PRIVATE exact appeal draft');
    expect(host.textContent).toContain(m.decision_appeal_uncertain());
    gateCommand = new Promise((resolve) => {
      releaseCommand = resolve;
    });
    await click(m.decision_retry_same());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]?.csrf).toBe('AAAAAAAAAAAAAAAAAAAAAA');
    // Same author, different browser session: target absence supplies no exemption.
    await session('author-1', 'AQEBAQEBAQEBAQEBAQEBAQ');
    concealed();
    await act(async () => {
      releaseCommand();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    gateCommand = null;
    concealed();
    expect(host.textContent).not.toContain(m.decision_status_pending());
    await session(null, null);
    concealed();
    await session('author-1', 'AAAAAAAAAAAAAAAAAAAAAA');
    concealed();
    await click(m.moderation_decision_read_retry());
    expect(host.textContent).toContain(m.decision_status_pending());
    expect(host.textContent).not.toContain('PRIVATE exact appeal draft');
    expect(commands).toHaveLength(2);

    // Current read failures recover explicitly; final native denial conceals the entire page.
    mode = 'unavailable';
    await click(m.decision_refresh());
    concealed();
    expect(host.textContent).toContain(m.moderation_decision_read_unavailable());
    mode = 'ready';
    await click(m.moderation_decision_read_retry());
    expect(host.textContent).toContain(m.decision_status_pending());
    decisionReads = 0;
    mode = 'final-denial';
    await click(m.decision_refresh());
    concealed();
    expect(host.textContent).toContain(m.moderation_decision_read_closed());
    expect(decisionReads).toBe(1);
    mode = 'denied';
    const beforeDenial = calls.length;
    await expect(readDecisionPage({ data: { id: decision.id } })).rejects.toMatchObject({ isNotFound: true });
    expect(calls).toHaveLength(beforeDenial + 1);

    mode = 'ready';
    const second = await load('decision-2');
    await render(second);
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    const third = await load('decision-3');
    await render(third);
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toContain('PRIVATE original decision 3');
    expect(host.textContent).not.toContain('PRIVATE original decision 2');
    // A prepared refresh for a different viewer is refused even before the browser session query changes.
    requestViewer = 'another-viewer';
    await click(m.decision_refresh());
    concealed();
    requestViewer = 'author-1';
    mode = 'platform-closed';
    await click(m.moderation_decision_read_retry());
    concealed();
    expect(host.textContent).toContain(m.moderation_decision_read_platform_closed());
    expect(host.querySelector('button')).toBeNull();
    mode = 'ready';
    await render(await load('decision-3'));
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    await act(async () => root.unmount());
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toBe('');
    expect(commands).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    globalThis.fetch = fetchBefore;
    for (const key of Object.keys(environment)) delete environment[key];
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
