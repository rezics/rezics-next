import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import {
  campaignEnvelopeDecision, campaignEnvelopeTimeoutReason, campaignEnvelopeWaitMs,
  campaignQualificationShard, campaignShardActiveMs, noteCampaignPreparation,
  readCampaignPreparation, runCampaignEnvelopeProcess,
  type CampaignEnvelopeInput, type CampaignEnvelopeLimits,
} from './campaign-envelope.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function clock(input: Partial<CampaignEnvelopeInput> & Pick<CampaignEnvelopeInput, 'now'>): CampaignEnvelopeInput {
  return { startedAt: 0, admissionWaitMs: 0, admissionOpen: false, runDeadline: 9_000_000, ...input };
}

test('preparation longer than the operation budget is not an operation failure', () => {
  const decision = campaignEnvelopeDecision(clock({ now: 360_001 }));
  expect(decision.phase).toBe('preparation');
  expect(decision.failure).toBeUndefined();
  expect(decision.operationActiveMs).toBeUndefined();
  expect(decision.activeRemainingMs).toBe(600_000 - 360_001);
});

test('preparation over 600000ms refuses as preparation and does not start operation', () => {
  const decision = campaignEnvelopeDecision(clock({ now: 600_001 }));
  expect(decision.failure).toBe('preparation');
  expect(decision.phase).toBe('preparation');
  expect(decision.operationActiveMs).toBeUndefined();
  expect(campaignEnvelopeWaitMs(decision)).toBe(0);
  expect(campaignEnvelopeTimeoutReason('bun', 'preparation')).toBe(
    'bun preparation exceeded 600000 ms of active work',
  );
  expect(campaignEnvelopeTimeoutReason('bun', 'preparation')).not.toContain('timed out after');
});

test('exactly 600000ms of preparation remains inside the preparation clock', () => {
  const decision = campaignEnvelopeDecision(clock({ now: 600_000 }));
  expect(decision.failure).toBeUndefined();
  expect(decision.phase).toBe('preparation');
  expect(campaignEnvelopeWaitMs(decision)).toBe(1);
});

test('operation starts only after in-budget preparation and keeps its own 360000ms', () => {
  const noted = noteCampaignPreparation({}, 200_000, { activeMs: 200_000 });
  expect(noted.preparationActiveElapsedMs).toBe(200_000);
  const inside = campaignEnvelopeDecision(clock({
    now: 200_000 + 360_000, preparationActiveElapsedMs: noted.preparationActiveElapsedMs,
    preparation: noted.preparation,
  }));
  expect(inside.phase).toBe('operation');
  expect(inside.failure).toBeUndefined();
  expect(inside.operationActiveMs).toBe(360_000);
  expect(inside.operationActiveMs).toBe(inside.activeElapsedMs - 200_000);
  const over = campaignEnvelopeDecision(clock({
    now: 200_000 + 360_001, preparationActiveElapsedMs: noted.preparationActiveElapsedMs,
    preparation: noted.preparation,
  }));
  expect(over.failure).toBe('operation');
  expect(over.operationActiveMs).toBe(360_001);
  expect(campaignEnvelopeTimeoutReason('bun', 'operation')).toBe('bun timed out after 360000 ms of active work');
  expect(campaignEnvelopeTimeoutReason('bun', 'operation')).not.toContain('preparation');
});

test('a full preparation ceiling still leaves the whole operation clock', () => {
  const noted = noteCampaignPreparation({}, 600_000, { activeMs: 600_000 });
  const ceiling = campaignShardActiveMs();
  const full = campaignEnvelopeDecision(clock({
    now: ceiling, runDeadline: ceiling + 60_000,
    preparationActiveElapsedMs: noted.preparationActiveElapsedMs, preparation: noted.preparation,
  }));
  expect(full.failure).toBeUndefined();
  expect(full.operationActiveMs).toBe(360_000);
  const past = campaignEnvelopeDecision(clock({
    now: ceiling + 1, runDeadline: ceiling + 60_000,
    preparationActiveElapsedMs: noted.preparationActiveElapsedMs, preparation: noted.preparation,
  }));
  expect(past.failure).toBe('operation');
  expect(past.phase).toBe('operation');
  const preparationOnly = campaignEnvelopeDecision(clock({ now: ceiling, runDeadline: ceiling + 60_000 }));
  expect(preparationOnly.failure).toBe('preparation');
});

test('evidence over 600000ms is a preparation failure before any operation time', () => {
  const noted = noteCampaignPreparation({}, 1_000, { activeMs: 600_001 });
  expect(noted.preparationActiveElapsedMs).toBeUndefined();
  const decision = campaignEnvelopeDecision(clock({
    now: 1_000, preparation: noted.preparation, preparationActiveElapsedMs: noted.preparationActiveElapsedMs,
  }));
  expect(decision.failure).toBe('preparation');
  expect(decision.operationActiveMs).toBeUndefined();
  expect(decision.preparationActiveMs).toBe(600_001);
});

test('a short evidence measurement cannot hide runner preparation that already exceeded 600000ms', () => {
  const noted = noteCampaignPreparation({}, 600_001, { activeMs: 100 });
  expect(noted.preparationActiveElapsedMs).toBeUndefined();
  const decision = campaignEnvelopeDecision(clock({ now: 600_001, preparation: { activeMs: 100 } }));
  expect(decision.failure).toBe('preparation');
  expect(decision.phase).toBe('preparation');
});

test('a later preparation write cannot move the operation start and hide elapsed work', () => {
  const first = noteCampaignPreparation({}, 100_000, { activeMs: 100_000 });
  const second = noteCampaignPreparation(first, 500_000, { activeMs: 100_000 });
  expect(second.preparationActiveElapsedMs).toBe(100_000);
  const decision = campaignEnvelopeDecision(clock({
    now: 500_000, preparationActiveElapsedMs: second.preparationActiveElapsedMs, preparation: second.preparation,
  }));
  expect(decision.operationActiveMs).toBe(400_000);
  expect(decision.failure).toBe('operation');
});

test('admission wait is excluded from active time and does not move the run deadline', () => {
  const paused = campaignEnvelopeDecision(clock({
    now: 700_000, admissionWaitMs: 200_000, runDeadline: 800_000,
  }));
  expect(paused.activeElapsedMs).toBe(500_000);
  expect(paused.phase).toBe('preparation');
  expect(paused.failure).toBeUndefined();
  expect(paused.wallRemainingMs).toBe(100_000);
  const overrun = campaignEnvelopeDecision(clock({
    now: 900_001, admissionWaitMs: 200_000, runDeadline: 2_000_000,
  }));
  expect(overrun.activeElapsedMs).toBe(700_001);
  expect(overrun.failure).toBe('preparation');
  const deadline = campaignEnvelopeDecision(clock({
    now: 800_000, admissionWaitMs: 800_000, runDeadline: 800_000,
  }));
  expect(deadline.activeElapsedMs).toBe(0);
  expect(deadline.wallRemainingMs).toBe(0);
  expect(deadline.failure).toBe('deadline');
  expect(campaignEnvelopeTimeoutReason('bun', 'deadline')).toBe('bun reached its run deadline');
});

test('an open admission pauses the active clock and still honors the run deadline', () => {
  const paused = campaignEnvelopeDecision(clock({
    now: 700_000, admissionOpen: true, runDeadline: 800_000,
  }));
  expect(paused.failure).toBeUndefined();
  expect(paused.activeRemainingMs).toBe(Number.POSITIVE_INFINITY);
  expect(campaignEnvelopeWaitMs(paused)).toBe(100_000);
  const wall = campaignEnvelopeDecision(clock({
    now: 800_000, admissionOpen: true, runDeadline: 800_000,
  }));
  expect(wall.failure).toBe('deadline');
  expect(campaignEnvelopeWaitMs(wall)).toBe(0);
  const revealed = campaignEnvelopeDecision(clock({
    now: 1_000, admissionOpen: true, preparation: { activeMs: 600_001 },
  }));
  expect(revealed.failure).toBe('preparation');
});

test('the run deadline wins when preparation has also overrun', () => {
  const decision = campaignEnvelopeDecision(clock({ now: 600_001, runDeadline: 600_001 }));
  expect(decision.failure).toBe('deadline');
  expect(decision.activeElapsedMs).toBe(600_001);
});

test('work after preparation is charged whole, including time that is only cleanup', () => {
  const noted = noteCampaignPreparation({}, 50_000, { activeMs: 50_000 });
  const cleanupIncluded = campaignEnvelopeDecision(clock({
    now: 50_000 + 360_001, preparationActiveElapsedMs: noted.preparationActiveElapsedMs,
    preparation: noted.preparation,
  }));
  expect(cleanupIncluded.operationActiveMs).toBe(360_001);
  expect(cleanupIncluded.failure).toBe('operation');
});

test('invalid clocks and an operation start without preparation evidence are refused', () => {
  expect(() => campaignEnvelopeDecision(clock({ now: Number.NaN }))).toThrow('Invalid campaign envelope clock');
  expect(() => campaignEnvelopeDecision(clock({ now: 10, admissionWaitMs: -1 }))).toThrow('Invalid campaign envelope clock');
  expect(() => campaignEnvelopeDecision(clock({ now: 10, admissionWaitMs: 11 }))).toThrow('Invalid campaign envelope clock');
  expect(() => campaignEnvelopeDecision(clock({
    now: 10, preparationActiveElapsedMs: 11, preparation: { activeMs: 1 },
  }))).toThrow('Invalid campaign envelope clock');
  expect(() => campaignEnvelopeDecision(clock({
    now: 10, preparationActiveElapsedMs: 1,
  }))).toThrow('Invalid campaign envelope clock');
  expect(() => campaignEnvelopeDecision(clock({ now: 10 }), { preparationActiveMs: 0, operationActiveMs: 1 }))
    .toThrow('Invalid campaign envelope budget');
});

test('incomplete preparation evidence does not start the operation clock', () => {
  for (const parsed of [null, {}, { preparation: {} }, { preparation: { activeMs: -1 } },
    { preparation: { activeMs: Number.NaN } }, { preparation: { activeMs: '600000' } }, { phases: {} }]) {
    expect(readCampaignPreparation(parsed)).toBeUndefined();
  }
  const evidence = readCampaignPreparation({ preparation: { activeMs: 12 }, copies: [] });
  expect(evidence).toEqual({ activeMs: 12 });
  const noted = noteCampaignPreparation({}, 12, evidence);
  expect(campaignEnvelopeDecision(clock({
    now: 12, preparationActiveElapsedMs: noted.preparationActiveElapsedMs, preparation: noted.preparation,
  })).phase).toBe('operation');
});

test('only the campaign qualification file receives the split shard', () => {
  expect(campaignQualificationShard([
    'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts',
  ])).toBe(true);
  expect(campaignQualificationShard([
    'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts',
    'tests/qa/fault-recovery/search-ops-lock.test.ts',
  ])).toBe(false);
  expect(campaignQualificationShard(['tests/qa/fault-recovery/search-ops-lock.test.ts'])).toBe(false);
  expect(campaignShardActiveMs()).toBe(960_000);
  expect(campaignShardActiveMs()).toBeGreaterThan(360_000);
});

test('a wall deadline refuses while both phase budgets remain', async () => {
  const run = await runScript('await Bun.sleep(30_000)\n', {
    preparationActiveMs: 20_000, operationActiveMs: 20_000,
  }, 400);
  expect(run.envelopeFailure).toBe('deadline');
  expect(run.output).toContain('reached its run deadline');
  expect(run.output).not.toContain('preparation exceeded');
  expect(run.activeElapsedMs).toBeLessThan(2_000);
}, 8_000);

test('preparation longer than the operation budget still reaches operation', async () => {
  const run = await runScript(`await Bun.sleep(1_600)
await Bun.write(process.env.EVIDENCE, JSON.stringify({ preparation: { activeMs: 1_600 } }))
await Bun.sleep(250)
`, { preparationActiveMs: 8_000, operationActiveMs: 1_200 });
  expect(run.ok).toBe(true);
  expect(run.envelopeFailure).toBeUndefined();
  expect(run.activeElapsedMs).toBeGreaterThan(1_200);
  expect(run.report.preparationActiveMs).toBeGreaterThan(1_200);
  expect(run.report.operationActiveMs ?? 0).toBeLessThanOrEqual(1_200);
  expect(run.report.phase).toBe('operation');
}, 8_000);

test('a preparation overrun is refused before operation starts', async () => {
  const run = await runScript('await Bun.sleep(30_000)\n', {
    preparationActiveMs: 400, operationActiveMs: 400,
  });
  expect(run.envelopeFailure).toBe('preparation');
  expect(run.report.operationActiveMs).toBeUndefined();
  expect(run.report.phase).toBe('preparation');
  expect(run.output).toContain('preparation exceeded 400 ms of active work');
  expect(run.output).not.toContain('timed out after');
  expect(run.activeElapsedMs).toBeLessThan(2_000);
}, 8_000);

test('operation overrun after preparation uses the operation clock', async () => {
  const run = await runScript(`await Bun.write(process.env.EVIDENCE, JSON.stringify({ preparation: { activeMs: 1 } }))
await Bun.sleep(30_000)
`, { preparationActiveMs: 5_000, operationActiveMs: 350 });
  expect(run.envelopeFailure).toBe('operation');
  expect(run.output).toContain('timed out after 350 ms of active work');
  expect(run.output).not.toContain('preparation exceeded');
  expect(run.report.operationActiveMs).toBeGreaterThan(350);
  expect(run.report.preparationActiveMs ?? 0).toBeLessThan(350);
}, 8_000);

test('evidence of preparation over 600000ms refuses on the real process clock', async () => {
  const run = await runScript(`await Bun.write(process.env.EVIDENCE, JSON.stringify({ preparation: { activeMs: 600001 } }))
await Bun.sleep(30_000)
`);
  expect(run.envelopeFailure).toBe('preparation');
  expect(run.report.operationActiveMs).toBeUndefined();
  expect(run.report.evidencePreparationActiveMs).toBe(600_001);
  expect(run.output).toContain('preparation exceeded 600000 ms of active work');
  expect(run.elapsedMs).toBeLessThan(2_000);
}, 8_000);

test('admission wait is not charged to the active clock of the running process', async () => {
  const run = await runScript(`console.log('QA_MEMORY_WAIT_BEGIN 9-1')
await Bun.sleep(800)
console.log('QA_MEMORY_WAIT_END 9-1 800')
`, { preparationActiveMs: 400, operationActiveMs: 400 });
  expect(run.ok).toBe(true);
  expect(run.envelopeFailure).toBeUndefined();
  expect(run.admissionWaitMs).toBeGreaterThanOrEqual(700);
  expect(run.activeElapsedMs).toBeLessThan(400);
}, 8_000);

test('an open admission does not hold the process past the run deadline', async () => {
  const run = await runScript(`console.log('QA_MEMORY_WAIT_BEGIN 9-1')
await Bun.sleep(30_000)
`, { preparationActiveMs: 20_000, operationActiveMs: 20_000 }, 350);
  expect(run.envelopeFailure).toBe('deadline');
  expect(run.output).not.toContain('preparation exceeded');
  expect(run.elapsedMs).toBeLessThan(2_000);
}, 8_000);

async function runScript(script: string, limits?: CampaignEnvelopeLimits, deadlineMs = 30_000) {
  mkdirSync(join(import.meta.dir, '../../.temp'), { recursive: true });
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/campaign-envelope-'));
  scratch.push(directory);
  const evidencePath = join(directory, 'evidence.json');
  writeFileSync(join(directory, 'child.ts'), script);
  return runCampaignEnvelopeProcess({
    root: directory, command: 'bun', args: ['child.ts'],
    env: { ...process.env, EVIDENCE: evidencePath },
    evidencePath, runDeadline: Date.now() + deadlineMs, limits,
  });
}
