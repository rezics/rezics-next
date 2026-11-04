import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';

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

type Request = { data: Record<string, unknown>; headers: Record<string, string> };
type Snapshot = {
  ok: true;
  counts: Record<string, number>;
  value: string | null;
  reactionsAsOf: { epoch: number; position: string };
};
let write: (request: Request) => Promise<{ ok: true } | { ok: false; reason: 'unavailable' }>;
let read: (request: Request) => Promise<Snapshot>;
const writes: Request[] = [];
const reads: Request[] = [];
const changeReaction = async (request: Request) => {
  writes.push(request);
  return write(request);
};
const readReaction = async (request: Request) => {
  reads.push(request);
  return read(request);
};

mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reactions', () => ({ changeReaction, readReaction }));

const { createRoot } = await import('react-dom/client');
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { homeFeedDestination } = await import('../src/features/pages/home-feed-destination');
const { m } = await import('../src/paraglide/messages.js');
const nativeFetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected native request'));
const original = homeFeedStoryPage().feedItems.find((item) => item.destination.kind === 'subject')!;
const subjectId = original.destination.kind === 'subject' ? original.destination.id : '';
const watermark = { epoch: 1, position: '2' };

function mountedProjection(kind: string | null, counts: Record<string, number> = { like: 3, love: 2, insightful: 1 }) {
  return {
    target: { targetKind: 'subject', targetId: subjectId },
    counts: { state: 'available', values: counts, asOf: watermark },
    viewer: { state: 'available', kind },
    action: 'allowed',
  };
}

function item(projection: unknown, id = subjectId): FeedItem {
  const destination = original.destination;
  const summary = { ...original.summary, id, creativeWork: false, subjectReactions: projection };
  return {
    ...original,
    id: `semantic:${id}`,
    key: { ...original.key, id },
    summary,
    destination: destination.kind === 'subject' ? { ...destination, id } : destination,
  } as FeedItem;
}

function page(row: FeedItem): FeedPage {
  const source = homeFeedStoryPage();
  return {
    ...source,
    feedItems: [row],
    next: null,
    sources: { discovery: 'ready', following: 'not_requested', continue: 'not_requested' },
  } as FeedPage;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const host = window.document.createElement('div');
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
async function paint(row: FeedItem, signedIn = true, onRetry?: () => void) {
  const result = { state: 'ready' as const, page: page(row) };
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <HomeFeed result={result} locale="en" signedIn={signedIn} onRetry={onRetry} />
      </QueryClientProvider>,
    );
    await tick();
  });
}
async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
    await tick();
  });
}
function reactionButton(kind: string) {
  const labels: Record<string, string> = {
    like: m.reaction_like(),
    love: m.reaction_love(),
    laugh: m.reaction_laugh(),
    insightful: m.reaction_insightful(),
    sad: m.reaction_sad(),
  };
  return [...host.querySelectorAll<HTMLButtonElement>('[data-slot="reactions"] button')].find((button) =>
    button.getAttribute('aria-label')?.startsWith(labels[kind]!),
  );
}

beforeEach(() => {
  writes.length = 0;
  reads.length = 0;
  write = async () => ({ ok: true });
  read = async () => ({
    ok: true,
    counts: { like: 3, love: 2 },
    value: null,
    reactionsAsOf: { epoch: 1, position: '3' },
  });
  client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-one', csrfToken: 'csrf-one' });
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.replaceChildren();
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

test('Home renders five admitted Subject kinds, clears deliberately, and waits for point reconciliation', async () => {
  const firstRead = deferred<Snapshot>();
  read = () => firstRead.promise;
  const row = item(mountedProjection('love'));
  await paint(row);

  expect(host.querySelectorAll('[data-slot="reaction-chip"]')).toHaveLength(5);
  expect(reactionButton('love')?.getAttribute('aria-pressed')).toBe('true');
  expect(reactionButton('laugh')?.textContent).toContain('0');
  await click(reactionButton('love')!);
  expect(writes[0]?.data).toMatchObject({ target: 'subject', id: subjectId, kind: null, expectedReader: 'reader-one' });
  expect(reactionButton('love')?.textContent).toContain('2');
  firstRead.resolve({
    ok: true,
    counts: { like: 3, love: 1 },
    value: null,
    reactionsAsOf: { epoch: 1, position: '3' },
  });
  await act(tick);
  expect(reactionButton('love')?.getAttribute('aria-pressed')).toBe('false');
  expect(reactionButton('love')?.textContent).toContain('1');

  read = async () => ({
    ok: true,
    counts: { like: 4, love: 1 },
    value: 'like',
    reactionsAsOf: { epoch: 1, position: '4' },
  });
  await click(reactionButton('like')!);
  expect(writes[1]?.data).toMatchObject({ target: 'subject', id: subjectId, kind: 'like' });
  expect(reactionButton('like')?.textContent).toContain('4');
  expect(reactionButton('like')?.getAttribute('aria-pressed')).toBe('true');
  expect(reads).toHaveLength(2);
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('anonymous Home Subject reactions return to the card', async () => {
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  await paint(
    item({
      target: { targetKind: 'subject', targetId: subjectId },
      counts: { state: 'available', values: { like: 2 }, asOf: watermark },
      action: 'sign_in',
    }),
    false,
  );
  const expected = `/${'en'}/auth/sign-in?return_to=${encodeURIComponent(homeFeedDestination(original, 'en'))}`;
  expect(host.querySelectorAll('[data-slot="reaction-chip"][href]')).toHaveLength(5);
  expect(
    [...host.querySelectorAll<HTMLAnchorElement>('[data-slot="reaction-chip"][href]')].every(
      (link) => link.getAttribute('href') === expected,
    ),
  ).toBe(true);
});

test('unknown Home Subject coverage disables reactions and retries through the page', async () => {
  let retries = 0;
  const unavailable = item({
    target: { targetKind: 'subject', targetId: subjectId },
    counts: { state: 'unavailable' },
    viewer: { state: 'unavailable' },
    action: 'unavailable',
  });
  await paint(unavailable, true, () => retries++);
  expect(host.querySelectorAll('[data-slot="subject-reaction-unavailable"] button[aria-label*="—"]')).toHaveLength(5);
  expect(
    [
      ...host.querySelectorAll<HTMLButtonElement>('[data-slot="subject-reaction-unavailable"] button[aria-label*="—"]'),
    ].every((button) => button.disabled),
  ).toBe(true);
  expect(host.querySelectorAll('[data-slot="subject-reaction-unavailable"] button[aria-label*="—"]')).toHaveLength(5);
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === m.subject_section_retry(),
  );
  expect(retry).toBeDefined();
  expect(retry?.disabled).toBe(false);
  await click(retry!);
  expect(retries).toBe(1);
  expect(writes).toHaveLength(0);
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('an uncertain Home write retries the immutable original intent and retires late feedback after account replacement', async () => {
  write = async () => ({ ok: false, reason: 'unavailable' });
  await paint(item(mountedProjection(null)));
  await click(reactionButton('love')!);
  const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === m.editorial_retry(),
  );
  expect(retry).toBeDefined();
  expect(reads).toHaveLength(0);
  const originalWrite = writes[0]!;
  write = async () => ({ ok: true });
  const pointRead = deferred<Snapshot>();
  read = () => pointRead.promise;
  await click(retry!);
  expect(writes).toHaveLength(2);
  expect(writes[1]?.data).toEqual(originalWrite.data);
  expect(writes[1]?.headers['Idempotency-Key']).toBe(originalWrite.headers['Idempotency-Key']);
  expect(reactionButton('love')?.textContent).toContain('2');

  await act(async () => {
    client.setQueryData(['session'], { state: 'signed-in', subject: 'reader-two', csrfToken: 'csrf-two' });
    await tick();
  });
  pointRead.resolve({
    ok: true,
    counts: { like: 3, love: 3 },
    value: 'love',
    reactionsAsOf: { epoch: 1, position: '3' },
  });
  await act(tick);
  expect(reactionButton('love')?.getAttribute('aria-pressed')).not.toBe('true');
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(host.querySelector('button')?.textContent).not.toBe(m.editorial_retry());
  expect(nativeFetch).not.toHaveBeenCalled();
});

test('Subject fallback does not borrow counts, selection or sign-in advice from another target', async () => {
  const projection = {
    ...mountedProjection('love'),
    action: 'sign_in',
    target: { targetKind: 'subject', targetId: 'another-subject' },
  };
  await paint(item(projection), false);
  const fallback = host.querySelector('[data-slot="subject-reaction-unavailable"]')!;
  expect(fallback.querySelector('a')).toBeNull();
  expect(fallback.querySelectorAll('button[aria-label*="—"]')).toHaveLength(5);
  expect(writes).toHaveLength(0);
});
