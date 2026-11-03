import type { Pool, PoolClient } from 'pg';
import { Value } from 'typebox/value';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../command/command.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { withConnection } from '../database/pool.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { withReadTransaction } from '../semantic/read.ts';
import {
  POPULATION_TOTAL_DELIVERY,
  RATING_EVENTS,
  type PopulationTotalDelivery,
  type PopulationTotalEvent,
} from './events.ts';
import applyTotal from './population-total-component-apply.sql';
import { STANDARD_QUESTION_ID } from './votes.ts';
import { GLOBAL_CONTEXT } from '../access/gates/catalogue.ts';
import {
  assertPopulationDeliveryDelta,
  MAX_RATING_CHANGE_PAGE,
  MAX_RATING_POPULATION_DELIVERY_DELTAS,
} from './question-scale.ts';

const AGGREGATE_APPLIED = 'com.rezics.rating.aggregate.applied.v1';
const MAX_SERIAL = 9223372036854775807n;
type Queryable = Pick<PoolClient, 'query'>;
type Address = Pick<PopulationTotalEvent, 'sourcePartition' | 'populationId' | 'serial'>;
type CountedDelta = { questionId: string; shard: number; count: bigint; sum: bigint };

function address(data: Address): [number, string, number, string] {
  const route = routeOf(data.populationId);
  if (
    route === null ||
    !Number.isInteger(data.sourcePartition) ||
    data.sourcePartition < 0 ||
    data.sourcePartition > 4095 ||
    !/^[1-9][0-9]*$/.test(data.serial) ||
    BigInt(data.serial) > MAX_SERIAL
  )
    throw new TypeError('Invalid rating population delivery address');
  return [route, data.populationId, data.sourcePartition, data.serial];
}

function parse(event: CloudEvent): PopulationTotalEvent {
  if (event.type !== POPULATION_TOTAL_DELIVERY || !Value.Check(RATING_EVENTS[POPULATION_TOTAL_DELIVERY], event.data))
    throw new TypeError('Invalid rating population delivery');
  const data = event.data as PopulationTotalEvent;
  if (data.action === 'deliver') {
    for (const delta of data.deltas) assertPopulationDeliveryDelta(BigInt(delta.count), BigInt(delta.sum));
  }
  const [route] = address(data);
  const source = /^urn:rezics:log:(\d+)\.([1-9][0-9]*)$/.exec(event.source);
  if (
    !source ||
    Number(source[1]) !== (data.action === 'deliver' ? data.sourcePartition : partitionOf(route)) ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n
  )
    throw new TypeError('Invalid rating population delivery envelope');
  return data;
}

/** Only exact counted before/after deltas, reduced by destination/shard within one bounded source command. */
export class PopulationTotalCapture {
  private readonly populations = new Map<string, Map<string, CountedDelta>>();

  add(
    change: { questionId: string; populationId: string },
    entries: readonly {
      countingKey: string;
      delta: { count: bigint; sum: bigint };
    }[],
  ): void {
    for (const { delta } of entries) assertPopulationDeliveryDelta(delta.count, delta.sum);
    const shards = this.populations.get(change.populationId) ?? new Map<string, CountedDelta>();
    for (const { countingKey, delta } of entries) {
      const shard = Number.parseInt(countingKey.slice(0, 2), 16) % 16;
      const key = `${change.questionId}/${shard}`;
      const total = shards.get(key) ?? { questionId: change.questionId, shard, count: 0n, sum: 0n };
      const count = total.count + delta.count;
      const sum = total.sum + delta.sum;
      assertPopulationDeliveryDelta(count, sum);
      total.count = count;
      total.sum = sum;
      shards.set(key, total);
    }
    this.populations.set(change.populationId, shards);
  }

  async commit(tx: CommandTransaction): Promise<{ type: string; data: PopulationTotalDelivery }[]> {
    const sourcePartition = currentCommand(tx).partition;
    const events: { type: string; data: PopulationTotalDelivery }[] = [];
    for (const [populationId, shards] of [...this.populations].sort(([a], [b]) => a.localeCompare(b))) {
      const deltas = [...shards.values()]
        .filter(({ count, sum }) => count !== 0n || sum !== 0n)
        .sort((a, b) => a.questionId.localeCompare(b.questionId) || a.shard - b.shard)
        .map(({ questionId, shard, count, sum }) => ({ questionId, shard, count: String(count), sum: String(sum) }));
      if (deltas.length === 0) continue;
      if (deltas.length > MAX_RATING_POPULATION_DELIVERY_DELTAS)
        throw new RangeError('Rating population delivery exceeds its source page');
      for (const delta of deltas) assertPopulationDeliveryDelta(BigInt(delta.count), BigInt(delta.sum));
      const sequence = await tx.query<{ serial: string }>(
        `INSERT INTO rating.population_total_source(partition_no,population_id,serial) VALUES($1,$2,1)
         ON CONFLICT(partition_no,population_id) DO UPDATE SET serial=rating.population_total_source.serial+1
         RETURNING serial::text`,
        [sourcePartition, populationId],
      );
      const data: PopulationTotalDelivery = {
        action: 'deliver',
        sourcePartition,
        populationId,
        serial: sequence.rows[0]!.serial,
        deltas,
      };
      await tx.query(
        `INSERT INTO rating.population_total_delivery(partition_no,population_id,serial,payload)
         VALUES($1,$2,$3,$4::jsonb)`,
        [sourcePartition, populationId, data.serial, JSON.stringify(data)],
      );
      events.push({ type: POPULATION_TOTAL_DELIVERY, data });
    }
    if (events.length)
      await tx.query(
        `INSERT INTO rating.population_total_clock(partition_no,generation,pending) VALUES($1,1,$2)
       ON CONFLICT(partition_no) DO UPDATE SET generation=rating.population_total_clock.generation+1,
       pending=rating.population_total_clock.pending+EXCLUDED.pending`,
        [sourcePartition, events.length],
      );
    return events;
  }
}

/** Relay admission uses only its supplied, short native transaction. Never overwrites a receipt. */
async function admit(client: Queryable, data: PopulationTotalDelivery): Promise<void> {
  const key = address(data);
  await partitionReadClient(client, partitionOf(key[0]));
  const result = await client.query(
    `INSERT INTO rating.population_total_inbox(route,population_id,source_partition,serial,payload)
     VALUES($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT(route,population_id,source_partition,serial) DO UPDATE
     SET payload=rating.population_total_inbox.payload
     WHERE rating.population_total_inbox.payload=EXCLUDED.payload RETURNING serial`,
    [...key, JSON.stringify(data)],
  );
  if (result.rowCount !== 1) throw new Error('Rating population delivery identity changed');
}

/** One exact next receipt per command; gaps stay durable and never advance the frontier. */
async function receive(pool: Pool, item: Address): Promise<boolean> {
  const key = address(item);
  const result = await runCommand(pool, { partition: partitionOf(key[0]) }, async (tx) => {
    const inbox = await tx.query<{ payload: PopulationTotalDelivery; applied: boolean }>(
      `SELECT payload,applied FROM rating.population_total_inbox
       WHERE route=$1 AND population_id=$2 AND source_partition=$3 AND serial=$4`,
      key,
    );
    const row = inbox.rows[0];
    if (!row) return noEffect(false);
    if (row.applied) return noEffect(true);
    await tx.query(
      `INSERT INTO rating.population_total_received(route,population_id,source_partition)
       VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
      key.slice(0, 3),
    );
    const stream = await tx.query<{ serial: string }>(
      `SELECT serial::text FROM rating.population_total_received
       WHERE route=$1 AND population_id=$2 AND source_partition=$3 FOR UPDATE`,
      key.slice(0, 3),
    );
    if (BigInt(stream.rows[0]!.serial) + 1n !== BigInt(item.serial)) {
      // The initial stream insert must roll back too: noEffect may not conceal a domain write.
      throw new PredecessorPending();
    }
    await tx.query("SELECT set_config('rating.population_total_writer','population-home-v1',true)");
    // A first delivery may remove a pre-cutover contribution. The retained total is its baseline.
    // Missing shards are explicitly zero; a negative update fails its CHECK and rolls back the receipt.
    for (const delta of row.payload.deltas) {
      await tx.query(
        `INSERT INTO rating.population_total_component(route,question_id,population_id,shard,count,sum)
         VALUES($1,$2,$3,$4,0,0) ON CONFLICT DO NOTHING`,
        [key[0], delta.questionId, item.populationId, delta.shard],
      );
      const updated = await applyTotal.run(tx, {
        population_route: key[0],
        question_id: delta.questionId,
        population_id: item.populationId,
        shard: delta.shard,
        count_delta: delta.count,
        sum_delta: delta.sum,
        check_epoch: delta.questionId === STANDARD_QUESTION_ID || item.populationId !== GLOBAL_CONTEXT.id,
      });
      if (!updated.length)
        throw new Error('Rating population total shard unavailable or arithmetic exceeded its bound');
    }
    await tx.query(
      `UPDATE rating.population_total_inbox SET applied=true
       WHERE route=$1 AND population_id=$2 AND source_partition=$3 AND serial=$4`,
      key,
    );
    await tx.query(
      `UPDATE rating.population_total_received SET serial=$4
       WHERE route=$1 AND population_id=$2 AND source_partition=$3`,
      key,
    );
    return {
      value: true,
      events: [
        {
          type: POPULATION_TOTAL_DELIVERY,
          data: {
            action: 'received',
            sourcePartition: item.sourcePartition,
            populationId: item.populationId,
            serial: item.serial,
          } satisfies PopulationTotalEvent,
        },
      ],
    };
  }).catch((error: unknown) => {
    if (error instanceof PredecessorPending) return { value: false };
    throw error;
  });
  return result.value;
}
class PredecessorPending extends Error {}

/** Exact source acknowledgment is a second local command, recoverable from either committed event. */
async function acknowledge(pool: Pool, item: Address): Promise<void> {
  await runCommand(pool, { partition: item.sourcePartition }, async (tx) => {
    const changed = await tx.query(
      `UPDATE rating.population_total_delivery SET pending=false
       WHERE partition_no=$1 AND population_id=$2 AND serial=$3 AND pending RETURNING serial`,
      [item.sourcePartition, item.populationId, item.serial],
    );
    if (!changed.rowCount) return noEffect(undefined);
    const clock = await tx.query(
      `UPDATE rating.population_total_clock SET generation=generation+1,pending=pending-1
       WHERE partition_no=$1 AND pending>0 RETURNING generation`,
      [item.sourcePartition],
    );
    if (!clock.rowCount) throw new Error('Rating population delivery clock unavailable');
    return { value: undefined, events: [{ type: AGGREGATE_APPLIED, data: { applied: 1 } }] };
  });
}

async function deliver(pool: Pool, data: PopulationTotalDelivery): Promise<void> {
  await withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      await admit(client, data);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  if (await receive(pool, data)) await acknowledge(pool, data);
}

/** Shared foreground completion and registered worker recovery use the identical inbox/receipt commands. */
export async function flushPopulationTotalDeliveries(
  pool: Pool,
  partition: number,
  populations?: readonly string[],
): Promise<void> {
  if (populations && (populations.length === 0 || populations.length > MAX_RATING_CHANGE_PAGE))
    throw new RangeError(
      `Rating population delivery selection must contain 1 to ${MAX_RATING_CHANGE_PAGE} populations`,
    );
  for (;;) {
    const page = await withReadTransaction(pool, async (client) => {
      await partitionReadClient(client, partition);
      return client.query<{ payload: PopulationTotalDelivery }>(
        populations
          ? `SELECT payload FROM rating.population_total_delivery WHERE partition_no=$1 AND pending
             AND population_id=ANY($3::uuid[]) ORDER BY population_id,serial LIMIT $2`
          : `SELECT payload FROM rating.population_total_delivery WHERE partition_no=$1 AND pending
             ORDER BY population_id,serial LIMIT $2`,
        populations ? [partition, MAX_RATING_CHANGE_PAGE, populations] : [partition, MAX_RATING_CHANGE_PAGE],
      );
    });
    if (page.rows.length === 0) return;
    for (const { payload } of page.rows) await deliver(pool, payload);
  }
}

export function createPopulationTotalEffect(pool: Pool): Effect {
  return {
    name: 'rating_population_total',
    types: [POPULATION_TOTAL_DELIVERY],
    async admit(client, event) {
      const data = parse(event);
      if (data.action === 'deliver') await admit(client, data);
    },
    async run(event) {
      const data = parse(event);
      if (data.action === 'deliver') return deliver(pool, data);
      await acknowledge(pool, data);
      // One successor probe, not a receipt/history scan. Its commit emits its own continuation.
      if (BigInt(data.serial) < MAX_SERIAL) {
        const next = {
          sourcePartition: data.sourcePartition,
          populationId: data.populationId,
          serial: String(BigInt(data.serial) + 1n),
        };
        if (await receive(pool, next)) await acknowledge(pool, next);
      }
    },
  };
}

/** Exact subject-home readiness observation; absence means the untouched cutover baseline. */
export async function readPopulationTotalClock(
  client: Queryable,
  partition: number,
): Promise<{
  generation: string;
  pending: string;
}> {
  const result = await client.query<{ generation: string; pending: string }>(
    `SELECT generation::text,pending::text FROM rating.population_total_clock WHERE partition_no=$1`,
    [partition],
  );
  return result.rows[0] ?? { generation: '0', pending: '0' };
}
