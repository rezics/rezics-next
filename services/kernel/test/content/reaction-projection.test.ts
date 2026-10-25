import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import {
  createReactionCountEffect,
  projectReactionCounts,
  readReactionCounts,
  type ReactionCounts,
} from '../../src/content/reaction-projection.ts';
import { registerEffects } from '../../src/events/effects.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { checkStatement } from '../support/partition-binding.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const changed = 'com.rezics.content.reaction.changed.v1';

function consumer(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function countOf(read: ReactionCounts, kind: string): number {
  return read.counts.find((row) => row.kind === kind)?.count ?? 0;
}

function sum(read: ReactionCounts): number {
  return read.counts.reduce((total, row) => total + row.count, 0);
}

function later(
  left: { epoch: number; position: bigint },
  right: { epoch: number; position: bigint },
): { epoch: number; position: bigint } {
  if (left.epoch !== right.epoch) return left.epoch > right.epoch ? left : right;
  return left.position >= right.position ? left : right;
}

async function readCounts(targetId: string): Promise<ReactionCounts> {
  const client = await db.pool.connect();
  try {
    return await readReactionCounts(client, { targetId });
  } finally {
    client.release();
  }
}

async function append(
  actorRoute: number,
  actorId: string,
  targetId: string,
  targetKind: 'thread' | 'post',
  previousKind: 'upvote' | 'like' | null,
  kind: 'upvote' | 'like' | null,
) {
  return runCommand(db.pool, { partition: partitionOf(actorRoute) }, async () => ({
    value: null,
    events: [
      {
        type: changed,
        subject: targetId,
        data: { actorId, targetKind, targetId, previousKind, kind },
      },
    ],
  }));
}

async function capture(partition: number): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  const result = await projectBatch(db.pool, {
    consumer: consumer('reaction_capture'),
    partition,
    apply: async (envelopes) => {
      for (const envelope of envelopes) events.push(...envelope.events);
    },
  });
  expect(result.status).toBe('read');
  return events;
}

test('reaction count effects feed the kernel registerEffects contract', () => {
  const effect = createReactionCountEffect(db.pool);
  expect(effect.name).toBe('content_reaction_count');
  expect(effect.types).toEqual([changed]);
  expect(() => registerEffects([effect])).not.toThrow();
});

test('reaction count SQL is partition bound', async () => {
  for (const name of ['reaction-count-upsert', 'reaction-count-read']) {
    const { default: query } = await import(`../../src/content/${name}.sql`);
    expect(await checkStatement(db.admin, query)).toEqual({ bound: true, parameter: 'route' });
  }
});

test('reaction change events aggregate into per-target, per-kind counts in the target partition with a declared freshness watermark', async () => {
  const actorRoute = 0x2100;
  const otherActorRoute = 0x2110;
  const targetRoute = 0x4500;
  const actorPartition = partitionOf(actorRoute);
  const otherPartition = partitionOf(otherActorRoute);
  expect(actorPartition).not.toBe(partitionOf(targetRoute));
  expect(otherPartition).not.toBe(partitionOf(targetRoute));
  expect(actorPartition).not.toBe(otherPartition);

  const actorId = newId(actorRoute);
  const otherActorId = newId(otherActorRoute);
  const targetId = newId(targetRoute);
  const otherTargetId = newId(targetRoute);
  const upvote = await append(actorRoute, actorId, targetId, 'thread', null, 'upvote');
  const alsoUpvote = await append(otherActorRoute, otherActorId, targetId, 'thread', null, 'upvote');
  const like = await append(actorRoute, actorId, otherTargetId, 'thread', null, 'like');

  const first = await projectReactionCounts(db.pool, actorPartition);
  const second = await projectReactionCounts(db.pool, otherPartition);
  if (first.status !== 'read' || second.status !== 'read') throw new Error('Reaction projection did not read the log');
  expect(first.envelopes).toBeGreaterThan(0);
  expect(second.envelopes).toBeGreaterThan(0);

  const counts = await readCounts(targetId);
  expect(counts.counts).toEqual([{ kind: 'upvote', count: 2 }]);
  expect(counts.watermark).toEqual(
    later(
      { epoch: upvote.epoch, position: upvote.position },
      { epoch: alsoUpvote.epoch, position: alsoUpvote.position },
    ),
  );
  const other = await readCounts(otherTargetId);
  expect(other.counts).toEqual([{ kind: 'like', count: 1 }]);
  expect(other.watermark).toEqual({ epoch: like.epoch, position: like.position });

  const stored = await db.admin.query<{ route: number }>(
    'SELECT route FROM content.reaction_count WHERE target_id = ANY($1::uuid[])',
    [[targetId, otherTargetId]],
  );
  expect(stored.rows).toHaveLength(3);
  expect(stored.rows.every((row) => row.route === targetRoute)).toBe(true);

  const replay = await projectReactionCounts(db.pool, actorPartition);
  expect(replay).toEqual({ status: 'read', envelopes: 0, position: first.position });
  const again = await readCounts(targetId);
  expect(again.counts).toEqual([{ kind: 'upvote', count: 2 }]);
  expect(again.watermark).toEqual(
    later(
      { epoch: upvote.epoch, position: upvote.position },
      { epoch: alsoUpvote.epoch, position: alsoUpvote.position },
    ),
  );
});

test('replayed, reordered or duplicate events never double count, and a cleared or changed reaction moves exactly one count', async () => {
  const actorRoute = 0x3100;
  const targetRoute = 0x4600;
  const actorId = newId(actorRoute);
  const orderedTarget = newId(targetRoute);
  const reorderedTarget = newId(targetRoute);
  const partition = partitionOf(actorRoute);
  const ordered = {
    set: await append(actorRoute, actorId, orderedTarget, 'post', null, 'upvote'),
    change: await append(actorRoute, actorId, orderedTarget, 'post', 'upvote', 'like'),
    clear: await append(actorRoute, actorId, orderedTarget, 'post', 'like', null),
  };
  const reordered = {
    set: await append(actorRoute, actorId, reorderedTarget, 'post', null, 'upvote'),
    change: await append(actorRoute, actorId, reorderedTarget, 'post', 'upvote', 'like'),
    clear: await append(actorRoute, actorId, reorderedTarget, 'post', 'like', null),
  };
  const captured = await capture(partition);
  const orderedEvents = captured.filter((event) => event.subject === orderedTarget && event.type === changed);
  const reorderedEvents = captured.filter((event) => event.subject === reorderedTarget && event.type === changed);
  expect(orderedEvents.map((event) => event.sequence)).toEqual([
    ordered.set.position.toString().padStart(19, '0'),
    ordered.change.position.toString().padStart(19, '0'),
    ordered.clear.position.toString().padStart(19, '0'),
  ]);
  expect(reorderedEvents).toHaveLength(3);

  const effect = createReactionCountEffect(db.pool);
  await effect.run(orderedEvents[0]!);
  const set = await readCounts(orderedTarget);
  expect(set.counts).toEqual([{ kind: 'upvote', count: 1 }]);
  expect(set.watermark).toEqual({ epoch: ordered.set.epoch, position: ordered.set.position });

  await effect.run(orderedEvents[1]!);
  const changedCounts = await readCounts(orderedTarget);
  expect(countOf(set, 'upvote') - countOf(changedCounts, 'upvote')).toBe(1);
  expect(countOf(changedCounts, 'like') - countOf(set, 'like')).toBe(1);
  expect(sum(changedCounts)).toBe(sum(set));
  expect(changedCounts.counts).toEqual([{ kind: 'like', count: 1 }]);
  expect(changedCounts.watermark).toEqual({ epoch: ordered.change.epoch, position: ordered.change.position });

  await effect.run(orderedEvents[2]!);
  const cleared = await readCounts(orderedTarget);
  expect(countOf(changedCounts, 'like') - countOf(cleared, 'like')).toBe(1);
  expect(sum(cleared)).toBe(sum(changedCounts) - 1);
  expect(cleared.counts).toEqual([]);
  expect(cleared.watermark).toEqual({ epoch: ordered.clear.epoch, position: ordered.clear.position });

  for (const event of orderedEvents) await effect.run(event);
  const replayed = await readCounts(orderedTarget);
  expect(replayed.counts).toEqual([]);
  expect(replayed.watermark).toEqual({ epoch: ordered.clear.epoch, position: ordered.clear.position });

  for (const event of [...reorderedEvents].reverse()) await effect.run(event);
  const disordered = await readCounts(reorderedTarget);
  expect(disordered.counts).toEqual([]);
  expect(sum(disordered)).toBe(0);
  expect(disordered.watermark).toEqual({ epoch: reordered.clear.epoch, position: reordered.clear.position });

  for (const event of reorderedEvents) await effect.run(event);
  const disorderedAgain = await readCounts(reorderedTarget);
  expect(disorderedAgain.counts).toEqual([]);
  expect(disorderedAgain.watermark).toEqual({ epoch: reordered.clear.epoch, position: reordered.clear.position });
});

test('aggregation cost is O(changes) as reactions and targets grow', async () => {
  const actorRoute = 0x3200;
  const targetRoute = 0x4700;
  const actorId = newId(actorRoute);
  const targetId = newId(targetRoute);
  const sourcePartition = partitionOf(actorRoute);
  const batch = 2;
  const population: Population = {
    name: `reaction-counts-${randomUUID()}`,
    hotPartition: partitionOf(targetRoute),
    hotShare: 1,
    rows: () => ({
      'content.reaction_count': [
        {
          route: targetRoute,
          target_id: newId(targetRoute),
          source_partition: 1,
          kind: 'like',
          count: 1,
          source_epoch: 1,
          source_position: 1,
        },
      ],
    }),
  };
  const effect = createReactionCountEffect(db.pool);
  const report = await checkGrowth(db, {
    name: 'Reaction count aggregation',
    scales: [2048, 8192, 32768],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      await seed(growthDb, population, { from: previous, to: scale });
    },
    operation: async (_growthDb, _scale, repetition) => {
      const base = BigInt(repetition + 1) * 10n;
      const events: CloudEvent[] = [event(base + 1n, 'like', 'love'), event(base + 2n, 'love', 'like')];
      for (const item of events) await effect.run(item);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([2048, 8192, 32768]);
  const first = report.samples[0]!;
  expect(batch).toBe(2);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBe(first.cost.statements);
    expect(sample.cost.rows).toBe(first.cost.rows);
    expect(sample.cost.relations['content.reaction']).toBeUndefined();
    expect(sample.cost.relations['content.reaction_count']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.cost.relations['content.reaction_count']?.sequentialScans).toBe(0);
    for (const relation of Object.values(sample.cost.relations)) expect(relation.sequentialScans).toBe(0);
  }

  function event(position: bigint, previousKind: 'like' | 'love', kind: 'like' | 'love'): CloudEvent {
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
}, 180_000);
