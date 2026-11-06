import { expect, test } from 'bun:test';
import { collectRetainedUsefulPage } from '../../src/search/useful-page.ts';
import { readPublicSearchPage } from '../../src/search/public-runtime.ts';
import { decodeSearchCursor, encodeRetainedSearchCursor, retainedSearchContinuation } from '../../src/search/cursor.ts';
import type {
  PublicFilterConsumerOperations,
  PublicFilterConsumerQuery,
  PublicFilterQueriedObservation,
} from '../../src/search/public-filter-consumer-contract.ts';
import type { SearchHit } from '../../src/search/query.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const hit = (id: string, ordinal: number): SearchHit => ({
  id,
  index: 'unit',
  partition: 0,
  securityRevision: 1,
  matched: [],
  sort: [ordinal],
});
const check = async (hits: readonly SearchHit[]) => new Map(hits.map((h) => [h, h.id]));
const consumer = {
  physicalTarget: 'unit',
  incarnation: 'native-test-incarnation',
  consumerGeneration: '1',
  projectionGeneration: '1',
  meaningDigest: 'meaning',
  readDefinition: 'definition',
};
const queried: PublicFilterQueriedObservation = {
  consumer,
  snapshot: { kind: 'prepared', observation: 'observation', build: 'build', generation: 1n },
};
const repair = { consumer, job: 'retained-job' };
const cost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};
const context = () => ({ deadline: Date.now() + 10_000 });
const plan = { filterDocument: undefined, text: undefined, sort: 'name' as const, pageSize: 1, size: 3 };

function operations(overrides: Partial<PublicFilterConsumerOperations> = {}): PublicFilterConsumerOperations {
  return {
    capture: async () => ({ status: 'captured', queried, repair, cost }),
    captureDiscovery: async () => {
      throw new Error('unexpected mixed capture');
    },
    queryDiscovery: async () => {
      throw new Error('unexpected mixed query');
    },
    query: async () => ({
      status: 'queried',
      queried,
      execution: 'execution',
      start: { observation: 'start' },
      result: { hits: [], total: { value: 9999, relation: 'lower_bound' } },
      window: { positions: [], examined: 0, exhausted: true },
      cost,
    }),
    repairStep: async () => ({ status: 'settled', job: repair, cost }),
    readStatus: async () => ({
      status: 'observed',
      queried,
      covered: { observation: 'covered' },
      pending: [],
      changed: [],
      blocking: [],
      cost,
    }),
    closeObservation: async () => {},
    close: async () => {},
    ...overrides,
  };
}

test('host-bound capture is used without recapture or a second root reservation', async () => {
  const native = operations({
    capture: async () => {
      throw new Error('unexpected recapture');
    },
  });
  const read = await readPublicSearchPage({
    operations: native,
    plan,
    context: context(),
    check,
    canonicalId: (id) => id,
    capture: { status: 'captured', queried, repair, cost },
  });
  expect(read.page.status).toBe('exhausted');
  await read.finalize();
});

test('preparing host capture delivers only its actual durable locator without a foreground repair', async () => {
  const delivered: unknown[] = [];
  const native = operations({
    capture: async () => {
      throw new Error('unexpected recapture');
    },
    repairStep: async () => {
      throw new Error('unexpected competing repair');
    },
    query: async () => {
      throw new Error('preparing is not ready');
    },
  });
  await expect(
    readPublicSearchPage({
      operations: native,
      plan,
      context: context(),
      check,
      canonicalId: (id) => id,
      capture: { status: 'preparing', repair, cost },
      prepare: async (job) => {
        delivered.push(job);
      },
    }),
  ).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(delivered).toEqual([repair]);
});

test('retained windows consume raw ordinals and preserve filtered suffix and lookahead', async () => {
  const a = hit('canonical-a', 10);
  const duplicate = hit('canonical-a', 12);
  const b = hit('b', 15);
  const c = hit('c', 18);
  const calls: unknown[] = [];
  const first = await collectRetainedUsefulPage({
    limit: 2,
    check,
    canonicalId: (id) => id,
    read: async (size, refill) => {
      calls.push({ size, refill });
      return {
        execution: 'first',
        hits: [a, duplicate, b, c],
        window: { positions: [0, 1, 3, 4], examined: 5, exhausted: true },
      };
    },
  });
  expect(first.values).toEqual(['canonical-a', 'b']);
  expect(first.status).toBe('filled');
  expect(first.continuation).toEqual({ execution: 'first', consumed: 4 });
  expect(first.candidates).toBe(5);
  const last = await collectRetainedUsefulPage({
    limit: 2,
    continuation: first.continuation,
    check,
    canonicalId: (id) => id,
    read: async (size, refill) => {
      expect(refill).toEqual({ execution: 'first', consumed: 4, size });
      return { execution: 'last', hits: [c], window: { positions: [0], examined: 1, exhausted: true } };
    },
  });
  expect(last.values).toEqual(['c']);
  expect(last.status).toBe('exhausted');
  expect(calls).toEqual([{ size: 5, refill: undefined }]);
});

test('retained windows consume trailing rejects after a filled page and leave unused useful lookahead', async () => {
  const a = hit('a', 1);
  const hidden = hit('hidden', 2);
  const b = hit('b', 3);
  const alias = hit('alias-a', 4);
  const c = hit('c', 5);
  const result = await collectRetainedUsefulPage({
    limit: 2,
    check: async () =>
      new Map([
        [a, 'a'],
        [b, 'b'],
        [alias, 'a'],
        [c, 'c'],
      ]),
    canonicalId: (id) => id,
    read: async () => ({
      execution: 'filled',
      hits: [a, hidden, b, alias, c],
      window: { positions: [0, 1, 2, 3, 4], examined: 5, exhausted: false },
    }),
  });
  expect(result.values).toEqual(['a', 'b']);
  expect(result.status).toBe('filled');
  expect(result.continuation).toEqual({ execution: 'filled', consumed: 4 });
  expect(result.frontier).toEqual({ after: [4] });
});

test('empty filtered windows charge hidden raw prefixes and never certify EOF', async () => {
  let round = 0;
  const result = await collectRetainedUsefulPage({
    limit: 1,
    check,
    canonicalId: (id) => id,
    read: async (size, refill) => {
      expect(size).toBe(3);
      if (round) expect(refill).toEqual({ execution: `round-${round}`, consumed: 3, size: 3 });
      return { execution: `round-${++round}`, hits: [], window: { positions: [], examined: 3, exhausted: false } };
    },
  });
  expect(result.status).toBe('preparing');
  expect(result.candidates).toBe(9);
  expect(result.rounds).toBe(3);
  expect(result.continuation).toEqual({ execution: 'round-3', consumed: 3 });
});

test('only consumed native end evidence exhausts and malformed raw ordinals fail', async () => {
  const result = await collectRetainedUsefulPage({
    limit: 1,
    check,
    canonicalId: (id) => id,
    read: async () => ({ execution: 'empty', hits: [], window: { positions: [], examined: 2, exhausted: true } }),
  });
  expect(result.status).toBe('exhausted');
  expect(result.continuation.consumed).toBe(2);
  await expect(
    collectRetainedUsefulPage({
      limit: 1,
      check,
      canonicalId: (id) => id,
      read: async () => ({
        execution: 'bad',
        hits: [hit('a', 0)],
        window: { positions: [3], examined: 3, exhausted: true },
      }),
    }),
  ).rejects.toThrow('Invalid retained Search window');
});

test('preparation advances the actual retained job; settlement alone never publishes', async () => {
  let ready = false;
  const jobs: unknown[] = [];
  const native = operations({
    capture: async () =>
      ready ? { status: 'captured', queried, repair, cost } : { status: 'preparing', repair, cost },
    repairStep: async (job) => {
      jobs.push(job);
      ready = true;
      return { status: 'settled', job, cost };
    },
  });
  await expect(
    readPublicSearchPage({ operations: native, plan, context: context(), check, canonicalId: (id) => id }),
  ).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(jobs).toEqual([repair]);
  const read = await readPublicSearchPage({
    operations: native,
    plan,
    context: context(),
    check,
    canonicalId: (id) => id,
  });
  expect(read.page.status).toBe('exhausted');
  await read.finalize();
});

test('final status is required for the exact zero-hit execution after completion work', async () => {
  const order: string[] = [];
  const native = operations({
    readStatus: async ({ execution }) => {
      order.push(execution!);
      return { status: 'unavailable', reason: 'dependency_unavailable', cost };
    },
  });
  const read = await readPublicSearchPage({
    operations: native,
    plan,
    context: context(),
    check,
    canonicalId: (id) => id,
  });
  order.push('summaries');
  await expect(read.finalize()).rejects.toMatchObject({ code: 'index_not_ready' });
  expect(order).toEqual(['summaries', 'execution']);
});

test('interrupted continuation authenticates its retained locator and retries the same raw prefix', async () => {
  const keys: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(1)]]) };
  const binding = { operation: 'subjects.search', principal: 'anonymous', request: { sort: 'name', limit: 1 } };
  const continuation = {
    queried,
    repair,
    window: { execution: 'previous', consumed: 2 },
    work: { candidates: 3, rounds: 1 },
    frontier: { after: [2] },
  };
  const token = await encodeRetainedSearchCursor(keys, binding, 1, continuation);
  expect(token).not.toContain('retained-job');
  const decoded = await decodeSearchCursor(keys, binding, token);
  if (!decoded.ok) throw new Error('Cursor failed to authenticate');
  expect(retainedSearchContinuation(decoded.after)).toEqual(continuation);
  expect(await decodeSearchCursor(keys, { ...binding, request: { sort: 'name', limit: 2 } }, token)).toMatchObject({
    ok: false,
  });
  const locators: unknown[] = [];
  let interrupted = true;
  const successful = operations().query;
  const native = operations({
    query: async (observation, ctx, refill): Promise<PublicFilterConsumerQuery> => {
      locators.push(refill);
      if (interrupted) {
        interrupted = false;
        throw new Error('transport interrupted');
      }
      return successful(observation, ctx, refill);
    },
  });
  const read = () =>
    readPublicSearchPage({
      operations: native,
      plan,
      continuation,
      context: context(),
      check,
      canonicalId: (id) => id,
    });
  await expect(read()).rejects.toThrow('transport interrupted');
  const resumed = await read();
  await resumed.finalize();
  expect(locators).toEqual([
    { execution: 'previous', consumed: 2, size: 1 },
    { execution: 'previous', consumed: 2, size: 1 },
  ]);
});

test('a continuation spends the remaining root allowance without resetting rounds', async () => {
  const page = await collectRetainedUsefulPage({
    limit: 1,
    prepared: true,
    continuation: { execution: 'previous', consumed: 1 },
    spent: { candidates: 3, rounds: 1 },
    check,
    canonicalId: (id) => id,
    read: async (size, refill) => {
      expect(size).toBe(1);
      expect(refill).toEqual({ execution: 'previous', consumed: 1, size: 1 });
      return {
        execution: 'remaining',
        hits: [hit('last', 5)],
        window: { positions: [0], examined: 1, exhausted: true },
      };
    },
  });
  expect(page.status).toBe('exhausted');
  expect(page.candidates).toBe(4);
  expect(page.rounds).toBe(2);
});

test('a spent continuation reads only an actual captured prepared replacement', async () => {
  const replacement: PublicFilterQueriedObservation = {
    consumer,
    snapshot: { kind: 'prepared', observation: 'replacement', build: 'replacement-build', generation: 2n },
  };
  const requests: unknown[] = [];
  const base = operations();
  const native = operations({
    capture: async ({ plan: captured, snapshot }) => {
      expect(snapshot).toBe('prepared');
      expect(captured.after).toEqual([4]);
      return { status: 'captured', queried: replacement, repair, cost };
    },
    query: async (observation, ctx, refill) => {
      requests.push({ observation, refill });
      const result = await base.query(observation, ctx, refill);
      if (result.status !== 'queried') throw new Error('Test query was unavailable');
      return { ...result, queried: replacement };
    },
    readStatus: async () => ({
      status: 'observed',
      queried: replacement,
      covered: { observation: 'replacement-cut' },
      pending: [],
      changed: [],
      blocking: [],
      cost,
    }),
  });
  const read = await readPublicSearchPage({
    operations: native,
    plan: { ...plan, after: [4] },
    context: context(),
    check,
    canonicalId: (id) => id,
    continuation: {
      queried,
      repair,
      window: { execution: 'spent', consumed: 1 },
      work: { candidates: 4, rounds: 2 },
      frontier: { after: [4] },
    },
  });
  expect(read.page.status).toBe('exhausted');
  expect(requests).toEqual([{ observation: replacement, refill: undefined }]);
  await read.finalize();
});
