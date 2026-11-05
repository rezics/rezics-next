import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { ChangeReactionInput, ReactionFailure } from '../src/threads/reaction-request';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/one' });
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
type Pending = {
  data: ChangeReactionInput;
  headers: Headers;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
const writes: Pending[] = [],
  reads: Pending[] = [];
const transport =
  (calls: Pending[]) =>
  ({ data, headers }: { data: ChangeReactionInput; headers: HeadersInit }) =>
    new Promise((resolve, reject) => calls.push({ data, headers: new Headers(headers), resolve, reject }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reactions', () => ({ changeReaction: transport(writes), readReaction: transport(reads) }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { ThreadReactions } = await import('../src/threads/thread-reactions');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes(label))!;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function settle(call: Pending, result: unknown) {
  await act(async () => {
    if (result instanceof Error) call.reject(result);
    else call.resolve(result);
    await tick();
  });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  client?.clear();
  writes.length = reads.length = 0;
});
afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
});

test('keyboard recovery keeps its focus boundary and pointer recovery does not take focus', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThreadReactions
          target={{ kind: 'post', id: 'one' }}
          counts={{ like: 2, love: 3 }}
          value="like"
          signedIn
          returnTo="/en/threads/one"
        />
      </QueryClientProvider>,
    ),
  );
  const like = button(m.reaction_like());
  await act(async () => {
    like.focus();
    like.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    like.click();
  });
  await settle(writes[0]!, new Error('lost'));
  const retry = button(m.editorial_retry());
  expect(window.document.activeElement).toBe(retry);
  await act(async () => {
    retry.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    retry.click();
  });
  await settle(writes[1]!, { ok: true });
  await settle(reads[0]!, { ok: true, counts: { like: 2, love: 4 }, value: 'love' });
  const boundary = host.querySelector<HTMLElement>('[role="group"][tabindex="-1"]')!;
  expect(window.document.activeElement).toBe(boundary);
  const external = window.document.createElement('input');
  window.document.body.append(external);
  const pointerLike = button(m.reaction_like());
  await act(async () => {
    pointerLike.focus();
    pointerLike.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    pointerLike.click();
  });
  external.focus();
  await settle(writes[2]!, new Error('lost'));
  expect(window.document.activeElement).toBe(external);
});
