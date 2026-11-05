import { afterAll, expect, spyOn, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { loadRecoveryPage, parseRecoveryPage, useRecoveryPage, type RecoveryPageStage } from '../src/recovery-page';
const limits = { minPasswordLength: 8, maxPasswordLength: 128 };
const encode = (value: string) => new TextEncoder().encode(value);
const responseWithReader = (reader: object) =>
  ({ status: 200, headers: new Headers(), body: { getReader: () => reader } }) as unknown as Response;
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', `${import.meta.dir}/../../web`)))
);
const dom = new Window({ url: 'https://auth.test/recovery' });
const globals = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  [...Object.keys(globals)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
function Advice({ stage }: { stage: RecoveryPageStage }) {
  const { state } = useRecoveryPage(stage);
  return createElement(
    'output',
    null,
    state.kind === 'ready' ? `${state.page.stage}:${state.page.viewer.kind}` : state.kind,
  );
}
afterAll(async () => {
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await dom.happyDOM.close();
});

test('page reads send only a stage, bound responses and keep outages explicitly unavailable', async () => {
  const request = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(recoveryPage('complete', limits)));
  try {
    expect((await loadRecoveryPage('complete')).kind).toBe('ready');
    expect(request.mock.calls[0]?.[0]).toBe('/recovery/page');
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      body: '{"stage":"complete"}',
      cache: 'no-store',
      redirect: 'error',
    });
    request.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect(await loadRecoveryPage('step-up')).toEqual({ kind: 'unavailable' });
    const json = JSON.stringify(
      recoveryPage('step-up', limits, { kind: 'signed-in', account_id: 'account-"id', email: 'readeré@example.test' }),
    );
    const atLimit = json + ' '.repeat(4096 - encode(json).byteLength);
    expect(encode(atLimit)).toHaveLength(4096);
    request.mockResolvedValueOnce(new Response(atLimit));
    expect((await loadRecoveryPage('step-up')).kind).toBe('ready');
    for (const response of [
      new Response(`${atLimit} `),
      new Response(`${atLimit} `, { headers: { 'content-length': '1' } }),
    ]) {
      request.mockResolvedValueOnce(response);
      expect(await loadRecoveryPage('step-up')).toEqual({ kind: 'unavailable' });
    }
    for (const body of [Uint8Array.of(34, 255, 34), '{']) {
      request.mockResolvedValueOnce(new Response(body));
      expect(await loadRecoveryPage('complete')).toEqual({ kind: 'unavailable' });
    }
    const caller = new AbortController();
    let resolveLate!: (response: Response) => void;
    request.mockImplementationOnce(() => new Promise((resolve) => (resolveLate = resolve)));
    const pending = loadRecoveryPage('step-up', caller.signal);
    await Promise.resolve();
    caller.abort();
    expect(await pending).toEqual({ kind: 'unavailable' });
    resolveLate(
      Response.json(recoveryPage('step-up', limits, { kind: 'signed-in', account_id: 'obsolete', email: null })),
    );
    expect(await pending).toEqual({ kind: 'unavailable' });
  } finally {
    request.mockRestore();
  }
});

test('completed bodies do not await cancellation; an aborted stalled read releases its reader', async () => {
  let completeRead = false;
  let completedReleased = false;
  const never = () => new Promise<void>(() => {});
  const request = spyOn(globalThis, 'fetch');
  try {
    request.mockResolvedValueOnce(
      responseWithReader({
        read: async () => {
          if (completeRead) return { done: true, value: undefined };
          completeRead = true;
          return { done: false, value: encode(JSON.stringify(recoveryPage('complete', limits))) };
        },
        cancel: never,
        releaseLock: () => (completedReleased = true),
      }),
    );
    expect((await loadRecoveryPage('complete')).kind).toBe('ready');
    expect(completedReleased).toBe(true);

    let beginRead!: () => void;
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => (beginRead = resolve));
    const released = new Promise<void>((resolve) => (releaseRead = resolve));
    let cancelled = false;
    let readReleased = false;
    request.mockResolvedValueOnce(
      responseWithReader({
        read: () => {
          beginRead();
          return new Promise(() => {});
        },
        cancel: () => {
          cancelled = true;
          return never();
        },
        releaseLock: () => {
          readReleased = true;
          releaseRead();
        },
      }),
    );
    const caller = new AbortController();
    const pending = loadRecoveryPage('step-up', caller.signal);
    await reading;
    caller.abort();
    expect(await pending).toEqual({ kind: 'unavailable' });
    await Promise.race([released, new Promise((resolve) => setTimeout(resolve, 0))]);
    expect(cancelled).toBe(true);
    expect(readReleased).toBe(true);
  } finally {
    request.mockRestore();
  }
});

test('a late step-up completion cannot replace advice for the current stage', async () => {
  let completeOld!: (response: Response) => void;
  let oldSignal: AbortSignal | undefined;
  const request = spyOn(globalThis, 'fetch')
    .mockImplementationOnce((_input, init) => {
      oldSignal = init?.signal as AbortSignal;
      return new Promise((resolve) => (completeOld = resolve));
    })
    .mockResolvedValueOnce(Response.json(recoveryPage('start', limits)));
  const host = document.body.appendChild(document.createElement('div'));
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(createElement(Advice, { stage: 'step-up' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      root.render(createElement(Advice, { stage: 'start' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(oldSignal?.aborted).toBe(true);
    expect(host.textContent).toBe('start:signed-out');
    await act(async () => {
      completeOld(
        Response.json(
          recoveryPage('step-up', limits, { kind: 'signed-in', account_id: 'obsolete', email: 'old@example.test' }),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.textContent).toBe('start:signed-out');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    request.mockRestore();
  }
});

test('stage actions cannot validate a credential or restore another stage’s account advice', () => {
  const viewer = { kind: 'signed-in' as const, account_id: 'current', email: 'current@example.test' };
  expect(parseRecoveryPage(recoveryPage('step-up', limits, viewer), 'step-up')?.viewer).toEqual(viewer);
  expect(parseRecoveryPage(recoveryPage('step-up', limits, viewer), 'complete')).toBeNull();
  const anonymous = recoveryPage('complete', limits, viewer);
  expect(anonymous.viewer).toEqual({ kind: 'signed-out' });
  expect(parseRecoveryPage({ ...anonymous, viewer }, 'complete')).toBeNull();
  expect(parseRecoveryPage({ ...anonymous, token_valid: true }, 'complete')).toBeNull();
  expect(
    parseRecoveryPage({ ...anonymous, actions: { start: true, complete: true, authenticate: false } }, 'complete'),
  ).toBeNull();
});
