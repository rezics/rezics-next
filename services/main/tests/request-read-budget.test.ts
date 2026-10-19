import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FusekiClient, fusekiReadBudget, withFusekiReadRequest, FusekiReadBudgetExceeded,
  FusekiReadDeadlineExceeded, createFusekiReadDiagnostics, snapshotFusekiReadDiagnostics,
  type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { GraphReadFence } from '../src/infrastructure/graph-read-fence.ts';
import { workRead, publicWorkRead, WorkReadUnavailable, WorkReadMoved, WorkReadLimit }
  from '../src/modules/work/read-session.ts';
import { publicLanguageRequest } from '../src/modules/display-language/public-request.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { runWorkerTick } from '../src/worker-tick.ts';

const queryResult = { results: { bindings: [{ epoch: { type: 'literal', value: 'epoch' },
  sequence: { type: 'literal', value: '1' } }] } };
const bytes = Buffer.byteLength(JSON.stringify(queryResult));
const limits = { calls: 160, bytes: 4 * 1024 * 1024, deadlineMs: 10_000 };
const request = (signal?: AbortSignal) => new Request('http://main.test/v1/works', { signal });
const scope = (callsLeft: number, bytesLeft = 4096): FusekiReadBudget => ({
  callsLeft, bytesLeft, signal: AbortSignal.timeout(10_000),
});

function fixture(handler?: (request: Request) => Response | Promise<Response>) {
  const headers: Headers[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
    headers.push(request.headers);
    return handler ? handler(request) : Response.json(queryResult);
  } });
  const graph = new FusekiClient(server.url.href, 'a'.repeat(64), 'a'.repeat(64));
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  return { graph, deps, headers, stop: () => server.stop(true) };
}

test.each(['preflight', 'declared'] as const)(
  'budget exit clears callback and descendant context and restores the %s caller', async phase => {
    await withFusekiReadRequest(request(), limits, async () => {
      const check = async () => {
        const caller = fusekiReadBudget.getStore();
        expect(caller).toBeDefined();
        expect(fusekiReadBudget.exit((value: number) => {
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          return value;
        }, 7)).toBe(7);
        expect(fusekiReadBudget.getStore()).toBe(caller);

        const detached = fusekiReadBudget.exit(async () => {
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          await Promise.resolve();
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          await delay(0);
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          return 'detached';
        });
        expect(fusekiReadBudget.getStore()).toBe(caller);
        expect(await detached).toBe('detached');
        expect(fusekiReadBudget.getStore()).toBe(caller);

        const reason = new Error('detached callback failed');
        expect(() => fusekiReadBudget.exit((error: Error) => {
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          throw error;
        }, reason)).toThrow(reason);
        expect(fusekiReadBudget.getStore()).toBe(caller);
        await expect(fusekiReadBudget.exit(async () => {
          await delay(0);
          expect(fusekiReadBudget.getStore()).toBeUndefined();
          throw reason;
        })).rejects.toBe(reason);
        expect(fusekiReadBudget.getStore()).toBe(caller);
      };
      if (phase === 'declared') await fusekiReadBudget.run(scope(3), check);
      else await check();
    });
    expect(fusekiReadBudget.getStore()).toBeUndefined();
  });

test('a detached worker selects its own bounded allocation without renewing a cancelled caller', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('request left before the scheduled worker tick');
  const callerBudget = scope(3, 3 * bytes);
  const workerBudget = { ...scope(1, bytes), deadline: performance.now() + 1000 };
  try {
    await expect(withFusekiReadRequest(request(controller.signal), limits, async () => {
      const root = fusekiReadBudget.getStore()!;
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(callerBudget, async () => {
        const caller = fusekiReadBudget.getStore()!;
        await f.graph.query('ASK {}');
        expect([root.callsLeft, root.bytesLeft]).toEqual([1, bytes]);
        expect([caller.callsLeft, caller.bytesLeft]).toEqual([2, 2 * bytes]);

        // Like a request-triggered nudge, this timer inherits the caller before
        // explicitly exiting it to create the worker tick and its own owner.
        const detached = delay(0).then(() => {
          expect(fusekiReadBudget.getStore()).toBe(caller);
          expect(caller.signal.reason).toBe(reason);
          return fusekiReadBudget.exit(() => runWorkerTick('main.request-budget.detached', () =>
            withFusekiReadRequest(request(), { calls: 1, bytes, deadlineMs: 1000 }, () =>
              fusekiReadBudget.run(workerBudget, async () => {
                const worker = fusekiReadBudget.getStore()!;
                expect(worker).not.toBe(caller);
                expect(worker.signal.aborted).toBe(false);
                expect(worker.deadline).toBeLessThanOrEqual(workerBudget.deadline);
                await f.graph.query('ASK {}');
                expect([worker.callsLeft, worker.bytesLeft]).toEqual([0, 0]);
                await expect(f.graph.query('ASK {}')).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
              }))));
        });
        const workerStopped = detached.catch(error => error);
        controller.abort(reason);
        await expect(f.graph.query('ASK {}')).rejects.toBe(reason);
        expect(await workerStopped).toBeInstanceOf(FusekiReadBudgetExceeded);
        expect(fusekiReadBudget.getStore()).toBe(caller);
        expect(caller.signal.reason).toBe(reason);
        await expect(f.graph.query('ASK {}')).rejects.toBe(reason);
        expect([root.callsLeft, root.bytesLeft]).toEqual([1, bytes]);
        expect([caller.callsLeft, caller.bytesLeft]).toEqual([2, 2 * bytes]);
      });
    })).rejects.toBe(reason);
    expect(fusekiReadBudget.getStore()).toBeUndefined();
    expect(f.headers).toHaveLength(3);
    expect(f.headers.every(headers => Number(headers.get('x-rezics-read-budget-ms')) > 0)).toBe(true);
    expect([workerBudget.callsLeft, workerBudget.bytesLeft]).toEqual([0, 0]);
    expect([callerBudget.callsLeft, callerBudget.bytesLeft]).toEqual([2, 2 * bytes]);
  } finally { controller.abort(); await f.stop(); }
});

test('preflight, plain nested scopes and sibling owners spend one request allocation', async () => {
  const f = fixture();
  const first = scope(3), sibling = scope(3);
  try {
    await expect(withFusekiReadRequest(request(), limits, async () => {
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(first, () => f.graph.query('ASK {}'));
      await fusekiReadBudget.run(sibling, async () => {
        await f.graph.query('ASK {}');
        await f.graph.query('ASK {}');
      });
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.headers).toHaveLength(3);
    expect(first.callsLeft).toBe(2);
    expect(sibling.callsLeft).toBe(2);
  } finally { await f.stop(); }
});

test('existing accessor budgets debit each ancestor once, including preflight response bytes', async () => {
  const f = fixture();
  const outer = scope(4, 4 * bytes);
  try {
    await withFusekiReadRequest(request(), limits, async () => {
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(outer, async () => {
        const parent = fusekiReadBudget.getStore()!;
        let calls = 3, left = 3 * bytes;
        const linked: FusekiReadBudget = {
          signal: AbortSignal.timeout(10_000),
          get callsLeft() { return Math.min(calls, parent.callsLeft); },
          set callsLeft(value) { const used = this.callsLeft - value; calls -= used; parent.callsLeft -= used; },
          get bytesLeft() { return Math.min(left, parent.bytesLeft); },
          set bytesLeft(value) { const used = this.bytesLeft - value; left -= used; parent.bytesLeft -= used; },
        };
        await fusekiReadBudget.run(linked, () => f.graph.query('ASK {}'));
        expect(calls).toBe(2);
        expect(left).toBe(2 * bytes);
        expect(outer.callsLeft).toBe(3);
        expect(outer.bytesLeft).toBe(3 * bytes);
        expect(parent.callsLeft).toBe(3);
        expect(parent.bytesLeft).toBe(3 * bytes);
        await f.graph.query('ASK {}');
      });
    });
    expect(f.headers).toHaveLength(3);
    expect(outer.callsLeft).toBe(2);
    expect(outer.bytesLeft).toBe(2 * bytes);
  } finally { await f.stop(); }
});

test('response bytes cannot be renewed by entering another owner', async () => {
  const f = fixture();
  try {
    await expect(withFusekiReadRequest(request(), limits, async () => {
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(scope(20, 2 * bytes + 1), () => f.graph.query('ASK {}'));
      await fusekiReadBudget.run(scope(20, 4096), () => f.graph.query('ASK {}'));
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.headers).toHaveLength(3);
  } finally { await f.stop(); }
});

test('selecting an allocation smaller than preflight already spent cannot return a result', async () => {
  const f = fixture();
  try {
    await expect(withFusekiReadRequest(request(), limits, async () => {
      await f.graph.query('ASK {}');
      await f.graph.query('ASK {}');
      return fusekiReadBudget.run(scope(1), async () => 'unfunded result');
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.headers).toHaveLength(2);
  } finally { await f.stop(); }
});

test('native reads receive a shrinking wall allocation without requiring search diagnostics', async () => {
  const f = fixture(async request => {
    if (request.method === 'GET') return Response.json({ moduleVersion: '0.5.43',
      instanceId: '00000000-0000-4000-8000-000000000001', publicSearchWriteEpoch: '0',
      publicSearchWriteActive: false, profiles: {} });
    if (request.headers.get('content-type') === 'application/json'
      && (await request.json() as { templateIndex?: { operation?: string } }).templateIndex?.operation === 'membership-status')
      return Response.json({ needsPreparation: false });
    return Response.json(queryResult);
  });
  const budget = { ...scope(5), deadline: performance.now() + 1000 };
  try {
    await fusekiReadBudget.run(budget, async () => {
      await f.graph.commandHealth();
      await delay(20);
      await f.graph.query('ASK {}');
      await f.graph.templateQuery({ query: 'SELECT ?id WHERE {}', bindings: {}, tables: [], limit: 1 });
      await f.graph.templateIndex({ operation: 'basis', keys: [] });
      await f.graph.membershipPreparationStatus();
    });
    const allocations = f.headers.map(headers => Number(headers.get('x-rezics-read-budget-ms')));
    expect(allocations).toHaveLength(5);
    expect(allocations.every(ms => ms > 0 && ms <= 1000)).toBe(true);
    expect(allocations[1]!).toBeLessThan(allocations[0]!);
    expect(f.headers.every(headers => !headers.has('x-rezics-search-budget-ms'))).toBe(true);
  } finally { await f.stop(); }
});

test('a passed monotonic deadline refuses work even before its abort timer has run', async () => {
  const f = fixture();
  try {
    await expect(fusekiReadBudget.run({ ...scope(2), deadline: performance.now() - 1 },
      () => f.graph.query('ASK {}'))).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.headers).toHaveLength(0);
  } finally { await f.stop(); }
});

test('public requests preserve cancellation while discarding bearer authority', async () => {
  const controller = new AbortController();
  const original = new Request('http://main.test/v1/works', {
    signal: controller.signal, headers: { authorization: 'Bearer private' },
  });
  const publicRequest = publicLanguageRequest(original);
  controller.abort();
  expect(publicRequest.signal.aborted).toBe(true);
  expect(publicRequest.headers.has('authorization')).toBe(false);
  const f = fixture();
  try {
    await expect(publicWorkRead(f.deps, original, {}, async () => 'unreachable')).rejects.toBe(controller.signal.reason);
    expect(f.headers).toHaveLength(0);
  } finally { await f.stop(); }
});

test('aborted requests cannot replay retained graph inputs or schedule a fallback', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('retained graph request cancelled');
  try {
    await expect(withFusekiReadRequest(request(controller.signal), limits, async () => {
      const fence = new GraphReadFence(f.graph);
      await fence.capture(() => f.graph.query('ASK {}'));
      controller.abort(reason);
      await fence.verify(() => f.graph.query('ASK {}'));
    })).rejects.toBe(reason);
    expect(f.headers).toHaveLength(1);
  } finally { await f.stop(); }
});

test('cancellation stops scheduling after an in-flight transport and permits an independent retry', async () => {
  let release!: () => void;
  const active = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { release(); await delay(100); return Response.json(queryResult); });
  const controller = new AbortController();
  const diagnostics = createFusekiReadDiagnostics();
  try {
    const pending = withFusekiReadRequest(request(controller.signal), limits,
      () => fusekiReadBudget.run({ ...scope(20), diagnostics }, async () => {
        for (let item = 0; item < 10; item++) await f.graph.query('ASK {}');
      }));
    const settled = pending.catch(error => error);
    await active;
    const started = performance.now();
    controller.abort();
    expect(await settled).toBe(controller.signal.reason);
    expect(performance.now() - started).toBeLessThan(100);
    expect(snapshotFusekiReadDiagnostics({ ...scope(1), diagnostics })?.active).toEqual([]);
    await delay(150);
    expect(f.headers).toHaveLength(1);
    await withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'));
    expect(f.headers).toHaveLength(2);
  } finally { controller.abort(); await f.stop(); }
});

test('cancelled authority fences stop before another owner, retaining the phase and cause', async () => {
  const f = fixture();
  const controller = new AbortController();
  let authority = 0, operation = 0;
  f.deps.access.assertRecoveryOpen = async () => { authority++; };
  try {
    const error = await workRead(f.deps, request(controller.signal), {}, async session => {
      operation++;
      session.observeDependency('cancel-in-fence', true, async () => { controller.abort(); return true; });
      session.observeDependency('later-owner', true, async () => { throw new Error('cancelled read scheduled an owner'); });
      return 'private result';
    }).catch(error => error);
    expect(error).toBeInstanceOf(WorkReadUnavailable);
    expect(error).toMatchObject({ code: 'work_read_cancelled', phase: 'dependency-fence', cause: controller.signal.reason });
    expect(operation).toBe(1);
    expect(authority).toBe(0);
  } finally { await f.stop(); }
});

test('every retry and final fence spends from the original call allocation', async () => {
  const f = fixture();
  const budget = scope(4);
  let attempts = 0;
  try {
    await expect(fusekiReadBudget.run(budget, () => workRead(f.deps, request(), {}, async session => {
      attempts++;
      await session.query('SELECT ?epoch WHERE {}', 1);
      throw new WorkReadMoved('Selected dependency changed');
    }))).rejects.toBeInstanceOf(WorkReadUnavailable);
    expect(attempts).toBe(2);
    expect(f.headers).toHaveLength(4);
    expect(budget.callsLeft).toBe(0);
  } finally { await f.stop(); }
});

test('dependency and authority fences cannot exceed the request allocation', async () => {
  const f = fixture();
  const budget = scope(3);
  f.deps.access.assertRecoveryOpen = async () => { await f.graph.query('ASK {}'); };
  try {
    await expect(fusekiReadBudget.run(budget, () => workRead(f.deps, request(), {},
      session => session.query('SELECT ?epoch WHERE {}', 1)))).rejects.toBeInstanceOf(WorkReadLimit);
    expect(f.headers).toHaveLength(3);
    expect(budget.callsLeft).toBe(0);
  } finally { await f.stop(); }
});
