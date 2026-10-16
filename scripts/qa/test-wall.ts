import { admissionIntervalMs } from './core.ts';

type Interval = { start: number; end: number };

/** Charge concurrent tests once, excluding separately bounded preparation
 * between shards and admission waits within the actual test intervals. */
export function activeTestWallMs(tests: readonly Interval[], waits: readonly Interval[]): number {
  const spans = tests.filter(span => span.end > span.start).sort((a, b) => a.start - b.start);
  let total = 0;
  let current: Interval | undefined;
  const charge = (span: Interval) => span.end - span.start - admissionIntervalMs(waits, span.start, span.end);
  for (const span of spans) {
    if (current && span.start <= current.end) current.end = Math.max(current.end, span.end);
    else {
      if (current) total += charge(current);
      current = { ...span };
    }
  }
  return total + (current ? charge(current) : 0);
}
