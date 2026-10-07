import { Temporal } from '@js-temporal/polyfill';
import { checkedSemanticValue, semanticValueRdf, type SemanticValue } from '../semantic/value.ts';

export type EventTimeStatus = 'actual' | 'planned';
export type EventTemporalKind = 'instant' | 'interval';
export type EventTimePrecision = 'year' | 'month' | 'day' | 'minute' | 'second';
export type EventPoint =
  | { state: 'known'; value: Extract<SemanticValue, { kind: 'temporal' }> }
  | { state: 'unknown' | 'open'; lexical: string };

export interface EventObservationIntent {
  event: string;
  timeStatus: EventTimeStatus;
  temporalKind: EventTemporalKind;
  start: EventPoint;
  end?: EventPoint;
  expectedRevisionHead: string | null;
  actingSubject: string;
  timeEvidence?: string;
}

export class InvalidEventObservationInput extends Error {}
export class UnsupportedEventTime extends Error {}

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const contentRevision = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const precisions = new Set<EventTimePrecision>(['year', 'month', 'day', 'minute', 'second']);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidEventObservationInput('event point must be an object');
  }
  return value as Record<string, unknown>;
}

function checkedPoint(value: unknown): EventPoint {
  const row = record(value);
  if (row.state === 'known') {
    if (Object.keys(row).length !== 2 || !('value' in row)) {
      throw new InvalidEventObservationInput('known event point has unsupported fields');
    }
    let temporal: SemanticValue;
    try { temporal = checkedSemanticValue(row.value); }
    catch { throw new InvalidEventObservationInput('known event point is not an admitted temporal value'); }
    if (temporal.kind !== 'temporal' || !precisions.has(temporal.precision as EventTimePrecision)) {
      throw new UnsupportedEventTime('event precision is not indexed by event-time-v1');
    }
    return { state: 'known', value: temporal as Extract<SemanticValue, { kind: 'temporal' }> };
  }
  if ((row.state === 'unknown' || row.state === 'open') && Object.keys(row).length === 2
    && typeof row.lexical === 'string' && row.lexical.length >= 1 && row.lexical.length <= 200
    && !row.lexical.includes('\u0000')) {
    return { state: row.state, lexical: row.lexical };
  }
  throw new InvalidEventObservationInput('event point state or lexical is invalid');
}

export function checkedEventObservation(value: unknown): EventObservationIntent {
  const row = record(value);
  const allowed = ['event', 'timeStatus', 'temporalKind', 'start', 'end', 'expectedRevisionHead',
    'actingSubject', 'timeEvidence'];
  if (Object.keys(row).some(key => !allowed.includes(key))
    || !nativeId.test(String(row.event ?? '')) || !nativeId.test(String(row.actingSubject ?? ''))
    || (row.expectedRevisionHead !== null && !nativeId.test(String(row.expectedRevisionHead ?? '')))
    || (row.timeEvidence !== undefined && !contentRevision.test(String(row.timeEvidence)))) {
    throw new InvalidEventObservationInput('event observation references are invalid');
  }
  if (row.timeStatus !== 'actual' && row.timeStatus !== 'planned') {
    throw new InvalidEventObservationInput('event time status is invalid');
  }
  if (row.temporalKind !== 'instant' && row.temporalKind !== 'interval') {
    throw new InvalidEventObservationInput('event temporal kind is invalid');
  }
  const start = checkedPoint(row.start);
  const end = row.end === undefined ? undefined : checkedPoint(row.end);
  if (row.temporalKind === 'instant' && (start.state !== 'known' || end !== undefined)) {
    throw new InvalidEventObservationInput('an instant has one known start point and no end');
  }
  if (row.temporalKind === 'interval' && end === undefined) {
    throw new InvalidEventObservationInput('an interval requires an explicit end state');
  }
  return { event: row.event as string, timeStatus: row.timeStatus,
    temporalKind: row.temporalKind, start, ...(end ? { end } : {}),
    expectedRevisionHead: row.expectedRevisionHead as string | null,
    actingSubject: row.actingSubject as string,
    ...(row.timeEvidence ? { timeEvidence: row.timeEvidence as string } : {}) };
}

export function eventPointRdf(point: EventPoint, allocate: () => string) {
  if (point.state !== 'known') {
    return { iri: allocate(), state: point.state, lexical: point.lexical,
      temporalNode: undefined, temporalTriples: [] as string[] };
  }
  const encoded = semanticValueRdf(point.value, allocate);
  if (!encoded.node || encoded.node.shape !== 'temporal') {
    throw new InvalidEventObservationInput('event temporal value did not produce a value node');
  }
  return { iri: allocate(), state: point.state, lexical: point.value.lexical,
    temporalNode: encoded.node.iri, temporalTriples: encoded.node.triples };
}

export interface EndpointBounds {
  state: 'known' | 'unknown' | 'open';
  precision: EventTimePrecision | null;
  civilMin: string | null;
  civilMax: string | null;
  instantMin: string | null;
  instantMax: string | null;
}

const datePattern = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/;
const offsetPattern = /(Z|[+-]\d{2}:\d{2})$/;

function civilDate(value: Extract<SemanticValue, { kind: 'temporal' }>): { min: string; max: string } {
  const match = datePattern.exec(value.lexical);
  if (!match) throw new UnsupportedEventTime('temporal lexical has no Gregorian date prefix');
  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;
  const minDate = Temporal.PlainDate.from({ year, month, day });
  const maxDate = value.precision === 'year' ? minDate.add({ years: 1 }).subtract({ days: 1 })
    : value.precision === 'month' ? minDate.add({ months: 1 }).subtract({ days: 1 }) : minDate;
  return { min: minDate.toString(), max: maxDate.toString() };
}

function instantRange(value: Extract<SemanticValue, { kind: 'temporal' }>): { min: string; max: string } | null {
  if (value.precision !== 'minute' && value.precision !== 'second') return null;
  const offset = offsetPattern.exec(value.lexical)?.[1];
  if (!offset) return null;
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value.lexical)?.[1] ?? '';
  // PostgreSQL timestamptz preserves microseconds. Do not claim exact matching
  // for finer source precision in a microsecond index.
  if (fraction.length > 6) return null;
  let start: Temporal.Instant;
  try { start = Temporal.Instant.from(value.lexical); }
  catch { return null; }
  const span = value.precision === 'minute' ? 60_000_000_000n
    : 10n ** BigInt(9 - fraction.length);
  return { min: start.toString(), max: Temporal.Instant.fromEpochNanoseconds(
    // PostgreSQL indexes microseconds; the last representable instant must not
    // round up into the following minute or second.
    start.epochNanoseconds + span - 1000n).toString() };
}

export function eventEndpointBounds(point: EventPoint, interpretation: 'civil-date' | 'instant'): EndpointBounds {
  if (point.state !== 'known') return { state: point.state, precision: null,
    civilMin: null, civilMax: null, instantMin: null, instantMax: null };
  const value = point.value;
  if (interpretation === 'civil-date') {
    const bounds = civilDate(value);
    return { state: 'known', precision: value.precision as EventTimePrecision,
      civilMin: bounds.min, civilMax: bounds.max, instantMin: null, instantMax: null };
  }
  const bounds = instantRange(value);
  if (!bounds) throw new UnsupportedEventTime('instant comparison requires a minute or second value with an offset no finer than microseconds');
  return { state: 'known', precision: value.precision as EventTimePrecision,
    civilMin: null, civilMax: null, instantMin: bounds.min, instantMax: bounds.max };
}

export function checkedDateRange(start: string, end: string, grain: 'year' | 'month' | 'day') {
  if (grain === 'day') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      throw new InvalidEventObservationInput('daily query bounds must use YYYY-MM-DD');
    }
    const first = Temporal.PlainDate.from(start), last = Temporal.PlainDate.from(end);
    const span = last.since(first, { largestUnit: 'day' }).days;
    if (span < 0 || span >= 366) throw new UnsupportedEventTime('daily query range exceeds 366 buckets');
    return { start: first.toString(), end: last.toString(), buckets: span + 1 };
  }
  if (grain === 'month') {
    if (!/^\d{4}-\d{2}$/.test(start) || !/^\d{4}-\d{2}$/.test(end)) {
      throw new InvalidEventObservationInput('monthly query bounds must use YYYY-MM');
    }
    const first = Temporal.PlainYearMonth.from(start), last = Temporal.PlainYearMonth.from(end);
    const span = (last.year - first.year) * 12 + last.month - first.month;
    if (span < 0 || span >= 120) throw new UnsupportedEventTime('monthly query range exceeds 120 buckets');
    const lastDate = last.toPlainDate({ day: 1 }).add({ months: 1 }).subtract({ days: 1 });
    return { start: `${first.toString()}-01`, end: lastDate.toString(), buckets: span + 1 };
  }
  if (!/^\d{4}$/.test(start) || !/^\d{4}$/.test(end)) {
    throw new InvalidEventObservationInput('year query bounds must use YYYY');
  }
  const first = Number(start), last = Number(end);
  if (first < 1 || last > 9999) throw new InvalidEventObservationInput('year query bound is invalid');
  const span = last - first;
  if (span < 0 || span >= 100) throw new UnsupportedEventTime('yearly query range exceeds 100 buckets');
  const lastDate = Temporal.PlainDate.from(`${end}-01-01`).add({ years: 1 }).subtract({ days: 1 });
  return { start: `${start}-01-01`, end: lastDate.toString(), buckets: span + 1 };
}

export function checkedInstantRange(start: string, end: string) {
  let first: Temporal.Instant, last: Temporal.Instant;
  try { first = Temporal.Instant.from(start); last = Temporal.Instant.from(end); }
  catch { throw new InvalidEventObservationInput('instant query bounds require exact UTC offsets'); }
  if (first.epochNanoseconds % 1000n !== 0n || last.epochNanoseconds % 1000n !== 0n) {
    throw new UnsupportedEventTime('instant query bounds must resolve to whole microseconds');
  }
  if (Temporal.Instant.compare(first, last) > 0) throw new InvalidEventObservationInput('query start follows query end');
  if (last.epochNanoseconds - first.epochNanoseconds > 366n * 86_400_000_000_000n) {
    throw new UnsupportedEventTime('instant query range exceeds 366 days');
  }
  return { start: first.toString(), end: last.toString() };
}
