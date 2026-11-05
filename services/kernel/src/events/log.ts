import type { Pool } from 'pg';
import { lookupEventType } from './catalogue.ts';
import { withConnection } from '../database/pool.ts';
import advanceCheckpoint from './advance-checkpoint.sql';
import compareAdvanceCheckpoint from './compare-advance-checkpoint.sql';
import ensureCheckpoint from './ensure-checkpoint.sql';
import lockCheckpoint from './lock-checkpoint.sql';
import readLog from './read-log.sql';

export { EVENT_TYPES } from './catalogue.ts';

export const BATCH_ENVELOPES = 64;

export type CloudEvent = {
  specversion: '1.0';
  id: string;
  source: string;
  type: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  sequence: string;
  data: unknown;
};

export type Envelope = { partition: number; epoch: number; position: bigint; events: CloudEvent[] };
export type StopReason = 'gap' | 'epoch' | 'unknown_type' | 'invalid_data';
export type BatchResult =
  | { status: 'busy' }
  | { status: 'read'; envelopes: number; position: bigint }
  | { status: 'stopped'; reason: StopReason; envelopes: number; position: bigint };

type LogRow = {
  head_epoch: number | null;
  position: bigint | null;
  event_seq: number | null;
  event_count: number | null;
  epoch: number | null;
  id: string | null;
  type: string | null;
  subject: string | null;
  data: unknown;
  time: string | null;
  payload_state: string | null;
};

type EnvelopeGroup = { position: bigint; rows: LogRow[] };

function stop(reason: StopReason, envelopes: number, position: bigint): BatchResult {
  return { status: 'stopped', reason, envelopes, position };
}

function parseRows(
  rows: LogRow[],
  partition: number,
  checkpoint: { epoch: number | null; position: bigint },
): {
  envelopes: Envelope[];
  reason?: StopReason;
} {
  const groups: EnvelopeGroup[] = [];
  for (const row of rows) {
    if (row.position === null) continue;
    const rowPosition = BigInt(row.position);
    let group = groups.at(-1);
    if (!group || group.position !== rowPosition) {
      group = { position: rowPosition, rows: [] };
      groups.push(group);
    }
    if (row.event_seq !== null) group.rows.push(row);
  }
  const envelopes: Envelope[] = [];
  let expectedEpoch = checkpoint.epoch;
  let reason: StopReason | undefined;
  for (const group of groups) {
    const groupRows = group.rows;
    const count = groupRows[0]?.event_count;
    if (
      groupRows.length === 0 ||
      count == null ||
      groupRows.length !== count ||
      groupRows.some((row, index) => row.event_count !== count || row.event_seq !== index)
    ) {
      reason = 'gap';
      break;
    }
    const envelopeEpoch = groupRows[0]!.epoch;
    if (envelopeEpoch === null || groupRows.some((row) => row.epoch !== envelopeEpoch)) {
      reason = 'epoch';
      break;
    }
    expectedEpoch ??= envelopeEpoch;
    if (groupRows.some((row) => row.epoch !== expectedEpoch)) {
      reason = 'epoch';
      break;
    }
    const events: CloudEvent[] = [];
    for (const row of groupRows) {
      const validator = row.type === null ? undefined : lookupEventType(row.type);
      if (!validator) {
        reason = 'unknown_type';
        break;
      }
      const minimized = row.payload_state === 'minimized';
      if (
        (row.payload_state !== 'present' && !minimized) ||
        (minimized
          ? row.subject !== null ||
            typeof row.data !== 'object' ||
            row.data === null ||
            Array.isArray(row.data) ||
            Object.keys(row.data).length !== 0
          : !validator.Check(row.data))
      ) {
        reason = 'invalid_data';
        break;
      }
      events.push({
        specversion: '1.0',
        id: row.id!,
        source: `urn:rezics:log:${partition}.${envelopeEpoch}`,
        type: minimized ? 'com.rezics.history.minimized.v1' : row.type!,
        ...(row.subject === null ? {} : { subject: row.subject }),
        time: row.time!,
        datacontenttype: 'application/json',
        sequence: group.position.toString().padStart(19, '0'),
        data: row.data,
      });
    }
    if (reason) break;
    envelopes.push({ partition, epoch: envelopeEpoch, position: group.position, events });
  }
  return { envelopes, ...(reason === undefined ? {} : { reason }) };
}

function validateOptions(options: { consumer: string; envelopes?: number }): number {
  const limit = options.envelopes ?? BATCH_ENVELOPES;
  if (!Number.isInteger(limit) || limit < 1 || limit > BATCH_ENVELOPES)
    throw new RangeError(`envelopes must be an integer from 1 to ${BATCH_ENVELOPES}`);
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.consumer)) throw new RangeError('consumer name is invalid');
  return limit;
}

async function readSnapshot(pool: Pool, options: { consumer: string; partition: number; envelopes?: number }) {
  const limit = validateOptions(options);
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await ensureCheckpoint.run(client, { partition_no: options.partition, consumer: options.consumer });
      const checkpoint = await lockCheckpoint.run(client, {
        partition_no: options.partition,
        consumer: options.consumer,
      });
      if (!checkpoint) {
        await client.query('COMMIT');
        return undefined;
      }
      const rows = await readLog.run(client, {
        partition_no: options.partition,
        position: checkpoint.position,
        envelopes: limit,
      });
      const parsed = parseRows(rows, options.partition, checkpoint);
      await client.query('COMMIT');
      return { checkpoint, ...parsed };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * Reads and applies one short transactional batch. `apply` runs inside the open transaction, whose
 * session becomes idle in a transaction after five seconds, so effects should only record or enqueue work.
 */
export async function readBatch(
  pool: Pool,
  options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
  },
): Promise<BatchResult> {
  return withConnection(pool, async (client) => {
    const limit = validateOptions(options);
    await ensureCheckpoint.run(client, { partition_no: options.partition, consumer: options.consumer });
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const checkpoint = await lockCheckpoint.run(client, {
        partition_no: options.partition,
        consumer: options.consumer,
      });
      if (!checkpoint) {
        await client.query('COMMIT');
        return { status: 'busy' };
      }

      const position = checkpoint.position;
      const rows = await readLog.run(client, {
        partition_no: options.partition,
        position,
        envelopes: limit,
      });
      const { envelopes, reason } = parseRows(rows, options.partition, checkpoint);

      if (envelopes.length > 0) {
        await options.apply(envelopes);
        const last = envelopes.at(-1)!;
        await advanceCheckpoint.run(client, {
          partition_no: options.partition,
          consumer: options.consumer,
          epoch: last.epoch,
          position: last.position,
        });
      }
      await client.query('COMMIT');
      if (reason) return stop(reason, envelopes.length, envelopes.at(-1)?.position ?? position);
      return { status: 'read', envelopes: envelopes.length, position: envelopes.at(-1)?.position ?? position };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** Reads a batch, releases the connection before applying it, then compare-and-sets its checkpoint. */
export async function projectBatch(
  pool: Pool,
  options: {
    consumer: string;
    partition: number;
    apply: (envelopes: readonly Envelope[]) => Promise<void>;
    envelopes?: number;
  },
): Promise<BatchResult> {
  const snapshot = await readSnapshot(pool, options);
  if (!snapshot) return { status: 'busy' };
  const { checkpoint, envelopes, reason } = snapshot;
  if (envelopes.length > 0) {
    await options.apply(envelopes);
    const last = envelopes.at(-1)!;
    const advanced = await withConnection(pool, async (client) =>
      compareAdvanceCheckpoint.run(client, {
        partition_no: options.partition,
        consumer: options.consumer,
        expected_epoch: checkpoint.epoch ?? 0,
        expected_epoch_is_null: checkpoint.epoch === null,
        expected_position: checkpoint.position,
        next_epoch: last.epoch,
        next_position: last.position,
      }),
    );
    if (advanced.length === 0) return { status: 'busy' };
  }
  const position = envelopes.at(-1)?.position ?? checkpoint.position;
  if (reason) return stop(reason, envelopes.length, position);
  return { status: 'read', envelopes: envelopes.length, position };
}
