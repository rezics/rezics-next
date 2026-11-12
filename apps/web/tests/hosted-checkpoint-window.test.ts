import { expect, test } from 'bun:test';
import type { RecoveryObservation, RecoveryObserver } from '../src/library/application';
import { HostedCheckpointWindow } from '../src/library/hosted-checkpoint-window';
import type { HostedCheckpointRequest, HostedCheckpointResult } from '../src/library/hosted-checkpoint-source';

const loaded = (title: string, nextCursor: string | null = null): HostedCheckpointResult => ({
  state: 'loaded', items: [{ availability: 'available', subjectId: 'book', revision: '1', title, catalogueId: 'catalogue', publicationRevisionId: 'publication', occurrenceId: 'chapter' }], nextCursor,
});
function fixture() {
  let owner: RecoveryObservation = { subject: 'A', csrfToken: 'credential-A', identity: {} };
  const listeners = new Set<() => void>();
  const observer: RecoveryObserver = { read: () => owner, subscribe: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const calls: { input: HostedCheckpointRequest; signal: AbortSignal; resolve: (result: HostedCheckpointResult) => void }[] = [];
  const controller = new HostedCheckpointWindow(observer, 'en', (input, signal) => new Promise(resolve => { calls.push({ input, signal, resolve }); }));
  const stop = controller.start();
  return { controller, calls, stop,
    replace(subject: string | null = owner.subject, notify = true) {
      owner = { subject, csrfToken: subject ? `credential-${subject}` : null, identity: {} };
      if (notify) for (const listener of listeners) listener();
    },
    async settle(result: HostedCheckpointResult, index = calls.length-1) { calls[index]!.resolve(result); await Promise.resolve(); },
  };
}

test('Books navigation replaces pages, preserves native opaque cursors and retries the exact failed movement', async () => {
  const f = fixture();
  try {
    await f.settle(loaded('first', 'opaque+/next=='));
    const first = f.controller.getSnapshot();
    f.controller.next(first);
    expect(f.calls[1]!.input).toEqual({ viewer: 'A', locale: 'en', cursor: 'opaque+/next==' });
    expect(f.controller.getSnapshot().result).toEqual({ state: 'loading' });
    await f.settle({ state: 'unavailable' });
    f.controller.retry(f.controller.getSnapshot());
    expect(f.calls[2]!.input.cursor).toBe('opaque+/next==');
    await f.settle(loaded('second', 'last'));
    expect(f.controller.getSnapshot().previous).toBe(true);
    f.controller.previous(f.controller.getSnapshot());
    expect(f.calls[3]!.input.cursor).toBeUndefined();
    await f.settle(loaded('first current read', 'next-again'));
    expect(f.controller.getSnapshot().previous).toBe(false);
    f.controller.next(first); // stale control from the earlier displayed first page
    expect(f.calls).toHaveLength(4);
    f.controller.refresh(f.controller.getSnapshot());
    expect(f.calls[4]!.input.cursor).toBeUndefined();
    await f.settle({ state: 'loaded', items: [], nextCursor: 'sparse' });
    f.controller.next(f.controller.getSnapshot());
    expect(f.calls[5]!.input.cursor).toBe('sparse');
  } finally { f.stop(); }
});

test('viewer and equal-value credential replacement hide old pages synchronously and reject late A/B/A work', async () => {
  const f = fixture();
  try {
    await f.settle(loaded('private A', 'next-A'));
    const old = f.controller.getSnapshot();
    f.replace('A', false);
    expect(f.controller.getSnapshot().result.state).toBe('loading'); // before observer notification
    f.controller.next(old);
    expect(f.calls).toHaveLength(1);
    f.replace('A');
    expect(f.controller.getSnapshot().result.state).toBe('loading');
    f.replace('B');
    f.replace('A');
    expect(f.calls.map(call => call.input.viewer)).toEqual(['A','A','B','A']);
    expect(f.calls.slice(0,-1).every(call => call.signal.aborted)).toBe(true);
    await f.settle(loaded('late same A'), 1);
    await f.settle(loaded('late B'), 2);
    expect(f.controller.getSnapshot().result.state).toBe('loading');
    await f.settle(loaded('current A'), 3);
    expect(f.controller.getSnapshot().result).toEqual(loaded('current A'));
    f.replace(null);
    expect(f.controller.getSnapshot().result).toEqual({ state: 'signed-out' });
    f.controller.refresh(old);
    expect(f.calls).toHaveLength(4);
  } finally { f.stop(); }
});

test('stale cursors require an explicit first read; denied and signed-out responses remove predecessors', async () => {
  for (const state of ['stale','denied','signed-out'] as const) {
    const f = fixture();
    try {
      await f.settle(loaded('first', 'next'));
      f.controller.next(f.controller.getSnapshot());
      await f.settle({ state });
      const failed = f.controller.getSnapshot();
      expect(failed.result).toEqual({ state });
      expect(failed.previous).toBe(false);
      f.controller.retry(failed);
      expect(f.calls).toHaveLength(2);
      if (state === 'stale') {
        f.controller.first(failed);
        expect(f.calls[2]!.input.cursor).toBeUndefined();
        await f.settle({ state: 'loaded', items: [], nextCursor: null });
        expect(f.controller.getSnapshot().first).toBe(false);
      }
    } finally { f.stop(); }
  }
});

test('the window retains only eight predecessors and disposal ignores an outstanding response', async () => {
  const f = fixture();
  for (let page = 0; page <= 10; page++) {
    await f.settle(loaded(`page ${page}`, `cursor-${page+1}`));
    if (page < 10) f.controller.next(f.controller.getSnapshot());
  }
  for (let previous = 9; previous >= 2; previous--) {
    f.controller.previous(f.controller.getSnapshot());
    expect(f.calls.at(-1)!.input.cursor).toBe(`cursor-${previous}`);
    await f.settle(loaded(`reread ${previous}`));
  }
  expect(f.controller.getSnapshot().previous).toBe(false);
  f.controller.refresh(f.controller.getSnapshot());
  const pending = f.calls.at(-1)!;
  f.stop();
  expect(pending.signal.aborted).toBe(true);
  pending.resolve(loaded('late disposed title'));
  await Promise.resolve();
  expect(f.controller.getSnapshot().result.state).toBe('loading');
});
