import { expect, test } from 'bun:test';
import { createOutcomeRpc, type OutcomeRpc, type OutcomeRpcTransport } from './support/outcome-rpc.ts';

type Packet = Record<string, unknown>;
type Handler = (method: string, params: unknown) => unknown;

/** One end of a controlled in-memory channel. Packets cross as JSON, so only plain data survives. */
class Port implements OutcomeRpcTransport {
  peer!: Port;
  held: unknown[] = [];
  hold = false;
  sent: Packet[] = [];
  messages = new Set<(packet: unknown) => void>();
  failures = new Set<(error: Error) => void>();
  syncFailure: Error | undefined;
  asyncFailure: Error | undefined;

  send(packet: unknown): void | Promise<void> {
    if (this.syncFailure) throw this.syncFailure;
    if (this.asyncFailure) return Promise.reject(this.asyncFailure);
    const wire = JSON.parse(JSON.stringify(packet)) as Packet;
    this.sent.push(wire);
    this.peer.receive(wire);
  }

  subscribe(onMessage: (packet: unknown) => void, onFailure: (error: Error) => void) {
    this.messages.add(onMessage);
    this.failures.add(onFailure);
    return () => {
      this.messages.delete(onMessage);
      this.failures.delete(onFailure);
    };
  }

  receive(wire: unknown) {
    if (this.hold) this.held.push(wire);
    else queueMicrotask(() => this.emit(wire));
  }

  emit(wire: unknown) {
    for (const listener of [...this.messages]) listener(wire);
  }

  /** Delivers held packets in the given order (default: arrival order). */
  release(order?: number[]) {
    const held = this.held.splice(0);
    for (const index of order ?? held.keys()) this.emit(held[index]);
  }

  fail(error: Error) {
    for (const listener of [...this.failures]) listener(error);
  }
}

function channel(
  left: Handler = unexpected,
  right: Handler = unexpected,
  timeoutMs = 1000,
  limits: { a?: number; b?: number } = {},
) {
  const a = new Port();
  const b = new Port();
  a.peer = b;
  b.peer = a;
  const rpcA = createOutcomeRpc(a, {
    timeoutMs,
    ...(limits.a === undefined ? {} : { maxPending: limits.a }),
    onRequest: (method, params) => left(method, params),
  });
  const rpcB = createOutcomeRpc(b, {
    timeoutMs,
    ...(limits.b === undefined ? {} : { maxPending: limits.b }),
    onRequest: (method, params) => right(method, params),
  });
  return { a, b, rpcA, rpcB };
}

function unexpected(method: string): never {
  throw new Error(`unexpected request ${method}`);
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Tracks how many times a promise settled and how. */
function track<T>(promise: Promise<T>) {
  const state = { resolved: [] as T[], rejected: [] as unknown[] };
  promise.then(
    (value) => state.resolved.push(value),
    (error) => state.rejected.push(error),
  );
  return state;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function failure(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected rejection');
}

class RebuildError extends Error {
  override name = 'RebuildError';
  constructor(
    message: string,
    readonly reason: string,
    readonly generation: number,
    readonly partitions: number[],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

test('outcome IPC settles correlated operation completion and preserves real results and errors', async () => {
  // Concurrent requests settle by id, not by arrival order.
  {
    const gates = new Map<string, ReturnType<typeof deferred<string>>>();
    const { b, rpcA } = channel(unexpected, (method) => {
      const gate = deferred<string>();
      gates.set(method, gate);
      return gate.promise;
    });
    const first = track(rpcA.request('first'));
    const second = track(rpcA.request('second'));
    await tick();
    expect(b.sent).toHaveLength(0);
    gates.get('second')!.resolve('two');
    await tick();
    expect(second.resolved).toEqual(['two']);
    expect(first.resolved).toEqual([]);
    gates.get('first')!.resolve('one');
    await tick();
    expect(first.resolved).toEqual(['one']);
  }

  // Responses delivered out of order still match their own requests.
  {
    const { a, rpcA } = channel(unexpected, (method, params) => `${method}:${params}`);
    a.hold = true; // hold what the responder sends back to A
    const results = [rpcA.request('m', 1), rpcA.request('m', 2), rpcA.request('m', 3)].map(track);
    await tick();
    expect(a.held).toHaveLength(3);
    a.release([2, 0, 1]);
    await tick();
    expect(results.map((state) => state.resolved)).toEqual([['m:1'], ['m:2'], ['m:3']]);
  }

  // Packets are versioned plain data with unambiguous kinds and per-peer unique ids.
  {
    const { a, b, rpcA } = channel(unexpected, () => 'ok');
    await Promise.all([rpcA.request('one', { x: 1 }), rpcA.request('two')]);
    expect(a.sent).toHaveLength(2);
    expect(a.sent[0]).toMatchObject({
      protocol: 'rezics.outcome-rpc',
      version: 1,
      kind: 'request',
      method: 'one',
      params: { x: 1 },
    });
    expect(a.sent[0]!.id).not.toBe(a.sent[1]!.id);
    expect(b.sent.map((packet) => packet.kind)).toEqual(['result', 'result']);
    expect(b.sent.map((packet) => packet.id)).toEqual(a.sent.map((packet) => packet.id));
  }

  // Both directions at once: the worker asks for resource ownership while its init is still unanswered.
  {
    const log: string[] = [];
    let worker!: OutcomeRpc;
    const { rpcA, rpcB } = channel(
      (method, params) => {
        log.push(`supervisor:${method}`);
        if (method === 'resource.claim') return { granted: true, resource: (params as { name: string }).name };
        return unexpected(method);
      },
      async (method) => {
        log.push(`worker:${method}`);
        const claim = await worker.request<{ granted: boolean; resource: string }>('resource.claim', {
          name: 'index-1',
        });
        log.push('worker:claimed');
        return { ready: claim.granted, resource: claim.resource };
      },
    );
    worker = rpcB;
    const result = await rpcA.request('init');
    expect(result).toEqual({ ready: true, resource: 'index-1' });
    expect(log).toEqual(['worker:init', 'supervisor:resource.claim', 'worker:claimed']);
  }

  // Header pair arrays keep repeated names and order.
  {
    const headers = [
      ['content-type', 'application/json'],
      ['set-cookie', 'session=a; HttpOnly'],
      ['set-cookie', 'csrf=b; Path=/'],
      ['x-null', ''],
    ];
    const { rpcA } = channel(unexpected, () => ({
      status: 200,
      headers,
      body: { ok: true, none: null, nested: [[1, [2]], []] },
    }));
    const response = await rpcA.request<any>('http');
    expect(response.headers).toEqual(headers);
    expect(response).toEqual({ status: 200, headers, body: { ok: true, none: null, nested: [[1, [2]], []] } });
  }

  // Parameters pass through and an undefined result stays undefined.
  {
    const seen: unknown[] = [];
    const { rpcA } = channel(unexpected, (method, params) => {
      seen.push([method, params]);
    });
    expect(await rpcA.request('noop')).toBeUndefined();
    expect(await rpcA.request('noop', { a: [1, 'b', null] })).toBeUndefined();
    expect(seen).toEqual([
      ['noop', undefined],
      ['noop', { a: [1, 'b', null] }],
    ]);
  }

  // Typed failure details survive with name, message, stack, cause and enumerable fields.
  {
    const inner = new TypeError('cluster unreachable');
    const original = new RebuildError('rebuild failed', 'generation-mismatch', 7, [3, 5], { cause: inner });
    const { rpcA } = channel(unexpected, () => {
      throw original;
    });
    const error = await failure(rpcA.request('rebuild'));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RebuildError');
    expect(error.message).toBe('rebuild failed');
    expect(error.stack).toBe(original.stack);
    expect(error.reason).toBe('generation-mismatch');
    expect(error.generation).toBe(7);
    expect(error.partitions).toEqual([3, 5]);
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause.name).toBe('TypeError');
    expect(error.cause.message).toBe('cluster unreachable');
    // Standard fields stay non-enumerable, like native errors.
    expect(Object.keys(error).sort()).toEqual(['generation', 'partitions', 'reason']);
  }

  // Aggregate errors, non-error causes and cycles terminate and keep their shape.
  {
    const cyclic: any = new Error('loop');
    cyclic.cause = cyclic;
    cyclic.self = cyclic;
    cyclic.details = { nested: cyclic };
    const aggregate: any = new AggregateError([new RangeError('first'), cyclic, 'plain'], 'many', { cause: 'because' });
    aggregate.errors.push(aggregate);
    const { rpcA } = channel(unexpected, () => {
      throw aggregate;
    });
    const error = await failure(rpcA.request('aggregate'));
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toBe('many');
    expect(error.cause).toBe('because');
    expect(error.errors).toHaveLength(4);
    expect(error.errors[0]).toBeInstanceOf(Error);
    expect(error.errors[0].name).toBe('RangeError');
    expect(error.errors[1].message).toBe('loop');
    expect(error.errors[1].cause).toBe('[Circular]');
    expect(error.errors[1].self).toBe('[Circular]');
    expect(error.errors[2]).toBe('plain');
    expect(error.errors[3]).toBe('[Circular]');
  }

  // Deep cause chains are bounded.
  {
    let chain: Error = new Error('level 0');
    for (let level = 1; level < 40; level += 1) chain = new Error(`level ${level}`, { cause: chain });
    const { rpcA } = channel(unexpected, () => {
      throw chain;
    });
    let error = await failure(rpcA.request('deep'));
    let depth = 0;
    while (error instanceof Error && error.cause !== undefined) {
      error = error.cause;
      depth += 1;
    }
    expect(depth).toBeLessThan(12);
    expect(error).toBe('[Truncated]');
  }

  // Handler rejection, synchronous throws and non-error throws become operation errors, not unhandled events.
  {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const { rpcA } = channel(unexpected, (method) => {
      if (method === 'reject') return Promise.reject(new RangeError('async rejection'));
      if (method === 'throw') throw new SyntaxError('sync throw');
      if (method === 'string') throw 'just text';
      if (method === 'bad-result') return { run: () => 1 };
      return unexpected(method);
    });
    expect((await failure(rpcA.request('reject'))).name).toBe('RangeError');
    expect((await failure(rpcA.request('throw'))).message).toBe('sync throw');
    expect(await failure(rpcA.request('string'))).toBe('just text');
    const bad = await failure(rpcA.request('bad-result'));
    expect(bad.code).toBe('invalid');
    await tick();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  }

  // Functions, class instances and cycles are not plain data and are refused before anything is sent.
  {
    const { a, rpcA } = channel();
    const loop: any = {};
    loop.self = loop;
    for (const params of [() => 1, { fn() {} }, new Map(), new Date(), loop, [undefined], Number.NaN, 1n]) {
      expect((await failure(rpcA.request('bad', params))).code).toBe('invalid');
    }
    expect(a.sent).toHaveLength(0);
  }

  // Duplicate and late replies cannot resolve anything; unrelated ids are ignored.
  {
    const { a, b, rpcA } = channel(unexpected, async (method) => {
      if (method === 'slow') await new Promise((resolve) => setTimeout(resolve, 40));
      return method;
    });
    expect(await rpcA.request('fast')).toBe('fast');
    const [firstResult] = b.sent;
    a.emit(firstResult); // exact duplicate of a settled reply
    a.emit({ ...firstResult, id: 'unrelated' });
    const slow = track(rpcA.request('slow'));
    await tick();
    a.emit(firstResult); // old reply while another request is pending
    a.emit({ ...firstResult, id: a.sent[1]!.id, method: 'fast' }); // right id, wrong method
    await tick();
    expect(slow.resolved).toEqual([]);
    expect(slow.rejected).toHaveLength(1);
    expect(slow.rejected[0]).toMatchObject({ code: 'protocol' });
    await tick();
    expect(slow.resolved).toEqual([]);
    expect(slow.rejected).toHaveLength(1);
  }

  // Traffic without the protocol marker is ignored.
  {
    const { a, rpcA } = channel(unexpected, () => 'done');
    const pending = track(rpcA.request('x'));
    a.emit({ hello: 'world' });
    a.emit('chatter');
    a.emit(null);
    await tick();
    expect(pending.resolved).toEqual(['done']);
  }
});

test('outcome IPC rejects disconnect malformed response send failure and deadline without inventing success', async () => {
  const never = () => new Promise<never>(() => {});

  // Transport failure rejects every pending request exactly once, detaches listeners and rejects later calls.
  {
    const { a, rpcA } = channel(unexpected, never);
    const requests = [rpcA.request('a'), rpcA.request('b')].map(track);
    const disconnect = new Error('IPC channel disconnected');
    a.fail(disconnect);
    a.fail(new Error('second failure'));
    await tick();
    for (const request of requests) {
      expect(request.resolved).toEqual([]);
      expect(request.rejected).toEqual([disconnect]);
    }
    expect(a.messages.size).toBe(0);
    expect(a.failures.size).toBe(0);
    expect(await failure(rpcA.request('later'))).toBe(disconnect);
    expect(a.sent).toHaveLength(2);
  }

  // A reply that arrives after the disconnect resolves nothing.
  {
    const { a, rpcA } = channel(unexpected, () => 'late');
    a.hold = true;
    const request = track(rpcA.request('x'));
    await tick();
    a.fail(new Error('gone'));
    a.release();
    await tick();
    expect(request.resolved).toEqual([]);
    expect(request.rejected).toHaveLength(1);
  }

  // Local close rejects pending requests with the given or a default error and clears timers and listeners.
  {
    const { a, rpcA } = channel(unexpected, never, 60_000);
    const custom = new Error('shutting down');
    const request = track(rpcA.request('x'));
    rpcA.close(custom);
    rpcA.close(new Error('ignored'));
    await tick();
    expect(request.rejected).toEqual([custom]);
    expect(a.messages.size).toBe(0);
    expect(await failure(rpcA.request('y'))).toBe(custom);

    const other = channel(unexpected, never);
    const pending = track(other.rpcA.request('x'));
    other.rpcA.close();
    await tick();
    expect(pending.rejected[0]).toMatchObject({ code: 'closed' });
  }

  // Malformed responses: an unattributable packet fails the peer, an attributable one fails only its request.
  {
    const malformed: [string, (id: string) => unknown][] = [
      ['unknown kind', (id) => ({ protocol: 'rezics.outcome-rpc', version: 1, kind: 'ack', id })],
      ['wrong version', (id) => ({ protocol: 'rezics.outcome-rpc', version: 2, kind: 'result', id, method: 'x' })],
      ['no id', () => ({ protocol: 'rezics.outcome-rpc', version: 1, kind: 'result', method: 'x', value: 1 })],
      [
        'misaligned method',
        (id) => ({ protocol: 'rezics.outcome-rpc', version: 1, kind: 'result', id, method: 'y', value: 1 }),
      ],
      ['no error body', (id) => ({ protocol: 'rezics.outcome-rpc', version: 1, kind: 'error', id, method: 'x' })],
      [
        'bad error body',
        (id) => ({
          protocol: 'rezics.outcome-rpc',
          version: 1,
          kind: 'error',
          id,
          method: 'x',
          error: { error: { name: 1 } },
        }),
      ],
    ];
    for (const [label, build] of malformed) {
      const { a, rpcA } = channel(unexpected, never);
      const request = track(rpcA.request('x'));
      const bystander = track(rpcA.request('x'));
      a.emit(build(a.sent[0]!.id as string));
      await tick();
      expect([label, request.resolved]).toEqual([label, []]);
      expect(request.rejected).toHaveLength(1);
      expect(request.rejected[0]).toMatchObject({ code: 'protocol' });
      // Only the unattributable packet takes the bystander down with the peer.
      expect(bystander.rejected).toHaveLength(label === 'no id' ? 1 : 0);
      expect(a.messages.size).toBe(label === 'no id' ? 0 : 1);
      rpcA.close();
    }
  }

  // A malformed request still gets an error reply, and one bad handler result does not poison the peer.
  {
    const { a, b, rpcA } = channel(unexpected, () => 'fine');
    b.emit({ protocol: 'rezics.outcome-rpc', version: 1, kind: 'request', id: 'r1', method: 7 });
    await tick();
    expect(b.sent[0]).toMatchObject({ kind: 'error', id: 'r1' });
    expect(await rpcA.request('ok')).toBe('fine');
    expect(a.messages.size).toBe(1);
  }

  // Synchronous send failure rejects that request once, with the real error, and leaves nothing pending.
  {
    const { a, rpcA } = channel();
    a.syncFailure = new Error('channel closed');
    const request = track(rpcA.request('x'));
    await tick();
    expect(request.rejected).toEqual([a.syncFailure]);
    a.syncFailure = undefined;
  }

  // Asynchronous send failure does the same, even when it settles after other traffic.
  {
    const { a, rpcA } = channel(unexpected, () => 'ok');
    a.asyncFailure = new Error('write EPIPE');
    const request = track(rpcA.request('x', undefined, 60_000));
    await tick();
    expect(request.resolved).toEqual([]);
    expect(request.rejected).toEqual([a.asyncFailure]);
    a.asyncFailure = undefined;
    expect(await rpcA.request('again')).toBe('ok');
  }

  // A completed send is not a response: with no reply the request ends at its deadline.
  {
    const { a, rpcA } = channel(unexpected, never, 20);
    const started = performance.now();
    const request = track(rpcA.request('startup'));
    await tick();
    expect(a.sent).toHaveLength(1);
    expect(request.resolved).toEqual([]);
    expect(request.rejected).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(performance.now() - started).toBeGreaterThanOrEqual(15);
    expect(request.resolved).toEqual([]);
    expect(request.rejected).toHaveLength(1);
    expect(request.rejected[0]).toMatchObject({ code: 'timeout' });
  }

  // Per-request deadlines override the default, and a late reply after timeout cannot resolve another id.
  {
    const gates: ReturnType<typeof deferred<string>>[] = [];
    const { b, rpcA } = channel(
      unexpected,
      () => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
      60_000,
    );
    const quick = track(rpcA.request('quick', undefined, 15));
    const patient = track(rpcA.request('patient'));
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(quick.rejected).toHaveLength(1);
    expect(quick.rejected[0]).toMatchObject({ code: 'timeout' });
    expect(patient.rejected).toEqual([]);
    gates[0]!.resolve('too late for quick');
    await tick();
    expect(quick.resolved).toEqual([]);
    expect(patient.resolved).toEqual([]);
    gates[1]!.resolve('on time');
    await tick();
    expect(patient.resolved).toEqual(['on time']);
    expect(b.sent).toHaveLength(2);
  }

  // The pending bound rejects the excess request without sending it, and frees up as requests settle.
  {
    const gates: ReturnType<typeof deferred<string>>[] = [];
    const { a, rpcA } = channel(
      unexpected,
      () => {
        const gate = deferred<string>();
        gates.push(gate);
        return gate.promise;
      },
      1000,
      { a: 2 },
    );
    const first = track(rpcA.request('one'));
    rpcA.request('two');
    const overflow = await failure(rpcA.request('three'));
    expect(overflow).toMatchObject({ code: 'overflow' });
    expect(a.sent).toHaveLength(2);
    gates[0]!.resolve('done');
    await tick();
    expect(first.resolved).toEqual(['done']);
    gates[1]!.resolve('done');
    const again = track(rpcA.request('three'));
    await tick();
    gates[2]!.resolve('three');
    await tick();
    expect(again.resolved).toEqual(['three']);
  }

  // Incoming handlers are bounded too: the excess request receives an overflow error reply.
  {
    const gate = deferred<string>();
    const { rpcA } = channel(unexpected, () => gate.promise, 1000, { b: 1 });
    const running = track(rpcA.request('one'));
    const excess = await failure(rpcA.request('two'));
    expect(excess).toMatchObject({ code: 'overflow' });
    gate.resolve('released');
    await tick();
    expect(running.resolved).toEqual(['released']);
  }

  // Invalid bounds are refused up front.
  {
    const port = new Port();
    port.peer = port;
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createOutcomeRpc(port, { onRequest: unexpected, timeoutMs })).toThrow();
    }
    expect(() => createOutcomeRpc(port, { onRequest: unexpected, maxPending: 0 })).toThrow();
    expect(port.messages.size).toBe(0);
    const { rpcA } = channel();
    expect((await failure(rpcA.request('x', undefined, 0))).code).toBe('invalid');
    expect((await failure(rpcA.request('', undefined))).code).toBe('invalid');
  }

  // A reply that cannot be sent fails the peer instead of leaving the requester guessing.
  {
    const { b, rpcA, rpcB } = channel(unexpected, () => 'result');
    b.asyncFailure = new Error('reply EPIPE');
    const request = track(rpcA.request('x', undefined, 60_000));
    await tick();
    expect(b.messages.size).toBe(0);
    expect(await failure(rpcB.request('y'))).toBe(b.asyncFailure);
    rpcA.close();
    await tick();
    expect(request.rejected).toHaveLength(1);
  }

  // A transport that fails while subscribing leaves a closed peer, not a hung one.
  {
    const failing: OutcomeRpcTransport = {
      send: () => {},
      subscribe(_onMessage, onFailure) {
        onFailure(new Error('already gone'));
        return () => {};
      },
    };
    const rpc = createOutcomeRpc(failing, { onRequest: unexpected });
    expect((await failure(rpc.request('x'))).message).toBe('already gone');
  }
});
