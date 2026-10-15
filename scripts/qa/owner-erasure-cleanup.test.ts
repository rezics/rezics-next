import { expect, spyOn, test } from 'bun:test';
import { commandAsync, type CommandPhaseSample } from './core.ts';
import { createOwnerErasureCleanupClock, OWNER_ERASURE_CLEANUP_MS, ownerErasureCleanup,
  ownerErasureCleanupShard } from './owner-erasure-cleanup.ts';

function sample(at: number, admission: CommandPhaseSample['admission'] = []): CommandPhaseSample {
  return { activeElapsedMs: at - admission.reduce((sum, span) => sum + span.end - span.start, 0),
    admissionOpen: false, observedAt: at, commandStartedAt: 0, admission };
}

test('disposal cannot spend or replenish the unchanged operation allowance', () => {
  let at = 350_000;
  const clock = createOwnerErasureCleanupClock(360_000, () => at);
  clock.observe('OWNER_ERASURE_CLEANUP BEGIN a');
  at += 60_000;
  expect(clock.sample(sample(at)).operationActiveMs).toBe(350_000);
  clock.observe('OWNER_ERASURE_CLEANUP END a');
  expect(clock.sample(sample(at + 10_000), true).reason).toBeUndefined();
  expect(clock.sample(sample(at + 10_001), true).reason).toContain('consumer exceeded 360000');
});

test('nested disposal and admission overlap count once, with an independent aggregate cleanup bound', () => {
  let at = 10;
  const clock = createOwnerErasureCleanupClock(360_000, () => at);
  clock.observe('OWNER_ERASURE_CLEANUP BEGIN a');
  at = 20;
  clock.observe('OWNER_ERASURE_CLEANUP BEGIN b');
  at = 50;
  clock.observe('OWNER_ERASURE_CLEANUP END a');
  at = 70;
  clock.observe('OWNER_ERASURE_CLEANUP END b');
  const result = clock.sample(sample(at, [{ start: 30, end: 40 }]), true);
  expect(result.cleanupMs).toBe(50);
  expect(result.operationActiveMs).toBe(10);
  clock.observe('OWNER_ERASURE_CLEANUP BEGIN c');
  at += OWNER_ERASURE_CLEANUP_MS - 50;
  expect(clock.sample(sample(at, [{ start: 30, end: 40 }])).reason).toBeUndefined();
  at++;
  expect(clock.sample(sample(at, [{ start: 30, end: 40 }])).reason).toContain('cleanup exceeded');
});

test('invalid or incomplete cleanup cannot qualify a successful command', () => {
  for (const lines of [
    ['OWNER_ERASURE_CLEANUP invalid'],
    ['OWNER_ERASURE_CLEANUP END a'],
    ['OWNER_ERASURE_CLEANUP BEGIN a', 'OWNER_ERASURE_CLEANUP BEGIN a'],
    ['OWNER_ERASURE_CLEANUP BEGIN a'],
  ]) {
    const clock = createOwnerErasureCleanupClock(360_000, () => 0);
    for (const line of lines) clock.observe(line);
    expect(clock.sample(sample(10), true).reason).toBeDefined();
  }
});

test('cleanup failure closes its clock and preserves the primary exception', async () => {
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const primary = new Error('owned resource remains');
  try {
    await expect(ownerErasureCleanup(async () => { throw primary; })).rejects.toBe(primary);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(lines[0]!.replace('BEGIN', 'END'));
  } finally { log.mockRestore(); }
});

test('only individual owner-erasure consumers use the cleanup clock', () => {
  const production = 'tests/qa/fault-recovery/owner-restore-erasure-production.test.ts';
  expect(ownerErasureCleanupShard([production])).toBe(true);
  expect(ownerErasureCleanupShard(['tests/qa/fault-recovery/owner-restore-erasure-completion.test.ts'])).toBe(true);
  expect(ownerErasureCleanupShard([])).toBe(false);
  expect(ownerErasureCleanupShard([production, 'other.test.ts'])).toBe(false);
});

test('the live command can finish bounded disposal after its operation deadline instant', async () => {
  const clock = createOwnerErasureCleanupClock(1_000);
  const result = await commandAsync(process.cwd(), 'bun', ['-e', `
    console.log('OWNER_ERASURE_CLEANUP BEGIN a');
    await Bun.sleep(1200);
    console.log('OWNER_ERASURE_CLEANUP END a');
  `], 1_000, process.env, line => clock.observe(line), { phaseDeadline: value => clock.sample(value) });
  expect(result.ok).toBe(true);
  expect(result.timedOut).toBe(false);
  expect(result.activeElapsedMs).toBeGreaterThan(1_000);
});
