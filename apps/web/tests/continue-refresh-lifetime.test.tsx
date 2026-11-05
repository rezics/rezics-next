import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { m } from '../src/paraglide/messages.js';
import type { ContinueEntry, ContinueResult, ContinueView } from '../src/library/continue-source';

// UNRUN: default mounted hook and presentation regressions for the integration gate.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/continue' });
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

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/kernel/exposure', () => ({ useOperation: () => false }));
const { createRoot } = await import('react-dom/client');
const { ContinueSection, useContinueRefresh } = await import('../src/library/continue');

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

const calls: Deferred<ContinueResult>[] = [];
const controls: { current?: ReturnType<typeof useContinueRefresh> } = {};
const host = window.document.createElement('main') as unknown as HTMLElement;
window.document.body.append(host);
let root: ReturnType<typeof createRoot>;
let mounted = false;

function Harness({
  initial,
  read,
  scope,
}: {
  initial: ContinueView | undefined;
  read: () => Promise<ContinueResult>;
  scope: string;
}) {
  const resume = useContinueRefresh(initial, read, scope);
  controls.current = resume;
  return (
    <ContinueSection
      destination
      state={resume.result}
      locale="en"
      onRetry={() => void resume.refresh()}
      busy={resume.busy}
    />
  );
}

function reader(): () => Promise<ContinueResult> {
  return () => {
    const call = deferred<ContinueResult>();
    calls.push(call);
    return call.promise;
  };
}

function entry(label: string): ContinueEntry {
  const subjectId = `subject-${label.toLowerCase().replaceAll(' ', '-')}`;
  return {
    subjectId,
    label,
    summary: { id: subjectId, type: 'schema:Book', types: ['schema:Book'], label, cover: null },
    progress: null,
  };
}

const loaded = (...labels: string[]): ContinueResult => ({
  state: 'loaded',
  entries: labels.map(entry),
  next: null,
});
const preparing = (retryAfter: number): ContinueView => ({ state: 'preparing', retryAfter });

async function paint(initial: ContinueView | undefined, read: () => Promise<ContinueResult>, scope: string) {
  await act(async () => root.render(<Harness initial={initial} read={read} scope={scope} />));
}

type RefreshHandle = { pending: Promise<ContinueResult> };

async function startRefresh(): Promise<RefreshHandle> {
  let pending!: Promise<ContinueResult>;
  await act(async () => {
    pending = controls.current!.refresh();
  });
  return { pending };
}

async function settle(index: number, result: ContinueResult | Error) {
  await act(async () => {
    if (result instanceof Error) calls[index]!.reject(result);
    else calls[index]!.resolve(result);
    await Promise.resolve();
  });
}

function state() {
  return host.querySelector('section[data-continue-state]')?.getAttribute('data-continue-state');
}

function busy() {
  return host.querySelector('[aria-busy="true"]') !== null;
}

function controlledPreparationTimers() {
  const timers = new Map<number, { delay: number; run: () => void }>();
  const nativeSetTimeout = globalThis.setTimeout;
  const nativeClearTimeout = globalThis.clearTimeout;
  let nextTimer = -1;
  const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((run, delay, ...args) => {
    if (delay !== 2_000 && delay !== 30_000) return nativeSetTimeout(run, delay, ...args);
    const id = nextTimer--;
    timers.set(id, { delay: Number(delay), run: () => run(...args) });
    return id;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(((id) => {
    if (!timers.delete(Number(id))) nativeClearTimeout(id);
  }) as typeof clearTimeout);
  return {
    timers,
    async fireNext() {
      const next = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
      expect(next).toBeDefined();
      timers.delete(next![0]);
      await act(async () => next![1].run());
    },
    restore() {
      timerSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  calls.length = 0;
  controls.current = undefined;
  host.replaceChildren();
  root = createRoot(host);
  mounted = true;
});

afterEach(async () => {
  if (mounted) {
    await act(async () => root.unmount());
    mounted = false;
  }
});

afterAll(async () => {
  await window.happyDOM.close();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Older Continue refreshes cannot replace current results or clear a newer pending read', async () => {
  const read = reader();
  await paint({ state: 'unavailable' }, read, 'same-view');

  const { pending: first } = await startRefresh();
  const { pending: second } = await startRefresh();
  await settle(0, loaded('Older while pending'));
  await first;
  expect(state()).toBe('unknown');
  expect(busy()).toBe(true);
  await settle(1, loaded('Current while pending'));
  await second;
  expect(state()).toBe('loaded');
  expect(host.textContent).toContain('Current while pending');
  expect(host.textContent).not.toContain('Older while pending');

  const { pending: olderSuccess } = await startRefresh();
  const { pending: newerSuccess } = await startRefresh();
  await settle(3, loaded('Newest result'));
  await newerSuccess;
  await settle(2, loaded('Late older result'));
  await olderSuccess;
  expect(state()).toBe('loaded');
  expect(host.textContent).toContain('Newest result');
  expect(host.textContent).not.toContain('Late older result');

  const { pending: olderRejection } = await startRefresh();
  const { pending: newerPending } = await startRefresh();
  await settle(4, new Error('old read failed'));
  await olderRejection;
  expect(state()).toBe('unknown');
  expect(busy()).toBe(true);
  await settle(5, loaded('Surviving result'));
  await newerPending;
  expect(state()).toBe('loaded');
  expect(host.textContent).toContain('Surviving result');
});

test('initial and scope replacements show their own state and retire late completions through unmount', async () => {
  const read = reader();
  await paint({ state: 'unavailable' }, read, 'cursor-one');
  const { pending: oldInitialRead } = await startRefresh();

  const replacement = preparing(600);
  await paint(replacement, read, 'cursor-one');
  expect(state()).toBe('preparing');
  expect(busy()).toBe(false);
  await settle(0, loaded('Retired initial result'));
  await oldInitialRead;
  expect(state()).toBe('preparing');
  expect(host.textContent).not.toContain('Retired initial result');

  const { pending: oldScopeRead } = await startRefresh();
  await paint(loaded('Current scope result'), read, 'cursor-two');
  expect(state()).toBe('loaded');
  expect(host.textContent).toContain('Current scope result');
  await settle(1, { state: 'closed' });
  await oldScopeRead;
  expect(state()).toBe('loaded');
  expect(host.textContent).toContain('Current scope result');
  expect(host.textContent).not.toContain(m.platform_closed_message({}, { locale: 'en' }));

  const { pending: unmountedRead } = await startRefresh();
  await act(async () => root.unmount());
  mounted = false;
  await settle(2, loaded('After unmount'));
  expect(await unmountedRead).toEqual(loaded('After unmount'));
  expect(host.innerHTML).toBe('');
});

test('closed Continue shows the native gate, retires rows and never retries', async () => {
  const timers = controlledPreparationTimers();
  const read = reader();
  const closed = { state: 'closed' } as const;
  const message = m.platform_closed_message({}, { locale: 'en' });
  try {
    await paint(closed, read, 'closed-initial');
    expect(state()).toBe('closed');
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain(m.library_continue_empty({}, { locale: 'en' }));
    expect(host.textContent).not.toContain(m.library_continue_denied({}, { locale: 'en' }));
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(timers.timers.size).toBe(0);

    await paint(loaded('Retained subject'), read, 'closed-refresh');
    const { pending } = await startRefresh();
    expect(state()).toBe('unknown');
    expect(host.textContent).not.toContain('Retained subject');
    await settle(0, closed);
    await pending;
    expect(state()).toBe('closed');
    expect(host.textContent).toContain(message);
    expect(host.textContent).not.toContain('Retained subject');
    expect(host.textContent).not.toContain(m.library_continue_empty({}, { locale: 'en' }));
    expect(host.textContent).not.toContain(m.library_continue_denied({}, { locale: 'en' }));
    expect(host.querySelectorAll('a')).toHaveLength(0);
    expect(host.querySelectorAll('button')).toHaveLength(0);
    expect(timers.timers.size).toBe(0);
  } finally {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
    timers.restore();
  }
});

test('preparation retries stay on their lifetime, clamp delays and stop after two attempts', async () => {
  const timers = controlledPreparationTimers();
  const read = reader();
  try {
    await paint(preparing(600), read, 'retired-preparation');
    expect([...timers.timers.values()].map((timer) => timer.delay)).toEqual([30_000]);
    await paint(loaded('Replacement state'), read, 'retired-preparation');
    expect(timers.timers.size).toBe(0);
    expect(calls).toHaveLength(0);

    await paint(preparing(600), read, 'bounded-preparation');
    expect([...timers.timers.values()].map((timer) => timer.delay)).toEqual([30_000]);
    await timers.fireNext();
    expect(calls).toHaveLength(1);
    expect(state()).toBe('unknown');
    expect(busy()).toBe(true);

    await settle(0, preparing(2));
    expect([...timers.timers.values()].map((timer) => timer.delay)).toEqual([2_000]);
    await timers.fireNext();
    expect(calls).toHaveLength(2);
    await settle(1, preparing(2));
    expect(timers.timers.size).toBe(0);
    expect(state()).toBe('preparing');

    await paint({ state: 'unavailable' }, read, 'unavailable');
    expect(timers.timers.size).toBe(0);
    expect(calls).toHaveLength(2);
  } finally {
    if (mounted) {
      await act(async () => root.unmount());
      mounted = false;
    }
    timers.restore();
  }
});
