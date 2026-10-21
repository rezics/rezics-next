import { expect, test } from 'bun:test';
import { FusekiClient, fusekiReadBudget, FusekiReadBudgetExceeded, withFusekiReadRequest,
  type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { CONTRIBUTION_CREATE_READ_COST, withContributionGraphRead } from '../src/modules/contribution/draft.ts';

const result = { boolean: true };
const bytes = Buffer.byteLength(JSON.stringify(result));
const limits = { calls: 160, bytes: 4 * 1024 * 1024, deadlineMs: 10_000 };
const request = (signal?: AbortSignal) => new Request('http://main.test/v1/main-versions/default/selection', { signal });
const scope = (callsLeft: number, bytesLeft = 1_000_000): FusekiReadBudget => ({
  callsLeft, bytesLeft, signal: AbortSignal.timeout(10_000),
});

function fixture() {
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    calls++;
    return Response.json(result);
  } });
  const graph = new FusekiClient(server.url.href, 'a'.repeat(64), 'a'.repeat(64));
  return { graph, calls: () => calls, stop: () => server.stop(true) };
}

test('a first exact-draft reservation preserves spent preflight and the later publication fence', async () => {
  const f = fixture();
  try {
    await withFusekiReadRequest(request(), limits, async () => {
      const root = fusekiReadBudget.getStore()!;
      // Admission, language heads and the exact selected publication precede
      // readExactContributionDraft's existing five-call reservation.
      for (let i = 0; i < 3; i++) await f.graph.query('ASK {}');
      await withContributionGraphRead(5, undefined, async () => {
        const draft = fusekiReadBudget.getStore()!;
        expect(draft.callsLeft).toBe(5);
        for (let i = 0; i < 4; i++) await f.graph.query('ASK {}');
        expect(draft.callsLeft).toBe(1);
        expect(draft.bytesLeft).toBe(5 * CONTRIBUTION_CREATE_READ_COST.responseBytes - 4 * bytes);
      });
      expect([root.callsLeft, root.bytesLeft]).toEqual([limits.calls - 7, limits.bytes - 7 * bytes]);
      await f.graph.query('ASK {}');
      expect([root.callsLeft, root.bytesLeft]).toEqual([limits.calls - 8, limits.bytes - 8 * bytes]);
    });
    expect(f.calls()).toBe(8);
  } finally { await f.stop(); }
});

test('later reservations and ordinary nested owners charge every enclosing allocation exactly once', async () => {
  const f = fixture();
  const owner = scope(10);
  try {
    await expect(withFusekiReadRequest(request(), limits, async () => {
      const root = fusekiReadBudget.getStore()!;
      await f.graph.query('ASK {}');
      await fusekiReadBudget.run(owner, async () => {
        await withContributionGraphRead(5, undefined, async () => {
          for (let i = 0; i < 3; i++) await f.graph.query('ASK {}');
        });
        expect([owner.callsLeft, root.callsLeft]).toEqual([7, 6]);
        expect([owner.bytesLeft, root.bytesLeft]).toEqual([1_000_000 - 3 * bytes, 1_000_000 - 4 * bytes]);
        await withContributionGraphRead(2, undefined, async () => { await f.graph.query('ASK {}'); });
        expect([owner.callsLeft, root.callsLeft]).toEqual([6, 5]);
        await fusekiReadBudget.run(scope(20), async () => {
          for (let i = 0; i < 5; i++) await f.graph.query('ASK {}');
          await f.graph.query('ASK {}');
        });
      });
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.calls()).toBe(10);
    expect(owner.callsLeft).toBe(1);
  } finally { await f.stop(); }
});

test('reservation through an accessor owner does not charge its already-reserved ancestors again', async () => {
  const f = fixture();
  try {
    await withFusekiReadRequest(request(), limits, async () => {
      const root = fusekiReadBudget.getStore()!;
      let calls = 10, left = 1_000_000;
      const linked: FusekiReadBudget = {
        signal: AbortSignal.timeout(10_000),
        get callsLeft() { return Math.min(calls, root.callsLeft); },
        set callsLeft(value) { const used = this.callsLeft - value; calls -= used; root.callsLeft -= used; },
        get bytesLeft() { return Math.min(left, root.bytesLeft); },
        set bytesLeft(value) { const used = this.bytesLeft - value; left -= used; root.bytesLeft -= used; },
      };
      await fusekiReadBudget.run(linked, async () => {
        await withContributionGraphRead(5, undefined, async () => {
          for (let i = 0; i < 3; i++) await f.graph.query('ASK {}');
        });
        expect([linked.callsLeft, root.callsLeft, calls]).toEqual([7, 7, 7]);
        expect([linked.bytesLeft, root.bytesLeft, left]).toEqual(Array(3).fill(1_000_000 - 3 * bytes));
      });
    });
    expect(f.calls()).toBe(3);
  } finally { await f.stop(); }
});

test('concurrent fully reserved children can spend only their own allocation', async () => {
  const f = fixture();
  const owner = scope(6);
  let start!: () => void;
  const ready = new Promise<void>(resolve => { start = resolve; });
  try {
    await withFusekiReadRequest(request(), limits, () => fusekiReadBudget.run(owner, async () => {
      const readers = [0, 1].map(() => withContributionGraphRead(3, undefined, async () => {
        await ready;
        for (let i = 0; i < 3; i++) await f.graph.query('ASK {}');
        expect(fusekiReadBudget.getStore()!.callsLeft).toBe(0);
      }));
      expect(owner.callsLeft).toBe(0);
      start();
      await Promise.all(readers);
      expect(owner.callsLeft).toBe(0);
      expect(owner.bytesLeft).toBe(1_000_000 - 6 * bytes);
    }));
    expect(f.calls()).toBe(6);
  } finally { start(); await f.stop(); }
});

test('a reserved child cannot exceed its own call cap or renew the operation', async () => {
  const f = fixture();
  try {
    await expect(withFusekiReadRequest(request(), limits, () => withContributionGraphRead(2, undefined, async () => {
      await f.graph.query('ASK {}');
      await f.graph.query('ASK {}');
      await f.graph.query('ASK {}');
    }))).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.calls()).toBe(2);
  } finally { await f.stop(); }
});

test('a handled reserved-child refusal still closes the request and its later fence', async () => {
  const f = fixture();
  let refusal: unknown;
  try {
    const stopped = await withFusekiReadRequest(request(), limits, async () => {
      try {
        await withContributionGraphRead(1, undefined, async () => {
          await f.graph.query('ASK {}');
          await f.graph.query('ASK {}');
        });
      } catch (error) { refusal = error; }
      expect(refusal).toBeInstanceOf(FusekiReadBudgetExceeded);
      expect(fusekiReadBudget.getStore()!.signal.reason).toBe(refusal);
      await f.graph.query('ASK {}');
    }).catch(error => error);
    expect(stopped).toBe(refusal);
    expect(f.calls()).toBe(1);
  } finally { await f.stop(); }
});

test.each(['calls', 'bytes'] as const)('a reservation larger than the remaining fallback %s is refused before transport', async counter => {
  const f = fixture();
  const cap = { ...limits, ...(counter === 'calls' ? { calls: 2 }
    : { bytes: 2 * CONTRIBUTION_CREATE_READ_COST.responseBytes }) };
  try {
    await expect(withFusekiReadRequest(request(), cap, async () => {
      await f.graph.query('ASK {}');
      await withContributionGraphRead(2, undefined, async () => { await f.graph.query('ASK {}'); });
    })).rejects.toBeInstanceOf(FusekiReadBudgetExceeded);
    expect(f.calls()).toBe(1);
  } finally { await f.stop(); }
});

test('cancellation closes a reserved child and final fence while a fresh request retains an independent budget', async () => {
  const f = fixture();
  const controller = new AbortController();
  const reason = new Error('reader left during exact draft');
  let failedRoot: FusekiReadBudget | undefined;
  try {
    await expect(withFusekiReadRequest(request(controller.signal), limits, async () => {
      failedRoot = fusekiReadBudget.getStore()!;
      await f.graph.query('ASK {}');
      await withContributionGraphRead(5, undefined, async () => {
        await f.graph.query('ASK {}');
        controller.abort(reason);
        await f.graph.query('ASK {}');
      });
      await f.graph.query('ASK {}');
    })).rejects.toBe(reason);
    expect(f.calls()).toBe(2);
    expect([failedRoot!.callsLeft, failedRoot!.bytesLeft]).toEqual([limits.calls - 2, limits.bytes - 2 * bytes]);
    await withFusekiReadRequest(request(), limits, () => withContributionGraphRead(5, undefined,
      async () => { await f.graph.query('ASK {}'); }));
    expect(f.calls()).toBe(3);
  } finally { controller.abort(); await f.stop(); }
});
