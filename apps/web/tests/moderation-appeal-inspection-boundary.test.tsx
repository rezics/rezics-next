import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createAppealResolutionIntent } from '../src/moderation/appeal-resolution/intent';
import { appealReadKey, moderationAppealInput } from '../src/moderation/appeals-read-model';
import { WorkbenchAppeal } from '../src/moderation/workbench-appeal';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/authoring-departure', () => ({
  AuthoringDepartureBoundary: ({ children }: { children: ReactNode }) => <>{children}</>,
  useAuthoringDeparture: () => ({ release() {} }),
}));
const { readModerationAppealPage } = await import('../src/moderation/appeals-read');
const { readWorkbenchPage, prepareWorkbenchRead } = await import('../src/moderation/workbench-queue/read');
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/moderation/workbench' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  Element: browser.Element,
  Node: browser.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of saved)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});
const session = { state: 'signed-in', subject: 'viewer', csrfToken: 'csrf' };
const origin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(session.csrfToken) };
const source = { partition: 0, epoch: 1, position: '12' };
const provenance = { actorId: 'viewer', session: { clientId: 'web', authnEpoch: 1 }, source };
const authorization = `Bearer ${btoa('{}')}.${btoa(JSON.stringify({ sub: 'viewer', client_id: 'web', authn_epoch: 1 }))}.signature`;

const row = {
  id: 'appeal',
  decisionId: 'decision',
  appellantId: 'private-account',
  statement: 'Restore this.',
  createdAt: '2026-11-01T00:00:00Z',
  canResolve: false,
  decision: { statement: 'Original decision.', target: { kind: 'board' as const, id: 'board' } },
};

test('1/10/20 installed rows cross the adapter and panel without identity or target reads; sparse stays sparse', async () => {
  for (const count of [1, 10, 20, 0]) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url).pathname);
        expect(request.cache).toBe('no-store');
        return Response.json({
          appeals: Array.from({ length: count }, (_, i) => ({ ...row, id: `appeal-${i}` })),
          next: 'opaque',
        });
      },
    });
    const page = await readModerationAppealPage(client, { boardId: 'board' }, 'Bearer viewer', 'viewer');
    expect(page.state).toBe('ready');
    expect(page.appeals).toHaveLength(count);
    expect(page.targets).toEqual([]);
    expect(page.next).toBe('opaque');
    expect(calls).toEqual(['/v1/boards/board/appeals']);
    const inspect = await readModerationAppealPage(
      client,
      { boardId: 'board', inspect: row.id },
      'Bearer viewer',
      'viewer',
    );
    expect(inspect.state).toBe('unavailable'); // Incomplete pages cannot masquerade as exact inspection.
    expect(calls).toHaveLength(2);
    const markup = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: { state: 'ready', appeals: page.appeals, selectedAppeal: row },
        queueHref: '?cursor=captured',
      }),
    );
    expect(markup).toContain('Original decision.');
    expect(markup).toContain('Restore this.');
    expect(markup).toContain('href="?cursor=captured"');
    expect(markup).not.toContain('private-account');
    const resolved = renderToStaticMarkup(
      createElement(WorkbenchAppeal, {
        appealId: row.id,
        page: {
          state: 'ready',
          appeals: [],
          selectedAppeal: {
            ...row,
            decision: {
              ...row.decision,
              appeal: { outcome: 'reversed', statement: 'Restored.', resolvedAt: row.createdAt },
            },
          },
        },
        queueHref: '?cursor=captured',
      }),
    );
    expect(resolved).toContain(m.moderation_appeal_reversed());
    expect(resolved).toContain('Restored.');
  }
});

test('inspect binds the private read identity and uncertain delivery keeps its original sender and command', async () => {
  const input = moderationAppealInput('board', { cursor: 'captured', inspect: 'appeal' });
  expect(input.inspect).toBe('appeal');
  expect(appealReadKey(input)).not.toBe(appealReadKey({ ...input, inspect: 'other' }));
  const intent = createAppealResolutionIntent('appeal', 'original-native-session');
  intent.synchronize('appeal', 'viewer-session', true);
  intent.edit('Review.');
  const calls: unknown[] = [];
  const command = intent.begin('reverse', async (original) => {
    calls.push(original);
    throw new Error('lost');
  })!;
  await expect(intent.send(command)).rejects.toThrow('lost');
  intent.uncertain();
  expect(intent.retry()).toBe(command);
  expect(command.nativeSession).toBe('original-native-session');
  await expect(intent.send(command)).rejects.toThrow('lost');
  expect(calls.length).toBe(2);
  expect(calls.every((item) => item === command)).toBe(true);
  intent.synchronize('appeal', 'replacement-session', true);
  await expect(intent.send(command)).rejects.toThrow('unavailable');
});

test('installed exact requests mount populated, empty, sparse, concealed, unavailable and resolved selections without scanning', async () => {
  const selected = {
    ...row,
    source,
    appellantIdentity: { state: 'available', kind: 'actor', handle: 'reader', displayName: 'Reader', automated: false },
    targetContext: {
      state: 'available',
      destination: { kind: 'thread', id: 'current-thread', boardId: 'current-board' },
    },
    resolutionCommand: {
      operationId: 'moderation_appeal.resolve',
      method: 'POST',
      path: '/v1/moderation-appeals/appeal:resolve',
    },
    resolution: null,
  };
  for (const state of ['populated', 'empty', 'sparse', 'concealed', 'unavailable', 'resolved', 'retry']) {
    const search = workbenchSearch({ queue: 'appeals', board: 'board', case: 'appeal', cursor: 'captured' });
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push(url.pathname + url.search);
        expect(request.headers.get('authorization')).toBe(authorization);
        expect(request.cache).toBe('no-store');
        if (state === 'retry' && calls.length === 1)
          return Response.json({ code: 'dependency_unavailable' }, { status: 503 });
        return Response.json(
          {
            appeals: state === 'populated' ? [selected] : [],
            next: state === 'sparse' ? 'sparse-next' : null,
            provenance,
            ...(state === 'empty'
              ? {}
              : {
                  selectedAppeal: {
                    ...selected,
                    ...(state === 'concealed' || state === 'unavailable'
                      ? { appellantIdentity: { state }, targetContext: { state } }
                      : {}),
                    ...(state === 'resolved'
                      ? { resolution: { outcome: 'upheld', statement: 'Reviewed.', resolvedAt: row.createdAt } }
                      : {}),
                  },
                }),
          },
          { headers: { 'rezics-session-token': 'opaque-native-session' } },
        );
      },
    });
    const read = () => readWorkbenchPage(client, search, authorization, origin);
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    cache.setQueryData(['session'], session);
    const page = await prepareWorkbenchRead(cache, search, read, new AbortController().signal);
    const host = document.createElement('main');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          <QueryClientProvider client={cache}>
            <WorkbenchPage page={page} search={search} onSearch={() => {}} read={read} />
          </QueryClientProvider>,
        ),
      );
      if (state === 'retry')
        await act(async () =>
          [...host.querySelectorAll('button')]
            .find((button) => button.textContent === m.moderation_queue_retry())!
            .click(),
        );
      expect(calls).toHaveLength(state === 'retry' ? 2 : 1);
      expect(calls.every((call) => call === '/v1/boards/board/appeals?limit=20&cursor=captured&inspect=appeal')).toBe(
        true,
      );
      expect(host.querySelector('a')?.getAttribute('href')).toContain('cursor=captured');
      expect(host.querySelector('a')?.getAttribute('href')).toContain('board=board');
      expect(host.textContent).not.toContain('private-account');
      expect(host.textContent).not.toContain('opaque-native-session');
      if (state === 'empty') expect(host.textContent).toContain(m.moderation_workbench_appeal_unavailable());
      else {
        expect(host.textContent).toContain('Original decision.');
        expect(host.textContent).toContain('Restore this.');
        expect(host.textContent).toContain(
          state === 'resolved' ? 'Reviewed.' : m.moderation_appeal_resolution_pending(),
        );
        if (state === 'populated') expect(host.textContent).toContain('Reader · @reader');
        if (state === 'concealed') expect(host.textContent).toContain(m.moderation_appeal_context_concealed());
        if (state === 'unavailable') expect(host.textContent).toContain(m.moderation_target_unavailable());
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      cache.clear();
    }
  }
});

test('exact selection rejects mismatched actor, missing native session, missing outcome and uncovered source', async () => {
  for (const defect of ['actor', 'session', 'epoch', 'client', 'outcome', 'source', 'id']) {
    const client = createKernelClient('https://kernel.test', {
      fetch: async () =>
        Response.json(
          {
            appeals: [],
            next: null,
            provenance: {
              ...provenance,
              actorId: defect === 'actor' ? 'other' : 'viewer',
              session: { clientId: defect === 'client' ? 'other' : 'web', authnEpoch: defect === 'epoch' ? 2 : 1 },
            },
            selectedAppeal: {
              ...row,
              id: defect === 'id' ? 'other' : row.id,
              source: { ...source, position: defect === 'source' ? '13' : '12' },
              ...(defect === 'outcome' ? {} : { resolution: null }),
              resolutionCommand: {
                operationId: 'moderation_appeal.resolve',
                method: 'POST',
                path: '/v1/moderation-appeals/appeal:resolve',
              },
            },
          },
          { headers: defect === 'session' ? {} : { 'rezics-session-token': 'opaque-native-session' } },
        ),
    });
    const page = await readModerationAppealPage(
      client,
      { boardId: 'board', threadId: 'thread', inspect: 'appeal', cursor: 'captured' },
      'Bearer viewer',
      'viewer',
      origin,
    );
    expect(page.state).toBe('unavailable');
    expect(page.selectedAppeal).toBeUndefined();
    expect(page.appeals).toEqual([]);
  }
});

test('native same-intent retry echoes original opaque session and operands; advice cannot override native denial', async () => {
  const { sendModerationAppealResolution } = await import('../src/moderation/actions');
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return requests.length === 1
        ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
        : Response.json({ id: 'appeal' });
    },
  });
  const intent = createAppealResolutionIntent('appeal', 'opaque-original');
  intent.synchronize('appeal', 'browser-session', true);
  intent.edit('  Review.  ');
  const command = intent.begin('reverse', (original) =>
    sendModerationAppealResolution(client, original, 'Bearer original'),
  )!;
  await expect(intent.send(command)).rejects.toThrow();
  intent.uncertain();
  expect(intent.retry()).toBe(command);
  intent.settle(await intent.send(command));
  expect(intent.result).toEqual({ state: 'resolved', outcome: 'reverse', statement: 'Review.' });
  for (const request of requests) {
    expect(new URL(request.url).pathname).toBe('/v1/moderation-appeals/appeal:resolve');
    expect(request.headers.get('rezics-session-token')).toBe('opaque-original');
    expect(request.headers.get('authorization')).toBe('Bearer original');
    expect(request.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
    expect(await request.json()).toEqual({ outcome: 'reverse', statement: 'Review.' });
  }
  const denied = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ code: 'forbidden' }, { status: 403 }),
  });
  expect(await sendModerationAppealResolution(denied, command, 'Bearer original')).toEqual({ state: 'forbidden' });
});
