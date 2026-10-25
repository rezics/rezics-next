import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { projectBatch, type BatchResult, type CloudEvent, type Envelope } from '../events/log.ts';
import partitionRead from '../partition/read.sql';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, REACTION_KINDS, type ContentEventData } from './events.ts';
import insertSql from './reaction-count-insert.sql';
import readSql from './reaction-count-read.sql';
import upsert from './reaction-count-upsert.sql';

const changed = 'com.rezics.content.reaction.changed.v1';
const maxPosition = 9223372036854775807n;
export const REACTION_COUNT_CONSUMER = 'content_reaction_count';

export type ReactionKind = (typeof REACTION_KINDS)[number];
export type ReactionCountWatermark = Readonly<{ epoch: number; position: bigint }>;
export type ReactionCountTotal = Readonly<{ kind: ReactionKind; count: number }>;
export type ReactionCounts = Readonly<{
  counts: readonly ReactionCountTotal[];
  watermark: ReactionCountWatermark | null;
}>;

type Change = ContentEventData<typeof changed> &
  Readonly<{ sourcePartition: number; epoch: number; position: bigint; targetRoute: number }>;

function route(id: string): number {
  const value = routeOf(id);
  if (value === null) throw new RangeError('Invalid routed content identity');
  return value;
}

function parse(event: CloudEvent): Change {
  if (event.type !== changed || !Value.Check(CONTENT_EVENTS[changed], event.data))
    throw new TypeError('Invalid reaction count source event');
  const data = event.data as ContentEventData<typeof changed>;
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  const sourcePartition = Number(source?.[1]);
  const epoch = Number(source?.[2]);
  const actorRoute = routeOf(data.actorId);
  const targetRoute = routeOf(data.targetId);
  const position = /^\d{19}$/.test(event.sequence) ? BigInt(event.sequence) : 0n;
  if (
    actorRoute === null ||
    targetRoute === null ||
    !source ||
    !Number.isInteger(sourcePartition) ||
    sourcePartition !== partitionOf(actorRoute) ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    epoch > 2147483647 ||
    position <= 0n ||
    position > maxPosition ||
    event.subject !== data.targetId ||
    !/^[0-9a-f-]{36}$/.test(event.id)
  )
    throw new TypeError('Invalid reaction count source envelope');
  return { ...data, sourcePartition, epoch, position, targetRoute };
}

async function applyChange(client: PoolClient, change: Change): Promise<void> {
  const { rows } = await client.query<{ writeState: string }>(partitionRead.sql, [partitionOf(change.targetRoute)]);
  const anchor = rows[0];
  if (!anchor || anchor.writeState !== 'active') throw new Error('Content partition is unavailable');
  const deltas: { kind: ReactionKind; delta: number }[] = [];
  if (change.previousKind && change.previousKind !== change.kind) deltas.push({ kind: change.previousKind, delta: -1 });
  if (change.kind && change.kind !== change.previousKind) deltas.push({ kind: change.kind, delta: 1 });
  for (const step of deltas) {
    const parameters = {
      route: change.targetRoute,
      target_id: change.targetId,
      source_partition: change.sourcePartition,
      kind: step.kind,
      delta: step.delta,
      source_epoch: change.epoch,
      source_position: change.position.toString(),
    };
    // A point update reads the contribution. Insert only when that row is absent;
    // a stale watermark updates nothing and must not replace the stored count.
    const updated = await client.query(
      upsert.sql,
      upsert.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    if ((updated.rowCount ?? 0) === 0) {
      await client.query(
        insertSql.sql,
        insertSql.params.map((name) => parameters[name as keyof typeof parameters]),
      );
    }
  }
}

async function applyReactionChange(pool: Pool, event: CloudEvent): Promise<void> {
  const change = parse(event);
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await applyChange(client, change);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

async function applyEnvelopes(pool: Pool, envelopes: readonly Envelope[]): Promise<void> {
  for (const envelope of envelopes) {
    for (const event of envelope.events) {
      if (event.type === changed) await applyReactionChange(pool, event);
    }
  }
}

/** Consumes one actor partition through projectBatch and folds each change into the target partition. */
export function projectReactionCounts(pool: Pool, partition: number): Promise<BatchResult> {
  return projectBatch(pool, {
    consumer: REACTION_COUNT_CONSUMER,
    partition,
    apply: (envelopes) => applyEnvelopes(pool, envelopes),
  });
}

export function createReactionCountEffect(pool: Pool): Effect {
  return {
    name: 'content_reaction_count',
    types: [changed],
    run: (event) => applyReactionChange(pool, event),
  };
}

/** Counts for one target, plus the newest source watermark incorporated into them. */
export async function readReactionCounts(
  client: PoolClient,
  target: Readonly<{ targetId: string }>,
): Promise<ReactionCounts> {
  const parameters = { route: route(target.targetId), target_id: target.targetId };
  const { rows } = await client.query<(typeof readSql)['~reylo']['element']>(
    readSql.sql,
    readSql.params.map((name) => parameters[name as keyof typeof parameters]),
  );
  const totals = new Map<ReactionKind, number>();
  let epoch = 0;
  let position = 0n;
  for (const row of rows) {
    const kind = row.kind as ReactionKind;
    if (!REACTION_KINDS.includes(kind) || !Number.isSafeInteger(row.count) || row.count < 0)
      throw new Error('Invalid reaction count row');
    totals.set(kind, (totals.get(kind) ?? 0) + row.count);
    const rowPosition = BigInt(row.source_position);
    if (row.source_epoch > epoch || (row.source_epoch === epoch && rowPosition > position)) {
      epoch = row.source_epoch;
      position = rowPosition;
    }
  }
  const counts = [...totals.entries()]
    .filter((entry) => entry[1] > 0)
    .map(([kind, count]) => ({ kind, count }))
    .sort((left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0));
  return { counts, watermark: epoch === 0 ? null : { epoch, position } };
}
