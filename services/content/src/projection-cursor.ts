import type { Pool } from 'pg';
import { ContentConflict, ContentUnavailable, type ContentPosition } from './core.ts';

const decimal = /^(0|[1-9][0-9]*)$/;

function consumerName(value: string): void {
  if (!/^[a-z][a-z0-9._-]{0,99}$/.test(value)) throw new ContentConflict('invalid projection consumer');
}

/** Durable Content-side acknowledgement; the graph receipt makes replay safe across stores. */
export class ContentProjectionCursor {
  constructor(private readonly pool: Pool) {}

  async initialize(consumer: string): Promise<ContentPosition> {
    consumerName(consumer);
    await this.pool.query(`INSERT INTO content.projection_checkpoint (consumer, data_epoch)
      SELECT $1, data_epoch FROM content.owner_control WHERE singleton
      ON CONFLICT (consumer) DO NOTHING`, [consumer]);
    return this.read(consumer);
  }

  async read(consumer: string): Promise<ContentPosition> {
    consumerName(consumer);
    const result = await this.pool.query(`SELECT c.data_epoch, c.sequence::text AS sequence,
      o.data_epoch AS owner_epoch FROM content.projection_checkpoint c
      CROSS JOIN content.owner_control o WHERE c.consumer = $1 AND o.singleton`, [consumer]);
    if (result.rowCount !== 1) throw new ContentUnavailable('projection checkpoint uninitialized');
    const row = result.rows[0];
    if (row.data_epoch !== row.owner_epoch) throw new ContentConflict('Content owner epoch changed');
    return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
  }

  async acknowledge(consumer: string, expected: ContentPosition, next: ContentPosition): Promise<void> {
    consumerName(consumer);
    if (expected.owner !== 'content' || next.owner !== 'content'
      || expected.dataEpoch !== next.dataEpoch || !decimal.test(expected.sequence)
      || !decimal.test(next.sequence) || BigInt(next.sequence) !== BigInt(expected.sequence) + 1n) {
      throw new ContentConflict('projection acknowledgement must advance one source event');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(`SELECT c.data_epoch, c.sequence::text AS sequence,
        o.data_epoch AS owner_epoch FROM content.projection_checkpoint c
        CROSS JOIN content.owner_control o WHERE c.consumer = $1 AND o.singleton FOR UPDATE OF c, o`, [consumer]);
      const row = current.rows[0];
      if (!row || row.owner_epoch !== expected.dataEpoch || row.data_epoch !== expected.dataEpoch
        || row.sequence !== expected.sequence) throw new ContentConflict('projection checkpoint changed');
      const event = await client.query(`SELECT 1 FROM content.outbox
        WHERE data_epoch = $1::uuid AND sequence = $2::bigint`, [next.dataEpoch, next.sequence]);
      if (event.rowCount !== 1) throw new ContentUnavailable('projection source event missing');
      await client.query(`UPDATE content.projection_checkpoint SET sequence = $2::bigint,
        updated_at = clock_timestamp() WHERE consumer = $1`, [consumer, next.sequence]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  /** Promote an independently replayed rebuild cursor only at the exact owner cut. */
  async adoptRebuildCheckpoint(consumer: string, rebuildConsumer: string,
    cut: ContentPosition): Promise<void> {
    consumerName(consumer);
    consumerName(rebuildConsumer);
    if (consumer === rebuildConsumer || cut.owner !== 'content'
      || !/^[0-9a-f-]{36}$/.test(cut.dataEpoch) || !decimal.test(cut.sequence)) {
      throw new ContentConflict('invalid rebuild checkpoint promotion');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(`SELECT data_epoch, sequence::text AS sequence
        FROM content.owner_control WHERE singleton FOR UPDATE`);
      if (owner.rowCount !== 1 || owner.rows[0].data_epoch !== cut.dataEpoch
        || BigInt(owner.rows[0].sequence) < BigInt(cut.sequence)) {
        throw new ContentConflict('Content owner epoch moved before checkpoint promotion');
      }
      const replay = await client.query(`SELECT data_epoch, sequence::text AS sequence
        FROM content.projection_checkpoint WHERE consumer = $1 FOR UPDATE`, [rebuildConsumer]);
      if (replay.rowCount !== 1 || replay.rows[0].data_epoch !== cut.dataEpoch
        || replay.rows[0].sequence !== cut.sequence) {
        throw new ContentConflict('rebuild cursor does not cover owner cut');
      }
      await client.query(`INSERT INTO content.projection_checkpoint (consumer, data_epoch, sequence)
        VALUES ($1, $2::uuid, $3::bigint)
        ON CONFLICT (consumer) DO UPDATE SET data_epoch = EXCLUDED.data_epoch,
          sequence = CASE WHEN content.projection_checkpoint.data_epoch = EXCLUDED.data_epoch
            THEN GREATEST(content.projection_checkpoint.sequence, EXCLUDED.sequence)
            ELSE EXCLUDED.sequence END, updated_at = clock_timestamp()`,
      [consumer, cut.dataEpoch, cut.sequence]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
