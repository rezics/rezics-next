import { afterAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import {
  applyBoardCandidate,
  createBoardEffect,
  readBoardCandidates,
  type BoardCandidate,
} from '../../src/content/board-projection.ts';
import { CONTENT_EVENTS } from '../../src/events/contracts/content.ts';
import { registerEffects } from '../../src/events/effects.ts';
import { EVENT_TYPES, readBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { checkStatement } from '../support/partition-binding.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());
const sourceRoute = 0x1234;
const boardRoute = 0x5678;
const boardId = newId(boardRoute);
const otherBoardId = newId(boardRoute);
const authorId = newId(0x9abc);
const createdAt = '2026-10-25T00:00:00.000Z';
const created = 'com.rezics.content.thread.created.v1';
const revised = 'com.rezics.content.revision.created.v1';

async function board(id: string) {
  await db.admin.query(
    `INSERT INTO content.board
     (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Books', 'published', 1, $4) ON CONFLICT DO NOTHING`,
    [boardRoute, id, newId(0xdef0), randomUUID()],
  );
}

// Fixture setup uses the real command transaction and outbox, never a fabricated envelope.
async function source(targetBoard = boardId) {
  await board(targetBoard);
  const threadId = newId(sourceRoute);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const body = Buffer.from('private source bytes');
  const command = await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
       (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, 'Private title', 'published', 1, $5, $6)`,
      [sourceRoute, threadId, authorId, targetBoard, context.transactionId, createdAt],
    );
    await tx.query(
      `INSERT INTO content.post
       (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, $4, $5, 'published', 1, $6)`,
      [sourceRoute, threadId, itemId, authorId, revisionId, context.transactionId],
    );
    await tx.query(
      `INSERT INTO content.revision
       (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
        subject_ids, board_id, availability, recorded_transaction_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'private source bytes', 'CC0-1.0', '{}', $7, 'available', $8, $9)`,
      [
        sourceRoute,
        threadId,
        itemId,
        revisionId,
        body,
        createHash('sha256').update(body).digest(),
        targetBoard,
        context.transactionId,
        createdAt,
      ],
    );
    return {
      value: { threadId, itemId, revisionId },
      events: [
        {
          type: created,
          subject: threadId,
          data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  return { ...command.value, command };
}

async function collect(): Promise<Envelope[]> {
  const captured: Envelope[] = [];
  const result = await readBatch(db.pool, {
    partition: partitionOf(sourceRoute),
    consumer: `board_${randomUUID().replaceAll('-', '')}`,
    apply: async (envelopes) => {
      captured.push(...envelopes);
    },
  });
  expect(result.status).toBe('read');
  return captured;
}

async function eventFor(threadId: string): Promise<CloudEvent> {
  const event = (await collect())
    .flatMap((envelope) => envelope.events)
    .find((event) => event.subject === threadId && event.type === created);
  expect(event).toBeDefined();
  return event!;
}

test('closed content events are registered in the kernel relay catalogue', () => {
  for (const type of [created, revised]) {
    expect(Object.hasOwn(CONTENT_EVENTS, type)).toBe(true);
    expect(Object.hasOwn(EVENT_TYPES, type)).toBe(true);
  }
});

test('board effects feed the existing kernel registerEffects contract', () => {
  const effect = createBoardEffect(db.pool);
  expect(effect.types).toContain(created);
  expect(effect.types).toContain(revised);
  expect(() => registerEffects([effect])).not.toThrow();
});

test('real command outbox creation is asynchronously and idempotently projected in the board partition', async () => {
  const fixture = await source();
  expect(partitionOf(sourceRoute)).not.toBe(partitionOf(boardRoute));
  const event = await eventFor(fixture.threadId);
  expect(event).toMatchObject({
    source: `urn:rezics:log:${fixture.command.partition}.${fixture.command.epoch}`,
    sequence: fixture.command.position.toString().padStart(19, '0'),
    data: { threadId: fixture.threadId, itemId: fixture.itemId, revisionId: fixture.revisionId, actorId: authorId },
  });
  expect((await readBoardCandidates(db.pool, boardId, null, 200)).candidates).toEqual([]);
  // readBatch has released its source transaction before any effect runs.
  const effect = createBoardEffect(db.pool);
  await effect.run(event);
  const first = await readBoardCandidates(db.pool, boardId, null, 200);
  expect(first.candidates).toEqual([
    {
      id: fixture.threadId,
      boardId,
      createdAt,
      epoch: fixture.command.epoch,
      position: fixture.command.position,
    },
  ]);
  const before = await db.admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [
    partitionOf(boardRoute),
  ]);
  await effect.run(event);
  expect(await readBoardCandidates(db.pool, boardId, null, 200)).toEqual(first);
  const after = await db.admin.query('SELECT position FROM core.partition WHERE partition_no = $1', [
    partitionOf(boardRoute),
  ]);
  expect(after.rows).toEqual(before.rows);
  expect(
    (
      await db.admin.query('SELECT route, thread_id FROM content.board_thread WHERE route = $1 AND board_id = $2', [
        boardRoute,
        boardId,
      ])
    ).rows,
  ).toEqual([{ route: boardRoute, thread_id: fixture.threadId }]);
});

test('stale or duplicate events cannot regress a per-thread source epoch and position or immutable ordering', async () => {
  const targetBoard = newId(boardRoute);
  await board(targetBoard);
  const candidate: BoardCandidate = {
    id: newId(sourceRoute),
    boardId: targetBoard,
    createdAt,
    epoch: 1,
    position: 100n,
  };
  await applyBoardCandidate(db.pool, candidate);
  await applyBoardCandidate(db.pool, { ...candidate, epoch: 2, position: 1n });
  await applyBoardCandidate(db.pool, { ...candidate, position: 999n, createdAt: '2030-01-01T00:00:00.000Z' });
  await applyBoardCandidate(db.pool, { ...candidate, epoch: 2, position: 1n });
  const independent: BoardCandidate = { ...candidate, id: newId(sourceRoute), epoch: 1, position: 1n };
  await applyBoardCandidate(db.pool, independent);
  const page = await readBoardCandidates(db.pool, targetBoard, null, 200);
  expect(page.candidates).toEqual(expect.arrayContaining([{ ...candidate, epoch: 2, position: 1n }, independent]));
  expect(page.candidates).toHaveLength(2);
});

test('keyset ties are deterministic and newer insertion between pages cannot duplicate candidates or cross boards', async () => {
  const targetBoard = newId(boardRoute);
  await board(targetBoard);
  await board(otherBoardId);
  const ids = Array.from({ length: 4 }, () => newId(sourceRoute))
    .sort()
    .reverse();
  for (const id of ids)
    await applyBoardCandidate(db.pool, { id, boardId: targetBoard, createdAt, epoch: 1, position: 1n });
  await applyBoardCandidate(db.pool, {
    id: newId(sourceRoute),
    boardId: otherBoardId,
    createdAt,
    epoch: 1,
    position: 1n,
  });
  const first = await readBoardCandidates(db.pool, targetBoard, null, 2);
  expect(first.candidates.map((candidate) => candidate.id)).toEqual(ids.slice(0, 2));
  expect(first.next).toEqual({ createdAt, id: ids[1]! });
  await applyBoardCandidate(db.pool, {
    id: newId(sourceRoute),
    boardId: targetBoard,
    createdAt: '2026-10-26T00:00:00.000Z',
    epoch: 1,
    position: 1n,
  });
  const second = await readBoardCandidates(db.pool, targetBoard, first.next, 2);
  expect(second.candidates.map((candidate) => candidate.id)).toEqual(ids.slice(2));
  expect(new Set([...first.candidates, ...second.candidates].map((candidate) => candidate.id)).size).toBe(4);
  expect((await readBoardCandidates(db.pool, otherBoardId, null, 2)).candidates).toHaveLength(1);
  await expect(readBoardCandidates(db.pool, targetBoard, null, 201)).rejects.toThrow(RangeError);
});

test('source references survive edits and erasure and old creation replay cannot restore searchable bytes', async () => {
  const targetBoard = newId(boardRoute);
  const fixture = await source(targetBoard);
  const event = await eventFor(fixture.threadId);
  const effect = createBoardEffect(db.pool);
  await effect.run(event);
  const original = (await readBoardCandidates(db.pool, targetBoard, null, 2)).candidates[0]!;
  const revisionId = newId(sourceRoute);
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.revision
       (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
        subject_ids, board_id, availability, recorded_transaction_id)
       SELECT route, thread_id, post_id, $4, body, body_sha256, search_text, licence,
         subject_ids, board_id, availability, $5 FROM content.revision
       WHERE route = $1 AND thread_id = $2 AND revision_id = $3`,
      [sourceRoute, fixture.threadId, fixture.revisionId, revisionId, context.transactionId],
    );
    await tx.query('UPDATE content.post SET head_revision_id = $3 WHERE route = $1 AND post_id = $2', [
      sourceRoute,
      fixture.itemId,
      revisionId,
    ]);
    return {
      value: null,
      events: [
        {
          type: revised,
          subject: fixture.threadId,
          data: {
            threadId: fixture.threadId,
            itemId: fixture.itemId,
            revisionId,
            actorId: authorId,
            ...SUBJECT_THREAD_EVENT_FIELDS,
          },
        },
      ],
    };
  });
  const revisionEvent = (await collect())
    .flatMap((envelope) => envelope.events)
    .find((event) => event.type === revised && event.subject === fixture.threadId)!;
  await effect.run(revisionEvent);
  await db.admin.query(
    `UPDATE content.post SET availability = 'erased', security_revision = security_revision + 1
     WHERE route = $1 AND thread_id = $2 AND post_id = $3`,
    [sourceRoute, fixture.threadId, fixture.itemId],
  );
  await db.admin.query(
    `UPDATE content.revision SET body = NULL, body_sha256 = NULL, search_text = NULL, availability = 'erased'
     WHERE route = $1 AND thread_id = $2 AND revision_id = ANY($3::uuid[])`,
    [sourceRoute, fixture.threadId, [fixture.revisionId, revisionId]],
  );
  await effect.run(event);
  const candidate = (await readBoardCandidates(db.pool, targetBoard, null, 2)).candidates[0]!;
  expect(candidate.id).toBe(original.id);
  expect(candidate.createdAt).toBe(original.createdAt);
  expect(candidate.position).toBeGreaterThan(original.position);
  const sourceRows = await db.admin.query(
    'SELECT availability, body, body_sha256, search_text FROM content.revision WHERE route = $1 AND thread_id = $2 AND revision_id = $3',
    [sourceRoute, candidate.id, revisionId],
  );
  expect(sourceRows.rows).toEqual([{ availability: 'erased', body: null, body_sha256: null, search_text: null }]);
  const projection = await db.admin.query(
    'SELECT to_jsonb(c) AS value FROM content.board_thread c WHERE route = $1 AND board_id = $2',
    [boardRoute, targetBoard],
  );
  expect(JSON.stringify(projection.rows)).not.toContain('private source bytes');
  expect(JSON.stringify(projection.rows)).not.toContain('Private title');
});

test('board projection SQL is partition bound and candidate pages do not join source partitions', async () => {
  for (const name of ['upsert-board-thread', 'page-board-threads']) {
    const { default: query } = await import(`../../src/content/${name}.sql`);
    expect(await checkStatement(db.admin, query)).toMatchObject({ bound: true });
    expect(query.sql).not.toMatch(/\b(?:JOIN|OFFSET|COUNT)\b/i);
  }
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const targetBoard = newId(boardRoute);
  await board(targetBoard);
  const id = newId(sourceRoute);
  async function grow(database: GrowthDatabase, scale: number, previous: number) {
    // Setup is outside measurement. Grow both the exact board and same-route other boards.
    const rows = Array.from({ length: scale - previous }, () => ({
      thread_id: newId(sourceRoute),
      other_id: newId(sourceRoute),
      other_board: newId(boardRoute),
    }));
    await database.admin.query(
      `INSERT INTO content.board_thread (route, board_id, thread_id, created_at, source_epoch, source_position)
       SELECT $1::integer, $2::uuid, x.thread_id, '2020-01-01'::timestamptz, 1::integer, 1::bigint
       FROM jsonb_to_recordset($3::jsonb) x(thread_id uuid)
       UNION ALL SELECT $1::integer, x.other_board, x.other_id, '2020-01-01'::timestamptz, 1::integer, 1::bigint
       FROM jsonb_to_recordset($3::jsonb) x(other_board uuid, other_id uuid)`,
      [boardRoute, targetBoard, JSON.stringify(rows)],
    );
    await database.admin.query('VACUUM (ANALYZE) content.board_thread');
  }
  const report = await checkGrowth(db, {
    name: 'board candidate upsert and fixed keyset page',
    scales: [32, 256, 2048],
    grow,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    operation: async (database, _scale, repetition) => {
      // A fresh source position changes every write's identity, so a receipt cannot replace the effect.
      await applyBoardCandidate(database.pool, {
        id,
        boardId: targetBoard,
        createdAt,
        epoch: 1,
        position: BigInt(repetition + 1),
      });
      const page = await readBoardCandidates(database.pool, targetBoard, { createdAt, id }, 8);
      expect(page.candidates).toHaveLength(8);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
  expect(report.samples.every((sample) => (sample.cost.relations?.['content.board_thread']?.rows ?? 0) > 0)).toBe(true);
  console.info('Board projection GrowthReport', JSON.stringify(report));
}, 60_000);
