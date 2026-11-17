import { AsyncLocalStorage } from 'node:async_hooks';
import { channel } from 'node:diagnostics_channel';

export const discoveryTiming = channel('rezics.search.discovery.timing');

type Interval = readonly [start: number, end: number];
type Scope = { spans: Map<string, Interval[]>; advanced: number; certified: number };
const current = new AsyncLocalStorage<Scope>();

function wall(intervals: Interval[]) {
  let total = 0;
  let end = 0;
  for (const [start, finish] of intervals.sort(([left], [right]) => left - right)) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return Math.round(total * 100) / 100;
}

export function observeDiscovery<T>(
  fields:
    | { event: 'turn' }
    | { event: 'wave'; phase: 'populating' | 'reconciling'; generation: number; selected: number },
  work: () => Promise<T>,
): Promise<T> {
  if (!discoveryTiming.hasSubscribers) return work();
  const scope: Scope = { spans: new Map(), advanced: 0, certified: 0 };
  const start = performance.now();
  return current.run(scope, async () => {
    let completed = false;
    try {
      const result = await work();
      completed = true;
      return result;
    } finally {
      const end = performance.now();
      const { spans, advanced, certified } = scope;
      discoveryTiming.publish({
        ...fields,
        completed,
        at: performance.timeOrigin + start,
        wallMs: wall([[start, end]]),
        ...(fields.event === 'wave' && { advanced, certified }),
        // Per-stage union and union across stages. Stage wall times can overlap.
        coveredMs: wall([...spans.values()].flat()),
        stages: Object.fromEntries([...spans].map(([stage, intervals]) => [stage, wall(intervals)])),
      });
    }
  });
}

export function timeDiscovery<T>(stage: string, work: () => Promise<T>): Promise<T> {
  const scope = current.getStore();
  if (!scope) return work();
  const start = performance.now();
  return work().finally(() => {
    const interval = [start, performance.now()] as const;
    const intervals = scope.spans.get(stage);
    if (intervals) intervals.push(interval);
    else scope.spans.set(stage, [interval]);
  });
}

export function discoveryFrontier(changed: number | null, certified = false) {
  const scope = current.getStore();
  if (!scope || !changed) return;
  scope.advanced += changed;
  if (certified) scope.certified += changed;
}

export function discoveryEdge(edge: string, generation: number, changed: number | null = 1) {
  if (changed === 1 && discoveryTiming.hasSubscribers)
    discoveryTiming.publish({ event: 'edge', edge, generation, at: performance.timeOrigin + performance.now() });
}
