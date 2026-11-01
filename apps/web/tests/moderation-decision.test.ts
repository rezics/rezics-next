import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import * as localStart from '../.storybook/react-start';

const environment: Record<string, unknown> = {};
let requestViewer = 'author-1';
let requestEpoch = 'session-one';
const responseHeaders = new Headers();
mock.module('cloudflare:workers', () => ({ env: environment }));
// Run the actual BFF handlers locally, selecting the real browser session hook only in the DOM.
mock.module('@tanstack/react-start', () => ({
  ...localStart,
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
  getRequest: () =>
    new Request('https://site.test/moderation/decisions/decision-1', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
  setResponseHeader: (key: string, value: string) => responseHeaders.set(key, value),
}));
const { loadDecisionPage, canAppealDecision } = await import('../src/moderation/decision-read');
const { submitDecisionAppeal } = await import('../src/moderation/appeal');
const { DecisionPageView } = await import('../src/moderation/decision-page');

const decidedAt = '2026-01-01T12:00:00.000Z';
const decision = {
  id: 'decision-1',
  targetKind: 'post' as const,
  targetId: 'post-1',
  action: 'takedown' as const,
  statement: 'This post violates the board rules.',
  decidedAt,
  appealDeadline: '2026-07-03T12:00:00.000Z',
  appeal: null,
};

test('decision page reads its decision and the applicable existing record once each', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage('decision-1', {
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return decision;
    },
    post: async (id) => {
      calls.push(`post:${id}`);
      return {
        id,
        threadId: 'thread-1',
        createdAt: decidedAt,
        authorId: 'author-1',
        text: 'The affected post',
        href: '/threads/thread-1#post-1',
      };
    },
    thread: async (id) => {
      calls.push(`thread:${id}`);
      return { id, createdAt: decidedAt, authorId: 'author-1', text: 'The affected thread', href: `/threads/${id}` };
    },
  });

  expect(page).toMatchObject({ decision, target: { id: 'post-1', text: 'The affected post' } });
  expect(calls).toEqual(['decision:decision-1', 'post:post-1']);
  expect(calls).toHaveLength(2);
});

test('appeal access is inclusive of the deadline and limited to the author without an existing appeal', () => {
  expect(canAppealDecision(decision, 'author-1', 'author-1', Date.parse(decision.appealDeadline))).toBe(true);
  expect(canAppealDecision(decision, 'author-1', 'author-1', Date.parse(decision.appealDeadline) + 1)).toBe(false);
  expect(canAppealDecision(decision, 'author-1', 'someone-else', Date.parse(decidedAt))).toBe(false);
  expect(
    canAppealDecision(
      { ...decision, appeal: { id: 'appeal-1', outcome: null } },
      'author-1',
      'author-1',
      Date.parse(decidedAt),
    ),
  ).toBe(false);
});

test('a successful appeal is followed by the decision read and becomes pending', async () => {
  const calls: string[] = [];
  const pending = {
    ...decision,
    appeal: { id: 'appeal-1', outcome: null, statement: 'I disagree.', resolvedAt: null },
  };
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

  expect(result).toMatchObject({ state: 'pending', decision: pending });
  expect(calls).toEqual(['appeal:decision-1:I disagree.', 'decision:decision-1']);
});

test('a 422 length error preserves the draft while late and duplicate appeals use the next decision state', async () => {
  const draft = 'x'.repeat(2001);
  let next = decision;
  const reader = { decision: async () => next };
  const tooLong = await submitDecisionAppeal('decision-1', draft, {
    appeal: async () => ({ status: 422 }),
    ...reader,
  });
  expect(tooLong).toMatchObject({ state: 'invalid', text: draft });

  next = { ...decision, appeal: { id: 'appeal-1', outcome: null, statement: 'Earlier appeal', resolvedAt: null } };
  for (const status of [409, 422]) {
    const refreshed = await submitDecisionAppeal('decision-1', 'My reason', {
      appeal: async () => ({ status }),
      ...reader,
    });
    expect(refreshed).toMatchObject({ state: 'updated', decision: next });
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
    decision,
    viewerId: 'author-1',
    target: { id: 'post-1', authorId: 'author-1', text: 'Affected post', href: '/threads/thread-1#post-1' },
  };
  const open = renderToStaticMarkup(createElement(DecisionPageView, { page, now: Date.parse(decidedAt) }));
  expect(open).toContain(decision.statement);
  expect(open).toContain('Affected post');
  expect(open).toContain('dateTime="' + decidedAt + '"');
  expect(open).toContain('dateTime="' + decision.appealDeadline + '"');
  expect(open).toContain('appeal-statement');
  expect(open).toContain('2,000');

  const late = renderToStaticMarkup(
    createElement(DecisionPageView, { page, now: Date.parse(decision.appealDeadline) + 1 }),
  );
  expect(late).not.toContain('appeal-statement');
  const otherReader = renderToStaticMarkup(
    createElement(DecisionPageView, { page: { ...page, viewerId: 'other' }, now: Date.parse(decidedAt) }),
  );
  expect(otherReader).not.toContain('appeal-statement');
});

test('a private decision remains readable when its target is withheld, including after its appeal deadline', async () => {
  const calls: string[] = [];
  const page = await loadDecisionPage(decision.id, {
    decision: async (id) => {
      calls.push(`decision:${id}`);
      return decision;
    },
    post: async (id) => {
      calls.push(`post:${id}`);
      return null;
    },
    thread: async () => {
      throw new Error('A post decision must not read a thread');
    },
  });
  expect(calls).toEqual(['decision:decision-1', 'post:post-1']);
  expect(page?.target).toBeNull();
  if (!page) throw new Error('The authorized decision must remain readable');
  for (const now of [Date.parse(decidedAt), Date.parse(decision.appealDeadline) + 1]) {
    const markup = renderToStaticMarkup(
      createElement(DecisionPageView, { page: { ...page, viewerId: 'author-1' }, now }),
    );
    expect(markup).toContain(decision.statement);
    expect(markup).toContain('data-slot="withheld"');
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
          page: { decision: { ...decision, appeal }, target: null, viewerId: 'author-1' },
          now: Date.parse(decidedAt),
        }),
      ),
    );
    expect(markup.match(/<main\b/g)).toHaveLength(1);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toContain('Original decision');
    expect(markup).toContain(decision.statement);
    expect(markup).toContain('Current content availability');
    expect(markup).toContain('This content is unavailable.');
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

test('current target reads hide nonavailable bytes and final decision denial discards the entire private page', async () => {
  const { fromPlainText } = await import('@rezics/document');
  const { decisionReadAdapters, loadCurrentDecisionPage } = await import('../src/moderation/decision-read');
  let record = {
    id: decision.targetId,
    threadId: 'thread-1',
    authorId: 'author-1',
    availability: 'available',
    removed: false,
    body: fromPlainText('Current permitted text'),
  };
  const reads = decisionReadAdapters(
    {
      'moderation-decisions': () => ({ get: async () => ({ data: decision }) }),
      posts: () => ({ get: async () => ({ data: { post: record } }) }),
      threads: () => ({
        get: async () => {
          throw new Error('No unrelated target read');
        },
      }),
    },
    'Bearer author',
  );
  expect(await reads.post(decision.targetId)).toMatchObject({
    text: 'Current permitted text',
    href: '/threads/thread-1#post-1',
  });
  for (const availability of ['withheld', 'erased', 'unavailable', 'unknown']) {
    record = { ...record, availability };
    expect(await reads.post(decision.targetId)).toBeNull();
  }
  record = { ...record, availability: 'available', id: 'another-post' };
  expect(await reads.post(decision.targetId)).toBeNull();
  const calls: string[] = [];
  const result = await loadCurrentDecisionPage(decision.id, {
    ...reads,
    decision: async () => {
      calls.push('decision');
      return calls.length === 1 ? decision : null;
    },
    post: async () => {
      calls.push('target');
      return { id: decision.targetId, text: 'Do not disclose after final denial', href: '/threads/thread-1#post-1' };
    },
  });
  expect(result).toBeNull();
  expect(calls).toEqual(['decision', 'target', 'decision']);
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
    ).toEqual({ state: 'conflict' });
  }
  for (const status of [201, 503]) {
    expect(
      await submitDecisionAppeal(decision.id, command.statement, {
        appeal: async () => ({ status }),
        decision: async () => decision,
      }),
    ).toEqual({ state: 'failed' });
    expect(intent.keyFor(command)).toBe(originalKey);
  }
});

// Authored UNRUN: controller integration owns execution of this default route/read/view regression.
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
  const commands: { body: string; key: string | null }[] = [];
  let mode: 'ready' | 'unavailable' | 'denied' | 'final-denial' | 'platform-closed' = 'ready';
  let decisionReads = 0;
  let loseFirstCommand = true;
  let gateRead: Promise<void> | null = null;
  let gateCommand: Promise<void> | null = null;
  let releaseRead!: () => void;
  let releaseCommand!: () => void;
  const decisions = new Map(
    [1, 2, 3].map((n) => [
      `decision-${n}`,
      {
        ...decision,
        id: `decision-${n}`,
        targetId: `post-${n}`,
        statement: `PRIVATE original decision ${n}`,
      },
    ]),
  );
  Object.assign(environment, {
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
        commands.push({ body: await request.text(), key: request.headers.get('idempotency-key') });
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
      if (mode === 'denied' || (mode === 'final-denial' && ordinal === 2))
        return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE DENIAL' }, { status: 404 });
      return Response.json(current);
    },
    { preconnect: fetchBefore.preconnect },
  );
  type Page = Awaited<ReturnType<typeof readDecisionPage>>;
  let page: Page;
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
    await session('author-1', 'session-one');
    page = await readDecisionPage({ data: { id: decision.id } });
    expect(page).toMatchObject({ target: null, viewerId: 'author-1', sessionEpoch: 'session-one' });
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/moderation-decisions/decision-1',
      '/v1/posts/post-1',
      '/v1/moderation-decisions/decision-1',
    ]);
    await render();
    expect(host.textContent).toContain('PRIVATE original decision 1');
    expect(host.querySelector('[data-slot="withheld"]')).not.toBeNull();
    await act(async () => user.type(host.querySelector('textarea')!, 'PRIVATE refresh draft'));
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    await session('another-viewer', 'another-session');
    concealed();
    await act(async () => {
      releaseRead();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    concealed();
    await session('author-1', 'session-one');
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
    // Same author, different browser session: target absence supplies no exemption.
    await session('author-1', 'session-two');
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
    await session('author-1', 'session-one');
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
    expect(decisionReads).toBe(2);
    mode = 'denied';
    const beforeDenial = calls.length;
    await expect(readDecisionPage({ data: { id: decision.id } })).rejects.toMatchObject({ isNotFound: true });
    expect(calls).toHaveLength(beforeDenial + 1);

    mode = 'ready';
    const second = await readDecisionPage({ data: { id: 'decision-2' } });
    await render(second);
    gateRead = new Promise((resolve) => {
      releaseRead = resolve;
    });
    await click(m.decision_refresh());
    const third = await readDecisionPage({ data: { id: 'decision-3' } });
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
    await render(await readDecisionPage({ data: { id: 'decision-3' } }));
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
