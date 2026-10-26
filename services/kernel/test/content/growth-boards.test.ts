import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import {
  applyBoardCandidate,
  createBoardEffect,
  readBoardCandidates,
  type BoardCandidate,
} from '../../src/content/board-projection.ts';
import type { CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const sourceRoute = 0x1234;
const boardRoute = 0x5678;
const authorId = newId(0x9abc);
const createdAt = '2026-10-25T00:00:00.000Z';
const populationSize = 500;
const scales = [1, 8, 64] as const;

async function createBoard(boardId: string): Promise<void> {
  await db.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Growth board', 'published', 1, $4) ON CONFLICT DO NOTHING`,
    [boardRoute, boardId, newId(0xdef0), randomUUID()],
  );
}

async function createSource(boardId: string): Promise<{ threadId: string; event: CloudEvent }> {
  await createBoard(boardId);
  const threadId = newId(sourceRoute);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const fixture = await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
       (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, 'Anchor', 'published', 1, $5, $6)`,
      [sourceRoute, threadId, authorId, boardId, context.transactionId, createdAt],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: threadId,
          data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  return {
    threadId,
    event: {
      id: randomUUID(),
      type: 'com.rezics.content.thread.created.v1',
      source: `urn:rezics:log:${fixture.partition}.${fixture.epoch}`,
      sequence: fixture.position.toString().padStart(19, '0'),
      subject: threadId,
      time: createdAt,
      data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
    },
  } as { threadId: string; event: CloudEvent };
}

test('Board projection stays within its bound as T grows', async () => {
  const boardId = newId(boardRoute);
  const { event } = await createSource(boardId);

  // This population matches production content.thread rows and grows the source anchor partition.
  const threads: Population = {
    name: `growth-board-projection-threads-${randomUUID()}`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ route }) => ({
      'content.thread': [
        {
          route,
          thread_id: newId(route),
          author_account_id: authorId,
          board_id: boardId,
          title: 'Growth neighbour',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: randomUUID(),
          created_at: createdAt,
        },
      ],
    }),
  };
  // This population matches projected content.board_thread rows and grows the destination anchor partition.
  const candidates: Population = {
    name: `growth-board-projection-candidates-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route }) => {
      const threadId = newId(route);
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: boardId,
            title: 'Projected neighbour',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: createdAt,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: boardId,
            thread_id: threadId,
            created_at: createdAt,
            source_epoch: 1,
            source_position: 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };

  const report = await checkGrowth(db, {
    name: 'Board projection',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, threads, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, candidates, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
    },
    operation: async (growthDb) => createBoardEffect(growthDb.pool).run(event),
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);

test('Board candidate page stays within its bound as d grows', async () => {
  const boardId = newId(boardRoute);
  await createBoard(boardId);
  const cursorAt = '2026-10-25T00:00:00.000Z';
  const older = Array.from({ length: 8 }, (_, index): BoardCandidate => ({
    id: newId(sourceRoute),
    boardId,
    createdAt: `2026-10-24T23:59:${String(59 - index).padStart(2, '0')}.000Z`,
    epoch: 1,
    position: BigInt(index + 1),
  }));
  const cursor: BoardCandidate = {
    id: newId(sourceRoute),
    boardId,
    createdAt: cursorAt,
    epoch: 1,
    position: 20n,
  };
  for (const candidate of [...older, cursor]) await applyBoardCandidate(db.pool, candidate);
  const expected = await readBoardCandidates(db.pool, boardId, { createdAt: cursorAt, id: cursor.id }, 8);

  // This population matches projected rows, growing the measured board and its keyset depth.
  const onBoard: Population = {
    name: `growth-board-page-anchor-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const threadId = newId(route);
      const time = `2026-10-25T00:01:${String(ordinal % 60).padStart(2, '0')}.000Z`;
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: boardId,
            title: 'Measured board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: time,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: boardId,
            thread_id: threadId,
            created_at: time,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };
  // This population matches projected rows on other boards in the same route partition, growing total T.
  const otherBoards: Population = {
    name: `growth-board-page-other-${randomUUID()}`,
    hotPartition: partitionOf(boardRoute),
    hotShare: 1,
    rows: ({ route, ordinal }) => {
      const otherBoard = newId(boardRoute);
      const threadId = newId(route);
      const time = `2026-10-25T00:01:${String(ordinal % 60).padStart(2, '0')}.000Z`;
      return {
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: authorId,
            board_id: otherBoard,
            title: 'Other board thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: randomUUID(),
            created_at: time,
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: otherBoard,
            thread_id: threadId,
            created_at: time,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: null,
          },
        ],
      };
    },
  };

  const report = await checkGrowth(db, {
    name: 'Board candidate page',
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, onBoard, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
      await seed({ pool: growthDb.pool, admin: growthDb.admin }, otherBoards, {
        from: previous * populationSize,
        to: scale * populationSize,
      });
    },
    operation: async (growthDb) => {
      const page = await readBoardCandidates(growthDb.pool, boardId, { createdAt: cursorAt, id: cursor.id }, 8);
      expect(page.candidates.map(({ id }) => id)).toEqual(expected.candidates.map(({ id }) => id));
      return page;
    },
  });
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
}, 90_000);
