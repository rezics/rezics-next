import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { createKernelClient } from '@rezics/client';
import * as start from '../.storybook/react-start';
import { changeReactionRequest, readReactionRequest, type ChangeReactionInput } from '../src/threads/reaction-request';
import { boardOpeningCard } from '../src/threads/board-opening-fixtures';
import { boardOpeningReaction } from '../src/threads/board-opening';
import type { SessionEnv } from '../src/session/client';

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
type Call = { data: ChangeReactionInput; headers: Headers; resolve(value: unknown): void; reject(error: Error): void };
const writes: Call[] = [],
  reads: Call[] = [];
const transport =
  (calls: Call[]) =>
  ({ data, headers }: { data: ChangeReactionInput; headers: HeadersInit }) =>
    new Promise((resolve, reject) => calls.push({ data, headers: new Headers(headers), resolve, reject }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reactions', () => ({ changeReaction: transport(writes), readReaction: transport(reads) }));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { ThreadReactions } = await import('../src/threads/thread-reactions');
const { m } = await import('../src/paraglide/messages.js');
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
const session = (subject = 'reader') => ({ state: 'signed-in', subject, csrfToken: 'csrf' });
async function paint(patch: Partial<ComponentProps<typeof ThreadReactions>> = {}) {
  if (!root) {
    client = new QueryClient();
    client.setQueryData(['session'], session());
    root = createRoot(host);
  }
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ThreadReactions
          target={{ kind: 'post', id: 'one' }}
          counts={{ like: 2, love: 3 }}
          value="like"
          signedIn
          returnTo="/en/threads/one"
          {...patch}
        />
      </QueryClientProvider>,
    ),
  );
}
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.startsWith(label))!;
const click = (label: string) =>
  act(async () => {
    button(label).click();
  });
async function settle(call: Call, result: unknown = { ok: true }) {
  await act(async () => {
    if (result instanceof Error) call.reject(result);
    else call.resolve(result);
  });
}
function boardReaction(isCurrent: () => boolean = () => true) {
  const card = boardOpeningCard(1);
  card.actions.react = 'allowed';
  card.interaction = {
    ...card.interaction,
    counts: { state: 'as-of', values: { like: 3 }, source: { epoch: 2, position: '12' } },
    viewer: { state: 'current', reaction: null },
  };
  return boardOpeningReaction(card, true, { key: 'board-visit', reader: 'reader', isCurrent });
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
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('a replaced Board reader discards the late mutation before its current-target readback', async () => {
  let current = true;
  await paint(boardReaction(() => current));
  await click(m.reaction_like());
  current = false;
  await settle(writes[0]!);
  expect(writes[0]!.data).toMatchObject({ target: 'thread', kind: 'like', expectedReader: 'reader' });
  expect(reads).toHaveLength(0);
});

test('a failed Board readback retries the exact target and reader without repeating the acknowledged write', async () => {
  await paint(boardReaction());
  await click(m.reaction_like());
  await settle(writes[0]!);
  expect(reads[0]!.data).toEqual(writes[0]!.data);
  await settle(reads[0]!, { ok: false, reason: 'unavailable' });
  await click(m.editorial_retry());
  expect(writes).toHaveLength(1);
  expect(reads[1]!.data).toEqual(writes[0]!.data);
  await settle(reads[1]!, {
    ok: true,
    counts: { like: 4 },
    value: 'like',
    reactionsAsOf: { epoch: 2, position: '13' },
  });
});

for (const clear of [false, true])
  test(`lost ${clear ? 'clear' : 'replace'} retries its exact intent and reads past an older receipt`, async () => {
    const refreshed: unknown[] = [];
    let finishRefresh!: () => void;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    await paint({
      onMutation: async (kind) => {
        refreshed.push(kind);
        await refresh;
      },
    });
    await click(clear ? m.reaction_like() : m.reaction_love());
    await click(m.reaction_love()); // A queued choice cannot escape uncertainty.
    await settle(writes[0]!, new Error('Response lost'));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(m.candidate_unavailable());
    expect(button(m.reaction_like()).disabled).toBe(true);
    await click(m.editorial_retry());
    await click(m.editorial_retry());
    expect(writes).toHaveLength(2);
    expect(writes[1]!.data).toEqual(writes[0]!.data);
    expect(writes[1]!.data.kind).toBe(clear ? null : 'love');
    expect(writes[1]!.headers.get('idempotency-key')).toBe(writes[0]!.headers.get('idempotency-key'));
    await settle(writes[1]!, clear ? { ok: false, reason: 'conflict' } : { ok: true });
    expect(reads[0]!.data).toEqual(writes[0]!.data);
    await settle(reads[0]!, { ok: false, reason: 'unavailable' });
    await click(m.editorial_retry());
    expect(writes).toHaveLength(2);
    await paint({ counts: { like: 50, love: 60 }, value: 'love' });
    await settle(reads[1]!, { ok: true, counts: { like: 7, love: 9 }, value: 'like' });
    expect(button(m.reaction_like()).textContent).toBe(`${m.reaction_like()}7`);
    expect(button(m.reaction_like()).getAttribute('aria-pressed')).toBe('true');
    expect(button(m.reaction_love()).textContent).toBe(`${m.reaction_love()}9`);
    expect(refreshed).toEqual(['like']);
    expect(button(m.reaction_like()).disabled).toBe(true);
    await act(async () => {
      finishRefresh();
    });
    expect(button(m.reaction_like()).disabled).toBe(false);
  });

for (const boundary of ['target', 'account', 'csrf'] as const)
  test(`${boundary} retires retry handlers and late reconciliation`, async () => {
    await paint();
    await click(m.reaction_love());
    await settle(writes[0]!, new Error('lost'));
    const retired = button(m.editorial_retry());
    await click(m.editorial_retry());
    await settle(writes[1]!);
    if (boundary !== 'target')
      await act(async () => {
        client.setQueryData(
          ['session'],
          boundary === 'account' ? session('other-reader') : { ...session(), csrfToken: 'replacement' },
        );
      });
    const target = {
      kind: boundary === 'target' ? ('thread' as const) : ('post' as const),
      id: boundary === 'target' ? 'two' : 'one',
    };
    await paint({ target, counts: { like: 20, love: 30 }, value: 'love' });
    await act(async () => retired.click());
    await settle(reads[0]!, { ok: true, counts: { like: 99 }, value: 'like' });
    expect(button(m.reaction_love()).textContent).toBe(`${m.reaction_love()}30`);
    expect(button(m.reaction_love()).getAttribute('aria-pressed')).toBe('true');
    expect(writes).toHaveLength(2);
    expect(reads).toHaveLength(1);
    await click(m.reaction_like());
    expect(writes[2]!.data).toMatchObject({
      target: target.kind,
      id: target.id,
      expectedReader: boundary === 'account' ? 'other-reader' : 'reader',
    });
    expect(writes[2]!.headers.get('idempotency-key')).not.toBe(writes[0]!.headers.get('idempotency-key'));
    await settle(writes[2]!);
  });

test('the BFF forwards retry identity, fences another reader, and reads the current exact target', async () => {
  const calls: Request[] = [];
  const native = createKernelClient('https://kernel.test', {
    fetch: async (url, init) => {
      const request = new Request(url, init);
      calls.push(request);
      return request.method === 'GET'
        ? Response.json({ post: { reactions: { love: 4 }, viewerReaction: 'love' } })
        : new Response(null, { status: 204 });
    },
  });
  const csrf = 'A'.repeat(22),
    sessionId = 'a'.repeat(43),
    commandId = crypto.randomUUID();
  const env = {
    SITE_ORIGINS: 'https://site.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://api.test',
    WEBSITE_SCOPES: 'reaction:set',
    WEBSITE_CLIENT_ID: 'rezics-website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: () => sessionId,
      get: () => ({
        credential: async () => ({ status: 'active', subject: 'reader', accessToken: 'access', csrfToken: csrf }),
      }),
    },
  } as unknown as Partial<SessionEnv>;
  const request = () =>
    new Request('https://site.test/reaction', {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        cookie: `__Host-rezics_session=${sessionId}`,
        'x-csrf-token': csrf,
        'idempotency-key': commandId,
      },
    });
  const input: ChangeReactionInput = { target: 'post', id: 'one', kind: null, expectedReader: 'reader' };
  for (let i = 0; i < 2; i++) expect(await changeReactionRequest(input, request(), env, native)).toEqual({ ok: true });
  expect(calls.map((call) => call.headers.get('idempotency-key'))).toEqual([commandId, commandId]);
  expect(await readReactionRequest(input, request(), env, native)).toEqual({
    ok: true,
    counts: { love: 4 },
    value: 'love',
  });
  expect(calls[2]!.url).toBe('https://kernel.test/v1/posts/one');
  expect(await changeReactionRequest({ ...input, expectedReader: 'other' }, request(), env, native)).toEqual({
    ok: false,
    reason: 'forbidden',
  });
  expect(calls).toHaveLength(3);
});
