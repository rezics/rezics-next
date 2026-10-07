import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { MAIN_RELAY_STREAM_SCOPE } from '../outbox/relay-position.ts';
import { readEventDependencies, readEventSource, readEventSourceKeys } from './source.ts';

export const EVENT_PROJECTION_COST = {
  sourceKeys: 100, targets: 32, relayEvents: 100, windowRows: 100,
  windowUpdates: 8, windowsPerUpdate: 8,
} as const;

export class EventProjectionUnavailable extends Error {}

interface Key { event: string; status: 'actual' | 'planned' }
interface Checkpoint {
  generation: string; data_epoch: string; relay_sequence: string;
  backfill_event: string | null; backfill_status: Key['status'] | null;
  backfill_complete: boolean;
}
interface Interval {
  event: string; time_status: Key['status']; time_revision: string; manifest: string;
  temporal_kind: string; start_state: string; start_precision: string | null;
  end_state: string; end_precision: string | null;
  civil_start_min: string | null; civil_start_max: string | null;
  civil_end_min: string | null; civil_end_max: string | null;
  instant_start_min: string | null; instant_start_max: string | null;
  instant_end_min: string | null; instant_end_max: string | null;
  instant_supported: boolean;
}
interface Window {
  id: string; interpretation: 'civil-date' | 'instant'; grain: 'year' | 'month' | 'day';
  bucket_start: string; bucket_end: string; query_start: string; query_end: string; state: string;
  after_event: string | null; after_status: Key['status'] | null;
  before_update?: boolean;
}
const columns = ['event', 'time_status', 'time_revision', 'manifest', 'temporal_kind',
  'start_state', 'start_precision', 'end_state', 'end_precision',
  'civil_start_min', 'civil_start_max', 'civil_end_min', 'civil_end_max',
  'instant_start_min', 'instant_start_max', 'instant_end_min', 'instant_end_max',
  'instant_supported'] as const;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

function intervalFromSource(row: Awaited<ReturnType<typeof readEventSource>>['rows'][number]): Interval {
  return { event: row.event, time_status: row.timeStatus, time_revision: row.timeRevision,
    manifest: row.manifest, temporal_kind: row.temporalKind,
    start_state: row.startState, start_precision: row.startPrecision,
    end_state: row.endState, end_precision: row.endPrecision,
    civil_start_min: row.civilStartMin, civil_start_max: row.civilStartMax,
    civil_end_min: row.civilEndMin, civil_end_max: row.civilEndMax,
    instant_start_min: row.instantStartMin, instant_start_max: row.instantStartMax,
    instant_end_min: row.instantEndMin, instant_end_max: row.instantEndMax,
    instant_supported: row.instantSupported };
}

/** A window contains at most the admitted 366 buckets. Each interval contributes
 * once to every overlapping bucket; possible includes definite. */
async function changeBuckets(client: PoolClient, window: Window, row: Interval, delta: 1 | -1) {
  const unit = window.grain === 'year' ? '1 year' : window.grain === 'month' ? '1 month' : '1 day';
  if (window.interpretation === 'instant' && !row.instant_supported) {
    // A civil-only value prevents an instant comparison only in its possible
    // calendar window. Preserve that outcome alongside the supported counts.
    const column = row.time_status === 'actual' ? 'unsupported_actual_count' : 'unsupported_planned_count';
    await client.query(`UPDATE access.event_temporal_window SET ${column}=${column}+$2
      WHERE id=$1 AND daterange($3::date,$4::date,'[]')
        && daterange(bucket_start,(bucket_end+$5::interval)::date,'[)')`,
    [window.id, delta, row.civil_start_min, row.civil_end_max, unit]);
    return;
  }
  const civil = window.interpretation === 'civil-date';
  const bound = civil ? 'date' : 'timestamptz';
  const range = civil ? 'daterange' : 'tstzrange';
  const bucketStart = civil ? 'bucket_start::date' : "bucket_start::timestamp AT TIME ZONE 'UTC'";
  const bucketEnd = civil ? '(bucket_start + $4::interval)::date'
    : "(bucket_start + $4::interval)::timestamp AT TIME ZONE 'UTC'";
  const prefix = civil ? 'civil' : 'instant';
  const values = [window.id, window.bucket_start, window.bucket_end, unit, row.time_status,
    row[`${prefix}_start_min`], row[`${prefix}_end_max`], row[`${prefix}_start_max`], row[`${prefix}_end_min`]];
  const contribution = `WITH contribution AS (
    SELECT bucket_start::date AS bucket_start,
      CASE WHEN $8::${bound} IS NOT NULL AND $9::${bound} IS NOT NULL AND $8::${bound} <= $9::${bound}
        THEN CASE WHEN ${range}($8::${bound}, $9::${bound}, '[]')
          && ${range}(${bucketStart}, ${bucketEnd}, '[)') THEN 1 ELSE 0 END
        ELSE 0 END::bigint AS definite_count
    FROM generate_series($2::date, $3::date, $4::interval) AS bucket(bucket_start)
    WHERE ${range}($6::${bound}, $7::${bound}, '[]') && ${range}(${bucketStart}, ${bucketEnd}, '[)'))`;
  if (delta === 1) {
    await client.query(`${contribution} INSERT INTO access.event_temporal_bucket
      (window_id,time_status,bucket_start,definite_count,possible_count)
      SELECT $1,$5,bucket_start,definite_count,1 FROM contribution
      ON CONFLICT (window_id,time_status,bucket_start) DO UPDATE SET
        definite_count = event_temporal_bucket.definite_count + EXCLUDED.definite_count,
        possible_count = event_temporal_bucket.possible_count + EXCLUDED.possible_count`, values);
  } else {
    await client.query(`${contribution} UPDATE access.event_temporal_bucket b SET
      definite_count = b.definite_count - c.definite_count, possible_count = b.possible_count - 1
      FROM contribution c WHERE b.window_id = $1 AND b.time_status = $5 AND b.bucket_start = c.bucket_start`, values);
    await client.query(`DELETE FROM access.event_temporal_bucket
      WHERE window_id = $1 AND time_status = $2 AND possible_count = 0`, [window.id, row.time_status]);
  }
}

async function changeMember(client: PoolClient, window: Window, row: Interval, delta: 1 | -1) {
  if (delta === -1) {
    await client.query(`DELETE FROM access.event_temporal_member
      WHERE window_id=$1 AND event=$2 AND time_status=$3`, [window.id, row.event, row.time_status]);
    return;
  }
  if (window.interpretation === 'instant' && !row.instant_supported) return;
  const civil = window.interpretation === 'civil-date';
  const bound = civil ? 'date' : 'timestamptz';
  const range = civil ? 'daterange' : 'tstzrange';
  const prefix = civil ? 'civil' : 'instant';
  await client.query(`INSERT INTO access.event_temporal_member (window_id,event,time_status,time_revision,definite)
    SELECT $1,$2,$3,$4,CASE WHEN $9::${bound} IS NOT NULL AND $10::${bound} IS NOT NULL
      AND $9::${bound}<=$10::${bound} THEN ${range}($9::${bound},$10::${bound},'[]')
        && ${range}($5::${bound},$6::${bound},'[]') ELSE false END
    WHERE ${range}($7::${bound},$8::${bound},'[]') && ${range}($5::${bound},$6::${bound},'[]')
    ON CONFLICT (window_id,event,time_status) DO UPDATE SET
      time_revision=EXCLUDED.time_revision,definite=EXCLUDED.definite`,
  [window.id, row.event, row.time_status, row.time_revision, window.query_start, window.query_end,
    row[`${prefix}_start_min`], row[`${prefix}_end_max`], row[`${prefix}_start_max`], row[`${prefix}_end_min`]]);
}

/** Durable owner consumer: one bounded transaction advances source keys, relay
 * work and window work. Target savepoints retain failures without losing peers. */
export class EventTemporalProjection {
  constructor(private readonly access: Pool, private readonly relay: Pool,
    private readonly env: WorkActivationEnvironment) {}

  async tick(): Promise<number> {
    const client = await this.access.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('event-temporal-projection',0)) AS locked")).rows[0];
      if (!locked?.locked) { await client.query('ROLLBACK'); return 0; }
      const recovery = (await client.query<{ open: boolean }>(
        'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
      if (recovery?.open !== true) throw new EventProjectionUnavailable('Access is held for recovery');
      let checkpoint = (await client.query<Checkpoint>(`SELECT generation::text,data_epoch,relay_sequence::text,
        backfill_event,backfill_status,backfill_complete FROM access.event_temporal_checkpoint
        WHERE singleton FOR UPDATE`)).rows[0];
      if (!checkpoint) {
        const cut = (await this.relay.query<{ sequence: string }>(`SELECT coalesce(max(sequence),0)::text AS sequence
          FROM relay.delivered_batch WHERE stream_scope = $1 AND data_epoch = $2`,
        [MAIN_RELAY_STREAM_SCOPE, this.env.lineage.dataEpoch])).rows[0]!.sequence;
        const generation = randomUUID();
        await client.query(`INSERT INTO access.event_temporal_checkpoint
          (singleton,generation,data_epoch,relay_sequence,actual_revision,planned_revision)
          VALUES (true,$1,$2,$3,'','')`, [generation, this.env.lineage.dataEpoch, cut]);
        checkpoint = { generation, data_epoch: this.env.lineage.dataEpoch, relay_sequence: cut,
          backfill_event: null, backfill_status: null, backfill_complete: false };
      }
      if (checkpoint.data_epoch !== this.env.lineage.dataEpoch) {
        throw new EventProjectionUnavailable('Event projection epoch requires recovery');
      }
      let worked = await this.ingestRelay(client, checkpoint);
      if (!checkpoint.backfill_complete) worked += await this.backfill(client, checkpoint);
      worked += await this.projectTargets(client);
      worked += await this.updateWindows(client);
      const updates = (await client.query<{ pending: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM access.event_temporal_window_update LIMIT 1) AS pending')).rows[0]!.pending;
      // A delayed delta must reach a window before its scan passes the target.
      if (!updates) worked += await this.buildWindow(client, checkpoint);
      if (checkpoint.backfill_complete) {
        const dependencies = await readEventDependencies(this.env);
        if (dependencies.dataEpoch !== checkpoint.data_epoch) throw new EventProjectionUnavailable('Event owner epoch changed');
        if (BigInt(checkpoint.relay_sequence) >= BigInt(dependencies.relaySequence)) {
          // Each collection can acknowledge its own coverage while another
          // status retains a failed target or unfinished bucket delta.
          await client.query(`UPDATE access.event_temporal_checkpoint SET
            actual_revision = CASE WHEN ($1='none' OR EXISTS(
              SELECT 1 FROM access.event_temporal_applied WHERE time_revision=$1))
              AND NOT EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE time_status='actual' LIMIT 1)
              AND NOT EXISTS(SELECT 1 FROM access.event_temporal_window_update WHERE time_status='actual' LIMIT 1)
              THEN $1 ELSE actual_revision END,
            planned_revision = CASE WHEN ($2='none' OR EXISTS(
              SELECT 1 FROM access.event_temporal_applied WHERE time_revision=$2))
              AND NOT EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE time_status='planned' LIMIT 1)
              AND NOT EXISTS(SELECT 1 FROM access.event_temporal_window_update WHERE time_status='planned' LIMIT 1)
              THEN $2 ELSE planned_revision END WHERE singleton`, [dependencies.actual, dependencies.planned]);
        }
      }
      await client.query('COMMIT');
      return worked;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the projection failure */ }
      throw error;
    } finally { client.release(); }
  }

  private async enqueue(client: PoolClient, key: Key, sequence: string) {
    if (!native.test(key.event) || !['actual', 'planned'].includes(key.status)) {
      throw new EventProjectionUnavailable('Event relay target is invalid');
    }
    await client.query(`INSERT INTO access.event_temporal_pending
      (event,time_status,source_sequence,state,attempts,retry_at)
      VALUES ($1,$2,$3,'queued',0,clock_timestamp())
      ON CONFLICT (event,time_status) DO UPDATE SET source_sequence = greatest(
        event_temporal_pending.source_sequence,EXCLUDED.source_sequence),state='queued',retry_at=clock_timestamp()`,
    [key.event, key.status, sequence]);
  }

  private async ingestRelay(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    const batch = (await this.relay.query<{ sequence: string; event_count: number }>(
      `SELECT sequence::text,event_count FROM relay.delivered_batch
       WHERE stream_scope=$1 AND data_epoch=$2 AND sequence>$3::numeric ORDER BY relay.delivered_batch.sequence LIMIT 1`,
    [MAIN_RELAY_STREAM_SCOPE, checkpoint.data_epoch, checkpoint.relay_sequence])).rows[0];
    if (!batch) return 0;
    if (BigInt(batch.sequence) !== BigInt(checkpoint.relay_sequence) + 1n) {
      throw new EventProjectionUnavailable(`Event relay coverage has a gap after ${checkpoint.relay_sequence}: next ${batch.sequence}`);
    }
    const events = (await this.relay.query<{ envelope: { type?: string;
      data?: { receipt?: { outcome?: string; event?: string; timeStatus?: Key['status'] } } } }>(
      `SELECT envelope FROM relay.delivered_event WHERE stream_scope=$1 AND data_epoch=$2
       AND sequence=$3::numeric ORDER BY event_id LIMIT $4`,
    [MAIN_RELAY_STREAM_SCOPE, checkpoint.data_epoch, batch.sequence, EVENT_PROJECTION_COST.relayEvents + 1])).rows;
    if (events.length !== batch.event_count || events.length > EVENT_PROJECTION_COST.relayEvents) {
      throw new EventProjectionUnavailable('Event relay batch exceeds coverage budget or is incomplete');
    }
    for (const { envelope } of events) {
      if (envelope.type !== 'com.rezics.event.time-changed.v1') continue;
      const receipt = envelope.data?.receipt;
      if (receipt?.outcome !== 'succeeded' || !receipt.event || !receipt.timeStatus) {
        throw new EventProjectionUnavailable('Event relay proof is incomplete');
      }
      await this.enqueue(client, { event: receipt.event, status: receipt.timeStatus }, batch.sequence);
    }
    await client.query('UPDATE access.event_temporal_checkpoint SET relay_sequence=$1 WHERE singleton', [batch.sequence]);
    checkpoint.relay_sequence = batch.sequence;
    return 1;
  }

  private async backfill(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    const source = await readEventSourceKeys(this.env, {
      ...(checkpoint.backfill_event && checkpoint.backfill_status
        ? { after: { event: checkpoint.backfill_event, status: checkpoint.backfill_status } } : {}),
      limit: EVENT_PROJECTION_COST.sourceKeys });
    if (source.position.dataEpoch !== checkpoint.data_epoch) throw new EventProjectionUnavailable('Event backfill epoch changed');
    // Pending positions all belong to the relay stream. The inventory's graph
    // diagnostic sequence must never be compared with those positions.
    for (const key of source.keys) await this.enqueue(client, key, checkpoint.relay_sequence);
    const last = source.keys.at(-1);
    checkpoint.backfill_complete = source.keys.length < EVENT_PROJECTION_COST.sourceKeys;
    if (last) { checkpoint.backfill_event = last.event; checkpoint.backfill_status = last.status; }
    await client.query(`UPDATE access.event_temporal_checkpoint SET backfill_event=$1,backfill_status=$2,
      backfill_complete=$3,processed=processed+$4 WHERE singleton`,
    [checkpoint.backfill_event, checkpoint.backfill_status, checkpoint.backfill_complete, source.keys.length]);
    return source.keys.length || 1;
  }

  private async projectTargets(client: PoolClient): Promise<number> {
    const activeWindows = (await client.query<{ active: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM access.event_temporal_window WHERE state IN ('building','ready') LIMIT 1) AS active`)).rows[0]!.active;
    const pending = (await client.query<{ event: string; time_status: Key['status'] }>(
      `SELECT event,time_status FROM access.event_temporal_pending WHERE retry_at<=clock_timestamp()
       ORDER BY retry_at,event,time_status LIMIT $1 FOR UPDATE`, [EVENT_PROJECTION_COST.targets])).rows;
    for (const target of pending) {
      await client.query('SAVEPOINT event_target');
      try {
        const source = await readEventSource(this.env, { target: { event: target.event, status: target.time_status } });
        if (source.position.dataEpoch !== this.env.lineage.dataEpoch || source.rows.length > 1 || !source.head) {
          throw new EventProjectionUnavailable('Event target source is ambiguous or changed epoch');
        }
        const old = (await client.query<Interval>(`SELECT ${columns.map(column =>
          column.includes('_min') || column.includes('_max') ? `${column}::text AS ${column}` : column).join(',')}
          FROM access.event_temporal_interval WHERE event=$1 AND time_status=$2 FOR UPDATE`,
        [target.event, target.time_status])).rows[0] ?? null;
        const next = source.rows[0] ? intervalFromSource(source.rows[0]) : null;
        if (next && (next.event !== target.event || next.time_status !== target.time_status)) {
          throw new EventProjectionUnavailable('Event target differs from its source');
        }
        if (old?.time_revision !== next?.time_revision || old?.manifest !== next?.manifest) {
          if (next) await client.query(`INSERT INTO access.event_temporal_interval (${columns.join(',')})
            VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})
            ON CONFLICT (event,time_status) DO UPDATE SET ${columns.slice(2).map(column => `${column}=EXCLUDED.${column}`).join(',')}`,
          columns.map(column => next[column]));
          else await client.query('DELETE FROM access.event_temporal_interval WHERE event=$1 AND time_status=$2',
            [target.event, target.time_status]);
          // Queued windows have not consumed any interval yet. Their seek scan
          // will read the new row directly; enqueue deltas only after a scan starts.
          if (activeWindows) await client.query(`INSERT INTO access.event_temporal_window_update
            (event,time_status,old_interval,new_interval) VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
          [target.event, target.time_status, old ? JSON.stringify(old) : null, next ? JSON.stringify(next) : null]);
        }
        await client.query(`INSERT INTO access.event_temporal_applied (event,time_status,time_revision)
          VALUES ($1,$2,$3) ON CONFLICT (event,time_status) DO UPDATE SET time_revision=EXCLUDED.time_revision`,
        [target.event, target.time_status, source.head]);
        await client.query('DELETE FROM access.event_temporal_pending WHERE event=$1 AND time_status=$2',
          [target.event, target.time_status]);
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT event_target');
        await client.query(`UPDATE access.event_temporal_pending SET state='failed',attempts=attempts+1,
          retry_at=clock_timestamp()+least(30,power(2,least(attempts,5))) * interval '1 second',error=$3
          WHERE event=$1 AND time_status=$2`, [target.event, target.time_status,
          (error instanceof Error ? error.message : String(error)).slice(0, 500)]);
      }
      await client.query('RELEASE SAVEPOINT event_target');
    }
    return pending.length;
  }

  private async updateWindows(client: PoolClient): Promise<number> {
    let worked = 0;
    for (let index = 0; index < EVENT_PROJECTION_COST.windowUpdates; index++) {
      const job = (await client.query<{ id: string; event: string; time_status: Key['status'];
        old_interval: Interval | null; new_interval: Interval | null; after_window: string | null; created_at: string }>(
        `SELECT id::text,event,time_status,old_interval,new_interval,after_window::text,created_at::text
         FROM access.event_temporal_window_update ORDER BY event_temporal_window_update.id LIMIT 1 FOR UPDATE`)).rows[0];
      if (!job) break;
      const windows = (await client.query<Window>(`SELECT id::text,interpretation,grain,
        bucket_start::text,bucket_end::text,query_start,query_end,state,after_event,after_status,
        created_at<=$1::timestamptz AS before_update FROM access.event_temporal_window
        WHERE ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3 FOR UPDATE`,
      [job.created_at, job.after_window, EVENT_PROJECTION_COST.windowsPerUpdate])).rows;
      for (const window of windows) {
        // Evaluate creation eligibility after the bounded primary-key seek:
        // filtering first could walk every newer window to return no rows.
        if (!window.before_update) continue;
        const included = window.state === 'ready' || Boolean(window.after_event && (
          job.event < window.after_event || job.event === window.after_event && job.time_status <= window.after_status!));
        if (!included) continue;
        if (job.old_interval) {
          await changeBuckets(client, window, job.old_interval, -1);
          await changeMember(client, window, job.old_interval, -1);
        }
        if (job.new_interval) {
          await changeBuckets(client, window, job.new_interval, 1);
          await changeMember(client, window, job.new_interval, 1);
        }
        await client.query('UPDATE access.event_temporal_window SET revision=revision+1 WHERE id=$1', [window.id]);
      }
      if (windows.length < EVENT_PROJECTION_COST.windowsPerUpdate) {
        await client.query('DELETE FROM access.event_temporal_window_update WHERE id=$1', [job.id]);
      } else {
        await client.query('UPDATE access.event_temporal_window_update SET after_window=$2 WHERE id=$1',
          [job.id, windows.at(-1)!.id]);
      }
      worked++;
    }
    return worked;
  }

  private async buildWindow(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    if (!checkpoint.backfill_complete) return 0;
    const pending = (await client.query<{ pending: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE state='queued' LIMIT 1) AS pending")).rows[0]!.pending;
    if (pending) return 0;
    const window = (await client.query<Window>(`SELECT id::text,interpretation,grain,bucket_start::text,
      bucket_end::text,query_start,query_end,state,after_event,after_status FROM access.event_temporal_window
      WHERE state IN ('queued','building') ORDER BY created_at,id LIMIT 1 FOR UPDATE`)).rows[0];
    if (!window) return 0;
    const rows = (await client.query<Interval>(`SELECT ${columns.map(column =>
      column.includes('_min') || column.includes('_max') ? `${column}::text AS ${column}` : column).join(',')}
      FROM access.event_temporal_interval WHERE ($1::text IS NULL OR (event,time_status)>($1,$2))
      ORDER BY event,time_status LIMIT $3`, [window.after_event, window.after_status, EVENT_PROJECTION_COST.windowRows])).rows;
    for (const row of rows) {
      await changeBuckets(client, window, row, 1);
      await changeMember(client, window, row, 1);
    }
    const last = rows.at(-1);
    await client.query(`UPDATE access.event_temporal_window SET state=$2,after_event=$3,after_status=$4,
      processed=processed+$5 WHERE id=$1`, [window.id, rows.length < EVENT_PROJECTION_COST.windowRows ? 'ready' : 'building',
    last?.event ?? window.after_event, last?.time_status ?? window.after_status, rows.length]);
    return rows.length || 1;
  }
}
