import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { ChangeReactionInput, ReactionFailure, ReactionSnapshot } from '../src/threads/reaction-request';

// Gate only the existing transports. The card, queue, session observer and readback owner remain installed.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const browser = new Window({ url: 'https://site.test/en/' });
const globals = {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  HTMLElement: browser.HTMLElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  HTMLInputElement: browser.HTMLInputElement,
  Element: browser.Element,
  Node: browser.Node,
  Document: browser.Document,
  ShadowRoot: browser.ShadowRoot,
  DocumentFragment: browser.DocumentFragment,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
type Write = ReturnType<typeof deferred<{ ok: true } | ReactionFailure>> & {
  data: ChangeReactionInput;
  headers: Headers;
};
const writes: Write[] = [];
const reads: ReturnType<typeof deferred<ReactionSnapshot | ReactionFailure>>[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reactions', () => ({
  changeReaction: ({ data, headers }: { data: ChangeReactionInput; headers: HeadersInit }) => {
    const write = { ...deferred<{ ok: true } | ReactionFailure>(), data, headers: new Headers(headers) };
    writes.push(write);
    return write.promise;
  },
  readReaction: () => {
    const read = deferred<ReactionSnapshot | ReactionFailure>();
    reads.push(read);
    return read.promise;
  },
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { FeedActionBar } = await import('../src/features/feed/action-bar');
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
type Props = import('../src/features/feed/action-bar').FeedActionBarProps;
type FeedItem = import('../src/features/pages/home-feed-read').FeedItem;
const host = browser.document.createElement('div');
browser.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
const viewer = (token = 'csrf-one') => ({ state: 'signed-in', subject: 'reader-one', csrfToken: token });
const props = (): Props => ({
  locale: 'en',
  title: 'A discussion',
  href: '/en/threads/thread/reading',
  signedIn: true,
  reaction: { target: { kind: 'thread', id: 'thread' }, counts: { upvote: 8, downvote: 2 }, value: null },
  reply: { href: '/en/threads/thread/reading#reply' },
  library: { href: '/en/subjects/work/book?slot=collections' },
});
async function paint(node: ReactNode) {
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
}
async function click(node: Element | null) {
  expect(node).not.toBeNull();
  await act(async () => {
    (node as HTMLElement).click();
  });
}
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (node) => node.getAttribute('aria-label') === label || node.textContent === label,
  ) ?? null;
const score = () => host.querySelector('[data-slot="vote-control"] output')?.textContent;
const settle = async (index = 0) => {
  await act(async () => {
    writes[index]!.resolve({ ok: true });
  });
  await act(async () => {
    reads.at(-1)!.resolve({ ok: true, counts: { upvote: 12, downvote: 3 }, value: writes[index]!.data.kind });
  });
};
beforeEach(() => {
  writes.length = 0;
  reads.length = 0;
  setLocale('en', { reload: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], viewer());
  root = createRoot(host as unknown as HTMLElement);
  Object.defineProperty(browser.navigator, 'share', { configurable: true, value: undefined });
  Object.defineProperty(browser.navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  mock.restore();
  await browser.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('one-slot votes update immediately, settle from actual counts, and revert a refused replacement', async () => {
  await paint(<FeedActionBar {...props()} />);
  expect(score()).toBe('6');
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
  await click(button(m.reaction_upvote()));
  expect(score()).toBe('7');
  expect(writes).toHaveLength(1);
  expect(reads).toHaveLength(0);
  expect(writes[0]!.data.expectedReader).toBe('reader-one');
  expect(writes[0]!.headers.get('idempotency-key')).toMatch(/^[a-f0-9-]{36}$/);
  await settle();
  expect(score()).toBe('9');
  await click(button(m.reaction_downvote()));
  expect(score()).toBe('7');
  await act(async () => {
    writes[1]!.resolve({ ok: false, reason: 'forbidden' });
  });
  expect(score()).toBe('9');
  expect(host.textContent).toContain(m.reaction_forbidden());
  expect(reads).toHaveLength(1);
});

test('unknown writes retain the exact current-visit key and reconcile once on explicit retry', async () => {
  await paint(<FeedActionBar {...props()} />);
  await click(button(m.reaction_downvote()));
  await act(async () => {
    writes[0]!.resolve({ ok: false, reason: 'unavailable' });
  });
  expect(score()).toBe('6');
  expect(reads).toHaveLength(0);
  await click(button(m.editorial_retry()));
  expect(writes[1]!.headers.get('idempotency-key')).toBe(writes[0]!.headers.get('idempotency-key'));
  await settle(1);
  expect(score()).toBe('9');
  expect(reads).toHaveLength(1);
});

test.each([1, 10, 20])(
  '%i admitted rows mount without reads; one click owns one write and one readback',
  async (count) => {
    await paint(
      <>
        {Array.from({ length: count }, (_, i) => (
          <FeedActionBar
            key={i}
            {...props()}
            reaction={{ ...props().reaction!, target: { kind: 'post', id: `post-${i}` } }}
          />
        ))}
      </>,
    );
    expect(writes).toHaveLength(0);
    expect(reads).toHaveLength(0);
    await click(button(m.reaction_upvote()));
    await settle();
    expect(writes).toHaveLength(1);
    expect(reads).toHaveLength(1);
  },
);

test('away/back and source retirement suppress late receipts and discard old optimistic state', async () => {
  let sourceCurrent = true;
  const source = { key: 'page-one', isCurrent: () => sourceCurrent };
  const initial = props();
  await paint(<FeedActionBar {...initial} origin={source} />);
  await click(button(m.reaction_upvote()));
  expect(score()).toBe('7');
  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
    client.setQueryData(['session'], viewer());
  });
  expect(score()).toBe('6');
  await act(async () => {
    writes[0]!.resolve({ ok: true });
  });
  expect(reads).toHaveLength(0);
  expect(score()).toBe('6');
  await click(button(m.reaction_downvote()));
  sourceCurrent = false;
  await paint(<FeedActionBar {...initial} origin={{ key: 'page-two', isCurrent: () => true }} />);
  await act(async () => {
    writes[1]!.resolve({ ok: true });
  });
  expect(reads).toHaveLength(0);
  expect(score()).toBe('6');
});

test('signed-out votes, reply, Library and overflow participation lead to localized sign-in', async () => {
  await paint(<FeedActionBar {...props()} signedIn={false} locale="de" />);
  const signIn = '/de/auth/sign-in?return_to=%2Fen%2Fthreads%2Fthread%2Freading';
  expect(host.querySelector('a[aria-label]')?.getAttribute('href')).toBe(signIn);
  expect(
    [...host.querySelectorAll('a')].filter((a) => a.getAttribute('href') === signIn).length,
  ).toBeGreaterThanOrEqual(4);
  expect(button(m.report_action())).toBeNull();
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test('native share does not copy on success or cancellation; clipboard failure offers the admitted URL', async () => {
  const native: ShareData[] = [];
  const copies: string[] = [];
  Object.defineProperty(browser.navigator, 'share', {
    configurable: true,
    value: async (data: ShareData) => {
      native.push(data);
    },
  });
  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (url: string) => {
        copies.push(url);
        throw new Error('denied');
      },
    },
  });
  await paint(<FeedActionBar {...props()} />);
  await click(button(m.thread_reading_share()));
  expect(native[0]?.url).toBe('https://site.test/en/threads/thread/reading');
  expect(copies).toHaveLength(0);
  Object.defineProperty(browser.navigator, 'share', {
    configurable: true,
    value: async () => {
      throw new DOMException('cancelled', 'AbortError');
    },
  });
  await click(button(m.thread_reading_share()));
  expect(copies).toHaveLength(0);
  Object.defineProperty(browser.navigator, 'share', { configurable: true, value: undefined });
  await click(button(m.thread_reading_share()));
  expect(host.textContent).toContain(m.report_copy_recovery_description());
  expect(host.querySelector('input')?.value).toBe('https://site.test/en/threads/thread/reading');
  expect(host.textContent).not.toContain(m.report_copy_success());
  await click(button(m.report_copy_recovery_close()));
  expect(browser.document.activeElement).toBe(button(m.thread_reading_share()));
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test('Home uses actual FeedResults action slots, retains Continue and never invents feed scores', async () => {
  const content: FeedItem = {
    id: 'activity',
    occurredAt: null,
    source: 'following',
    key: { owner: 'content', kind: 'thread', route: 4660, id: 'thread' },
    summary: { id: 'thread', title: 'A discussion', kind: 'discussion', createdAt: '2026-11-03T00:00:00Z' },
    destination: { kind: 'thread', id: 'thread', title: 'A discussion' },
  };
  const work: FeedItem = {
    id: 'continue',
    occurredAt: null,
    source: 'continue',
    key: { owner: 'semantic', kind: 'book', route: 1, id: 'work' },
    summary: {
      id: 'work',
      type: 'book',
      types: ['book'],
      creativeWork: true,
      label: { value: 'A book', language: 'en' },
      cover: null,
    },
    destination: { kind: 'subject', id: 'work', title: 'A book' },
    continue: { subjectId: 'work', state: null, lastActivityAt: '2026-11-03T00:00:00Z', activeProgressSession: null },
  };
  await paint(
    <HomeFeed
      locale="en"
      signedIn
      verification={{ sitekey: 'prepared-key', scriptUrl: 'https://verify.example/script' }}
      result={{
        state: 'ready',
        page: {
          feedItems: [content, work],
          next: null,
          asOf: '2026-11-03T00:00:00Z',
          sources: { discovery: 'not_requested', following: 'ready', continue: 'ready' },
        },
      }}
    />,
  );
  expect(host.querySelectorAll('[data-slot="feed-action-bar"]')).toHaveLength(2);
  expect(host.querySelectorAll('[data-slot="vote-unavailable"]')).toHaveLength(2);
  expect(host.querySelector('[data-slot="vote-control"]')).toBeNull();
  expect(host.querySelector('a[href="/en/library/progress?subjectId=work"]')).not.toBeNull();
  expect(
    [...host.querySelectorAll('a')].some(
      (a) => a.textContent?.includes(m.feed_action_library()) && a.getAttribute('href')?.endsWith('?slot=collections'),
    ),
  ).toBe(true);
  expect(writes).toHaveLength(0);
  expect(reads).toHaveLength(0);
  // The installed report/copy owner receives the row address, not Home's current pathname.
  const copied: string[] = [];
  Object.defineProperty(browser.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (url: string) => {
        copied.push(url);
      },
    },
  });
  expect(button(m.report_action())).toBeNull();
  await click(button(m.report_more()));
  const menuItems = [...browser.document.querySelectorAll('[role="menuitem"]')];
  expect(menuItems.some((node) => node.textContent?.includes(m.report_action()))).toBe(true);
  await click(menuItems.find((node) => node.textContent?.includes(m.report_copy())) ?? null);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain('/en/threads/thread/');
  expect(copied[0]).not.toBe('https://site.test/en/');
});
