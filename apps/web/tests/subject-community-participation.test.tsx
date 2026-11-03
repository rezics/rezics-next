import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { ChangeReactionInput, ReactionSnapshot } from '../src/threads/reaction-request';
import type { ThreadWatchCommand, ThreadWatchNative } from '../src/threads/thread-watch-native';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/subjects/one/reviews' });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
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
  fetch: globalThis.fetch,
})) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { SubjectCommunityInteractions } = await import('../src/features/pages/subject-community-interactions');
const { projectCommunityActionAdvice } = await import('../src/features/pages/subject-community-actions');
const { useSubjectCommunityLifetime } = await import('../src/features/pages/subject-community-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
const root = createRoot(host);
const pending = deferred<{ ok: true }>();
const writes: ChangeReactionInput[] = [];
let reads = 0;
let requests = 0;
const preparedTransport = {
  change: ({ data }: { data: ChangeReactionInput }) => {
    writes.push(data);
    return pending.promise;
  },
  async read(): Promise<ReactionSnapshot> {
    reads++;
    return { ok: true, counts: { like: 2 }, value: 'like' };
  },
};
const reader = (subject: string) => ({ state: 'signed-in' as const, subject, csrfToken: `${subject}-csrf` });

function view(
  contextId: string,
  readerId: string,
  value: 'like' | 'insightful',
  transport: typeof preparedTransport = preparedTransport,
) {
  return (
    <QueryClientProvider client={client}>
      <SubjectCommunityInteractions
        thread={{
          id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4',
          title: 'Review',
          authorId: 'author',
          boardId: 'board',
          createdAt: '2026-11-02T00:00:00.000Z',
          summary: 'Excerpt',
          licence: 'MIT',
          reactions: { like: 2, love: 3, insightful: 4 },
          viewerReaction: value,
          actions: { reply: 'available', reaction: 'available', watch: null, overflow: false },
        }}
        subject={{ id: 'subject', label: 'Subject' }}
        locale="en"
        href="/en/threads/thread/review"
        contextId={contextId}
        reader={readerId}
        source="native-source"
        reactionsAsOf={{ epoch: 1, position: '5' }}
        preparedTransport={transport}
      />
    </QueryClientProvider>
  );
}

const threadId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const postRevisionId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';
const exactActions = [
  { action: 'post:create', operationId: 'post.create', state: 'available' },
  { action: 'reaction:set', operationId: 'thread.set_reaction', state: 'available' },
  { action: 'reaction:set', operationId: 'thread.clear_reaction', state: 'available' },
  { action: 'thread:watch', operationId: 'thread.watch', state: 'available' },
  { action: 'thread:watch', operationId: 'thread.unwatch', state: 'not_applicable' },
  { action: 'report:create', operationId: 'report.create', state: 'available' },
];
function nativeAdvice(operations = exactActions, watch: unknown = { state: 'current', watching: false }) {
  return {
    card: {
      state: 'current',
      actions: {
        state: 'current',
        retryable: false,
        references: [
          {
            type: 'content.thread',
            id: threadId,
            sourceRevisionId: postRevisionId,
            state: 'current',
            operations,
          },
        ],
      },
      reply: { state: 'available' },
      watch,
      currentness: {
        source: 'current',
        place: 'current',
        authors: 'current',
        reactions: 'current',
        actions: 'current',
        watch: 'current',
        media: 'current',
        comments: 'current',
      },
    },
  };
}

test('community actions require exact current thread advice and matched operation states', () => {
  const input = nativeAdvice();
  expect(projectCommunityActionAdvice(input, { threadId, postRevisionId })).toEqual({
    reply: 'available',
    reaction: 'available',
    watch: { state: 'current', watching: false },
    overflow: true,
  });
  expect(projectCommunityActionAdvice(input, { threadId: '01a17a3b-0884-721b-91ef-d7ffd7bb58e6', postRevisionId })).toEqual({
    reply: null,
    reaction: null,
    watch: null,
    overflow: false,
  });
  expect(projectCommunityActionAdvice(input, { threadId, postRevisionId: '01a17a3b-0884-721b-91ef-d7ffd7bb58e7' })).toEqual({
    reply: null,
    reaction: null,
    watch: null,
    overflow: false,
  });
  const denied = exactActions.map((item) =>
    item.operationId === 'thread.clear_reaction' ? { ...item, state: 'denied' } : item,
  );
  expect(projectCommunityActionAdvice(nativeAdvice(denied), { threadId, postRevisionId })?.reaction).toBeNull();
  expect(projectCommunityActionAdvice(nativeAdvice(exactActions, { state: 'unavailable', retryable: false }), { threadId, postRevisionId })).toBeUndefined();
});

function watchView(preparedWatch: ThreadWatchNative) {
  return (
    <QueryClientProvider client={client}>
      <SubjectCommunityInteractions
        thread={{
          id: threadId,
          title: 'Review',
          authorId: 'author',
          boardId: 'board',
          createdAt: '2026-11-02T00:00:00.000Z',
          summary: 'Excerpt',
          licence: 'MIT',
          actions: { reply: null, reaction: null, watch: { state: 'current', watching: false }, overflow: false },
        }}
        subject={{ id: 'subject', label: 'Subject' }}
        locale="en"
        href="/en/threads/thread/review"
        contextId="context-one"
        reader="reader-one"
        source="native-source"
        reactionsAsOf={null}
        preparedWatch={preparedWatch}
      />
    </QueryClientProvider>
  );
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function chips() {
  return [...host.querySelectorAll<HTMLButtonElement>('button[data-slot="reaction-chip"]')];
}

beforeEach(() => {
  writes.length = 0;
  reads = 0;
  requests = 0;
  client.setQueryData(['session'], reader('reader-one'));
  globalThis.fetch = (async () => {
    requests++;
    throw new Error('Subject community interactions must not fetch on mount');
  }) as typeof fetch;
});

afterEach(async () => {
  await act(async () => root.render(null));
  client.clear();
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('native watch baseline skips per-card reads and an uncertain write recovers from current status', async () => {
  const reads: string[] = [];
  const commands: ThreadWatchCommand[] = [];
  const native: ThreadWatchNative = {
    async read(request) {
      reads.push(`${request.threadId}/${request.viewerId}`);
      return { kind: 'confirmed', state: { watching: true } };
    },
    async set(command) {
      commands.push(command);
      return { kind: 'unknown' };
    },
  };
  await act(async () => root.render(watchView(native)));
  expect(reads).toHaveLength(0);
  const watch = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === m.thread_watch_watch(),
  );
  expect(watch).toBeDefined();
  await act(async () => watch!.click());
  await act(async () => tick());
  expect(commands.map(({ threadId: id, viewerId, watching }) => ({ id, viewerId, watching }))).toEqual([
    { id: threadId, viewerId: 'reader-one', watching: true },
  ]);
  expect(host.textContent).toContain(m.thread_watch_outcome_unknown());
  const check = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === m.thread_watch_check_again(),
  );
  expect(check).toBeDefined();
  await act(async () => check!.click());
  await act(async () => tick());
  expect(reads).toEqual([`${threadId}/reader-one`]);
  expect(host.textContent).toContain(m.thread_watch_watching());
  expect(host.textContent).not.toContain(m.thread_watch_confirm_started());
  expect(
    [...host.querySelectorAll<HTMLButtonElement>('button')].some((button) => button.textContent === m.thread_watch_stop()),
  ).toBe(false);
});

test('community reaction keeps the exact command through uncertainty and reconciles with one fresh point read', async () => {
  const writes: Array<{ data: ChangeReactionInput; headers: HeadersInit }> = [];
  const reads: ChangeReactionInput[] = [];
  const transport = {
    async change(input: { data: ChangeReactionInput; headers: HeadersInit }) {
      writes.push(input);
      return writes.length === 1 ? { ok: false as const, reason: 'unavailable' as const } : { ok: true as const };
    },
    async read(input: { data: ChangeReactionInput; headers: HeadersInit }): Promise<ReactionSnapshot> {
      reads.push(input.data);
      return {
        ok: true,
        counts: { love: 4 },
        value: 'love',
        reactionsAsOf: { epoch: 1, position: '5' },
      };
    },
  };
  await act(async () => root.render(view('context-one', 'reader-one', 'like', transport)));
  expect(reads).toHaveLength(0);
  const love = chips().find((button) => button.textContent?.startsWith(m.reaction_love()));
  await act(async () => love!.click());
  await act(async () => tick());
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === m.editorial_retry(),
  );
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  await act(async () => tick());
  expect(writes).toHaveLength(2);
  expect(writes.map(({ data }) => data)).toEqual([
    { target: 'thread', id: threadId, kind: 'love', expectedReader: 'reader-one' },
    { target: 'thread', id: threadId, kind: 'love', expectedReader: 'reader-one' },
  ]);
  const key = (headers: HeadersInit) => new Headers(headers).get('Idempotency-Key');
  expect(key(writes[0]!.headers)).toBeTruthy();
  expect(key(writes[1]!.headers)).toBe(key(writes[0]!.headers));
  expect(reads).toEqual([{ target: 'thread', id: threadId, kind: 'love', expectedReader: 'reader-one' }]);
  expect(
    chips()
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent),
  ).toEqual([`${m.reaction_love()}4`]);
});

test('mounted community reactions make no initial reads and discard writes after reader and Context replacement', async () => {
  await act(async () => root.render(view('context-one', 'reader-one', 'like')));
  expect(requests).toBe(0);
  expect(reads).toBe(0);
  const love = chips().find((button) => button.textContent?.startsWith(m.reaction_love()));
  expect(love).toBeDefined();
  await act(async () => love!.click());
  expect(writes).toEqual([
    { target: 'thread', id: '01a17a3b-0884-721b-91ef-d7ffd7bb58e4', kind: 'love', expectedReader: 'reader-one' },
  ]);

  await act(async () => {
    client.setQueryData(['session'], reader('reader-two'));
    root.render(view('context-two', 'reader-two', 'insightful'));
  });
  await act(async () => {
    pending.resolve({ ok: true });
    await tick();
  });
  expect(reads).toBe(0);
  expect(requests).toBe(0);
  expect(
    chips()
      .filter((button) => button.getAttribute('aria-pressed') === 'true')
      .map((button) => button.textContent),
  ).toEqual([`${m.reaction_insightful()}4`]);
});

test('community visits retire on replacement and unmount without reviving a previous matching URL', async () => {
  type Input = Parameters<typeof useSubjectCommunityLifetime>[0];
  let current!: ReturnType<typeof useSubjectCommunityLifetime>;
  function Probe({ input }: { input: Input }) {
    current = useSubjectCommunityLifetime(input);
    return null;
  }
  const input: Input = {
    subjectId: 'subject',
    contextId: 'context',
    reader: 'reader',
    route: '/reviews?cursor=one',
    source: 'observation',
    targetId: 'thread',
    ready: true,
    locale: 'en',
    credentialEpoch: 'csrf-one',
    exposure: 'public',
  };
  const show = async (value: Input) => act(async () => root.render(<Probe input={value} />));
  for (const replacement of [
    { subjectId: 'other' },
    { contextId: 'realm' },
    { reader: 'another' },
    { route: '/discussion?cursor=two' },
    { source: 'new observation' },
    { targetId: 'other-thread' },
    { ready: false },
    { locale: 'fr' },
    { credentialEpoch: 'csrf-two' },
    { exposure: 'private' },
  ]) {
    await show(input);
    const retired = current;
    expect(retired.isCurrent()).toBe(true);
    await show({ ...input, ...replacement });
    expect(retired.isCurrent()).toBe(false);
    await show(input);
    expect(current.isCurrent()).toBe(true);
    expect(retired.isCurrent()).toBe(false);
  }
  const unmounted = current;
  await act(async () => root.render(null));
  expect(unmounted.isCurrent()).toBe(false);
  await show(input);
  expect(current.isCurrent()).toBe(true);
  expect(unmounted.isCurrent()).toBe(false);
});
