import type { Pool } from 'pg';
import { ContentConflict, ContentUnavailable, type ContentPosition, type ContentOutboxEvent } from './core.ts';

export const CONTENT_PROJECTION_COST = { scanEvents: 1, retryEvents: 8, graphCommandsPerEvent: 1, deadlineMs: 10_000 } as const;

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
    return this.position(consumer, false);
  }

  async readScan(consumer: string): Promise<ContentPosition> {
    return this.position(consumer, true);
  }

  private async position(consumer: string, scan: boolean): Promise<ContentPosition> {
    consumerName(consumer);
    const result = await this.pool.query(`SELECT c.data_epoch, ${scan ? 'c.scan_sequence' : 'c.sequence'}::text AS sequence,
      c.sequence::text AS completed, COALESCE((SELECT min(sequence) - 1 FROM content.projection_pending
        WHERE consumer = c.consumer AND data_epoch = c.data_epoch), c.scan_sequence)::text AS covered,
      o.data_epoch AS owner_epoch FROM content.projection_checkpoint c
      CROSS JOIN content.owner_control o WHERE c.consumer = $1 AND o.singleton`, [consumer]);
    if (result.rowCount !== 1) throw new ContentUnavailable('projection checkpoint uninitialized');
    const row = result.rows[0];
    if (row.data_epoch !== row.owner_epoch) throw new ContentConflict('Content owner epoch changed');
    if (row.completed !== row.covered) throw new ContentConflict('retained projection coverage differs');
    return { owner: 'content', dataEpoch: row.data_epoch, sequence: row.sequence };
  }

  async acknowledge(consumer: string, expected: ContentPosition, next: ContentPosition,
    retained?: { event: ContentOutboxEvent; target: string }): Promise<void> {
    consumerName(consumer);
    if (expected.owner !== 'content' || next.owner !== 'content'
      || expected.dataEpoch !== next.dataEpoch || !decimal.test(expected.sequence)
      || !decimal.test(next.sequence) || BigInt(next.sequence) !== BigInt(expected.sequence) + 1n) {
      throw new ContentConflict('projection acknowledgement must advance one source event');
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      // Only the checkpoint is locked: the owner row belongs to the sequencer, and
      // an epoch cut racing this check leaves a checkpoint that read() rejects.
      const current = await client.query(`SELECT c.data_epoch, c.scan_sequence::text AS sequence,
        c.sequence::text AS completed, COALESCE((SELECT min(sequence) - 1 FROM content.projection_pending
          WHERE consumer = c.consumer AND data_epoch = c.data_epoch), c.scan_sequence)::text AS covered,
        o.data_epoch AS owner_epoch FROM content.projection_checkpoint c
        CROSS JOIN content.owner_control o WHERE c.consumer = $1 AND o.singleton FOR UPDATE OF c`, [consumer]);
      const row = current.rows[0];
      if (!row || row.owner_epoch !== expected.dataEpoch || row.data_epoch !== expected.dataEpoch
        || row.sequence !== expected.sequence) throw new ContentConflict('projection checkpoint changed');
      if (row.completed !== row.covered) throw new ContentConflict('retained projection coverage differs');
      const event = await client.query(`SELECT id FROM content.outbox
        WHERE data_epoch = $1::uuid AND sequence = $2::bigint`, [next.dataEpoch, next.sequence]);
      if (event.rowCount !== 1) throw new ContentUnavailable('projection source event missing');
      if (retained) {
        if (!retained.target || retained.target.length > 300 || event.rows[0].id !== retained.event.id
          || retained.event.position.dataEpoch !== next.dataEpoch || retained.event.position.sequence !== next.sequence) {
          throw new ContentConflict('retained projection differs from source event');
        }
        await client.query(`INSERT INTO content.projection_pending
          (consumer, data_epoch, sequence, event_id, target) VALUES ($1,$2,$3,$4,$5)`,
        [consumer, next.dataEpoch, next.sequence, retained.event.id, retained.target]);
        await client.query(`INSERT INTO content.projection_target (consumer,data_epoch,target,first_sequence)
          VALUES ($1,$2,$3,$4) ON CONFLICT (consumer,data_epoch,target) DO NOTHING`,
        [consumer, next.dataEpoch, retained.target, next.sequence]);
      }
      await client.query(`UPDATE content.projection_checkpoint SET scan_sequence = $2::bigint,
        sequence = COALESCE((SELECT min(sequence) - 1 FROM content.projection_pending
          WHERE consumer = $1 AND data_epoch = $3), $2::bigint),
        updated_at = clock_timestamp() WHERE consumer = $1`, [consumer, next.sequence, next.dataEpoch]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async hasPendingTarget(consumer: string, epoch: string, target: string): Promise<boolean> {
    consumerName(consumer);
    return (await this.pool.query(`SELECT 1 FROM content.projection_pending
      WHERE consumer = $1 AND data_epoch = $2 AND target = $3 LIMIT 1`,
    [consumer, epoch, target])).rowCount === 1;
  }

  /** Fair, bounded retries: only the oldest event of each target is eligible. */
  async retries(consumer: string): Promise<ContentOutboxEvent[]> {
    consumerName(consumer);
    const rows = (await this.pool.query(`WITH targets AS MATERIALIZED (
      SELECT t.* FROM content.projection_target t
      WHERE t.consumer = $1 AND t.data_epoch = (SELECT data_epoch FROM content.projection_checkpoint WHERE consumer = $1)
      ORDER BY t.attempted_at, t.first_sequence LIMIT $2)
      SELECT event.* FROM targets t CROSS JOIN LATERAL (
        SELECT o.* FROM content.projection_pending p JOIN content.outbox o ON o.id = p.event_id
          AND o.data_epoch = p.data_epoch AND o.sequence = p.sequence
        WHERE p.consumer = t.consumer AND p.data_epoch = t.data_epoch AND p.sequence = t.first_sequence LIMIT 1
      ) event`, [consumer, CONTENT_PROJECTION_COST.retryEvents])).rows;
    return rows.map(row => ({ id: row.id, position: { owner: 'content', dataEpoch: row.data_epoch,
      sequence: String(row.sequence) }, operationId: row.operation_id, recipe: row.recipe,
      eventType: row.event_type, revisionId: row.revision_id, payload: row.payload }));
  }

  async finishRetry(consumer: string, event: ContentOutboxEvent, completed: boolean): Promise<void> {
    consumerName(consumer);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      const current = await client.query(`SELECT c.data_epoch, o.data_epoch AS owner_epoch, c.sequence::text AS completed,
        COALESCE((SELECT min(sequence) - 1 FROM content.projection_pending WHERE consumer=c.consumer
          AND data_epoch=c.data_epoch), c.scan_sequence)::text AS covered
        FROM content.projection_checkpoint c CROSS JOIN content.owner_control o
        WHERE c.consumer = $1 AND o.singleton FOR UPDATE OF c`, [consumer]);
      if (current.rows[0]?.data_epoch !== event.position.dataEpoch
        || current.rows[0]?.owner_epoch !== event.position.dataEpoch) throw new ContentConflict('Content owner epoch changed');
      if (current.rows[0].completed !== current.rows[0].covered) throw new ContentConflict('retained projection coverage differs');
      if (completed) {
        const removed = await client.query(`DELETE FROM content.projection_pending
          WHERE consumer = $1 AND data_epoch = $2 AND sequence = $3 AND event_id = $4 RETURNING target`,
        [consumer, event.position.dataEpoch, event.position.sequence, event.id]);
        if (removed.rowCount) await client.query(`INSERT INTO content.projection_target(consumer,data_epoch,target,first_sequence)
          SELECT consumer,data_epoch,target,sequence FROM content.projection_pending
          WHERE consumer=$1 AND data_epoch=$2 AND target=$3 ORDER BY sequence LIMIT 1`,
        [consumer, event.position.dataEpoch, removed.rows[0].target]);
        await client.query(`UPDATE content.projection_checkpoint c SET sequence = COALESCE(
          (SELECT min(sequence) - 1 FROM content.projection_pending WHERE consumer = $1 AND data_epoch = c.data_epoch),
          scan_sequence), updated_at = clock_timestamp() WHERE consumer = $1`, [consumer]);
      } else {
        await client.query(`UPDATE content.projection_target SET attempted_at = clock_timestamp()
          WHERE consumer = $1 AND data_epoch = $2 AND first_sequence = $3`,
        [consumer, event.position.dataEpoch, event.position.sequence]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
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
      const pending = await client.query('SELECT 1 FROM content.projection_pending WHERE consumer = ANY($1) LIMIT 1',
        [[consumer, rebuildConsumer]]);
      if (pending.rowCount) throw new ContentConflict('pending projection prevents rebuild promotion');
      await client.query(`INSERT INTO content.projection_checkpoint (consumer, data_epoch, sequence, scan_sequence)
        VALUES ($1, $2::uuid, $3::bigint, $3::bigint)
        ON CONFLICT (consumer) DO UPDATE SET data_epoch = EXCLUDED.data_epoch,
          scan_sequence = CASE WHEN content.projection_checkpoint.data_epoch = EXCLUDED.data_epoch
            THEN GREATEST(content.projection_checkpoint.scan_sequence, EXCLUDED.scan_sequence)
            ELSE EXCLUDED.scan_sequence END,
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
