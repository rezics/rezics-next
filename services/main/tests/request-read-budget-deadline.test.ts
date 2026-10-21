import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import { FusekiClient, fusekiReadBudget, FusekiReadDeadlineExceeded, withFusekiReadRequest,
  type FusekiReadBudget } from '../src/infrastructure/fuseki.ts';
import { workRead, WorkReadMoved, WorkReadUnavailable } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const limits = { calls: 160, bytes: 4 * 1024 * 1024, deadlineMs: 2000 };
const result = { results: { bindings: [{ epoch: { type: 'literal', value: 'epoch' },
  sequence: { type: 'literal', value: '1' } }] } };
const request = (deadline?: string | number) => new Request('http://main.test/v1/works', {
  headers: deadline === undefined ? {} : { 'x-rezics-server-deadline': String(deadline) },
});
const scope = (deadline?: number): FusekiReadBudget => ({ callsLeft: 20, bytesLeft: 4096,
  signal: AbortSignal.timeout(2000), deadline });

/** Real HTTP transport; no composeMain, database, native engine or mixed-load proof. */
function fixture() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const headers: Headers[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => {
    headers.push(request.headers);
    if ((await request.text()).includes('held-deadline-read')) await held;
    return Response.json(result);
  } });
  const graph = new FusekiClient(server.url.href);
  const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } },
    access: { assertRecoveryOpen: async () => {} } } as unknown as MainWorkDependencies;
  return { graph, deps, headers, stop: async () => { release(); await server.stop(true); } };
}

test.each([false, true])('expired forwarded deadlines start no admission or native child (ambient: %s)', async ambient => {
  const f = fixture();
  let admitted = 0;
  const run = () => withFusekiReadRequest(request(Date.now() - 1), limits, async () => {
    admitted++;
    return f.graph.query('ASK {}');
  });
  try {
    await expect(ambient ? fusekiReadBudget.run(scope(), run) : run()).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(admitted).toBe(0);
    expect(f.headers).toHaveLength(0);
  } finally { await f.stop(); }
});

test('a partly spent Web deadline survives preflight, nested reads and a consistency retry', async () => {
  const f = fixture();
  const issuedAt = Date.now() - 1500;
  const operation = request(issuedAt + 2000);
  let rootDeadline = Infinity;
  let remainingAtEntry = Infinity;
  const attempts: { deadline: number; callsLeft: number }[] = [];
  try {
    const error: unknown = await withFusekiReadRequest(operation, limits, async () => {
      rootDeadline = fusekiReadBudget.getStore()!.deadline!;
      remainingAtEntry = rootDeadline - performance.now();
      await f.graph.query('ASK {}');
      await delay(40);
      expect(fusekiReadBudget.getStore()!.deadline).toBe(rootDeadline);
      return workRead(f.deps, operation, {}, async session => {
        const budget = fusekiReadBudget.getStore()!;
        attempts.push({ deadline: budget.deadline!, callsLeft: budget.callsLeft });
        await session.query(attempts.length === 1 ? 'SELECT ?value WHERE {}'
          : 'SELECT ?value WHERE { BIND("held-deadline-read" AS ?value) }', 1);
        if (attempts.length === 1) throw new WorkReadMoved('Selected dependency changed');
        return 'unreachable';
      });
    }).catch(error => error);
    expect(remainingAtEntry).toBeLessThanOrEqual(500);
    expect(attempts).toHaveLength(2);
    expect(attempts.every(attempt => attempt.deadline === rootDeadline)).toBe(true);
    expect(attempts[1]!.callsLeft).toBeLessThan(attempts[0]!.callsLeft);
    expect(error).toBeInstanceOf(WorkReadUnavailable);
    expect(error).toMatchObject({ code: 'work_read_deadline_exceeded', phase: 'read',
      cause: expect.any(FusekiReadDeadlineExceeded),
      diagnostics: { active: [], history: expect.arrayContaining([
        expect.objectContaining({ attempt: 2, status: 'aborted' }),
      ]) } });
    const allocations = f.headers.map(headers => Number(headers.get('x-rezics-read-budget-ms')));
    expect(allocations).toHaveLength(5);
    expect(allocations.every(ms => ms > 0 && ms <= 500)).toBe(true);
    expect(allocations.at(-1)!).toBeLessThan(allocations[0]!);
    await delay(40);
    expect(f.headers).toHaveLength(5);
    await withFusekiReadRequest(request(), limits, () => f.graph.query('ASK {}'));
    expect(f.headers).toHaveLength(6);
  } finally { await f.stop(); }
});

test('a distant forwarded deadline cannot extend the local deadline or transport cancellation timer', async () => {
  const f = fixture();
  try {
    await expect(withFusekiReadRequest(request(Number.MAX_SAFE_INTEGER), { ...limits, deadlineMs: 80 }, async () => {
      expect(fusekiReadBudget.getStore()!.deadline! - performance.now()).toBeLessThanOrEqual(80);
      return f.graph.query('SELECT ?value WHERE { BIND("held-deadline-read" AS ?value) }');
    })).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.headers).toHaveLength(1);
    expect(Number(f.headers[0]!.get('x-rezics-read-budget-ms'))).toBeLessThanOrEqual(80);
  } finally { await f.stop(); }
});

test.each([undefined, '', 'invalid', 'NaN', 'Infinity', '-1', '0', '1.5', '9007199254740992'])(
  'absent or malformed forwarded deadline retains the local cap: %s', async header => {
    let signal!: AbortSignal;
    await expect(withFusekiReadRequest(request(header), { ...limits, deadlineMs: 40 }, async () => {
      const budget = fusekiReadBudget.getStore()!;
      signal = budget.signal;
      expect(budget.deadline! - performance.now()).toBeLessThanOrEqual(40);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    })).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(signal.reason).toBeInstanceOf(FusekiReadDeadlineExceeded);
  });

test('a forwarded deadline retains a tighter ambient owner deadline and cancels its transport', async () => {
  const f = fixture();
  const deadline = performance.now() + 80;
  try {
    await expect(fusekiReadBudget.run(scope(deadline), () => withFusekiReadRequest(
      request(Date.now() + 1000), limits, async () => {
        expect(fusekiReadBudget.getStore()!.deadline).toBe(deadline);
        return f.graph.query('SELECT ?value WHERE { BIND("held-deadline-read" AS ?value) }');
      }))).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.headers).toHaveLength(1);
    expect(Number(f.headers[0]!.get('x-rezics-read-budget-ms'))).toBeLessThanOrEqual(80);
  } finally { await f.stop(); }
});

test('joining an ambient request shortens its original timer and cancels already running reads', async () => {
  const f = fixture();
  try {
    await expect(withFusekiReadRequest(request(), limits, async () => {
      const root = fusekiReadBudget.getStore()!;
      const running = f.graph.query('SELECT ?value WHERE { BIND("held-deadline-read" AS ?value) }')
        .catch(error => error);
      const shortened = fusekiReadBudget.run(scope(), () => withFusekiReadRequest(
        request(Date.now() + 80), limits, async () => {
          expect(root.deadline! - performance.now()).toBeLessThanOrEqual(80);
          return f.graph.query('SELECT ?value WHERE { BIND("held-deadline-read" AS ?value) }');
        })).catch(error => error);
      const errors: unknown[] = await Promise.all([running, shortened]);
      expect(errors.every(error => error instanceof FusekiReadDeadlineExceeded)).toBe(true);
      expect(root.signal.reason).toBeInstanceOf(FusekiReadDeadlineExceeded);
    })).rejects.toBeInstanceOf(FusekiReadDeadlineExceeded);
    expect(f.headers).toHaveLength(2);
  } finally { await f.stop(); }
});


test('native hops keep the absolute operation deadline across preflight and a tighter nested owner', async () => {
  const f = fixture();
  const absolute = Date.now() + 1500;
  try {
    await withFusekiReadRequest(request(absolute), limits, async () => {
      await f.graph.query('SELECT (1 AS ?value) WHERE {}');
      await delay(30);
      await fusekiReadBudget.run(scope(performance.now() + 500), async () => {
        await f.graph.query('SELECT (2 AS ?value) WHERE {}');
      });
    });
    expect(f.headers).toHaveLength(2);
    const deadlines = f.headers.map(headers => Number(headers.get('x-rezics-server-deadline')));
    expect(deadlines.every(deadline => Number.isSafeInteger(deadline) && deadline > 0 && deadline <= absolute)).toBe(true);
    expect(deadlines[1]!).toBeLessThan(deadlines[0]! - 500);
    expect(Number(f.headers[1]!.get('x-rezics-read-budget-ms'))).toBeLessThanOrEqual(500);
  } finally { await f.stop(); }
});
