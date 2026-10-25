import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPool } from '../../src/database/pool.ts';
import { LINKS_PROJECTED } from '../../src/semantic/events.ts';
import { LINKS_CONSUMER, linkProjection } from '../../src/semantic/links.ts';
import { newId, partitionOf } from '../../src/route/route.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
afterAll(async () => {
  await pool.end();
  await admin.end();
});

const projection = linkProjection(pool);
let nextPartition = 1024 + Math.floor(Math.random() * 2048);

type Draft = { type: string; subject?: string; data: unknown };

async function append(partition: number, events: Draft[]): Promise<bigint> {
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ epoch: number; position: string }>(
      'UPDATE core.partition SET position = position + 1 WHERE partition_no = $1 RETURNING epoch, position::text',
      [partition],
    );
    const { epoch, position } = rows[0]!;
    for (const [seq, event] of events.entries()) {
      await client.query(
        `INSERT INTO core.outbox (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          partition,
          position,
          seq,
          events.length,
          epoch,
          Bun.randomUUIDv7(),
          event.type,
          event.subject ?? null,
          JSON.stringify(event.data),
        ],
      );
    }
    await client.query('COMMIT');
    return BigInt(position);
  } finally {
    client.release();
  }
}

test("a batch's link changes apply out of order and twice and keep the newest state", async () => {
  const sourcePartition = nextPartition++;
  const targetPartition = nextPartition++;
  const sourceRoute = sourcePartition << 4;
  const targetRoute = targetPartition << 4;
  const sourceId = newId(sourceRoute);
  const targetId = newId(targetRoute);
  const statementA = newId(sourceRoute);
  const statementB = newId(sourceRoute);
  const statementC = newId(sourceRoute);
  expect(partitionOf(sourceRoute)).toBe(sourcePartition);
  expect(partitionOf(targetRoute)).toBe(targetPartition);

  const changed = (
    revision: number,
    changes: { property: string; statement: string; target: string; present: boolean }[],
  ) => ({
    type: 'com.rezics.semantic.links.changed.v1',
    subject: sourceId,
    data: { subject: sourceId, revision, changes },
  });
  const property = 'schema:exampleOfWork';
  await append(sourcePartition, [
    changed(4, [
      { property, statement: statementA, target: targetId, present: false },
      { property, statement: statementB, target: targetId, present: true },
    ]),
    { type: 'com.rezics.subject.created.v1', subject: sourceId, data: { id: sourceId } },
  ]);
  await append(sourcePartition, [
    changed(1, [
      { property, statement: statementA, target: targetId, present: true },
      { property, statement: statementC, target: targetId, present: true },
    ]),
  ]);
  await append(sourcePartition, [
    changed(3, [
      { property, statement: statementB, target: targetId, present: false },
      { property, statement: statementC, target: targetId, present: true },
    ]),
  ]);

  const applied = await projection.run(sourcePartition);
  expect(applied.status).toBe('read');
  const read = async () => {
    const { rows } = await admin.query<{
      statement_id: string;
      source_revision: number;
      present: boolean;
      recorded_transaction_id: string;
    }>(
      `SELECT statement_id::text, source_revision, present, recorded_transaction_id::text
       FROM semantic.inbound_link WHERE subject_id = $1 ORDER BY statement_id`,
      [targetId],
    );
    return rows;
  };
  const expected = [
    { statement_id: statementA, source_revision: 4, present: false },
    { statement_id: statementB, source_revision: 4, present: true },
    { statement_id: statementC, source_revision: 3, present: true },
  ].sort((left, right) => (left.statement_id < right.statement_id ? -1 : 1));
  const first = await read();
  expect(
    first.map(({ statement_id, source_revision, present }) => ({ statement_id, source_revision, present })),
  ).toEqual(expected);
  const transactions = first.map((row) => row.recorded_transaction_id);

  const again = await projection.run(sourcePartition);
  expect(again).toMatchObject({ status: 'read', envelopes: 0 });
  expect((await read()).map((row) => row.recorded_transaction_id)).toEqual(transactions);

  await admin.query(
    `UPDATE core.consumer_checkpoint SET epoch = NULL, position = 0
     WHERE consumer = $1 AND partition_no = $2`,
    [LINKS_CONSUMER, sourcePartition],
  );
  const replayed = await projection.run(sourcePartition);
  expect(replayed.status).toBe('read');
  if (replayed.status === 'read') expect(replayed.envelopes).toBeGreaterThan(0);
  const afterReplay = await read();
  expect(
    afterReplay.map(({ statement_id, source_revision, present }) => ({ statement_id, source_revision, present })),
  ).toEqual(expected);
  expect(afterReplay.map((row) => row.recorded_transaction_id)).toEqual(transactions);

  const projected = await admin.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM core.outbox WHERE partition_no = $1 AND type = $2',
    [targetPartition, LINKS_PROJECTED],
  );
  expect(projected.rows[0]!.count).toBe(2);
});
