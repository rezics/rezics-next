import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient, SESSION_HEADER } from '@rezics/client';
import { dirname } from 'node:path';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/moderation/workbench' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { WorkbenchPage } = await import('../src/moderation/workbench-queue/page');
const { WorkbenchView } = await import('../src/moderation/workbench-queue/view');
const { prepareWorkbenchRead, readWorkbenchPage } = await import('../src/moderation/workbench-queue/read');
const { workbenchSearch } = await import('../src/moderation/workbench-queue/scope');
const { privateReaderFingerprint } = await import('../src/moderation/private-reader-origin');
const { m } = await import('../src/paraglide/messages.js');
const search = workbenchSearch({
  board: 'board-one',
  history: true,
  cursor: 'queue-original',
  historyDecision: 'decision',
});
const session = { state: 'signed-in', subject: 'moderator-one', csrfToken: 'original-session' };
const readerOrigin = { subject: session.subject, csrfFingerprint: await privateReaderFingerprint(session.csrfToken) };
const entry = {
  id: 'decision',
  targetId: 'original-target',
  targetKind: 'post',
  action: 'takedown',
  decidedAt: '2026-11-04T00:00:00Z',
  statement: 'Private retained history reason',
  history: { reasonState: 'retained', decider: 'withheld', receipt: 'permitted', target: 'unavailable' },
};
const native = createKernelClient('https://kernel.invalid', {
  fetch: (async (input, init) => {
    const request = new Request(input, init);
    expect(init?.cache).toBe('no-store');
    expect(request.headers.get('authorization')).toBe('Bearer prepared');
    const path = new URL(request.url).pathname;
    const data =
      path === '/v1/moderation-decisions/decision'
        ? {
            ...entry,
            appeal: null,
            appealDeadline: null,
            viewer: {
              affectedAuthor: false,
              observedAt: entry.decidedAt,
              appeal: { state: 'unavailable', reason: 'not_affected_author' },
            },
            targetContext: { state: 'concealed' },
          }
        : { viewer: { kind: 'board-moderator' }, entries: [entry], nextCursor: null };
    expect(['/v1/boards/board-one/moderation-history', '/v1/moderation-decisions/decision']).toContain(path);
    return Response.json(data, { headers: { [SESSION_HEADER]: 'native-source' } });
  }) as typeof fetch,
});
const load = (input = search, signal?: AbortSignal) =>
  readWorkbenchPage(native, input, 'Bearer prepared', readerOrigin, signal);

test('the mounted history owner hides an unadmitted browser visit and retires all reasons and controls on session replacement', async () => {
  for (const replacement of ['credential', 'equal', 'ABA'] as const) {
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host);
    try {
      const unknown = await prepareWorkbenchRead(cache, search, load, new AbortController().signal);
      await act(async () =>
        root.render(
          <QueryClientProvider client={cache}>
            <WorkbenchPage page={unknown} search={search} onSearch={() => {}} />
          </QueryClientProvider>,
        ),
      );
      expect(host.textContent).not.toContain('Private retained history reason');
      await act(async () => {
        cache.setQueryData(['session'], session);
      });
      expect(host.textContent).not.toContain('Private retained history reason');
      const admitted = await prepareWorkbenchRead(cache, search, load, new AbortController().signal);
      await act(async () =>
        root.render(
          <QueryClientProvider client={cache}>
            <WorkbenchPage key="fresh" page={admitted} search={search} onSearch={() => {}} />
          </QueryClientProvider>,
        ),
      );
      expect(host.textContent).toContain('Private retained history reason');
      expect(host.textContent).toContain(m.moderation_target_withheld());
      await act(async () => {
        if (replacement === 'ABA') cache.setQueryData(['session'], { ...session, subject: 'other' });
        cache.setQueryData(
          ['session'],
          replacement === 'credential' ? { ...session, csrfToken: 'replacement-session' } : { ...session },
        );
      });
      expect(host.textContent).not.toContain('Private retained history reason');
      expect(host.textContent).not.toContain(m.moderation_history_open_receipt());
      expect(host.textContent).not.toContain(m.moderation_target_withheld());
    } finally {
      await act(async () => root.unmount());
      host.remove();
      cache.clear();
    }
  }
});

test('late reads cannot revive a replaced visit; queue return restores the original keyboard control', async () => {
  const cache = new QueryClient();
  cache.setQueryData(['session'], session);
  let resolve!: (value: Awaited<ReturnType<typeof load>>) => void;
  const pending = prepareWorkbenchRead(
    cache,
    search,
    () =>
      new Promise((yes) => {
        resolve = yes;
      }),
    new AbortController().signal,
  );
  cache.setQueryData(['session'], { ...session, subject: 'replacement-account' });
  resolve(await load());
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  try {
    const returned = workbenchSearch({ ...search, history: undefined, historyReturn: true });
    const page = { ...(await load()), history: undefined, search: returned };
    await act(async () => root.render(<WorkbenchView page={page} onSearch={() => {}} isCurrent={() => true} />));
    expect(window.document.activeElement?.id).toBe('workbench-queue-reports');
    expect(returned.cursor).toBe('queue-original');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    cache.clear();
  }
});
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
