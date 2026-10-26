import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const route = 0x1234;
const otherRoute = 0x5678;
const scales = [2048, 8192, 32768] as const;

test('one partition refresh has flat rows and buffers as other partitions grow', async () => {
  const at = new Date();
  const createdAt = new Date(at.getTime() - 3_600_000).toISOString();
  const staleAt = new Date(at.getTime() - 20 * 60_000).toISOString();
  const freshAt = new Date(at.getTime() + 24 * 3_600_000).toISOString();
  const boardId = newId(route);
  const dueIds = Array.from({ length: 8 }, () => newId(route));
  const freshId = newId(route);
  const zeroId = newId(route);
  const population: Population = {
    name: `board-rank-other-partitions-${randomUUID()}`,
    hotPartition: partitionOf(otherRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const board = newId(otherRoute);
      const thread = newId(otherRoute);
      return {
        'content.board': [
          {
            route: otherRoute,
            board_id: board,
            subject_id: newId(otherRoute),
            title: 'Other partition',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
          },
        ],
        'content.board_thread': [
          {
            route: otherRoute,
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
            route: otherRoute,
            target_id: thread,
            kind: 'upvote',
            count: 2,
            source_epoch: 1,
            source_position: ordinal + 1,
          },
        ],
      };
    },
  };
  const report = await checkGrowth(db, {
    name: 'partition board rank refresh',
    scales,
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    repetitions: 1,
    warmups: 0,
    grow: async (growthDb, scale, previous) => {
      if (previous === 0) {
        await growthDb.admin.query(
          `INSERT INTO content.board
            (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
           VALUES ($1, $2, $3, 'Refreshed partition', 'published', 1, $4)`,
          [route, boardId, newId(route), randomUUID()],
        );
        await growthDb.admin.query(
          `INSERT INTO content.board_thread
            (route, board_id, thread_id, created_at, last_activity_at, active_rank, hot_rank,
             rank_refreshed_at, source_epoch, source_position)
           SELECT $1, $2, item.id, $3, $3, CASE WHEN item.id = $6 THEN 0 ELSE 1 END, 1,
                  CASE WHEN item.id = $7 THEN $5::timestamptz ELSE $4::timestamptz END, 1, 1
           FROM unnest($8::uuid[]) AS item(id)`,
          [route, boardId, createdAt, staleAt, freshAt, zeroId, freshId, [...dueIds, freshId, zeroId]],
        );
      }
      await seed(growthDb, population, { from: previous, to: scale });
    },
    operation: async (_growthDb, _scale, repetition) => {
      const refreshed = await refreshBoardRankBatch(db.pool, new Date(at.getTime() + repetition * 11 * 60_000), [
        partitionOf(route),
      ]);
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
