import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthReport,
} from '../support/growth.ts';
import { createReactionRelayBase } from './reaction-relay-convergence-fixture.ts';
import {
  RankingWorld,
  expectedOrder,
  plus,
  sorts,
  startInlineRankingRuntime,
  type RankedThread,
  type RankingRuntime,
} from './board-ranking-native-convergence-fixture.ts';

const scales = [256, 1024, 4096] as const;
const candidateLimit = 200;
const pageSize = 3;
const refreshBatch = 500;
const relations = [
  'content.board',
  'content.board_thread',
  'content.thread',
  'content.post',
  'content.revision',
  'content.reaction',
  'content.reaction_count',
  'content.reaction_total',
  'access.account',
  'access.resource_grant',
  'access.resource_role_grant',
  'access.resource_denial',
  'core.partition',
  'core.receipt',
  'core.outbox',
] as const;

type Fixture = {
  world: RankingWorld;
  db: GrowthDatabase;
  runtime: RankingRuntime;
  boardId: string;
  sourcePartition: number;
  population: RankedThread[];
  at: string;
};

async function fixture(): Promise<Fixture> {
  const base = await createReactionRelayBase();
  let db: GrowthDatabase | undefined;
  let runtime: RankingRuntime | undefined;
  try {
    db = await openGrowthDatabase(base.system.database.pool.options.connectionString!);
    const world = new RankingWorld(base, db.pool);
    const boardId = await world.board();
    const first = await world.thread(boardId, world.start);
    runtime = await startInlineRankingRuntime(world, [partitionOf(routeOf(boardId)!)]);
    await runtime.consume(first.envelopes);
    await runtime.consume((await world.react(first.thread, base.other, 'upvote')).envelopes);
    return {
      world,
      db,
      runtime,
      boardId,
      sourcePartition: partitionOf(routeOf(first.thread.id)!),
      population: [first.thread],
      at: plus(world.start, 371),
    };
  } catch (error) {
    try {
      await runtime?.stop();
    } finally {
      try {
        await db?.close();
      } finally {
        await base.system.close();
      }
    }
    throw error;
  }
}
async function close(f: Fixture): Promise<void> {
  try {
    await f.runtime.stop();
  } finally {
    try {
      await f.db.close();
    } finally {
      await f.world.base.system.close();
    }
  }
}

/** Unrelated business data uses real commands, on the very same board and source/actor partitions as the probe. */
async function grow(f: Fixture, scale: number): Promise<void> {
  const envelopes = [];
  while (f.population.length < scale) {
    const created = await f.world.thread(f.boardId, f.world.start, f.sourcePartition);
    const reaction = await f.world.react(created.thread, f.world.base.other, 'upvote');
    f.population.push(created.thread);
    envelopes.push(...created.envelopes, ...reaction.envelopes);
    if (envelopes.length >= 64) {
      await f.runtime.consume(envelopes.splice(0));
    }
  }
  await f.runtime.consume(envelopes);
  await refreshAll(f);
  // Retain actual native populations. No fixture relocates unrelated candidates or votes to another board.
  const counts = (
    await f.db.admin.query<{
      candidates: string;
      threads: string;
      slots: string;
      totals: string;
    }>(
      `SELECT
       (SELECT count(*) FROM content.board_thread WHERE route=$1 AND board_id=$2) AS candidates,
       (SELECT count(*) FROM content.thread
         WHERE route >= $3*16 AND route < ($3+1)*16 AND board_id=$2) AS threads,
       (SELECT count(*) FROM content.reaction
         WHERE route=$4 AND actor_account_id=$5 AND target_id=ANY($6::uuid[])) AS slots,
       (SELECT count(*) FROM content.reaction_total
         WHERE route >= $3*16 AND route < ($3+1)*16 AND target_id=ANY($6::uuid[]) AND kind='upvote') AS totals`,
      [
        routeOf(f.boardId),
        f.boardId,
        f.sourcePartition,
        routeOf(f.world.base.other.accountId),
        f.world.base.other.accountId,
        f.population.map(({ id }) => id),
      ],
    )
  ).rows[0]!;
  for (const key of ['candidates', 'threads', 'slots', 'totals'] as const)
    expect(Number(counts[key]), JSON.stringify({ scale, key, counts })).toBeGreaterThanOrEqual(scale);
}

/** Every batch is an independently completed registered production workflow, not a changed-count barrier. */
async function refreshAll(f: Fixture): Promise<void> {
  for (let batch = 0; batch < 100; batch++) {
    await f.runtime.refresh(f.at);
    const due = (
      await f.db.admin.query<{ count: string }>(
        `SELECT count(*) FROM content.board_thread
        WHERE route >= $1*16 AND route < ($1+1)*16 AND active_rank<>0
          AND rank_refreshed_at <= $2::timestamptz - INTERVAL '10 minutes'`,
        [partitionOf(routeOf(f.boardId)!), f.at],
      )
    ).rows[0]!;
    if (Number(due.count) === 0) return;
  }
  throw new Error('Native rank workflows did not close the finite fixture population');
}

function rawGuards(name: string, report: GrowthReport): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  assertGrowthAccessPaths(name, report.samples, relations);
  for (const sample of report.samples) {
    const { cost, scale } = sample;
    const raw = JSON.stringify({ scale, cost, relationSizes: sample.relationSizes });
    expect(cost.rows, raw).toBeGreaterThan(0);
    expect(cost.blocks, raw).toBeGreaterThan(0);
    expect(cost.statements, raw).toBeGreaterThan(0);
    // Keep the original raw per-relation guard; no SQL-text classifier or catalogue subtraction.
    for (const repetition of sample.repetitions)
      for (const [relation, measured] of Object.entries(repetition.relations))
        expect(
          measured.sequentialScans,
          JSON.stringify({ name, scale, relation, ...measured, size: sample.relationSizes?.[relation] }),
        ).toBe(0);
  }
}

test.serial(
  'Original documented privacy, replay and raw growth bounds remain strict: native newest/active/hot pages with same-board threads and reactions',
  async () => {
    const f = await fixture();
    try {
      const selected: RankedThread[] = [];
      // A fixed newer neighbourhood is readable by anonymous and independently authenticated readers.
      for (let index = 0; index < 8; index++) {
        const created = await f.world.thread(f.boardId, plus(f.world.start, 360), f.sourcePartition);
        selected.push(created.thread);
        await f.runtime.consume(created.envelopes);
        if (index === 0) {
          await f.runtime.consume((await f.world.react(created.thread, f.world.base.author, 'upvote')).envelopes);
          await f.runtime.consume((await f.world.react(created.thread, f.world.base.other, 'upvote')).envelopes);
        }
      }
      const name = 'Native board pages after actual reaction and rank workflow closure';
      const read = async () => {
        await f.world.time(f.at);
        const values = [];
        for (const sort of sorts) {
          const page = await f.world.page(f.boardId, sort, undefined, undefined, pageSize);
          expect(page.threads.map(({ id }) => id)).toEqual(expectedOrder(selected, sort, f.at).slice(0, pageSize));
          expect(page.next).toEqual(expect.any(String));
          if (sort === 'newest') expect(page.rankRefreshedAt).toBeNull();
          else expect(new Date(page.rankRefreshedAt!).toISOString()).toBe(f.at);
          values.push(page);
        }
        return values;
      };
      const report = await checkGrowth(f.db, {
        name,
        scales,
        repetitions: 1,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: async (_db, scale) => grow(f, scale),
        operation: read,
        warmup: read,
      });
      rawGuards(name, report);
      for (const sample of report.samples)
        for (const cost of sample.repetitions) {
          const candidates = cost.relations['content.board_thread']!;
          const raw = JSON.stringify({ scale: sample.scale, cost, relationSizes: sample.relationSizes });
          // Three fixed HTTP operations: retain the original 2Q candidate bound for each sort, additively.
          expect(candidates, raw).toBeDefined();
          expect(candidates.rows, raw).toBeGreaterThan(0);
          expect(candidates.rows, raw).toBeLessThanOrEqual(sorts.length * 2 * candidateLimit);
          const blocks =
            candidates.blocks +
            Object.entries(cost.relations)
              .filter(([name]) => name.startsWith('index:board_thread_'))
              .reduce((sum, [, relation]) => sum + relation.blocks, 0);
          const footprint = sample.relationSizes!['content.board_thread']!;
          expect(footprint, raw).toBeDefined();
          // Charge the complete measured relation, including the fixed selected neighbourhood.
          const bound = sorts.length * (2 * candidateLimit + 2 * Math.ceil(Math.log2(2 + footprint.reltuples)));
          expect(blocks, raw).toBeLessThanOrEqual(bound);
        }
      // The read metric covers exactly its three pages. Authenticated privacy/replay controls are outside it.
      for (const person of [f.world.base.author, f.world.base.other])
        for (const sort of sorts) {
          const page = await f.world.page(f.boardId, sort, person.bearer);
          expect(page.threads.map(({ id }) => id)).toEqual(expectedOrder(selected, sort, f.at).slice(0, pageSize));
        }
      const refreshBoard = await f.world.board();
      const first = await f.world.thread(refreshBoard, f.world.start, f.sourcePartition);
      await f.runtime.consume(first.envelopes);
      await f.runtime.consume((await f.world.react(first.thread, f.world.base.other, 'upvote')).envelopes);
      await rankRefreshGrowth({ ...f, boardId: refreshBoard, population: [first.thread] });
    } finally {
      await close(f);
    }
  },
  3_600_000,
);

async function rankRefreshGrowth(f: Fixture): Promise<void> {
  let due: RankedThread[] = [];
  const outcomes: { scale: number; ids: string[]; refreshedAt: string }[] = [];
  const prepare = async () => {
    due = [];
    const envelopes = [];
    for (let index = 0; index < refreshBatch; index++) {
      const created = await f.world.thread(f.boardId, plus(f.world.start, 360), f.sourcePartition);
      due.push(created.thread);
      envelopes.push(...created.envelopes);
      const reaction = await f.world.react(created.thread, f.world.base.other, 'upvote');
      envelopes.push(...reaction.envelopes);
      if (envelopes.length >= 64) await f.runtime.consume(envelopes.splice(0));
    }
    await f.runtime.consume(envelopes);
    // Assert the prepared batch is actually due. Previously completed batches remain at the fixed refresh clock.
    const row = (
      await f.db.admin.query<{ count: string }>(
        `SELECT count(*) FROM content.board_thread WHERE route=$1 AND board_id=$2
          AND thread_id=ANY($3::uuid[]) AND rank_refreshed_at <= $4::timestamptz - INTERVAL '10 minutes'`,
        [routeOf(f.boardId), f.boardId, due.map(({ id }) => id), f.at],
      )
    ).rows[0]!;
    expect(Number(row.count)).toBe(refreshBatch);
  };
  const operation = async (_db: GrowthDatabase, scale: number) => {
    // The real producer and its physical completion/result are inside this operation's capture context.
    await f.runtime.refresh(f.at);
    const rows = (
      await f.db.admin.query<{
        thread_id: string;
        score: number;
        rank_refreshed_at: Date;
      }>(
        `SELECT thread_id,score,rank_refreshed_at FROM content.board_thread
          WHERE route=$1 AND board_id=$2 AND thread_id=ANY($3::uuid[]) ORDER BY thread_id`,
        [routeOf(f.boardId), f.boardId, due.map(({ id }) => id)],
      )
    ).rows;
    expect(rows).toHaveLength(refreshBatch);
    for (const row of rows) {
      expect(row.score).toBe(1);
      expect(row.rank_refreshed_at.toISOString()).toBe(f.at);
    }
    outcomes.push({ scale, ids: rows.map(({ thread_id }) => thread_id), refreshedAt: f.at });
    return rows;
  };
  const name = 'Native registered hot-rank refresh with a fresh fixed 500-row due batch';
  const report = await checkGrowth(f.db, {
    name,
    scales,
    repetitions: 1,
    rule: 'series',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (_db, scale) => grow(f, scale),
    prepare,
    warmup: async (db, scale) => {
      await prepare();
      return operation(db, scale);
    },
    operation,
  });
  rawGuards(name, report);
  for (const scale of scales) {
    const attempts = outcomes.filter((outcome) => outcome.scale === scale);
    const sample = report.samples.find((sample) => sample.scale === scale)!;
    expect(attempts).toHaveLength(2 + (sample.coldBackendDiscards ?? 0));
  }
  expect(new Set(outcomes.flatMap(({ ids }) => ids)).size).toBe(outcomes.length * refreshBatch);
  for (const sample of report.samples) {
    const raw = JSON.stringify(sample);
    expect(sample.cost.relations['content.board_thread']!.rows, raw).toBeGreaterThanOrEqual(refreshBatch);
    expect(sample.cost.relations['content.reaction_total']!.rows, raw).toBeGreaterThanOrEqual(refreshBatch);
    // Preserve the documented <= 2B + 2 statement ceiling with B=500, with no removed DBOS/catalogue work.
    expect(sample.cost.statements, raw).toBeLessThanOrEqual(2 * refreshBatch + 2);
  }
}
