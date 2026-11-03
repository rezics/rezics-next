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

test('a Home baseline cannot be rebound after a viewer or request observation changes', async () => {
  function Probe({
    current = result,
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
    return <output>{scope.available ? 'current' : 'retired'}</output>;
  }
  await paint(<Probe />);
  expect(host.textContent).toBe('current');
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  });
  expect(host.textContent).toBe('retired');
  const replacement = { ...result };
  await paint(<Probe current={replacement} />);
  expect(host.textContent).toBe('current');
  await paint(<Probe current={replacement} spaceId="another-space" />);
  expect(host.textContent).toBe('retired');
  await paint(<Probe current={replacement} />);
  expect(host.textContent).toBe('retired');
  await paint(<Probe current={{ ...result }} busy />);
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

test('Home consumes exact native reaction operands and retires them on viewer, target and source replacement', async () => {
  const item = row(1);
  if (!('kind' in item.summary)) throw new Error('Expected thread summary');
  item.summary = {
    ...item.summary,
    reactionTarget: { targetKind: 'thread', targetId: id },
    reactions: { upvote: 8, downvote: 3, like: 2 },
    viewerReaction: 'upvote',
  };
  const current = {
    state: 'ready' as const,
    page: { ...result.page, feedItems: [item], reactionsAsOf: { epoch: 1, position: '7' } },
  };
  await paint(<HomeFeed result={current} locale="en" signedIn />);
  expect(host.querySelector('[data-slot="vote-control"]')).not.toBeNull();
  expect(host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  expect(host.querySelector('[aria-pressed="true"]')?.getAttribute('aria-label')).toContain('8');
  expect(host.querySelector('[data-slot="vote-control"]')?.textContent).toContain('5');
  await act(async () =>
    client.setQueryData(['session'], { state: 'signed-in', subject: 'replacement', csrfToken: 'new-csrf' }),
  );
  expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
  await paint(<HomeFeed result={{ ...current }} locale="en" signedIn />);
  expect(host.querySelector('[data-slot="vote-control"]')).not.toBeNull();
  await paint(
    <HomeFeed result={current} input={{ stream: 'following', spaceId: 'replacement' }} locale="en" signedIn busy />,
  );
  expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
  const mismatch = structuredClone(current);
  if (!('reactionTarget' in mismatch.page.feedItems[0]!.summary)) throw new Error('Expected native target');
  mismatch.page.feedItems[0]!.summary.reactionTarget = { targetKind: 'thread', targetId: 'another-thread' };
  await paint(<HomeFeed result={mismatch} locale="en" signedIn />);
  expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('Home reads the current work, recorded zero and immediate parent without hydration; spoiler reveal retires', async () => {
  const { homeReviewContextPage } = await import('../src/kernel/fake/home-review-context');
  const page = homeReviewContextPage();
  const current = { state: 'ready' as const, page };
  await paint(<HomeFeed result={current} locale="en" signedIn />);
  const rows = host.querySelectorAll('[data-feed-id]');
  expect(rows[0]!.querySelector('[data-feed-card-reviewed-subject] bdi')?.getAttribute('lang')).toBe('ja');
  expect(rows[0]!.textContent).toContain('現在の作品名');
  const citation = rows[0]!.querySelector('[data-feed-card-citation]')!;
  expect(citation.textContent).toContain('0 units');
  expect(citation.textContent).toContain('Revision 11');
  expect(citation.textContent).toContain('vote revision 7');
  expect(citation.textContent).toContain('-4–8 · 2');
  const parent = rows[1]!.querySelector('[data-feed-card-parent]')!;
  const links = [...parent.querySelectorAll('a')].map((link) => link.getAttribute('href'));
  expect(links[0]).toBe(
    '/en/threads/00000000-0000-7000-8000-000000000001/review-of-a-permitted-work?post=00000000-0000-7000-8000-000000000003#post-00000000-0000-7000-8000-000000000003',
  );
  expect(links).toContain(
    '/en/posts/00000000-0000-7000-8000-000000000003/revisions/00000000-0000-7000-8000-000000000006',
  );
  expect(parent.querySelector('[data-feed-card-parent-author]')?.textContent).toBe('Hana');
  expect(parent.querySelector('[data-feed-card-parent-preview]')?.getAttribute('lang')).toBe('ja');
  const reveal = parent.querySelector('details')!;
  expect(reveal.open).toBe(false);
  reveal.open = true;
  await act(async () =>
    client.setQueryData(['session'], { state: 'signed-in', subject: 'replacement', csrfToken: 'new-csrf' }),
  );
  expect(host.querySelector<HTMLDetailsElement>('[data-feed-card-parent] details')!.open).toBe(false);
  for (const state of ['withheld', 'removed'] as const) {
    await paint(<HomeFeed result={{ state: 'ready', page: homeReviewContextPage(state) }} locale="en" signedIn />);
    const concealed = host.querySelector('[data-feed-card-parent]')!;
    expect(concealed.getAttribute('data-feed-card-parent')).toBe(state);
    expect(concealed.querySelectorAll('a')).toHaveLength(state === 'removed' ? 1 : 0);
    expect(host.textContent).not.toContain('許された親の本文。');
    expect(host.textContent).not.toContain('Hana');
  }
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('concealed native review context never falls back to a stale discovery target or private citation', async () => {
  const item: FeedItem = {
    id: 'discovery-review',
    source: 'discovery',
    occurredAt: null,
    key: { owner: 'content', kind: 'thread', route: 0, id },
    summary: {
      id,
      kind: 'review',
      title: 'Readable review',
      subject: { id: 'stale-subject', title: 'SECRET stale label' },
      reviewContext: { target: { state: 'withheld' }, citation: { state: 'withheld' } },
    },
    destination: { kind: 'thread', id, title: 'Readable review' },
  };
  await paint(
    <HomeFeed
      result={{
        state: 'ready',
        page: {
          ...result.page,
          feedItems: [item],
          sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
        },
      }}
      locale="en"
    />,
  );
  expect(host.querySelector('[data-feed-card-reviewed-subject] a')).toBeNull();
  expect(host.querySelector('[data-feed-card-citation]')?.textContent).toBe(m.subject_community_citation_unavailable());
  expect(host.textContent).not.toContain('SECRET');
  expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
  expect(nativeFetch).not.toHaveBeenCalled();
});
