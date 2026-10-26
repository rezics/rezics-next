import { afterAll, expect, test } from 'bun:test';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import {
  applyReactionCountEnvelopes,
  createReactionCountEffect,
  readReactionCounts,
  type ReactionCounts,
} from '../../src/content/reaction-projection.ts';
import { withReactionCounts, type ContentReadDependencies } from '../../src/content/reads.ts';
import { projectBatch, type CloudEvent, type Envelope } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { capture, costOf, openGrowthDatabase } from '../support/growth.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const changed = 'com.rezics.content.reaction.changed.v1';
const kinds = ['upvote', 'downvote', 'like', 'love', 'laugh', 'insightful', 'sad'] as const;
type CountRow = { kind: (typeof kinds)[number]; count: number };

function consumer(): string {
  return `reaction_totals_${randomUUID().replaceAll('-', '')}`;
}

function event(
  actorId: string,
  targetId: string,
  position: bigint,
  previousKind: (typeof kinds)[number] | null,
  kind: (typeof kinds)[number] | null,
): CloudEvent {
  const sourcePartition = partitionOf(routeOf(actorId)!);
  return {
    specversion: '1.0',
    id: randomUUID(),
    source: `urn:rezics:log:${sourcePartition}.1`,
    type: changed,
    subject: targetId,
    time: '2026-10-25T00:00:00.000Z',
    datacontenttype: 'application/json',
    sequence: position.toString().padStart(19, '0'),
    data: { actorId, targetKind: 'thread', targetId, previousKind, kind },
  };
}

async function append(
  actorId: string,
  targetId: string,
  previousKind: (typeof kinds)[number] | null,
  kind: (typeof kinds)[number] | null,
) {
  const actorRoute = routeOf(actorId);
  if (actorRoute === null) throw new TypeError('Invalid fixture actor');
  return runCommand(db.pool, { partition: partitionOf(actorRoute) }, async () => ({
    value: null,
    events: [
      { type: changed, subject: targetId, data: { actorId, targetKind: 'thread', targetId, previousKind, kind } },
    ],
  }));
}

async function captureEvents(partition: number): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  const result = await projectBatch(db.pool, {
    consumer: consumer(),
    partition,
    apply: async (envelopes) => {
      for (const envelope of envelopes) events.push(...envelope.events);
    },
  });
  expect(result.status).toBe('read');
  return events;
}

async function readCounts(targetId: string): Promise<ReactionCounts> {
  const client = await db.pool.connect();
  try {
    return await readReactionCounts(client, { targetId });
  } finally {
    client.release();
  }
}

async function totalAndContributionRows(targetId: string) {
  const totals = await db.admin.query<CountRow>(
    `SELECT kind, count FROM content.reaction_total WHERE target_id = $1::uuid ORDER BY kind`,
    [targetId],
  );
  const contributions = await db.admin.query<CountRow>(
    `SELECT kind, sum(count)::integer AS count
     FROM content.reaction_count WHERE target_id = $1::uuid GROUP BY kind ORDER BY kind`,
    [targetId],
  );
  return { totals: totals.rows, contributions: contributions.rows };
}

async function expectTotalsMatchContributions(targetId: string): Promise<void> {
  const rows = await totalAndContributionRows(targetId);
  expect(rows.totals).toEqual(rows.contributions);
  const read = await readCounts(targetId);
  expect(read.counts).toEqual(
    rows.contributions.filter((row) => row.count > 0).map(({ kind, count }) => ({ kind, count })),
  );
}

test('reaction totals stay equal to contributions after actual log events are replayed, stale and reordered', async () => {
  const actorRoute = 0x3100;
  const actorId = newId(actorRoute);
  const sourcePartition = partitionOf(actorRoute);
  const orderedTarget = newId(0x4600);
  const reorderedTarget = newId(0x4600);
  const records = [
    await append(actorId, orderedTarget, null, 'upvote'),
    await append(actorId, reorderedTarget, null, 'upvote'),
    await append(actorId, orderedTarget, 'upvote', 'like'),
    await append(actorId, reorderedTarget, 'upvote', 'like'),
    await append(actorId, orderedTarget, 'like', null),
    await append(actorId, reorderedTarget, 'like', null),
  ];
  expect(records.every((record) => record.partition === sourcePartition)).toBe(true);
  const captured = await captureEvents(sourcePartition);
  const orderedEvents = captured.filter((item) => item.subject === orderedTarget && item.type === changed);
  const reorderedEvents = captured.filter((item) => item.subject === reorderedTarget && item.type === changed);
  expect(orderedEvents).toHaveLength(3);
  expect(reorderedEvents).toHaveLength(3);

  const effect = createReactionCountEffect(db.pool);
  for (const item of orderedEvents) {
    await effect.run(item);
    await expectTotalsMatchContributions(orderedTarget);
  }
  const afterNewest = await totalAndContributionRows(orderedTarget);
  await effect.run(orderedEvents[0]!);
  await effect.run(orderedEvents[2]!);
  expect(await totalAndContributionRows(orderedTarget)).toEqual(afterNewest);
  await expectTotalsMatchContributions(orderedTarget);

  for (const item of [...reorderedEvents].reverse()) {
    await effect.run(item);
    await expectTotalsMatchContributions(reorderedTarget);
  }
  for (const item of reorderedEvents) await effect.run(item);
  await expectTotalsMatchContributions(reorderedTarget);
});

function envelope(partition: number, position: bigint, item: CloudEvent): Envelope {
  return { partition, epoch: 1, position, events: [item] };
}

// Contribution rows and totals are seeded in bulk; a few real events prove the projection writes the rows the reads use.
async function seedContributions(route: number, targetId: string, partitions: readonly number[]): Promise<void> {
  if (partitions.length === 0) return;
  await db.admin.query(
    `INSERT INTO content.reaction_count (route, target_id, source_partition, kind, count, source_epoch, source_position)
     SELECT $1::integer, $2::uuid, partition, 'upvote', 1, 1, 1 FROM unnest($3::integer[]) AS partition`,
    [route, targetId, partitions],
  );
  await db.admin.query(
    `INSERT INTO content.reaction_total AS stored (route, target_id, kind, count, source_epoch, source_position)
     VALUES ($1::integer, $2::uuid, 'upvote', $3::integer, 1, 1)
     ON CONFLICT (route, target_id, kind) DO UPDATE SET count = stored.count + EXCLUDED.count`,
    [route, targetId, partitions.length],
  );
}

test('single-target and page reads stay within seven rows as 256, 1024 and 4096 contributors accumulate', async () => {
  const targetRoute = 0x4700;
  const targetId = newId(targetRoute);
  const sourcePositions = new Map<number, bigint>();
  const anchorActor = newId(targetRoute);
  // Commands establish the target partition through the owning command path.
  await append(anchorActor, targetId, null, null);

  async function apply(items: readonly Envelope[]): Promise<void> {
    await applyReactionCountEnvelopes(db.pool, items);
  }

  function next(partition: number, itemTarget: string): Envelope {
    const position = (sourcePositions.get(partition) ?? 0n) + 1n;
    sourcePositions.set(partition, position);
    const actorId = newId(partition * 16);
    return envelope(partition, position, event(actorId, itemTarget, position, null, 'upvote'));
  }

  // Keep the totals relation large enough to test its indexed read plan from the first scale.
  const otherTargets = Array.from({ length: 2047 }, () => newId(targetRoute));
  await db.admin.query(
    `INSERT INTO content.reaction_count (route, target_id, source_partition, kind, count, source_epoch, source_position)
     SELECT $1::integer, id, ordinal - 1, 'upvote', 1, 1, 1 FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ordinal)`,
    [targetRoute, otherTargets],
  );
  await db.admin.query(
    `INSERT INTO content.reaction_total (route, target_id, kind, count, source_epoch, source_position)
     SELECT $1::integer, id, 'upvote', 1, 1, 1 FROM unnest($2::uuid[]) AS id`,
    [targetRoute, otherTargets],
  );
  const samples: Array<{ scale: number; single: number; page: number; statements: number }> = [];
  const scales = [256, 1024, 4096] as const;
  const realPerScale = 3;
  let seeded = 0;
  let real = 0;
  for (const scale of scales) {
    // Real events take the highest source partitions, so the bulk range below never overlaps them.
    const events: Envelope[] = [];
    for (let count = 0; count < realPerScale; count++) events.push(next(4095 - real - count, targetId));
    real += realPerScale;
    await apply(events);
    const bulkEnd = scale - real;
    await seedContributions(
      targetRoute,
      targetId,
      Array.from({ length: bulkEnd - seeded }, (_, index) => seeded + index),
    );
    seeded = bulkEnd;

    const read = await readCounts(targetId);
    expect(read.counts).toEqual([{ kind: 'upvote', count: scale }]);
    await expectTotalsMatchContributions(targetId);

    const singleTrace = await capture(db, () => readCounts(targetId));
    const singleCost = costOf(singleTrace.capture);
    const pageTrace = await capture(db, () =>
      withReactionCounts({ pool: db.pool } as ContentReadDependencies, [{ id: targetId }], Date.now() + 10_000),
    );
    const pageCost = costOf(pageTrace.capture);
    const singleRows = singleCost.relations['content.reaction_total']?.rows ?? 0;
    const pageRows = pageCost.relations['content.reaction_total']?.rows ?? 0;
    expect(singleRows).toBeLessThanOrEqual(7);
    expect(pageRows).toBeLessThanOrEqual(7);
    expect(singleTrace.capture.statements.filter((sql) => sql.includes('content.reaction_total'))).toHaveLength(1);
    expect(pageTrace.capture.statements.filter((sql) => sql.includes('content.reaction_total'))).toHaveLength(1);
    samples.push({
      scale,
      single: singleCost.rows,
      page: pageCost.rows,
      statements: pageCost.statements,
    });
  }
  expect(samples.map((sample) => sample.scale)).toEqual([256, 1024, 4096]);
  expect(samples.map((sample) => sample.single)).toEqual([samples[0]!.single, samples[0]!.single, samples[0]!.single]);
  expect(samples.map((sample) => sample.page)).toEqual([samples[0]!.page, samples[0]!.page, samples[0]!.page]);
  expect(samples.map((sample) => sample.statements)).toEqual([
    samples[0]!.statements,
    samples[0]!.statements,
    samples[0]!.statements,
  ]);
}, 180_000);

test('reaction totals migration backfills contribution sums and newest source watermarks', async () => {
  const adminUrl = new URL(db.url);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Pool({ connectionString: adminUrl.href, max: 1 });
  const databaseName = `reaction_totals_${randomUUID().replaceAll('-', '')}`;
  let targetPool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const targetUrl = new URL(db.url);
    targetUrl.pathname = `/${databaseName}`;
    targetPool = new pg.Pool({ connectionString: targetUrl.href, max: 1 });
    await targetPool.query('CREATE SCHEMA content');
    await targetPool.query(`
      CREATE TABLE content.reaction_count (
        route integer NOT NULL,
        target_id uuid NOT NULL,
        source_partition integer NOT NULL,
        kind text NOT NULL,
        count integer NOT NULL,
        source_epoch integer NOT NULL,
        source_position bigint NOT NULL
      )
    `);
    const targetId = newId(0x4900);
    const otherTargetId = newId(0x4910);
    const targetRoute = routeOf(targetId)!;
    const otherTargetRoute = routeOf(otherTargetId)!;
    await targetPool.query(
      `INSERT INTO content.reaction_count
         (route,target_id,source_partition,kind,count,source_epoch,source_position)
       VALUES
         ($1,$2,1,'upvote',4,1,10),
         ($1,$2,2,'upvote',3,2,5),
         ($1,$2,3,'like',0,3,2),
         ($3,$4,4,'love',7,1,25)`,
      [targetRoute, targetId, otherTargetRoute, otherTargetId],
    );
    const migrationPath = new URL('../../db/content/migrations/20261025225727_reaction_totals.sql', import.meta.url);
    const migration = await Bun.file(migrationPath).text();
    const up = migration.split('-- migrate:up')[1]?.split('-- migrate:down')[0]?.trim();
    if (!up) throw new Error('Reaction totals migration has no up section');
    await targetPool.query(up);
    const rows = await targetPool.query<{
      target_id: string;
      kind: string;
      count: number;
      source_epoch: number;
      source_position: string;
    }>(
      `SELECT target_id,kind,count,source_epoch,source_position::text AS source_position
       FROM content.reaction_total ORDER BY target_id,kind`,
    );
    expect(rows.rows).toEqual([
      { target_id: targetId, kind: 'like', count: 0, source_epoch: 3, source_position: '2' },
      { target_id: targetId, kind: 'upvote', count: 7, source_epoch: 2, source_position: '5' },
      { target_id: otherTargetId, kind: 'love', count: 7, source_epoch: 1, source_position: '25' },
    ]);
  } finally {
    await targetPool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await admin.end();
  }
});
