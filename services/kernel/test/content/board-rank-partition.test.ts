import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const route = 0x1234;
const otherRoute = 0x5678;
const warmupRoute = 0x2345;
const scales = [256, 1024, 4096] as const;

test('one partition refresh has flat rows and buffers as other partitions grow', async () => {
  const at = new Date();
  const createdAt = new Date(at.getTime() - 3_600_000).toISOString();
  const staleAt = new Date(at.getTime() - 20 * 60_000).toISOString();
  const freshAt = new Date(at.getTime() + 24 * 3_600_000).toISOString();
  const boardId = newId(route);
  let dueIds = Array.from({ length: 8 }, () => newId(route));
  const warmupBoardId = newId(warmupRoute);
  let warmupDueIds = Array.from({ length: 8 }, () => newId(warmupRoute));
  const freshId = newId(route);
  const zeroId = newId(route);
  const makePopulation = (populationRoute: number): Population => ({
    name: `board-rank-other-partitions-${randomUUID()}`,
    hotPartition: partitionOf(populationRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const board = newId(populationRoute);
      const thread = newId(populationRoute);
      return {
        'content.board': [
          {
            route: populationRoute,
            board_id: board,
            subject_id: newId(populationRoute),
            title: 'Other partition',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
          },
        ],
        'content.board_thread': [
          {
            route: populationRoute,
            board_id: board,
            thread_id: thread,
            created_at: createdAt,
            last_activity_at: createdAt,
            active_rank: 1,
            hot_rank: 1,
            rank_refreshed_at: ordinal % 2 === 0 ? staleAt : freshAt,
            source_epoch: 1,
            source_position: ordinal + 1,
          },
        ],
        'content.reaction_total': [
          {
            route: populationRoute,
            target_id: thread,
            kind: 'upvote',
            count: 2,
            source_epoch: 1,
            source_position: ordinal + 1,
          },
        ],
      };
    },
  });
  const population = makePopulation(otherRoute);
  const report = await checkGrowth(db, {
    name: 'partition board rank refresh',
    rule: 'series',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    grow: async (growthDb, scale, previous) => {
      if (previous === 0) {
        await growthDb.admin.query(
          `INSERT INTO content.board
            (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
           VALUES ($1, $2, $3, 'Refreshed partition', 'published', 1, $4)`,
          [route, boardId, newId(route), randomUUID()],
        );
        await growthDb.admin.query(
          `INSERT INTO content.board
            (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
           VALUES ($1, $2, $3, 'Warmup partition', 'published', 1, $4)`,
          [warmupRoute, warmupBoardId, newId(warmupRoute), randomUUID()],
        );
      }
      if (previous === 0) {
        // Pad all shared indexes before the first scale without adding other due work.
        for (const baselineRoute of [route, warmupRoute, otherRoute]) {
          const baseline = makePopulation(baselineRoute);
          await seed(
            growthDb,
            {
              ...baseline,
              name: `${baseline.name}-baseline`,
              rows(placement) {
                const rows = baseline.rows!(placement);
                return {
                  ...rows,
                  'content.board_thread': rows['content.board_thread']!.map((row) => ({
                    ...row,
                    rank_refreshed_at: freshAt,
                  })),
                };
              },
            },
            { from: 0, to: 4096 },
          );
        }
      }
      dueIds = Array.from({ length: 8 }, () => newId(route));
      warmupDueIds = Array.from({ length: 8 }, () => newId(warmupRoute));
      await growthDb.admin.query(
        `INSERT INTO content.board_thread
            (route, board_id, thread_id, created_at, last_activity_at, active_rank, hot_rank,
             rank_refreshed_at, source_epoch, source_position)
           SELECT $1, $2, item.id, $3, $3, CASE WHEN item.id = $6 THEN 0 ELSE 1 END, 1,
                  CASE WHEN item.id = $7 THEN $5::timestamptz ELSE $4::timestamptz END, 1, 1
           FROM unnest($8::uuid[]) AS item(id)`,
        [
          route,
          boardId,
          createdAt,
          staleAt,
          freshAt,
          zeroId,
          freshId,
          previous === 0 ? [...dueIds, freshId, zeroId] : dueIds,
        ],
      );
      await growthDb.admin.query(
        `INSERT INTO content.board_thread
            (route, board_id, thread_id, created_at, last_activity_at, active_rank, hot_rank,
             rank_refreshed_at, source_epoch, source_position)
           SELECT $1, $2, item.id, $3, $3, 1, 1, $4::timestamptz, 1, 1
           FROM unnest($5::uuid[]) AS item(id)`,
        [warmupRoute, warmupBoardId, createdAt, staleAt, warmupDueIds],
      );
      await seed(growthDb, population, { from: previous, to: scale });
    },
    warmup: async () => {
      const refreshed = await refreshBoardRankBatch(db.pool, at, [partitionOf(warmupRoute)]);
      expect(refreshed).toBe(warmupDueIds.length);
    },
    operation: async () => {
      const refreshed = await refreshBoardRankBatch(db.pool, at, [partitionOf(route)]);
      expect(refreshed).toBe(dueIds.length);
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(
    report.samples.every(({ cost }) =>
      Object.values(cost.relations ?? {}).every((relation) => relation.sequentialScans === 0),
    ),
  ).toBe(true);
  const other = await db.admin.query(
    `SELECT count(*)::integer AS count FROM content.board_thread
     WHERE route = $1 AND rank_refreshed_at = $2::timestamptz`,
    [otherRoute, staleAt],
  );
  expect(other.rows).toEqual([{ count: scales[2] / 2 }]);
  const untouched = await db.admin.query(
    `SELECT thread_id FROM content.board_thread WHERE route = $1 AND board_id = $2
       AND ((thread_id = $3 AND rank_refreshed_at = $5::timestamptz)
         OR (thread_id = $4 AND rank_refreshed_at = $6::timestamptz))`,
    [route, boardId, freshId, zeroId, freshAt, staleAt],
  );
  expect(untouched.rowCount).toBe(2);
}, 180_000);
