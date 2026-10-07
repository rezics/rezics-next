import type { Pool, PoolClient } from 'pg';
import { eventEndpointBounds, UnsupportedEventTime, type EventObservationIntent } from './time.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readEventObservationReceipt } from './observation.ts';

export interface EventEffectWindow {
  id: string;
  interpretation: 'civil-date' | 'instant';
  grain: 'year' | 'month' | 'day';
  bucket_start: string;
  bucket_end: string;
  scan_started_at: string | null;
}

export interface EventEffectInterval {
  civil_start_min: string | null;
  civil_end_max: string | null;
  instant_start_min: string | null;
  instant_end_max: string | null;
  instant_supported: boolean;
}

type Status = 'actual' | 'planned';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** UUID ordering is also the projection's window and target seek ordering. */
export function uuidOrdinal(value: string): string {
  const suffix = value.startsWith('https://rezics.com/id/') ? value.slice('https://rezics.com/id/'.length) : value;
  if (!uuid.test(suffix)) throw new Error('Event effect UUID is invalid');
  return BigInt(`0x${suffix.replaceAll('-', '')}`).toString();
}

function checkedStatus(status: Status): Status {
  if (status !== 'actual' && status !== 'planned') throw new Error('Event effect status is invalid');
  return status;
}

/** Typed indexed effects preserve open bounds and the union of old/new spans.
 * A missing interval contributes nothing; unknown/open points remain unbounded. */
export const effectInsertSql = `INSERT INTO access.event_temporal_window_update
  (event,time_status,old_interval,new_interval,target,last_window,unvisited_windows,ready,civil_effect,instant_effect,unsupported_effect)
  VALUES ($1,$2,$3::jsonb,$4::jsonb,numrange($5::numeric,$5::numeric,'[]'),$7::uuid,numrange(0,$6::numeric,'[]'),$8::boolean,
    datemultirange(
      CASE WHEN $3::jsonb IS NULL THEN 'empty'::daterange
        ELSE daterange(($3::jsonb->>'civil_start_min')::date,($3::jsonb->>'civil_end_max')::date,'[]') END,
      CASE WHEN $4::jsonb IS NULL THEN 'empty'::daterange
        ELSE daterange(($4::jsonb->>'civil_start_min')::date,($4::jsonb->>'civil_end_max')::date,'[]') END),
    tstzmultirange(
      CASE WHEN ($3::jsonb->>'instant_supported')::boolean IS TRUE
        THEN tstzrange(($3::jsonb->>'instant_start_min')::timestamptz,($3::jsonb->>'instant_end_max')::timestamptz,'[]')
        ELSE 'empty'::tstzrange END,
      CASE WHEN ($4::jsonb->>'instant_supported')::boolean IS TRUE
        THEN tstzrange(($4::jsonb->>'instant_start_min')::timestamptz,($4::jsonb->>'instant_end_max')::timestamptz,'[]')
        ELSE 'empty'::tstzrange END),
    datemultirange(
      CASE WHEN ($3::jsonb->>'instant_supported')::boolean IS FALSE
        THEN daterange(($3::jsonb->>'civil_start_min')::date,($3::jsonb->>'civil_end_max')::date,'[]')
        ELSE 'empty'::daterange END,
      CASE WHEN ($4::jsonb->>'instant_supported')::boolean IS FALSE
        THEN daterange(($4::jsonb->>'civil_start_min')::date,($4::jsonb->>'civil_end_max')::date,'[]')
        ELSE 'empty'::daterange END))`;

export function effectInsertValues(event: string, status: Status,
  old: EventEffectInterval | null, next: EventEffectInterval | null, lastWindow: string, ready: boolean): unknown[] {
  return [event, checkedStatus(status), old ? JSON.stringify(old) : null,
    next ? JSON.stringify(next) : null, uuidOrdinal(event), uuidOrdinal(lastWindow), lastWindow, ready];
}

export function eventIntentEffect(input: EventObservationIntent): EventEffectInterval {
  const end = input.temporalKind === 'instant' ? input.start : input.end!;
  const civilStart = eventEndpointBounds(input.start, 'civil-date');
  const civilEnd = eventEndpointBounds(end, 'civil-date');
  let instantStart = null, instantEnd = null, supported = true;
  try {
    instantStart = eventEndpointBounds(input.start, 'instant').instantMin;
    instantEnd = eventEndpointBounds(end, 'instant').instantMax;
  } catch (error) {
    if (!(error instanceof UnsupportedEventTime)) throw error;
    supported = false;
  }
  return { civil_start_min: civilStart.civilMin, civil_end_max: civilEnd.civilMax,
    instant_start_min: instantStart, instant_end_max: instantEnd, instant_supported: supported };
}

/** Durable admission-bound fence precedes graph visibility. Replays reuse the
 * same effect; concurrent admissions retain independent conservative unions. */
export async function registerEventPublication(pool: Pool, publication: {
  receipt: string; admission: string; digest: string; event: string; status: Status;
  expiresAt: string; authorityEpoch: string;
  old: EventEffectInterval | null; next: EventEffectInterval | null;
}, env: WorkActivationEnvironment) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fence = (await client.query<{ open: boolean }>('SELECT open FROM access.recovery_fence WHERE id=true FOR SHARE')).rows[0];
    if (!fence?.open) throw new Error('Event publication is held for recovery');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`event-publication:${publication.receipt}`]);
    const prior = (await client.query<{ event: string; time_status: string; publication_digest: string }>(
      `SELECT event,time_status,publication_digest FROM access.event_temporal_window_update
        WHERE publication_receipt=$1 FOR UPDATE`, [publication.receipt])).rows[0];
    if (prior) {
      if (prior.event !== publication.event || prior.time_status !== publication.status
        || prior.publication_digest !== publication.digest) throw new Error('Event publication intent conflicts');
    } else {
      // A slow retry must not resurrect an already projected receipt.
      const terminal = await readEventObservationReceipt(env, publication.admission);
      if (terminal) {
        if (terminal.requestDigest !== publication.digest || terminal.dataEpoch !== env.lineage.dataEpoch)
          throw new Error('Event publication terminal differs');
        await client.query('COMMIT');
        return false;
      }
      const row = (await client.query<{ id: string }>(`${effectInsertSql} RETURNING id::text`,
        effectInsertValues(publication.event, publication.status, publication.old, publication.next,
          '00000000-0000-0000-0000-000000000000', false))).rows[0]!;
      await client.query(`UPDATE access.event_temporal_window_update SET publication_receipt=$2,
        publication_admission=$3,publication_digest=$4,publication_expiry=$5,publication_authority_epoch=$6 WHERE id=$1`,
      [row.id, publication.receipt, publication.admission, publication.digest, publication.expiresAt, publication.authorityEpoch]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

/** A job fences only windows whose scan started before its creation and that its bounded
 * window seek has not visited. Both old and new contributions matter. */
export function eventEffectFence(window: EventEffectWindow, status?: Status,
  events?: string[], jobId?: string): { text: string; values: unknown[] } {
  const unit = window.grain === 'year' ? '1 year' : window.grain === 'month' ? '1 month'
    : window.grain === 'day' ? '1 day' : undefined;
  if (!unit || !['civil-date', 'instant'].includes(window.interpretation)) {
    throw new Error('Event effect window is invalid');
  }
  const values: unknown[] = [uuidOrdinal(window.id), window.scan_started_at, window.bucket_start, window.bucket_end];
  const civil = `daterange($3::date,($4::date+interval '${unit}')::date,'[)')`;
  const instant = `tstzrange($3::date::timestamp AT TIME ZONE 'UTC',
    ($4::date+interval '${unit}') AT TIME ZONE 'UTC','[)')`;
  const predicates = [
    window.interpretation === 'civil-date' ? `u.civil_effect && ${civil}`
      : `(u.instant_effect && ${instant} OR u.unsupported_effect && ${civil})`];
  // Literal status predicates let PostgreSQL select the corresponding partial
  // effect index even when a prepared statement uses a generic plan.
  if (status) predicates.push(`u.time_status='${checkedStatus(status)}'`);
  if (events) {
    if (events.length > 8) throw new Error('Event effect selection exceeds its admitted topic bound');
    predicates.push(`u.target @> ANY($${values.push(events.map(uuidOrdinal))}::numeric[])`);
  }
  if (jobId !== undefined) {
    if (!/^[1-9][0-9]*$/.test(jobId)) throw new Error('Event effect job is invalid');
    predicates.push(`u.id=$${values.push(jobId)}::bigint`);
  }
  const geometry = predicates.join(' AND ');
  return { text: `SELECT (
    EXISTS(SELECT 1 FROM access.event_temporal_window_update u WHERE u.publication_receipt IS NOT NULL
      AND ${geometry} LIMIT 1)
    OR EXISTS(SELECT 1 FROM access.event_temporal_window_update u WHERE u.publication_receipt IS NULL
      AND u.unvisited_windows @> $1::numeric AND u.existing_windows @> $2::timestamptz
      AND ${geometry} LIMIT 1)) AS pending`, values };
}

export async function hasEventEffects(client: PoolClient, window: EventEffectWindow,
  status?: Status, events?: string[], jobId?: string): Promise<boolean> {
  const { text, values } = eventEffectFence(window, status, events, jobId);
  return (await client.query<{ pending: boolean }>(text, values)).rows[0]!.pending;
}

/** Historical/unregistered targets have unknown geometry and stay conservative.
 * Registered attempts are fenced by their indexed old/new geometry instead. */
export async function eventPendingTargets(client: PoolClient, status?: Status, events?: string[]) {
  return (await client.query<{ pending: boolean; failed: boolean }>(`SELECT
    EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE NOT effect_registered
      AND ($1::text IS NULL OR time_status=$1) AND ($2::text[] IS NULL OR event=ANY($2)) LIMIT 1) AS pending,
    EXISTS(SELECT 1 FROM access.event_temporal_pending WHERE state='failed'
      AND ($1::text IS NULL OR time_status=$1) AND ($2::text[] IS NULL OR event=ANY($2)) LIMIT 1) AS failed`,
  [status ?? null, events ?? null])).rows[0]!;
}
