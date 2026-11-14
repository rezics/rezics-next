import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import {
  createReleaseSearchRelevanceState,
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
const priorWork = '10000000-0000-8000-8000-000000000001';
const nextWork = '10000000-0000-8000-8000-000000000002';

test('PostgreSQL relevance lineage binds authority, keeps replay idempotent and reads only page candidates', async () => {
  const executions = new Map<
    string,
    { principal: string; request: string; generation: number; cut: string; expires: Date }
  >();
  const positions = new Map<string, { parent: string | null; branch: string; digest: string }>();
  const branches = new Map<string, string>();
  const works = new Map<string, Set<string>>();
  const queries: string[] = [];
  let reservations = 0;
  const key = (execution: string, node: string) => `${execution}/${node}`;
  const fakePool = {
    async query(sql: string, values: unknown[] = []) {
      queries.push(sql);
      if (sql.includes('INSERT INTO search.release_relevance_execution')) {
        const [execution, node, principal, requestHash, generation, cutHash, expires, branch, digest, seed] =
          values as unknown as [string, string, string, string, number, string, Date, string, string, string[]];
        executions.set(execution, { principal, request: requestHash, generation, cut: cutHash, expires });
        positions.set(key(execution, node), { parent: null, branch, digest });
        works.set(key(execution, node), new Set(seed));
        return { rows: [{ execution_id: execution, position_id: node }] };
      }
      if (sql.includes('WITH RECURSIVE retained AS')) {
        const [execution, node, principal, requestHash, generation, cutHash, now, candidates] = values as unknown as [
          string,
          string,
          string,
          string,
          number,
          string,
          Date,
          string[],
        ];
        const session = executions.get(execution);
        if (
          !session ||
          session.principal !== principal ||
          session.request !== requestHash ||
          session.generation !== generation ||
          session.cut !== cutHash ||
          session.expires <= now ||
          !positions.has(key(execution, node))
        )
          return { rows: [] };
        const found = new Set<string>();
        let current: string | null = node;
        while (current !== null) {
          for (const id of works.get(key(execution, current)) ?? []) if (candidates.includes(id)) found.add(id);
          current = positions.get(key(execution, current))?.parent ?? null;
        }
        return {
          rows: [
            { execution_id: execution, work_id: null },
            ...[...found].map((work_id) => ({ execution_id: execution, work_id })),
          ],
        };
      }
      if (sql.startsWith('UPDATE search.release_relevance_execution')) {
        const [execution, node, principal, requestHash, generation, cutHash, expires, now] = values as unknown as [
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
          !positions.has(key(execution, node))
        )
          return { rows: [] };
        session.expires = expires;
        return { rows: [{ id: execution }] };
      }
      if (sql.includes('INSERT INTO search.release_relevance_position')) {
        const [
          execution,
          parent,
          proposed,
          branch,
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
        if (
          !session ||
          session.principal !== principal ||
          session.request !== requestHash ||
          session.generation !== generation ||
          session.cut !== cutHash ||
          session.expires <= now ||
          !positions.has(key(execution, parent))
        )
          return { rows: [] };
        session.expires = expires;
        const branchKey = `${execution}/${parent}/${branch}`;
        let node = branches.get(branchKey);
        if (!node) {
          node = proposed;
          branches.set(branchKey, node);
          positions.set(key(execution, node), { parent, branch, digest });
          works.set(key(execution, node), new Set(emitted));
        }
        const value = positions.get(key(execution, node))!;
        return { rows: [{ execution_id: execution, id: node, work_digest: value.digest }] };
      }
      if (sql.startsWith('WITH doomed AS')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected relevance state SQL: ${sql.slice(0, 64)}`);
    },
  } as unknown as Pool;
  const state = createReleaseSearchRelevanceState({
    pool: fakePool,
    run: async <T>(operation: () => Promise<T>) => operation(),
    reserve: () => reservations++,
    poolId: 'semantic',
  });
  const now = 1_800_000_000_000;
  const root = await state.start(binding, now, [priorWork]);
  await state.resume(binding, root, now);
  expect(await state.seen(binding, root, [priorWork, nextWork], now)).toEqual(new Set([priorWork]));
  const branch = 'a'.repeat(64);
  const advanced = await state.advance(binding, root, branch, [nextWork], now);
  expect(await state.seen(binding, advanced, [priorWork, nextWork], now)).toEqual(new Set([priorWork, nextWork]));
  expect(await state.seen(binding, root, [priorWork, nextWork], now)).toEqual(new Set([priorWork]));
  expect(await state.advance(binding, root, branch, [nextWork], now)).toEqual(advanced);
  await expect(state.resume({ ...binding, principal: 'anonymous' }, advanced, now)).rejects.toBeInstanceOf(
    ReleaseSearchRelevanceStateExpired,
  );
  expect(reservations).toBe(queries.length);
  expect(queries.some((sql) => sql.includes('WITH RECURSIVE retained AS'))).toBe(true);
});
