import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Use the existing local server-function bridge, retaining the real action, validator, session and kernel client.
const start = await import('@tanstack/react-start');
const startServer = await import('@tanstack/react-start/server');
const storyStart = await import('../.storybook/react-start');
const environment: Record<string, unknown> = {};
let actionRequest = new Request('https://site.test/en/boards/moderation');
mock.module('cloudflare:workers', () => ({ env: environment }));
mock.module('@tanstack/react-start/server', () => ({ ...startServer, ...storyStart, getRequest: () => actionRequest }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const bridge = storyStart.createServerFn();
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
          actionRequest = new Request('https://site.test/en/boards/moderation', {
            method: input?.data ? 'POST' : 'GET',
            headers,
          });
          return invoke(input as never);
        };
      },
    };
    return chain;
  },
  createIsomorphicFn: () => {
    let server: (...args: never[]) => unknown;
    let client: (...args: never[]) => unknown;
    const chain = {
      server(handler: typeof server) {
        server = handler;
        return chain;
      },
      client(handler: typeof client) {
        client = handler;
        return (...args: never[]) => (typeof window === 'undefined' ? server : client)(...args);
      },
    };
    return chain;
  },
}));
const { createModerationIntent, validateModerationKey } = await import('../src/moderation/command-intent');
const { sendDecisionAppeal } = await import('../src/moderation/appeal');
const { submitModerationAppealResolution, sendModerationAppealResolution, sendModerationReportAction } =
  await import('../src/moderation/actions');
const { AppealResolution } = await import('../src/moderation/appeal-resolution');

test('lost-response retries retain the command key and commit no duplicate author appeal, report action or resolution', async () => {
  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const decision = {
    id,
    targetKind: 'post',
    targetId: id,
    action: 'takedown',
    statement: 'Board rule.',
    decidedAt: '2026-01-01T00:00:00Z',
    appealDeadline: '2026-07-03T00:00:00Z',
    appeal: { id, outcome: null, statement: 'Please review.', resolvedAt: null },
  };
  for (const action of ['appeal', 'take-down', 'dismiss', 'reverse'] as const) {
    const form = createModerationIntent();
    const intent = { action, id, statement: 'Please review.' };
    const receipts = new Map<string, string>();
    const keys: string[] = [];
    let writes = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === 'GET') return Response.json(decision);
        expect(request.headers.get('authorization')).toBe('Bearer reviewer');
        const key = JSON.parse(request.headers.get('idempotency-key') ?? 'null');
        expect(validateModerationKey(key)).toBe(key);
        const command = request.url + (await request.text());
        keys.push(key);
        if (!receipts.has(key)) {
          receipts.set(key, command);
          writes++;
        } else expect(receipts.get(key)).toBe(command);
        if (keys.length === 1) return Response.json({ code: 'unavailable' }, { status: 503 });
        return Response.json(
          action === 'take-down'
            ? { securityRevision: '1' }
            : action === 'dismiss'
              ? { id, outcome: 'dismissed' }
              : { id },
          { status: action === 'appeal' ? 201 : 200 },
        );
      },
    });
    const send = () => {
      const idempotencyKey = form.keyFor(intent);
      if (action === 'appeal')
        return sendDecisionAppeal(client, { id, statement: intent.statement, idempotencyKey }, 'Bearer reviewer');
      if (action === 'reverse')
        return sendModerationAppealResolution(
          client,
          { id, outcome: 'reverse', statement: intent.statement, idempotencyKey },
          'Bearer reviewer',
        );
      return sendModerationReportAction(
        client,
        action === 'dismiss'
          ? { action, reportId: id, idempotencyKey }
          : {
              action,
              reportId: id,
              targetKind: 'post',
              targetId: id,
              reason: 'Rule',
              idempotencyKey,
            },
        'Bearer reviewer',
      );
    };
    const first = await send().catch(() => undefined);
    expect(first === undefined || ('state' in first && first.state === 'failed')).toBe(true);
    const confirmed = await send();
    expect(confirmed).toBeDefined();
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(writes).toBe(1);
    expect(form.keyFor({ ...intent, statement: 'Changed intent' })).not.toBe(keys[0]);
    form.changed();
    expect(form.keyFor(intent)).not.toBe(keys[0]);
  }
});

test('reviewers see the confirmed upheld or reversed statement and authority failures never become confirmation', async () => {
  for (const outcome of ['uphold', 'reverse'] as const) {
    const confirmed = await submitModerationAppealResolution(async () => ({ id: 'appeal' }), {
      id: 'appeal',
      outcome,
      statement: '  Independent review.  ',
    });
    if (confirmed.state !== 'resolved') throw new Error('Expected confirmed resolution');
    const html = renderToStaticMarkup(
      createElement(AppealResolution, {
        appealId: 'appeal',
        mayResolve: true,
        resolution: { outcome: confirmed.outcome === 'uphold' ? 'upheld' : 'reversed', statement: confirmed.statement },
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(outcome === 'uphold' ? 'Decision upheld' : 'Decision reversed');
    expect(html).toContain('Independent review.');
    expect(html).not.toContain('<textarea');
  }
  for (const status of [403, 409, 404]) {
    const send = () =>
      submitModerationAppealResolution(
        async () => {
          throw Object.assign(new Error('Denied'), { status });
        },
        { id: 'appeal', outcome: 'reverse', statement: 'Review.' },
      );
    if (status === 404) await expect(send()).rejects.toThrow('Denied');
    else expect(await send()).toEqual({ state: status === 403 ? 'forbidden' : 'conflict' });
  }
});

// Authored for integration; intentionally UNRUN in the implementation worker's typing-only attempt.
test('The actual AppealResolution form freezes an uncertain command and explicitly retries its exact payload and key without permitting a contradictory new resolution or crossing viewer retirement', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/boards/moderation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createContext, useContext } = await import('react');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { AuthoringDepartureProvider } = await import('../src/threads/authoring-departure');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', storybook));
  const user = userEvent.setup({ document: window.document });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const originalSession = { state: 'signed-in' as const, subject: 'reviewer', csrfToken: 'AAAAAAAAAAAAAAAAAAAAAA' };
  let authorizations = 0;
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
        credential: async () => {
          authorizations++;
          return {
            status: 'active',
            subject: 'reviewer',
            accessToken: 'reviewer',
            csrfToken: originalSession.csrfToken,
          };
        },
      }),
    },
  });
  const recorded = createStoryRecordedKernelFetch();
  const originalFetch = globalThis.fetch;
  const calls: { path: string; body: string; key: string | null; authorization: string | null }[] = [];
  const receipts = new Map<string, string>();
  let effects = 0;
  let lose = true;
  let release!: () => void;
  let gate: Promise<void> | null = null;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method !== 'POST') return recorded(request);
      const call = {
        path: new URL(request.url).pathname,
        body: await request.text(),
        key: request.headers.get('idempotency-key'),
        authorization: request.headers.get('authorization'),
      };
      expect(call.path).toMatch(/^\/v1\/moderation-appeals\/[0-9a-f-]+:resolve$/u);
      expect(call.authorization).toBe('Bearer reviewer');
      validateModerationKey(JSON.parse(call.key!));
      calls.push(call);
      const payload = call.path + call.body;
      if (!receipts.has(call.key!)) {
        receipts.set(call.key!, payload);
        effects++;
      } else expect(receipts.get(call.key!)).toBe(payload);
      if (gate) await gate;
      if (lose) {
        lose = false;
        throw new TypeError('Response lost after commit');
      }
      return Response.json({ id: call.path.split('/').at(-1)!.replace(':resolve', '') });
    },
    { preconnect() {} },
  ) as typeof fetch;
  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  let generation = 0;
  let props = { appealId: id, mayResolve: true };
  let sibling = false;
  let reads = 0;
  const notifications: boolean[] = [];
  const Presentation = createContext<ReturnType<typeof createElement> | null>(null);
  const parent = createRootRoute({ component: Outlet });
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ['/review?tab=appeals'] }),
    routeTree: parent.addChildren([
      createRoute({
        getParentRoute: () => parent,
        path: '/review',
        validateSearch: (search) => search,
        component: () => useContext(Presentation),
      }),
      createRoute({
        getParentRoute: () => parent,
        path: '/destination',
        loader: () => {
          reads++;
          release();
        },
        component: () => createElement(AppealResolution, { appealId: 'replacement', mayResolve: true }),
      }),
    ]),
  });
  await router.load();
  const flush = () =>
    act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  const render = async () => {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(Presentation.Provider, {
            value: createElement(AuthoringDepartureProvider, {
              sessionBound: false,
              children: [
                createElement(AppealResolution, {
                  ...props,
                  key: generation,
                  onUnresolvedChange: (value) => notifications.push(value),
                }),
                sibling
                  ? createElement(AppealResolution, { key: 'sibling', appealId: 'sibling', mayResolve: true })
                  : null,
              ],
            }),
            children: createElement(RouterProvider, { router }),
          }),
        ),
      ),
    );
    await flush();
  };
  const button = (name: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === name)!;
  const click = async (name: string) => {
    await act(async () => button(name).click());
    await flush();
  };
  const type = async () => {
    await act(async () => user.type(host.querySelector('textarea')!, '  Private independent review.  '));
  };
  const blocked = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dialog = () => window.document.querySelector('[role="alertdialog"]');
  const depart = async (href: string) => {
    await act(async () => {
      void router.navigate({ href });
    });
    await flush();
  };
  const decide = async (label: string) => {
    await act(async () =>
      [...dialog()!.querySelectorAll('button')].find((node) => node.textContent === label)!.click(),
    );
    await flush();
  };
  const hold = () => {
    gate = new Promise<void>((done) => {
      release = done;
    });
  };
  try {
    cache.setQueryData(sessionQuery.queryKey, originalSession);
    hold();
    await render();
    expect(blocked()).toBe(false);
    await type();
    sibling = true;
    await render();
    await act(async () => user.type(host.querySelectorAll('textarea')[1]!, 'Second local review.'));
    await depart('/review?tab=appeals&selected=metadata');
    expect(dialog()).toBeNull();
    await depart('/review?tab=appeals&cursor=next');
    expect(window.document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
    expect(dialog()!.textContent).toContain(m.moderation_resolution_leave_unsaved());
    await decide(m.thread_authoring_stay());
    expect([...host.querySelectorAll('textarea')].map((node) => node.value)).toEqual([
      '  Private independent review.  ',
      'Second local review.',
    ]);
    sibling = false;
    await render();
    const reverse = button(m.moderation_appeal_reverse_action());
    await act(async () => {
      reverse.click();
      reverse.click();
      button(m.moderation_appeal_uphold_action()).click();
    });
    await flush();
    expect(calls).toHaveLength(1);
    expect(host.querySelector('textarea')!.disabled).toBe(true);
    await depart('/review?tab=appeals&thread=another');
    expect(dialog()!.textContent).toContain(m.moderation_resolution_leave_pending());
    await decide(m.thread_authoring_stay());
    await act(async () => {
      release();
    });
    gate = null;
    await flush();
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.moderation_appeal_intent_uncertain());
    expect(reverse.disabled).toBe(true);
    await depart('/review?tab=appeals&cursor=next');
    await decide(m.thread_authoring_stay());
    expect(button(m.moderation_appeal_uphold_action()).disabled).toBe(true);
    await act(async () => user.type(host.querySelector('textarea')!, 'Contrary edit'));
    expect(host.querySelector('textarea')!.value).toBe('  Private independent review.  ');
    await click(m.moderation_appeal_uphold_action());
    await click(m.moderation_appeal_reverse_action());
    expect(calls).toHaveLength(1); // No automatic resume, edit or contrary outcome.
    await click(m.moderation_appeal_intent_retry());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
    expect(JSON.parse(calls[1]!.body)).toEqual({ outcome: 'reverse', statement: 'Private independent review.' });
    expect(effects).toBe(1);
    expect(authorizations).toBe(2); // Both attempts independently prepare the current session.
    expect(host.querySelector('[role="status"]')!.textContent).toContain(m.moderation_appeal_reversed());
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Private independent review.');
    expect(blocked()).toBe(false);
    // An unrelated failed refresh leaves this mounted form and its confirmed outcome intact.
    await Promise.reject(new Error('Unrelated refresh failed')).catch(() => render());
    expect(host.querySelector('[role="status"]')!.textContent).toContain('Private independent review.');
    expect(host.querySelector('textarea')).toBeNull();
    expect(calls).toHaveLength(2);

    generation++;
    hold();
    await render();
    await type();
    await click(m.moderation_appeal_reverse_action());
    const beforeLeave = [...notifications];
    await depart('/destination');
    expect(reads).toBe(0);
    await decide(m.thread_authoring_leave()); // Destination read settles the already sent original command.
    expect(reads).toBe(1);
    expect(notifications).toEqual(beforeLeave);
    expect(host.textContent).not.toContain('Private independent review.');
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.querySelector('textarea')!.value).toBe('');
    gate = null;
    await depart('/review?tab=appeals');

    for (const retirement of ['viewer', 'session', 'signed-out', 'admission', 'appeal', 'unmount'] as const) {
      generation++;
      props = { appealId: id, mayResolve: true };
      cache.setQueryData(sessionQuery.queryKey, originalSession);
      hold();
      await render();
      await type();
      await click(m.moderation_appeal_reverse_action());
      const before = calls.length;
      if (retirement === 'session') await depart('/review?tab=appeals&post=replacement');
      await act(async () => {
        if (retirement === 'viewer')
          cache.setQueryData(sessionQuery.queryKey, { ...originalSession, subject: 'another-reviewer' });
        if (retirement === 'session')
          cache.setQueryData(sessionQuery.queryKey, { ...originalSession, csrfToken: 'BBBBBBBBBBBBBBBBBBBBBA' });
        if (retirement === 'signed-out')
          cache.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
      });
      if (retirement === 'admission') props = { ...props, mayResolve: false };
      if (retirement === 'appeal') props = { ...props, appealId: id.replace(/1$/, '2') };
      if (retirement === 'unmount') await act(async () => root.render(null));
      else await render();
      await act(async () => {
        release();
      });
      gate = null;
      await flush();
      expect(dialog()).toBeNull();
      expect(host.textContent).not.toContain('Private independent review.');
      expect(host.querySelector('[role="status"]')).toBeNull();
      expect(host.querySelector('textarea')).toBeNull();
      if (retirement !== 'unmount') {
        expect(host.textContent).toContain(m.moderation_appeal_intent_retired());
        // Restoring old props/session cannot automatically resurrect the old private intent.
        props = { appealId: id, mayResolve: true };
        cache.setQueryData(sessionQuery.queryKey, originalSession);
        await render();
        expect(host.querySelector('button')).toBeNull();
      }
      expect(calls).toHaveLength(before);
    }
  } finally {
    await act(async () => root.unmount());
    cache.clear();
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(environment)) delete environment[key];
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
