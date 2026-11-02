import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import * as start from '../.storybook/react-start';
import type {
  ContainerLifecycleAdapter,
  ContainerTarget,
  LifecycleAction,
  LifecycleIntent,
  LifecycleRead,
  LifecycleResult,
  LifecycleSnapshot,
} from '../src/community/container-lifecycle';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const spaceTarget: ContainerTarget = { kind: 'space', id: '0192f3a0-6c1e-7b2a-9d4e-000000000001' };
const realmTarget: ContainerTarget = { kind: 'realm', id: '0192f3a0-6c1e-7b2a-9d4e-000000000002' };
const contextId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
const head = '0192f3a0-6c1e-7b2a-9d4e-000000000004';

const reads: Array<Deferred<LifecycleRead> & { data: { target: ContainerTarget; contextId?: string | null } }> = [];
const changes: Array<Deferred<LifecycleResult> & { data: LifecycleIntent; headers: Headers }> = [];
const destinations: Array<
  Deferred<
    { kind: 'available'; target: ContainerTarget; contextId: string | null; href: string } | { kind: 'unavailable' }
  > & {
    data: { target: ContainerTarget; contextId: string | null };
  }
> = [];
type Blocker = (attempt: { current: { pathname: string }; next: { pathname: string } }) => boolean | Promise<boolean>;
const departureBlockers: Blocker[] = [];

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-router', () => ({
  useBlocker: ({ shouldBlockFn }: { shouldBlockFn: Blocker }) => { departureBlockers.push(shouldBlockFn); },
  useRouter: () => ({}),
}));
mock.module('../src/community/space-actions', () => ({
  readContainerLifecycle: ({ data }: { data: { target: ContainerTarget; contextId?: string | null } }) => {
    const call = deferred<LifecycleRead>();
    reads.push({ ...call, data });
    return call.promise;
  },
  changeContainerLifecycle: ({ data, headers }: { data: LifecycleIntent; headers: HeadersInit }) => {
    const call = deferred<LifecycleResult>();
    changes.push({ ...call, data, headers: new Headers(headers) });
    return call.promise;
  },
  readContainerLifecycleDestination: ({ data }: { data: { target: ContainerTarget; contextId: string | null } }) => {
    const call = deferred<
      { kind: 'available'; target: ContainerTarget; contextId: string | null; href: string } | { kind: 'unavailable' }
    >();
    destinations.push({ ...call, data });
    return call.promise;
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const testWindow = new Window({ url: `https://site.test/en/realms/${realmTarget.id}`, width: 1280, height: 900 });
const globals = {
  window: testWindow,
  document: testWindow.document,
  navigator: testWindow.navigator,
  HTMLElement: testWindow.HTMLElement,
  HTMLButtonElement: testWindow.HTMLButtonElement,
  HTMLTextAreaElement: testWindow.HTMLTextAreaElement,
  Element: testWindow.Element,
  Node: testWindow.Node,
  Document: testWindow.Document,
  DocumentFragment: testWindow.DocumentFragment,
  MutationObserver: testWindow.MutationObserver,
  ResizeObserver: testWindow.ResizeObserver,
  getComputedStyle: testWindow.getComputedStyle.bind(testWindow),
  requestAnimationFrame: testWindow.requestAnimationFrame.bind(testWindow),
  cancelAnimationFrame: testWindow.cancelAnimationFrame.bind(testWindow),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery } = await import('../src/session/query');
const { ContainerLifecyclePanel } = await import('../src/community/container-lifecycle-controls');
const { AuthoringDepartureState } = await import('../src/threads/authoring-departure');
const { containerLifecycleSessionSource, createContainerLifecycleCallerLifetime } =
  await import('../src/community/container-lifecycle-caller-lifetime');
const { createContainerLifecycle } = await import('../src/community/container-lifecycle');
const { m } = await import('../src/paraglide/messages.js');

type Client = InstanceType<typeof QueryClient>;
type TargetSnapshot = LifecycleSnapshot['state'];
const visitor = (csrfToken = 'csrf-one', state: 'signed-in' | 'signed-out' = 'signed-in') => ({
  state,
  subject: state === 'signed-in' ? 'moderator-one' : null,
  csrfToken: state === 'signed-in' ? csrfToken : null,
});

function ready(target: ContainerTarget, state: TargetSnapshot, actions: readonly LifecycleAction[]): LifecycleRead {
  return {
    kind: 'ready',
    snapshot: { target, head, version: '7', state, contextId, actions },
  };
}

function confirmed(intent: LifecycleIntent): LifecycleResult {
  return {
    kind: 'confirmed',
    target: intent.target,
    action: intent.action,
    head: intent.expectedHead,
    contextId: intent.contextId,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let client: Client;
let root: ReturnType<typeof createRoot>;
let host: HTMLElement;
let target: ContainerTarget;
let title: string;
let strictMode: boolean;
let restrictions: string[];
let restrictionCallback: (state: 'removed' | 'orphaned') => void;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function panel() {
  return createElement(ContainerLifecyclePanel, {
    target,
    title,
    onRestriction: restrictionCallback,
  });
}

async function paint() {
  await act(async () => {
    const content = createElement(QueryClientProvider, { client }, panel());
    root.render(strictMode ? createElement(StrictMode, null, content) : content);
    await Promise.resolve();
  });
  await flush();
}

async function requestDeparture() {
  let decision: boolean | Promise<boolean> = false;
  await act(async () => {
    decision = departureBlockers.at(-1)!({ current: { pathname: '/en/current' }, next: { pathname: '/en/next' } });
    await Promise.resolve();
  });
  await flush();
  return decision;
}

async function settle<T>(call: Deferred<T>, value: T) {
  await act(async () => {
    call.resolve(value);
    await tick();
  });
}

function button(label: string) {
  const found = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label);
  expect(found).toBeDefined();
  return found!;
}

async function click(label: string) {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
  });
  await flush();
}

async function fillReason(value: string) {
  await act(async () => {
    const field = host.querySelector('textarea');
    expect(field).toBeDefined();
    const setter = Object.getOwnPropertyDescriptor(testWindow.HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(field, value);
    field!.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  reads.length = 0;
  changes.length = 0;
  destinations.length = 0;
  departureBlockers.length = 0;
  target = realmTarget;
  title = 'Quiet reading room';
  strictMode = false;
  restrictions = [];
  restrictionCallback = (state) => restrictions.push(state);
  testWindow.history.replaceState({}, '', `/en/realms/${realmTarget.id}`);
  host = testWindow.document.createElement('main');
  testWindow.document.body.append(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, visitor());
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  host.remove();
});

afterAll(() => {
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('default Panel fences late change, authoritative read and destination on same-account credential replacement', async () => {
  await paint();
  expect(reads).toHaveLength(1);
  await settle(reads[0]!, ready(realmTarget, 'removed', ['restore']));
  await click(m.container_lifecycle_restore());
  await click(m.container_lifecycle_confirm());
  expect(changes).toHaveLength(1);
  expect(changes[0]!.headers.get('X-CSRF-Token')).toBe('csrf-one');

  await settle(changes[0]!, confirmed(changes[0]!.data));
  expect(reads).toHaveLength(2);
  await settle(reads[1]!, ready(realmTarget, 'active', ['remove']));
  expect(destinations).toHaveLength(1);
  const revision = containerLifecycleSessionSource(client).snapshot();
  const restrictionsBeforeReplacement = restrictions.length;

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, visitor('csrf-replacement'));
    await tick();
  });
  expect(containerLifecycleSessionSource(client).snapshot()).toBeGreaterThan(revision);
  await paint();
  expect(reads).toHaveLength(3);

  await settle(destinations[0]!, {
    kind: 'available',
    target: realmTarget,
    contextId,
    href: `/en/realms/${realmTarget.id}`,
  });
  expect(host.querySelector('a')).toBeNull();
  expect(restrictions).toHaveLength(restrictionsBeforeReplacement);
  expect(reads).toHaveLength(3);
  expect(destinations).toHaveLength(1);
});

test('same-account away and back retires the pending read even when React sees only the final cache value', async () => {
  await paint();
  expect(reads).toHaveLength(1);
  const revision = containerLifecycleSessionSource(client).snapshot();

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, visitor('', 'signed-out'));
    client.setQueryData(sessionQuery.queryKey, visitor());
    await tick();
  });
  await paint();
  expect(containerLifecycleSessionSource(client).snapshot()).toBeGreaterThanOrEqual(revision + 2);
  expect(reads).toHaveLength(2);

  await settle(reads[0]!, ready(realmTarget, 'removed', ['restore']));
  expect(host.textContent).not.toContain(m.container_lifecycle_removed_state());
  expect(host.querySelector('a')).toBeNull();
  await settle(reads[1]!, ready(realmTarget, 'active', ['remove']));
  expect(button(m.container_lifecycle_remove())).toBeDefined();
  expect(host.querySelector(`button`)).not.toBeNull();
});

test('target, locale and readiness changes fence retained old callbacks before replacement work', async () => {
  const originalRestrictions: string[] = [];
  const replacementRestrictions: string[] = [];
  restrictionCallback = (state) => originalRestrictions.push(state);
  await paint();
  expect(reads).toHaveLength(1);

  testWindow.history.replaceState({}, '', `/fr/realms/${realmTarget.id}`);
  await paint();
  expect(reads).toHaveLength(2);
  expect(reads[1]!.data.target).toEqual(realmTarget);

  target = spaceTarget;
  title = 'Quiet space';
  restrictionCallback = (state) => replacementRestrictions.push(state);
  testWindow.history.replaceState({}, '', `/fr/spaces/${spaceTarget.id}`);
  await paint();
  expect(reads).toHaveLength(3);
  expect(reads[2]!.data.target).toEqual(spaceTarget);

  await settle(reads[0]!, ready(realmTarget, 'removed', ['restore']));
  await settle(reads[1]!, ready(realmTarget, 'removed', ['restore']));
  expect(host.textContent).not.toContain(m.container_lifecycle_removed_state());
  await settle(reads[2]!, ready(spaceTarget, 'active', ['remove']));
  await fillReason('Recorded reason');
  await click(m.container_lifecycle_remove());
  await click(m.container_lifecycle_confirm());
  expect(changes).toHaveLength(1);

  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, visitor('', 'signed-out'));
    await tick();
  });
  expect(host.textContent).toBe('');
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, visitor('csrf-one'));
    await tick();
  });
  await paint();
  expect(reads).toHaveLength(4);
  const readCountBeforeLateChange = reads.length;
  const oldRestrictionsBeforeLateChange = originalRestrictions.length;
  const newRestrictionsBeforeLateChange = replacementRestrictions.length;

  await settle(changes[0]!, confirmed(changes[0]!.data));
  expect(reads).toHaveLength(readCountBeforeLateChange);
  expect(originalRestrictions).toHaveLength(oldRestrictionsBeforeLateChange);
  expect(replacementRestrictions).toHaveLength(newRestrictionsBeforeLateChange);
  await settle(reads[3]!, ready(spaceTarget, 'active', ['remove']));
  expect(button(m.container_lifecycle_remove())).toBeDefined();
});

test('StrictMode replay and healthy rerender keep one caller usable; uncertain retry and completion stay exact and bounded', async () => {
  strictMode = true;
  await paint();
  expect(reads).toHaveLength(1);
  await settle(reads[0]!, ready(realmTarget, 'active', ['remove']));

  title = 'Updated title';
  await paint();
  expect(reads).toHaveLength(1);
  await fillReason('Repeated disruption');
  await click(m.container_lifecycle_remove());
  const confirm = button(m.container_lifecycle_confirm());
  await act(async () => {
    confirm.click();
    confirm.click();
    await tick();
  });
  expect(changes).toHaveLength(1);
  expect(changes[0]!.headers.get('X-CSRF-Token')).toBe('csrf-one');
  await settle(changes[0]!, { kind: 'unavailable' });
  expect(host.textContent).toContain(m.container_lifecycle_uncertain());

  await click(m.container_lifecycle_retry());
  expect(changes).toHaveLength(2);
  expect(changes[1]!.data).toEqual(changes[0]!.data);
  expect(changes[1]!.headers.get('X-CSRF-Token')).toBe(changes[0]!.headers.get('X-CSRF-Token'));
  await settle(changes[1]!, confirmed(changes[1]!.data));
  expect(reads).toHaveLength(2);
  await settle(reads[1]!, ready(realmTarget, 'removed', ['restore']));
  expect(reads).toHaveLength(2);
  expect(destinations).toHaveLength(0);
});

for (const scenario of [
  { name: 'Realm removal', target: realmTarget, state: 'active' as const, action: 'remove' as const, reason: 'Reviewed reason' },
  { name: 'Space restoration', target: spaceTarget, state: 'removed' as const, action: 'restore' as const, reason: '' },
]) {
  test(`${scenario.name} shares Stay and Leave protection with lifecycle controls`, async () => {
    target = scenario.target;
    await paint();
    await settle(reads[0]!, ready(target, scenario.state, [scenario.action]));
    expect(await requestDeparture()).toBe(false);
    const actionLabel = scenario.action === 'remove' ? m.container_lifecycle_remove() : m.container_lifecycle_restore();
    if (scenario.reason) await fillReason(scenario.reason);
    await click(actionLabel);
    const confirmation = scenario.action === 'remove'
      ? m.container_lifecycle_confirm_remove({ title })
      : m.container_lifecycle_confirm_restore({ title });
    const reviewed = await requestDeparture();
    expect(host.textContent).toContain(m.container_lifecycle_leave_title());
    expect(host.textContent).toContain(m.container_lifecycle_leave_unsaved());
    expect(host.textContent).toContain(confirmation);
    await click(m.thread_authoring_stay());
    expect(await reviewed).toBe(true);
    if (scenario.reason) expect(host.querySelector('textarea')?.value).toBe(scenario.reason);
    await click(m.container_lifecycle_confirm());
    const intent = changes[0]!.data;
    expect(intent).toMatchObject({ target, action: scenario.action, expectedHead: head, expectedVersion: '7', reason: scenario.reason, contextId });
    let pending = await requestDeparture();
    expect(host.textContent).toContain(m.container_lifecycle_leave_pending());
    await click(m.thread_authoring_stay());
    expect(await pending).toBe(true);
    expect(changes[0]!.data).toBe(intent);

    if (scenario.action === 'remove') {
      await settle(changes[0]!, { kind: 'unavailable' });
      pending = await requestDeparture();
      expect(host.textContent).toContain(m.container_lifecycle_leave_pending());
      await click(m.thread_authoring_stay());
      expect(await pending).toBe(true);
      await click(m.container_lifecycle_retry());
      expect(changes).toHaveLength(2);
      expect(changes[1]!.data).toEqual(intent);
      await settle(changes[1]!, confirmed(intent));
      expect(reads).toHaveLength(2);
      expect(await requestDeparture()).toBe(false);
      await settle(reads[1]!, ready(target, 'removed', ['restore']));
      expect(await requestDeparture()).toBe(false);
    } else {
      const leaving = await requestDeparture();
      await click(m.thread_authoring_leave());
      expect(await leaving).toBe(false);
      expect(host.querySelector('section')).toBeNull();
      await settle(changes[0]!, confirmed(intent));
      expect(reads).toHaveLength(1);
    }
  });
}

test('shared Leave retires lifecycle callers even when another draft opens the prompt', async () => {
  const owner = new AuthoringDepartureState(); let retired = false;
  owner.register({ kind: 'container-lifecycle', needsDecision: () => false, unresolved: () => false, discard: () => {}, leave: () => { retired = true; } });
  owner.register({ needsDecision: () => true, unresolved: () => false, discard: () => {} });
  const blocked = owner.block('/space', '/other', null);
  owner.leave();
  expect(retired).toBe(true);
  expect(await blocked).toBe(false);
});

test('unmount and remount retire old promises while a fresh default Panel reads again', async () => {
  await paint();
  expect(reads).toHaveLength(1);
  const oldRoot = root;
  await act(async () => oldRoot.unmount());
  await tick();

  root = createRoot(host as unknown as HTMLElement);
  await paint();
  expect(reads).toHaveLength(2);
  const restrictionsBeforeLateRead = restrictions.length;
  await settle(reads[0]!, ready(realmTarget, 'removed', ['restore']));
  expect(host.textContent).not.toContain(m.container_lifecycle_removed_state());
  expect(restrictions).toHaveLength(restrictionsBeforeLateRead);
  await settle(reads[1]!, ready(realmTarget, 'active', ['remove']));
  expect(button(m.container_lifecycle_remove())).toBeDefined();
});

test('retained controller callbacks cannot dispatch after their mounted visit retires', async () => {
  let visitValid = true;
  const lifetime = createContainerLifecycleCallerLifetime(() => visitValid);
  const disconnect = lifetime.connect();
  expect(lifetime.current()).toBe(true);

  let adapterReads = 0;
  let adapterChanges = 0;
  const adapter: ContainerLifecycleAdapter = {
    read: async () => {
      adapterReads++;
      return ready(realmTarget, 'active', ['remove']);
    },
    change: async () => {
      adapterChanges++;
      return { kind: 'unavailable' };
    },
    destination: async () => ({ kind: 'unavailable' }),
  };
  const controller = createContainerLifecycle(realmTarget, adapter, () => head, lifetime);
  await controller.refresh();
  expect(adapterReads).toBe(1);
  controller.setReason('Retained intent');
  const retainedRefresh = controller.refresh;
  const retainedSubmit = () => controller.submit('remove');
  visitValid = false;
  disconnect();
  lifetime.retire();
  await retainedRefresh();
  await retainedSubmit();
  await controller.retry();
  expect(adapterReads).toBe(1);
  expect(adapterChanges).toBe(0);
});
