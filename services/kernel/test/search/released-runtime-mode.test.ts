import { expect, test } from 'bun:test';
import { searchWorkerOwnership } from './support/runner-slot.ts';
import { randomUUID } from 'node:crypto';
import { createOutcomeRpc, createOutcomeWorkerClock, type OutcomeRpcTransport } from './support/outcome-rpc.ts';

test('explicit kernelPool refuses child ownership before invoking the pool capability', () => {
  let calls = 0;
  const instrumented = searchWorkerOwnership(() => {
    calls += 1;
    throw new Error('Selecting worker ownership must not acquire a pool');
  });
  expect(instrumented.kind).toBe('in-process');
  expect(() => instrumented.requireOwnedChild()).toThrow('explicit kernelPool capability');
  expect(() => instrumented.requireOwnedChild()).toThrow('in-process instrumentation');
  expect(calls).toBe(0);

  const child = searchWorkerOwnership(undefined);
  expect(child.kind).toBe('owned-child');
  expect(() => child.requireOwnedChild()).not.toThrow();
});

test('the child clock delegates system time until an explicit instant, then returns independent frozen Dates', async () => {
  const child = createOutcomeWorkerClock();
  const lifecycle = randomUUID();
  child.initialize({ lifecycle });
  const before = Date.now();
  const first = child.clock();
  expect(first.getTime()).toBeGreaterThanOrEqual(before);
  await Bun.sleep(5);
  expect(child.clock().getTime()).toBeGreaterThan(first.getTime());

  // Explicit freeze may precede the child's wall time. Only subsequent fixture transitions are monotonic.
  const instant = Date.UTC(2025, 0, 1);
  expect(child.change({ lifecycle, instant })).toEqual({ lifecycle, instant });
  const frozen = child.clock();
  frozen.setTime(0);
  await Bun.sleep(5);
  expect(child.clock().getTime()).toBe(instant);
  expect(child.clock()).not.toBe(child.clock());
  expect(child.change({ lifecycle, instant })).toEqual({ lifecycle, instant });
  child.change({ lifecycle, instant: instant + 17 });
  expect(child.clock().getTime()).toBe(instant + 17);
});

test('child clock refuses invalid, backwards and foreign-lifecycle transitions without losing its frozen state', () => {
  const child = createOutcomeWorkerClock();
  const lifecycle = randomUUID();
  const instant = Date.UTC(2025, 0, 1);
  expect(() => child.change({ lifecycle, instant })).toThrow('Foreign');
  child.initialize({ lifecycle, instant });
  expect(() => child.initialize({ lifecycle, instant })).toThrow('already initialized');
  for (const value of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER, '1', null, undefined]) {
    expect(() => child.change({ lifecycle, instant: value })).toThrow();
    expect(child.clock().getTime()).toBe(instant);
  }
  expect(() => child.change({ lifecycle, instant: instant - 1 })).toThrow('backwards');
  expect(() => child.change({ lifecycle: randomUUID(), instant: instant + 1 })).toThrow('Foreign');
  expect(() => child.change({ lifecycle })).toThrow('requires an instant');
  expect(() => child.change({ lifecycle, instant, extra: true })).toThrow();
  expect(child.clock().getTime()).toBe(instant);

  const restarted = createOutcomeWorkerClock();
  const nextLifecycle = randomUUID();
  restarted.initialize({ lifecycle: nextLifecycle, instant });
  expect(restarted.clock().getTime()).toBe(instant);
  expect(() => restarted.change({ lifecycle, instant: instant + 1 })).toThrow('Foreign');
  restarted.change({ lifecycle: nextLifecycle, instant: instant + 1 });
  expect(restarted.clock().getTime()).toBe(instant + 1);
});

test('instrumentation keeps the supplied clock function and rejects child replica controls', () => {
  let calls = 0;
  const original = () => {
    calls += 1;
    return new Date(123);
  };
  const instrumented = createOutcomeWorkerClock(original);
  expect(calls).toBe(0);
  expect(instrumented.clock).toBe(original);
  expect(() => instrumented.initialize({ lifecycle: randomUUID(), instant: 456 })).toThrow('supplied clock');
  expect(() => instrumented.change({ lifecycle: randomUUID(), instant: 456 })).toThrow('supplied clock');
  expect(instrumented.clock().getTime()).toBe(123);
  expect(calls).toBe(1);
});

function clockTransports(): OutcomeRpcTransport[] {
  const receive: ((packet: unknown) => void)[] = [() => {}, () => {}];
  return [0, 1].map((side) => ({
    send(packet) {
      const wire: unknown = JSON.parse(JSON.stringify(packet));
      queueMicrotask(() => receive[1 - side]!(wire));
    },
    subscribe(message) {
      receive[side] = message;
      return () => {
        receive[side] = () => {};
      };
    },
  }));
}

test('clock RPC waits for a matching response and refuses pending or later updates after custody loss', async () => {
  const [parentTransport, childTransport] = clockTransports();
  const clock = createOutcomeWorkerClock();
  const lifecycle = randomUUID();
  const instant = Date.UTC(2025, 0, 1);
  clock.initialize({ lifecycle });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const received = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const parent = createOutcomeRpc(parentTransport!, {
    timeoutMs: 1000,
    onRequest() {
      throw new Error('Unexpected child request');
    },
  });
  const child = createOutcomeRpc(childTransport!, {
    async onRequest(method, params) {
      expect(method).toBe('clock');
      const result = clock.change(params);
      reached();
      await gate;
      return result;
    },
  });
  try {
    let acknowledged = false;
    const pending = parent.request('clock', { lifecycle, instant }).then((value) => {
      acknowledged = true;
      return value;
    });
    await Promise.race([received, pending]);
    expect(clock.clock().getTime()).toBe(instant);
    expect(acknowledged).toBe(false); // Delivery and even application alone are not an IPC acknowledgment.
    release();
    expect(await pending).toEqual({ lifecycle, instant });
    expect(acknowledged).toBe(true);
    await expect(parent.request('clock', { lifecycle, instant: instant - 1 })).rejects.toThrow('backwards');
    await expect(parent.request('clock', { lifecycle: randomUUID(), instant })).rejects.toThrow('Foreign');

    const lost = new Error('Owned child custody lost');
    const unacknowledged = parent.request('clock', { lifecycle, instant: instant + 1 });
    parent.close(lost);
    await expect(unacknowledged).rejects.toThrow('Owned child custody lost');
    await expect(parent.request('clock', { lifecycle, instant: instant + 2 })).rejects.toThrow(
      'Owned child custody lost',
    );
  } finally {
    release();
    parent.close();
    child.close();
  }
});
