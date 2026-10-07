import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RecoveryBudget } from '../../../scripts/ops/recovery-set.ts';
import { GiB } from '../../../scripts/qa/memory-admission.ts';

const scratch = resolve(import.meta.dir, '../../../.temp');
mkdirSync(scratch, { recursive: true });

test('recovery evidence accepts four active minutes after five minutes of memory admission', async () => {
  const directory = mkdtempSync(join(scratch, 'recovery-evidence-timing-'));
  let at = 0;
  const now = () => at;
  const budget = new RecoveryBudget(now);
  try {
    await budget.phase('start-held', () => budget.startup({
      REZICS_STACK_PROFILE: 'qa', REZICS_QA_MEMORY_DEADLINE: '1000000',
    }, () => { at += 240_000; }, {
      lockFile: join(directory, 'mutex.sqlite'), now, pollMs: 150_000,
      sleep: async ms => { at += ms; }, announce: () => {},
      read: async () => ({ vmTotal: 24 * GiB, vmUsed: at < 300_000 ? 24 * GiB : 0,
        hostAvailable: 20 * GiB }),
    }));
    expect(at).toBe(540_000);
    expect(budget.timing()).toEqual({
      elapsedMs: 240_000, admissionWaitMs: 300_000, budgetMs: 600_000,
    });
    expect(budget.phases).toEqual({ memoryAdmission: 300_000, 'start-held': 240_000 });
    expect(budget.remaining()).toBe(360_000);
    await expect(budget.phase('verification', () => { at += 360_001; }))
      .rejects.toThrow('exceeded its 600-second budget');
    expect(budget.timing()).toEqual({
      elapsedMs: 600_001, admissionWaitMs: 300_000, budgetMs: 600_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recovery evidence reports zero admission wait for ordinary active work', async () => {
  let at = 10_000;
  const budget = new RecoveryBudget(() => at);
  await budget.phase('checksums', () => { at += 30_000; });
  expect(budget.timing()).toEqual({
    elapsedMs: 30_000, admissionWaitMs: 0, budgetMs: 600_000,
  });
});
