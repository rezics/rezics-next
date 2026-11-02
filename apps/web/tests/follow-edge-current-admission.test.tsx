import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import type { CurrentFollowState, FollowWriteInput, FollowWriteResult } from '../src/library/follow-records';
import type { SessionEnv } from '../src/session/client';

// UNRUN: focused composed/deferred regressions for integration, using the existing mounted DOM facilities.
// Controlled native responses exercise the actual reader; they establish no native or browser authorization proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/following' });
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
const firstTarget = 'original-target';
const secondTarget = 'second-target';
const firstKey = '123e4567-e89b-42d3-a456-426614174000';
const secondKey = '123e4567-e89b-42d3-a456-426614174001';
const reads: (ReturnType<typeof deferred<CurrentFollowState>> & { targetId: string })[] = [];
const writes: (ReturnType<typeof deferred<FollowWriteResult>> & { input: FollowWriteInput; csrfToken: string })[] = [];
let admitted: string[];
let actualRead: ((targetId: string) => Promise<CurrentFollowState>) | undefined;
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/exposure', () => ({ useOperation: (operation: string) => admitted.includes(operation) }));
mock.module('../src/library/follow-actions', () => ({
  readFollowState: async () => ({ state: 'unavailable' }),
  readCurrentFollowState: ({ data }: { data: { targetId: string } }) => {
    if (actualRead) return actualRead(data.targetId);
    const call = { ...deferred<CurrentFollowState>(), targetId: data.targetId };
    reads.push(call);
    return call.promise;
  },
  setFollow: ({ data, headers }: { data: FollowWriteInput; headers: Record<string, string> }) => {
    const call = { ...deferred<FollowWriteResult>(), input: data, csrfToken: headers['X-CSRF-Token']! };
    writes.push(call);
    return call.promise;
  },
}));
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { loadCurrentFollowState } = await import('../src/library/follow-records');
const { prepareSession } = await import('../src/session/request');
const { FollowTargetControl, followStateQuery } = await import('../src/library/follow-target-control');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
const viewer = (subject = 'alice', csrfToken = 'csrf-one') => ({ state: 'signed-in', subject, csrfToken });
const page = (targetId = firstTarget, following = true, subject = 'alice'): CurrentFollowState => ({
  targetId,
  subject,
  edge: { state: 'ready', following },
});
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let props: ComponentProps<typeof FollowTargetControl>;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const tree = () => (
  <QueryClientProvider client={client}>
    <FollowTargetControl {...props} />
  </QueryClientProvider>
);
const paint = () =>
  act(async () => {
    root.render(tree());
    await tick();
  });
const replace = (update: () => void) =>
  act(async () => {
    update();
    flushSync(() => root.render(tree()));
    expect(host.textContent).not.toContain(m.library_following());
    await tick();
  });
const settle = <T,>(call: ReturnType<typeof deferred<T>>, value: T) =>
  act(async () => {
    call.resolve(value);
    await tick();
  });
const button = (label: string) => {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent === label);
  expect(found).toBeDefined();
  return found!;
};
const click = (label: string, twice = false) =>
  act(async () => {
    const node = button(label);
    node.click();
    if (twice) node.click();
    await tick();
  });
function preparedSession() {
  const current = { subject: 'bob', token: 'bob-token', status: 'active', calls: 0 };
  const env: Partial<SessionEnv> = {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          current.calls++;
          return {
            status: current.status,
            subject: current.subject,
            accessToken: current.token,
            csrfToken: 'A'.repeat(22),
          };
        },
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
  const request = new Request('https://site.test/action', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  return { current, env, request };
}

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  actualRead = undefined;
  admitted = ['follow.get', 'follow.put', 'follow.delete'];
  props = { targetId: firstTarget, idempotencyKey: firstKey };
  setLocale('en', { reload: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
});
afterAll(async () => {
  setLocale(previousLocale, { reload: false });
  host.remove();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});

test('actual preparation binds false edges to its viewer and exact target with one BASIC GET and no hydration', async () => {
  const { current, env, request } = preparedSession();
  const calls: Request[] = [];
  let response = () => Response.json({ code: 'not_found' }, { status: 404 });
  const native = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return response();
    },
  });
  expect(await loadCurrentFollowState(native, request, env, firstTarget)).toEqual(page(firstTarget, false, 'bob'));
  expect(current.calls).toBe(1);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer bob-token');
  expect(new URL(calls[0]!.url).pathname).toBe(`/v1/follows/${firstTarget}`);
  expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({ view: 'BASIC' });
  expect(calls[0]!.cache).toBe('no-store');
  expect(calls[0]!.redirect).toBe('manual');
  response = () => Response.json({ follow: { targetId: secondTarget, state: 'following' } });
  expect((await loadCurrentFollowState(native, request, env, firstTarget)).edge).toEqual({ state: 'unavailable' });
  expect(current.calls).toBe(2);

  // A prior successful WeakMap entry is not this preparation's identity or credential.
  await prepareSession(request, env);
  current.status = 'absent';
  const before = calls.length;
  expect((await loadCurrentFollowState(native, request, env, firstTarget)).subject).toBeNull();
  current.status = 'unavailable';
  expect((await loadCurrentFollowState(native, request, env, firstTarget)).edge.state).toBe('unavailable');
  current.status = 'active';
  current.subject = '';
  expect((await loadCurrentFollowState(native, request, env, firstTarget)).subject).toBeNull();
  expect(
    (
      await loadCurrentFollowState(
        native,
        new Request('https://site.test/action', {
          headers: { authorization: 'Bearer explicit-without-prepared-subject' },
        }),
        env,
        firstTarget,
      )
    ).subject,
  ).toBeNull();
  expect(
    (await loadCurrentFollowState(native, new Request('https://site.test/action'), env, firstTarget)).edge.state,
  ).toBe('signed-out');
  expect(calls).toHaveLength(before);
});

test('the mounted control rejects replacement credentials even for an actually absent edge', async () => {
  const { current, env, request } = preparedSession();
  const calls: Request[] = [];
  const native = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  actualRead = (targetId) => loadCurrentFollowState(native, request, env, targetId);
  await paint();
  expect(calls).toHaveLength(1);
  expect(host.textContent).toContain(m.library_follow_unavailable());
  expect([...host.querySelectorAll('button')].some((node) => node.textContent === m.library_follow())).toBe(false);
  expect(client.getQueryData(followStateQuery('alice', firstTarget).queryKey)).toBeUndefined();
  await click(m.library_follow_unfollow());
  await settle(writes[0]!, { ok: true, following: false });
  expect(client.getQueryData(followStateQuery('alice', firstTarget).queryKey)).toBeUndefined();
  expect(host.textContent).toContain(m.library_follow_unavailable());
  await replace(() => client.setQueryData(sessionQuery.queryKey, viewer('bob')));
  expect(calls).toHaveLength(2);
  expect(current.calls).toBe(2);
  expect(button(m.library_follow()).disabled).toBe(false);
});

test('read admission ABA retires accepted data and old result/error/finally without blocking a fresh read', async () => {
  client.setQueryData(followStateQuery('alice', firstTarget).queryKey, { state: 'ready', following: true });
  await paint();
  expect(reads).toHaveLength(1);
  expect(host.textContent).not.toContain(m.library_following());
  await settle(reads[0]!, page());
  expect(host.textContent).toContain(m.library_following());
  await replace(() => {
    admitted = ['follow.delete'];
  });
  expect(button(m.library_follow_unfollow()).disabled).toBe(false);
  await replace(() => {
    admitted = ['follow.get', 'follow.put', 'follow.delete'];
  });
  expect(reads).toHaveLength(2);
  await replace(() => {
    admitted = ['follow.delete'];
  });
  await replace(() => {
    admitted = ['follow.get', 'follow.put', 'follow.delete'];
  });
  expect(reads).toHaveLength(3);
  await settle(reads[2]!, page(firstTarget, false));
  expect(button(m.library_follow()).disabled).toBe(false);
  await act(async () => {
    reads[1]!.reject(new Error('retired read failed'));
    await tick();
  });
  expect(button(m.library_follow()).disabled).toBe(false);
  expect(host.textContent).not.toContain(m.library_follow_unavailable());
  await replace(() => {
    admitted = ['follow.delete'];
  });
  await replace(() => {
    admitted = ['follow.get', 'follow.put', 'follow.delete'];
  });
  await settle(reads[3]!, { subject: 'alice', targetId: firstTarget, edge: { state: 'unavailable' } });
  await click(m.library_follow_retry(), true);
  expect(reads).toHaveLength(5);
  expect(host.textContent).toContain(m.library_follow_loading());
  await settle(reads[4]!, page(firstTarget, false));
  expect(button(m.library_follow()).disabled).toBe(false);
});

test('The complete target follow edge read and action workflow accepts only actual current viewer target and admission lifetimes without reviving retired private edge state', async () => {
  await paint();
  await replace(() => client.setQueryData(sessionQuery.queryKey, viewer('bob')));
  await settle(reads[1]!, page(firstTarget, false, 'bob'));
  expect(button(m.library_follow()).disabled).toBe(false);
  await replace(() => client.setQueryData(sessionQuery.queryKey, viewer()));
  expect(reads).toHaveLength(3);
  await settle(reads[0]!, page());
  expect(host.textContent).not.toContain(m.library_following());
  await replace(() => {
    props = { ...props, targetId: secondTarget };
  });
  await settle(reads[3]!, page(secondTarget, false));
  expect(button(m.library_follow()).disabled).toBe(false);
  await replace(() => {
    props = { ...props, targetId: firstTarget };
  });
  expect(reads).toHaveLength(5);
  await settle(reads[2]!, page());
  expect(host.textContent).not.toContain(m.library_following());
  await settle(reads[4]!, page(firstTarget, false));
  expect(button(m.library_follow()).disabled).toBe(false);
  expect(reads.map((call) => call.targetId)).toEqual([
    firstTarget,
    firstTarget,
    firstTarget,
    secondTarget,
    firstTarget,
  ]);
});

test('closed or revoked read admission retains independently admitted DELETE and never reconciles into a replacement read', async () => {
  await paint();
  await settle(reads[0]!, { subject: 'alice', targetId: firstTarget, edge: { state: 'closed' } });
  expect(button(m.library_follow_unfollow()).disabled).toBe(false);
  await click(m.library_follow_unfollow(), true);
  expect(writes).toHaveLength(1);
  await replace(() => {
    admitted = ['follow.delete'];
  });
  expect(button(m.library_follow_unfollow()).disabled).toBe(true);
  await replace(() => {
    admitted = ['follow.get', 'follow.delete'];
  });
  expect(reads).toHaveLength(2);
  await settle(writes[0]!, { ok: true, following: false });
  expect(client.getQueryData(followStateQuery('alice', firstTarget).queryKey)).toBeUndefined();
  expect(host.textContent).not.toContain(m.library_following());
  await settle(reads[1]!, page());
  expect(button(m.library_follow_unfollow()).disabled).toBe(false);
  await click(m.library_follow_unfollow());
  await settle(writes[1]!, { ok: true, following: false });
  expect(client.getQueryData(followStateQuery('alice', firstTarget).queryKey)).toEqual({
    state: 'ready',
    following: false,
  });
  expect(writes.every((call) => call.input.following === false)).toBe(true);
});

test('supplied edges do no reads and uncertain retry retains exact intent through CSRF and callback refresh', async () => {
  let oldRemoved = 0;
  let currentRemoved = 0;
  props = { ...props, following: true, onRemoved: () => oldRemoved++ };
  await paint();
  await click(m.library_follow_unfollow(), true);
  const first = writes[0]!;
  props = { ...props, following: false, idempotencyKey: secondKey, onRemoved: () => currentRemoved++ };
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('alice', 'csrf-two'));
    root.render(tree());
    await tick();
  });
  await act(async () => {
    first.reject(new Error('response lost'));
    await tick();
  });
  expect(writes).toHaveLength(1);
  await click(m.library_follow_unfollow());
  expect(writes[1]!.input).toBe(first.input);
  expect(writes[1]!.input).toEqual({ targetId: firstTarget, following: false, idempotencyKey: firstKey });
  expect(writes[1]!.csrfToken).toBe('csrf-two');
  await settle(writes[1]!, { ok: true, following: false });
  expect(oldRemoved).toBe(0);
  expect(currentRemoved).toBe(1);
  expect(reads).toHaveLength(0);
  expect(client.getQueryData(followStateQuery('alice', firstTarget).queryKey)).toEqual({
    state: 'ready',
    following: false,
  });
});

test('a ready conflict requires deliberate current own-edge review and a separate fresh action', async () => {
  await paint();
  await settle(reads[0]!, page(firstTarget, false));
  await click(m.library_follow());
  await settle(writes[0]!, { ok: false, reason: 'conflict' });
  expect(button(m.library_follow()).disabled).toBe(true);
  await click(m.library_follow_conflict_recovery_review(), true);
  expect(reads).toHaveLength(2);
  await settle(reads[1]!, { ...page(), edge: { state: 'unavailable' } });
  expect(writes).toHaveLength(1);
  expect(host.textContent).toContain(m.library_follow_conflict_recovery_unavailable());
  await act(async () => client.setQueryData(sessionQuery.queryKey, viewer('alice', null)));
  await click(m.library_follow_conflict_recovery_review());
  await settle(reads[2]!, page(firstTarget, false));
  expect(button(m.library_follow()).disabled).toBe(true);
  expect(writes).toHaveLength(1);
  await act(async () => client.setQueryData(sessionQuery.queryKey, viewer('alice', 'csrf-two')));
  await click(m.library_follow());
  expect(writes[1]!.input.idempotencyKey).not.toBe(firstKey);
  expect(writes[1]!.csrfToken).toBe('csrf-two');
  await settle(writes[1]!, { ok: true, following: true });
});

test('read recovery never renews an uncertain command or replaces its original credential', async () => {
  await paint();
  await settle(reads[0]!, page(firstTarget, false));
  await click(m.library_follow());
  const original = writes[0]!;
  await settle(original, { ok: false, reason: 'unavailable' });
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('alice', 'csrf-two'));
    void client.refetchQueries({ queryKey: ['follow-state'] });
    await tick();
  });
  await settle(reads[1]!, page());
  await click(m.library_follow());
  expect(writes[1]!.input).toBe(original.input);
  expect(writes[1]!.csrfToken).toBe(original.csrfToken);
  await settle(writes[1]!, { ok: true, following: true });
});

test('a delete-only supplied edge can prepare a new removal after conflict without reading a hidden target', async () => {
  admitted = ['follow.delete'];
  let removed = 0;
  props = { ...props, following: true, onRemoved: () => removed++ };
  await paint();
  await click(m.library_follow_unfollow());
  await settle(writes[0]!, { ok: false, reason: 'conflict' });
  await click(m.library_follow_conflict_recovery_remove());
  expect(writes).toHaveLength(1);
  expect(removed).toBe(0);
  await click(m.library_follow_unfollow());
  expect(writes[1]!.input.following).toBe(false);
  expect(writes[1]!.input.idempotencyKey).not.toBe(firstKey);
  await settle(writes[1]!, { ok: true, following: false });
  expect(removed).toBe(1);
  expect(reads).toHaveLength(0);
});

test('revoking a pending review immediately leaves independent removal available and retires its late result', async () => {
  await paint();
  await settle(reads[0]!, page(firstTarget, false));
  await click(m.library_follow());
  await settle(writes[0]!, { ok: false, reason: 'conflict' });
  await click(m.library_follow_conflict_recovery_review());
  await replace(() => {
    admitted = ['follow.delete'];
  });
  await click(m.library_follow_conflict_recovery_remove());
  expect(button(m.library_follow_unfollow()).disabled).toBe(false);
  await settle(reads[1]!, page());
  expect(host.textContent).not.toContain(m.library_following());
  expect(writes).toHaveLength(1);
  await click(m.library_follow_unfollow());
  expect(writes[1]!.input.following).toBe(false);
  expect(writes[1]!.input.idempotencyKey).not.toBe(firstKey);
  await settle(writes[1]!, { ok: true, following: false });
});
