import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { FollowControlProps } from '../src/library/follow-control';
import type { FollowState, FollowWriteInput, FollowWriteResult } from '../src/library/follow-records';

// Mounted regressions for integration. Puck's installed DOM is reused without new dependencies.
// These controlled transports do not prove native authorization or browser/session integration.
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
const reads: (ReturnType<typeof deferred<FollowState>> & { targetId: string })[] = [];
const writes: (ReturnType<typeof deferred<FollowWriteResult>> & { input: FollowWriteInput; csrfToken: string })[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/follow-actions', () => ({
  readCurrentFollowState: ({ data }: { data: { targetId: string } }) => {
    const subject = client.getQueryData<{ subject: string | null }>(sessionQuery.queryKey)?.subject ?? null;
    const call = { ...deferred<FollowState>(), targetId: data.targetId };
    reads.push(call);
    return call.promise.then((edge) => ({
      subject,
      targetId: data.targetId,
      edge,
    }));
  },
  readFollowState: ({ data }: { data: { targetId: string } }) => {
    const call = { ...deferred<FollowState>(), targetId: data.targetId };
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
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const viewerExposure = await import('../src/kernel/viewer-exposure');
const { FollowTargetControl, followStateQuery } = await import('../src/library/follow-target-control');
const { FollowControl } = await import('../src/library/follow-control');
const { m } = await import('../src/paraglide/messages.js');

const firstTarget = 'target-one';
const secondTarget = 'target-two';
const firstKey = '123e4567-e89b-42d3-a456-426614174000';
const secondKey = '123e4567-e89b-42d3-a456-426614174001';
type Viewer = { state: 'unknown' | 'signed-in' | 'signed-out'; subject: string | null; csrfToken: string | null };
const viewer = (subject = 'viewer-one', csrfToken = 'csrf-one'): Viewer => ({ state: 'signed-in', subject, csrfToken });
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
spyOn(viewerExposure, 'readViewerExposure').mockImplementation(async ({ data }) => ({
  subject: data,
  admitted: client.getQueryData<string[]>(exposureQuery.queryKey) ?? [],
}));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const paint = (node: ReactNode, session?: Viewer) =>
  act(async () => {
    if (session) client.setQueryData(sessionQuery.queryKey, session);
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    await tick();
  });
type TargetProps = ComponentProps<typeof FollowTargetControl>;
const target = (props: Partial<TargetProps> = {}, session?: Viewer) =>
  paint(<FollowTargetControl targetId={firstTarget} following={true} idempotencyKey={firstKey} {...props} />, session);
const control = (props: Partial<FollowControlProps> = {}) =>
  paint(
    <FollowControl
      targetId={firstTarget}
      initial={{ state: 'ready', following: true }}
      ready={true}
      canFollow={true}
      canRemove={true}
      idempotencyKey={firstKey}
      write={(input) => {
        const call = { ...deferred<FollowWriteResult>(), input, csrfToken: 'presenter' };
        writes.push(call);
        return call.promise;
      }}
      {...props}
    />,
  );
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
  });
const settle = <T,>(call: ReturnType<typeof deferred<T>>, value: T) =>
  act(async () => {
    call.resolve(value);
    await tick();
  });
const cached = (subject = 'viewer-one', targetId = firstTarget) =>
  client.getQueryData(followStateQuery(subject, targetId).queryKey);
const observedCache = (subject: string, targetId = firstTarget) =>
  client
    .getQueriesData<FollowState>({ queryKey: ['follow-state', subject, targetId] })
    .map(([, value]) => value)
    .filter((value): value is FollowState => value !== undefined);
const setCurrentExposure = (admitted: string[]) =>
  act(async () => {
    const snapshot = viewerExposure.viewerExposureLifetime(client).getSnapshot();
    if (snapshot.state !== 'signed-in') throw new Error('Expected a current signed-in exposure observation');
    client.setQueryData(viewerExposure.viewerExposureQuery(snapshot.observation).queryKey, {
      subject: snapshot.observation.subject,
      admitted,
    });
    await tick();
  });

beforeEach(() => {
  reads.length = 0;
  writes.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer());
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
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

test('Follow state and pending mutation completions cannot cross observed viewer or target replacement', async () => {
  await target({ following: undefined });
  expect(reads).toHaveLength(1);
  expect(host.textContent).toContain(m.library_follow_loading());
  const oldViewerRead = reads[0]!;
  await target({ following: undefined }, viewer('viewer-two'));
  expect(reads).toHaveLength(2);
  await settle(oldViewerRead, { state: 'ready', following: true });
  expect(observedCache('viewer-two')).toEqual([]);
  expect(host.textContent).not.toContain(m.library_following());
  await settle(reads[1]!, { state: 'ready', following: false });
  expect(button(m.library_follow()).disabled).toBe(false);
  expect(observedCache('viewer-two')).toEqual([{ state: 'ready', following: false }]);

  await target({ targetId: secondTarget, following: undefined });
  const oldTargetRead = reads[2]!;
  await target({ targetId: 'target-three', following: undefined });
  expect(reads).toHaveLength(4);
  await settle(oldTargetRead, { state: 'ready', following: true });
  expect(observedCache('viewer-two', 'target-three')).toEqual([]);
  expect(host.textContent).not.toContain(m.library_following());
  await paint(null);
  await settle(reads[3]!, { state: 'ready', following: true });
  expect(observedCache('viewer-two', 'target-three')).toEqual([]);
  expect(reads.map((call) => call.targetId)).toEqual([firstTarget, firstTarget, secondTarget, 'target-three']);
});

for (const boundary of ['viewer', 'target', 'unmount'] as const) {
  test(`Late removal after ${boundary} cannot seed a cache, remove a replacement row or clear its pending write`, async () => {
    let oldRemoved = 0;
    let nextRemoved = 0;
    await target({ onRemoved: () => oldRemoved++ });
    await click(m.library_follow_unfollow(), true);
    expect(writes).toHaveLength(1);
    const oldWrite = writes[0]!;
    if (boundary === 'unmount') await paint(null);
    else {
      await target(
        { targetId: boundary === 'target' ? secondTarget : firstTarget, onRemoved: () => nextRemoved++ },
        viewer(boundary === 'viewer' ? 'viewer-two' : 'viewer-one'),
      );
      expect(button(m.library_follow_unfollow()).disabled).toBe(false);
      await click(m.library_follow_unfollow());
    }
    await settle(oldWrite, { ok: true, following: false });
    expect(oldRemoved).toBe(0);
    expect(nextRemoved).toBe(0);
    expect(cached()).toBeUndefined();
    expect(cached('viewer-two')).toBeUndefined();
    expect(cached('viewer-one', secondTarget)).toBeUndefined();
    if (boundary !== 'unmount') {
      expect(host.querySelector('[data-slot="follow-control"]')!.getAttribute('aria-busy')).toBe('true');
      await settle(writes[1]!, { ok: true, following: false });
      expect(nextRemoved).toBe(1);
      expect(
        cached(boundary === 'viewer' ? 'viewer-two' : 'viewer-one', boundary === 'target' ? secondTarget : firstTarget),
      ).toEqual({ state: 'ready', following: false });
    }
  });
}

test('Unknown, signed-out, missing-subject and unadmitted viewers cannot dispatch; hydration enables healthy follow/remove', async () => {
  for (const session of [
    { state: 'unknown', subject: null, csrfToken: null },
    { state: 'signed-out', subject: null, csrfToken: null },
    { state: 'signed-in', subject: null, csrfToken: 'csrf' },
  ] satisfies Viewer[]) {
    await target({ following: false }, session);
    expect(host.querySelector('button')).toBeNull();
  }
  await act(async () => client.setQueryData(exposureQuery.queryKey, []));
  await target({ following: false }, viewer());
  expect(host.querySelector('button')).toBeNull();
  expect(writes).toHaveLength(0);
  await act(async () => client.setQueryData(exposureQuery.queryKey, ['personal_library']));
  await target({ following: false }, viewer('viewer-one', 'csrf-two'));
  await click(m.library_follow(), true);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.input.following).toBe(true);
  await settle(writes[0]!, { ok: true, following: true });
  expect(host.textContent).toContain(m.library_following());
  await click(m.library_follow_unfollow());
  await settle(writes[1]!, { ok: true, following: false });
  expect(cached()).toEqual({ state: 'ready', following: false });
  expect(reads).toHaveLength(0);

  let removed = 0;
  await control({ initial: { state: 'forbidden' }, canFollow: false, onChange: () => removed++ });
  await click(m.library_follow_unfollow());
  expect(writes[2]!.input).toEqual({ targetId: firstTarget, following: false, idempotencyKey: firstKey });
  await settle(writes[2]!, { ok: true, following: false });
  expect(removed).toBe(1);
  expect(reads).toHaveLength(0);
});

for (const loss of ['unknown', 'signed-out', 'csrf', 'admission'] as const) {
  test(`Observed ${loss} loss retires a pending callback before a session or admission can recover`, async () => {
    let removed = 0;
    const props = { onRemoved: () => removed++ };
    await target(props);
    await click(m.library_follow_unfollow());
    const oldWrite = writes[0]!;
    if (loss === 'admission') await setCurrentExposure([]);
    if (loss === 'admission') await target(props);
    else
      await target(
        props,
        loss === 'csrf' ? { ...viewer(), csrfToken: null } : { state: loss, subject: null, csrfToken: null },
      );
    expect(host.querySelector<HTMLButtonElement>('button')?.disabled ?? true).toBe(loss !== 'csrf');
    await target(props, viewer());
    await setCurrentExposure(['personal_library']);
    await click(m.library_follow_unfollow());
    expect(writes).toHaveLength(2);
    if (loss === 'csrf' || loss === 'admission') {
      expect(writes[1]!.input).toBe(oldWrite.input);
      expect(writes[1]!.csrfToken).toBe('csrf-one');
    }
    await settle(oldWrite, { ok: true, following: false });
    expect(removed).toBe(0);
    expect(cached()).toBeUndefined();
    expect(host.querySelector('[data-slot="follow-control"]')!.getAttribute('aria-busy')).toBe('true');
    await settle(writes[1]!, { ok: true, following: false });
    expect(removed).toBe(1);
  });
}

test('Rerenders, refreshed following, callbacks, supplied keys and nonempty CSRF rotation preserve uncertain intent', async () => {
  let oldRemoved = 0;
  let currentRemoved = 0;
  await target({ onRemoved: () => oldRemoved++ });
  await click(m.library_follow_unfollow(), true);
  const first = writes[0]!;
  const refreshed = { following: false, idempotencyKey: secondKey, onRemoved: () => currentRemoved++ };
  await target(refreshed, viewer('viewer-one', 'csrf-two'));
  expect(writes).toHaveLength(1);
  expect(button(m.library_follow_unfollow()).disabled).toBe(false);
  await act(async () => first.reject(new Error('Response lost')));
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.error_message());
  await target({ ...refreshed, onRemoved: () => currentRemoved++ });
  await click(m.library_follow_unfollow());
  expect(writes[1]!.input).toBe(first.input);
  expect(writes[1]!.csrfToken).toBe('csrf-one');
  await settle(writes[1]!, { ok: false, reason: 'unavailable' });
  await target({ ...refreshed, following: true }, viewer('viewer-one', 'csrf-three'));
  expect(writes).toHaveLength(2);
  await click(m.library_follow_unfollow());
  expect(writes[2]!.input).toBe(first.input);
  expect(writes[2]!.csrfToken).toBe('csrf-one');
  await settle(writes[2]!, { ok: true, following: false });
  expect(oldRemoved).toBe(0);
  expect(currentRemoved).toBe(1);
});

test('A missing initial CSRF token preserves the seeded request through an explicit rejected-command review', async () => {
  let reviews = 0;
  await target(
    { onReview: async () => (reviews++, { state: 'ready', following: true }) },
    { ...viewer(), csrfToken: null },
  );
  await click(m.library_follow_unfollow());
  expect(writes).toHaveLength(0);

  await target(
    {
      idempotencyKey: secondKey,
      onReview: async () => (reviews++, { state: 'ready', following: true }),
    },
    viewer('viewer-one', 'csrf-ready'),
  );
  await click(m.library_follow_unfollow());
  expect(writes).toHaveLength(1);
  const rejected = writes[0]!;
  expect(rejected.input).toEqual({ targetId: firstTarget, following: false, idempotencyKey: firstKey });
  expect(rejected.csrfToken).toBe('csrf-ready');
  await settle(rejected, { ok: false, reason: 'conflict' });

  await click(m.library_follow_conflict_recovery_review());
  expect(reviews).toBe(1);
  expect(host.textContent).toContain(m.library_follow_conflict_recovery_ready());
  await click(m.library_follow_unfollow());
  expect(writes).toHaveLength(2);
  expect(writes[1]!.input.targetId).toBe(firstTarget);
  expect(writes[1]!.input.following).toBe(false);
  expect(writes[1]!.input.idempotencyKey).not.toBe(firstKey);
  await settle(writes[1]!, { ok: true, following: false });
  expect(host.textContent).toContain(m.library_follow_removed());
});

test('The standalone presenter fences target changes, preserves independent remove admission and keeps conflict explicit', async () => {
  let oldChanged = 0;
  let nextChanged = 0;
  await control({ onChange: () => oldChanged++ });
  await click(m.library_follow_unfollow());
  await control({
    targetId: secondTarget,
    initial: { state: 'ready', following: false },
    onChange: () => nextChanged++,
  });
  await click(m.library_follow());
  await settle(writes[0]!, { ok: true, following: false });
  expect(oldChanged).toBe(0);
  expect(nextChanged).toBe(0);
  expect(button(m.library_follow()).disabled).toBe(true);
  await settle(writes[1]!, { ok: false, reason: 'conflict' });
  await control({ targetId: secondTarget, initial: { state: 'ready', following: true }, idempotencyKey: secondKey });
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.library_follow_conflict());
  expect(button(m.library_follow()).disabled).toBe(true);
  await click(m.library_follow());
  expect(writes).toHaveLength(2);

  await control({ targetId: 'delete-only', initial: { state: 'forbidden' }, canFollow: false });
  await click(m.library_follow_unfollow());
  await control({ targetId: 'delete-only', initial: { state: 'forbidden' }, canFollow: true });
  expect(button(m.library_follow_unfollow()).disabled).toBe(true);
  await settle(writes[2]!, { ok: true, following: false });
  expect(host.textContent).toContain(m.library_follow_removed());

  const followOnly = { targetId: 'follow-admission', initial: { state: 'ready', following: false } as const };
  await control({ ...followOnly, onChange: () => oldChanged++ });
  await click(m.library_follow());
  const retired = writes[3]!;
  await control({ ...followOnly, canFollow: false });
  expect(host.querySelector('button')).toBeNull();
  await control({ ...followOnly, idempotencyKey: secondKey, onChange: () => nextChanged++ });
  await click(m.library_follow());
  expect(writes[4]!.input).toBe(retired.input);
  await settle(retired, { ok: true, following: true });
  expect(oldChanged).toBe(0);
  expect(nextChanged).toBe(0);
  expect(button(m.library_follow()).disabled).toBe(true);
  await settle(writes[4]!, { ok: true, following: true });
  expect(nextChanged).toBe(1);
});
