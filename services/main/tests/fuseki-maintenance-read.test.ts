import { afterEach, expect, spyOn, test } from 'bun:test';
import {
  FusekiClient,
  FusekiQueryResponseTooLarge,
  FusekiReadBudgetExceeded,
  fusekiReadBudget,
  type TemplateQueryEnvelope,
} from '../src/infrastructure/fuseki.ts';

const restores: (() => void)[] = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const capability = 'a'.repeat(64);
const client = (signal?: AbortSignal) => new FusekiClient('http://fuseki.invalid/rezics/', capability, capability, signal);
const template: TemplateQueryEnvelope = {
  query: 'SELECT ?id WHERE { GRAPH <urn:rezics:graph:current> { ?id <urn:label> ?label } }',
  bindings: {}, tables: [], limit: 1,
};
const reads = [
  { name: 'query', call: (fuseki: FusekiClient) => fuseki.query('ASK {}'), result: { boolean: true } },
  { name: 'template', call: (fuseki: FusekiClient) => fuseki.templateQuery(template), result: { results: { bindings: [] } } },
  { name: 'index', call: (fuseki: FusekiClient) => fuseki.templateIndex({ operation: 'basis', keys: [] }), result: { bases: [], position: { dataEpoch: 'epoch', sequence: '1' } } },
  { name: 'membership status', call: (fuseki: FusekiClient) => fuseki.membershipPreparationStatus(), result: { needsPreparation: false } },
  { name: 'health', call: (fuseki: FusekiClient) => fuseki.commandHealth(), result: { moduleVersion: '0.5.37', instanceId: '00000000-0000-4000-8000-000000000001', publicSearchWriteEpoch: '0', publicSearchWriteActive: false, profiles: {} } },
  { name: 'delta', call: (fuseki: FusekiClient) => fuseki.searchDeltaSince('-1'), result: { available: false } },
];

/** Advance finite deadlines explicitly: a cold response need not spend ten real seconds. */
function controlledClock() {
  let now = Date.now();
  const timers: { duration: number; deadline: number; controller: AbortController }[] = [];
  const date = spyOn(Date, 'now').mockImplementation(() => now);
  const timeout = spyOn(AbortSignal, 'timeout').mockImplementation((duration: number) => {
    const controller = new AbortController();
    timers.push({ duration, deadline: now + duration, controller });
    return controller.signal;
  });
  restores.push(() => date.mockRestore(), () => timeout.mockRestore());
  return {
    timers,
    advance(milliseconds: number) {
      now += milliseconds;
      for (const timer of timers) if (timer.deadline <= now && !timer.controller.signal.aborted)
        timer.controller.abort(new DOMException('Finite read deadline expired', 'TimeoutError'));
    },
  };
}
function fetchStub(handler: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>) {
  const stub = spyOn(globalThis, 'fetch').mockImplementation(handler as typeof fetch);
  restores.push(() => stub.mockRestore());
  return stub;
}
function requestSignal(init?: RequestInit): AbortSignal {
  if (!init?.signal) throw new Error('read transport must carry its deadline signal');
  return init.signal;
}

test('sequential cold maintenance reads share one finite deadline instead of renewing an interactive timeout', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000);
  const fuseki = client(preparation);
  let active = reads[0]!;
  const signals: AbortSignal[] = [];
  const fetch = fetchStub(async (_url, init) => {
    const signal = requestSignal(init); signals.push(signal);
    clock.advance(11_001); signal.throwIfAborted();
    return Response.json(active.result);
  });
  for (const read of reads) {
    active = read;
    expect(await read.call(fuseki)).toEqual(read.result);
  }
  expect(signals.every(signal => signal === preparation)).toBe(true);
  expect(clock.timers.map(timer => timer.duration)).toEqual([540_000]);
  expect(fetch).toHaveBeenCalledTimes(reads.length);
  clock.advance(540_000 - reads.length * 11_001);
  for (const read of reads) await expect(read.call(fuseki)).rejects.toBe(preparation.reason);
  expect(fetch).toHaveBeenCalledTimes(reads.length);
});

test('a maintenance token alone retains the ordinary ten-second read deadline', async () => {
  const clock = controlledClock();
  fetchStub(async (_url, init) => {
    clock.advance(10_001); requestSignal(init).throwIfAborted();
    return Response.json({ boolean: true });
  });
  await expect(client().query('ASK {}')).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(clock.timers.map(timer => timer.duration)).toEqual([10_000]);
});

test('all preparation reads refuse a pre-aborted signal before calling fetch', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000);
  clock.advance(540_000);
  const fetch = fetchStub(async () => { throw new Error('expired preparation must not fetch'); });
  for (const read of reads) await expect(read.call(client(preparation))).rejects.toBe(preparation.reason);
  expect(fetch).not.toHaveBeenCalled();
});

test('the shared maintenance deadline cancels a read still waiting for headers', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000);
  const fetch = fetchStub(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = requestSignal(init);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    clock.advance(540_000);
  }));
  await expect(client(preparation).query('ASK {}')).rejects.toBe(preparation.reason);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('every read method cancels a stalled response body at the same preparation deadline', async () => {
  const clock = controlledClock();
  let preparation: AbortSignal;
  let cancelled = false;
  let pulls = 0;
  fetchStub(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{'));
      else clock.advance(540_000);
    },
    cancel(reason) { cancelled = true; expect(reason).toBe(preparation.reason); },
  }, { highWaterMark: 0 })));
  for (const read of reads) {
    preparation = AbortSignal.timeout(540_000); pulls = 0; cancelled = false;
    await expect(read.call(client(preparation))).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(preparation.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
  }
}, 2000);

test('a configured preparation client still obeys the interactive ten-second deadline inside a read scope', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000), request = new AbortController();
  fetchStub(async (_url, init) => {
    clock.advance(10_001); requestSignal(init).throwIfAborted();
    return Response.json({ boolean: true });
  });
  await fusekiReadBudget.run({ signal: request.signal, callsLeft: 1, bytesLeft: 4096 }, async () => {
    await expect(client(preparation).query('ASK {}')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  expect(preparation.aborted).toBe(false); expect(request.signal.aborted).toBe(false);
  expect(clock.timers.map(timer => timer.duration)).toEqual([540_000, 10_000]);
});

test('request cancellation remains effective when a preparation signal is configured', async () => {
  controlledClock();
  const preparation = AbortSignal.timeout(540_000), request = new AbortController(), reason = new Error('route cancelled');
  fetchStub(async (_url, init) => {
    request.abort(reason); requestSignal(init).throwIfAborted();
    return Response.json({ boolean: true });
  });
  await fusekiReadBudget.run({ signal: request.signal, callsLeft: 1, bytesLeft: 4096 }, async () => {
    await expect(client(preparation).query('ASK {}')).rejects.toBe(reason);
  });
  expect(preparation.aborted).toBe(false);
});

test('scoped call and byte accounting still applies to configured maintenance clients', async () => {
  controlledClock();
  const preparation = AbortSignal.timeout(540_000), request = new AbortController();
  const value = { boolean: true }, bytes = Buffer.byteLength(JSON.stringify(value));
  const fetch = fetchStub(async () => Response.json(value));
  const budget = { signal: request.signal, callsLeft: 1, bytesLeft: 4096 };
  await fusekiReadBudget.run(budget, async () => {
    expect(await client(preparation).query('ASK {}')).toEqual(value);
    expect(budget.callsLeft).toBe(0); expect(budget.bytesLeft).toBe(4096 - bytes);
    await expect(client(preparation).searchDeltaSince('-1')).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  await fusekiReadBudget.run({ signal: request.signal, callsLeft: 1, bytesLeft: bytes - 1 }, async () => {
    await expect(client(preparation).query('ASK {}')).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('maintenance reads preserve declared and streamed per-response byte refusals', async () => {
  controlledClock();
  const preparation = AbortSignal.timeout(540_000);
  for (const declared of [true, false]) {
    let cancelled = false;
    const fetch = fetchStub(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"boolean":true}')); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': '100' } : {} }));
    await expect(client(preparation).query('ASK {}', 8)).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
    expect(cancelled).toBe(true); fetch.mockRestore();
  }
});

const prepared = { status: 'committed' as const, complete: true, placements: 0, receipts: [], examined: 0, phase: 4, after: '', restarted: false };
test('membership preparation retries the exact request under its finite maintenance and absolute deadline', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000);
  const input = { dataEpoch: 'epoch', routingEpoch: 'routing', requestId: 'exact-request', deadline: Date.now() + 60_000 };
  const fetch = fetchStub(async (_url, init) => {
    clock.advance(11_001); requestSignal(init).throwIfAborted();
    if (fetch.mock.calls.length === 1) throw new TypeError('lost acknowledgment');
    return Response.json(prepared);
  });
  expect(await client(preparation).membershipPrepare(input)).toEqual(prepared);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1]?.body).toBe(fetch.mock.calls[1]![1]?.body);
  expect(fetch.mock.calls[0]![1]?.signal).toBe(fetch.mock.calls[1]![1]?.signal);
  expect(clock.timers.map(timer => timer.duration)).toEqual([540_000, 60_000]);
});

test('membership preparation honors explicit, configured and absolute cancellation without retrying', async () => {
  const clock = controlledClock();
  for (const source of ['explicit', 'configured', 'absolute'] as const) {
    const preparation = AbortSignal.timeout(540_000), explicit = new AbortController(), reason = new Error('explicit preparation cancelled');
    let signal: AbortSignal | undefined;
    const fetch = fetchStub(async (_url, init) => {
      signal = requestSignal(init);
      if (source === 'explicit') explicit.abort(reason);
      else clock.advance(source === 'configured' ? 540_000 : 60_000);
      signal.throwIfAborted();
      return Response.json(prepared);
    });
    const input = { dataEpoch: 'epoch', routingEpoch: 'routing', requestId: 'cancelled-request', deadline: Date.now() + (source === 'configured' ? 600_000 : 60_000) };
    const pending = client(preparation).membershipPrepare(input, explicit.signal);
    await expect(pending).rejects.toBe(signal?.reason);
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRestore();
  }
});

test('the interactive deadline cancels a stalled body even on a preparation client', async () => {
  const clock = controlledClock();
  const preparation = AbortSignal.timeout(540_000), request = new AbortController();
  let cancelled = false;
  let pulls = 0;
  fetchStub(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (++pulls === 1) controller.enqueue(new TextEncoder().encode('{'));
      else clock.advance(10_001);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 })));
  await fusekiReadBudget.run({ signal: request.signal, callsLeft: 1, bytesLeft: 4096 }, async () => {
    await expect(client(preparation).query('ASK {}')).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  expect(cancelled).toBe(true);
  expect(preparation.aborted).toBe(false);
}, 2000);

test('the scoped default response cap is retained when the enclosing byte budget is larger', async () => {
  controlledClock();
  const preparation = AbortSignal.timeout(540_000), request = new AbortController();
  let cancelled = false;
  fetchStub(async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
    cancel() { cancelled = true; },
  })));
  await fusekiReadBudget.run({ signal: request.signal, callsLeft: 1, bytesLeft: 4_194_304 }, async () => {
    await expect(client(preparation).query('ASK {}')).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
  });
  expect(cancelled).toBe(true);
});
