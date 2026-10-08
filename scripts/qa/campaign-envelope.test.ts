import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { commandAsync, phaseDeadlineFailure } from './core.ts';
import { cleanupQaStacks } from './stack-ownership.ts';
import { projectName } from '../dev/config.ts';
import {
  CAMPAIGN_OPERATION_ACTIVE_MS, CAMPAIGN_PREPARATION_ACTIVE_MS,
  campaignCommandAccepted, campaignPhaseDeadline, campaignQualificationShard, campaignShardActiveMs,
  childStackCleanupCommand, classifyCampaignEvidence, currentSuppliedRunIds, openCampaignEvidence,
  preparationBoundaryActiveMs,
  type CampaignEvidenceRead, type CampaignEvidenceState, type CommandPhaseSample,
} from './campaign-envelope.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sample(activeElapsedMs: number, admissionOpen = false): CommandPhaseSample {
  return {
    activeElapsedMs, admissionOpen, observedAt: activeElapsedMs, commandStartedAt: 0, admission: [],
  };
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
  if (fresh.kind === 'ready') expect(fresh.reportedActiveMs).toBe(40_000);
  const started = 1_000;
  const delayed = preparationBoundaryActiveMs({
    activeElapsedMs: 180, observedAt: started + 180, modifiedAt: started + 100, commandStartedAt: started, admission: [],
  });
  expect(delayed).toBe(100);
  expect(delayed).not.toBe(180);
  expect(delayed).not.toBe(40_000);
  const admitted = preparationBoundaryActiveMs({
    activeElapsedMs: 100, observedAt: started + 500, modifiedAt: started + 100, commandStartedAt: started,
    admission: [{ start: started + 100, end: started + 500 }],
  });
  expect(admitted).toBe(100);
  expect(preparationBoundaryActiveMs({
    activeElapsedMs: 50_000, observedAt: 550_000, modifiedAt: 50_000, commandStartedAt: started, admission: [],
  })).toBeUndefined();
  const inconsistent = openCampaignEvidence();
  expect(inconsistent.observe({
    ...base, parsed: { projectRunId, preparation: { activeMs: 40_000 } }, readError: false,
    modifiedAt: 50_000, observedAt: 550_000, activeElapsedMs: 50_000, admission: [],
  }).kind).toBe('refused');
  expect(inconsistent.proof).toBeUndefined();
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
    projectRunId: input.projectRunId, activeElapsedMs: input.activeElapsedMs, observedAt: Date.now(), admission: [],
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
  expect(first.kind).toBe('ready');
  if (first.kind !== 'ready') throw new Error('missing preparation proof');
  const boundary = first.boundaryActiveMs;
  expect(boundary).toBeLessThanOrEqual(180_000);
  expect(boundary).toBeGreaterThan(180_000 - 1_000);
  expect(boundary).not.toBe(180_000 + 360_001);
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
  expect(during).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: boundary });
  const refused = campaignPhaseDeadline(sample(boundary + 360_001), during);
  expect(refused.phase).toBe('operation');
  expect(refused.reason).toBe('bun timed out after 360000 ms of active work');
  expect(refused.reason).not.toContain('preparation exceeded');
  writeFileSync(evidencePath, '{');
  const torn = look(180_000 + 400_000);
  expect(torn).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: boundary });
  expect(campaignPhaseDeadline(sample(boundary + 360_001), torn).reason).toBe(
    'bun timed out after 360000 ms of active work');
  writeFileSync(evidencePath, JSON.stringify({
    preparation, completedAt: new Date().toISOString(), fixtureBackupRetained: 'kept',
  }));
  const finalWrite = look(180_000 + 20_000, 'final');
  expect(finalWrite).toEqual({ kind: 'ready', reportedActiveMs: 180_000, boundaryActiveMs: boundary });
  expect(watch.proof?.boundaryActiveMs).toBe(boundary);
  expect(campaignPhaseDeadline(sample(boundary + 360_001), finalWrite).reason).toBe(
    'bun timed out after 360000 ms of active work');
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: finalWrite, sample: sample(boundary + 360_001),
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
  expect(watch.proof).toEqual({ reportedActiveMs: 180_000, boundaryActiveMs: boundary });
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
  if (first.kind !== 'ready') throw new Error('missing preparation proof');
  const boundary = first.boundaryActiveMs;
  expect(campaignPhaseDeadline(sample(100_000), first).reason).toContain('preparation exceeded 600000');
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation, completedAt: new Date().toISOString() }));
  const rewritten = look(590_000);
  expect(rewritten).toEqual({ kind: 'ready', reportedActiveMs: 600_001, boundaryActiveMs: boundary });
  expect(campaignPhaseDeadline(sample(590_000), rewritten).reason).toContain('preparation exceeded 600000');
  writeFileSync(evidencePath, JSON.stringify({ preparation: { activeMs: 1 }, completedAt: new Date().toISOString() }));
  expect(look(120_000).kind).toBe('contradicted');
  expect(watch.proof).toEqual({ reportedActiveMs: 600_001, boundaryActiveMs: boundary });
  const other = openCampaignEvidence();
  writeFileSync(evidencePath, JSON.stringify({ projectRunId, preparation: { activeMs: 20_000 } }));
  const opened = other.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs: 20_000,
  }));
  expect(opened.kind).toBe('ready');
  if (opened.kind !== 'ready') throw new Error('missing preparation proof');
  writeFileSync(evidencePath, JSON.stringify({ runId: 'other-run', preparation: { activeMs: 20_000 } }));
  const foreign = other.observe(evidenceRead({
    path: evidencePath, projectRunId, commandStartedAt, activeElapsedMs: 700_000,
  }));
  expect(foreign.kind).toBe('contradicted');
  expect(campaignPhaseDeadline(sample(700_000), foreign).reason).toBe('bun campaign evidence was refused');
  expect(other.proof).toEqual({ reportedActiveMs: 20_000, boundaryActiveMs: opened.boundaryActiveMs });
  expect(campaignCommandAccepted({
    exitOk: true, timedOut: false, evidence: foreign, sample: sample(700_000),
  })).toEqual({ ok: false, failure: 'evidence' });
});

test('commandAsync keeps preparation past the operation timeout and fails closed without echoing a callback error', async () => {
  const secret = 'SUPER-SECRET-PHASE-LEAK';
  let calls = 0;
  const thrown = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, {
      phaseDeadline: () => { calls += 1; throw new Error(secret); },
    });
  expect(thrown.timedOut).toBe(true);
  expect(thrown.ok).toBe(false);
  expect(calls).toBe(1);
  expect(thrown.output).toContain(phaseDeadlineFailure);
  expect(thrown.output).not.toContain(secret);
  const nonfinite = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, { phaseDeadline: () => ({ activeLimitMs: Number.NaN }) });
  expect(nonfinite.output).toContain(phaseDeadlineFailure);
  expect(nonfinite.output).not.toContain('timed out after 360000');
  const negative = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, { phaseDeadline: () => ({ activeLimitMs: -1 }) });
  expect(negative.output).toContain(phaseDeadlineFailure);
  expect(negative.output.match(/phase deadline failed/g)?.length).toBe(1);
  const leaked = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, {
      phaseDeadline: () => ({ activeLimitMs: 10_000, reason: secret }),
    });
  expect(leaked.output).toContain(phaseDeadlineFailure);
  expect(leaked.output).not.toContain(secret);
  let seenPastOperationTimeout = false;
  const preparation = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(500)'], 360,
    process.env, undefined, {
      phaseDeadline: probe => {
        const decision = campaignPhaseDeadline(probe, { kind: 'absent' });
        if (probe.activeElapsedMs > 360) seenPastOperationTimeout = true;
        return decision;
      },
    });
  expect(preparation.ok).toBe(true);
  expect(preparation.timedOut).toBe(false);
  expect(seenPastOperationTimeout).toBe(true);
  expect(preparation.output).not.toContain('timed out after');
  expect(preparation.output).not.toContain('preparation exceeded');
  const reportedPath = evidenceFile('reported');
  const reportedWatch = openCampaignEvidence();
  const reported = await commandAsync(import.meta.dir, 'bun', ['-e', `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({ preparation: { activeMs: ${CAMPAIGN_PREPARATION_ACTIVE_MS + 1} } }));
    await Bun.sleep(30_000);
  `], 30_000, { ...process.env, EVIDENCE: reportedPath }, undefined, {
    phaseDeadline: probe => campaignPhaseDeadline(probe, reportedWatch.observe(readEvidence('reported', probe))),
  });
  expect(reported.timedOut).toBe(true);
  expect(reported.output).toContain('bun preparation exceeded 600000 ms of active work');
  expect(reported.output).not.toContain('timed out after 360000');
  let forgottenCalls = 0;
  const forgotten = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, {
      phaseDeadline: () => { forgottenCalls += 1; return { activeLimitMs: 40 }; },
    });
  expect(forgotten.timedOut).toBe(true);
  expect(forgotten.output).toContain(phaseDeadlineFailure);
  expect(forgotten.output).not.toContain('timed out after');
  expect(forgottenCalls).toBeGreaterThan(0);
  expect(forgottenCalls).toBeLessThan(4);
  const wall = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, {
      runDeadline: Date.now() + 250,
      phaseDeadline: () => ({ activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS }),
    });
  expect(wall.output).toContain('reached its run deadline');
  expect(wall.output).not.toContain(phaseDeadlineFailure);
}, 15_000);

const runnerEvidence = new Map<string, string>();
function evidenceFile(name: string): string {
  const directory = mkdtempSync(join(import.meta.dir, '../../.temp/campaign-runner-'));
  scratch.push(directory);
  const path = join(directory, 'erasure-campaign-qualification.json');
  runnerEvidence.set(name, path);
  return path;
}
function readEvidence(name: string, probe: CommandPhaseSample): CampaignEvidenceRead {
  const path = runnerEvidence.get(name)!;
  let parsed: unknown, readError = false;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { readError = true; }
  const exists = awaitFile(path);
  return {
    parsed: exists ? parsed : undefined,
    readError: exists ? readError : false,
    modifiedAt: exists ? statSync(path).mtimeMs : probe.commandStartedAt,
    commandStartedAt: probe.commandStartedAt,
    projectRunId: '20261008t000000-runner-f1',
    activeElapsedMs: probe.activeElapsedMs,
    observedAt: probe.observedAt,
    admission: probe.admission,
  };
}
function awaitFile(path: string): boolean {
  try { statSync(path); return true; }
  catch { return false; }
}

test('a late first read uses the evidence write, and later rewrites cannot move that boundary', async () => {
  const path = evidenceFile('delay');
  const projectRunId = '20261008t000000-runner-f1';
  const watch = openCampaignEvidence();
  let boundary: number | undefined;
  let firstActive = 0;
  let writeAt = 0;
  const child = `
    const fs = require('node:fs');
    const started = Date.now();
    while (Date.now() - started < 40) {}
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({
      projectRunId: ${JSON.stringify(projectRunId)},
      preparation: { activeMs: 20_000 },
    }));
    await Bun.sleep(420);
    const current = JSON.parse(fs.readFileSync(process.env.EVIDENCE, 'utf8'));
    current.completedAt = new Date().toISOString();
    current.phases = { 'copy-compact-index-0': 1 };
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify(current));
    await Bun.sleep(250);
  `;
  const result = await commandAsync(import.meta.dir, 'bun', ['-e', child], 30_000,
    { ...process.env, EVIDENCE: path }, undefined, {
      phaseDeadline: probe => {
        if (!awaitFile(path)) return { activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS };
        const modifiedAt = statSync(path).mtimeMs;
        if (writeAt === 0) writeAt = modifiedAt;
        if (probe.observedAt < modifiedAt + 200) return { activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS };
        const evidence = watch.observe(readEvidence('delay', probe));
        if (evidence.kind === 'ready' && boundary === undefined) {
          boundary = evidence.boundaryActiveMs;
          firstActive = probe.activeElapsedMs;
        }
        return campaignPhaseDeadline(probe, evidence);
      },
    });
  expect(result.ok).toBe(true);
  expect(boundary).toBeDefined();
  expect(firstActive - boundary!).toBeGreaterThan(150);
  expect(boundary).not.toBe(firstActive);
  const again = watch.observe(readEvidence('delay', {
    activeElapsedMs: (boundary ?? 0) + 400, admissionOpen: false, observedAt: Date.now(),
    commandStartedAt: Date.now() - 5_000, admission: [],
  }), 'final');
  expect(again).toEqual({ kind: 'ready', reportedActiveMs: 20_000, boundaryActiveMs: boundary });
  const operationReason = campaignPhaseDeadline(
    sample((boundary ?? 0) + CAMPAIGN_OPERATION_ACTIVE_MS + 1), again).reason;
  expect(operationReason).toBe('bun timed out after 360000 ms of active work');
  const killed = await commandAsync(import.meta.dir, 'bun', ['-e', 'await Bun.sleep(30_000)'], 30_000,
    process.env, undefined, {
      phaseDeadline: probe => probe.activeElapsedMs > 80
        ? { activeLimitMs: (boundary ?? 0) + CAMPAIGN_OPERATION_ACTIVE_MS, reason: operationReason }
        : { activeLimitMs: (boundary ?? 0) + CAMPAIGN_OPERATION_ACTIVE_MS },
    });
  expect(killed.timedOut).toBe(true);
  expect(killed.output).toContain('bun timed out after 360000 ms of active work');
  expect(killed.output.match(/timed out after 360000 ms of active work/g)?.length).toBe(1);
}, 10_000);

test('the runner refuses a foreign proof and keeps admission off the active clock', async () => {
  const path = evidenceFile('foreign');
  const projectRunId = '20261008t000000-runner-f1';
  const watch = openCampaignEvidence();
  const child = `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({
      projectRunId: ${JSON.stringify(projectRunId)}, preparation: { activeMs: 20_000 },
    }));
    await Bun.sleep(300);
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({
      runId: 'other-run', preparation: { activeMs: 20_000 },
    }));
    await Bun.sleep(30_000);
  `;
  const foreign = await commandAsync(import.meta.dir, 'bun', ['-e', child], 30_000,
    { ...process.env, EVIDENCE: path }, undefined, {
      phaseDeadline: probe => campaignPhaseDeadline(probe, watch.observe(readEvidence('foreign', probe))),
    });
  expect(foreign.timedOut).toBe(true);
  expect(foreign.output).toContain('bun campaign evidence was refused');
  expect(foreign.output).not.toContain('preparation exceeded');
  expect(foreign.output).not.toContain('timed out after 360000');
  expect(watch.proof?.reportedActiveMs).toBe(20_000);
  const admitted = await commandAsync(import.meta.dir, 'bun', ['-e', `
    console.log('QA_MEMORY_WAIT_BEGIN 9-1');
    await Bun.sleep(400);
    console.log('QA_MEMORY_WAIT_END 9-1 400');
  `], 250, process.env, undefined, {
    phaseDeadline: () => ({ activeLimitMs: 5_000 }),
  });
  expect(admitted.ok).toBe(true);
  expect(admitted.admissionWaitMs).toBeGreaterThanOrEqual(300);
  expect(admitted.activeElapsedMs).toBeLessThan(250);
  expect(admitted.elapsedMs).toBeGreaterThanOrEqual(admitted.admissionWaitMs);
  const stalePath = evidenceFile('stale');
  writeFileSync(stalePath, JSON.stringify({ preparation: { activeMs: 10 } }));
  const staleTime = new Date(Date.now() - 60_000);
  utimesSync(stalePath, staleTime, staleTime);
  const staleWatch = openCampaignEvidence();
  let staleKind = '';
  const stale = await commandAsync(import.meta.dir, 'bun', ['-e', 'process.exit(0)'], 5_000,
    process.env, undefined, {
      phaseDeadline: probe => {
        const evidence = staleWatch.observe({
          parsed: JSON.parse(readFileSync(stalePath, 'utf8')), readError: false,
          modifiedAt: statSync(stalePath).mtimeMs, commandStartedAt: probe.commandStartedAt,
          projectRunId, activeElapsedMs: probe.activeElapsedMs, observedAt: probe.observedAt,
          admission: probe.admission,
        });
        staleKind = evidence.kind;
        return campaignPhaseDeadline(probe, evidence);
      },
    });
  expect(stale.ok).toBe(true);
  expect(staleKind).toBe('refused');
  expect(staleWatch.proof).toBeUndefined();
  const tornPath = evidenceFile('torn');
  const tornWatch = openCampaignEvidence();
  const tornChild = `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({
      projectRunId: ${JSON.stringify(projectRunId)}, preparation: { activeMs: 15_000 },
    }));
    await Bun.sleep(450);
    fs.writeFileSync(process.env.EVIDENCE, '{');
    await Bun.sleep(300);
  `;
  const torn = await commandAsync(import.meta.dir, 'bun', ['-e', tornChild], 30_000,
    { ...process.env, EVIDENCE: tornPath }, undefined, {
      phaseDeadline: probe => campaignPhaseDeadline(probe, tornWatch.observe(readEvidence('torn', probe))),
    });
  expect(torn.ok).toBe(true);
  expect(torn.output).not.toContain('preparation exceeded');
  expect(tornWatch.proof?.reportedActiveMs).toBe(15_000);
  const tornFinal = tornWatch.observe(readEvidence('torn', {
    activeElapsedMs: torn.activeElapsedMs, admissionOpen: false, observedAt: Date.now(),
    commandStartedAt: Date.now() - 5_000, admission: [],
  }), 'final');
  expect(tornFinal.kind).toBe('contradicted');
  const malformedPath = evidenceFile('malformed');
  const malformedWatch = openCampaignEvidence();
  let malformedKind = '';
  const malformed = await commandAsync(import.meta.dir, 'bun', ['-e', `
    const fs = require('node:fs');
    fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({ preparation: { activeMs: 'bad' } }));
    await Bun.sleep(400);
  `], 5_000, { ...process.env, EVIDENCE: malformedPath }, undefined, {
    phaseDeadline: probe => {
      const evidence = malformedWatch.observe(readEvidence('malformed', probe));
      malformedKind = evidence.kind;
      return campaignPhaseDeadline(probe, evidence);
    },
  });
  expect(malformed.ok).toBe(true);
  expect(malformedKind).toBe('refused');
}, 15_000);
