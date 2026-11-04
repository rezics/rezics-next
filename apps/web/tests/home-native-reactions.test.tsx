import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
const { readHomeFeedPage } = await import('../src/features/pages/home-feed-read');
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { ThreadReactions } = await import('../src/threads/thread-reactions');
const { HomeReactionRecovery, useHomeReactionRecovery } =
  await import('../src/features/feed/home-reaction-currentness-recovery');
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
            summary: {
              id,
              title: 'Collection',
              description: null,
              curator: { state: 'unavailable', reason: 'native_projection' },
              presentationKind: null,
              presentationKindSource: 'empty',
              cover: null,
              coverSource: 'none',
            },
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

test('signed-in Home keeps Content reaction facts visible but disables writes without native action advice', async () => {
  const item: FeedItem = {
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
      viewerReaction: null,
    },
    destination: { kind: 'thread', id, title: 'Card' },
  };
  await paint(
    <HomeFeed
      result={{
        state: 'ready',
        page: { ...result.page, feedItems: [item], reactionsAsOf: { epoch: 1, position: '2' } },
      }}
      locale="en"
      signedIn
    />,
  );
  expect(host.querySelector('[data-slot="feed-reaction-admission"]')?.textContent).toContain(m.reaction_unavailable());
  const controls = host.querySelector('[data-slot="reactions"]');
  expect(controls).not.toBeNull();
  expect(controls?.querySelectorAll('button:not([disabled])')).toHaveLength(0);
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
  expect(host.textContent).toBe('retired');
  expect(initialOrigin.isCurrent()).toBe(false);
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

test('native allowed kinds do not change counts or selected facts, and [] disables every kind', async () => {
  let sends = 0;
  const render = (
    allowedKinds: readonly ('upvote' | 'love')[],
    counts: { upvote: number; love?: number } = { upvote: 8, love: 3 },
  ) => (
    <ThreadReactions
      target={{ kind: 'thread', id }}
      counts={counts}
      value="love"
      signedIn
      returnTo="/en/"
      presentation="vote"
      allowedKinds={allowedKinds}
      preparedTransport={{
        change: async () => {
          sends++;
          return { ok: true };
        },
        read: async () => ({ ok: true, counts: {}, value: null }),
      }}
    />
  );
  await paint(render(['upvote']));
  const love = host.querySelector<HTMLButtonElement>('[data-slot="reaction-chip"][aria-pressed="true"]')!;
  expect(love.textContent).toContain('3');
  expect(love.disabled).toBe(true);
  const arrows = host.querySelectorAll<HTMLButtonElement>('[data-slot="vote-control"] button');
  expect(arrows[0]!.disabled).toBe(false);
  expect(arrows[1]!.disabled).toBe(true);
  await click(love);
  expect(sends).toBe(0);
  await paint(render(['upvote'], { upvote: 8 }));
  const selectedZero = host.querySelector<HTMLButtonElement>('[data-slot="reaction-chip"][aria-pressed="true"]');
  expect(selectedZero?.textContent).toContain('0');
  expect(selectedZero?.disabled).toBe(true);
  await paint(render([]));
  expect(host.querySelector('[data-slot="vote-control"] output')?.textContent).toBe('8');
  expect(host.querySelectorAll('[data-slot="reactions"] button:not([disabled])')).toHaveLength(1); // read-only picker
  expect(sends).toBe(0);
});

test('uncertain retry keeps the original sender, credential, target, body and key; discard refreshes once', async () => {
  type Transport = NonNullable<Parameters<typeof ThreadReactions>[0]['preparedTransport']>;
  const sent: Parameters<Transport['change']>[0][] = [];
  let replacedSenderCalls = 0;
  let refreshed = 0;
  const first: Transport = {
    change: async (request) => {
      sent.push(request);
      return { ok: false, reason: 'unavailable' };
    },
    read: async () => ({ ok: false, reason: 'unavailable' }),
  };
  const render = (transport: Transport) => (
    <ThreadReactions
      target={{ kind: 'thread', id }}
      counts={{ upvote: 8 }}
      value={null}
      signedIn
      returnTo="/en/?original=one"
      presentation="vote"
      allowDiscard
      onMutation={async () => {
        refreshed++;
      }}
      preparedTransport={transport}
    />
  );
  await paint(render(first));
  await click(host.querySelector<HTMLButtonElement>('[data-slot="vote-control"] button')!);
  await paint(
    render({
      ...first,
      change: async () => {
        replacedSenderCalls++;
        return { ok: true };
      },
    }),
  );
  await click([...host.querySelectorAll('button')].find((button) => button.textContent === m.editorial_retry())!);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(new Headers(sent[1]!.headers).get('X-CSRF-Token')).toBe('csrf');
  expect(sent[1]!.data).toEqual({ target: 'thread', id, kind: 'upvote', expectedReader: 'reader' });
  expect(replacedSenderCalls).toBe(0);
  await click([...host.querySelectorAll('button')].find((button) => button.textContent === m.reaction_discard())!);
  expect(refreshed).toBe(1);
  expect(host.querySelectorAll('[data-slot="vote-control"] button:not([disabled])')).toHaveLength(0);
  expect(host.textContent).not.toContain(m.reaction_discard());
});

test('public Home rejects private viewer slots and current private advice', async () => {
  const item = { ...row(0), source: 'discovery' as const };
  for (const personal of [{ viewerReaction: 'love' }, { reactionAdvice: { state: 'current', allowed: [] } }]) {
    const publicPage = {
      ...result.page,
      sources: { following: 'not_requested', discovery: 'ready', continue: 'not_requested' },
      feedItems: [{ ...item, summary: { ...item.summary, ...personal } }],
    };
    const client = { feedItems: { get: async () => ({ status: 200, data: publicPage }) } };
    expect(await readHomeFeedPage(client as Parameters<typeof readHomeFeedPage>[0])).toEqual({
      state: 'unavailable',
      code: 'invalid_feed_response',
    });
  }
});

test('Home keeps an original uncertain command across retired advice, A/B/A and remount until retry or discard', async () => {
  type Transport = NonNullable<Parameters<typeof ThreadReactions>[0]['preparedTransport']>;
  const sent: Parameters<Transport['change']>[0][] = [];
  let acknowledge!: (value: { ok: false; reason: 'unavailable' }) => void;
  const lost = new Promise<{ ok: false; reason: 'unavailable' }>((resolve) => {
    acknowledge = resolve;
  });
  let uncertain = true;
  let replacementSends = 0;
  let refreshes = 0;
  const original: Transport = {
    change: async (request) => {
      sent.push(request);
      return sent.length === 1 ? lost : uncertain ? { ok: false, reason: 'unavailable' } : { ok: true };
    },
    read: async () => {
      throw new Error('Home refreshes through its page owner');
    },
  };
  const replacement: Transport = {
    ...original,
    change: async () => {
      replacementSends++;
      return { ok: true };
    },
  };
  const originalPage = { ...result, page: { ...result.page } };
  const anotherPage = { ...result, page: { ...result.page } };
  const refresh = () => {
    refreshes++;
  };
  function Journey({ page, transport = original }: { page: typeof result; transport?: Transport }) {
    const scope = useHomeReactionRecovery(refresh);
    const source = useHomeReactionCurrentness(
      page,
      { stream: 'following', cursor: 'original' },
      'following',
      true,
      false,
    );
    return (
      <>
        <HomeReactionRecovery scope={scope} locale="en" onRefresh={refresh} />
        <ThreadReactions
          target={{ kind: 'thread', id }}
          counts={{ upvote: 8 }}
          value={null}
          signedIn
          returnTo="/en/threads/original?locate=exact"
          presentation="vote"
          optimistic={false}
          settleWithRead={false}
          personalReady={!scope.recovery.pending('original-occurrence')}
          reactionOrigin={source.origin}
          commandRecovery={{
            ...scope.recovery.port('original-occurrence', '/en/threads/original?locate=exact'),
            start(command) {
              scope.recovery.port('original-occurrence', '/en/threads/original?locate=exact').start(command);
              source.retire();
            },
          }}
          preparedTransport={transport}
        />
      </>
    );
  }
  await paint(<Journey page={originalPage} />);
  await click(host.querySelector<HTMLButtonElement>('[data-slot="vote-control"] button')!);
  expect(sent).toHaveLength(1);
  expect(host.querySelector('[data-slot="home-reaction-recovery"] [aria-busy="true"]')).not.toBeNull();
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  });
  await paint(<Journey page={anotherPage} transport={replacement} />);
  await paint(<Journey page={originalPage} transport={replacement} />);
  acknowledge({ ok: false, reason: 'unavailable' });
  await act(async () => {
    await lost;
  });
  const recovery = () => host.querySelector('[data-slot="home-reaction-recovery"]')!;
  expect(recovery().querySelector('a')?.getAttribute('href')).toBe('/en/threads/original?locate=exact');
  uncertain = false;
  await click([...recovery().querySelectorAll('button')].find((button) => button.textContent === m.editorial_retry())!);
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(replacementSends).toBe(0);
  expect(refreshes).toBe(1);
  expect(host.querySelector('[data-slot="home-reaction-recovery"]')).toBeNull();
  expect(host.querySelectorAll('[data-slot="vote-control"] button:not([disabled])')).toHaveLength(0);

  uncertain = true;
  const fresh = { ...result, page: { ...result.page } };
  await paint(<Journey page={fresh} />);
  await click(host.querySelector<HTMLButtonElement>('[data-slot="vote-control"] button')!);
  expect(sent).toHaveLength(3);
  await paint(<span>another route</span>);
  await paint(<Journey page={fresh} transport={replacement} />);
  expect(recovery()).not.toBeNull();
  await click(
    [...recovery().querySelectorAll('button')].find((button) => button.textContent === m.reaction_discard())!,
  );
  expect(refreshes).toBe(2);
  expect(sent).toHaveLength(3);
  expect(host.querySelector('[data-slot="home-reaction-recovery"]')).toBeNull();
  expect(host.querySelectorAll('[data-slot="vote-control"] button:not([disabled])')).toHaveLength(0);
});
