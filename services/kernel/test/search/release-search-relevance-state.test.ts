import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  createReleaseSearchRelevanceState,
  ReleaseSearchRelevanceStateConflict,
  ReleaseSearchRelevanceStateExpired,
  type ReleaseSearchRelevanceBinding,
} from '../../src/search/release-search-relevance-state.ts';

const request = {
  releaseDigest: 'release-digest',
  filter: { type: { in: ['edition'] } },
  sort: 'relevance' as const,
  languages: ['en'],
  spoilerThreshold: 0 as const,
  groupLimit: 20,
  childLimit: 20,
  previewLimit: 3,
};
const cut = {
  names: { epoch: 'names', pools: [{ id: 'semantic', population: { generation: '1', homes: [] } }] },
  basis: {
    releaseDigest: 'release-digest',
    physical: { generation: 7, incarnation: 'incarnation', indexUuid: 'index-uuid' },
    epoch: 'source-cut',
    calendarReadyFor: null,
  },
};
const binding: ReleaseSearchRelevanceBinding = {
  principal: 'account:00000000-0000-8000-8000-000000000001',
  request,
  generation: 7,
  cut,
};
const id = (index: number) => `10000000-0000-8000-8000-${String(index).padStart(12, '0')}`;
const branch = (index: number) => index.toString(16).padStart(64, '0');
const key = (execution: string, position: string) => `${execution}/${position}`;

function fakeDatabase() {
  type Execution = { principal: string; request: string; generation: number; cut: string; expires: Date };
  type Position = { parent: string | null; branch: string; digest: string; root: string };
  const executions = new Map<string, Execution>();
  const positions = new Map<string, Position>();
  const branches = new Map<string, string>();
  const roots = new Map<string, Set<string>>();
  const queries: string[] = [];
  const cleanup: string[] = [];
  const trieEdgesPerLookup: number[] = [];
  let rootCounter = 0;
  const root = () => `membership-root-${++rootCounter}`;
  const client = {
    release() {},
    async query(input: string | { text: string; values?: unknown[] }, values: unknown[] = []) {
      const sql = typeof input === 'string' ? input : input.text;
      if (typeof input !== 'string') values = input.values ?? values;
      queries.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.includes('WITH doomed AS')) {
        cleanup.push(sql);
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO search.release_relevance_execution')) {
        const [execution, position, principal, requestHash, generation, cutHash, expires, branchHash, digest] =
          values as unknown as [string, string, string, string, number, string, Date, string, string];
        const membership = root();
        executions.set(execution, { principal, request: requestHash, generation, cut: cutHash, expires });
        positions.set(key(execution, position), { parent: null, branch: branchHash, digest, root: membership });
        roots.set(membership, new Set<string>());
        return { rows: [{ execution_id: execution, id: position }] };
      }
      if (sql.startsWith('UPDATE search.release_relevance_execution')) {
        const [execution, position, principal, requestHash, generation, cutHash, expires, now] = values as unknown as [
          string,
          string,
          string,
          string,
          number,
          string,
          Date,
          Date,
        ];
        const session = executions.get(execution);
        if (
          !session ||
          session.principal !== principal ||
          session.request !== requestHash ||
          session.generation !== generation ||
          session.cut !== cutHash ||
          session.expires <= now ||
          !positions.has(key(execution, position))
        )
          return { rows: [] };
        session.expires = expires;
        return { rows: [{ id: execution }] };
      }
      if (sql.includes('SELECT p.membership_root')) {
        const [execution, position] = values as [string, string];
        const current = positions.get(key(execution, position));
        if (!current) return { rows: [] };
        if (values.length === 7) {
          const [id, node, principal, requestHash, generation, cutHash, now] = values as unknown as [
            string,
            string,
            string,
            string,
            number,
            string,
            Date,
          ];
          const session = executions.get(id);
          if (
            !session ||
            session.principal !== principal ||
            session.request !== requestHash ||
            session.generation !== generation ||
            session.cut !== cutHash ||
            session.expires <= now ||
            node !== position
          )
            return { rows: [] };
        }
        return { rows: [{ membership_root: current.root }] };
      }
      if (sql.includes('release_relevance_membership_contains')) {
        const [_execution, membership, candidates] = values as [string, string, string[]];
        const present = roots.get(membership) ?? new Set<string>();
        trieEdgesPerLookup.push(candidates.length * 32);
        return { rows: candidates.filter((work) => present.has(work)).map((work_id) => ({ work_id })) };
      }
      if (sql.includes('search.release_relevance_advance')) {
        const [
          execution,
          parent,
          proposed,
          branchHash,
          digest,
          principal,
          requestHash,
          generation,
          cutHash,
          expires,
          now,
          emitted,
        ] = values as unknown as [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          number,
          string,
          Date,
          Date,
          string[],
        ];
        const session = executions.get(execution);
        const parentPosition = positions.get(key(execution, parent));
        if (
          !session ||
          !parentPosition ||
          session.principal !== principal ||
          session.request !== requestHash ||
          session.generation !== generation ||
          session.cut !== cutHash ||
          session.expires <= now
        )
          return { rows: [] };
        session.expires = expires;
        const branchKey = `${key(execution, parent)}/${branchHash}`;
        const existing = branches.get(branchKey);
        if (existing) {
          const position = positions.get(key(execution, existing))!;
          return {
            rows: [{ execution_id: execution, id: existing, work_digest: position.digest }],
          };
        }
        const membership = root();
        const inherited = new Set(roots.get(parentPosition.root) ?? []);
        for (const work of emitted) inherited.add(work);
        roots.set(membership, inherited);
        positions.set(key(execution, proposed), { parent, branch: branchHash, digest, root: membership });
        branches.set(branchKey, proposed);
        return {
          rows: [{ execution_id: execution, id: proposed, work_digest: digest }],
        };
      }
      throw new Error(`Unexpected relevance state SQL: ${sql.slice(0, 72)}`);
    },
  };
  const fakePool = { connect: async () => client } as unknown as Pool;
  return {
    fakePool,
    queries,
    cleanup,
    trieEdgesPerLookup,
  };
}

function stateFor(database: ReturnType<typeof fakeDatabase>) {
  let reservations = 0;
  const state = createReleaseSearchRelevanceState({
    pool: database.fakePool,
    deadline: Date.now() + 30_000,
    run: async <T>(operation: () => Promise<T>) => operation(),
    reserve: () => reservations++,
    poolId: 'semantic',
  });
  return { state, reservations: () => reservations };
}

test('deep relevance membership uses fixed trie work with replayable sibling roots', async () => {
  const database = fakeDatabase();
  const { state, reservations } = stateFor(database);
  const now = 1_800_000_000_000;
  const initial = id(1);
  const empty = await state.start(binding, now);
  expect(await state.seen(binding, empty, [initial], now)).toEqual(new Set());
  const root = await state.advance(binding, empty, branch(999), [initial], now);
  expect(await state.seen(binding, root, [initial, id(2)], now)).toEqual(new Set([initial]));

  let location = root;
  const works = Array.from({ length: 129 }, (_, index) => id(index + 10));
  for (let index = 0; index < works.length; index++) {
    expect(await state.seen(binding, location, [works[index]!], now)).toEqual(new Set());
    location = await state.advance(binding, location, branch(index + 1), [works[index]!, works[index]!], now);
  }
  expect(await state.seen(binding, location, [initial, works[0]!, works.at(-1)!], now)).toEqual(
    new Set([initial, works[0]!, works.at(-1)!]),
  );
  expect(Math.max(...database.trieEdgesPerLookup)).toBe(96);
  expect(database.queries.some((sql) => sql.includes('WITH RECURSIVE'))).toBe(false);
  expect(database.queries.some((sql) => sql.includes('membership_contains'))).toBe(true);

  const leftWork = id(1000);
  const rightWork = id(1001);
  const left = await state.advance(binding, location, branch(1001), [leftWork], now);
  const right = await state.advance(binding, location, branch(1002), [rightWork], now);
  expect(await state.seen(binding, left, [leftWork, rightWork], now)).toEqual(new Set([leftWork]));
  expect(await state.seen(binding, right, [leftWork, rightWork], now)).toEqual(new Set([rightWork]));
  expect(await state.advance(binding, location, branch(1001), [leftWork], now)).toEqual(left);
  await expect(state.advance(binding, location, branch(1001), [rightWork], now)).rejects.toBeInstanceOf(
    ReleaseSearchRelevanceStateConflict,
  );
  await expect(state.resume({ ...binding, principal: 'anonymous' }, right, now)).rejects.toBeInstanceOf(
    ReleaseSearchRelevanceStateExpired,
  );
  expect(reservations()).toBe(database.queries.length);
});

test('expiry keeps retained state private and cleanup drains bounded positions and trie nodes', async () => {
  const database = fakeDatabase();
  const { state } = stateFor(database);
  const now = 1_800_000_000_000;
  const root = await state.start(binding, now);
  const location = await state.advance(binding, root, branch(1), [id(1)], now);
  await expect(state.resume(binding, location, now + 15 * 60_000 + 1)).rejects.toBeInstanceOf(
    ReleaseSearchRelevanceStateExpired,
  );
  await state.start(binding, now + 15 * 60_000 + 1);
  expect(database.cleanup).toHaveLength(6);
  expect(database.cleanup.every((sql) => /LIMIT (100|500)/.test(sql))).toBe(true);
  expect(database.cleanup.some((sql) => sql.includes('release_relevance_membership_node'))).toBe(true);
});
