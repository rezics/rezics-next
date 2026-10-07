import type { PoolClient } from 'pg';

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

/** A job fences only windows whose scan started before its creation and that its bounded
 * window seek has not visited. Both old and new contributions matter. */
export function eventEffectFence(window: EventEffectWindow, status?: Status,
  events?: string[], jobId?: string): { text: string; values: unknown[] } {
  if (!window.scan_started_at) return { text: 'SELECT false AS pending', values: [] };
  const unit = window.grain === 'year' ? '1 year' : window.grain === 'month' ? '1 month'
    : window.grain === 'day' ? '1 day' : undefined;
  if (!unit || !['civil-date', 'instant'].includes(window.interpretation)) {
    throw new Error('Event effect window is invalid');
  }
  const values: unknown[] = [uuidOrdinal(window.id), window.scan_started_at, window.bucket_start, window.bucket_end];
  const civil = `daterange($3::date,($4::date+interval '${unit}')::date,'[)')`;
  const instant = `tstzrange($3::date::timestamp AT TIME ZONE 'UTC',
    ($4::date+interval '${unit}') AT TIME ZONE 'UTC','[)')`;
  const predicates = ['u.unvisited_windows @> $1::numeric', 'u.existing_windows @> $2::timestamptz',
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
  return { text: `SELECT EXISTS(SELECT 1 FROM access.event_temporal_window_update u
    WHERE ${predicates.join(' AND ')} LIMIT 1) AS pending`, values };
}

export async function hasEventEffects(client: PoolClient, window: EventEffectWindow,
  status?: Status, events?: string[], jobId?: string): Promise<boolean> {
  const { text, values } = eventEffectFence(window, status, events, jobId);
  return (await client.query<{ pending: boolean }>(text, values)).rows[0]!.pending;
}
