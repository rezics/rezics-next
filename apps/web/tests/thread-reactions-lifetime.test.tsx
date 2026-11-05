import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { ChangeReactionInput, ReactionFailure, ReactionSnapshot } from '../src/threads/reaction-request';

// UNRUN: default-composition regressions for the controller's integration gate.
// Only the changeReaction transport is gated; ThreadReactions, Reactions, their queue and session cache are real.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/one/reading' });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Result = { ok: true } | ReactionFailure;
const calls: (ReturnType<typeof deferred<Result>> & { data: ChangeReactionInput; headers: Headers })[] = [];
// Runtime shims select the browser implementation, without replacing the real in-memory session contract.
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/reactions', () => ({
  changeReaction: ({ data, headers }: { data: ChangeReactionInput; headers: HeadersInit }) => {
    const call = { ...deferred<Result>(), data, headers: new Headers(headers) };
    calls.push(call);
    return call.promise;
  },
  // The read transport stays pending: these cases gate only change outcomes.
  readReaction: () => deferred<ReactionSnapshot | ReactionFailure>().promise,
}));
const { createRoot } = await import('react-dom/client');
const { renderToStaticMarkup } = await import('react-dom/server');
const { QueryClient, QueryClientProvider, QueryObserver } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { ThreadReactions } = await import('../src/threads/thread-reactions');
const { m } = await import('../src/paraglide/messages.js');
type Props = ComponentProps<typeof ThreadReactions>;
const viewer = (subject = 'reader-one', csrfToken = 'csrf-one') => ({
  state: 'signed-in' as const,
  subject,
  csrfToken,
});
const baseline = (): Props => ({
  target: { kind: 'post', id: 'one' },
  counts: { like: 2, love: 3, sad: 1, insightful: 1, upvote: 4, downvote: 2 },
  value: 'like',
  signedIn: true,
  personalReady: true,
  returnTo: '/en/threads/one/reading',
  onMutation: async () => {
    refreshed.push('original');
  },
});
const fresh = (): Partial<Props> => ({
  counts: { like: 9, love: 8, sad: 7, insightful: 6, upvote: 5, downvote: 4 },
  value: 'insightful',
  onMutation: async () => {
    refreshed.push('replacement');
  },
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let props: Props;
const refreshed: string[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
async function paint(patch: Partial<Props> = {}, prepared = false) {
  props = { ...props, ...patch };
  await act(async () => {
    const view = <ThreadReactions {...props} />;
    root.render(prepared ? view : <QueryClientProvider client={client}>{view}</QueryClientProvider>);
  });
}
const chips = () => [...host.querySelectorAll<HTMLButtonElement>('button[data-slot="reaction-chip"]')];
function chip(label: string) {
  const node = chips().find((node) => node.textContent?.startsWith(label));
  expect(node).toBeDefined();
  return node!;
}
const click = (label: string) =>
  act(async () => {
    chip(label).click();
  });
const pressed = () =>
  chips()
    .filter((node) => node.getAttribute('aria-pressed') === 'true')
    .map((node) => node.textContent);
async function settle(index: number, result: Result | Error = { ok: true }) {
  await act(async () => {
    if (result instanceof Error) calls[index]!.reject(result);
    else calls[index]!.resolve(result);
    await tick();
  });
}
function freshView() {
  expect(pressed()).toEqual([`${m.reaction_insightful()}6`]);
  expect(chip(m.reaction_love()).textContent).toBe(`${m.reaction_love()}8`);
  expect(host.querySelector('[role="status"]')).toBeNull();
}
beforeEach(() => {
  calls.length = 0;
  refreshed.length = 0;
  props = baseline();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
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

const boundaries = [
  'target-id',
  'target-kind',
  'account',
  'csrf',
  'away/back',
  'session-loss',
  'session-error',
  'session-removal',
  'readiness',
  'signed-in',
  'unmount',
  'provider',
] as const;
for (const boundary of boundaries)
  for (const outcome of ['success', 'refusal', 'lost-response'] as const) {
    test(`${boundary} retires queued choices and late ${outcome} without lending them to the replacement`, async () => {
      await paint();
      await click(m.reaction_love());
      await click(m.reaction_sad());
      expect(calls).toHaveLength(1);
      expect(chip(m.reaction_sad()).disabled).toBe(false);
      expect(calls[0]!.data).toEqual({ target: 'post', id: 'one', kind: 'love', expectedReader: 'reader-one' });
      expect(calls[0]!.headers.get('x-csrf-token')).toBe('csrf-one');

      if (boundary === 'target-id') await paint({ ...fresh(), target: { kind: 'post', id: 'two' } });
      if (boundary === 'target-kind') await paint({ ...fresh(), target: { kind: 'thread', id: 'one' } });
      if (boundary === 'readiness') {
        await paint({ personalReady: false });
        await paint({ ...fresh(), personalReady: true });
      }
      if (boundary === 'signed-in') {
        await paint({ signedIn: false });
        await paint({ ...fresh(), signedIn: true });
      }
      if (boundary === 'unmount') {
        await act(async () => root.render(null));
        await paint(fresh());
      }
      if (boundary === 'provider') {
        const previousClient = client;
        client = new QueryClient();
        client.setQueryData(sessionQuery.queryKey, viewer());
        await paint(fresh());
        previousClient.clear();
      }
      if (boundary === 'session-error') {
        await act(async () => {
          await client
            .fetchQuery({
              ...sessionQuery,
              staleTime: 0,
              queryFn: async () => {
                throw new Error('session refresh failed');
              },
            })
            .catch(() => {});
        });
        const sessionEntry = client.getQueryCache().find({ queryKey: sessionQuery.queryKey });
        expect(sessionEntry?.state.status).toBe('error');
        expect(sessionEntry?.state.data).toEqual(viewer());
      }
      if (['account', 'csrf', 'away/back', 'session-loss', 'session-error', 'session-removal'].includes(boundary)) {
        await act(async () => {
          if (boundary === 'account') client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
          if (boundary === 'csrf') client.setQueryData(sessionQuery.queryKey, viewer('reader-one', 'csrf-two'));
          if (boundary === 'away/back') {
            // No intermediate React render: observing B must retire A even when A comes straight back.
            client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
            client.setQueryData(sessionQuery.queryKey, viewer());
          }
          if (boundary === 'session-loss')
            client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
          if (boundary === 'session-removal') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
        });
        if (boundary === 'session-loss' || boundary === 'session-error' || boundary === 'session-removal') {
          expect(chips().every((node) => node.disabled)).toBe(true);
          await act(async () => {
            client.setQueryData(sessionQuery.queryKey, viewer());
          });
        }
        await paint(fresh());
      }
      freshView();
      await settle(
        0,
        outcome === 'success'
          ? { ok: true }
          : outcome === 'refusal'
            ? { ok: false, reason: 'forbidden' }
            : new Error('Response lost'),
      );
      expect(calls).toHaveLength(1);
      expect(refreshed).toEqual([]);
      freshView();
      // A fresh current choice remains usable; it does not wait for or replay the retired queue.
      await click(m.reaction_like());
      expect(calls).toHaveLength(2);
      expect(calls[1]!.data).toEqual({
        target: props.target.kind,
        id: props.target.id,
        kind: 'like',
        expectedReader: boundary === 'account' ? 'reader-two' : 'reader-one',
      });
      expect(calls[1]!.headers.get('x-csrf-token')).toBe(
        boundary === 'account' || boundary === 'csrf' ? 'csrf-two' : 'csrf-one',
      );
      await settle(1);
      expect(refreshed).toEqual(['replacement']);
      expect(pressed()).toEqual([`${m.reaction_like()}10`]);
    });
  }

for (const targetKind of ['thread', 'post', 'subject'] as const)
  test(`${targetKind} commands retire on a retained-data session error and recover for the same reader`, async () => {
    props = { ...baseline(), target: { kind: targetKind, id: 'one' } };
    await paint();
    await click(m.reaction_love());
    await click(m.reaction_sad());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data.expectedReader).toBe('reader-one');
    const queuedChoice = chip(m.reaction_sad());

    await act(async () => {
      await client
        .fetchQuery({
          ...sessionQuery,
          staleTime: 0,
          queryFn: async () => {
            throw new Error('session refresh failed');
          },
        })
        .catch(() => {});
      const sessionEntry = client.getQueryCache().find({ queryKey: sessionQuery.queryKey });
      expect(sessionEntry?.state.status).toBe('error');
      expect(sessionEntry?.state.data).toEqual(viewer());
      queuedChoice.click();
      calls[0]!.resolve({ ok: true });
      await tick();
    });
    expect(calls).toHaveLength(1);
    expect(refreshed).toEqual([]);
    expect(chips().every((node) => node.disabled)).toBe(true);

    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer());
    });
    await paint(fresh());
    await click(m.reaction_like());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data).toEqual({
      target: targetKind,
      id: 'one',
      kind: 'like',
      expectedReader: 'reader-one',
    });
    await settle(1);
    expect(refreshed).toEqual(['replacement']);
  });

test('a session transition before queued work starts fences transport immediately, before a replacement render', async () => {
  await paint();
  await act(async () => {
    chip(m.reaction_love()).click();
    chip(m.reaction_sad()).click();
    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
    client.setQueryData(sessionQuery.queryKey, viewer());
    await tick();
  });
  expect(calls).toEqual([]);
  expect(refreshed).toEqual([]);
  expect(pressed()).toEqual([`${m.reaction_like()}2`]);
});

test('an observed away/back transition fences an in-flight completion before React replaces the caller', async () => {
  await paint();
  await click(m.reaction_love());
  await click(m.reaction_sad());
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
    client.setQueryData(sessionQuery.queryKey, viewer());
    calls[0]!.resolve({ ok: true });
    await tick();
  });
  expect(calls).toHaveLength(1);
  expect(refreshed).toEqual([]);
  expect(pressed()).toEqual([`${m.reaction_like()}2`]);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test('ordinary echoes and callback replacement preserve current serialized replace/remove choices and the original token', async () => {
  await paint();
  await click(m.reaction_love());
  await click(m.reaction_sad());
  await click(m.reaction_sad());
  expect(calls).toHaveLength(1);
  const pendingSession = deferred<ReturnType<typeof viewer>>();
  let sessionFetch!: Promise<ReturnType<typeof viewer>>;
  const observer = new QueryObserver(client, sessionQuery);
  const unsubscribe = observer.subscribe(() => {});
  await act(async () => {
    // These are ordinary notifications. A later success is separately covered as retirement.
    observer.updateResult();
    await client.invalidateQueries({ queryKey: sessionQuery.queryKey, exact: true, refetchType: 'none' });
    client.setQueryData(['session', 'unrelated'], viewer());
    sessionFetch = client.fetchQuery({ ...sessionQuery, queryFn: () => pendingSession.promise, staleTime: 0 });
  });
  await paint({
    counts: { ...props.counts, like: 1, love: 4 },
    value: 'love',
    onMutation: async () => {
      refreshed.push('current');
    },
  });
  await settle(0);
  expect(calls).toHaveLength(2);
  expect(pressed()).toEqual([`${m.reaction_sad()}2`]);
  await settle(1);
  expect(calls).toHaveLength(3);
  expect(pressed()).toEqual([]);
  await settle(2);
  expect(calls.map((call) => call.data.kind)).toEqual(['love', 'sad', null]);
  expect(
    calls.every(
      (call) =>
        call.data.target === 'post' && call.data.id === 'one' && call.headers.get('x-csrf-token') === 'csrf-one',
    ),
  ).toBe(true);
  expect(refreshed).toEqual(['original', 'original', 'original']);
  expect(host.querySelector('[aria-busy="true"]')).toBeNull();
  unsubscribe();
  await act(async () => {
    pendingSession.resolve(viewer());
    await sessionFetch;
  });
});

test('a current refusal rolls back one slot, preserves its copy, and keeps the next choice usable', async () => {
  await paint();
  await click(m.reaction_love());
  await click(m.reaction_sad());
  await settle(0, { ok: false, reason: 'forbidden' });
  expect(calls[1]!.data.kind).toBe('sad');
  await settle(1, { ok: false, reason: 'rate-limited', retryAfter: 7 });
  expect(pressed()).toEqual([`${m.reaction_like()}2`]);
  expect(chip(m.reaction_love()).textContent).toBe(`${m.reaction_love()}3`);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.reaction_rate_limited({ seconds: 7 }));
  expect(refreshed).toEqual([]);
  await click(m.reaction_love());
  await settle(2);
  expect(pressed()).toEqual([`${m.reaction_love()}4`]);
  expect(host.querySelector('[role="status"]')).toBeNull();
});

test('a current permission refusal preserves the existing refusal copy and controlled counts', async () => {
  await paint();
  await click(m.reaction_love());
  await settle(0, { ok: false, reason: 'forbidden' });
  expect(pressed()).toEqual([`${m.reaction_like()}2`]);
  expect(chip(m.reaction_love()).textContent).toBe(`${m.reaction_love()}3`);
  expect(host.querySelector('[role="status"]')?.textContent).toBe(m.reaction_forbidden());
  expect(refreshed).toEqual([]);
  await paint({ ...fresh(), target: { kind: 'post', id: 'two' } });
  freshView();
});

for (const reject of [false, true])
  test(`retirement during an already-started refresh suppresses its late ${reject ? 'failure' : 'completion'} and queued transport`, async () => {
    const refresh = deferred<void>();
    await paint({
      onMutation: async () => {
        refreshed.push('started');
        await refresh.promise;
      },
    });
    await click(m.reaction_love());
    await click(m.reaction_sad());
    await settle(0);
    expect(refreshed).toEqual(['started']);
    await paint({ ...fresh(), target: { kind: 'subject', id: 'two' } });
    await act(async () => {
      if (reject) refresh.reject(new Error('Refresh failed'));
      else refresh.resolve();
      await tick();
    });
    expect(calls).toHaveLength(1);
    freshView();
    expect(chips().some((node) => node.textContent?.startsWith(m.reaction_upvote()))).toBe(false);
    expect(chips().some((node) => node.textContent?.startsWith(m.reaction_downvote()))).toBe(false);
  });

test('SSR, unknown sessions and readiness remain disabled, while anonymous URLs and standalone prepared views survive', async () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ThreadReactions {...props} />
    </QueryClientProvider>,
  );
  expect(html).toContain('disabled=""');
  await act(async () => {
    client.setQueryData(['session'], { state: 'unknown', csrfToken: null });
  });
  await paint();
  expect(chips().every((node) => node.disabled)).toBe(true);
  await click(m.reaction_love());
  expect(calls).toEqual([]);
  await paint({ signedIn: false });
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/auth/sign-in?return_to=%2Fen%2Fthreads%2Fone%2Freading');
  await paint({ signedIn: true, personalReady: false }, true);
  expect(chips().every((node) => node.disabled)).toBe(true);
  await paint({ personalReady: true }, true);
  await click(m.reaction_love());
  expect(calls).toHaveLength(1);
  await settle(0);
  expect(pressed()).toEqual([`${m.reaction_love()}4`]);
});

// UNRUN: qualifying equal successes replace work; no helper/queue/admission is mocked.
for (const source of ['manual', 'fetch'] as const)
  for (const target of ['thread', 'post', 'subject'] as const)
    for (const outcome of ['success', 'refusal', 'lost-response'] as const)
      test(`${source} equal success retires ${target} queued work and late ${outcome} before React commits`, async () => {
        await paint({ target: { kind: target, id: 'one' } });
        await click(m.reaction_love());
        await click(m.reaction_sad());
        expect(calls).toHaveLength(1);
        const oldButton = chip(m.reaction_like());
        const oldData = client.getQueryData(sessionQuery.queryKey);
        const successes: unknown[] = [];
        const unsubscribe = client.getQueryCache().subscribe((event) => {
          if (
            event.query.queryKey.length === 1 &&
            event.query.queryKey[0] === 'session' &&
            event.type === 'updated' &&
            event.action.type === 'success'
          ) {
            successes.push(event.query.state.data);
            oldButton.click();
            if (outcome === 'lost-response') calls[0]!.reject(new Error('Response lost'));
            else calls[0]!.resolve(outcome === 'success' ? { ok: true } : { ok: false, reason: 'forbidden' });
          }
        });
        const sessionResult = deferred<ReturnType<typeof viewer>>();
        let pending: Promise<unknown> | undefined;
        if (source === 'fetch') {
          await act(async () => {
            pending = client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: () => sessionResult.promise });
          });
          // Merely starting the fetch has not retired the optimistic selection or drained the queue.
          expect(pressed()).toEqual([`${m.reaction_love()}4`]);
          expect(calls).toHaveLength(1);
        }
        await act(async () => {
          expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
          if (source === 'manual') client.setQueryData(sessionQuery.queryKey, { ...viewer() });
          else {
            sessionResult.resolve({ ...viewer() });
            await pending;
          }
          expect(successes).toHaveLength(1);
          expect(successes[0]).toBe(oldData); // Default structural sharing retained the original object.
          expect(successes[0]).toEqual(viewer());
          await tick();
        });
        unsubscribe();
        expect(calls).toHaveLength(1);
        expect(refreshed).toEqual([]);
        expect(pressed()).toEqual([`${m.reaction_like()}2`]);
        expect(host.querySelector('[role="status"]')).toBeNull();
        expect(chip(m.reaction_love()).textContent).toBe(`${m.reaction_love()}3`);
        expect(oldButton.isConnected).toBe(false);
        expect(window.document.activeElement).not.toBe(oldButton);
        await click(m.reaction_love());
        await settle(1);
        await click(m.reaction_love());
        await settle(2);
        expect(calls.map((call) => call.data.kind)).toEqual(['love', 'love', null]);
        expect(
          calls.every(
            (call) =>
              call.data.target === target &&
              call.data.id === 'one' &&
              call.data.expectedReader === 'reader-one' &&
              call.headers.get('x-csrf-token') === 'csrf-one',
          ),
        ).toBe(true);
        expect(refreshed).toEqual(['original', 'original']);
        expect(pressed()).toEqual([]);
      });

for (const source of ['manual', 'fetch'] as const) {
  test(`${source} equal success fences undispatched choices in the same act`, async () => {
    await paint();
    const oldButton = chip(m.reaction_sad());
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey.length === 1 &&
        event.query.queryKey[0] === 'session' &&
        event.type === 'updated' &&
        event.action.type === 'success'
      )
        oldButton.click();
    });
    await act(async () => {
      if (source === 'fetch') {
        await client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: async () => ({ ...viewer() }) });
      } else {
        chip(m.reaction_love()).click();
        chip(m.reaction_sad()).click();
        client.setQueryData(sessionQuery.queryKey, { ...viewer() });
      }
      await tick();
    });
    unsubscribe();
    expect(calls).toEqual([]);
    expect(refreshed).toEqual([]);
    expect(pressed()).toEqual([`${m.reaction_like()}2`]);
  });

  for (const reject of [false, true])
    test(`${source} equal success retires an already-started refresh and its late ${reject ? 'failure' : 'completion'}`, async () => {
      const refresh = deferred<void>();
      await paint({
        onMutation: async () => {
          refreshed.push('started');
          await refresh.promise;
        },
      });
      await click(m.reaction_love());
      await click(m.reaction_sad());
      await settle(0);
      expect(refreshed).toEqual(['started']);
      await act(async () => {
        if (source === 'manual') client.setQueryData(sessionQuery.queryKey, { ...viewer() });
        else await client.fetchQuery({ ...sessionQuery, staleTime: 0, queryFn: async () => ({ ...viewer() }) });
        if (reject) refresh.reject(new Error('Refresh failed'));
        else refresh.resolve();
        await tick();
      });
      expect(calls).toHaveLength(1);
      expect(refreshed).toEqual(['started']);
      expect(pressed()).toEqual([`${m.reaction_like()}2`]);
      expect(host.querySelector('[role="status"]')).toBeNull();
      await paint(fresh());
      await click(m.reaction_like());
      await settle(1);
      expect(refreshed).toEqual(['started', 'replacement']);
    });
}
