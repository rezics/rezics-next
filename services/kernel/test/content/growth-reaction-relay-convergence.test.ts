import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { AccountActor } from '../../src/request/access.ts';
import { setReaction } from '../../src/content/reactions.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import {
  createReactionRelayBase,
  readPartitionPosition,
  startReactionEffects,
  type ReactionRelayBase,
  type ReactionWorkRuntime,
} from './reaction-relay-convergence-fixture.ts';

const scales = [256, 1024, 4096] as const;

let base: ReactionRelayBase | undefined;
let growth: GrowthDatabase | undefined;
let runtime: ReactionWorkRuntime | undefined;

type RunEvidence = {
  readonly scale: number;
  readonly targetId: string;
  readonly targetRoute: number;
  readonly targetPartition: number;
  readonly sourcePartition: number;
  readonly sourceEpoch: number;
  readonly sourcePosition: string;
  readonly capturePosition: string;
  readonly captureConsumer: string;
  readonly idempotencyKey: string;
};

type PopulationEvidence = {
  readonly scale: number;
  readonly total: Readonly<Record<'reaction' | 'receipt' | 'count' | 'total', number>>;
  readonly hot: Readonly<Record<'reaction' | 'receipt' | 'count' | 'total', number>>;
};

afterAll(async () => {
  try {
    await runtime?.stop();
  } finally {
    try {
      await growth?.close();
    } finally {
      await base?.system.close();
    }
  }
});

async function count(pool: GrowthDatabase['admin'], sql: string, values: readonly unknown[] = []): Promise<number> {
  const row = (await pool.query<{ count: string }>(sql, [...values])).rows[0];
  if (!row) throw new Error('Expected a growth population count');
  return Number(row.count);
}

async function captureEvidence(
  db: GrowthDatabase,
  actorId: string,
  targetRoute: number,
): Promise<{
  readonly consumer: string;
  readonly before: { epoch: number; position: string };
  readonly targetPosition: { epoch: number; position: string };
}> {
  const actorRoute = routeOf(actorId);
  if (actorRoute === null) throw new TypeError('The native reaction actor has no route');
  const sourcePartition = partitionOf(actorRoute);
  const before = await readPartitionPosition(db.pool, sourcePartition);
  const targetPosition = await readPartitionPosition(db.pool, partitionOf(targetRoute));
  const consumer = `reaction_growth_${randomUUID().replaceAll('-', '')}`;
  await db.admin.query(
    `INSERT INTO core.consumer_checkpoint (partition_no,consumer,epoch,position)
     VALUES ($1,$2,$3,$4)`,
    [sourcePartition, consumer, before.epoch, before.position],
  );
  return { consumer, before, targetPosition };
}

async function executeJoinedOperation(
  db: GrowthDatabase,
  actor: AccountActor,
  targetId: string,
  evidence: Awaited<ReturnType<typeof captureEvidence>>,
  scale: number,
  idempotencyKey: string,
): Promise<RunEvidence> {
  const targetRoute = routeOf(targetId);
  const actorRoute = routeOf(actor.accountId);
  if (targetRoute === null || actorRoute === null) throw new TypeError('The native operation requires routed ids');
  const targetPartition = partitionOf(targetRoute);
  const sourcePartition = partitionOf(actorRoute);
  if (targetPartition === sourcePartition) throw new Error('Reaction source and target require distinct partitions');

  const result = await setReaction(
    { pool: db.pool, access: base!.system.access },
    actor,
    { targetKind: 'thread', targetId, kind: 'like' },
    { idempotencyKey, deadline: Date.now() + 30_000, requestId: randomUUID() },
  );
  if (!result || result.value.kind !== 'like')
    throw new Error('The native reaction command did not commit a slot change');

  const envelopes: Envelope[] = [];
  const batch = await readBatch(db.pool, {
    consumer: evidence.consumer,
    partition: sourcePartition,
    envelopes: 1,
    apply: async (read) => {
      envelopes.push(...read);
    },
  });
  if (batch.status !== 'read' || envelopes.length !== 1)
    throw new Error(`The committed reaction event was unavailable to the native reader (${batch.status})`);
  const envelope = envelopes[0]!;
  if (
    envelope.partition !== sourcePartition ||
    envelope.epoch !== evidence.before.epoch ||
    envelope.position <= BigInt(evidence.before.position)
  )
    throw new Error('The reaction event did not advance its actor source partition');
  const matching = envelope.events.filter(
    (event) =>
      event.type === 'com.rezics.content.reaction.changed.v1' &&
      (event.data as { actorId?: unknown; targetId?: unknown; kind?: unknown }).actorId === actor.accountId &&
      (event.data as { targetId?: unknown }).targetId === targetId &&
      (event.data as { kind?: unknown }).kind === 'like',
  );
  if (matching.length !== 1) throw new Error('The real outbox did not return the committed target reaction event');
  const effect = runtime!.reactionEffects[0]!;
  await effect.run(matching[0]!);
  await effect.run(matching[0]!);
  return {
    scale,
    targetId,
    targetRoute,
    targetPartition,
    sourcePartition,
    sourceEpoch: envelope.epoch,
    sourcePosition: envelope.position.toString(),
    capturePosition: batch.position.toString(),
    captureConsumer: evidence.consumer,
    idempotencyKey,
  };
}

function growthPopulation(actorId: string, actorRoute: number, targetRoute: number, scale: number): Population {
  return {
    name: `reaction-relay-${scale}-${randomUUID().replaceAll('-', '')}`,
    hotPartition: partitionOf(actorRoute),
    hotShare: 0.5,
    rows({ ordinal, route, partition }) {
      const actorTarget = newId(targetRoute);
      const unrelatedActorId = newId(route);
      const unrelatedTargetRoute = (targetRoute + 0x1000 + (ordinal % 0x1000)) % 0x10000;
      const unrelatedTarget = newId(unrelatedTargetRoute);
      const transactionId = randomUUID();
      const unrelatedTransactionId = randomUUID();
      const sequence = ordinal + 1;
      return {
        'content.reaction': [
          {
            route: actorRoute,
            actor_account_id: actorId,
            target_kind: 'thread',
            target_route: targetRoute,
            target_id: actorTarget,
            kind: 'love',
            updated_at: '2026-10-01T00:00:00.000Z',
          },
          {
            route,
            actor_account_id: unrelatedActorId,
            target_kind: 'thread',
            target_route: unrelatedTargetRoute,
            target_id: unrelatedTarget,
            kind: 'like',
            updated_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        'core.receipt': [
          {
            partition_no: partitionOf(actorRoute),
            principal_kind: 'account',
            principal_id: actorId,
            command_kind: 'content.reaction.set',
            idempotency_key: `reaction-history-${scale}-${ordinal}`,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: sequence,
            transaction_id: transactionId,
            response: { targetId: actorTarget, kind: 'love' },
          },
          {
            partition_no: partition,
            principal_kind: 'account',
            principal_id: unrelatedActorId,
            command_kind: 'content.reaction.set',
            idempotency_key: `unrelated-reaction-history-${scale}-${ordinal}`,
            request_digest: new Uint8Array(32),
            epoch: 1,
            position: sequence,
            transaction_id: unrelatedTransactionId,
            response: { targetId: unrelatedTarget, kind: 'like' },
          },
        ],
        'content.reaction_count': [
          {
            route: targetRoute,
            target_id: actorTarget,
            source_partition: partitionOf(actorRoute),
            kind: 'love',
            count: 1,
            source_epoch: 1,
            source_position: sequence,
          },
          {
            route: unrelatedTargetRoute,
            target_id: unrelatedTarget,
            source_partition: partition,
            kind: 'like',
            count: 1,
            source_epoch: 1,
            source_position: sequence,
          },
        ],
        'content.reaction_total': [
          {
            route: targetRoute,
            target_id: actorTarget,
            kind: 'love',
            count: 1,
            source_epoch: 1,
            source_position: sequence,
          },
          {
            route: unrelatedTargetRoute,
            target_id: unrelatedTarget,
            kind: 'like',
            count: 1,
            source_epoch: 1,
            source_position: sequence,
          },
        ],
      };
    },
  };
}

async function populationEvidence(
  db: GrowthDatabase,
  actorId: string,
  actorRoute: number,
  targetRoute: number,
): Promise<
  PopulationEvidence['total'] & {
    readonly actorReaction: number;
    readonly actorReceipt: number;
    readonly targetCount: number;
    readonly targetTotal: number;
  }
> {
  const [reaction, receipt, countRows, totalRows, actorReaction, actorReceipt, targetCount, targetTotal] =
    await Promise.all([
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction'),
      count(db.admin, 'SELECT count(*)::text AS count FROM core.receipt'),
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction_count'),
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction_total'),
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction WHERE route=$1 AND actor_account_id=$2', [
        actorRoute,
        actorId,
      ]),
      count(
        db.admin,
        `SELECT count(*)::text AS count FROM core.receipt
          WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
            AND command_kind='content.reaction.set'`,
        [partitionOf(actorRoute), actorId],
      ),
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction_count WHERE route=$1', [targetRoute]),
      count(db.admin, 'SELECT count(*)::text AS count FROM content.reaction_total WHERE route=$1', [targetRoute]),
    ]);
  return {
    reaction,
    receipt,
    count: countRows,
    total: totalRows,
    actorReaction,
    actorReceipt,
    targetCount,
    targetTotal,
  };
}

test('The distinct joined native outcomes and three-scale bounded growth retain the existing owner contracts.', async () => {
  // Existing owner checks cover the slot and relay separately. This captures one committed native slot command,
  // its decoded source event, the registered production projection and same-event replay as one fixed operation.
  base = await createReactionRelayBase();
  const measuredTargets = new Map<number, string>();
  const warmupTargets = new Map<number, string>();
  for (const scale of scales) {
    measuredTargets.set(
      scale,
      (await base.createThread(base.mainBoardId, `Reaction growth measured ${scale} ${randomUUID()}`)).threadId,
    );
    warmupTargets.set(
      scale,
      (await base.createThread(base.mainBoardId, `Reaction growth warmup ${scale} ${randomUUID()}`)).threadId,
    );
  }

  // A second native clone gives checkGrowth its instrumented pool while retaining the real Auth and Access actors.
  growth = await openGrowthDatabase(base.system.database.pool.options.connectionString!);
  const actor = await base.system.access.authenticate(base.other.bearer, {
    pool: growth.pool,
    deadline: Date.now() + 30_000,
  });
  if (actor.kind !== 'account') throw new Error('Native Auth did not restore the growth actor');
  const actorId = actor.accountId;
  const actorRoute = routeOf(actorId);
  if (actorRoute === null) throw new TypeError('The growth actor must have an account route');
  runtime = await startReactionEffects(base.system, growth.pool, growth.url, { relay: false });

  const evidence: RunEvidence[] = [];
  const populations: PopulationEvidence[] = [];
  const captures = new Map<number, Awaited<ReturnType<typeof captureEvidence>>>();
  const idempotencyKeys = new Map<number, string>();
  const report = await checkGrowth(growth, {
    name: 'Joined reaction slot and target projection replay',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 1,
    warmups: 1,
    async grow(db, scale) {
      const targetId = measuredTargets.get(scale)!;
      const targetRoute = routeOf(targetId)!;
      const population = growthPopulation(actorId, actorRoute, targetRoute, scale);
      const before = await populationEvidence(db, actorId, actorRoute, targetRoute);
      await seed(db, population, { from: 0, to: scale });
      const snapshot = await populationEvidence(db, actorId, actorRoute, targetRoute);
      populations.push({
        scale,
        total: {
          reaction: snapshot.reaction - before.reaction,
          receipt: snapshot.receipt - before.receipt,
          count: snapshot.count - before.count,
          total: snapshot.total - before.total,
        },
        hot: {
          reaction: snapshot.actorReaction - before.actorReaction,
          receipt: snapshot.actorReceipt - before.actorReceipt,
          count: snapshot.targetCount - before.targetCount,
          total: snapshot.targetTotal - before.targetTotal,
        },
      });
    },
    async warmup(_db, scale, repetition) {
      const targetId = warmupTargets.get(scale)!;
      const targetRoute = routeOf(targetId)!;
      const setup = await captureEvidence(growth!, actorId, targetRoute);
      await executeJoinedOperation(
        growth!,
        actor,
        targetId,
        setup,
        scale,
        `reaction-growth-warmup-${repetition}-${scale}`,
      );
    },
    async prepare(_db, scale, repetition) {
      const targetId = measuredTargets.get(scale)!;
      captures.set(repetition, await captureEvidence(growth!, actorId, routeOf(targetId)!));
      idempotencyKeys.set(repetition, `reaction-growth-measured-${repetition}-${scale}`);
    },
    async operation(_db, scale, repetition) {
      const targetId = measuredTargets.get(scale)!;
      const setup = captures.get(repetition);
      const key = idempotencyKeys.get(repetition);
      if (!setup || !key) throw new Error(`Missing pre-operation capture for repetition ${repetition}`);
      const result = await executeJoinedOperation(growth!, actor, targetId, setup, scale, key);
      evidence.push(result);
      return result;
    },
  });

  expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
  expect(populations.map(({ scale }) => scale)).toEqual(scales);
  for (const item of populations) {
    const prior = populations[populations.indexOf(item) - 1];
    const cumulative = scales.slice(0, scales.indexOf(item.scale) + 1).reduce((sum, value) => sum + value, 0);
    expect(item.total).toEqual({
      reaction: cumulative * 2,
      receipt: cumulative * 2,
      count: cumulative * 2,
      total: cumulative * 2,
    });
    expect(item.hot.reaction).toBe(cumulative);
    expect(item.hot.receipt).toBe(cumulative);
    expect(item.hot.count).toBe(item.scale);
    expect(item.hot.total).toBe(item.scale);
    if (prior) {
      expect(item.total.reaction).toBeGreaterThan(prior.total.reaction);
      expect(item.hot.reaction).toBeGreaterThan(prior.hot.reaction);
      expect(item.total.count).toBeGreaterThan(prior.total.count);
      expect(item.hot.count).toBeGreaterThan(prior.hot.count);
    }
  }

  expect(evidence.map(({ scale }) => scale)).toEqual(scales);
  for (const sample of report.samples) {
    const relations = sample.cost.relations;
    expect(relations?.['content.reaction']).toBeDefined();
    expect(relations?.['core.receipt']).toBeDefined();
    expect(relations?.['content.reaction_count']).toBeDefined();
    expect(relations?.['content.reaction_total']).toBeDefined();
  }
  assertGrowthAccessPaths('Joined reaction slot and target projection replay', report.samples, [
    'content.reaction',
    'core.receipt',
    'content.reaction_count',
    'content.reaction_total',
  ]);

  for (const run of evidence) {
    expect(run.sourcePartition).not.toBe(run.targetPartition);
    expect(BigInt(run.capturePosition)).toBe(BigInt(run.sourcePosition));
    const sourceSlot = await growth.admin.query<{ kind: string }>(
      `SELECT kind FROM content.reaction
          WHERE route=$1 AND actor_account_id=$2 AND target_kind='thread' AND target_id=$3`,
      [actorRoute, actorId, run.targetId],
    );
    expect(sourceSlot.rows).toEqual([{ kind: 'like' }]);
    const receipt = await growth.admin.query<{ idempotency_key: string; position: string }>(
      `SELECT idempotency_key, position::text AS position FROM core.receipt
          WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND idempotency_key=$3`,
      [run.sourcePartition, actorId, run.idempotencyKey],
    );
    expect(receipt.rows).toHaveLength(1);
    expect(receipt.rows[0]!.position).toBe(run.sourcePosition);
    const event = await growth.admin.query<{ event_count: number; event_seq: number; type: string }>(
      `SELECT event_count, event_seq, type FROM core.outbox
          WHERE partition_no=$1 AND position=$2::bigint ORDER BY event_seq`,
      [run.sourcePartition, run.sourcePosition],
    );
    expect(event.rows).toHaveLength(1);
    expect(event.rows[0]).toEqual({
      event_count: 1,
      event_seq: 0,
      type: 'com.rezics.content.reaction.changed.v1',
    });
    const projection = await growth.admin.query<{ kind: string; count: number }>(
      `SELECT kind, count FROM content.reaction_count
          WHERE route=$1 AND target_id=$2 AND source_partition=$3 ORDER BY kind`,
      [run.targetRoute, run.targetId, run.sourcePartition],
    );
    expect(projection.rows).toEqual([{ kind: 'like', count: 1 }]);
    const total = await growth.admin.query<{ kind: string; count: number }>(
      `SELECT kind, count FROM content.reaction_total WHERE route=$1 AND target_id=$2 ORDER BY kind`,
      [run.targetRoute, run.targetId],
    );
    expect(total.rows).toEqual([{ kind: 'like', count: 1 }]);
    const targetHead = await readPartitionPosition(growth.pool, run.targetPartition);
    const prepared = captures.get([...idempotencyKeys.entries()].find(([, key]) => key === run.idempotencyKey)![0])!;
    expect(targetHead).toEqual(prepared.targetPosition);
    const relay = await growth.admin.query<{ epoch: number | null; position: string }>(
      `SELECT epoch, position::text AS position FROM core.consumer_checkpoint
          WHERE consumer=$1 AND partition_no=$2`,
      [run.captureConsumer, run.sourcePartition],
    );
    expect(relay.rows).toHaveLength(1);
    expect(relay.rows[0]!.epoch).toBeGreaterThan(0);
    expect(BigInt(relay.rows[0]!.position)).toBe(BigInt(run.sourcePosition));
  }
  const lastRun = evidence.at(-1);
  if (!lastRun) throw new Error('The growth check did not execute a measured operation');
  expect(await readPartitionPosition(growth.pool, lastRun.sourcePartition)).toEqual({
    epoch: lastRun.sourceEpoch,
    position: lastRun.sourcePosition,
  });
}, 180_000);
