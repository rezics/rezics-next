import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import { projectBatch, type BatchResult, type CloudEvent, type Envelope } from '../events/log.ts';
import partitionRead from '../partition/read.sql';
import { partitionOf, routeOf } from '../route/route.ts';
import { CONTENT_EVENTS, REACTION_KINDS, type ContentEventData } from './events.ts';
import readSql from './reaction-count-read.sql';
import contributionUpsert from './reaction-contribution-upsert.sql';
import readBaseline from './reaction-projection-baseline.sql';
import countUpsert from './reaction-count-upsert.sql';
import subjectReactorDelete from './reaction-subject-reactor-delete.sql';
import subjectReactorUpsert from './reaction-subject-reactor-upsert.sql';
import totalUpsert from './reaction-total-upsert.sql';

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
  if (event.type !== changed || !Value.Check(CONTENT_EVENTS()[changed], event.data))
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
    (data.targetKind === 'subject' &&
      [data.previousKind, data.kind].some((kind) => kind === 'upvote' || kind === 'downvote')) ||
    !/^[0-9a-f-]{36}$/.test(event.id)
  )
    throw new TypeError('Invalid reaction count source envelope');
  return { ...data, sourcePartition, epoch, position, targetRoute };
}

async function applyChange(client: PoolClient, change: Change): Promise<void> {
  const { rows } = await client.query<{ writeState: string }>(partitionRead.sql, [partitionOf(change.targetRoute)]);
  const anchor = rows[0];
  if (!anchor || anchor.writeState !== 'active') throw new Error('Content partition is unavailable');
  // Retain cleared slots as tombstones so a late set cannot resurrect them.
  // The slot CAS and both aggregate kinds commit together on the target home.
  const slot = await contributionUpsert.run(client, {
    route: change.targetRoute,
    target_id: change.targetId,
    actor_id: change.actorId,
    kind: change.kind,
    source_epoch: change.epoch,
    source_position: change.position,
  });
  if (!slot) return;
  const previous = slot.previous_kind;
  const deltas: { kind: ReactionKind; delta: number }[] = [];
  if (previous && previous !== change.kind) deltas.push({ kind: previous, delta: -1 });
  if (change.kind && change.kind !== previous) deltas.push({ kind: change.kind, delta: 1 });
  // A skipped intermediate change can leave the same kind (or a clear). Still
  // record this event's freshness without counting its advertised previousKind.
  const unchangedKind = change.kind ?? change.previousKind;
  if (deltas.length === 0 && unchangedKind) deltas.push({ kind: unchangedKind, delta: 0 });
  // Different actors can switch kinds concurrently; lock aggregate kinds in one order.
  deltas.sort((left, right) => left.kind.localeCompare(right.kind));
  for (const step of deltas) {
    const parameters = {
      route: change.targetRoute,
      target_id: change.targetId,
      source_partition: change.sourcePartition,
      kind: step.kind,
      delta: step.delta,
      update_delta: step.delta,
      source_epoch: change.epoch,
      source_position: change.position.toString(),
    };
    // Idempotency belongs to the actor slot, not this partition-wide kind.
    // An older event for another actor must still contribute exactly once.
    const updated = await client.query<{ previous_count: number; current_count: number }>(
      countUpsert.sql,
      countUpsert.params.map((name) => parameters[name as keyof typeof parameters]),
    );
    const contribution = updated.rows[0];
    if (!contribution) throw new Error('Reaction contribution update is missing');
    const totalParameters = {
      ...parameters,
      delta: contribution.current_count - contribution.previous_count,
      update_delta: contribution.current_count - contribution.previous_count,
    };
    await client.query(
      totalUpsert.sql,
      totalUpsert.params.map((name) => totalParameters[name as keyof typeof totalParameters]),
    );
  }
  if (change.targetKind !== 'subject') return;
  const parameters = {
    route: change.targetRoute,
    subject_id: change.targetId,
    actor_account_id: change.actorId,
    kind: change.kind,
  };
  if (change.kind === null) {
    await client.query(
      subjectReactorDelete.sql,
      subjectReactorDelete.params.map((name) => parameters[name as keyof typeof parameters]),
    );
  } else {
    await client.query(
      subjectReactorUpsert.sql,
      subjectReactorUpsert.params.map((name) => parameters[name as keyof typeof parameters]),
    );
  }
}

async function applyReactionChange(pool: Pool, event: CloudEvent): Promise<void> {
  const change = parse(event);
  // Installation rebuilt counts from frozen native slots. Events at or below
  // that source cutover are already represented, including cleared slots.
  const cutover = await withConnection(pool, (client) =>
    readBaseline.run(client, { source_partition: change.sourcePartition }),
  );
  if (
    cutover &&
    (change.epoch < cutover.source_epoch ||
      (change.epoch === cutover.source_epoch && change.position <= BigInt(cutover.source_position)))
  )
    return;
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

/** Applies decoded source envelopes through the same path used by the reaction relay. */
export function applyReactionCountEnvelopes(pool: Pool, envelopes: readonly Envelope[]): Promise<void> {
  return applyEnvelopes(pool, envelopes);
}

/** Consumes one actor partition through projectBatch and folds each change into the target partition. */
export function projectReactionCounts(pool: Pool, partition: number): Promise<BatchResult> {
  return projectBatch(pool, {
    consumer: REACTION_COUNT_CONSUMER,
    partition,
    apply: (envelopes) => applyReactionCountEnvelopes(pool, envelopes),
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
