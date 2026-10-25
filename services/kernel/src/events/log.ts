import type { Pool } from 'pg';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { withConnection } from '../database/pool.ts';
import advanceCheckpoint from './advance-checkpoint.sql';
import ensureCheckpoint from './ensure-checkpoint.sql';
import lockCheckpoint from './lock-checkpoint.sql';
import readLog from './read-log.sql';

export const BATCH_ENVELOPES = 64;

const UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const digest = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' });
export const EVENT_TYPES = {
  'com.rezics.definitions.published.v1': Type.Object({ digest }, { additionalProperties: false }),
  'com.rezics.definitions.activated.v1': Type.Object(
    { digest, head: Type.Integer({ minimum: 1 }) },
    { additionalProperties: false },
  ),
  'com.rezics.subject.created.v1': Type.Object({ id: Type.String({ pattern: UUID }) }, { additionalProperties: false }),
} as const;

export type CloudEvent = {
  specversion: '1.0';
  id: string;
  source: string;
  type: keyof typeof EVENT_TYPES;
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
};

type EnvelopeGroup = { position: bigint; rows: LogRow[] };

function stop(reason: StopReason, envelopes: number, position: bigint): BatchResult {
  return { status: 'stopped', reason, envelopes, position };
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
  const limit = options.envelopes ?? BATCH_ENVELOPES;
  if (!Number.isInteger(limit) || limit < 1 || limit > BATCH_ENVELOPES) {
    throw new RangeError(`envelopes must be an integer from 1 to ${BATCH_ENVELOPES}`);
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(options.consumer)) throw new RangeError('consumer name is invalid');

  return withConnection(pool, async (client) => {
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
        const rows = group.rows;
        const count = rows[0]?.event_count;
        if (
          rows.length === 0 ||
          count === null ||
          count === undefined ||
          rows.length !== count ||
          rows.some((row, index) => row.event_count !== count || row.event_seq !== index)
        ) {
          reason = 'gap';
          break;
        }

        const envelopeEpoch = rows[0]!.epoch;
        if (envelopeEpoch === null || rows.some((row) => row.epoch !== envelopeEpoch)) {
          reason = 'epoch';
          break;
        }
        expectedEpoch ??= envelopeEpoch;
        if (rows.some((row) => row.epoch !== expectedEpoch)) {
          reason = 'epoch';
          break;
        }

        const events: CloudEvent[] = [];
        for (const row of rows) {
          if (row.type === null || !Object.hasOwn(EVENT_TYPES, row.type)) {
            reason = 'unknown_type';
            break;
          }
          const schema = EVENT_TYPES[row.type as keyof typeof EVENT_TYPES];
          if (!Value.Check(schema, row.data)) {
            reason = 'invalid_data';
            break;
          }
          events.push({
            specversion: '1.0',
            id: row.id!,
            source: `urn:rezics:log:${options.partition}.${envelopeEpoch}`,
            type: row.type as keyof typeof EVENT_TYPES,
            ...(row.subject === null ? {} : { subject: row.subject }),
            time: row.time!,
            datacontenttype: 'application/json',
            sequence: group.position.toString().padStart(19, '0'),
            data: row.data,
          });
        }
        if (reason) break;
        envelopes.push({ partition: options.partition, epoch: envelopeEpoch, position: group.position, events });
      }

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
