import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { reactionKinds } from '@rezics/ui/reactions';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/' });
const globals = {
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
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { ThreadReactions } = await import('../src/threads/thread-reactions');
const { useHomeReactionCurrentness } = await import('../src/features/feed/home-reaction-currentness');
const { m } = await import('../src/paraglide/messages.js');
const nativeFetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected native request'));
const id = '00000000-0000-7000-8000-000000000001';
const result = {
  state: 'ready' as const,
  page: {
    feedItems: [],
    next: null,
    asOf: '2026-11-04T00:00:00Z',
    sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' },
  } satisfies FeedPage,
};
function row(index: number): FeedItem {
  return {
    id: `occurrence:${index}`,
    source: 'following',
    occurredAt: null,
    key: { owner: 'content', kind: 'thread', route: 0, id },
    summary: {
      id,
      kind: index % 2 ? 'review' : 'discussion',
      title: `Card ${index}`,
      createdAt: '2026-11-04T00:00:00Z',
    },
    destination: { kind: 'thread', id, title: `Card ${index}` },
  };
}
const host = window.document.createElement('div');
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
async function paint(element: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
  });
}
async function click(button: HTMLElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  nativeFetch.mockClear();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  nativeFetch.mockRestore();
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test.each([1, 10, 20])(
  '%i duplicate Content targets and unsupported rows stay unavailable without mount reads',
  async (count) => {
    const feedItems = Array.from({ length: count }, (_, index): FeedItem =>
      index % 3 !== 2
        ? row(index)
        : {
            id: `collection:${index}`,
            source: 'following',
            occurredAt: null,
            key: { owner: 'library', kind: 'collection', route: 0, id },
            summary: { id, title: 'Collection', description: null },
            destination: { kind: 'collection', id, title: 'Collection' },
          },
    );
    for (const signedIn of [false, true]) {
      await paint(
        <HomeFeed result={{ state: 'ready', page: { ...result.page, feedItems } }} locale="en" signedIn={signedIn} />,
      );
      expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(count);
      expect(host.querySelectorAll('[data-slot="vote-unavailable"]')).toHaveLength(count - Math.floor(count / 3));
      expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
    }
    expect(nativeFetch).not.toHaveBeenCalled();
  },
);

test.each([
  ['missing', undefined, m.reaction_unavailable(), false, true],
  ['allowed', reactionKinds, undefined, true, true],
  ['empty current', [] as const, m.reaction_forbidden(), false, true],
  ['unknown viewer', reactionKinds, m.reaction_unavailable(), false, false],
] as const)('signed-in Home preserves reaction facts with %s native action advice', async (_name, allowed, status, enabled, viewerKnown) => {
  const target = { targetKind: 'thread' as const, targetId: id };
  const item = {
    id: 'occurrence:action-advice',
    source: 'following',
    occurredAt: null,
    key: { owner: 'content', kind: 'thread', route: 0, id },
    summary: {
      id,
      kind: 'discussion',
      title: 'Card',
      createdAt: '2026-11-04T00:00:00Z',
      reactionTarget: { targetKind: 'thread', targetId: id },
      reactions: { upvote: 2, like: 1 },
      ...(viewerKnown ? { viewerReaction: null } : {}),
      ...(allowed === undefined ? {} : { reactionAdvice: { target, state: 'current' as const, allowed } }),
    },
    destination: { kind: 'thread', id, title: 'Card' },
  } satisfies FeedItem;
  await paint(
    <HomeFeed
      result={{
        state: 'ready',
        page: { ...result.page, feedItems: [item], reactionsAsOf: { epoch: 1, position: '2' } },
      }}
      locale="en"
      stream="following"
      input={{ stream: 'following' }}
      signedIn
    />,
  );
  const admission = host.querySelector('[data-slot="feed-reaction-admission"]');
  if (status) expect(admission?.textContent).toContain(status);
  else expect(admission).toBeNull();
  const controls = host.querySelector('[data-slot="reactions"]');
  expect(controls).not.toBeNull();
  expect(controls?.textContent).toContain('2');
  expect(controls?.querySelectorAll('button:not([disabled])').length > 0).toBe(enabled);
  const postTarget = { targetKind: 'post' as const, targetId: id };
  const post: FeedItem = {
    ...item,
    id: 'occurrence:post-action-advice',
    key: { owner: 'content', kind: 'post', route: 0, id },
    summary: {
      id,
      threadId: id,
      title: 'Card',
      createdAt: '2026-11-04T00:00:00Z',
      reactionTarget: postTarget,
      reactions: { upvote: 2, like: 1 },
      ...(viewerKnown ? { viewerReaction: null } : {}),
      ...(allowed === undefined ? {} : { reactionAdvice: { target: postTarget, state: 'current' as const, allowed } }),
    },
    destination: { kind: 'post', id, postId: id, threadId: id, title: 'Card' },
  };
  await paint(
    <HomeFeed
      result={{ state: 'ready', page: { ...result.page, feedItems: [post], reactionsAsOf: { epoch: 1, position: '2' } } }}
      locale="en"
      stream="following"
      input={{ stream: 'following' }}
      signedIn
    />,
  );
  expect(host.querySelector('[data-slot="reactions"]')?.querySelectorAll('button:not([disabled])').length > 0).toBe(
    enabled,
  );
  const postAdmission = host.querySelector('[data-slot="feed-reaction-admission"]');
  if (status) expect(postAdmission?.textContent).toContain(status);
  else expect(postAdmission).toBeNull();
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('a Home baseline retires across session, request, provider and route incarnations', async () => {
  const baseline = { ...result, page: { ...result.page } };
  let latestOrigin: ReturnType<typeof useHomeReactionCurrentness>['origin'] | undefined;
  function Probe({
    current = baseline,
    spaceId,
    busy = false,
  }: {
    current?: typeof result;
    spaceId?: string;
    busy?: boolean;
  }) {
    const scope = useHomeReactionCurrentness(
      current,
      { stream: 'following', ...(spaceId ? { spaceId } : {}) },
      'following',
      true,
      busy,
    );
    latestOrigin = scope.origin;
    return <output>{scope.available ? 'current' : 'retired'}</output>;
  }
  await paint(<Probe />);
  expect(host.textContent).toBe('current');

  const initialOrigin = latestOrigin!;
  let startFetch!: () => void;
  let finishFetch!: (value: { state: 'signed-in'; subject: string; csrfToken: string }) => void;
  const fetchStarted = new Promise<void>((resolve) => (startFetch = resolve));
  const response = new Promise<{ state: 'signed-in'; subject: string; csrfToken: string }>(
    (resolve) => (finishFetch = resolve),
  );
  let request!: Promise<unknown>;
  await act(async () => {
    request = client.fetchQuery({
      queryKey: ['session'],
      staleTime: 0,
      queryFn: async () => {
        startFetch();
        return response;
      },
    });
    await fetchStarted;
  });
  expect(host.textContent).toBe('current');
  expect(initialOrigin.isCurrent()).toBe(true);
  finishFetch({ state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  await act(async () => {
    await request;
  });
  expect(host.textContent).toBe('retired');
  expect(initialOrigin.isCurrent()).toBe(false);

  await paint(<Probe current={{ ...baseline }} />);
  expect(host.textContent).toBe('retired');

  const fresh = { ...baseline, page: { ...baseline.page } };
  await paint(<Probe current={fresh} />);
  expect(host.textContent).toBe('current');
  const requestOrigin = latestOrigin!;
  await paint(<Probe current={fresh} spaceId="another-space" />);
  expect(host.textContent).toBe('retired');
  expect(requestOrigin.isCurrent()).toBe(false);
  await paint(<Probe current={fresh} />);
  expect(host.textContent).toBe('retired');

  const credentialPage = { ...baseline, page: { ...baseline.page } };
  await paint(<Probe current={credentialPage} />);
  expect(host.textContent).toBe('current');
  const credentialOrigin = latestOrigin!;
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'rotated' });
  });
  expect(host.textContent).toBe('retired');
  expect(credentialOrigin.isCurrent()).toBe(false);

  const batchedPage = { ...baseline, page: { ...baseline.page } };
  await paint(<Probe current={batchedPage} />);
  expect(host.textContent).toBe('current');
  const batchedOrigin = latestOrigin!;
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-b', csrfToken: 'csrf-b' });
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-c', csrfToken: 'csrf-c' });
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'rotated' });
  });
  expect(host.textContent).toBe('retired');
  expect(batchedOrigin.isCurrent()).toBe(false);

  const routePage = { ...baseline, page: { ...baseline.page } };
  await paint(<Probe current={routePage} />);
  expect(host.textContent).toBe('current');
  const routeOrigin = latestOrigin!;
  await act(async () => root.unmount());
  expect(routeOrigin.isCurrent()).toBe(false);
  root = createRoot(host);
  await paint(<Probe current={routePage} />);
  expect(host.textContent).toBe('retired');

  await paint(<Probe current={{ ...baseline, page: { ...baseline.page } }} busy />);
  expect(host.textContent).toBe('retired');
  expect(nativeFetch).not.toHaveBeenCalled();
});

test.each([null, { epoch: 1, position: '6' }])(
  'a supplied source watermark keeps %j readback in explicit recovery',
  async (initial) => {
    let watermark = initial;
    let writes = 0;
    let reads = 0;
    await paint(
      <ThreadReactions
        target={{ kind: 'thread', id }}
        counts={{ upvote: 8 }}
        value={null}
        signedIn
        returnTo="/en/threads/one/reading"
        presentation="vote"
        sourceWatermark={{ epoch: 1, position: '7' }}
        settleWithRead
        preparedTransport={{
          change: async () => {
            writes++;
            return { ok: true };
          },
          read: async () => {
            reads++;
            return { ok: true, counts: { upvote: 9 }, value: 'upvote', reactionsAsOf: watermark };
          },
        }}
      />,
    );
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    await click(host.querySelector<HTMLButtonElement>('[data-slot="vote-control"] button')!);
    expect(writes).toBe(1);
    expect(reads).toBe(1);
    watermark = { epoch: 1, position: '8' };
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === m.editorial_retry())!);
    expect(writes).toBe(1);
    expect(reads).toBe(2);
    expect(host.querySelectorAll('[data-slot="vote-control"] [aria-pressed="true"]')).toHaveLength(1);
  },
);
