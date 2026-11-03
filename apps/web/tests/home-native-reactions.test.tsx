import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FeedItem, FeedPage } from '../src/features/pages/home-feed-read';
import type { FeedReaction } from '../src/features/feed/vote-control';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/' });
const globals = {
  window, document: window.document, navigator: window.navigator,
  HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element, Node: window.Node, Document: window.Document,
  DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { HomeFeed } = await import('../src/features/pages/home-feed');
const { homeReactionAdmission } = await import('../src/features/feed/home-reaction-admission');
const { m } = await import('../src/paraglide/messages.js');
const id = '00000000-0000-7000-8000-000000000001';
function row(index = 0): FeedItem {
  return {
    id: `occurrence:${index}`, source: 'following', occurredAt: null,
    key: { owner: 'content', kind: 'thread', route: 0, id },
    summary: { id: 'different-summary-id', kind: index % 2 ? 'review' : 'discussion', title: `Card ${index}`, createdAt: '2026-11-04T00:00:00Z',
      reactionTarget: { targetKind: 'thread', targetId: id }, reactions: { upvote: 8, downvote: 2 }, viewerReaction: null },
    destination: { kind: 'thread', id, title: `Card ${index}` },
  };
}
function page(count = 1): FeedPage {
  return { feedItems: Array.from({ length: count }, (_, index) => row(index)), next: null, asOf: '2026-11-04T00:00:00Z',
    reactionsAsOf: { epoch: 1, position: '7' }, sources: { following: 'ready', discovery: 'not_requested', continue: 'not_requested' } };
}
type Props = ComponentProps<typeof HomeFeed>;
type Transport = NonNullable<FeedReaction['preparedTransport']>;
const host = window.document.createElement('div');
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: QueryClient;
let props: Props;
const writes: Parameters<Transport['change']>[0][] = [];
let reads = 0;
let value: FeedReaction['value'];
let failure: 'refused' | 'unknown' | undefined;
const transport: Transport = {
  change: async input => {
    writes.push(input);
    if (failure === 'unknown') throw new Error('lost response');
    if (failure === 'refused') return { ok: false, reason: 'forbidden' };
    value = input.data.kind;
    return { ok: true };
  },
  read: async () => { reads++; return { ok: true, counts: { upvote: 8 + Number(value === 'upvote'), downvote: 2 + Number(value === 'downvote') }, value }; },
};
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('[data-slot="vote-control"] button')];
const pressed = () => buttons().filter(button => button.getAttribute('aria-pressed') === 'true');
async function paint(patch: Partial<Props> = {}) {
  props = { ...props, ...patch };
  await act(async () => { root.render(<QueryClientProvider client={client}><HomeFeed {...props} /></QueryClientProvider>); });
}
async function click(button: HTMLElement) { await act(async () => { button.click(); await new Promise(resolve => setTimeout(resolve, 0)); }); }
beforeEach(() => {
  client = new QueryClient();
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  props = { result: { state: 'ready', page: page() }, locale: 'en', signedIn: true, preparedReactionTransport: transport };
  writes.length = 0; reads = 0; value = null; failure = undefined;
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); });
afterAll(async () => {
  mock.restore(); await window.happyDOM.close();
  for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test.each([1, 10, 20])('%i duplicate targets and mixed unsupported rows do not read reactions on mount', async count => {
  const native = page(count);
  native.feedItems = native.feedItems.map((item, index) => index % 3 ? item : {
    id: item.id, source: 'following', occurredAt: null, key: { owner: 'library', kind: 'collection', route: 0, id },
    summary: { id, title: 'Collection', description: null }, destination: { kind: 'collection', id, title: 'Collection' },
  });
  await paint({ result: { state: 'ready', page: native } });
  expect(host.querySelectorAll('[data-feed-id]')).toHaveLength(count);
  expect(reads).toBe(0); expect(writes).toHaveLength(0);
});

test('known empty, unavailable, anonymous omission and signed-in null stay distinct', async () => {
  const item = row();
  if (!('reactionTarget' in item.summary)) throw new Error('Content summary required');
  item.summary.reactions = {};
  delete item.summary.viewerReaction;
  expect(homeReactionAdmission(item, true)?.personalReady).toBe(false);
  expect(homeReactionAdmission(item, false)).toMatchObject({ counts: {}, value: null, personalReady: true });
  item.summary.viewerReaction = null;
  expect(homeReactionAdmission(item, true)?.personalReady).toBe(true);
  const native = page(); native.feedItems = [item];
  await paint({ result: { state: 'ready', page: native } });
  expect(host.querySelector('output')?.textContent).toBe('0');
  delete item.summary.reactions;
  expect(homeReactionAdmission(item, true)).toBeUndefined();
  item.summary.reactions = { upvote: 9 };
  item.summary.reactionTarget = { targetKind: 'post', targetId: id };
  expect(homeReactionAdmission(item, true)).toBeUndefined();
  delete item.summary.reactionTarget;
  expect(homeReactionAdmission(item, true)).toBeUndefined();
});

test('select, switch and clear use the supplied target and the installed engine readback', async () => {
  await paint();
  for (const index of [0, 1, 1]) await click(buttons()[index]!);
  expect(writes.map(call => call.data.kind)).toEqual(['upvote', 'downvote', null]);
  expect(writes.every(call => call.data.id === id && call.data.target === 'thread' && call.data.expectedReader === 'reader')).toBe(true);
  expect(reads).toBe(3); expect(pressed()).toHaveLength(0);
});

test('refusal rolls back and unknown retry retains the same immutable command before readback', async () => {
  await paint(); failure = 'refused'; await click(buttons()[0]!);
  expect(pressed()).toHaveLength(0); expect(reads).toBe(0);
  failure = 'unknown'; await click(buttons()[0]!);
  const command = writes.at(-1)!;
  failure = undefined;
  await click([...host.querySelectorAll('button')].find(button => button.textContent === m.editorial_retry())!);
  expect(writes.at(-1)).toEqual(command); expect(reads).toBe(1);
});

test('request, source watermark and equal session replacement retire old private observations', async () => {
  await paint(); await click(buttons()[0]!); expect(pressed()).toHaveLength(1);
  await paint({ busy: true, input: { stream: 'following', spaceId: 'replacement-space' } });
  expect(pressed()).toHaveLength(0); expect(host.querySelector('[data-slot="vote-unavailable"]')).not.toBeNull();
  const next = page(); next.reactionsAsOf = { epoch: 2, position: '1' };
  await paint({ busy: false, result: { state: 'ready', page: next } });
  await click(buttons()[0]!);
  await act(async () => { client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' }); });
  expect(pressed()).toHaveLength(0); expect(host.querySelector('[data-slot="vote-unavailable"]')).not.toBeNull();
});
