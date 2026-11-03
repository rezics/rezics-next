import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { ChangeReactionInput, ReactionSnapshot } from '../src/threads/reaction-request';

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

function view(contextId: string, readerId: string, value: 'like' | 'insightful') {
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
        }}
        subject={{ id: 'subject', label: 'Subject' }}
        locale="en"
        href="/en/threads/thread/review"
        contextId={contextId}
        reader={readerId}
        source="native-source"
        preparedTransport={preparedTransport}
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
