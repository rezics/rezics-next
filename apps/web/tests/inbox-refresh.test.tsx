import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import type { InboxPage, InboxSeenAttempt, InboxSeenResult, ResolvedInboxPage } from '../src/inbox/inbox-read';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/inbox' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
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

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const reads = await import('../src/inbox/inbox-read');
const { ViewerInboxPage } = await import('../src/inbox/inbox-page');
const { currentInboxViewer, inboxViewerQueryKey } = await import('../src/inbox/inbox-viewer');
const { inboxPageQuery } = await import('../src/inbox/inbox-query');
const { sessionQuery } = await import('../src/session/query');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const continuation = 'opaque.second+page/cursor==';
const lateCursor = 'opaque.retired+page/cursor==';
const notice = (id: string): ResolvedInboxPage['items'][number] => ({
  id,
  unread: true,
  kind: 'reply',
  createdAt: '2026-10-29T10:00:00.000Z',
  actorId: 'actor',
  actorName: 'Momo',
  threadId: 'thread',
  postId: id,
  decisionId: null,
  reportId: null,
  href: `/threads/thread#post-${id}`,
  text: `Private reply ${id}`,
  unavailable: false,
});
const ready = (ids: string[], next: string | null): InboxPage => ({
  signedIn: true,
  state: 'ready',
  items: ids.map(notice),
  next,
});

afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('refresh returns to the current first page, retires older responses, and preserves an uncertain seen command', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken: 'token' });
  const viewer = currentInboxViewer(client)!;
  let firstPageReads = 0;
  const pageCalls: (string | undefined)[] = [];
  const loadPage = async (cursor?: string) => {
    pageCalls.push(cursor);
    if (cursor) return ready(['older', 'oldest'], null);
    return ready(firstPageReads++ === 0 ? ['newest'] : ['arrival', 'newest'], continuation);
  };
  const commands: { data: InboxSeenAttempt; work: ReturnType<typeof deferred<InboxSeenResult>> }[] = [];
  spyOn(reads, 'markInboxSeen').mockImplementation(({ data }) => {
    const work = deferred<InboxSeenResult>();
    commands.push({ data: { ...data }, work });
    return work.promise;
  });

  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(ViewerInboxPage, { viewer, csrfToken: 'token', loadPage }),
        ),
      ),
    );
  const button = (label: string) => {
    const node = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    expect(node, label).toBeDefined();
    return node!;
  };
  const click = (label: string) => act(async () => button(label).click());
  const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-notice-id]')].map((row) => row.dataset.noticeId);

  try {
    await render();
    await tick();
    await click(m.inbox_load_more());
    await tick();
    expect(rows()).toEqual(['newest', 'older', 'oldest']);
    expect(pageCalls).toEqual([undefined, continuation]);

    await click(m.inbox_triage_mark());
    expect(commands).toHaveLength(1);
    const original = { ...commands[0]!.data };
    await act(async () => commands[0]!.work.reject(new Error('response lost')));
    await tick();
    expect(host.textContent).toContain(m.inbox_seen_unknown());

    const late = deferred<InboxPage>();
    const staleResponse = client.fetchQuery(inboxPageQuery(viewer, lateCursor, () => late.promise));
    await tick();
    await click(m.inbox_start_first_page());
    await tick();
    late.resolve(ready(['retired'], null));
    await staleResponse.catch(() => {});
    await tick();

    expect(pageCalls).toEqual([undefined, continuation, undefined]);
    expect(rows()).toEqual(['arrival', 'newest']);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.data).toEqual(original);
    expect(
      client.getQueryCache().findAll({ queryKey: inboxViewerQueryKey(viewer) }).map((query) => query.queryKey.at(-1)),
    ).toEqual([null]);

    await click(m.inbox_seen_retry());
    expect(commands.map(({ data }) => data)).toEqual([original, original]);
    await act(async () => commands[1]!.work.reject(new Error('response lost again')));
    await tick();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
