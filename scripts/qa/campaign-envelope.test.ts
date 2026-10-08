import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { commandAsync } from './core.ts';
import { cleanupQaStacks } from './stack-ownership.ts';
import { projectName } from '../dev/config.ts';
import {
  campaignCommandAccepted, campaignPhaseDeadline, campaignQualificationShard, campaignShardActiveMs,
  childStackCleanupCommand, classifyCampaignEvidence, currentSuppliedRunIds, openCampaignEvidence,
  phaseDeadlineArm,
  type CampaignEvidenceRead, type CampaignEvidenceState, type CommandPhaseSample,
} from './campaign-envelope.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sample(activeElapsedMs: number, admissionOpen = false): CommandPhaseSample {
  return { activeElapsedMs, admissionOpen };
}

function ready(reportedActiveMs: number, boundaryActiveMs: number): CampaignEvidenceState {
  return { kind: 'ready', reportedActiveMs, boundaryActiveMs };
}

test('preparation past the operation budget is still preparation', () => {
  const decision = campaignPhaseDeadline(sample(360_001), { kind: 'absent' });
  expect(decision.phase).toBe('preparation');
  expect(decision.reason).toBeUndefined();
  expect(decision.activeLimitMs).toBe(600_000);
  expect(campaignShardActiveMs()).toBeGreaterThan(decision.activeLimitMs);
});

test('preparation past 600000ms is refused as preparation and not as a 360000ms operation timeout', () => {
  const decision = campaignPhaseDeadline(sample(600_001), { kind: 'absent' });
  expect(decision.phase).toBe('preparation');
  expect(decision.reason).toBe('bun preparation exceeded 600000 ms of active work');
  expect(decision.reason).not.toContain('timed out after 360000');
  const ceiling = campaignPhaseDeadline(sample(700_000), { kind: 'absent' });
  expect(ceiling.reason).toContain('preparation exceeded');
  expect(700_000).toBeLessThan(campaignShardActiveMs());
});

test('exactly 600000ms of preparation and exactly 360000ms of operation are inside their clocks', () => {
  expect(campaignPhaseDeadline(sample(600_000), { kind: 'absent' }).reason).toBeUndefined();
  const operation = campaignPhaseDeadline(sample(200_000 + 360_000), ready(200_000, 200_000));
  expect(operation.phase).toBe('operation');
  expect(operation.reason).toBeUndefined();
  expect(operation.activeLimitMs).toBe(200_000 + 360_000);
});

test('operation starts at the measured preparation boundary and refuses its own overrun', () => {
  const inside = campaignPhaseDeadline(sample(100_000), ready(100_000, 100_000));
  expect(inside.phase).toBe('operation');
  expect(inside.reason).toBeUndefined();
  const over = campaignPhaseDeadline(sample(100_000 + 360_001), ready(100_000, 100_000));
  expect(over.phase).toBe('operation');
  expect(over.reason).toBe('bun timed out after 360000 ms of active work');
  expect(sample(100_000 + 360_001).activeElapsedMs - 100_000).toBe(360_001);
});

test('reported preparation and the parent boundary are separate ceilings', () => {
  const reported = campaignPhaseDeadline(sample(1_000), ready(600_001, 1_000));
  expect(reported.phase).toBe('preparation');
  expect(reported.reason).toContain('preparation exceeded 600000');
  const parent = campaignPhaseDeadline(sample(600_001), ready(100, 600_001));
  expect(parent.phase).toBe('preparation');
  expect(parent.reason).toContain('preparation exceeded 600000');
  const both = campaignPhaseDeadline(sample(500_000), ready(100_000, 500_000));
  expect(both.phase).toBe('operation');
  expect(both.activeLimitMs).toBe(500_000 + 360_000);
  expect(both.activeLimitMs).not.toBe(100_000 + 360_000);
  expect(both.reason).toBeUndefined();
});

test('an open admission does not spend the active clock, and a run deadline stays outside it', () => {
  const paused = campaignPhaseDeadline(sample(700_000, true), { kind: 'absent' });
  expect(paused.reason).toBeUndefined();
  expect(paused.phase).toBe('preparation');
  const revealed = campaignPhaseDeadline(sample(1_000, true), ready(600_001, 1_000));
  expect(revealed.reason).toContain('preparation exceeded 600000');
  expect(() => campaignPhaseDeadline(sample(Number.NaN), { kind: 'absent' })).toThrow('Invalid campaign envelope clock');
});

test('stale, malformed, and foreign evidence do not open the operation clock', () => {
  const projectRunId = '20261008t000000-aaaaaa-f1';
  const base = {
    commandStartedAt: 1_000, projectRunId, activeElapsedMs: 50_000, observedAt: 51_000,
  };
  expect(classifyCampaignEvidence({
    ...base, parsed: { preparation: { activeMs: 10 } }, readError: false, modifiedAt: 999,
  }).kind).toBe('refused');
  expect(classifyCampaignEvidence({
    ...base, parsed: { runId: 'other-run', preparation: { activeMs: 10 } }, readError: false, modifiedAt: 50_000,
  }).kind).toBe('refused');
  expect(classifyCampaignEvidence({
    ...base, parsed: { preparation: { activeMs: Number.NaN } }, readError: false, modifiedAt: 50_000,
  }).kind).toBe('refused');
  expect(classifyCampaignEvidence({
    ...base, parsed: undefined, readError: true, modifiedAt: 50_000,
  }).kind).toBe('ignored');
  const fresh = classifyCampaignEvidence({
    ...base, parsed: { projectRunId, preparation: { activeMs: 40_000 } }, readError: false, modifiedAt: 50_000,
  });
  expect(fresh.kind).toBe('ready');
  if (fresh.kind === 'ready') {
    expect(fresh.reportedActiveMs).toBe(40_000);
    expect(fresh.boundaryActiveMs).toBe(50_000);
    expect(fresh.boundaryActiveMs).not.toBe(40_000);
    expect(fresh.boundaryActiveMs).not.toBe(49_000);
  }
  const wallGap = classifyCampaignEvidence({
    ...base, parsed: { projectRunId, preparation: { activeMs: 40_000 } }, readError: false,
    modifiedAt: 50_000, observedAt: 550_000, activeElapsedMs: 50_000,
  });
  expect(wallGap.kind).toBe('ready');
  if (wallGap.kind === 'ready') expect(wallGap.boundaryActiveMs).toBe(50_000);
  expect(campaignPhaseDeadline(sample(50_000), { kind: 'refused' }).phase).toBe('preparation');
});

test('a clean exit without preparation evidence is not an operation success', () => {
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: { kind: 'absent' }, sample: sample(20),
  })).toEqual({ ok: false, failure: 'missing-preparation' });
  expect(campaignCommandAccepted({
    exitOk: false, timedOut: false, evidence: { kind: 'absent' }, sample: sample(20),
  })).toEqual({ ok: false });
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: ready(10, 10), sample: sample(10),
  }).ok).toBe(true);
  expect(campaignQualificationShard([
    'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts',
  ])).toBe(true);
  expect(campaignQualificationShard([
    'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts',
    'tests/qa/fault-recovery/search-ops-lock.test.ts',
  ])).toBe(false);
});

test('commandAsync still times out, pauses admission, and keeps the run deadline', async () => {
  const timed = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 350);
  expect(timed.timedOut).toBe(true);
  expect(timed.ok).toBe(false);
  expect(timed.output).toContain('timed out after 350 ms of active work');
  expect(timed.output).not.toContain('preparation exceeded');
  const admitted = await commandAsync(import.meta.dir, 'bun', ['-e', `
    console.log('QA_MEMORY_WAIT_BEGIN 4-1');
    await Bun.sleep(700);
    console.log('QA_MEMORY_WAIT_END 4-1 700');
  `], 400, process.env, undefined, { runDeadline: Date.now() + 30_000 });
  expect(admitted.ok).toBe(true);
  expect(admitted.admissionWaitMs).toBeGreaterThanOrEqual(600);
  expect(admitted.activeElapsedMs).toBeLessThan(400);
  const deadline = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 20_000,
    process.env, undefined, { runDeadline: Date.now() + 350 });
  expect(deadline.timedOut).toBe(true);
  expect(deadline.output).toContain('reached its run deadline');
  expect(deadline.output).not.toContain('preparation exceeded');
}, 15_000);

test('filesystem-marker unit, not a Docker proof: after a real timeout a current supplied id keeps its marker and a runner-created id is reset', async () => {
  // Markers are files in a temp directory. This does not start Docker or destroy volumes, containers, or private bytes.
  const timed = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 350);
  expect(timed.timedOut).toBe(true);
  expect(timed.output).toContain('timed out after 350 ms of active work');
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/campaign-cleanup-'));
  scratch.push(directory);
  const suppliedId = 'fixture-supplied-a';
  const createdId = 'fixture-created-b';
  const supplied = currentSuppliedRunIds(`${suppliedId},not-a-run,${suppliedId}`);
  expect(supplied.has(suppliedId)).toBe(true);
  expect(supplied.has('not-a-run')).toBe(false);
  expect(childStackCleanupCommand(['--profile', 'qa', '--run-id', suppliedId], supplied)).toBe('stack:down');
  expect(childStackCleanupCommand(['--profile', 'qa', '--run-id', createdId], supplied)).toBe('stack:reset');
  expect(childStackCleanupCommand(['--profile', 'qa', '--run-id', 'fixture-other-c'], supplied)).toBe('stack:reset');
  expect(childStackCleanupCommand(['--profile', 'qa'], supplied)).toBe('stack:reset');
  expect(childStackCleanupCommand(['--profile', 'qa', '--run-id', 'not-a-run'], currentSuppliedRunIds('not-a-run'))).toBe('stack:reset');
  expect(currentSuppliedRunIds(undefined).size).toBe(0);
  const volumes = new Map<string, string>();
  for (const id of [suppliedId, createdId]) {
    const volume = join(directory, id);
    mkdirSync(volume);
    writeFileSync(join(volume, 'marker'), id);
    volumes.set(id, volume);
    const args = ['--profile', 'qa', '--run-id', id];
    writeFileSync(join(directory, `${projectName({ profile: 'qa', runId: id })}.json`), JSON.stringify(args));
  }
  const failures = await cleanupQaStacks(directory, async args => {
    const command = childStackCleanupCommand(args, supplied);
    const id = args[args.indexOf('--run-id') + 1]!;
    if (command === 'stack:reset') rmSync(volumes.get(id)!, { recursive: true, force: true });
    if (id === createdId) throw new Error(`${command} ${id} failed`);
  });
  expect(failures).toEqual([expect.stringContaining('stack:reset fixture-created-b failed')]);
  expect(await Bun.file(join(volumes.get(suppliedId)!, 'marker')).exists()).toBe(true);
  expect(await Bun.file(join(volumes.get(createdId)!, 'marker')).exists()).toBe(false);
  const kept = join(directory, `${projectName({ profile: 'qa', runId: createdId })}.json`);
  const released = join(directory, `${projectName({ profile: 'qa', runId: suppliedId })}.json`);
  expect(await Bun.file(kept).exists()).toBe(true);
  expect(await Bun.file(released).exists()).toBe(false);
}, 10_000);

function evidenceRead(input: {
  path: string;
  projectRunId: string;
  commandStartedAt: number;
  activeElapsedMs: number;
}): CampaignEvidenceRead {
  let parsed: unknown, readError = false;
  try { parsed = JSON.parse(readFileSync(input.path, 'utf8')); }
  catch { readError = true; }
  return {
    parsed, readError, modifiedAt: statSync(input.path).mtimeMs, commandStartedAt: input.commandStartedAt,
    projectRunId: input.projectRunId, activeElapsedMs: input.activeElapsedMs, observedAt: Date.now(),
  };
}

test('repeated qualification writes keep the first preparation boundary', async () => {
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/campaign-evidence-'));
  scratch.push(directory);
  const evidencePath = join(directory, 'erasure-campaign-qualification.json');
  const projectRunId = '20261008t000000-bbbbbb-f1';
  const commandStartedAt = Date.now() - 5_000;
  const watch = openCampaignEvidence();
  const preparation = { activeMs: 180_000 };
  const look = (activeElapsedMs: number, when?: 'poll' | 'final') => watch.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs,
  }), when);
  writeFileSync(evidencePath, JSON.stringify({ phases: { 'copy-0-seed': 4 } }));
  expect(look(10_000).kind).toBe('absent');
  writeFileSync(evidencePath, JSON.stringify({ preparation, phases: {} }));
  const first = look(180_000);
  expect(first).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: 180_000 });
  await Bun.sleep(30);
  writeFileSync(evidencePath, JSON.stringify({
    preparation, phases: { 'copy-compact-index-0': 1 },
    phaseDetails: { 'copy-compact-index-0': { status: 'running' } },
  }));
  writeFileSync(evidencePath, JSON.stringify({
    preparation, phases: { 'copy-compact-index-0': 135_653 },
    phaseDetails: { 'copy-compact-index-0': { status: 'succeeded' } },
  }));
  const during = look(180_000 + 360_001);
  expect(during).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: 180_000 });
  const refused = campaignPhaseDeadline(sample(180_000 + 360_001), during);
  expect(refused.phase).toBe('operation');
  expect(refused.reason).toBe('bun timed out after 360000 ms of active work');
  expect(refused.reason).not.toContain('preparation exceeded');
  writeFileSync(evidencePath, '{');
  const torn = look(180_000 + 400_000);
  expect(torn).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: 180_000 });
  expect(campaignPhaseDeadline(sample(180_000 + 360_001), torn).reason).toBe(
    'bun timed out after 360000 ms of active work');
  writeFileSync(evidencePath, JSON.stringify({
    preparation, completedAt: new Date().toISOString(), fixtureBackupRetained: 'kept',
  }));
  const finalWrite = look(180_000 + 20_000, 'final');
  expect(finalWrite).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: 180_000 });
  expect(watch.proof?.boundaryActiveMs).toBe(180_000);
  expect(campaignPhaseDeadline(sample(180_000 + 360_001), finalWrite).reason).toBe(
    'bun timed out after 360000 ms of active work');
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: finalWrite, sample: sample(180_000 + 360_001),
  })).toEqual({ ok: false, failure: 'operation' });
  writeFileSync(evidencePath, '{');
  const corrupt = look(700_000, 'final');
  expect(corrupt.kind).toBe('contradicted');
  const corruptDecision = campaignPhaseDeadline(sample(700_000), corrupt);
  expect(corruptDecision.reason).toBe('bun campaign evidence was refused');
  expect(corruptDecision.reason).not.toContain('preparation exceeded');
  expect(corruptDecision.reason).not.toContain('timed out after 360000');
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation }));
  expect(look(180_000).kind).toBe('contradicted');
  expect(watch.proof).toEqual({ reportedActiveMs: 180_000, boundaryActiveMs: 180_000 });
}, 10_000);

test('a later foreign run or a changed preparation proof refuses and leaves the first boundary', () => {
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/campaign-evidence-'));
  scratch.push(directory);
  const evidencePath = join(directory, 'erasure-campaign-qualification.json');
  const projectRunId = '20261008t000000-cccccc-f1';
  const commandStartedAt = Date.now() - 1_000;
  const watch = openCampaignEvidence();
  const preparation = { activeMs: 600_001 };
  const look = (activeElapsedMs: number) => watch.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs,
  }));
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation }));
  const first = look(100_000);
  expect(first.kind).toBe('ready');
  expect(campaignPhaseDeadline(sample(100_000), first).reason).toContain('preparation exceeded 600000');
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation, completedAt: new Date().toISOString() }));
  const rewritten = look(590_000);
  expect(rewritten).toEqual({ kind: 'ready', reportedActiveMs: 600_001, boundaryActiveMs: 100_000 });
  expect(campaignPhaseDeadline(sample(590_000), rewritten).reason).toContain('preparation exceeded 600000');
  writeFileSync(evidencePath, JSON.stringify({ preparation: { activeMs: 1 }, completedAt: new Date().toISOString() }));
  expect(look(120_000).kind).toBe('contradicted');
  expect(watch.proof).toEqual({ reportedActiveMs: 600_001, boundaryActiveMs: 100_000 });
  const other = openCampaignEvidence();
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation: { activeMs: 20_000 } }));
  expect(other.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs: 20_000,
  })).kind).toBe('ready');
  writeFileSync(evidencePath, JSON.stringify({ runId: 'other-run', preparation: { activeMs: 20_000 } }));
  const foreign = other.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs: 700_000,
  }));
  expect(foreign.kind).toBe('contradicted');
  expect(campaignPhaseDeadline(sample(700_000), foreign).reason).toBe('bun campaign evidence was refused');
  expect(other.proof).toEqual({ reportedActiveMs: 20_000, boundaryActiveMs: 20_000 });
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: foreign, sample: sample(700_000),
  })).toEqual({ ok: false, failure: 'evidence' });
});

test('the staged phase timer fails closed and keeps wall, preparation, and operation reasons', () => {
  let consulted = false;
  const wall = phaseDeadlineArm({
    now: 5_000, activeElapsedMs: 10, admissionOpen: true, runDeadline: 5_000,
    timeoutMs: 360_000, commandName: 'bun',
    decide: () => { consulted = true; return { activeLimitMs: 600_000 }; },
  });
  expect(consulted).toBe(false);
  expect(wall).toEqual({ expire: 'bun reached its run deadline' });
  const thrown = phaseDeadlineArm({
    now: 0, activeElapsedMs: Number.NaN, admissionOpen: false, timeoutMs: 360_000, commandName: 'bun',
    decide: () => { throw new Error('Invalid campaign envelope clock'); },
  });
  expect(thrown).toEqual({ expire: 'Invalid campaign envelope clock' });
  const nonfinite = phaseDeadlineArm({
    now: 0, activeElapsedMs: 1_000, admissionOpen: false, timeoutMs: 360_000, commandName: 'bun',
    decide: () => ({ activeLimitMs: Number.NaN }),
  });
  expect(nonfinite).toEqual({ expire: 'bun timed out after 360000 ms of active work' });
  const preparation = phaseDeadlineArm({
    now: 0, activeElapsedMs: 600_001, admissionOpen: false, timeoutMs: 360_000, commandName: 'bun',
    decide: sample => campaignPhaseDeadline(sample, { kind: 'absent' }),
  });
  expect(preparation).toEqual({ expire: 'bun preparation exceeded 600000 ms of active work' });
  const operation = phaseDeadlineArm({
    now: 0, activeElapsedMs: 180_000 + 360_001, admissionOpen: false, timeoutMs: 360_000, commandName: 'bun',
    decide: sample => campaignPhaseDeadline(sample, ready(180_000, 180_000)),
  });
  expect(operation).toEqual({ expire: 'bun timed out after 360000 ms of active work' });
  const reasonWins = phaseDeadlineArm({
    now: 0, activeElapsedMs: 1, admissionOpen: false, timeoutMs: 360_000, commandName: 'bun',
    decide: () => ({ activeLimitMs: Number.POSITIVE_INFINITY, reason: 'bun preparation exceeded 600000 ms of active work' }),
  });
  expect(reasonWins).toEqual({ expire: 'bun preparation exceeded 600000 ms of active work' });
  const paused = phaseDeadlineArm({
    now: 0, activeElapsedMs: 700_000, admissionOpen: true, runDeadline: 10_000,
    timeoutMs: 360_000, commandName: 'bun',
    decide: sample => campaignPhaseDeadline(sample, { kind: 'absent' }),
  });
  expect(paused).toEqual({ waitMs: 200 });
  expect(campaignPhaseDeadline(sample(600_000), { kind: 'absent' }).reason).toBeUndefined();
  expect(campaignPhaseDeadline(sample(200_000 + 360_000), ready(200_000, 200_000)).reason).toBeUndefined();
});
