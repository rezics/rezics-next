import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { effectInsertSql, effectInsertValues, hasEventEffects, uuidOrdinal } from './effects.ts';
import { EVENT_COLLECTION_BATCH, EVENT_SOURCE_COST, readEventCollectionKeys, readEventDependencies, readEventSource, readEventSourceKeys } from './source.ts';

export const EVENT_PROJECTION_COST = {
  sourceKeys: EVENT_SOURCE_COST.members, relayBatches: EVENT_SOURCE_COST.batches, targets: 32, relayEvents: EVENT_SOURCE_COST.members, windowRows: 100,
  collectionKeys: EVENT_COLLECTION_BATCH * 2, windowUpdates: 8, windowsPerUpdate: 8, windowCandidates: 8,
} as const;

export class EventProjectionUnavailable extends Error {}

interface Key { event: string; status: 'actual' | 'planned' }
interface Checkpoint {
  generation: string; data_epoch: string; relay_sequence: string;
  backfill_complete: boolean; initial_sequence: string | null;
  actual_source_sequence: string; actual_source_event: string | null; actual_prefix: string;
  planned_source_sequence: string; planned_source_event: string | null; planned_prefix: string;
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
  scan_started_at: string | null;
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
        backfill_complete,initial_sequence::text,
        actual_source_sequence::text,actual_source_event,actual_prefix::text,
        planned_source_sequence::text,planned_source_event,planned_prefix::text FROM access.event_temporal_checkpoint
        WHERE singleton FOR UPDATE`)).rows[0];
      if (!checkpoint) {
        const boundary = await readEventDependencies(this.env);
        const generation = randomUUID();
        await client.query(`INSERT INTO access.event_temporal_checkpoint
          (singleton,generation,data_epoch,relay_sequence,actual_revision,planned_revision,initial_sequence)
          VALUES (true,$1,$2,0,'','',$3)`, [generation, this.env.lineage.dataEpoch, boundary.relaySequence]);
        checkpoint = { generation, data_epoch: this.env.lineage.dataEpoch, relay_sequence: '0',
          backfill_complete: false, initial_sequence: boundary.relaySequence,
          actual_source_sequence: '0', actual_source_event: null, actual_prefix: '0',
          planned_source_sequence: '0', planned_source_event: null, planned_prefix: '0' };
      }
      if (checkpoint.data_epoch !== this.env.lineage.dataEpoch) {
        throw new EventProjectionUnavailable('Event projection epoch requires recovery');
      }
      if (checkpoint.initial_sequence === null) {
        const boundary = await readEventDependencies(this.env);
        checkpoint.initial_sequence = boundary.relaySequence;
        await client.query('UPDATE access.event_temporal_checkpoint SET initial_sequence=$1 WHERE singleton', [boundary.relaySequence]);
      }
      let worked = await this.ingestRelay(client, checkpoint);
      const source = await readEventDependencies(this.env);
      if (BigInt(checkpoint.relay_sequence) > BigInt(source.relaySequence)) {
        throw new EventProjectionUnavailable('Event journal checkpoint exceeds its source');
      }
      // Completion is a retained finite prefix, independent of later Main writes.
      if (!checkpoint.backfill_complete && BigInt(checkpoint.relay_sequence) >= BigInt(checkpoint.initial_sequence)) {
        checkpoint.backfill_complete = true;
        await client.query('UPDATE access.event_temporal_checkpoint SET backfill_complete=true WHERE singleton');
      }
      worked += await this.ingestCollections(client, checkpoint);
      worked += await this.projectTargets(client);
      worked += await this.updateWindows(client);
      worked += await this.buildWindow(client, checkpoint);
      if (checkpoint.backfill_complete) {
        const dependencies = await readEventDependencies(this.env);
        if (dependencies.dataEpoch !== checkpoint.data_epoch) throw new EventProjectionUnavailable('Event owner epoch changed');
        // Exact applied heads qualify only after their own owner batch was
        // consumed. Other targets and bucket jobs fence their own read scopes.
        await client.query(`UPDATE access.event_temporal_checkpoint SET
          actual_revision = CASE WHEN $1='none' OR EXISTS(
            SELECT 1 FROM access.event_temporal_applied WHERE time_status='actual'
              AND time_revision=$1 AND journal_sequence<= $3::numeric)
            THEN $1 ELSE actual_revision END,
          planned_revision = CASE WHEN $2='none' OR EXISTS(
            SELECT 1 FROM access.event_temporal_applied WHERE time_status='planned'
              AND time_revision=$2 AND journal_sequence<= $4::numeric)
            THEN $2 ELSE planned_revision END WHERE singleton`,
        [dependencies.actual, dependencies.planned, checkpoint.actual_prefix, checkpoint.planned_prefix]);
      }
      await client.query('COMMIT');
      return worked;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the projection failure */ }
      throw error;
    } finally { client.release(); }
  }

  private async enqueue(client: PoolClient, key: Key & { revision: string; sequence: string }) {
    if (!native.test(key.event) || !['actual', 'planned'].includes(key.status)) {
      throw new EventProjectionUnavailable('Event relay target is invalid');
    }
    const applied = await client.query(`UPDATE access.event_temporal_applied SET journal_sequence=$3
      WHERE event=$1 AND time_status=$2 AND time_revision=$4`, [key.event, key.status, key.sequence, key.revision]);
    if (applied.rowCount) {
      await client.query('DELETE FROM access.event_temporal_pending WHERE event=$1 AND time_status=$2 AND source_sequence<=$3',
        [key.event, key.status, key.sequence]);
      return;
    }
    await client.query(`INSERT INTO access.event_temporal_pending
      (event,time_status,source_sequence,journal_revision,state,attempts,retry_at)
      VALUES ($1,$2,$3,$4,'queued',0,clock_timestamp())
      ON CONFLICT (event,time_status) DO UPDATE SET source_sequence=EXCLUDED.source_sequence,
        journal_revision=EXCLUDED.journal_revision,state='queued',retry_at=clock_timestamp()
      WHERE event_temporal_pending.source_sequence<=EXCLUDED.source_sequence`,
    [key.event, key.status, key.sequence, key.revision]);
  }

  private async ingestRelay(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    const source = await readEventSourceKeys(this.relay, {
      dataEpoch: checkpoint.data_epoch, afterSequence: checkpoint.relay_sequence });
    if (!source) return 0;
    for (const key of source.keys) await this.enqueue(client, key);
    await client.query(`UPDATE access.event_temporal_checkpoint SET relay_sequence=$1,
      processed=processed+$2 WHERE singleton`, [source.sequence, source.members]);
    checkpoint.relay_sequence = source.sequence;
    return source.batches;
  }

  private async ingestCollections(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    let worked = 0;
    for (const status of ['actual', 'planned'] as const) {
      const coveredByMain = BigInt(checkpoint.relay_sequence) > BigInt(checkpoint[`${status}_source_sequence`]);
      const source = await readEventCollectionKeys(this.relay, { dataEpoch: checkpoint.data_epoch, status,
        sequence: coveredByMain ? checkpoint.relay_sequence : checkpoint[`${status}_source_sequence`],
        eventId: coveredByMain ? null : checkpoint[`${status}_source_event`] });
      for (const key of source.keys) await this.enqueue(client, key);
      await client.query(`UPDATE access.event_temporal_checkpoint SET
        ${status}_source_sequence=$1,${status}_source_event=$2,${status}_prefix=$3 WHERE singleton`,
      [source.sequence, source.eventId, source.prefix]);
      checkpoint[`${status}_source_sequence`] = source.sequence;
      checkpoint[`${status}_source_event`] = source.eventId;
      checkpoint[`${status}_prefix`] = source.prefix;
      worked += source.keys.length;
    }
    return worked;
  }

  private async projectTargets(client: PoolClient): Promise<number> {
    const receivers = (await client.query<{ active: boolean; last_window: string | null }>(`SELECT EXISTS(
      SELECT 1 FROM access.event_temporal_window WHERE state IN ('building','ready') LIMIT 1) AS active,
      (SELECT id::text FROM access.event_temporal_window ORDER BY access.event_temporal_window.id DESC LIMIT 1) AS last_window`)).rows[0]!;
    const pending = (await client.query<{ event: string; time_status: Key['status']; journal_revision: string | null; source_sequence: string }>(
      `SELECT event,time_status,journal_revision,source_sequence::text FROM access.event_temporal_pending WHERE retry_at<=statement_timestamp()
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
          if (receivers.active && receivers.last_window) {
            // Changes to one target retain FIFO across receivers; independent
            // targets rotate fairly without waiting for that target's windows.
            const prior = (await client.query<{ id: string }>(`SELECT id::text
              FROM access.event_temporal_window_update WHERE event=$1 AND time_status=$2
              ORDER BY access.event_temporal_window_update.id DESC LIMIT 1 FOR UPDATE`,
            [target.event, target.time_status])).rows[0];
            const job = (await client.query<{ id: string }>(`${effectInsertSql} RETURNING id::text`,
              effectInsertValues(target.event, target.time_status, old, next, receivers.last_window, !prior))).rows[0]!;
            if (prior) await client.query('UPDATE access.event_temporal_window_update SET next_job=$2 WHERE id=$1',
              [prior.id, job.id]);
          }
        }
        await client.query(`INSERT INTO access.event_temporal_applied (event,time_status,time_revision,journal_sequence)
          VALUES ($1,$2,$3,$4) ON CONFLICT (event,time_status) DO UPDATE SET
            journal_sequence=CASE WHEN event_temporal_applied.time_revision=EXCLUDED.time_revision
              THEN coalesce(EXCLUDED.journal_sequence,event_temporal_applied.journal_sequence)
              ELSE EXCLUDED.journal_sequence END,time_revision=EXCLUDED.time_revision`,
        [target.event, target.time_status, source.head,
          source.head === target.journal_revision ? target.source_sequence : null]);
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
        old_interval: Interval | null; new_interval: Interval | null; after_window: string | null; last_window: string | null; next_job: string | null }>(
        `SELECT id::text,event,time_status,old_interval,new_interval,after_window::text,last_window::text,next_job::text
         FROM access.event_temporal_window_update WHERE ready ORDER BY work_at,event_temporal_window_update.id LIMIT 1 FOR UPDATE`)).rows[0];
      if (!job) break;
      const windows = (await client.query<Window>(`SELECT id::text,interpretation,grain,
        bucket_start::text,bucket_end::text,query_start,query_end,state,after_event,after_status,
        scan_started_at::text FROM access.event_temporal_window
        WHERE ($1::uuid IS NULL OR id>$1::uuid) AND id<=$2::uuid ORDER BY access.event_temporal_window.id LIMIT $3 FOR UPDATE`,
      [job.after_window, job.last_window, EVENT_PROJECTION_COST.windowsPerUpdate])).rows;
      for (const window of windows) {
        if (!await hasEventEffects(client, window, undefined, undefined, job.id)) continue;
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
        await client.query(`UPDATE access.event_temporal_window SET revision=revision+1,
          ${job.time_status === 'actual' ? 'actual_revision=actual_revision+1' : 'planned_revision=planned_revision+1'} WHERE id=$1`, [window.id]);
      }
      if (windows.length < EVENT_PROJECTION_COST.windowsPerUpdate) {
        await client.query('DELETE FROM access.event_temporal_window_update WHERE id=$1', [job.id]);
        if (job.next_job) await client.query('UPDATE access.event_temporal_window_update SET ready=true WHERE id=$1', [job.next_job]);
      } else {
        await client.query(`UPDATE access.event_temporal_window_update SET after_window=$2,work_at=clock_timestamp(),
          unvisited_windows=numrange($3::numeric,upper(unvisited_windows),'(]') WHERE id=$1`,
          [job.id, windows.at(-1)!.id, uuidOrdinal(windows.at(-1)!.id)]);
      }
      worked++;
    }
    return worked;
  }

  private async buildWindow(client: PoolClient, checkpoint: Checkpoint): Promise<number> {
    if (!checkpoint.backfill_complete) return 0;
    const candidates = (await client.query<Window>(`SELECT id::text,interpretation,grain,bucket_start::text,
      bucket_end::text,query_start,query_end,state,after_event,after_status,scan_started_at::text
      FROM access.event_temporal_window WHERE state IN ('queued','building')
      ORDER BY work_at,access.event_temporal_window.id LIMIT $1 FOR UPDATE`, [EVENT_PROJECTION_COST.windowCandidates])).rows;
    let window: Window | undefined;
    for (const candidate of candidates) {
      await client.query('UPDATE access.event_temporal_window SET work_at=clock_timestamp() WHERE id=$1', [candidate.id]);
      // An older queued window has not consumed old rows yet. A running scan
      // must not overtake a relevant delta, but disjoint jobs never fence it.
      if (await hasEventEffects(client, candidate)) continue;
      window = candidate; break;
    }
    if (!window) return 0;
    if (!window.scan_started_at) {
      const started = (await client.query<{ started: string }>(`UPDATE access.event_temporal_window
        SET scan_started_at=clock_timestamp() WHERE id=$1 RETURNING scan_started_at::text AS started`, [window.id])).rows[0]!;
      window.scan_started_at = started.started;
    }
    // An empty indexed extent is complete immediately. Disjoint windows need
    // not walk the unrelated interval population merely to establish zero.
    const unit = window.grain === 'year' ? '1 year' : window.grain === 'month' ? '1 month' : '1 day';
    const occupied = (await client.query<{ occupied: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM access.event_temporal_interval WHERE ${window.interpretation === 'civil-date'
        ? "civil_possible && daterange($1::date,($2::date+$3::interval)::date,'[)')"
        : "instant_supported AND instant_possible && tstzrange($1::date::timestamp AT TIME ZONE 'UTC',($2::date+$3::interval) AT TIME ZONE 'UTC','[)')"} LIMIT 1)
      ${window.interpretation === 'instant' ? "OR EXISTS(SELECT 1 FROM access.event_temporal_interval WHERE NOT instant_supported AND civil_possible && daterange($1::date,($2::date+$3::interval)::date,'[)') LIMIT 1)" : ''}
      AS occupied`, [window.bucket_start, window.bucket_end, unit])).rows[0]!.occupied;
    if (!occupied) {
      await client.query("UPDATE access.event_temporal_window SET state='ready' WHERE id=$1", [window.id]);
      return 1;
    }
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
