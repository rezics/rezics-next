import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { burnPerHour } from '../src/allowance.ts';
import { loadSettings } from '../src/settings.ts';
import type { Pool, PoolReading } from '../src/types.ts';
import { readPool } from '../src/usage.ts';

const minute = 60_000;
const hour = 60 * minute;
const weekMinutes = 7 * 24 * 60;

export function hourlyAllowance(pool: Pool, current: PoolReading, history: readonly PoolReading[], now: number) {
  const observed = current.observedAt ? Date.parse(current.observedAt) : NaN;
  const window = current.windows.find((sample) => sample.minutes === weekMinutes);
  if (!window || !Number.isFinite(observed) || observed > now + minute || now - observed > 15 * minute)
    return { used: null, rate: null };
  if (window.resetsAt === null) return { used: window.usedPercent, rate: null };
  const currentWeek = { ...current, windows: [window] };
  const previous = history
    .filter((reading) => {
      if (reading.allowanceKey !== pool.allowanceKey || !reading.observedAt) return false;
      const age = observed - Date.parse(reading.observedAt);
      return (
        age >= 45 * minute &&
        age <= 75 * minute &&
        reading.windows.some(
          (old) =>
            old.minutes === window.minutes &&
            old.resetsAt !== null &&
            Math.abs(old.resetsAt - window.resetsAt!) <= minute &&
            old.usedPercent <= window.usedPercent,
        )
      );
    })
    .sort(
      (a, b) =>
        Math.abs(observed - Date.parse(a.observedAt!) - hour) - Math.abs(observed - Date.parse(b.observedAt!) - hour),
    )[0];
  return {
    used: window.usedPercent,
    rate: previous ? burnPerHour(currentWeek, [previous], { now: observed, spanMs: 75 * minute }) : null,
  };
}

if (import.meta.main) {
  const settings = loadSettings();
  const now = Date.now();
  const stored = JSON.parse(readFileSync(join(settings.stateDirectory, 'pool-readings.json'), 'utf8')) as {
    readings: PoolReading[];
  };
  console.log(
    JSON.stringify(
      Object.fromEntries(
        settings.pools
          .filter((pool) => ['codex', 'codex-1'].includes(pool.name))
          .map((pool) => [
            pool.name,
            {
              ...hourlyAllowance(pool, readPool(pool, now), stored.readings, now),
              ceiling: pool.policy.maxBurnPerHour ?? null,
            },
          ]),
      ),
    ),
  );
}
