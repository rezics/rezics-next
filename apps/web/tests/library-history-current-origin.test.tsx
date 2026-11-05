import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, startTransition, Suspense, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';
import type { MineFollowingRead } from '../src/library/mine-following-actions';
import type { MyLogsViewerHistory } from '../src/library/logs-server';
import type { CurrentFollowState, FollowWriteInput, FollowWriteResult } from '../src/library/follow-records';
import { PrivateDiaryWindowNavigation } from '../src/library/private-diary/window-navigation';

// UNRUN: bounded composed regressions for integration. Controlled transport completion is not
// native authorization, browser, cost or whole-Goal proof. Existing server/provenance tests remain intact.
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
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  KeyboardEvent: window.KeyboardEvent,
  PointerEvent: window.PointerEvent,
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
const follows: (ReturnType<typeof deferred<MineFollowingRead>> & { cursor: string | null })[] = [];
const logs: (ReturnType<typeof deferred<MyLogsViewerHistory>> & { cursor: string | null })[] = [];
const edges: (ReturnType<typeof deferred<CurrentFollowState>> & { targetId: string })[] = [];
const writes: (ReturnType<typeof deferred<FollowWriteResult>> & { input: FollowWriteInput; csrf: string })[] = [];
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/library/mine-following-actions', () => ({
  readMineFollowingForViewer: ({ data }: { data: { cursor?: string } }) => {
    const call = { ...deferred<MineFollowingRead>(), cursor: data.cursor ?? null };
    follows.push(call);
    return call.promise;
  },
}));
mock.module('../src/library/logs-server', () => ({
  readMyPublishedLogHistoryForViewer: ({ data }: { data: { cursor?: string } }) => {
    const call = { ...deferred<MyLogsViewerHistory>(), cursor: data.cursor ?? null };
    logs.push(call);
    return call.promise;
  },
}));
mock.module('../src/library/follow-actions', () => ({
  readFollowState: () => {
    throw new Error('Production must use the same-reader viewer envelope');
  },
  readCurrentFollowState: ({ data }: { data: { targetId: string } }) => {
    const call = { ...deferred<CurrentFollowState>(), targetId: data.targetId };
    edges.push(call);
    return call.promise;
  },
  setFollow: ({ data, headers }: { data: FollowWriteInput; headers: Record<string, string> }) => {
    const call = { ...deferred<FollowWriteResult>(), input: data, csrf: headers['X-CSRF-Token']! };
    writes.push(call);
    return call.promise;
  },
}));
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { CurrentViewerMineFollowingPage } = await import('../src/library/mine-following-page');
const { MyLogsCurrentViewer } = await import('../src/library/my-logs-page');
const { FollowTargetControl, followStateQuery } = await import('../src/library/follow-target-control');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');
const { m } = await import('../src/paraglide/messages.js');
const previousLocale = getLocale();
const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
const viewer = (subject: string, csrfToken = `${subject}-csrf`) => ({ state: 'signed-in', subject, csrfToken });
const key = '123e4567-e89b-42d3-a456-426614174000';
const targetId = 'stored-original';
function following(subject: string, cursor: string | null = null, empty = false): MineFollowingRead {
  return {
    subject,
    cursor,
    locale: 'en',
    page: {
      signedIn: true,
      next: null,
      follows: empty
        ? []
        : [
            {
              targetId,
              targetType: 'subject',
              state: 'following',
              reason: 'library',
              idempotencyKey: key,
              target: {
                id: 'canonical-destination',
                label: `${subject} history`,
                types: ['Book'],
                typeLabel: 'Book',
                cover: null,
              },
            },
          ],
    },
  };
}
function history(subject: string, cursor: string | null = null, empty = false): MyLogsViewerHistory {
  return {
    sessionSubject: subject,
    cursor,
    locale: 'en',
    page: {
      state: 'loaded',
      restarted: false,
      next: null,
      logs: empty
        ? []
        : [
            {
              id: `${subject}/public+snapshot`,
              account: null,
              subject: { id: targetId, label: `${subject} history`, types: ['Book'], cover: null },
              sessionState: 'completed',
              publishedAt: '2026-10-30T09:00:00Z',
              startedAt: '2026-10-29T09:00:00Z',
              completedAt: '2026-10-30T08:00:00Z',
              note: 'Immutable published snapshot',
            },
          ],
    },
  };
}
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let client: InstanceType<typeof QueryClient>;
let root: ReturnType<typeof createRoot>;
const tree = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
const paint = (node: ReactNode) =>
  act(async () => {
    root.render(tree(node));
    await tick();
  });
const settle = <T,>(call: ReturnType<typeof deferred<T>>, value: T) =>
  act(async () => {
    call.resolve(value);
    await tick();
  });
const button = (label: string) => {
  const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
  expect(node).toBeDefined();
  return node!;
};
// Retain the installed button's actual caller, rather than replacing its presenter or transport guard.
function retainedClick(node: HTMLButtonElement) {
  const propsKey = Object.keys(node).find((name) => name.startsWith('__reactProps'))!;
  const props = (node as unknown as Record<string, { onClick: () => void }>)[propsKey]!;
  return props.onClick;
}
const never = new Promise<never>(() => {});
function Pause({ active }: { active: boolean }) {
  if (active) throw never;
  return null;
}

beforeEach(() => {
  follows.length = logs.length = edges.length = writes.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, viewer('A'));
  client.setQueryData(exposureQuery.queryKey, ['personal_library', 'reading_progress', 'collections']);
  client.setQueryData(['exposure', 'anonymous'], ['reading_progress']);
  setLocale('en', { reload: false });
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
  for (const [name, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  mock.restore();
});

for (const kind of ['following', 'logs'] as const) {
  test(`${kind}: actual cache retirement before commit fences first/empty/refresh/retry/removal while B remains usable`, async () => {
    const initialFollowing = following('A');
    let initialLogs = history('A');
    const page = () =>
      kind === 'following' ? (
        <CurrentViewerMineFollowingPage initial={initialFollowing} />
      ) : (
        <MyLogsCurrentViewer initial={initialLogs} />
      );
    await paint(page());
    expect(host.textContent).toContain('A history');
    const firstA = kind === 'following' ? follows.at(-1)! : logs.at(-1)!;
    if (kind === 'following') {
      const user = userEvent.setup({ document: window.document });
      const trigger = host.querySelector<HTMLButtonElement>('[data-slot="follow-control"] button')!;
      await act(async () => {
        await user.click(trigger);
        await tick();
      });
      const remove = window.document.querySelector<HTMLElement>('[role="menuitem"]')!;
      await act(async () => {
        await user.click(remove);
        await tick();
      });
      expect(writes[0]!.input).toEqual({ targetId, following: false, idempotencyKey: key });
      expect(edges).toHaveLength(0); // The supplied row is the actual own edge; no second native read.
    }
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('B'));
      await tick();
    });
    const b = kind === 'following' ? follows.at(-1)! : logs.at(-1)!;
    expect(b).not.toBe(firstA);
    expect(host.textContent).not.toContain('A history');
    if (kind === 'following') await settle(follows.at(-1)!, following('B'));
    else await settle(logs.at(-1)!, history('B'));
    expect(host.textContent).toContain('B history');
    if (kind === 'following') {
      expect(host.querySelector('li a')?.getAttribute('href')).toBe(
        subjectHref({ id: 'canonical-destination', label: 'B history' }, 'en').href,
      );
      await settle(firstA as (typeof follows)[number], following('A', null, true));
      await settle(writes[0]!, { ok: true, following: false });
    } else {
      expect(host.querySelector('ol a')?.getAttribute('href')).toBe('/en/logs/B%2Fpublic%2Bsnapshot');
      expect(host.textContent).toContain('Immutable published snapshot');
      await settle(firstA as (typeof logs)[number], history('A', null, true));
    }
    expect(host.textContent).toContain('B history');
    const prefix = kind === 'following' ? ['mine-following'] : ['my-logs-current-viewer'];
    await act(async () => {
      void client.refetchQueries({ queryKey: prefix, type: 'active' });
      await tick();
    });
    await act(async () => {
      (kind === 'following' ? follows.at(-1)! : logs.at(-1)!).reject(new Error('Explicit retry required'));
      await tick();
    });
    const retry = retainedClick(button(m.library_follow_retry()));
    const count = follows.length + logs.length;
    // The UI is still B here. Cache notifications observe both the denial and readmission synchronously.
    await act(async () => {
      client.setQueryData(exposureQuery.queryKey, []);
      client.setQueryData(exposureQuery.queryKey, ['personal_library', 'reading_progress', 'collections']);
      retry();
      expect(follows.length + logs.length).toBe(count);
      await tick();
    });
    expect(host.textContent).not.toContain('B history');
    const fresh = kind === 'following' ? follows.at(-1)! : logs.at(-1)!;
    expect(follows.length + logs.length).toBe(count + 1);
    // Empty success has the same strict owner/address/locale provenance as a nonempty result.
    if (kind === 'following') await settle(fresh as (typeof follows)[number], following('A', null, true));
    else await settle(fresh as (typeof logs)[number], history('A', null, true));
    expect(host.textContent).not.toContain(kind === 'following' ? m.library_following_empty() : m.library_logs_empty());
    await act(async () => {
      button(m.library_follow_retry()).click();
      await tick();
    });
    if (kind === 'following') await settle(follows.at(-1)!, { ...following('B', null, true), locale: 'ja' });
    else await settle(logs.at(-1)!, { ...history('B', null, true), cursor: 'wrong-address' });
    expect(host.textContent).not.toContain(kind === 'following' ? m.library_following_empty() : m.library_logs_empty());
    await act(async () => {
      button(m.library_follow_retry()).click();
      await tick();
    });
    if (kind === 'following') await settle(follows.at(-1)!, following('B', null, true));
    else await settle(logs.at(-1)!, history('B', null, true));
    expect(host.textContent).toContain(kind === 'following' ? m.library_following_empty() : m.library_logs_empty());
    await act(async () => {
      void client.refetchQueries({ queryKey: prefix, type: 'active' });
      await tick();
    });
    await act(async () => {
      (kind === 'following' ? follows.at(-1)! : logs.at(-1)!).reject(new Error('Retain viewer retry'));
      await tick();
    });
    const viewerRetry = retainedClick(button(m.library_follow_retry()));
    const beforeViewerABA = follows.length + logs.length;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('A'));
      client.setQueryData(sessionQuery.queryKey, viewer('B'));
      viewerRetry();
      expect(follows.length + logs.length).toBe(beforeViewerABA);
      await tick();
    });
    expect(follows.length + logs.length).toBe(beforeViewerABA + 1);
    expect(host.textContent).not.toContain(kind === 'following' ? m.library_following_empty() : m.library_logs_empty());
    if (kind === 'following') await settle(follows.at(-1)!, following('B', null, true));
    else await settle(logs.at(-1)!, history('B', null, true));
    if (kind === 'logs') {
      initialLogs = structuredClone(initialLogs);
      await paint(page()); // Loader refresh may refetch, never stamp its retained A payload as viewer B.
      const refresh = logs.at(-1)!;
      await act(async () => {
        client
          .getQueryCache()
          .find({ queryKey: sessionQuery.queryKey })!
          .setState({ status: 'error', error: new Error('Session failed') });
        client.setQueryData(sessionQuery.queryKey, viewer('B'));
        await tick();
      });
      await settle(refresh, history('B'));
      expect(host.textContent).not.toContain('B history');
      await settle(logs.at(-1)!, history('B'));
      expect(host.textContent).toContain('B history');
    }
  });
}

test('observed suspended address/target ABA cannot revive retained callers or populate the replacement cache', async () => {
  for (const kind of ['following', 'logs'] as const) {
    const initialLogs = history('A', null, true);
    const initialFollowing = following('A', null, true);
    const calls = kind === 'following' ? follows : logs;
    const complete = (call: (typeof calls)[number]) =>
      kind === 'following'
        ? settle(call as (typeof follows)[number], following('A'))
        : settle(call as (typeof logs)[number], history('A'));
    const emptyLabel = kind === 'following' ? m.library_following_empty() : m.library_logs_empty();
    const page = (cursor: string | undefined, paused = false) => (
      <Suspense fallback={<p>Pending navigation</p>}>
        {kind === 'following' ? (
          <CurrentViewerMineFollowingPage initial={initialFollowing} cursor={cursor} />
        ) : (
          <MyLogsCurrentViewer initial={initialLogs} cursor={cursor} />
        )}
        <Pause active={paused} />
      </Suspense>
    );
    await paint(page(undefined));
    await act(async () => {
      calls.at(-1)!.reject(new Error('Retry'));
      await tick();
    });
    const retry = retainedClick(button(m.library_follow_retry()));
    await act(async () => {
      retry();
      await tick();
    });
    const old = calls.at(-1)!;
    const count = calls.length;
    await act(async () => {
      startTransition(() => root.render(tree(page('next+/address=', true))));
      await tick();
    });
    await act(async () => {
      retry();
      expect(calls).toHaveLength(count);
    });
    await paint(page(undefined));
    expect(calls).toHaveLength(count + 1);
    expect(host.textContent).not.toContain(emptyLabel); // Retained empty loader cannot seed the ABA return.
    await complete(old);
    expect(host.textContent).not.toContain('A history');
    await complete(calls.at(-1)!);
    expect(host.textContent).toContain('A history');
    const beforeLocale = calls.length;
    await act(async () => {
      setLocale('ja', { reload: false });
      startTransition(() => root.render(tree(page(undefined, true))));
      await tick();
    });
    setLocale('en', { reload: false });
    await paint(page(undefined));
    expect(calls).toHaveLength(beforeLocale + 1);
    expect(host.textContent).not.toContain('A history');
    await complete(calls.at(-1)!);
  }

  const target = (id: string, paused = false) => (
    <Suspense fallback={<p>Pending target</p>}>
      <FollowTargetControl targetId={id} idempotencyKey={key} />
      <Pause active={paused} />
    </Suspense>
  );
  await paint(target(targetId));
  const oldEdge = edges.at(-1)!;
  await act(async () => {
    button(m.library_follow_unfollow()).click();
    await tick();
  });
  const oldWrite = writes.at(-1)!;
  await act(async () => {
    startTransition(() => root.render(tree(target('other-target', true))));
    await tick();
  });
  await paint(target(targetId));
  const freshEdge = edges.at(-1)!;
  expect(freshEdge).not.toBe(oldEdge);
  await settle(oldEdge, { subject: 'A', targetId, edge: { state: 'ready', following: true } });
  await settle(oldWrite, { ok: true, following: false });
  expect(client.getQueryData(followStateQuery('A', targetId).queryKey)).toBeUndefined();
  await settle(freshEdge, { subject: 'A', targetId, edge: { state: 'ready', following: true } });
  expect(host.textContent).toContain(m.library_following());
});

test('private diary predecessor state is bounded and retires on equal admission replacement and A/B/A source changes', () => {
  const navigation = new PrivateDiaryWindowNavigation('A');
  let address = { year: 2020 };
  let load = {};
  navigation.observe({ source: 'A', address, admitted: true, continuation: 'slot-A', load });
  for (let index = 1; index <= 10; index += 1) {
    const target = { year: 2020, cursor: `opaque-${index}` };
    expect(navigation.stage('next', target, false)).toBe(true);
    load = {};
    navigation.observe({ source: 'A', address: target, admitted: true, continuation: 'slot-A', load });
    address = target;
  }
  expect(navigation.predecessors).toHaveLength(8);
  expect(navigation.previousAddress()).toMatchObject({ cursor: 'opaque-9' });

  navigation.observe({ source: 'A', address, admitted: true, continuation: 'slot-A', load: {} });
  expect(navigation.previousAddress()).toBeNull();
  navigation.observe({ source: 'B', address, admitted: true, continuation: 'slot-B', load: {} });
  expect(navigation.previousAddress()).toBeNull();
  navigation.observe({ source: 'A', address, admitted: true, continuation: 'slot-A2', load: {} });
  expect(navigation.previousAddress()).toBeNull();
});

test('directional deletion survives denied reads and create loss, while cache ABA retires removal and healthy rotation preserves exact uncertain intent', async () => {
  let removedA = 0;
  let removedB = 0;
  await paint(<FollowTargetControl targetId={targetId} idempotencyKey={key} />);
  await settle(edges.at(-1)!, { subject: 'A', targetId, edge: { state: 'forbidden' } });
  await act(async () => {
    button(m.library_follow_unfollow()).click();
    await tick();
  });
  const a = writes.at(-1)!;
  expect(a.input).toEqual({ targetId, following: false, idempotencyKey: key });
  await act(async () => {
    // Exact operation admission is supplied by the shared exposure primitive. GET/PUT
    // retirement must not cancel this independently admitted DELETE or its completion.
    client.setQueryData(exposureQuery.queryKey, ['follow.delete']);
    await tick();
  });
  expect(host.querySelector('[data-slot="follow-control"]')?.getAttribute('aria-busy')).toBe('true');
  await settle(a, { ok: false, reason: 'unavailable' });
  // A permitted supplied removal uses no read/create; the callbacks belong to their original rows.
  await paint(<FollowTargetControl targetId={targetId} following onRemoved={() => removedA++} idempotencyKey={key} />);
  await act(async () => {
    button(m.library_follow_unfollow()).click();
    await tick();
  });
  const suppliedA = writes.at(-1)!;
  const retained = retainedClick(button(m.library_follow_unfollow()));
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('B'));
    retained();
    expect(writes).toHaveLength(2);
    await tick();
  });
  await paint(<FollowTargetControl targetId={targetId} following onRemoved={() => removedB++} idempotencyKey={key} />);
  await act(async () => {
    button(m.library_follow_unfollow()).click();
    await tick();
  });
  const b = writes.at(-1)!;
  expect(b).not.toBe(suppliedA); // B is usable while the old mutation is unresolved.
  await settle(suppliedA, { ok: true, following: false });
  expect(removedA).toBe(0);
  expect(removedB).toBe(0);
  await settle(b, { ok: false, reason: 'unavailable' });
  await paint(
    <FollowTargetControl
      targetId={targetId}
      following={false}
      onRemoved={() => removedB++}
      idempotencyKey={crypto.randomUUID()}
    />,
  );
  const retry = retainedClick(button(m.library_follow_unfollow()));
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('B', 'rotated-current-token'));
    retry(); // Invoke before a React commit: the credential must come from the actual cache.
    await tick();
  });
  expect(writes.at(-1)!.input).toEqual(b.input);
  expect(writes.at(-1)!.csrf).toBe('rotated-current-token');
  await settle(writes.at(-1)!, { ok: true, following: false });
  expect(removedB).toBe(1);
  expect(removedA).toBe(0);
  await paint(<FollowTargetControl targetId={targetId} following idempotencyKey={crypto.randomUUID()} />);
  const beforeABA = retainedClick(button(m.library_follow_unfollow()));
  const count = writes.length;
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    client.setQueryData(sessionQuery.queryKey, viewer('B'));
    beforeABA();
    expect(writes).toHaveLength(count);
    await tick();
  });
  await act(async () => {
    button(m.library_follow_unfollow()).click();
    await tick();
  });
  expect(writes).toHaveLength(count + 1);
  await settle(writes.at(-1)!, { ok: false, reason: 'conflict' });
  expect(button(m.library_follow_unfollow()).disabled).toBe(true);
  expect(host.textContent).toContain(m.library_follow_conflict());
});
