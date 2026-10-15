import { randomUUID } from 'node:crypto';
import type { CommandPhaseSample } from './core.ts';

/** Cleanup owns the same two-minute bound as a QA stack reset. It cannot spend
 * or replenish the consumer's unchanged operation allowance. */
export const OWNER_ERASURE_CLEANUP_MS = 120_000;
const prefix = 'OWNER_ERASURE_CLEANUP';
const consumers = new Set([
  'tests/qa/fault-recovery/owner-restore-erasure-completion.test.ts',
  'tests/qa/fault-recovery/owner-restore-erasure-production.test.ts',
]);
export function ownerErasureCleanupShard(files: readonly string[]): boolean {
  return files.length === 1 && consumers.has(files[0]!);
}

export async function ownerErasureCleanup<T>(run: () => Promise<T>): Promise<T> {
  const id = randomUUID();
  console.log(`${prefix} BEGIN ${id}`);
  try { return await run(); }
  finally { console.log(`${prefix} END ${id}`); }
}

export function createOwnerErasureCleanupClock(operationMs: number, now: () => number = Date.now) {
  const spans: { start: number; end?: number }[] = [];
  const active = new Map<string, number>();
  let invalid = false;
  return {
    observe(line: string) {
      if (!line.startsWith(prefix)) return;
      const match = /^OWNER_ERASURE_CLEANUP (BEGIN|END) ([a-z0-9-]+)$/.exec(line);
      if (!match) { invalid = true; return; }
      const id = match[2]!;
      if (match[1] === 'BEGIN') {
        if (active.has(id)) { invalid = true; return; }
        if (!active.size) spans.push({ start: now() });
        active.set(id, 1);
      } else {
        if (!active.delete(id)) { invalid = true; return; }
        if (!active.size) spans.at(-1)!.end = now();
      }
    },
    sample(sample: CommandPhaseSample, final = false) {
      let cleanupMs = 0;
      for (const span of spans) {
        const start = Math.max(span.start, sample.commandStartedAt);
        const end = Math.min(span.end ?? sample.observedAt, sample.observedAt);
        let duration = Math.max(0, end - start);
        for (const wait of sample.admission)
          duration -= Math.max(0, Math.min(end, wait.end) - Math.max(start, wait.start));
        cleanupMs += Math.max(0, duration);
      }
      const operationActiveMs = Math.max(0, sample.activeElapsedMs - cleanupMs);
      const reason = invalid ? 'owner-erasure cleanup protocol is invalid'
        : final && active.size ? 'owner-erasure cleanup did not complete'
        : cleanupMs > OWNER_ERASURE_CLEANUP_MS ? 'owner-erasure cleanup exceeded 120s of active work'
        : operationActiveMs > operationMs ? `owner-erasure consumer exceeded ${operationMs} ms of active work`
        : undefined;
      return { cleanupMs, operationActiveMs, cleanupOpen: active.size > 0,
        activeLimitMs: active.size ? sample.activeElapsedMs + Math.max(0, OWNER_ERASURE_CLEANUP_MS - cleanupMs)
          : operationMs + cleanupMs,
        ...(reason ? { reason } : {}) };
    },
  };
}
