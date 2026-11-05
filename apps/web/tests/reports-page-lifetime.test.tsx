import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode, type ComponentProps } from 'react';
import userEvent from '@testing-library/user-event';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import * as start from '../.storybook/react-start';
import thread from '../src/kernel/recorded/thread.json';
import accounts from '../src/kernel/recorded/accounts.json';
import type { Report, ReportReadInput } from '../src/moderation/reports-read';
import type { ReportActionInput } from '../src/moderation/actions';

// Authored actual composition, UNRUN in this implementation attempt. Only the server-function
// boundary and native HTTP replies are supplied; the page, cache, queue and cards are real.
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
  HTMLFormElement: window.HTMLFormElement,
  KeyboardEvent: window.KeyboardEvent,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const viewer = (subject = id(1), csrfToken = 'original-session') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const input: ReportReadInput = { boardId: id(10), status: 'pending', targetKind: 'post', order: 'oldest' };
const author = { ...accounts.accounts[0]!, displayName: 'Private native author' };
const post = {
  ...thread.thread.firstPost,
  id: id(20),
  threadId: id(30),
  revisionId: id(40),
  authorId: author.id,
  availability: 'available',
  sha256: 'a'.repeat(64),
  mediaIds: [],
  body: fromPlainText('Private current native body', 'blocks'),
};
const revisionBody = fromPlainText('Private exact reported body', 'blocks');
const revision = {
  ...post,
  revisionId: id(41),
  mediaIds: [id(60)],
  body: {
    ...revisionBody,
    doc: {
      ...revisionBody.doc,
      content: [
        ...revisionBody.doc.content!,
        { type: 'image', attrs: { id: 'private-exact-image', src: id(60), alt: 'Private exact native media' } },
      ],
    },
  },
};
const media = {
  id: id(60),
  containerId: post.threadId,
  digest: 'b'.repeat(64),
  width: 200,
  height: 100,
  variants: [{ format: 'webp', width: 200, height: 100 }],
  placeholder: null,
  focalPoint: null,
  credit: null,
};
const report = (n: number): Report => ({
  id: id(100 + n),
  target: { kind: 'post', id: post.id },
  revisionId: revision.revisionId,
  reason: 'Private native reason',
  evidence: 'Private submitted evidence',
  createdAt: '2026-10-28T12:00:00.000Z',
  outcome: null,
  resolvedAt: null,
});
let rows: Report[];
let next: string | null;
let listFailure: number | undefined;
let targetAvailability: 'available' | 'withheld' | 'erased';
let readGate: ReturnType<typeof deferred<Response>> | undefined;
let listStarted: ReturnType<typeof deferred<void>> | undefined;
const reads: Request[] = [];
const sends: (ReturnType<typeof deferred<Response>> & { request: Request })[] = [];
const inputs: ReportActionInput[] = [];
const native = createKernelClient('https://kernel.test', {
  fetch: async (url, init) => {
    const request = new Request(url, init);
    const path = new URL(request.url).pathname;
    if (path === '/v1/media/presentations') {
      reads.push(request);
      return Response.json({ images: [media] });
    }
    if (request.method === 'POST') {
      const send = { ...deferred<Response>(), request };
      sends.push(send);
      return send.promise;
    }
    reads.push(request);
    if (path.endsWith('/reports')) {
      listStarted?.resolve();
      expect(request.cache).toBe('no-store');
      expect(new URL(request.url).searchParams.get('limit')).toBe('20');
      if (readGate) {
        const gate = readGate;
        readGate = undefined;
        return gate.promise;
      }
      if (listFailure) return Response.json({ code: 'stale_cursor' }, { status: listFailure });
      return Response.json({ reports: rows, next });
    }
    if (path === `/v1/posts/${post.id}/revisions/${revision.revisionId}`)
      return Response.json({ post: { ...revision, availability: targetAvailability } });
    if (path === `/v1/posts/${post.id}`) return Response.json({ post: { ...post, availability: targetAvailability } });
    if (path === `/v1/threads/${post.threadId}`)
      return Response.json({
        thread: { ...thread.thread, id: post.threadId, boardId: input.boardId, firstPost: post },
      });
    if (path === `/v1/boards/${input.boardId}`)
      return Response.json({ board: { id: input.boardId, title: 'Private native board', availability: 'available' } });
    if (path === '/v1/accounts') return Response.json({ accounts: [author] });
    throw new Error(`Unexpected native read: ${request.url}`);
  },
});
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const originalActions = { ...(await import('../src/moderation/actions')) };
mock.module('../src/moderation/actions', () => ({
  ...originalActions,
  actionOnReport: ({ data }: { data: ReportActionInput }) => {
    inputs.push(data);
    return originalActions.sendModerationReportAction(native, data, 'Bearer original-reader');
  },
}));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { loadModerationReportsRequest, prepareModerationReportRead } = await import('../src/moderation/reports-read');
const { ModerationReportsPage } = await import('../src/moderation/reports-page');
const { m } = await import('../src/paraglide/messages.js');
type Props = ComponentProps<typeof ModerationReportsPage>;
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let mounted: boolean;
let client: InstanceType<typeof QueryClient>;
let props: Props;
let refreshes: number;
let continuations: string[];
let refreshGate: ReturnType<typeof deferred<void>> | undefined;
let navigationCurrent: boolean;
const navigationListeners = new Set<() => void>();
const navigation = {
  isCurrent: () => navigationCurrent,
  subscribe: (retire: () => void) => {
    navigationListeners.add(retire);
    return () => {
      navigationListeners.delete(retire);
    };
  },
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
// Accepted 924 provenance replaces the former subject-only fixture admission. The only
// deferred authentication surface is the platform credential transport on this same Request.
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
        subject: viewer().subject,
        accessToken: 'original-reader',
        csrfToken: viewer().csrfToken,
      }),
    }),
  },
} as unknown as import('../src/session/client').SessionEnv;
const actualRead = (data: ReportReadInput) =>
  loadModerationReportsRequest(
    new Request('https://site.test/boards/moderation', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    }),
    environment,
    data,
    () => native,
  );
const fresh = (scope = input) => prepareModerationReportRead(client, scope, actualRead, new AbortController().signal);
async function paint(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () =>
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <ModerationReportsPage {...props} />
        </QueryClientProvider>
      </StrictMode>,
    ),
  );
}
function button(label: string, index = 0) {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].filter(
    (node) => node.textContent?.trim() === label,
  )[index];
  expect(found).toBeDefined();
  return found!;
}
const click = (label: string, index = 0) => act(async () => button(label, index).click());
const warns = () => {
  const event = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
};
const chooseDeparture = (label: string) =>
  act(async () => {
    const dialog = window.document.querySelector('[role="alertdialog"]')!;
    [...dialog.querySelectorAll('button')].find((node) => node.textContent === label)!.click();
  });
const hidden = () => {
  for (const text of [
    'Private native reason',
    'Private submitted evidence',
    'Private current native body',
    'Private exact reported body',
    'Private exact native media',
    'Private native author',
    'Private native board',
  ])
    expect(host.textContent).not.toContain(text);
  expect(host.querySelector(`a[href*="${revision.revisionId}"]`)).toBeNull();
  expect(host.querySelector('[data-slot="document-image"]')).toBeNull();
  expect(host.querySelector('textarea')).toBeNull();
  expect(host.querySelector('[role="checkbox"]')).toBeNull();
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.threads_next_page())).toBe(false);
};
async function review() {
  await click(m.moderation_queue_review());
}
async function settle(index: number, status = 200) {
  await act(async () => {
    sends[index]!.resolve(Response.json({}, { status }));
    await tick();
  });
}
beforeEach(async () => {
  rows = [report(1), report(2)];
  next = 'opaque-next';
  listFailure = undefined;
  targetAvailability = 'available';
  reads.length = 0;
  sends.length = 0;
  inputs.length = 0;
  readGate = undefined;
  refreshGate = undefined;
  refreshes = 0;
  continuations = [];
  navigationCurrent = true;
  navigationListeners.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  root = createRoot(host);
  mounted = true;
  props = {
    page: await fresh(),
    input,
    navigation,
    onNext: (cursor) => {
      continuations.push(cursor);
    },
    onRefresh: async () => {
      refreshes++;
      await refreshGate?.promise;
    },
  };
});
afterEach(async () => {
  if (mounted) await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  mock.module('../src/moderation/actions', () => originalActions);
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('Default private report queue retires original evidence and queued commands on session/readiness/navigation replacement and admits only an explicitly current native page', async () => {
  await paint();
  expect(host.textContent).toContain('Private exact reported body');
  expect(host.textContent).toContain('Private current native body');
  expect(host.querySelector('[data-slot="document-image"]')).not.toBeNull();
  expect(reads.filter((r) => new URL(r.url).pathname === `/v1/posts/${post.id}`)).toHaveLength(1);
  expect(reads.filter((r) => r.url.includes('/revisions/'))).toHaveLength(1);
  const count = reads.length;
  await review();
  const queued = button(m.moderation_dismiss());
  await act(async () => {
    flushSync(() => {
      client.setQueryData(sessionQuery.queryKey, viewer(id(2)));
      client.setQueryData(sessionQuery.queryKey, viewer());
      queued.click();
    });
  });
  hidden();
  expect(inputs).toEqual([]);
  expect(sends).toEqual([]);
  expect(reads).toHaveLength(count);
  await paint({ page: props.page, input: { ...input } });
  hidden();
  const old = props.page;
  await paint({ page: await fresh() });
  expect(host.textContent).toContain('Private submitted evidence');
  await paint({ page: { ...old } });
  hidden();
});

for (const replacement of [
  { state: 'unknown', subject: null, csrfToken: null },
  { state: 'unavailable', subject: null, csrfToken: null },
  { state: 'preparing', subject: viewer().subject, csrfToken: 'original-session' },
  { state: 'denied', subject: viewer().subject, csrfToken: 'original-session' },
  { state: 'signed-out', subject: null, csrfToken: null },
  { ...viewer(), csrfToken: null },
  viewer(id(2)),
  viewer(id(1), 'replacement-session'),
])
  test(`original reports never revive after ${JSON.stringify(replacement)}`, async () => {
    await paint();
    await review();
    const queued = button(m.moderation_dismiss());
    const count = reads.length;
    await act(async () => {
      flushSync(() => {
        client.setQueryData(sessionQuery.queryKey, replacement);
        queued.click();
      });
    });
    hidden();
    expect(sends).toHaveLength(0);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer());
    });
    await paint();
    hidden();
    expect(reads).toHaveLength(count);
    await paint({ page: await fresh() });
    expect(host.textContent).toContain('Private exact reported body');
  });

test('unknown browser readiness cannot initially admit an otherwise native page', async () => {
  client.setQueryData(sessionQuery.queryKey, { state: 'unknown', csrfToken: null });
  await paint();
  hidden();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer());
  });
  await paint();
  hidden();
  expect(sends).toHaveLength(0);
});

test('navigation retirement catches batched away/back, queued bulk confirmation and late individual success', async () => {
  await paint();
  await click(m.moderation_bulk_select_loaded());
  await click(m.moderation_bulk_review());
  const queued = button(m.moderation_bulk_confirm({ count: 2 }));
  await act(async () => {
    flushSync(() => {
      navigationCurrent = false;
      for (const retire of navigationListeners) retire();
      navigationCurrent = true;
      queued.click();
    });
  });
  hidden();
  expect(sends).toHaveLength(0);
  expect(continuations).toEqual([]);
  await paint({ page: await fresh() });
  await review();
  await click(m.moderation_dismiss());
  expect(sends).toHaveLength(1);
  await act(async () => {
    for (const retire of navigationListeners) retire();
  });
  hidden();
  await settle(0);
  expect(refreshes).toBe(0);
  hidden();
});

test('scope, source, readiness and unmount retire original queued work, even when old props return', async () => {
  await paint();
  const old = props.page;
  await paint({ input: { ...input, cursor: 'other-page' } });
  hidden();
  await paint({ input });
  hidden();
  await paint({ page: await fresh() });
  await paint({ page: { ...props.page, state: 'loading' } });
  hidden();
  await paint({ page: old });
  hidden();
  await paint({ page: await fresh() });
  await review();
  await click(m.moderation_dismiss());
  await act(async () => {
    root.unmount();
    mounted = false;
  });
  await settle(0);
  expect(refreshes).toBe(0);
  expect(sends).toHaveLength(1);
});

test('late bulk completion cannot schedule the next item or refresh after same-account replacement', async () => {
  await paint();
  await click(m.moderation_bulk_select_loaded());
  await click(m.moderation_bulk_review());
  await click(m.moderation_bulk_confirm({ count: 2 }));
  expect(sends).toHaveLength(1);
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'new-session'));
  });
  hidden();
  await settle(0);
  expect(sends).toHaveLength(1);
  expect(refreshes).toBe(0);
  hidden();
});

test('loader read keeps original scope, selection, post precedence and session through deferred completion', async () => {
  const scope = { ...input, threadId: id(30), postId: post.id, cursor: 'original-cursor' };
  const gate = deferred<Response>();
  readGate = gate;
  listStarted = deferred<void>();
  const pending = fresh(scope);
  await listStarted.promise;
  listStarted = undefined;
  const list = new URL(reads.at(-1)!.url);
  expect(list.pathname).toBe(`/v1/posts/${post.id}/reports`);
  expect(Object.fromEntries(list.searchParams)).toEqual({
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    limit: '20',
    cursor: 'original-cursor',
  });
  client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'replacement-session'));
  client.setQueryData(sessionQuery.queryKey, viewer());
  gate.resolve(Response.json({ reports: rows, next }));
  await paint({ page: await pending, input: scope });
  hidden();
  expect(sends).toHaveLength(0);
  await paint({ page: await fresh(scope) });
  expect(host.textContent).toContain('Private exact reported body');
  const abort = new AbortController();
  const deferredRead = deferred<Response>();
  readGate = deferredRead;
  const aborted = prepareModerationReportRead(client, input, actualRead, abort.signal);
  abort.abort();
  deferredRead.resolve(Response.json({ reports: [], next: null }));
  await expect(aborted).rejects.toThrow();
});

test('current ordinary and uncertain actions preserve exact native intent and refresh only on success', async () => {
  await paint();
  const count = reads.length;
  await review();
  expect(warns()).toBe(false);
  await click(m.moderation_dismiss());
  expect(inputs).toHaveLength(1);
  expect(refreshes).toBe(0);
  await act(async () => {
    sends[0]!.reject(new TypeError('Failed to fetch'));
    await tick();
  });
  expect(host.textContent).toContain(m.moderation_queue_uncertain());
  expect(refreshes).toBe(0);
  expect(sends).toHaveLength(1);
  await click(m.threads_next_page());
  await chooseDeparture(m.thread_authoring_stay());
  expect(host.textContent).toContain(m.moderation_queue_uncertain());
  expect(Object.isFrozen(inputs[0])).toBe(true);
  await click(m.moderation_queue_retry_action());
  expect(inputs[1]).toEqual(inputs[0]);
  expect(sends[1]!.request.headers.get('idempotency-key')).toBe(JSON.stringify(inputs[0]!.idempotencyKey));
  expect(sends[1]!.request.headers.get('idempotency-key')).toBe(sends[0]!.request.headers.get('idempotency-key'));
  refreshGate = deferred<void>();
  await settle(1);
  expect(refreshes).toBe(1);
  expect(warns()).toBe(false);
  expect(host.textContent).not.toContain(m.moderation_queue_uncertain());
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer(id(2)));
  });
  hidden();
  await act(async () => {
    refreshGate!.resolve();
    await tick();
  });
  hidden();
  expect(reads).toHaveLength(count);
  expect(sends).toHaveLength(2);
});

test('current bulk keeps original per-item receipts, exact explicit retry and single-action exclusion', async () => {
  rows = [report(1), report(2), report(3)];
  await paint({ page: await fresh() });
  await click(m.moderation_bulk_select_loaded());
  await click(m.moderation_bulk_review());
  await click(m.moderation_bulk_confirm({ count: 3 }));
  await settle(0);
  expect(sends).toHaveLength(2);
  await act(async () => {
    sends[1]!.reject(new TypeError('Failed to fetch'));
    await tick();
  });
  expect(sends).toHaveLength(2);
  expect(refreshes).toBe(0);
  expect(host.textContent).toContain(m.moderation_bulk_dismissed());
  expect(host.textContent).toContain(m.moderation_bulk_uncertain());
  await click(m.moderation_bulk_retry());
  expect(inputs[2]).toEqual(inputs[1]);
  await settle(2);
  expect(sends).toHaveLength(3);
  expect(refreshes).toBe(1);
  expect(host.textContent).toContain(m.moderation_bulk_dismissed());
  expect(host.textContent).not.toContain(m.moderation_bulk_uncertain());
  expect(inputs.every((value) => value.action === 'dismiss')).toBe(true);
  expect(inputs[0]!.idempotencyKey).not.toBe(inputs[1]!.idempotencyKey);
  expect(host.textContent).not.toContain('Private submitted evidence');
});

test('current sparse continuation retires before navigation and stale cursor offers only explicit restart', async () => {
  rows = [];
  await paint({ page: await fresh() });
  expect(host.textContent).toContain(m.moderation_queue_empty_next());
  const count = reads.length;
  await click(m.threads_next_page());
  hidden();
  expect(continuations).toEqual(['opaque-next']);
  expect(reads).toHaveLength(count);
  expect(sends).toHaveLength(0);
  listFailure = 409;
  let restarts = 0;
  await paint({
    page: await fresh(),
    onRestart: () => {
      restarts++;
    },
  });
  expect(host.textContent).toContain(m.moderation_queue_stale());
  await click(m.moderation_queue_restart());
  expect(restarts).toBe(1);
  hidden();
});

for (const availability of ['withheld', 'erased'] as const)
  test(`independent ${availability} evidence never acquires body from report inspection`, async () => {
    targetAvailability = availability;
    await paint({ page: await fresh() });
    expect(host.textContent).toContain('Private submitted evidence');
    expect(host.textContent).not.toContain('Private exact reported body');
    expect(host.textContent).not.toContain('Private current native body');
    expect(host.querySelector(`a[href*="${revision.revisionId}"]`)).toBeNull();
  });

test('reader cache and transport replacement require a new native read', async () => {
  await paint();
  const count = reads.length;
  const originalClient = client;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  await paint();
  hidden();
  expect(reads).toHaveLength(count);
  await paint({ page: await fresh() });
  expect(host.textContent).toContain('Private exact reported body');
  const source = async () => ({ ok: true as const });
  await paint({ onAction: source });
  hidden();
  expect(sends).toHaveLength(0);
  await paint({ page: await fresh() });
  expect(host.textContent).toContain('Private submitted evidence');
  originalClient.clear();
});

test('individual ownership excludes that report from bulk and a bounded loaded page never discovers more', async () => {
  rows = Array.from({ length: 20 }, (_, index) => report(index));
  await paint({ page: await fresh() });
  const count = reads.length;
  expect(host.querySelectorAll('[role="article"]')).toHaveLength(20);
  await review();
  await click(m.moderation_dismiss());
  await click(m.moderation_bulk_select_loaded());
  expect(host.textContent).toContain(m.moderation_bulk_selected({ count: 19 }));
  expect(inputs).toHaveLength(1);
  expect(sends).toHaveLength(1);
  await click(m.moderation_bulk_review());
  await click(m.moderation_bulk_confirm({ count: 19 }));
  expect(sends).toHaveLength(2);
  expect(inputs[1]!.reportId).not.toBe(inputs[0]!.reportId);
  await act(async () => {
    for (const retire of navigationListeners) retire();
  });
  await settle(0);
  await settle(1);
  expect(sends).toHaveLength(2);
  expect(refreshes).toBe(0);
  expect(reads).toHaveLength(count);
  hidden();
});

test('current takedown retains exact target and reason while its successful refresh replaces evidence', async () => {
  await paint();
  await review();
  const field = host.querySelector<HTMLTextAreaElement>('textarea')!;
  await act(async () => {
    // Use the native setter so React observes a real form edit.
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      'Original decision reason',
    );
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await click(m.threads_next_page());
  await chooseDeparture(m.thread_authoring_stay());
  expect(field.value).toBe('Original decision reason');
  await click(m.moderation_take_down());
  expect(inputs[0]).toMatchObject({
    action: 'take-down',
    targetKind: 'post',
    targetId: post.id,
    reportId: rows[0]!.id,
    reason: 'Original decision reason',
  });
  expect(await sends[0]!.request.clone().json()).toEqual({ reason: 'Original decision reason' });
  await settle(0);
  expect(refreshes).toBe(1);
  expect(host.textContent).toContain(m.moderation_queue_takedown_confirmed());
  expect(host.textContent).not.toContain('Private exact reported body');
  await paint({ page: await fresh() });
  expect(host.textContent).toContain('Private exact reported body');
});

test('a loader-to-mount session replacement and disconnected queued controls never gain authority', async () => {
  const old = props.page;
  client.setQueryData(sessionQuery.queryKey, viewer(id(1), 'replacement-session'));
  client.setQueryData(sessionQuery.queryKey, viewer());
  await paint();
  hidden();
  expect(sends).toHaveLength(0);
  await paint({ page: await fresh() });
  await review();
  const queued = button(m.moderation_dismiss());
  await act(async () => {
    root.unmount();
    mounted = false;
    queued.click();
    await tick();
  });
  expect(sends).toHaveLength(0);
  expect(refreshes).toBe(0);
  root = createRoot(host);
  mounted = true;
  await paint({ page: old });
  hidden();
});

test('a new mount cannot reuse the old native read during the synchronous Strict Mode reconnect window', async () => {
  await paint();
  const live = props.page;
  await act(async () => {
    flushSync(() => {
      root.unmount();
    });
    root = createRoot(host);
    flushSync(() =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={client}>
            <ModerationReportsPage {...props} page={live} />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  });
  hidden();
  expect(sends).toHaveLength(0);
  expect(refreshes).toBe(0);
  await paint({ page: await fresh() });
  expect(host.textContent).toContain('Private exact reported body');
});

test('confirmed report departure retires the original reader before continuation and fences late individual success', async () => {
  let queued!: HTMLButtonElement;
  let replacements = 0;
  let continued = '';
  await paint({
    onNext: (cursor) => {
      queued.click();
      replacements++;
      continued = cursor;
    },
  });
  await review();
  queued = button(m.moderation_dismiss(), 1);
  await click(m.moderation_dismiss());
  const user = userEvent.setup({ document: window.document });
  button(m.threads_next_page()).focus();
  await act(async () => user.keyboard('{Enter}'));
  const dialog = window.document.querySelector<HTMLElement>('[role="alertdialog"]')!;
  expect(dialog.textContent).toContain(m.moderation_review_leave_pending());
  await chooseDeparture(m.thread_authoring_leave());
  expect(replacements).toBe(1);
  expect(continued).toBe('opaque-next');
  expect(sends).toHaveLength(1);
  hidden();
  rows = [];
  next = null;
  const continuationInput = { ...input, cursor: continued };
  await paint({ input: continuationInput, page: await fresh(continuationInput) });
  const boundary = host.querySelector('article');
  expect(boundary?.tabIndex).toBe(-1);
  expect(window.document.activeElement).toBe(boundary);
  await settle(0);
  expect(refreshes).toBe(0);
  hidden();
});
