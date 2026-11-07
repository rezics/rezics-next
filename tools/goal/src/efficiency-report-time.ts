const HOUR_MS = 60 * 60_000; // UTC bucket and duration unit conversion.

export type UtcHour = { start: string; end: string };

export function completedUtcHour(now: Date | number = Date.now()): UtcHour {
  const time = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(time)) throw new Error('hourly report requires a valid time');
  const endMs = Math.floor(time / HOUR_MS) * HOUR_MS;
  return { start: new Date(endMs - HOUR_MS).toISOString(), end: new Date(endMs).toISOString() };
}

export function parseUtcHour(value: string): UtcHour {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || time % HOUR_MS !== 0 || new Date(time).toISOString() !== value)
    throw new Error('bucket must be a canonical UTC hour start');
  return { start: value, end: new Date(time + HOUR_MS).toISOString() };
}

/** Return the immediately preceding completed hours, newest first. */
export function previousUtcHours(bucketValue: string, count: number): UtcHour[] {
  const bucket = parseUtcHour(bucketValue);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('hour count must be a non-negative integer');
  const start = Date.parse(bucket.start);
  return Array.from({ length: count }, (_, index) => parseUtcHour(new Date(start - (index + 1) * HOUR_MS).toISOString()));
}
