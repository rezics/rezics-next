import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { FusekiClient, FusekiReadBudgetExceeded, FusekiReadDeadlineExceeded, fusekiReadBudget,
  snapshotFusekiReadDiagnostics, withFusekiReadRequest, type FusekiReadBudget, type FusekiReadObservation,
  type TemplateQueryEnvelope } from '../src/infrastructure/fuseki.ts';

const limits = { calls: 72, bytes: 8 * 1024 * 1024, deadlineMs: 10_000 };
const result = { boolean: true };
const bytes = Buffer.byteLength(JSON.stringify(result));
const capability = 'abc123'.repeat(10) + 'abcd';
const request = (signal?: AbortSignal) => new Request('http://main.test/v1/query', { signal });
const scope = (callsLeft: number, bytesLeft: number): FusekiReadBudget => ({
  signal: new AbortController().signal, callsLeft, bytesLeft,
});
const counters = (event: FusekiReadObservation) => event.allocations.map(owner => [owner.callsLeft, owner.bytesLeft]);
const keep = (events: FusekiReadObservation[]) => (event: FusekiReadObservation) => { events.push(event); };

function fixture(handler: (request: Request) => Response | Promise<Response> = () => Response.json(result)) {
  let transports = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    transports++;
    return handler(request);
  } });
  return { graph: new FusekiClient(server.url.href, capability, capability),
    transports: () => transports, stop: () => server.stop(true) };
}

test('private debit observation snapshots preflight and every nested getter allocation without double charging', async () => {
  const f = fixture(), events: FusekiReadObservation[] = [];
  const declared = { ...scope(5, 5 * bytes), attempt: 2, phase: 'read' as const, readPhase: 'hydration' };
  try {
    await withFusekiReadRequest(request(), { ...limits, calls: 9, bytes: 9 * bytes }, async () => {
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(declared, async () => {
        const parent = fusekiReadBudget.getStore()!;
        let calls = 3, remaining = 3 * bytes;
        await fusekiReadBudget.run({
          signal: parent.signal, attempt: 2, phase: 'writer-wait', readPhase: 'dependency-fence',
          deadline: performance.now() + 500,
          get callsLeft() { return Math.min(calls, parent.callsLeft); },
          set callsLeft(value) { const used = this.callsLeft - value; calls -= used; parent.callsLeft -= used; },
          get bytesLeft() { return Math.min(remaining, parent.bytesLeft); },
          set bytesLeft(value) { const used = this.bytesLeft - value; remaining -= used; parent.bytesLeft -= used; },
        }, () => f.graph.query('ASK {}'));
      });
    }, keep(events));
    const preflight = events.find(event => event.call === 1 && event.stage === 'before-debit')!;
    expect(counters(preflight)).toEqual([[9, 9 * bytes]]);
    const before = events.find(event => event.call === 2 && event.stage === 'before-debit')!;
    const after = events.find(event => event.call === 2 && event.stage === 'after-debit')!;
    const complete = events.find(event => event.call === 2 && event.stage === 'complete')!;
    expect(counters(before)).toEqual([[3, 3 * bytes], [5, 5 * bytes], [4, 4 * bytes]]);
    expect(counters(after)).toEqual([[2, 3 * bytes], [4, 5 * bytes], [3, 4 * bytes]]);
    expect(counters(complete)).toEqual([[2, 2 * bytes], [4, 4 * bytes], [3, 3 * bytes]]);
    expect(before.allocations[2]!.owner).toBe(preflight.allocations[0]!.owner);
    expect(before.allocations.map(owner => owner.owner)).toEqual(after.allocations.map(owner => owner.owner));
    expect(before.allocations[0]).toMatchObject({ attempt: 2, phase: 'writer-wait', readPhase: 'dependency-fence', aborted: false });
    expect(before.allocations.every(owner => owner.caller.includes('request-read-budget-observation.test.ts'))).toBe(true);
    expect(before.allocations[0]!.deadline).toBeLessThan(before.allocations[1]!.deadline!);
    expect(before).toMatchObject({ nativeMethod: 'query', endpoint: 'query', httpMethod: 'POST',
      status: 'active', httpStatus: null, actualBytes: 0 });
    expect(complete).toMatchObject({ status: 'complete', httpStatus: 200, actualBytes: bytes, cause: null });
    expect([declared.callsLeft, declared.bytesLeft]).toEqual([4, 4 * bytes]);
    expect(f.transports()).toBe(2);
  } finally { await f.stop(); }
});

test('a refused call debit is observed before transport with unchanged enclosing counters and no HTTP status', async () => {
  const f = fixture(), events: FusekiReadObservation[] = [];
  try {
    await expect(withFusekiReadRequest(request(), limits,
      () => fusekiReadBudget.run(scope(0, bytes), () => f.graph.query('ASK {}')), keep(events)))
      .rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.transports()).toBe(0);
    expect(events.map(event => event.stage)).toEqual(['before-debit', 'refused-debit', 'complete']);
    expect(counters(events[0]!)).toEqual([[0, bytes], [0, bytes]]);
    expect(counters(events[1]!)).toEqual(counters(events[0]!));
    expect(events[1]).toMatchObject({ status: 'refused', cause: 'call-budget',
      debit: { counter: 'callsLeft', amount: 1 }, httpStatus: null, actualBytes: 0, aborted: true });
    expect(events[1]!.allocations.every(owner => owner.aborted)).toBe(true);
  } finally { await f.stop(); }
});

test('a refused body debit reports delivered bytes and HTTP status without spending any enclosing bytes', async () => {
  const f = fixture(), events: FusekiReadObservation[] = [];
  try {
    await expect(withFusekiReadRequest(request(), { ...limits, bytes: bytes - 1 },
      () => f.graph.query('ASK {}'), keep(events))).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    const refusal = events.find(event => event.stage === 'refused-debit')!;
    expect(refusal).toMatchObject({ cause: 'byte-budget', httpStatus: 200, actualBytes: bytes,
      debit: { counter: 'bytesLeft', amount: bytes } });
    expect(counters(refusal)).toEqual([[71, bytes - 1]]);
    expect(events.at(-1)).toMatchObject({ status: 'refused', actualBytes: bytes });
    expect(f.transports()).toBe(1);
  } finally { await f.stop(); }
});

test('the private sink streams every debit beyond the existing bounded diagnostic history', async () => {
  const f = fixture(), events: FusekiReadObservation[] = [];
  try {
    await withFusekiReadRequest(request(), limits, async () => {
      for (let call = 0; call < 10; call++) await f.graph.query('ASK {}');
      expect(snapshotFusekiReadDiagnostics(fusekiReadBudget.getStore())?.history).toHaveLength(8);
    }, keep(events));
    expect(events.filter(event => event.stage === 'complete').map(event => event.call))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.filter(event => event.stage === 'before-debit')).toHaveLength(20);
    expect(events.filter(event => event.stage === 'after-debit')).toHaveLength(20);
    expect(f.transports()).toBe(10);
  } finally { await f.stop(); }
});

test('a transport refusal reports its HTTP status without reading or publishing its private error body', async () => {
  const f = fixture(() => new Response('private native diagnostic body', { status: 503 }));
  const events: FusekiReadObservation[] = [];
  try {
    await expect(withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'), keep(events)))
      .rejects.toMatchObject({ status: 503 });
    expect(events.at(-1)).toMatchObject({ stage: 'complete', status: 'failed', httpStatus: 503,
      actualBytes: 0, cause: 'failure' });
    expect(events).toHaveLength(3);
    expect(JSON.stringify(events)).not.toContain('private native diagnostic body');
  } finally { await f.stop(); }
});

const template: TemplateQueryEnvelope = { query: 'SELECT ?id WHERE { ?id <urn:private-predicate> ?value }',
  bindings: {}, tables: [], limit: 1 };
const health = { moduleVersion: '0.5.43', instanceId: '00000000-0000-4000-8000-000000000001',
  publicSearchWriteEpoch: '0', publicSearchWriteActive: false, profiles: {} };
const entries: { name: string; call: (graph: FusekiClient) => Promise<unknown>; value: unknown; query?: string }[] = [
  { name: 'query', call: (graph: FusekiClient) => graph.query(template.query), value: result, query: template.query },
  { name: 'templateQuery', call: (graph: FusekiClient) => graph.templateQuery(template), value: result, query: template.query },
  { name: 'commandHealth', call: (graph: FusekiClient) => graph.commandHealth(), value: health },
  { name: 'searchDeltaSince', call: (graph: FusekiClient) => graph.searchDeltaSince('-1'), value: { available: false } },
  { name: 'alsoEnjoyedCandidates', call: (graph: FusekiClient) => graph.alsoEnjoyedCandidates({
    source: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001', types: [], language: null, realm: null, limit: 1 }),
    value: { works: [], examined: 0 } },
  { name: 'prefixWalk', call: (graph: FusekiClient) => graph.prefixWalk({ prefix: 'secret', language: null, pageSize: 1, cursor: null }),
    value: { examined: 0 } },
  { name: 'templateIndex', call: (graph: FusekiClient) => graph.templateIndex({ operation: 'basis', keys: [] }), value: { bases: [] } },
  { name: 'membershipPreparationStatus', call: (graph: FusekiClient) => graph.membershipPreparationStatus(), value: { needsPreparation: false } },
  { name: 'membershipPrepare', call: (graph: FusekiClient) => graph.membershipPrepare({ dataEpoch: 'epoch', routingEpoch: 'routing',
    requestId: 'prepare', deadline: Date.now() + 1000 }),
    value: { status: 'committed', complete: true, placements: 0, examined: 0, receipts: [], phase: 4, after: '', restarted: false } },
  { name: 'prepareWorkScopeDirectory', call: (graph: FusekiClient) => graph.prepareWorkScopeDirectory(),
    value: { status: 'prepared', phase: 'complete', more: false } },
];

test.each(entries)('every existing read debit identifies $name with private query hashes and exact body bytes', async entry => {
  const f = fixture(() => Response.json(entry.value)), events: FusekiReadObservation[] = [];
  try {
    await withFusekiReadRequest(request(), limits, () => entry.call(f.graph), keep(events));
    const query = entry.query;
    const complete = events.at(-1)!;
    expect(complete).toMatchObject({ nativeMethod: entry.name, httpStatus: 200, status: 'complete',
      actualBytes: Buffer.byteLength(JSON.stringify(entry.value)),
      queryHash: query ? createHash('sha256').update(query).digest('hex') : null });
    expect(events.filter(event => event.stage === 'before-debit').map(event => event.debit?.counter))
      .toEqual(['callsLeft', 'bytesLeft']);
    expect(complete.caller).toContain('request-read-budget-observation.test.ts');
    const serialized = JSON.stringify(events);
    for (const privateText of [capability, template.query, 'urn:private-predicate', 'Bearer', '"prefix":"secret"']) {
      expect(serialized).not.toContain(privateText);
    }
  } finally { await f.stop(); }
});

test('concurrent requests keep separate observers, owner snapshots and attempt numbers', async () => {
  const f = fixture(), first: FusekiReadObservation[] = [], second: FusekiReadObservation[] = [];
  try {
    await Promise.all([
      withFusekiReadRequest(request(), limits, () => fusekiReadBudget.run({ ...scope(2, 2 * bytes), attempt: 1 }, async () => {
        await f.graph.query('ASK { <urn:first> ?p ?o }');
        fusekiReadBudget.getStore()!.attempt = 2;
        await f.graph.query('ASK { <urn:retry> ?p ?o }');
      }), keep(first)),
      withFusekiReadRequest(request(), limits, () => fusekiReadBudget.run({ ...scope(1, bytes), attempt: 7 },
        () => f.graph.query('ASK { <urn:second> ?p ?o }')), keep(second)),
    ]);
    expect(first.filter(event => event.stage === 'complete').map(event => [event.call, event.allocations[0]!.attempt]))
      .toEqual([[1, 1], [2, 2]]);
    expect(second.filter(event => event.stage === 'complete').map(event => [event.call, event.allocations[0]!.attempt]))
      .toEqual([[1, 7]]);
    expect(first.every(event => event.queryHash !== second[0]!.queryHash)).toBe(true);
    expect(counters(first.at(-1)!)).toEqual([[0, 0], [0, 0]]);
    expect(counters(second.at(-1)!)).toEqual([[0, 0], [0, 0]]);
    expect(f.transports()).toBe(3);
  } finally { await f.stop(); }
});

test.each(['throw', 'reject', 'mutate', 'pending'] as const)(
  'observer %s cannot alter the allocation, result, context or completion', async failure => {
    const f = fixture(), events: FusekiReadObservation[] = [], contexts: unknown[] = [];
    try {
      const owner = scope(1, bytes);
      const answer = await fusekiReadBudget.run(owner, () => withFusekiReadRequest(request(), limits,
        () => f.graph.query('ASK {}'), event => {
          events.push(event); contexts.push(fusekiReadBudget.getStore());
          if (failure === 'reject') return Promise.reject(new Error('observer rejected'));
          if (failure === 'pending') return new Promise<void>(() => {});
          if (failure === 'mutate') {
            (event.allocations[0] as { callsLeft: number }).callsLeft = 1000;
            return;
          }
          throw new Error('observer failed');
        }));
      expect(answer).toEqual(result);
      expect([owner.callsLeft, owner.bytesLeft]).toEqual([0, 0]);
      expect(contexts.every(context => context === undefined)).toBe(true);
      expect(events.at(-1)).toMatchObject({ status: 'complete', httpStatus: 200, actualBytes: bytes });
      expect(f.transports()).toBe(1);
    } finally { await f.stop(); }
  });

test('observation detaches after completion inside a still-active parent and restores its prior sink', async () => {
  const f = fixture(), outer: FusekiReadObservation[] = [], inner: FusekiReadObservation[] = [];
  try {
    await fusekiReadBudget.run(scope(4, 4 * bytes), () => withFusekiReadRequest(request(), limits, async () => {
      await f.graph.query('ASK {}');
      await withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'), keep(inner));
      await f.graph.query('ASK {}');
    }, keep(outer)));
    expect(outer.filter(event => event.stage === 'complete').map(event => event.call)).toEqual([1, 2]);
    expect(inner.filter(event => event.stage === 'complete').map(event => event.call)).toEqual([1]);
    // A different owner has no access to either completed observation lifetime.
    await withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'));
    expect(outer.filter(event => event.stage === 'complete')).toHaveLength(2);
    expect(inner.filter(event => event.stage === 'complete')).toHaveLength(1);
    expect(f.transports()).toBe(4);
  } finally { await f.stop(); }
});

test.each(['deadline', 'caller'] as const)('observation preserves %s cancellation and an independent fresh retry', async mode => {
  const events: FusekiReadObservation[] = [], retry: FusekiReadObservation[] = [];
  let bodyStarted!: () => void;
  const started = new Promise<void>(resolve => { bodyStarted = resolve; });
  let first = true;
  const f = fixture(() => {
    if (!first) return Response.json(result);
    first = false;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  });
  const controller = new AbortController(), reason = new Error('private cancellation detail');
  try {
    const req = mode === 'deadline' ? new Request('http://main.test/v1/query', {
      headers: { 'x-rezics-server-deadline': String(Date.now() + 150) }, signal: controller.signal }) : request(controller.signal);
    const pending = withFusekiReadRequest(req, limits, () => f.graph.query('ASK {}'), event => {
      events.push(event);
      if (event.stage === 'after-debit' && event.debit?.counter === 'bytesLeft') bodyStarted();
    });
    const settled = pending.catch(error => error);
    await started;
    if (mode === 'caller') controller.abort(reason);
    const error = await settled;
    if (mode === 'caller') expect(error).toBe(reason);
    else { expect(error).toBeInstanceOf(FusekiReadDeadlineExceeded); expect(controller.signal.aborted).toBe(false); }
    expect(events.at(-1)).toMatchObject({ stage: 'complete', status: 'aborted', aborted: true,
      httpStatus: 200, actualBytes: 1, cause: mode === 'deadline' ? 'deadline' : 'cancelled' });
    expect(f.transports()).toBe(1);
    const count = events.length;
    await withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'), keep(retry));
    expect(events).toHaveLength(count);
    expect(retry.at(-1)).toMatchObject({ call: 1, status: 'complete', cause: null });
    expect(JSON.stringify(events)).not.toContain(reason.message);
    expect(f.transports()).toBe(2);
  } finally { controller.abort(); await f.stop(); }
});

test('a completed request closes escaped continuations and its observer without starting later work', async () => {
  const f = fixture(), events: FusekiReadObservation[] = [];
  let release!: () => void, escaped!: Promise<unknown>;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    await withFusekiReadRequest(request(), limits, async () => {
      escaped = gate.then(() => f.graph.query('ASK {}')).catch(error => error);
      await f.graph.query('ASK {}');
    }, keep(events));
    const count = events.length;
    release();
    expect(await escaped).toBeInstanceOf(DOMException);
    expect(f.transports()).toBe(1);
    expect(events).toHaveLength(count);
    expect(fusekiReadBudget.getStore()).toBeUndefined();
  } finally { release(); await f.stop(); }
});
