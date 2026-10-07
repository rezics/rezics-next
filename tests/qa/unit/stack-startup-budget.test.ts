import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startDevCompose } from '../../../scripts/dev/cli.ts';
import { startSearchFuseki } from '../../../scripts/operations/search-startup.ts';
import { GiB } from '../../../scripts/qa/memory-admission.ts';

const root = resolve(import.meta.dir, '../../..');
const scratch = join(root, '.temp');
mkdirSync(scratch, { recursive: true });
const plenty = { vmTotal: 24 * GiB, vmUsed: 0, hostAvailable: 20 * GiB };

for (const [name, start, readinessMs] of [
  ['dev CLI', startDevCompose, 180_000],
  ['search rebuild', startSearchFuseki, 300_000],
] as const) {
  test(`${name} waits past its readiness budget and gives Compose the full timeout after admission`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-startup-budget-'));
    let now = 0;
    const readings: number[] = [];
    try {
      const result = await start(root, { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '900000' },
        'qa', timeout => {
          expect(now).toBe(400_000);
          expect(timeout).toBe(readinessMs);
          now += timeout;
          return 'ready';
        }, { lockFile: join(dir, 'mutex.sqlite'), now: () => now, pollMs: 400_000,
          sleep: async ms => { now += ms; }, announce: () => {},
          read: async remaining => {
            readings.push(remaining);
            return now === 0 ? { ...plenty, vmUsed: plenty.vmTotal } : plenty;
          } });
      expect(result).toBe('ready');
      expect(readings).toEqual([900_000, 500_000]);
      expect(now).toBe(400_000 + readinessMs);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${name} stops admission at the parent run deadline without starting Compose`, async () => {
    const dir = mkdtempSync(join(scratch, 'qa-startup-deadline-'));
    let now = 0, starts = 0;
    try {
      await expect(start(root, { REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '900000' },
        'qa', () => { starts++; }, { lockFile: join(dir, 'mutex.sqlite'), now: () => now,
          pollMs: 400_000, sleep: async ms => { now += ms; }, announce: () => {},
          read: async () => ({ ...plenty, vmUsed: plenty.vmTotal }) })).rejects.toThrow('Memory admission deadline');
      expect(now).toBe(900_000);
      expect(starts).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
