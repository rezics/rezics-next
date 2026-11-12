import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readModerationAppeals, resolveAppealTargets } = await import('../src/moderation/appeals-read');
const { resolveModerationAppeal } = await import('../src/moderation/actions');
const { ModerationAppealsView } = await import('../src/moderation/appeals-tab');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function appeal(n: number, targetId: string, outcome: 'uphold' | 'reverse' | null = null) {
  return {
    id: id(n),
    decisionId: id(n + 100),
    appellantId: `private-author-${n}`,
    statement: `Author reason ${n}`,
    createdAt: `2026-01-0${n}T12:00:00.000Z`,
    decision: {
      id: id(n + 100),
      targetKind: 'post' as const,
      targetId,
      statement: `Moderator decision ${n}`,
      deciderId: `decider-${n}`,
      appeal: outcome
        ? {
            outcome: outcome === 'uphold' ? ('upheld' as const) : ('reversed' as const),
            statement: `Resolution statement ${n}`,
            resolvedAt: '2026-01-10T12:00:00.000Z',
          }
        : null,
    },
  };
}

test('board appeal pages keep their cursor, show decision and author statements, and resolve repeated targets once', async () => {
  const calls: string[] = [];
  const appeals = [appeal(1, id(50)), appeal(2, id(50)), appeal(3, id(51))];
  const page = await readModerationAppeals(
    {
      boardAppeals: async (boardId, cursor) => {
        calls.push(`board:${boardId}:${cursor ?? ''}`);
        return { appeals, next: 'next+page==' };
      },
      threadAppeals: async () => ({ appeals: [], next: null }),
    },
    { boardId: id(1), cursor: 'current/page==' },
  );
  const targets = await resolveAppealTargets(page.appeals, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return { post: { body: `Target ${targetId}` } };
    },
    thread: async () => null,
  });
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, { appeals: page.appeals, targets, next: page.next }),
  );

  expect(page.next).toBe('next+page==');
  expect(calls).toEqual([`board:${id(1)}:current/page==`, `post:${id(50)}`, `post:${id(51)}`]);
  expect(markup).toContain('Moderator decision 1');
  expect(markup).toContain('Author reason 1');
  expect(markup).toContain(`Target ${id(50)}`);
  expect(markup).not.toContain('private-author');
});

test('thread filter reads the thread appeals endpoint and returns its page', async () => {
  const calls: string[] = [];
  const page = await readModerationAppeals(
    {
      boardAppeals: async () => {
        calls.push('board');
        return { appeals: [], next: null };
      },
      threadAppeals: async (threadId, cursor) => {
        calls.push(`thread:${threadId}:${cursor ?? ''}`);
        return { appeals: [appeal(1, id(50))], next: 'thread-next' };
      },
    },
    { boardId: id(1), threadId: id(2), cursor: 'thread-cursor' },
  );
  expect(calls).toEqual([`thread:${id(2)}:thread-cursor`]);
  expect(page.next).toBe('thread-next');
});

test('pages of five and twenty appeals read the page and each distinct target once', async () => {
  for (const count of [5, 20]) {
    let kernelReads = 0;
    const appeals = Array.from({ length: count }, (_, index) => appeal(index + 1, id(77)));
    const page = await readModerationAppeals(
      {
        boardAppeals: async () => {
          kernelReads += 1;
          return { appeals, next: null };
        },
        threadAppeals: async () => ({ appeals: [], next: null }),
      },
      { boardId: id(1) },
    );
    const targets = await resolveAppealTargets(page.appeals, {
      post: async () => {
        kernelReads += 1;
        return { post: { body: 'same target' } };
      },
      thread: async () => {
        kernelReads += 1;
        return null;
      },
    });
    expect(page.appeals).toHaveLength(count);
    expect(targets).toHaveLength(1);
    expect(kernelReads).toBe(2);
  }
});

test('installed appeal HTTP statuses preserve closed, stale and unavailable outcomes and the exact cursor', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationAppealPage } = await import('../src/moderation/appeals-read');
  for (const [status, code, expected] of [
    [400, 'invalid_cursor', 'stale'],
    [401, 'unauthorized', 'closed'],
    [403, 'forbidden', 'closed'],
    [404, 'not_found', 'closed'],
    [409, 'stale_cursor', 'stale'],
    [503, 'dependency_unavailable', 'unavailable'],
  ] as const) {
    let requested: Request | undefined;
    const detail = `NEVER DISCLOSE ${status}`;
    const client = createKernelClient('https://kernel.test', {
      fetch: Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          requested = new Request(input, init);
          return Response.json({ code, detail }, { status });
        },
        { preconnect() {} },
      ),
    });
    const page = await readModerationAppealPage(
      client,
      { boardId: id(1), cursor: 'opaque+failed/page==' },
      'Bearer reviewer',
      id(900),
    );
    expect(requested?.url).toContain('/v1/boards/' + id(1) + '/appeals');
    expect(new URL(requested!.url).searchParams.get('cursor')).toBe('opaque+failed/page==');
    expect(page.state).toBe(expected);
    expect(page.appeals.length).toBe(0);
    expect(page.next).toBeNull();
    expect(JSON.stringify(page)).not.toContain(detail);
  }
});

test('uphold and reverse post the chosen outcome and moderator statement', async () => {
  const calls: { path: string; body: unknown }[] = [];
  await resolveModerationAppeal(
    async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    },
    { id: id(1), outcome: 'uphold', statement: 'Keep the decision.' },
  );
  await resolveModerationAppeal(
    async (path, body) => {
      calls.push({ path, body });
      return { ok: true };
    },
    { id: id(2), outcome: 'reverse', statement: 'Restore the post.' },
  );
  expect(calls).toEqual([
    { path: `/v1/moderation-appeals/${id(1)}:resolve`, body: { outcome: 'uphold', statement: 'Keep the decision.' } },
    { path: `/v1/moderation-appeals/${id(2)}:resolve`, body: { outcome: 'reverse', statement: 'Restore the post.' } },
  ]);
});

test('pending appeals offer resolution only when the viewer can resolve and is not the original decider', () => {
  const pending = appeal(1, id(50));
  const resolvable = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [{ key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Taken down post' } } }],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => true,
    }),
  );
  const originalDecider = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [],
      next: null,
      viewerId: 'decider-1',
      canResolve: () => true,
    }),
  );
  const unauthorized = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [pending],
      targets: [],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => false,
    }),
  );
  const resolved = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [appeal(1, id(50), 'reverse')],
      targets: [],
      next: null,
      viewerId: 'another-moderator',
      canResolve: () => true,
    }),
  );
  expect(resolvable).toContain('Uphold');
  expect(resolvable).toContain('Reverse');
  expect(originalDecider).toContain('Another moderator must resolve this appeal.');
  expect(originalDecider).not.toContain('Uphold');
  expect(originalDecider).not.toContain('Reverse');
  expect(unauthorized).not.toContain('Uphold');
  expect(unauthorized).not.toContain('Reverse');
  expect(resolved).toContain('Resolution statement 1');
  expect(resolved).not.toContain('Uphold');
});

test('the appeals tab is addressable and keeps reports as the default tab', async () => {
  const reportsPage = await Bun.file(new URL('../src/moderation/reports-page.tsx', import.meta.url)).text();
  const route = await Bun.file(new URL('../src/routes/boards/$id_.moderation.tsx', import.meta.url)).text();
  const markup = renderToStaticMarkup(createElement(ModerationAppealsView, { appeals: [], targets: [], next: null }));
  expect(markup).toContain('aria-current="page"');
  expect(markup).toContain('href="?"');
  expect(reportsPage).toContain('?tab=appeals');
  expect(route).toContain("search.tab === 'appeals'");
  expect(route).toContain("deps.tab === 'appeals'");
});

test('a successful resolution returns the outcome and statement rendered on the appeal', async () => {
  const resolution = await resolveModerationAppeal(async () => ({ id: id(1) }), {
    id: id(1),
    outcome: 'reverse',
    statement: 'Restore the post.',
  });
  const resolvedAppeal = {
    ...appeal(1, id(50)),
    decision: {
      ...appeal(1, id(50)).decision,
      appeal: {
        outcome: resolution.outcome === 'uphold' ? ('upheld' as const) : ('reversed' as const),
        statement: resolution.statement,
        resolvedAt: '2026-01-10T12:00:00.000Z',
      },
    },
  };
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, { appeals: [resolvedAppeal], targets: [], next: null }),
  );
  expect(resolution).toEqual({ outcome: 'reverse', statement: 'Restore the post.' });
  expect(markup).toContain('Restore the post.');
  expect(markup).not.toContain('Uphold</button>');
});

test('the API decision target shape resolves posts and threads without a decision or permission read', async () => {
  const calls: string[] = [];
  const appeals = [
    {
      ...appeal(1, id(50)),
      decision: { statement: 'Post decision', target: { kind: 'post' as const, id: id(50) } },
      canResolve: true,
    },
    {
      ...appeal(2, id(51)),
      decision: { statement: 'Thread decision', target: { kind: 'thread' as const, id: id(51) } },
      canResolve: false,
    },
  ];
  const targets = await resolveAppealTargets(appeals, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return { post: { body: 'Post target' } };
    },
    thread: async (targetId) => {
      calls.push(`thread:${targetId}`);
      return { thread: { title: 'Thread target' } };
    },
  });
  expect(calls).toEqual([`post:${id(50)}`, `thread:${id(51)}`]);
  const markup = renderToStaticMarkup(createElement(ModerationAppealsView, { appeals, targets, next: null }));
  expect(markup).toContain('Post target');
  expect(markup).toContain('Thread target');
  expect(markup.match(/>Uphold<\/button>/g)).toHaveLength(1);
  expect(markup).toContain('Another moderator must resolve this appeal.');
});

test('a list denial cannot be overridden by a local resolution predicate', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationAppealsView, {
      appeals: [{ ...appeal(1, id(50)), canResolve: false }],
      targets: [],
      next: null,
      canResolve: () => true,
    }),
  );
  expect(markup).toContain('Another moderator must resolve this appeal.');
  expect(markup).not.toContain('Uphold');
  expect(markup).not.toContain('Reverse');
});

test('a forbidden resolution survives the server boundary as data, while other failures stay retryable', async () => {
  const { submitModerationAppealResolution } = await import('../src/moderation/actions');
  const input = { id: id(1), outcome: 'reverse' as const, statement: 'Independent review.' };
  expect(
    await submitModerationAppealResolution(async () => {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }, input),
  ).toEqual({ state: 'forbidden' });
  expect(await submitModerationAppealResolution(async () => ({ id: id(1) }), input)).toEqual({
    state: 'resolved',
    outcome: 'reverse',
    statement: 'Independent review.',
  });
  await expect(
    submitModerationAppealResolution(async () => {
      throw Object.assign(new Error('Unavailable'), { status: 503 });
    }, input),
  ).rejects.toThrow('Unavailable');
});

// Authored UNRUN: controller integration owns execution of this default route/read/view regression.
test('The default private Appeals route recovers bounded reads and retires private statements and late responses when its viewer or page identity changes, including withheld targets', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createKernelClient } = await import('@rezics/client');
  const { loadModerationAppealsRequest } = await import('../src/moderation/appeals-read');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { ModerationAppealsPage } = await import('../src/moderation/appeals-tab');
  const { moderationAppealInput, appealPageIsCurrent, createAppealReadLifetime, prepareModerationAppealRead } =
    await import('../src/moderation/appeals-read-model');
  const { m } = await import('../src/paraglide/messages.js');
  const route = await Bun.file(new URL('../src/routes/boards/$id_.moderation.tsx', import.meta.url)).text();
  expect(route).toContain('<ModerationAppealsPage');
  expect(route).toContain('moderationAppealInput(params.id, deps)');
  // Abort admission moved to the shared original-observation preparation, before and after read.
  expect(route).toContain('abortController.signal');
  const preparation = await Bun.file(new URL('../src/moderation/private-reader-lifetime.ts', import.meta.url)).text();
  expect(preparation).toContain('signal?.throwIfAborted()');
  expect(route).toContain('appealPage.navigationKey === appealNavigationKey');
  expect(route).toContain("search: { ...selection, tab: 'appeals'");

  const rows = [1, 2].map((n) => ({
    ...appeal(n, id(50)),
    decision: { statement: `PRIVATE decision ${n}`, target: { kind: 'post', id: id(50) } },
    statement: `PRIVATE appeal ${n}`,
    canResolve: n === 1,
  }));
  const calls: Request[] = [];
  let mode: 'ready' | 'unavailable' | 'stale' | 'closed' | 'sparse' | 'empty' = 'ready';
  let gate: Promise<void> | undefined;
  let release!: () => void;
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const path = new URL(request.url).pathname;
        expect(request.method).toBe('GET');
        expect(request.headers.get('authorization')).toBe('Bearer reviewer');
        expect(request.cache).toBe('no-store');
        if (path === `/v1/posts/${id(50)}`)
          return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE TARGET' }, { status: 404 });
        expect([`/v1/boards/${id(1)}/appeals`, `/v1/threads/${id(2)}/appeals`]).toContain(path);
        if (gate) await gate;
        if (mode === 'unavailable')
          return Response.json({ code: 'dependency_unavailable', detail: 'NEVER DISCLOSE' }, { status: 503 });
        if (mode === 'stale') return Response.json({ code: 'stale_cursor', detail: 'NEVER DISCLOSE' }, { status: 409 });
        if (mode === 'closed') return Response.json({ code: 'not_found', detail: 'NEVER DISCLOSE' }, { status: 404 });
        return Response.json({
          appeals: mode === 'ready' ? rows : [],
          next: mode === 'empty' ? null : 'opaque+next/==',
        });
      },
      { preconnect() {} },
    ),
  });
  const first = moderationAppealInput(id(1), { thread: id(2), post: id(3) });
  const later = { ...first, cursor: 'opaque+next/==' };
  // Actual same-prepared provenance replaces subject-only default fixture admission.
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(['session'], { state: 'signed-in', subject: id(900), csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' });
  const environment = {
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
          subject: id(900),
          accessToken: 'reviewer',
          csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA',
        }),
      }),
    },
  } as unknown as import('../src/session/client').SessionEnv;
  const read = (input: typeof first) =>
    loadModerationAppealsRequest(
      new Request('https://site.test/boards/moderation', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      }),
      environment,
      input,
      () => client,
    );
  const preparedRead = (input: typeof first) => prepareModerationAppealRead(cache, input, read);
  const ready = await preparedRead(first);
  expect(ready.state).toBe('ready');
  expect(ready.viewerId).toBe(id(900));
  expect(ready.appeals.map((row) => row.canResolve)).toEqual([true, false]);
  expect(calls.map((request) => new URL(request.url).pathname)).toEqual([`/v1/threads/${id(2)}/appeals`]); // One bounded native page; no per-row target or identity hydration.
  const initial = renderToStaticMarkup(createElement(ModerationAppealsPage, { page: ready, input: first }));
  expect(initial).toContain('PRIVATE decision 1');
  expect(initial).toContain('PRIVATE appeal 1');
  expect(initial).toContain(m.moderation_target_unavailable());
  expect(initial).toContain(m.moderation_appeals_read_post_thread_scope());
  expect(initial.match(/>Uphold<\/button>/g)).toHaveLength(1);
  expect(initial).not.toContain('NEVER DISCLOSE');

  // The prepared viewer retires statements even without any readable target or evidence guard.
  for (const session of [
    { state: 'signed-out' },
    { state: 'unavailable' },
    { state: 'unknown' },
    { state: 'signed-in', subject: id(901) },
  ]) {
    const lifetime = createAppealReadLifetime();
    lifetime.observeViewer(ready.viewerId, { state: 'signed-in', subject: id(900) });
    const token = lifetime.begin();
    lifetime.observeViewer(ready.viewerId, session);
    expect(lifetime.viewerRetired).toBe(true);
    lifetime.observeViewer(ready.viewerId, { state: 'signed-in', subject: id(900) });
    expect(lifetime.accepts(token, ready, first, id(900))).toBe(false);
    const closed = renderToStaticMarkup(
      createElement(ModerationAppealsView, {
        ...ready,
        targets: [],
        state: lifetime.viewerRetired ? 'closed' : ready.state,
      }),
    );
    expect(closed).toContain(m.moderation_appeals_read_closed());
    expect(closed).not.toContain('PRIVATE');
    expect(closed).not.toContain('<textarea');
  }
  // Even a failed session preparation with no private rows binds the next retry to its browser viewer.
  const preparing = createAppealReadLifetime();
  preparing.observeViewer(null, { state: 'signed-in', subject: id(900) });
  const preparationRetry = preparing.begin();
  preparing.observeViewer(null, { state: 'signed-in', subject: id(901) });
  expect(preparing.accepts(preparationRetry, ready, first, id(900))).toBe(false);
  for (const changed of [
    { ...later },
    { ...first, threadId: id(4) },
    { ...first, postId: id(5) },
    { ...first, boardId: id(6) },
  ])
    expect(appealPageIsCurrent(ready, changed)).toBe(false);

  mode = 'unavailable';
  const failed = await preparedRead(later);
  expect(failed.appeals).toEqual([]);
  expect(failed.targets).toEqual([]);
  expect(failed.next).toBeNull();
  const window = new Window({ url: 'https://site.test/en/boards/moderation?tab=appeals' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  type Props = Parameters<typeof ModerationAppealsPage>[0];
  let props: Props = { page: failed, input: later, read };
  let key = 'later';
  const render = async (patch: Partial<Props> = {}) => {
    props = { ...props, ...patch };
    await act(async () =>
      root.render(
        createElement(QueryClientProvider, { client: cache }, createElement(ModerationAppealsPage, { ...props, key })),
      ),
    );
  };
  const click = async (name: string) => {
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === name);
    expect(button, name).toBeDefined();
    await act(async () => button!.click());
  };
  try {
    await render();
    expect(host.textContent).toContain(m.moderation_appeals_read_unavailable());
    expect(host.textContent).not.toContain('PRIVATE');
    mode = 'ready';
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = calls.length;
    await click(m.moderation_appeals_read_retry());
    expect(host.textContent).toContain(m.moderation_appeals_read_loading());
    expect(calls).toHaveLength(before + 1);
    expect(Object.fromEntries(new URL(calls.at(-1)!.url).searchParams)).toEqual({ limit: '20', cursor: later.cursor });
    // Leaving a read retires it before a late native success arrives, including return to the same URL.
    await render({ active: false });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    gate = undefined;
    await render({ active: true });
    expect(host.textContent).not.toContain('PRIVATE');
    expect(host.querySelector('textarea')).toBeNull();

    key = 'retry-current-page';
    mode = 'unavailable';
    const newFailure = await preparedRead(later);
    mode = 'ready';
    await render({ page: newFailure });
    await click(m.moderation_appeals_read_retry());
    expect(host.textContent).toContain('PRIVATE appeal 1');
    expect(host.querySelectorAll('textarea')).toHaveLength(1);
    expect(new URL(calls.at(-2)!.url).searchParams.get('cursor')).toBe(later.cursor);

    mode = 'stale';
    const stale = await preparedRead(later);
    key = 'restart-stale';
    let resets = 0;
    await render({
      page: stale,
      onRestart: () => {
        resets++;
      },
    });
    expect(host.textContent).toContain(m.moderation_appeals_read_stale());
    await click(m.moderation_appeals_read_restart());
    expect(resets).toBe(1);
    mode = 'empty';
    const reset = await preparedRead(first);
    key = 'reset-first-page';
    await render({ page: reset, input: first });
    expect(new URL(calls.at(-1)!.url).searchParams.has('cursor')).toBe(false);
    expect(host.textContent).toContain(m.moderation_appeals_empty());
    expect(host.querySelectorAll('li').length).toBe(0);
    const buttonLabels = [...host.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
    expect(buttonLabels.includes(m.moderation_queue_refresh())).toBe(true);
    expect(
      buttonLabels.some((label) =>
        [m.moderation_appeal_uphold_action(), m.moderation_appeal_reverse_action()].includes(label),
      ),
    ).toBe(false);

    for (const value of ['sparse', 'closed'] as const) {
      mode = value;
      const page = await preparedRead({ boardId: id(1), postId: id(3) });
      key = value;
      await render({ page, input: { boardId: id(1), postId: id(3) } });
      expect(host.textContent).toContain(
        value === 'sparse' ? m.moderation_appeals_read_sparse() : m.moderation_appeals_read_closed(),
      );
      expect(host.textContent).toContain(m.moderation_appeals_read_post_board_scope());
      expect(host.textContent).not.toContain(m.moderation_appeals_empty());
      expect(host.textContent).not.toContain('NEVER DISCLOSE');
      expect(host.querySelector('textarea')).toBeNull();
    }
    expect(calls.every((request) => !new URL(request.url).pathname.includes('/posts/' + id(3) + '/appeals'))).toBe(
      true,
    );
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
