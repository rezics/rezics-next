import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { processRunning } from '../../tests/qa/support/process-liveness.ts';
import { describe, expect, test } from 'bun:test';
import { testArgs, unitHarnessFiles } from '../qa/acceptance.ts';
import { ownerTierBudgetMs } from '../qa/owner-tier-budget.ts';
import { formatPlan, nativeUnionTest, planAffected, type AffectedPlan } from '../qa/affected.ts';
import { repositoryGuards } from '../qa/repository-guards.ts';
import { TmuxLauncher, processIdentity, tmuxServer, type LaunchDescriptor } from './coordinator.ts';
import { acquireHeavy, acquireSharedLifecycle, archiveFiles, areaConflicts, balanceUnitShards, briefFile, claimConflicts, declaredTestTimeout, migrationsBelowMain, mergeOwnerFiles, mergeUnitFiles, ownerFilesFromPlan, unitFilesFromPlan, compositionSyntaxFailure, goalAreas,
  goalOfBriefPath, heavyQaStatus, heavyQaWaiters, historyIntroductions, inheritedSharedLifecycleOwnership, isHeavyTest, landedBoundary, launchCommand, nextTaskId, normalizeUseChains, outOfScope, ownerRefusal,
  parseBrief, parseCodexUsage, pathsOverlap, prepareCompositionMerge, preserveWorktreeArtifacts, rangesOverlap, removeFromTree, retryGitIndexLock, SONNET_MODEL,
  addGateWorktree, branchOnlyRefusal, classifyBranchOnlyFailures, codexHoursUntil100, coordinatorEnrollmentOptions, failingTestFiles, gateTreeRefusal, infrastructureStep, introducedUnitFailureFiles, introducedUnitFailures, landClaimScope, loadCodexResetStatus, markHeavyCommandStarted, memoryFloorRefusal, REGENERATION_COMMIT_SUBJECT,
  planUnitGateShards, qaWaitStatusLines, sharedLifecycleEnvironment, sharedLifecycleStatus, sharedLifecycleWaiters, runOwnerShard, runUnitGate, runUnitSide, shardTimeoutFiles, streamSelectionFiles, streamUnitBaseline, timedOutTestFiles, transferSharedLifecycleOwnership, UNIT_GATE_FILE_CAP, UNIT_JUNIT_MARKER, unitFailureDetails, unitFileErrorDetails, unitFileEvidence, unitGateRefusal, writeUnitEvidence, withRecovery, withSlot,
  mailCommand, mechanismSectionErrors, type AccountUsage, type Ledger, type Task, type UnitFailureDetail, type UnitRunEvidence, type UnitShardResult, treeMentions, usageLevel, usageReport, validateBrief,
  workerSessionEnvironment } from './goalctl.ts';
import { fastForwardMain, introducedTypecheckDiagnostics, typecheckDiagnostics, typecheckGate, typecheckWorkspaces, TYPECHECK_WORKSPACES, unclassifiedTypecheckLines,
  type FastForwardGates, type MainSync, type PreparedMerge, type TypecheckRun } from './goalctl.ts';
import { reviewPrompt } from './land.ts';
import { physicalPath, postgresSocketRefusal } from './postgres-socket.ts';

const brief = `---
id: G-040
title: Poll ballot owner schema  # comment
effort: xhigh
cases: [GOV11, GOV12]
paths: [services/main/src/modules/poll/**, tests/qa/integration/poll-*.test.ts]
migrations: [main/access:040-044]
shared: [route:poll]
depends: [G-038]
---
Body.
`;

function held(overrides: Partial<Task>): Task {
  return { id: 'G-039', title: 'held', effort: 'medium', cases: [], paths: [], migrations: [], shared: [],
    depends: [], brief: '', worktree: '', branch: '', base: '', state: 'running', attempts: [], ...overrides };
}

describe('goalctl briefs', () => {
  test('parses frontmatter lists and strips comments', () => {
    const parsed = parseBrief(brief);
    expect(parsed).toMatchObject({ id: 'G-040', title: 'Poll ballot owner schema', effort: 'xhigh',
      cases: ['GOV11', 'GOV12'], migrations: ['main/access:040-044'], shared: ['route:poll'], depends: ['G-038'] });
    expect(validateBrief(parsed)).toEqual([]);
  });

  test('rejects efforts the engine does not accept, absolute or .temp paths and malformed ranges', () => {
    const parsed = parseBrief(brief.replace('xhigh', 'ultra').replace('services/main/src/modules/poll/**', '/etc/**')
      .replace('040-044', '044-040'));
    expect(validateBrief(parsed)).toHaveLength(3);
    expect(validateBrief({ ...parseBrief(brief), paths: ['.temp/x'] })).toHaveLength(1);
  });

  test('selects mapped mechanisms, or none when the task touches none', () => {
    const body = (mechanisms: string) => `---\nid: G-040\ntitle: t\neffort: high\n---\n## Outcome\n\n## Mechanisms\n\n${mechanisms}\n\n## Checks\n`;
    expect(mechanismSectionErrors(body('none'))).toEqual([]);
    expect(mechanismSectionErrors(body('- rights-evaluation: consume\n- language-parsing: configure'))).toEqual([]);
    expect(mechanismSectionErrors(body('- private-instrument: new — no owner evaluates this private instrument'))).toEqual([]);
    expect(mechanismSectionErrors(body('- rights-evaluation: new — another evaluator'))).toContain('mechanism rights-evaluation is mapped: consume, configure or extend it');
    expect(mechanismSectionErrors('---\nid: G-040\ntitle: t\neffort: high\n---\n## Outcome\n')).toContain('brief needs a ## Mechanisms section');
    expect(mechanismSectionErrors(body('- not-a-mechanism: consume'))).toContain('unknown mechanism: not-a-mechanism');
    expect(mechanismSectionErrors(body('- rights-evaluation: new'))).toContain('mechanism rights-evaluation: new needs the reason no owner fits');
    expect(mechanismSectionErrors(body('none\n- rights-evaluation: consume'))).toContain('mechanism section is none or a list, not both');
    const prompt = reviewPrompt({ worktree: '/w', base: 'a', head: 'b', brief: 'brief', handoff: 'RESULT: done', directory: '/d' });
    expect(prompt).toContain('Which owner carries this change?');
    expect(prompt).toContain('duplicates a mapped mechanism');
  });
});

describe('goalctl claims', () => {
  const parsed = parseBrief(brief);

  test('identifies migrations that need normalization above main', () => {
    const main = () => ['985_a.sql', '1004_b.sql'];
    expect(migrationsBelowMain(['services/main/migrations/access/990_x.sql'], main))
      .toEqual(['services/main/migrations/access/990_x.sql (main already has 1004)']);
    expect(migrationsBelowMain(['services/main/migrations/access/1010_x.sql', 'apps/web/a.ts'], main)).toEqual([]);
  });

  test('Codex workers run on the service tier the manager selects', () => {
    const previous = process.env.GOAL_CODEX_SERVICE_TIER;
    try {
      for (const tier of ['fast', 'default']) {
        process.env.GOAL_CODEX_SERVICE_TIER = tier;
        const [, args] = launchCommand({ id: 'G-950', effort: 'high', session: '', prompt: 'p', engine: 'codex',
          worktree: '/w' } as Parameters<typeof launchCommand>[0]);
        expect(args.join(' ')).toContain(`service_tier="${tier}"`);
      }
    } finally {
      if (previous === undefined) delete process.env.GOAL_CODEX_SERVICE_TIER;
      else process.env.GOAL_CODEX_SERVICE_TIER = previous;
    }
  });

  test('a brief may name a shared worktree; its brief file is per task', () => {
    const brief = parseBrief('---\nid: G-950\ntitle: t\neffort: high\nengine: codex\nworktree: wave-9\npaths: [a/**]\n---\n');
    expect(brief.worktree).toBe('wave-9');
    expect(validateBrief(brief)).toEqual([]);
    expect(validateBrief({ ...brief, worktree: '../x' })).toContain('worktree must be a lower-case name: ../x');
    expect(briefFile({ id: 'G-950', worktree: '/w', shared: true })).toBe('.temp/goal/brief-g-950.md');
    expect(briefFile({ id: 'G-950', worktree: '/w' })).toBe('.temp/goal/brief.md');
  });

  test('Next.js dynamic folders in claims are literal directories', () => {
    expect(pathsOverlap('apps/web/app/[locale]/[handle]/**', 'apps/web/app/[locale]/following/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/[locale]/[handle]/**', 'apps/web/app/[locale]/[handle]/page.tsx')).toBe(true);
    expect(pathsOverlap('apps/web/app/[locale]/z/[[...path]]/**', 'apps/web/app/[locale]/z/**')).toBe(true);
    expect(pathsOverlap('apps/web/app/[locale]/r/[realm]/[...path]/**', 'apps/web/app/[locale]/r/[realm]/about/**')).toBe(false);
  });

  test('migration ranges compare numerically past 999', () => {
    expect(rangesOverlap('services/main/migrations/access:998-1002', 'services/main/migrations/access:1000-1003')).toBe(true);
    expect(rangesOverlap('services/main/migrations/access:990-999', 'services/main/migrations/access:1000-1003')).toBe(false);
  });

  test('detects case, path, migration and shared-slot overlap with holding tasks only', () => {
    const conflicts = claimConflicts(parsed, [
      held({ cases: ['GOV12'], paths: ['tests/qa/integration/poll-tally.test.ts'],
        migrations: ['main/access:044-046'], shared: ['route:poll'] }),
      held({ id: 'G-030', cases: ['GOV11'], state: 'verified' }),
    ]);
    expect(conflicts).toHaveLength(4);
    expect(conflicts.join('\n')).not.toContain('G-030');
  });

  test('keeps disjoint claims independent', () => {
    expect(claimConflicts(parsed, [held({ cases: ['GOV13'], paths: ['services/main/src/modules/poll.ts'],
      migrations: ['main/access:045-049', 'content:040-044'] })])).toEqual([]);
    expect(pathsOverlap('tests/qa/integration/poll-*', 'tests/qa/integration/pkg-*')).toBe(false);
    expect(pathsOverlap('services/**/poll.ts', 'services/main/src/app.ts')).toBe(false);
    expect(pathsOverlap('apps/web/app/identity/**', 'apps/web/app/[[]locale]/studio/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/\\[locale\\]/studio/**', 'apps/web/app/[[]locale]/studio/page.tsx')).toBe(true);
    expect(pathsOverlap('apps/web/app/[[]locale]/w/**', 'apps/web/app/[[]locale]/studio/**')).toBe(false);
    expect(pathsOverlap('apps/web/app/[a-z]*/**', 'apps/web/app/identity/**')).toBe(true);
    expect(pathsOverlap('services/**/poll.ts', 'services/main/src/poll.ts')).toBe(true);
    expect(pathsOverlap('services/main/src/modules/*/outbox-event*.ts',
      'services/main/src/modules/content-publication/comment.ts')).toBe(false);
    expect(pathsOverlap('services/main/src/modules/*/outbox-event*.ts',
      'services/main/src/modules/work/outbox-event.ts')).toBe(true);
    expect(pathsOverlap('services/main/tests/*integration.test.ts', 'services/main/tests/member-reply*.ts')).toBe(true);
    expect(pathsOverlap('model/definitions/**', 'model/definitions/work-metadata*.ts')).toBe(true);
    expect(pathsOverlap('tests/qa/unit/*-resolution.test.ts', 'tests/qa/unit/core.test.ts')).toBe(false);
    expect(pathsOverlap('apps/web/app/w/**', 'apps/web/app/works/**')).toBe(false);
    expect(pathsOverlap('apps/web/**', 'apps/web/app/w/page.tsx')).toBe(true);
    expect(rangesOverlap('content:001-003', 'content:003-009')).toBe(true);
  });

  test('reports changed files outside the claimed globs', () => {
    expect(outOfScope(['services/main/src/modules/poll/ballot.ts', 'services/main/src/app.ts'],
      parsed.paths)).toEqual(['services/main/src/app.ts']);
  });

  test('a generated file is not a claim and does not block land', () => {
    const generated = 'generated/openapi/main/public.json';
    const holder = held({ paths: [generated, 'services/main/src/modules/poll/**'] });
    const claimant = parseBrief(brief.replace('paths: [services/main/src/modules/poll/**, tests/qa/integration/poll-*.test.ts]',
      `paths: [${generated}]`));
    expect(claimConflicts(claimant, [holder])).toEqual([]);
    expect(claimConflicts(parsed, [held({ paths: ['**'] })])).toContain('path services/main/src/modules/poll/** overlaps G-039 **');
    const scope = landClaimScope([generated, 'scripts/goal/goalctl.ts'], ['scripts/goal/**'], [{ id: 'other', paths: [generated] }]);
    expect(scope).toEqual({ outOfClaim: [], claimedByOthers: [] });
    const blocked = landClaimScope(['scripts/other.ts'], ['scripts/goal/**'], [{ id: 'other', paths: ['scripts/other.ts'] }]);
    expect(blocked).toEqual({ outOfClaim: ['scripts/other.ts'], claimedByOthers: ['scripts/other.ts'] });
    const compose = 'infra/dev/compose.yaml';
    const shape = 'packages/model/src/generated/shape.ts';
    const sibling = 'packages/model/src/generated/other.ts';
    const exempt = landClaimScope([compose, shape, sibling, 'scripts/goal/goalctl.ts'], ['scripts/goal/**'],
      [{ id: 'other', paths: ['infra/dev/**', 'packages/model/src/generated/**'] }], [compose, shape]);
    expect(exempt).toEqual({ outOfClaim: [sibling], claimedByOthers: [sibling] });
    const own = landClaimScope([compose], ['scripts/goal/**'], [{ id: 'other', paths: ['infra/dev/**'] }]);
    expect(own).toEqual({ outOfClaim: [compose], claimedByOthers: [compose] });
  });
});

describe('goalctl runtime policy', () => {
  test('host available memory must meet the configured floor, defaulting to 12 GiB', () => {
    const meminfo = (giB: number) => `MemFree: 1 kB\nMemAvailable: ${giB * 1024 * 1024} kB\n`;
    expect(memoryFloorRefusal(meminfo(11))).toContain('GOAL_MEMORY_FLOOR_GIB=12');
    expect(memoryFloorRefusal(meminfo(12))).toBeUndefined();
    expect(memoryFloorRefusal(meminfo(13))).toBeUndefined();
    expect(memoryFloorRefusal(meminfo(7.5), 8)).toContain('MemAvailable 7.50 GiB');
    expect(memoryFloorRefusal(meminfo(0), 0)).toBeUndefined();
    expect(() => memoryFloorRefusal('MemFree: 999 kB')).toThrow('Cannot determine host MemAvailable');
    for (const floor of [-1, NaN, Infinity]) expect(() => memoryFloorRefusal(meminfo(16), floor)).toThrow('GOAL_MEMORY_FLOOR_GIB');
  });

  test('classifies 5h usage and treats stale snapshots as unknown', () => {
    const now = 1_800_000_000_000;
    const at = now / 1000 - 60;
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 42 } } }, now).level).toBe('normal');
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 80 } } }, now).level).toBe('restricted');
    expect(usageLevel({ at, rate_limits: { five_hour: { used_percentage: 97 } } }, now).level).toBe('critical');
    expect(usageLevel({ at: at - 3600, rate_limits: { five_hour: { used_percentage: 97 } } }, now).level)
      .toBe('unknown');
    expect(usageLevel(undefined, now).level).toBe('unknown');
  });

  test('paces dispatch against the time left before the 5h reset', () => {
    const now = 1_800_000_000;
    const snap = (used: number, resetIn: number, week?: number) => ({ at: now, rate_limits: {
      five_hour: { used_percentage: used, resets_at: now + resetIn },
      seven_day: week === undefined ? null : { used_percentage: week, resets_at: now + 3 * 86400 } } });
    // 80% after 4h (20%/h) with 1h left projects exactly 100%: no new dispatch.
    expect(usageLevel(snap(80, 3600), now * 1000).level).toBe('restricted');
    // 80% with 15 min left (about 17%/h) projects 84%: keep using the window.
    expect(usageLevel(snap(80, 900), now * 1000)).toMatchObject({ level: 'normal', projected: 84 });
    // A slower recent slope (width already reduced) reopens dispatch with the same used percentage.
    const resets = now + 3600;
    const history = [{ at: now - 1200, used: 76, resets }];
    expect(usageLevel(snap(80, 3600), now * 1000, history)).toMatchObject({ level: 'normal', projected: 92 });
    // 50% after 1h projects 250%: stop early instead of waiting for 80%.
    expect(usageLevel(snap(50, 4 * 3600), now * 1000).level).toBe('restricted');
    expect(usageLevel(snap(96, 60), now * 1000).level).toBe('critical');
    // The weekly window stops new Claude work when it would pass the cap's margin before its reset:
    // under the default 100% cap, 60% after 4 days projects 105%; 30% projects about 53% and continues.
    expect(usageLevel(snap(10, 4 * 3600, 60), now * 1000)).toMatchObject({ level: 'restricted' });
    expect(usageLevel(snap(10, 4 * 3600, 30), now * 1000)).toMatchObject({ level: 'normal' });
    expect(usageLevel(snap(10, 4 * 3600, 95), now * 1000)).toMatchObject({ level: 'critical' });
  });

  test('advises widening Claude work while the week would end unspent', () => {
    const now = 1_800_000_000;
    const weekResets = now + 24 * 3600;
    const snap = (week: number) => ({ at: now, rate_limits: {
      five_hour: { used_percentage: 10, resets_at: now + 4 * 3600 },
      seven_day: { used_percentage: week, resets_at: weekResets } } });
    // 24% after six days lands near 28%: spend more.
    expect(usageLevel(snap(24), now * 1000)).toMatchObject({ level: 'normal', weekProjected: 28 });
    expect(usageLevel(snap(24), now * 1000).weekAdvice).toContain('widen');
    // A recent slope of 3.5%/h over the last two hours has a low projection of 24 + 72 = 96%: stop new Claude work.
    const history = [{ at: now - 7200, used: 5, resets: now + 4 * 3600, week: 17, weekResets }];
    expect(usageLevel(snap(24), now * 1000, history)).toMatchObject({ level: 'restricted', weekProjected: 96 });
  });

  test('rounded weekly readings use the low projection for dispatch and warn on the high projection', () => {
    const now = 1_800_000_000;
    const weekResets = now + 160 * 3600;
    const history = [{ at: now - 3600, used: 5, resets: now + 3600, week: 6, weekResets }];
    const snap = (week: number) => ({ at: now, rate_limits: {
      five_hour: { used_percentage: 10, resets_at: now + 3600 },
      seven_day: { used_percentage: week, resets_at: weekResets } } });
    expect(usageLevel(snap(7), now * 1000, history)).toMatchObject({
      level: 'normal', weekProjected: 7, weekProjectedHigh: 327,
    });
    expect(usageLevel(snap(7), now * 1000, history).weekAdvice).toContain('warning');
    expect(usageLevel(snap(12), now * 1000, history).level).toBe('restricted');
  });

  test('reads a Codex account usage from its newest rollout line', () => {
    const now = 1_790_520_000_000;
    const line = (used: number, resets: number, reached: string | null = null) => JSON.stringify({
      timestamp: '2026-09-27T14:36:48.837Z', type: 'event_msg', payload: { type: 'token_count', rate_limits: {
        primary: { used_percent: used, window_minutes: 10080, resets_at: resets }, secondary: null,
        plan_type: 'pro', rate_limit_reached_type: reached } } });
    const text = [line(40, 1_791_053_423), '{"type":"event_msg"}', line(45, 1_791_053_423), '{"partial'].join('\n');
    expect(parseCodexUsage(text, now)).toMatchObject({ used: 45, windowMinutes: 10080, plan: 'pro', reached: false,
      resetInHours: 148.2 });
    expect(parseCodexUsage(line(100, 1_791_053_423), now).reached).toBe(true);
    expect(parseCodexUsage(line(80, 1_790_000_000), now)).toMatchObject({ used: 0, reached: false });
    expect(parseCodexUsage('', now)).toEqual({});
  });

  test('attributes a test timeout to the file that needs an isolated retry', () => {
    const output = [
      'tests/qa/unit/slow.test.ts:', '(fail) delayed check', 'Timeout: test delayed check timed out after 30000ms',
      'scripts/goal/other.test.ts:', '(fail) explicit timeout probe', 'Test timed out (37 s against 30 s)',
    ].join('\n');
    expect(timedOutTestFiles(output, ['tests/qa/unit/slow.test.ts', 'scripts/goal/other.test.ts']))
      .toEqual(['scripts/goal/other.test.ts', 'tests/qa/unit/slow.test.ts']);
  });

  test('keeps earlier test timeouts when the containing shard also times out', () => {
    const files = ['tests/qa/unit/first.test.ts', 'tests/qa/unit/last.test.ts'];
    const output = [
      `${files[0]}:`, '(fail) first test timed out [300ms]', 'Timeout: test first test timed out after 300ms',
      `${files[1]}:`,
    ].join('\n');
    expect(shardTimeoutFiles(output, files, process.cwd())).toEqual(files);
  });

  describe('unit gate rerun of files a timed-out shard never reached', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const shard = (group: readonly string[], fields: Partial<UnitShardResult>): UnitShardResult =>
      ({ done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [...group], output: '', ms: 1, ...fields });
    /** The first pass's only shard stops after `slow`; later passes follow `rerun` per file. */
    const stub = (slow: string, rerun: (group: readonly string[]) => Partial<UnitShardResult>) => {
      const calls: string[][] = [];
      const run = async (_cwd: string, group: readonly string[]): Promise<UnitShardResult> => {
        calls.push([...group]);
        return calls.length === 1
          ? shard(group, { done: false, timedOut: [slow], budgetExpired: true })
          : shard(group, rerun(group));
      };
      return { calls, run };
    };

    test('files after the timed-out one run again and the gate passes', async () => {
      const { calls, run } = stub('b.test.ts', () => ({}));
      const result = await runUnitGate('.', files, 1, run);
      expect(calls).toEqual([files, ['a.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts']]);
      // Only the timed-out file is left for the caller's isolated retry.
      expect(result).toMatchObject({ done: false, timedOut: ['b.test.ts'], unfinished: ['b.test.ts'], failing: [] });
    });

    test('a file that fails on the rerun counts as a failure of the side', async () => {
      const failure = { file: 'd.test.ts', test: 'fails', detail: 'expected 1' };
      const { run } = stub('b.test.ts', () => ({ failing: ['d.test.ts'], failures: [failure] }));
      const result = await runUnitGate('.', files, 1, run);
      expect(result).toMatchObject({ failing: ['d.test.ts'], failures: [failure], unfinished: ['b.test.ts'] });
    });

    test('a file that times out on the rerun stays unfinished', async () => {
      const { calls, run } = stub('b.test.ts', group =>
        ({ done: false, timedOut: ['c.test.ts'], budgetExpired: true, files: [...group] }));
      const result = await runUnitGate('.', files, 1, run);
      // Files the budget never reached are continued. A later wave that classifies nothing stops.
      expect(calls).toHaveLength(3);
      expect(result.done).toBe(false);
      expect(result.timedOut).toEqual(['b.test.ts', 'c.test.ts']);
      const neverStarted = result.unfinished.filter(file => !result.timedOut.includes(file));
      expect(neverStarted).toEqual(['a.test.ts', 'd.test.ts', 'e.test.ts']);
    });

    test('the rerun uses the shard layout of a first run of that size', async () => {
      const calls: string[][] = [];
      const run = async (_cwd: string, group: readonly string[]): Promise<UnitShardResult> => {
        calls.push([...group]);
        return calls.length <= 2 ? shard(group, { done: false, timedOut: [group[0]!], budgetExpired: true }) : shard(group, {});
      };
      await runUnitGate('.', files, 2, run);
      expect(calls.slice(0, 2)).toEqual(balanceUnitShards(files, 2));
      expect(calls.slice(2)).toEqual(balanceUnitShards(['c.test.ts', 'd.test.ts', 'e.test.ts'], 2));
    });

    test('a shard that was not cut by the budget is not rerun', async () => {
      const calls: string[][] = [];
      const run = async (_cwd: string, group: readonly string[]) => {
        calls.push([...group]);
        return shard(group, { done: false });
      };
      const result = await runUnitGate('.', files, 1, run);
      expect(calls).toEqual([files]);
      expect(result.unfinished).toEqual(files);
    });

    test('a runner error on the first pass is not rerun', async () => {
      const calls: string[][] = [];
      const run = async (_cwd: string, group: readonly string[]) => {
        calls.push([...group]);
        return shard(group, { done: false, budgetExpired: true, runnerErrors: [{ files: [...group], diagnostic: 'no task' }] });
      };
      const result = await runUnitGate('.', files, 1, run);
      expect(calls).toHaveLength(1);
      expect(result.runnerErrors).toHaveLength(1);
    });

    test('a 600-file plan finishes every file when each shard completes only part of its files', async () => {
      const files = Array.from({ length: 600 }, (_, index) => `wide-${String(index).padStart(3, '0')}.test.ts`);
      const ran = new Set<string>();
      const groups: string[][] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      let started = 0;
      let release: (() => void) | undefined;
      const hold = new Promise<void>(resolve => { release = resolve; });
      const result = await runUnitGate('.', files, 4, async (_cwd, group) => {
        groups.push([...group]);
        started++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (started === 4) release?.();
        if (started <= 4) await hold;
        const completed = group.slice(0, Math.min(2, group.length));
        for (const file of completed) ran.add(file);
        inFlight--;
        const finished = group.length <= 2;
        return {
          done: finished, budgetExpired: !finished, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
          files: [...group], output: completed.map(file => `${file}:\n(pass) kept [1ms]\n`).join(''), ms: 1,
        };
      });
      expect(maxInFlight).toBeLessThanOrEqual(4);
      expect(groups.every(group => group.length <= UNIT_GATE_FILE_CAP)).toBe(true);
      expect(groups.length).toBeGreaterThan(4);
      expect(result.done).toBe(true);
      expect(result.unfinished).toEqual([]);
      expect([...ran].sort()).toEqual([...files].sort());
    });

    test('a shard that makes no progress is inconclusive and names its files', async () => {
      const stuck = ['stuck-a.test.ts', 'stuck-b.test.ts', 'stuck-c.test.ts'];
      const calls: string[][] = [];
      const lines: string[] = [];
      const write = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        const result = await runUnitGate('.', stuck, 1, async (_cwd, group) => {
          calls.push([...group]);
          return shard(group, { done: false, budgetExpired: true, output: '' });
        });
        expect(calls).toEqual([stuck, stuck]);
        expect(result.done).toBe(false);
        expect(result.unfinished).toEqual(stuck);
        const printed = lines.join('\n');
        expect(printed).toContain('continuation made no progress');
        for (const file of stuck) expect(printed).toContain(file);
      } finally { console.log = write; }
    });

    test('main names the files when continuation makes no progress', async () => {
      const stuck = ['main-a.test.ts', 'main-b.test.ts'];
      const lines: string[] = [];
      const write = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        const side = await runUnitSide('.', stuck, 'main', [], async (_cwd, group) =>
          shard(group, { done: false, budgetExpired: true, output: '' }));
        expect(side.inconclusive).toEqual(stuck);
        const printed = lines.join('\n');
        expect(printed).toContain("main's run of 2 files did not finish");
        for (const file of stuck) expect(printed).toContain(file);
      } finally { console.log = write; }
    });
  });

  test('duration-based planning puts known-slow files in their own shards', () => {
    const budget = 12 * 60 * 1000;
    const slow = 'services/main/tests/slow-gate.test.ts';
    const fast = ['services/main/tests/a-gate.test.ts', 'services/main/tests/b-gate.test.ts', 'services/main/tests/c-gate.test.ts'];
    const unmeasured = 'services/main/tests/unmeasured-gate.test.ts';
    const planned = planUnitGateShards([
      { file: slow, timeout: { unparseable: false }, durationMs: 10 * 60 * 1000 },
      ...fast.map(file => ({ file, timeout: { unparseable: false }, durationMs: 5_000 })),
      { file: unmeasured, timeout: { unparseable: false } },
    ], 4, budget);
    expect(planned.shards.find(entry => entry.files.includes(slow))?.files).toEqual([slow]);
    const shared = planned.shards.filter(entry => entry.files.some(file => fast.includes(file) || file === unmeasured));
    expect(shared).toHaveLength(1);
    expect(shared[0]!.files).not.toContain(slow);
    expect(shared[0]!.files).toEqual(expect.arrayContaining([...fast, unmeasured]));
    expect(planned.shards.flatMap(entry => entry.files).sort()).toEqual([slow, ...fast, unmeasured].sort());
  });

  test('measured durations from QA history and gate evidence put known-slow files alone', async () => {
    const cwd = mkdtempSync(join(import.meta.dir, '../../.temp/unit-gate-durations-'));
    const slow = 'services/main/tests/slow-measured.test.ts';
    const evidenceSlow = 'services/main/tests/evidence-slow.test.ts';
    const fast = ['services/main/tests/fast-measured-a.test.ts', 'services/main/tests/fast-measured-b.test.ts'];
    mkdirSync(join(cwd, '.artifacts/qa/20261008t000000-aaaaaa/logs'), { recursive: true });
    writeFileSync(join(cwd, '.artifacts/qa/20261008t000000-aaaaaa/logs/unit-1-durations.json'),
      JSON.stringify({ [slow]: 10 * 60 * 1000, [fast[0]]: 1_000, [fast[1]]: 1_000 }));
    mkdirSync(join(cwd, '.temp/goal-orchestration/merges'), { recursive: true });
    writeFileSync(join(cwd, '.temp/goal-orchestration/merges/prior.json'),
      JSON.stringify({ invocations: [], durations: { [evidenceSlow]: 11 * 60 * 1000 } }));
    const calls: string[][] = [];
    const passed = (group: readonly string[]): UnitShardResult => ({
      done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [...group], output: '', ms: 1,
    });
    try {
      const result = await runUnitGate(cwd, [slow, evidenceSlow, ...fast], 4, async (_cwd, group) => {
        calls.push([...group]);
        return passed(group);
      });
      expect(result.done).toBe(true);
      expect(calls.find(group => group.includes(slow))).toEqual([slow]);
      expect(calls.find(group => group.includes(evidenceSlow))).toEqual([evidenceSlow]);
      const fastShard = calls.find(group => group.includes(fast[0]!));
      expect(fastShard).toEqual(expect.arrayContaining(fast));
      expect(fastShard).not.toContain(slow);
      expect(fastShard).not.toContain(evidenceSlow);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });

  test('the gate names the unfinished files when the ceiling is reached', async () => {
    const files = Array.from({ length: 10 }, (_, index) => `ceil-${index}.test.ts`);
    const previous = process.env.GOAL_UNIT_GATE_CEILING_MS;
    process.env.GOAL_UNIT_GATE_CEILING_MS = '1';
    const lines: string[] = [];
    const write = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      const result = await runUnitGate('.', files, 1, async (_cwd, group) => {
        await Bun.sleep(5);
        const completed = group[0]!;
        return {
          done: false, budgetExpired: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
          files: [...group], output: `${completed}:\n(pass) one [1ms]\n`, ms: 5,
        };
      });
      expect(result.done).toBe(false);
      expect(result.unfinished.length).toBeGreaterThan(0);
      expect(result.unfinished.length).toBeLessThan(files.length);
      const printed = lines.join('\n');
      expect(printed).toContain('gate ceiling was reached');
      for (const file of result.unfinished) expect(printed).toContain(file);
    } finally {
      console.log = write;
      if (previous === undefined) delete process.env.GOAL_UNIT_GATE_CEILING_MS;
      else process.env.GOAL_UNIT_GATE_CEILING_MS = previous;
    }
  });

  describe('unit gate evidence for classified runs', () => {
    const core = 'gate-isolated.test.ts';
    const other = 'gate-companion.test.ts';
    const slow = 'aa-slow-gate.test.ts';
    const later = 'bb-later-gate.test.ts';
    const caseName = 'QA slots: SIGTERM, SIGINT, process exit, errors and the run deadline release leases';
    const laterCase = 'later file rejects the payload';
    const shard = (group: readonly string[], fields: Partial<UnitShardResult> = {}): UnitShardResult =>
      ({ done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [...group], output: '', ms: 1, ...fields });
    const assertion = (file: string, name: string, expected: string, received: string) => [
      `${file}:`, 'error: expect(received).toBe(expected)', '', `Expected: ${expected}`, `Received: ${received}`,
      `(fail) ${name} [8.14ms]`,
    ].join('\n');

    async function withEvidence(files: readonly string[],
      run: (cwd: string, group: readonly string[]) => Promise<UnitShardResult>,
      check: (captured: { side: Awaited<ReturnType<typeof runUnitSide>>; evidence: UnitRunEvidence[]; lines: string[]; log: string }) => void | Promise<void>) {
      const previousShards = process.env.GOAL_UNIT_GATE_SHARDS;
      const previousLog = process.env.GOAL_MERGE_LOG;
      const directory = mkdtempSync(join(import.meta.dir, '../../.temp/unit-gate-evidence-'));
      const log = join(directory, 'merge.log');
      process.env.GOAL_UNIT_GATE_SHARDS = '1';
      process.env.GOAL_MERGE_LOG = log;
      const lines: string[] = [];
      const write = console.log;
      console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        const evidence: UnitRunEvidence[] = [];
        const side = await runUnitSide('.', files, 'affected', evidence, run);
        await check({ side, evidence, lines, log });
      } finally {
        console.log = write;
        if (previousShards === undefined) delete process.env.GOAL_UNIT_GATE_SHARDS;
        else process.env.GOAL_UNIT_GATE_SHARDS = previousShards;
        if (previousLog === undefined) delete process.env.GOAL_MERGE_LOG;
        else process.env.GOAL_MERGE_LOG = previousLog;
        rmSync(directory, { recursive: true, force: true });
      }
    }

    test('an isolated retry that fails keeps and prints its case name and error', async () => {
      const calls: string[][] = [];
      const failOutput = assertion(core, caseName, 'false', 'true');
      await withEvidence([core, other], async (_cwd, group) => {
        calls.push([...group]);
        if (calls.length === 1) return shard(group, {
          done: false, budgetExpired: true, timedOut: [core],
          output: `${core}:\nrunning test: holds past the budget\n${other}:\n`,
        });
        if (group.length === 1 && group[0] === other) return shard(group, { output: `${other}:\n(pass) finishes [1ms]` });
        return shard(group, {
          failing: [core], output: failOutput,
          failures: [{ file: core, test: caseName, detail: 'error: expect(received).toBe(expected)\nExpected: false\nReceived: true' }],
        });
      }, ({ side, evidence, lines, log }) => {
        expect(calls.map(group => group.join(','))).toEqual([`${core},${other}`, other, core]);
        expect(side.failing).toEqual([core]);
        expect(side.inconclusive).toEqual([]);
        const printed = lines.join('\n');
        expect(printed).toContain(`(fail) ${caseName}`);
        expect(printed).toContain('Expected: false');
        expect(printed).toContain('timed out while running: holds past the budget');
        const isolated = evidence.find(run => run.kind === 'isolated-retry' && run.side === 'affected');
        expect(isolated?.files[0]).toMatchObject({ file: core, cases: [{ test: caseName }] });
        expect(isolated?.files[0]?.cases[0]?.error).toContain('Expected: false');
        expect(isolated?.files[0]?.cases[0]?.error).toContain('Received: true');
        const refusal = unitGateRefusal('introduced unit failures; not merging:', side.failing, evidence);
        expect(refusal).toContain(`introduced unit failures; not merging:\n  ${core}`);
        expect(refusal).toContain(`(fail) ${caseName}`);
        expect(refusal).toContain('Expected: false');
        const path = writeUnitEvidence(evidence);
        expect(path).toBe(`${log.slice(0, -4)}.json`);
        const stored = JSON.parse(readFileSync(path!, 'utf8')) as { invocations: { runs: UnitRunEvidence[] }[] };
        expect(JSON.stringify(stored)).toContain(caseName);
        expect(JSON.stringify(stored)).toContain('Expected: false');
        expect(stored.invocations.some(item => item.runs.some(run => run.kind === 'isolated-retry'
          && run.files.some(file => Buffer.byteLength(file.output) <= 20 * 1024)))).toBe(true);
      });
    });

    test('an isolated retry that times out again names the case the transcript was running', async () => {
      const calls: string[][] = [];
      const timeoutOutput = [`${core}:`, `(fail) ${caseName} [5000.10ms]`, '  ^ this test timed out after 5000ms.'].join('\n');
      await withEvidence([core, other], async (_cwd, group) => {
        calls.push([...group]);
        if (calls.length === 1) return shard(group, {
          done: false, budgetExpired: true, timedOut: [core],
          output: `${core}:\nrunning test: ${caseName}\n${other}:\n`,
        });
        if (group.length === 1 && group[0] === other) return shard(group, {});
        return shard(group, { failing: [core], timedOut: [core], output: timeoutOutput });
      }, ({ side, evidence, lines }) => {
        expect(calls).toHaveLength(3);
        expect(side.inconclusive).toEqual([core]);
        expect(side.failing).toEqual([]);
        const printed = lines.join('\n');
        expect(printed).toContain(`(fail) ${caseName}`);
        expect(printed).toContain('this test timed out after 5000ms');
        const isolated = evidence.find(run => run.kind === 'isolated-retry');
        expect(isolated?.files[0]?.runningTest).toBe(caseName);
        expect(isolated?.files[0]?.cases[0]?.error).toContain('this test timed out after 5000ms');
        const refusal = unitGateRefusal('unit gate remains inconclusive after isolated timeout retry:', side.inconclusive, evidence);
        expect(refusal).toContain(`unit gate remains inconclusive after isolated timeout retry:\n  ${core}`);
        expect(refusal).toContain(`(fail) ${caseName}`);
        expect(refusal).toContain('this test timed out after 5000ms');
        expect(refusal).not.toContain(other);
      });
    });

    test('a never-started rerun failure is kept and the refusal names that case', async () => {
      const calls: string[][] = [];
      const failOutput = assertion(later, laterCase, 'true', 'false');
      await withEvidence([slow, later], async (_cwd, group) => {
        calls.push([...group]);
        if (calls.length === 1) return shard(group, {
          done: false, budgetExpired: true, timedOut: [slow], output: `${slow}:\nrunning test: slow once\n${later}:\n`,
        });
        if (group.length === 1 && group[0] === slow) return shard(group, { output: `${slow}:\n(pass) finishes [1ms]` });
        return shard(group, {
          failing: [later], output: failOutput,
          failures: [{ file: later, test: laterCase, detail: 'error: expect(received).toBe(expected)\nExpected: true\nReceived: false' }],
        });
      }, ({ side, evidence, lines }) => {
        expect(calls.map(group => group.join(','))).toEqual([`${slow},${later}`, later, slow, later]);
        expect(side.failing).toEqual([later]);
        expect(side.inconclusive).toEqual([]);
        const rerun = evidence.find(run => run.kind === 'never-started-rerun');
        expect(rerun?.files.map(file => file.file)).toEqual([later]);
        expect(rerun?.files[0]?.cases[0]).toMatchObject({ test: laterCase });
        expect(rerun?.files[0]?.cases[0]?.error).toContain('Received: false');
        const printed = lines.join('\n');
        expect(printed).toContain('Unit gate evidence (affected, never-started-rerun):');
        expect(printed).toContain(`(fail) ${laterCase}`);
        expect(printed).toContain('Expected: true');
        const refusal = unitGateRefusal('introduced unit failures; not merging:', side.failing, evidence);
        expect(refusal).toContain(`(fail) ${laterCase}`);
        expect(refusal).toContain('Received: false');
        expect(refusal).not.toContain(slow);
        expect(evidence.some(run => run.kind === 'confirm' && run.files.some(file => file.cases.some(item => item.test === laterCase)))).toBe(true);
      });
    });

    test('an introduced-failure refusal names the affected case when main fails a different one', () => {
      const file = 'gate-shared.test.ts';
      const branch = 'branch rejects the new payload';
      const baseline = 'main rejects the old payload';
      const evidence: UnitRunEvidence[] = [
        { side: 'affected', kind: 'confirm', files: [{ file, output: '', cases: [{ test: branch, error: 'Expected: false\nReceived: true' }] }] },
        { side: 'main', kind: 'first', files: [{ file, output: '', cases: [{ test: baseline, error: 'Expected: 1\nReceived: 2' }] }] },
      ];
      const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], evidence);
      const deciding = refusal.split('inherited on main:')[0] ?? refusal;
      expect(deciding).toContain(`introduced unit failures; not merging:\n  ${file}`);
      expect(deciding).toContain(`(fail) ${branch}`);
      expect(deciding).toContain('Expected: false');
      expect(deciding).not.toContain(baseline);
      expect(refusal).toContain('inherited on main:');
      expect(refusal.split('inherited on main:')[1]).toContain(`(fail) ${baseline}`);
    });

    test('a 30KB assertion error is truncated to the 20KB case cap', () => {
      const file = 'gate-long-error.test.ts';
      const blob = 'E'.repeat(30 * 1024);
      const output = [`${file}:`, `error: ${blob}`, '(fail) huge assertion [1ms]'].join('\n');
      const [kept] = unitFileEvidence(output, [file], [file], []);
      expect(kept!.cases[0]?.test).toBe('huge assertion');
      expect(kept!.cases[0]!.error.length).toBeLessThanOrEqual(20 * 1024);
      expect(kept!.cases[0]!.error.startsWith('error:')).toBe(true);
      expect(kept!.cases[0]!.error).toContain('[truncated to 20KB]');
      expect(kept!.cases[0]!.error).not.toContain(blob);
      const previous = process.env.GOAL_MERGE_LOG;
      const directory = mkdtempSync(join(import.meta.dir, '../../.temp/unit-gate-evidence-'));
      const log = join(directory, 'merge.log');
      process.env.GOAL_MERGE_LOG = log;
      try {
        const runs: UnitRunEvidence[] = [{ side: 'affected', kind: 'first', files: [kept!] }];
        const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], runs);
        const printedError = refusal.split('\n').filter(line => line.startsWith('      ')).map(line => line.slice(6)).join('\n');
        expect(printedError.length).toBeLessThanOrEqual(20 * 1024);
        expect(printedError).toContain('[truncated to 20KB]');
        expect(refusal).not.toContain(blob);
        const path = writeUnitEvidence(runs);
        const stored = JSON.parse(readFileSync(path!, 'utf8')) as { invocations: { runs: UnitRunEvidence[] }[] };
        const storedError = stored.invocations[0]!.runs[0]!.files[0]!.cases[0]!.error;
        expect(storedError.length).toBeLessThanOrEqual(20 * 1024);
        expect(storedError).toContain('[truncated to 20KB]');
        expect(storedError).not.toContain(blob);
      } finally {
        if (previous === undefined) delete process.env.GOAL_MERGE_LOG;
        else process.env.GOAL_MERGE_LOG = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('a failure printed before the shard budget expired stays on the first run', async () => {
      const failed = 'aa-failed-early.test.ts';
      const later = 'bb-later-budget.test.ts';
      const caseName = 'stops before the budget';
      const calls: string[][] = [];
      await withEvidence([failed, later], async (_cwd, group) => {
        calls.push([...group]);
        if (calls.length === 1) return shard(group, {
          done: false, budgetExpired: true, failing: [], timedOut: [later],
          output: `${assertion(failed, caseName, 'false', 'true')}\n${later}:\nrunning test: still going\n`,
        });
        if (group.length === 1 && group[0] === failed) return shard(group, { output: `${failed}:\n(pass) clears [1ms]` });
        return shard(group, { output: `${later}:\n(pass) finishes [1ms]` });
      }, ({ side, evidence, lines }) => {
        expect(side.failing).not.toContain(failed);
        const first = evidence.find(run => run.side === 'affected' && run.kind === 'first');
        const kept = first?.files.find(file => file.file === failed);
        expect(kept?.cases.map(item => item.test)).toEqual([caseName]);
        expect(kept?.cases[0]?.error).toContain('Expected: false');
        expect(lines.join('\n')).toContain(`(fail) ${caseName}`);
      });
    });

    test('keeps every case name when one error uses the per-file budget', () => {
      const file = 'gate-two-cases.test.ts';
      const blob = 'E'.repeat(30 * 1024);
      const output = [`${file}:`, `error: ${blob}`, '(fail) first huge assertion [1ms]',
        'error: second detail', '(fail) second case stays named [1ms]'].join('\n');
      const [kept] = unitFileEvidence(output, [file], [file], []);
      expect(kept!.cases.map(item => item.test)).toEqual(['first huge assertion', 'second case stays named']);
      const used = kept!.cases.reduce((sum, item) => sum + Buffer.byteLength(item.error), 0);
      expect(used).toBeLessThanOrEqual(20 * 1024);
      expect(kept!.cases[0]!.error).toContain('[truncated to 20KB]');
      expect(kept!.cases[1]!.error).toBe('');
      const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], [
        { side: 'affected', kind: 'first', files: [kept!] },
      ]);
      expect(refusal).toContain('(fail) first huge assertion');
      expect(refusal).toContain('(fail) second case stays named');
    });

    test('the 20KB cap counts UTF-8 bytes and stops on a character boundary', () => {
      const file = 'gate-wide-error.test.ts';
      const emoji = '😀';
      const original = `error: ${emoji.repeat(6_000)}`;
      const output = [`${file}:`, original, '(fail) wide assertion [1ms]'].join('\n');
      expect(original.length).toBeLessThan(20 * 1024);
      expect(Buffer.byteLength(original)).toBeGreaterThan(20 * 1024);
      const [kept] = unitFileEvidence(output, [file], [file], []);
      const stored = kept!.cases[0]!.error;
      expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(20 * 1024);
      expect(stored).toContain('[truncated to 20KB]');
      const body = stored.replace(/\n\[truncated to 20KB\]$/, '');
      expect(original.startsWith(body)).toBe(true);
      expect([...body].every(char => char === emoji || char.charCodeAt(0) < 128)).toBe(true);
      expect(Buffer.byteLength(kept!.output)).toBeLessThanOrEqual(20 * 1024);
      expect([...kept!.output].every(char => char === emoji || char.charCodeAt(0) < 128)).toBe(true);
      expect(kept!.output).toContain('(fail) wide assertion');
    });

    test('a later gate invocation appends its runs instead of replacing the first', () => {
      const previous = process.env.GOAL_MERGE_LOG;
      const directory = mkdtempSync(join(import.meta.dir, '../../.temp/unit-gate-evidence-'));
      const log = join(directory, 'merge.log');
      process.env.GOAL_MERGE_LOG = log;
      try {
        const file = 'gate-rerun.test.ts';
        const first: UnitRunEvidence[] = [{ side: 'affected', kind: 'first', files: [
          { file, output: '', cases: [{ test: 'first invocation fails', error: 'Expected: 1' }] }] }];
        const second: UnitRunEvidence[] = [{ side: 'affected', kind: 'confirm', files: [
          { file, output: '', cases: [{ test: 'second invocation fails', error: 'Expected: 2' }] }] }];
        const path = writeUnitEvidence(first);
        expect(writeUnitEvidence(second)).toBe(path);
        const stored = JSON.parse(readFileSync(path!, 'utf8')) as { invocations: { invocation: number; runs: UnitRunEvidence[] }[] };
        expect(stored.invocations.map(item => item.invocation)).toEqual([1, 2]);
        expect(stored.invocations[0]!.runs[0]!.files[0]!.cases[0]!.test).toBe('first invocation fails');
        expect(stored.invocations[1]!.runs[0]!.files[0]!.cases[0]!.test).toBe('second invocation fails');
      } finally {
        if (previous === undefined) delete process.env.GOAL_MERGE_LOG;
        else process.env.GOAL_MERGE_LOG = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    });

    test('keeps at most 20KB of a file transcript and 40 lines of each failure', () => {
      const file = 'gate-oversized.test.ts';
      const detail = Array.from({ length: 80 }, (_, index) => `detail ${index} ${'y'.repeat(200)}`);
      const output = [`${file}:`, 'x'.repeat(25_000), 'error: expect(received).toBe(expected)', ...detail,
        '(fail) oversized failure [1ms]'].join('\n');
      const [kept] = unitFileEvidence(output, [file], [file], []);
      expect(kept!.output.length).toBeLessThanOrEqual(20 * 1024);
      expect(kept!.output).toContain('(fail) oversized failure');
      expect(kept!.cases[0]?.test).toBe('oversized failure');
      expect(kept!.cases[0]?.error.split('\n')).toHaveLength(40);
      expect(kept!.cases[0]?.error).toContain('error: expect(received).toBe(expected)');
      expect(kept!.cases[0]?.error).not.toContain('detail 79');
    });

    test('consecutive timeouts keep each case\'s own trailing error', () => {
      const file = 'gate-two-timeouts.test.ts';
      const output = [
        `${file}:`,
        '(fail) first timeout [20.10ms]',
        '  ^ this test timed out after 20ms.',
        '(fail) second timeout [50.10ms]',
        '  ^ this test timed out after 50ms.',
      ].join('\n');
      const [kept] = unitFileEvidence(output, [file], [file], [file]);
      expect(kept!.cases.map(item => item.test)).toEqual(['first timeout', 'second timeout']);
      expect(kept!.cases[0]!.error).toContain('timed out after 20ms');
      expect(kept!.cases[0]!.error).not.toContain('50ms');
      expect(kept!.cases[1]!.error).toContain('timed out after 50ms');
      expect(kept!.cases[1]!.error).not.toContain('20ms');
      const followed = [
        `${file}:`,
        'error: expect(received).toBe(expected)',
        'Expected: 1',
        '(fail) assertion holds its own error [1ms]',
        '(fail) timeout after an assertion [50.10ms]',
        '  ^ this test timed out after 50ms.',
      ].join('\n');
      const [mixed] = unitFileEvidence(followed, [file], [file], []);
      expect(mixed!.cases.map(item => item.test)).toEqual(['assertion holds its own error', 'timeout after an assertion']);
      expect(mixed!.cases[0]!.error).toContain('Expected: 1');
      expect(mixed!.cases[0]!.error).not.toContain('50ms');
      expect(mixed!.cases[1]!.error).toContain('timed out after 50ms');
    });

    test('a file-level import error is kept and the branch output tail is logged', async () => {
      const file = 'gate-import-error.test.ts';
      const head = 'IMPORT-HEAD-NOT-IN-TAIL';
      const marker = 'branch-output-tail-marker';
      const blob = 'E'.repeat(30 * 1024);
      const output = [
        head,
        `${file}:`,
        '# Unhandled error between tests',
        '-------------------------------',
        `error: Cannot find module './missing-probe-import.ts' ${blob}`,
        '-------------------------------',
        marker,
      ].join('\n');
      await withEvidence([file], async () => shard([file], {
        failing: [file], output,
        fileErrors: [{ file, detail: "error: Cannot find module './missing-probe-import.ts'" }],
      }), ({ evidence, lines }) => {
        const kept = evidence.find(run => run.kind === 'first')?.files.find(item => item.file === file);
        expect(kept?.cases).toEqual([]);
        expect(kept?.fileError).toContain('# Unhandled error between tests');
        expect(kept?.fileError).toContain("Cannot find module './missing-probe-import.ts'");
        expect(kept?.fileError).toContain('[truncated to 20KB]');
        expect(Buffer.byteLength(kept!.fileError!)).toBeLessThanOrEqual(20 * 1024);
        expect(kept!.fileError).not.toContain(blob);
        expect(kept!.fileError).not.toContain(marker);
        const printed = lines.join('\n');
        expect(printed).toContain('# Unhandled error between tests');
        expect(printed).toContain("Cannot find module './missing-probe-import.ts'");
        const tailLog = lines.find(line => line.includes('fail on the branch'));
        const tail = tailLog!.slice(tailLog!.indexOf('\n') + 1);
        expect(tail.length).toBeLessThanOrEqual(20_000);
        expect(tail).toContain(marker);
        expect(tail).not.toContain(head);
        const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], evidence);
        expect(refusal).toContain(`introduced unit failures; not merging:\n  ${file}`);
        expect(refusal).toContain('# Unhandled error between tests');
        expect(refusal).toContain("Cannot find module './missing-probe-import.ts'");
        expect(refusal).not.toContain(blob);
        const path = writeUnitEvidence(evidence);
        const stored = JSON.parse(readFileSync(path!, 'utf8')) as { invocations: { runs: UnitRunEvidence[] }[] };
        const storedError = stored.invocations[0]!.runs.flatMap(run => run.files).find(item => item.file === file)?.fileError;
        expect(storedError).toContain("Cannot find module './missing-probe-import.ts'");
        expect(Buffer.byteLength(storedError!)).toBeLessThanOrEqual(20 * 1024);
      });
    });
  });

  test('a file declaring a 910000ms timeout runs alone for 970s and other files keep the default', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goalctl-long-shard-'));
    const long = join(directory, 'long.test.ts');
    const ordinary = join(directory, 'ordinary.test.ts');
    writeFileSync(long, `import { test } from 'bun:test';\ntest('slow', () => {}, 910_000);\n`);
    writeFileSync(ordinary, `import { test } from 'bun:test';\ntest('fast', () => {});\n`);
    expect(declaredTestTimeout(readFileSync(long, 'utf8'))).toEqual({ ms: 910_000, unparseable: false });
    const real = readFileSync(join(import.meta.dir, '../../infra/jena/tests/semantic-source-readiness-union.test.ts'), 'utf8');
    expect(declaredTestTimeout(real)).toEqual({ ms: 910_000, unparseable: false });
    const planned = planUnitGateShards([
      { file: long, timeout: declaredTestTimeout(readFileSync(long, 'utf8')) },
      { file: ordinary, timeout: { unparseable: false } },
    ], 4, 12 * 60 * 1000);
    expect(planned.shards).toEqual([
      { files: [long], budgetMs: 970_000 },
      { files: [ordinary], budgetMs: 12 * 60 * 1000 },
    ]);
    const calls: { files: readonly string[]; deadline: number }[] = [];
    const previous = process.env.GOAL_UNIT_GATE_BUDGET_MS;
    delete process.env.GOAL_UNIT_GATE_BUDGET_MS;
    const lines: string[] = [];
    const write = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const before = Date.now();
    try {
      const result = await runUnitGate(directory, ['long.test.ts', 'ordinary.test.ts'], 4, async (_cwd, files, deadline) => {
        calls.push({ files, deadline });
        return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
          output: '', ms: 1, files: [...files], budgetExpired: false };
      });
      expect(result.failing).toEqual([]);
      const longCall = calls.find(call => call.files.length === 1 && call.files[0] === 'long.test.ts');
      const rest = calls.find(call => call.files.includes('ordinary.test.ts'));
      expect(longCall?.files).toEqual(['long.test.ts']);
      expect(rest?.files).toEqual(['ordinary.test.ts']);
      expect(longCall!.deadline).toBeGreaterThanOrEqual(before + 970_000);
      expect(longCall!.deadline).toBeLessThan(before + 970_000 + 2_000);
      expect(rest!.deadline).toBeGreaterThanOrEqual(before + 12 * 60 * 1000);
      expect(rest!.deadline).toBeLessThan(before + 12 * 60 * 1000 + 2_000);
      expect(lines.some(line => line.includes('slowest budget 970000ms'))).toBe(true);
    } finally {
      console.log = write;
      if (previous === undefined) delete process.env.GOAL_UNIT_GATE_BUDGET_MS;
      else process.env.GOAL_UNIT_GATE_BUDGET_MS = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an unparseable declared timeout keeps the default budget and names the file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goalctl-unparsed-timeout-'));
    const file = join(directory, 'bound.test.ts');
    writeFileSync(file, `import { test } from 'bun:test';\nconst timeout = 910_000;\ntest('slow', () => {}, timeout);\n`);
    expect(declaredTestTimeout(readFileSync(file, 'utf8')).unparseable).toBe(true);
    const calls: { files: readonly string[]; deadline: number }[] = [];
    const previous = process.env.GOAL_UNIT_GATE_BUDGET_MS;
    delete process.env.GOAL_UNIT_GATE_BUDGET_MS;
    const lines: string[] = [];
    const write = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const before = Date.now();
    try {
      await runUnitGate(directory, ['bound.test.ts', 'missing.test.ts'], 1, async (_cwd, files, deadline) => {
        calls.push({ files, deadline });
        return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
          output: '', ms: 1, files: [...files], budgetExpired: false };
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.files).toContain('bound.test.ts');
      expect(calls[0]!.deadline).toBeGreaterThanOrEqual(before + 12 * 60 * 1000);
      expect(calls[0]!.deadline).toBeLessThan(before + 12 * 60 * 1000 + 2_000);
      expect(lines.some(line => line.includes('bound.test.ts') && line.includes('could not be parsed'))).toBe(true);
      expect(lines.some(line => line.includes('slowest budget 970000ms'))).toBe(false);
    } finally {
      console.log = write;
      if (previous === undefined) delete process.env.GOAL_UNIT_GATE_BUDGET_MS;
      else process.env.GOAL_UNIT_GATE_BUDGET_MS = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('extracts test names and assertion diffs from guard failures', () => {
    const file = 'tests/qa/unit/serialization-points.test.ts';
    const output = [
      `${file}:`, 'error: expect(received).toEqual(expected)', '- Expected  - 1', '+ Received  + 1',
      '  + "branch-only finding"', '    at <anonymous> (/branch/tests/qa/unit/serialization-points.test.ts:42:9)',
      '(fail) serialization guard > checks findings [2.3ms]',
    ].join('\n');
    expect(unitFailureDetails(output, [file], process.cwd())).toEqual([{
      file, test: 'serialization guard > checks findings',
      detail: 'error: expect(received).toEqual(expected)\n- Expected  - 1\n+ Received  + 1\n  + "branch-only finding"',
    }]);
  });

  test('the same failing case is inherited when only its finding text changes', () => {
    const file = 'tests/qa/unit/serialization-points.test.ts';
    const report = (...findings: string[]): UnitFailureDetail[] => [{ file,
      test: 'service migrations and write paths introduce no unapproved serialization or gate upgrades',
      detail: ['error: expect(received).toEqual(expected)', `- Expected  - ${findings.length}`, `+ Received  + ${findings.length}`,
        ...findings.map(finding => `+ ${JSON.stringify(finding)}`)].join('\n') }];
    const baseline = 'restore-lineage.ts:394: singleton-write: access.recovery_fence: singleton write guard';
    const removed = 'restore-lineage.ts:410: constant-advisory-key: rezics-relay-erasure-epoch: restore boundary key';
    const added = 'restore-lineage.ts:414: constant-advisory-key: rezics-relay-erasure-epoch: second restore boundary';
    const shifted = 'restore-lineage.ts:398: singleton-write: access.recovery_fence: singleton write guard';
    const main = report(baseline, removed);

    expect(introducedUnitFailureFiles([file], report(baseline, removed), main)).toEqual([]);
    expect(introducedUnitFailureFiles([file], report(baseline, removed, added), main)).toEqual([]);
    expect(introducedUnitFailureFiles([file], report(baseline), main)).toEqual([]);
    expect(introducedUnitFailureFiles([file], report(shifted), report(baseline))).toEqual([]);
    expect(introducedUnitFailureFiles([file], report(baseline), [])).toEqual([file]);
    const extra = [{ file, test: 'branch adds a finding', detail: 'error: id 86121887 port 54321' }];
    expect(introducedUnitFailures([file], [...report(baseline), ...extra], report(baseline))).toEqual([
      { file, cases: ['branch adds a finding'], fileError: false },
    ]);
  });

  test('a case that fails on the branch and on current main is inherited when only the error text differs', () => {
    const file = 'services/main/tests/nested-pool-checkout.test.ts';
    const name = 'nested pool checkout releases the client';
    const branch = [{ file, test: name, detail: 'error: id 86121887 port 54321' }];
    const main = [{ file, test: name, detail: 'error: id 7a4431ed port 54399' }];
    expect(introducedUnitFailureFiles([file], branch, main)).toEqual([]);
    expect(introducedUnitFailures([file], branch, main)).toEqual([]);
  });

  test('a new failing case in a file main also fails is introduced and the refusal names it', () => {
    const file = 'services/main/tests/library-public-bounds.test.ts';
    const shared = 'library public bounds reject an oversize page';
    const added = 'library public bounds reject a negative offset';
    const branch = [
      { file, test: shared, detail: 'error: id 111 port 1' },
      { file, test: added, detail: 'error: id 222 port 2' },
    ];
    const main = [{ file, test: shared, detail: 'error: id 999 port 9' }];
    expect(introducedUnitFailures([file], branch, main)).toEqual([{ file, cases: [added], fileError: false }]);
    const runs: UnitRunEvidence[] = [
      { side: 'affected', kind: 'confirm', files: [{ file, output: '', cases: branch.map(item => ({ test: item.test, error: item.detail! })) }] },
      { side: 'main', kind: 'first', files: [{ file, output: '', cases: [{ test: shared, error: main[0]!.detail! }] }] },
    ];
    const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], runs, 'affected',
      [{ file, cases: [added], fileError: false }]);
    const deciding = refusal.split('inherited on main:')[0] ?? refusal;
    expect(deciding).toContain(`(fail) ${added}`);
    expect(deciding).not.toContain(shared);
    expect(refusal.split('inherited on main:')[1]).toContain(shared);
  });

  test('an infrastructure start failure names its step and an assertion does not', () => {
    expect(infrastructureStep('Command failed: pg_ctl -D data -w start\npg_ctl: could not start server')).toBe('pg_ctl start');
    expect(infrastructureStep('pg_ctl: PID file "data/postmaster.pid" does not exist\nIs server running?')).toBe('pg_ctl start');
    expect(infrastructureStep('EmbeddedPostgres failed to start')).toBe('embedded PostgreSQL');
    expect(infrastructureStep('Error: listen EADDRINUSE: address already in use 127.0.0.1:5432')).toBe('port bind');
    expect(infrastructureStep('error: id 86121887 port 54321')).toBeUndefined();
    expect(infrastructureStep('Command failed: pg_ctl -D data -m immediate -w stop')).toBeUndefined();
  });

  test('a file that fails only on the branch is classified from alone runs', async () => {
    const load = 'services/main/tests/load-dependent.test.ts';
    const added = 'services/main/tests/erasure-live-remediation.test.ts';
    const fresh = 'services/main/tests/new-behavior.test.ts';
    const start = 'services/content/tests/comment-source-erasure.test.ts';
    const shared = 'selectors clear with the revision';
    const created = 'a new case the branch adds';
    const pg = 'Command failed: pg_ctl -D data -l postgres.log -o -h 127.0.0.1 -p 37561 -k sock -w start\npg_ctl: could not start server';
    const calls: { cwd: string; files: string[] }[] = [];
    const attempts = new Map<string, number>();
    const fail = (file: string, testName: string, detail: string): UnitShardResult => ({
      done: true, failing: [file], timedOut: [], failures: [{ file, test: testName, detail }],
      fileErrors: [], runnerErrors: [], files: [file], output: '', ms: 1,
    });
    const pass = (file: string): UnitShardResult => ({
      done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [file], output: '', ms: 1,
    });
    const runner = async (cwd: string, files: readonly string[]) => {
      calls.push({ cwd, files: [...files] });
      const file = files[0]!;
      if (file === load) return pass(file);
      if (file === start) return fail(file, 'comment source selectors clear once', pg);
      if (file === fresh) return fail(file, created, 'error: expect(received).toBe(expected)');
      if (cwd === '/branch') return fail(file, created, 'error: Expected 200 Received 503');
      return fail(file, shared, 'error: Expected 200 Received 503');
    };
    const absent = new Set([fresh]);
    const classified = await classifyBranchOnlyFailures([load, added, fresh, start], absent, '/branch', '/main', runner);
    expect(calls.every(call => call.files.length === 1)).toBe(true);
    expect(classified.orderDependent).toEqual([load]);
    expect(calls.filter(call => call.files[0] === load).map(call => call.cwd)).toEqual(['/branch']);
    expect(classified.introduced).toEqual([
      { file: added, cases: [created], fileError: false },
      { file: fresh, cases: [created], fileError: false },
    ]);
    expect(calls.filter(call => call.files[0] === added).map(call => call.cwd)).toEqual(['/branch', '/main']);
    expect(calls.filter(call => call.files[0] === fresh).map(call => call.cwd)).toEqual(['/branch']);
    expect(classified.inconclusive).toEqual([{ file: start, side: 'affected', step: 'pg_ctl start' }]);
    expect(calls.filter(call => call.files[0] === start)).toHaveLength(2);
    expect(classified.matched).toEqual([]);
    const names = classified.introduced.flatMap(item => item.cases);
    expect(names).not.toContain('comment source selectors clear once');
    const level = 'services/main/tests/governance-schema.test.ts';
    const levelRunner = async (cwd: string, files: readonly string[]): Promise<UnitShardResult> => ({
      done: true, failing: [files[0]!], timedOut: [], failures: [],
      fileErrors: cwd === '/branch' ? [{ file: files[0]!, detail: 'Cannot find module "branch-only.js"' }] : [],
      runnerErrors: [], files: [...files], output: '', ms: 1,
    });
    const fileError = await classifyBranchOnlyFailures([level], new Set(), '/branch', '/main', levelRunner);
    expect(fileError.introduced).toEqual([{ file: level, cases: [], fileError: true }]);
    const recovered = await classifyBranchOnlyFailures([start], new Set(), '/branch', '/main', async (_cwd, files) => {
      const file = files[0]!;
      const attempt = (attempts.get(`retry\0${file}`) ?? 0) + 1;
      attempts.set(`retry\0${file}`, attempt);
      return attempt === 1 ? fail(file, 'comment source selectors clear once', pg) : pass(file);
    });
    expect(recovered.orderDependent).toEqual([start]);
    expect(recovered.inconclusive).toEqual([]);
    expect(recovered.introduced).toEqual([]);
    const crashed = 'services/main/tests/progress-from-sessions.test.ts';
    const crashCalls: string[] = [];
    const fallout = await classifyBranchOnlyFailures([crashed], new Set(), '/branch', '/main', async (cwd, files) => {
      const file = files[0]!;
      crashCalls.push(cwd);
      return {
        done: true, failing: [file], timedOut: [],
        failures: [
          { file, test: '(unnamed)', detail: pg },
          { file, test: '(unnamed)', detail: "TypeError: undefined is not an object (evaluating 'pool.end')" },
        ],
        fileErrors: [], runnerErrors: [], files: [file], output: '', ms: 1,
      };
    });
    expect(fallout.inconclusive).toEqual([{ file: crashed, side: 'affected', step: 'pg_ctl start' }]);
    expect(fallout.introduced).toEqual([]);
    expect(crashCalls).toEqual(['/branch', '/branch']);
    expect(branchOnlyRefusal(fallout, [])).toBeUndefined();
    const unfinished = {
      introduced: [], orderDependent: [], matched: [], runnerErrors: [],
      inconclusive: [{ file: crashed, side: 'affected' as const, step: 'unfinished run' }],
    };
    expect(branchOnlyRefusal(unfinished, [])).toContain('unit gate remains inconclusive after an isolated rerun');
    const asserted = 'services/main/tests/projection-isolation.test.ts';
    const product = 'Fresh Access install applies every migration';
    const mixed = await classifyBranchOnlyFailures([asserted], new Set(), '/branch', '/main', async (cwd, files) => {
      const file = files[0]!;
      const failures = cwd === '/branch'
        ? [{ file, test: 'selectors clear with the revision', detail: pg }, { file, test: product, detail: 'error: expect(received).toBe(expected)\nExpected: 1\nReceived: 0' }]
        : [{ file, test: 'selectors clear with the revision', detail: 'error: expect(received).toBe(expected)\nExpected: 1\nReceived: 2' }];
      return { done: true, failing: [file], timedOut: [], failures, fileErrors: [], runnerErrors: [], files: [file], output: '', ms: 1 };
    });
    expect(mixed.introduced).toEqual([{ file: asserted, cases: [product], fileError: false }]);
    expect(mixed.inconclusive).toEqual([]);
    const typed = 'services/main/tests/pool-crash.test.ts';
    const typedOnly = await classifyBranchOnlyFailures([typed], new Set(), '/branch', '/main', async (cwd, files) => {
      const file = files[0]!;
      if (cwd === '/main') return pass(file);
      return fail(file, 'pool end runs', "TypeError: undefined is not an object (evaluating 'pool.end')");
    });
    expect(typedOnly.introduced).toEqual([{ file: typed, cases: ['pool end runs'], fileError: false }]);
    expect(typedOnly.inconclusive).toEqual([]);
  });

  test('a branch-only crash refuses and a crash on both sides stays a runner error', async () => {
    const crash = (diagnostic: string): UnitShardResult => ({
      done: true, failing: [], timedOut: [], failures: [], fileErrors: [],
      runnerErrors: [{ files: ['runner'], diagnostic }], files: ['runner'], output: 'pg_ctl: could not start server\nCommand failed: pg_ctl start', ms: 1,
    });
    const file = 'services/main/tests/branch-crash.test.ts';
    const tail = 'process.exit(1)\nbranch crashed before a case';
    const calls: string[] = [];
    const branchOnly = await classifyBranchOnlyFailures([file], new Set(), '/branch', '/main', async (cwd, files) => {
      calls.push(cwd);
      const only = files[0]!;
      if (cwd === '/main') return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [only], output: '', ms: 1 };
      return crash(tail);
    });
    expect(calls).toEqual(['/branch', '/main']);
    expect(branchOnly.introduced).toEqual([]);
    expect(branchOnly.inconclusive).toEqual([]);
    expect(branchOnly.matched).toEqual([]);
    const refusal = branchOnlyRefusal(branchOnly, []);
    expect(refusal).toContain('unattributed affected runner failure; not merging');
    expect(refusal).toContain(tail);
    expect(refusal).not.toContain('not blocking');
    const both = 'services/main/tests/both-crash.test.ts';
    const bothSides = await classifyBranchOnlyFailures([both], new Set(), '/branch', '/main', async cwd => crash(`${cwd} process.exit(1)`));
    expect(bothSides.introduced).toEqual([]);
    expect(bothSides.matched).toEqual([]);
    expect(bothSides.inconclusive).toEqual([]);
    expect(bothSides.runnerErrors.map(item => item.side)).toEqual(['affected', 'main']);
    const bothRefusal = branchOnlyRefusal(bothSides, []) ?? '';
    expect(bothRefusal).toContain('unattributed affected runner failure; not merging');
    expect(bothRefusal).toContain('unattributed main runner failure; not merging');
    expect(bothRefusal).toContain('/branch process.exit(1)');
    expect(bothRefusal).toContain('/main process.exit(1)');
    expect(bothRefusal).not.toContain(both);
  });

  test('a transcript that mentions a start step does not hide a product crash', async () => {
    const file = 'services/main/tests/not-a-function.test.ts';
    const transcript = 'Command failed: pg_ctl -D data -w start\npg_ctl: could not start server';
    const classified = await classifyBranchOnlyFailures([file], new Set(), '/branch', '/main', async (cwd, files) => {
      const name = files[0]!;
      if (cwd === '/main') return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [name], output: '', ms: 1 };
      return {
        done: true, failing: [name], timedOut: [],
        failures: [{ file: name, test: 'load is not a function', detail: 'TypeError: load is not a function' }],
        fileErrors: [], runnerErrors: [], files: [name], output: transcript, ms: 1,
      };
    });
    expect(classified.inconclusive).toEqual([]);
    expect(classified.introduced).toEqual([{ file, cases: ['load is not a function'], fileError: false }]);
    const pooled = 'services/main/tests/pool-transcript.test.ts';
    const fromTranscript = await classifyBranchOnlyFailures([pooled], new Set(), '/branch', '/main', async (cwd, files) => {
      const name = files[0]!;
      if (cwd === '/main') return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], files: [name], output: '', ms: 1 };
      return {
        done: true, failing: [name], timedOut: [],
        failures: [{ file: name, test: 'pool end runs', detail: "TypeError: undefined is not an object (evaluating 'pool.end')" }],
        fileErrors: [], runnerErrors: [], files: [name], output: transcript, ms: 1,
      };
    });
    expect(fromTranscript.inconclusive).toEqual([]);
    expect(fromTranscript.introduced).toEqual([{ file: pooled, cases: ['pool end runs'], fileError: false }]);
  });

  test('the unit gate refuses a checkout too deep for a PostgreSQL socket', () => {
    // Fixed paths, so the result does not depend on where this checkout lives.
    const main = '/tmp/rezics-socket-check';
    const taskTree = join(main, '.temp/worktrees/g-1000');
    expect(gateTreeRefusal(taskTree, main)).toBeUndefined();
    const nested = join(taskTree, '.temp/gate-scratch', 'x'.repeat(40));
    const refusal = gateTreeRefusal(nested, main);
    expect(refusal).toBe(postgresSocketRefusal(physicalPath(nested)));
    expect(refusal).toContain(physicalPath(nested));
    expect(refusal).toContain('bytes');
    expect(refusal).not.toContain('inconclusive');
    expect(Number(/(\d+) bytes/.exec(refusal ?? '')?.[1])).toBeGreaterThan(107);
  });

  test('cases in one shard output are attributed to their own files', async () => {
    const bounds = 'services/main/tests/library-public-bounds.test.ts';
    const checkout = 'services/main/tests/nested-pool-checkout.test.ts';
    const files = [bounds, checkout];
    const junit = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testsuite name="${bounds}" file="${bounds}">`,
      `<testcase name="library public bounds reject an oversize page" file="${bounds}">`,
      '<failure type="AssertionError" message="error: id 111&#10;port 54321"></failure>', '</testcase>',
      `<testcase name="library public bounds reject an oversize page" file="${bounds}">`,
      '<failure type="AssertionError" message="error: duplicate id"></failure>', '</testcase>',
      `<testcase name="library public bounds keep a passing case" file="${bounds}" />`,
      '</testsuite>',
      `<testsuite name="${checkout}" file="${checkout}">`,
      `<testcase name="nested pool checkout releases the client" file="${checkout}">`,
      '<failure type="AssertionError" message="error: id 222"></failure>', '</testcase>',
      '</testsuite>', '</testsuites>',
    ].join('\n');
    const output = [
      `${checkout}:`,
      '(fail) library public bounds reject an oversize page [1.00ms]',
      '(fail) nested pool checkout releases the client [2.00ms]',
      '2 tests failed:',
      '(fail) library public bounds reject an oversize page [1.00ms]',
      '(fail) nested pool checkout releases the client [2.00ms]',
      ' 0 pass', ' 2 fail',
      UNIT_JUNIT_MARKER, junit,
    ].join('\n');
    expect(unitFailureDetails(output, files).map(item => [item.file, item.test])).toEqual([
      [bounds, 'library public bounds reject an oversize page'],
      [checkout, 'nested pool checkout releases the client'],
    ]);
    expect(unitFailureDetails(output, files)[0]?.detail).toContain('port 54321');
    const evidence = unitFileEvidence(output, files, files, []);
    expect(evidence.find(item => item.file === bounds)?.cases.map(item => item.test))
      .toEqual(['library public bounds reject an oversize page']);
    expect(evidence.find(item => item.file === checkout)?.cases.map(item => item.test))
      .toEqual(['nested pool checkout releases the client']);
    const summary = [
      `${checkout}:`, '(pass) local case',
      '2 tests failed:',
      '(fail) library public bounds reject an oversize page [1.00ms]',
      '(fail) nested pool checkout releases the client [2.00ms]',
    ].join('\n');
    expect(failingTestFiles(summary, files)).toEqual([]);
    expect(unitFailureDetails(summary, files)).toEqual([]);
    const runs: UnitRunEvidence[] = [];
    const side = await runUnitSide('/repo', files, 'affected', runs, async () => ({
      done: true, failing: [checkout], timedOut: [],
      failures: [{ file: checkout, test: 'library public bounds reject an oversize page' }],
      fileErrors: [], runnerErrors: [], files, output, ms: 1,
    }));
    expect(side.failing).toEqual(files);
    const kept = runs.flatMap(run => run.files);
    expect(kept.find(item => item.file === bounds)?.cases.map(item => item.test))
      .toEqual(['library public bounds reject an oversize page']);
    expect(kept.find(item => item.file === checkout)?.cases.map(item => item.test))
      .toEqual(['nested pool checkout releases the client']);
  });

  test('owner cases stay with their files when unit junit shares the shard output', async () => {
    const bounds = 'services/main/tests/library-public-bounds.test.ts';
    const checkout = 'services/main/tests/nested-pool-checkout.test.ts';
    const unit = 'tests/qa/unit/search-private-budget.test.ts';
    const files = [bounds, checkout, unit];
    const carried = 'A carried count stays approximate and never shows a Work hidden mid-walk';
    const restore = 'restore reconciliation reuses the held access and relay connections';
    const budget = 'SEARCH10: private Fuseki call count rejects an invalid budget before reading';
    const junit = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testsuite name="${unit}" file="${unit}">`,
      `<testcase name="${budget}" file="${unit}">`,
      '<failure type="AssertionError" message="error: invalid budget"></failure>', '</testcase>',
      `<testcase name="private budget accepts a limit" file="${unit}" />`,
      '</testsuite>', '</testsuites>',
    ].join('\n');
    // Unit output, including its JUnit block, is joined ahead of the owner transcript.
    const output = [
      UNIT_JUNIT_MARKER, junit,
      `${bounds}:`, `(fail) ${carried} [1.00ms]`,
      `${checkout}:`, `(fail) ${restore} [2.00ms]`,
      ' 2 fail',
    ].join('\n');
    const runs: UnitRunEvidence[] = [];
    const side = await runUnitSide('/repo', files, 'affected', runs, async () => ({
      done: true, failing: [unit], timedOut: [],
      failures: [
        { file: bounds, test: carried },
        { file: checkout, test: restore },
        { file: unit, test: 'console name the junit replaces' },
      ],
      fileErrors: [], runnerErrors: [], files, output, ms: 1,
    }));
    expect(side.failing).toEqual([...files].sort());
    expect(side.failures.map(item => [item.file, item.test]).sort()).toEqual([
      [bounds, carried], [checkout, restore], [unit, budget],
    ].sort());
    const names = (file: string) => new Set(runs.flatMap(run => run.files)
      .filter(item => item.file === file).flatMap(item => item.cases.map(item => item.test)));
    // Joined shard transcripts repeat a case; the name still belongs to its own file.
    expect(names(bounds)).toEqual(new Set([carried]));
    expect(names(checkout)).toEqual(new Set([restore]));
    expect(names(unit)).toEqual(new Set([budget]));
  });

  test('a file that passes in junit is not failing when stdout prints fail and error lines', async () => {
    const file = 'scripts/goal/goalctl.test.ts';
    const omitted = 'scripts/goal/load-missing.test.ts';
    const junit = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testsuite name="${file}" file="${file}">`,
      `<testcase name="prints a stub gate" file="${file}" />`,
      '</testsuite>', '</testsuites>',
    ].join('\n');
    const output = [
      `${file}:`,
      '(fail) library public bounds reject an oversize page',
      'error: id 111',
      'Unit gate shard: 4 file(s), 1 failing in 1ms',
      UNIT_JUNIT_MARKER, junit,
    ].join('\n');
    expect(failingTestFiles(output, [file, omitted])).toEqual([]);
    expect(unitFailureDetails(output, [file, omitted])).toEqual([]);
    expect(unitFileErrorDetails(output, [file, omitted])).toEqual([]);
    expect(unitFileEvidence(output, [file], [file], []).find(item => item.file === file)?.fileError).toBeUndefined();
    const timedOut = [
      `${file}:`, '(fail) slow case', 'this test timed out after 5000ms',
      UNIT_JUNIT_MARKER, junit,
    ].join('\n');
    expect(timedOutTestFiles(timedOut, [file])).toEqual([file]);
    const load = [
      `${omitted}:`, '# Unhandled error between tests', 'error: Cannot find module \'./missing.ts\'',
      UNIT_JUNIT_MARKER, junit,
    ].join('\n');
    expect(failingTestFiles(load, [file, omitted])).toEqual([omitted]);
    expect(unitFileErrorDetails(load, [file, omitted]).map(item => item.file)).toEqual([omitted]);
    const runs: UnitRunEvidence[] = [];
    const side = await runUnitSide('/repo', [file], 'affected', runs, async () => ({
      done: true, failing: [file], timedOut: [], failures: [],
      fileErrors: [{ file, detail: 'error: id 111' }],
      runnerErrors: [], files: [file], output, ms: 1,
    }));
    expect(side.failing).toEqual([]);
    expect(side.fileErrors).toEqual([]);
  });

  test('a junit timeout that passes when the file runs alone is order or load dependent and not blocking', async () => {
    const slow = 'scripts/goal/goalctl.test.ts';
    const other = 'scripts/goal/goalctl-companion.test.ts';
    const bounds = 'services/main/tests/library-public-bounds.test.ts';
    const files = [slow, other];
    const caseName = 'a shard timeout stays inconclusive until the file runs alone';
    const printed = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testcase name="library public bounds reject an oversize page" file="${bounds}">`,
      '<failure type="AssertionError" message="error: id 111"></failure>', '</testcase>',
      '</testsuites>',
      // An unclosed testcase would swallow the next report's failure if the first marker were the report.
      `<testcase name="swallowed" file="${bounds}">`,
      '<failure type="AssertionError" message="error: id 111"></failure>',
    ].join('\n');
    const report = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testsuite name="${other}">`,
      `<testcase name="companion passes" file="${other}" />`,
      '</testsuite>',
      `<testsuite name="${slow}">`,
      `<testcase name="${caseName}" file="${slow}" time="18.8">`,
      '<failure type="TimeoutError" message="test timed out" />', '</testcase>',
      '</testsuite>', '</testsuites>',
    ].join('\n');
    const output = [
      `${other}:`, '(pass) companion passes [1.00ms]',
      `${bounds}:`, '(fail) library public bounds reject an oversize page [1.00ms]',
      'error: id 111', 'port 54321',
      UNIT_JUNIT_MARKER, printed,
      `${slow}:`, `(fail) ${caseName} [18762.28ms]`,
      UNIT_JUNIT_MARKER, report,
      `  ${UNIT_JUNIT_MARKER}`,
      `<testsuites><testcase name="nope" file="${other}"><failure message="nope"></failure></testcase></testsuites>`,
    ].join('\n');
    const candidates = [...files, bounds];
    expect(failingTestFiles(output, candidates)).toEqual([slow]);
    expect(timedOutTestFiles(output, candidates)).toEqual([slow]);
    expect(unitFailureDetails(output, candidates).map(item => [item.file, item.test])).toEqual([[slow, caseName]]);
    expect(unitFileErrorDetails(output, candidates)).toEqual([]);
    const previousShards = process.env.GOAL_UNIT_GATE_SHARDS;
    process.env.GOAL_UNIT_GATE_SHARDS = '1';
    const lines: string[] = [];
    const write = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    const calls: string[][] = [];
    try {
      const runs: UnitRunEvidence[] = [];
      const side = await runUnitSide('/repo', files, 'affected', runs, async (_cwd, group) => {
        calls.push([...group]);
        if (group.length === 1) {
          return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
            files: [...group], output: `${group[0]}:\n(pass) finishes [1.00ms]`, ms: 1 };
        }
        return {
          done: true, failing: [], timedOut: [], failures: [], fileErrors: [],
          runnerErrors: [{ files: ['runner'], diagnostic: 'task: Failed to run task "goal": exit status 1' }],
          files: [...group], output, ms: 1,
        };
      });
      expect(calls.map(group => [...group].sort())).toEqual([[...files].sort(), [slow]]);
      expect(side.failing).toEqual([]);
      expect(side.inconclusive).toEqual([]);
      expect(side.runnerErrors).toEqual([]);
      expect(side.orderDependent).toEqual([slow]);
      const printedLog = lines.join('\n');
      expect(printedLog).toContain('pass when run alone; order or load dependent, reported, not blocking');
      expect(printedLog).toContain(slow);
      expect(printedLog).not.toContain('unattributed');
      const first = runs.find(run => run.kind === 'first');
      expect(first?.files.some(file => file.file === slow && file.cases.some(item => item.test === caseName))).toBe(true);
      expect(first?.files.some(file => file.file === bounds)).toBe(false);
    } finally {
      console.log = write;
      if (previousShards === undefined) delete process.env.GOAL_UNIT_GATE_SHARDS;
      else process.env.GOAL_UNIT_GATE_SHARDS = previousShards;
    }
  });

  test('a passing file that prints fail lines naming other files makes no file fail', async () => {
    const printer = 'scripts/goal/goalctl.test.ts';
    const bounds = 'services/main/tests/library-public-bounds.test.ts';
    const checkout = 'services/main/tests/nested-pool-checkout.test.ts';
    const budget = 'tests/qa/unit/search-private-budget.test.ts';
    const files = [printer, bounds, checkout, budget];
    const printed = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testcase name="library public bounds reject an oversize page" file="${bounds}">`,
      '<failure type="AssertionError" message="error: id 111&#10;port 54321"></failure>', '</testcase>',
      `<testcase name="nested pool checkout releases the client" file="${checkout}">`,
      '<failure type="AssertionError" message="error: id 222"></failure>', '</testcase>',
      `<testcase name="SEARCH10: private Fuseki call count rejects an invalid budget before reading" file="${budget}">`,
      '<failure type="AssertionError" message="error: invalid budget"></failure>', '</testcase>',
      '</testsuites>',
    ].join('\n');
    const report = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testsuite name="${printer}">`,
      `<testcase name="prints a gate transcript" file="${printer}" />`,
      '</testsuite>', '</testsuites>',
    ].join('\n');
    const output = [
      `${printer}:`, '(pass) prints a gate transcript [0.40ms]',
      `${bounds}:`, '(fail) library public bounds reject an oversize page [1.00ms]',
      'error: id 111', 'port 54321',
      `${checkout}:`, '(fail) nested pool checkout releases the client [2.00ms]',
      'error: id 222',
      `${budget}:`, '(fail) SEARCH10: private Fuseki call count rejects an invalid budget before reading [3.00ms]',
      'error: invalid budget',
      UNIT_JUNIT_MARKER, printed,
      UNIT_JUNIT_MARKER, report,
    ].join('\n');
    expect(failingTestFiles(output, files)).toEqual([]);
    expect(unitFailureDetails(output, files)).toEqual([]);
    expect(unitFileErrorDetails(output, files)).toEqual([]);
    expect(timedOutTestFiles(output, files)).toEqual([]);
    expect(unitFileEvidence(output, files, [], [])).toEqual([]);
    const previousShards = process.env.GOAL_UNIT_GATE_SHARDS;
    process.env.GOAL_UNIT_GATE_SHARDS = '1';
    const write = console.log;
    console.log = () => {};
    try {
      const runs: UnitRunEvidence[] = [];
      const side = await runUnitSide('/repo', files, 'affected', runs, async () => ({
        done: true, failing: [bounds, checkout, budget], timedOut: [],
        failures: [
          { file: bounds, test: 'library public bounds reject an oversize page', detail: 'error: id 111\nport 54321' },
          { file: checkout, test: 'nested pool checkout releases the client', detail: 'error: id 222' },
          { file: budget, test: 'SEARCH10: private Fuseki call count rejects an invalid budget before reading', detail: 'error: invalid budget' },
        ],
        fileErrors: [
          { file: bounds, detail: 'error: id 111\nport 54321' },
          { file: checkout, detail: 'error: id 222' },
          { file: budget, detail: 'error: invalid budget' },
        ],
        runnerErrors: [], files, output, ms: 1,
      }));
      expect(side.failing).toEqual([]);
      expect(side.fileErrors).toEqual([]);
      expect(side.failures).toEqual([]);
      expect(side.runnerErrors).toEqual([]);
      expect(runs.flatMap(run => run.files)).toEqual([]);
    } finally {
      console.log = write;
      if (previousShards === undefined) delete process.env.GOAL_UNIT_GATE_SHARDS;
      else process.env.GOAL_UNIT_GATE_SHARDS = previousShards;
    }
  });

  test('the same permission case is inherited when only its subject text changes', () => {
    const file = 'tests/qa/unit/permissions.test.ts';
    const report = (...subjects: string[]): UnitFailureDetail[] => subjects.map(subject => ({ file,
      test: 'permission results preserve each subject path',
      detail: ['error: expect(received).toEqual(expected)', '- Expected  - 1', '+ Received  + 1', '  {',
        `    "${subject}": {`, '      + "permission": false,', '    },', '  }'].join('\n') }));
    const main = report('alice');
    const differentSubject = report('bob');
    const branch = report('alice', 'bob');
    const repeatedMain = report('alice', 'alice');

    expect(introducedUnitFailureFiles([file], differentSubject, main)).toEqual([]);
    expect(introducedUnitFailureFiles([file], branch, main)).toEqual([]);
    expect(introducedUnitFailureFiles([file], repeatedMain, repeatedMain)).toEqual([]);
  });

  test('real Bun permission diffs inherit a case whose subject text changed', () => {
    const file = '.temp/goal-gate-subject/permissions.test.ts';
    const root = process.cwd();
    // Assertion blocks captured from Bun runs with alice, bob, or both denied; only the fixture path is unified.
    const aliceDiff = [
      '@@ -2,3 +2,3 @@', '    "alice": {', '-     "permission": true,', '+     "permission": false,', '    },',
    ];
    const bobDiff = [
      '@@ -5,3 +5,3 @@', '    "bob": {', '-     "permission": true,', '+     "permission": false,', '    },',
    ];
    const bothDiff = [
      '@@ -2,6 +2,6 @@', '    "alice": {', '-     "permission": true,', '+     "permission": false,', '    },',
      '    "bob": {', '-     "permission": true,', '+     "permission": false,', '    },',
    ];
    const captured = (diff: string[], count: number) => unitFailureDetails([
      'bun test v1.4.2 (744846f84)', `${file}:`, 'error: expect(received).toEqual(expected)', '', ...diff, '',
      `- Expected  - ${count}`, `+ Received  + ${count}`, '',
      `      at <anonymous> (${root}/${file}:5:6)`, '(fail) permission results preserve each subject path [0.39ms]',
    ].join('\n'), [file], root);
    const alice = captured(aliceDiff, 1);
    const bob = captured(bobDiff, 1);
    const both = captured(bothDiff, 2);

    expect(alice).toHaveLength(1);
    expect(bob).toHaveLength(1);
    expect(both).toHaveLength(1);
    expect(introducedUnitFailureFiles([file], bob, alice)).toEqual([]);
    expect(introducedUnitFailureFiles([file], both, alice)).toEqual([]);
    expect(introducedUnitFailureFiles([file], alice, alice)).toEqual([]);
    expect(introducedUnitFailureFiles([file], both, both)).toEqual([]);
    expect(introducedUnitFailureFiles([file], alice, both)).toEqual([]);
    expect(introducedUnitFailureFiles([file], bob, both)).toEqual([]);
    expect(introducedUnitFailureFiles([], [], alice)).toEqual([]);
  });

  test('file-level load errors inherit when the normalized first line matches', () => {
    const file = 'tests/qa/unit/load-failure.test.ts';
    const branchRoot = '/tmp/worktrees/worker';
    const mainRoot = '/tmp/unit-gate-baseline';
    const output = (root: string, missing: string, line: number, column: number, duration: number,
      sourceLine: number, passes: number) => [
      `${file}:`, '# Unhandled error between tests',
      `error: Cannot find module '${root}/modules/${missing}.js' from '${root}/${file}' after ${duration}ms`,
      `    at load (${root}/runtime/loader.js:${line}:${column})`,
      `    ${sourceLine} | responseBytes: createResponseBytes()`, `${passes} pass`, '1 fail',
      `Ran ${passes + 1} tests across 1 files`,
    ].join('\n');
    const branch = unitFileErrorDetails(output(branchRoot, 'shared-module', 394, 7, 12, 39, 1), [file], branchRoot);
    const same = unitFileErrorDetails(output(mainRoot, 'shared-module', 398, 21, 31, 44, 7), [file], mainRoot);
    const different = unitFileErrorDetails(output(mainRoot, 'main-module', 398, 21, 31, 44, 7), [file], mainRoot);
    expect(branch).toHaveLength(1);
    expect(branch[0]!.detail).toBe(same[0]!.detail);
    expect(introducedUnitFailureFiles([file], [], [], branch, same)).toEqual([]);
    expect(introducedUnitFailureFiles([file], [], [], branch, different)).toEqual([file]);
  });

  test('a passing file that prints an indented gate transcript is not a file-level error', () => {
    const file = 'scripts/goal/goalctl.test.ts';
    const output = [
      `${file}:`,
      '(pass) unit gate evidence for classified runs > names each case [1.20ms]',
      'Unit gate: 5 file(s) in 1 shard(s), slowest budget 720000ms',
      'Unit gate shard: 1 file(s), 1 failing in 1ms',
      'Unit gate evidence (affected, first):',
      '  services/main/tests/library-public-bounds.test.ts',
      '    (fail) library public bounds reject an oversize page',
      '      error: id 111',
      '      port 54321',
      '  services/main/tests/nested-pool-checkout.test.ts',
      '    (fail) nested pool checkout releases the client',
      '      error: id 222',
      '(pass) the same file keeps passing [0.40ms]',
      ' 2 pass',
      ' 0 fail',
      'Ran 2 tests across 1 file. [4.00ms]',
    ].join('\n');
    expect(unitFileErrorDetails(output, [file])).toEqual([]);
    expect(failingTestFiles(output, [file])).toEqual([]);
    expect(timedOutTestFiles(output, [file])).toEqual([]);
    expect(unitFailureDetails(output, [file])).toEqual([]);
    expect(unitFileEvidence(output, [file], [], [])).toEqual([]);
    const load = [`${file}:`, "error: Cannot find module './missing-probe-import.ts'", ' 0 pass', ' 1 fail'].join('\n');
    expect(unitFileErrorDetails(load, [file])).toEqual([
      { file, detail: "error: Cannot find module './missing-probe-import.ts'" },
    ]);
  });

  test('a branch-only unhandled error blocks beside an inherited named test failure', () => {
    const file = 'tests/qa/unit/load-failure.test.ts';
    const root = '/tmp/worktrees/worker';
    const namedFailure = [
      `${file}:`, 'error: expect(received).toBe(expected)', '- Expected  - 1', '+ Received  + 1',
      '  + 1', `    at test (${root}/${file}:20:4)`, '(fail) existing guard > checks the baseline [1ms]',
    ].join('\n');
    const branchNamed = unitFailureDetails(namedFailure, [file], root);
    const mainNamed = unitFailureDetails(namedFailure, [file], root);
    const branchOutput = [
      namedFailure, '# Unhandled error between tests', `error: Cannot find module '${root}/modules/new-import.js'`,
      `    at load (${root}/runtime/loader.js:30:2)`, '1 fail', 'Ran 1 tests across 1 files',
    ].join('\n');
    const branchError = unitFileErrorDetails(branchOutput, [file], root);
    expect(introducedUnitFailureFiles([file], branchNamed, mainNamed, branchError, [])).toEqual([file]);
    const affected = unitFileEvidence(branchOutput, [file], [file], [], root);
    const inherited = unitFileEvidence(namedFailure, [file], [file], [], root);
    expect(affected[0]?.cases.map(item => item.test)).toEqual(['existing guard > checks the baseline']);
    expect(affected[0]?.fileError).toContain('# Unhandled error between tests');
    expect(affected[0]?.fileError).toContain('new-import.js');
    expect(inherited[0]?.cases.map(item => item.test)).toEqual(['existing guard > checks the baseline']);
    expect(inherited[0]?.fileError).toBeUndefined();
    const runs: UnitRunEvidence[] = [
      { side: 'affected', kind: 'confirm', files: affected },
      { side: 'main', kind: 'first', files: inherited },
    ];
    const refusal = unitGateRefusal('introduced unit failures; not merging:', [file], runs);
    const deciding = refusal.split('inherited on main:')[0] ?? refusal;
    expect(deciding).toContain('(fail) existing guard > checks the baseline');
    expect(deciding).toContain('# Unhandled error between tests');
    expect(deciding).toContain(`Cannot find module '${root}/modules/new-import.js'`);
    expect(refusal.split('inherited on main:')[1] ?? '').not.toContain('new-import.js');
    const previous = process.env.GOAL_MERGE_LOG;
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/unit-gate-evidence-'));
    process.env.GOAL_MERGE_LOG = join(directory, 'merge.log');
    try {
      const path = writeUnitEvidence(runs);
      const stored = JSON.parse(readFileSync(path!, 'utf8')) as { invocations: { runs: UnitRunEvidence[] }[] };
      const storedAffected = stored.invocations[0]!.runs.find(run => run.side === 'affected')!.files[0]!;
      const storedMain = stored.invocations[0]!.runs.find(run => run.side === 'main')!.files[0]!;
      expect(storedAffected.fileError).toContain('new-import.js');
      expect(storedAffected.cases[0]?.test).toBe('existing guard > checks the baseline');
      expect(storedMain.fileError).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.GOAL_MERGE_LOG;
      else process.env.GOAL_MERGE_LOG = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('the same scalar case is inherited when only its message changes', () => {
    const file = 'tests/qa/unit/load-failure.test.ts';
    const branchRoot = '/tmp/worktrees/worker';
    const mainRoot = '/tmp/unit-gate-baseline';
    const output = (root: string, message: string, line: number, column: number, duration: number) => [
      `${file}:`, `error: ReferenceError: ${message} at ${root}/src/restore-lineage.ts:${line}:${column} after ${duration}ms`,
      `(fail) load guard > resolves restore lineage [${duration}.1ms]`,
    ].join('\n');
    const branch = unitFailureDetails(output(branchRoot, 'existing problem', 394, 7, 12), [file], branchRoot);
    const same = unitFailureDetails(output(mainRoot, 'existing problem', 398, 21, 31), [file], mainRoot);
    const different = unitFailureDetails(output(mainRoot, 'new regression', 398, 21, 31), [file], mainRoot);
    expect(introducedUnitFailureFiles([file], branch, same)).toEqual([]);
    expect(introducedUnitFailureFiles([file], branch, different)).toEqual([]);
    const added = [{ file, test: 'load guard > rejects a new caller', detail: different[0]?.detail }];
    expect(introducedUnitFailureFiles([file], added, same)).toEqual([file]);
  });

  test('a removed named failure does not block when the file-level error remains identical', () => {
    const file = 'tests/qa/unit/load-failure.test.ts';
    const loadError = [{ file, detail: 'Cannot find module "shared-module.js"' }];
    const mainTestFailure = [{ file, test: 'fixed-on-branch', detail: 'error: assertion from main' }];
    expect(introducedUnitFailureFiles([file], [], mainTestFailure, loadError, loadError)).toEqual([]);
  });

  test('real Bun 1.4.2 failure output keeps native exceptions and scalar errors distinct', () => {
    const file = '.temp/goal-gate-probes/a-typeerror.test.ts';
    const root = process.cwd();
    // These are the relevant lines captured from the real one-file Bun runs in .temp/goal-gate-probes.
    const captured = (errorType: string, message: string, line: number) => [
      'bun test v1.4.2 (744846f84)', `${file}:`,
      "1 | import { test } from 'bun:test';", '2 |', "3 | test('throws a native error', () => {",
      `4 |   throw new ${errorType}('${message}');`, '                                                     ^',
      `${errorType}: ${message}`,
      `      at <anonymous> (${root}/${file}:4:${line})`, '(fail) throws a native error [0.23ms]',
      ' 0 pass', ' 1 fail', 'Ran 1 test across 1 file. [3.00ms]',
      'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    const typeError = unitFailureDetails(captured('TypeError', 'native type failure probe', 50), [file], root);
    const referenceError = unitFailureDetails(captured('ReferenceError', 'native reference failure probe', 60), [file], root);
    expect(typeError[0]?.test).toBe('throws a native error');
    expect(typeError[0]?.detail).toContain('TypeError: native type failure probe');
    expect(referenceError[0]?.detail).toContain('ReferenceError: native reference failure probe');
    expect(introducedUnitFailureFiles([file], referenceError, typeError)).toEqual([]);

    const scalarFile = '.temp/goal-gate-probes/d-scalar.test.ts';
    const scalar = (expected: number, received: number) => [
      'bun test v1.4.2 (744846f84)', `${scalarFile}:`,
      "1 | import { expect, test } from 'bun:test';", '2 |', "3 | test('has a scalar assertion failure', () => {",
      `4 |   expect(${received}).toBe(${expected});`, '                ^',
      'error: expect(received).toBe(expected)', '', `Expected: ${expected}`, `Received: ${received}`,
      `      at <anonymous> (${root}/${scalarFile}:4:13)`, '(fail) has a scalar assertion failure [0.30ms]',
      ' 0 pass', ' 1 fail', 'Ran 1 test across 1 file. [4.00ms]',
      'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    const oldScalar = unitFailureDetails(scalar(1, 2), [scalarFile], root);
    const newScalar = unitFailureDetails(scalar(1, 3), [scalarFile], root);
    expect(introducedUnitFailureFiles([scalarFile], newScalar, oldScalar)).toEqual([]);
  });

  test('real Bun assertion, unhandled rejection, import error, and timeout output retain their findings', () => {
    const root = process.cwd();
    const diffFile = '.temp/goal-gate-probes/c-equal-diff.test.ts';
    const diffOutput = [
      'bun test v1.4.2 (744846f84)', `${diffFile}:`,
      "1 | import { expect, test } from 'bun:test';", '2 |', "3 | test('has an object assertion diff', () => {",
      "4 |   expect({ restore: 'new' }).toEqual({ restore: 'old' });", '                                 ^',
      'error: expect(received).toEqual(expected)', '', '  {', '-   "restore": "old",', '+   "restore": "new",', '  }', '',
      '- Expected  - 1', '+ Received  + 1',
      `      at <anonymous> (${root}/${diffFile}:4:30)`, '(fail) has an object assertion diff [0.33ms]',
      ' 0 pass', ' 1 fail', 'Ran 1 test across 1 file. [3.00ms]',
      'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    const sameDiff = unitFailureDetails(diffOutput, [diffFile], root);
    const addedDiff = unitFailureDetails(diffOutput.replace('"restore": "new"', '"restore": "newer"'), [diffFile], root);
    expect(introducedUnitFailureFiles([diffFile], sameDiff, sameDiff)).toEqual([]);
    expect(introducedUnitFailureFiles([diffFile], addedDiff, sameDiff)).toEqual([]);

    const rejectionFile = '.temp/goal-gate-probes/e-unhandled-rejection.test.ts';
    const rejection = (message: string) => [
      'bun test v1.4.2 (744846f84)', `${rejectionFile}:`,
      "1 | import { test } from 'bun:test';", '2 |', "3 | test('leaves an unhandled rejection', async () => {",
      `4 |   queueMicrotask(() => { void Promise.reject(new Error('${message}')); });`, '                                                     ^',
      `error: ${message}`, `      at <anonymous> (${root}/${rejectionFile}:4:50)`,
      '(fail) leaves an unhandled rejection [0.36ms]', ' 0 pass', ' 1 fail',
      'Ran 1 test across 1 file. [4.00ms]', 'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    const oldRejection = unitFailureDetails(rejection('unhandled rejection probe'), [rejectionFile], root);
    const newRejection = unitFailureDetails(rejection('new rejection regression'), [rejectionFile], root);
    expect(oldRejection[0]?.detail).toContain('error: unhandled rejection probe');
    expect(introducedUnitFailureFiles([rejectionFile], newRejection, oldRejection)).toEqual([]);

    const importFile = '.temp/goal-gate-probes/f-import-error.test.ts';
    const importOutput = (worktree: string, errors: string[]) => [
      'bun test v1.4.2 (744846f84)', `${importFile}:`, '',
      ...errors.flatMap(error => ['# Unhandled error between tests', '-------------------------------',
        `error: Cannot find module '${error}' from '${worktree}/${importFile}'`, '-------------------------------', '']),
      ' 0 pass', ` ${errors.length} fail`, ` ${errors.length} error`,
      `Ran ${errors.length} test across 1 file. [3.00ms]`,
      'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    const branchErrors = unitFileErrorDetails(importOutput(root, ['./missing-probe-import.ts']), [importFile], root);
    const sameErrors = unitFileErrorDetails(importOutput('/tmp/unit-gate-baseline', ['./missing-probe-import.ts']), [importFile], '/tmp/unit-gate-baseline');
    const twoMainErrors = unitFileErrorDetails(importOutput('/tmp/unit-gate-baseline', ['./missing-probe-import.ts', './another-missing.ts']),
      [importFile], '/tmp/unit-gate-baseline');
    expect(branchErrors).toHaveLength(1);
    expect(branchErrors[0]?.detail).toContain("Cannot find module './missing-probe-import.ts'");
    expect(introducedUnitFailureFiles([importFile], [], [], branchErrors, sameErrors)).toEqual([]);
    expect(introducedUnitFailureFiles([importFile], [], [], branchErrors, twoMainErrors)).toEqual([]);

    const timeoutFile = '.temp/goal-gate-probes/g-timeout.test.ts';
    const timeoutOutput = [
      'bun test v1.4.2 (744846f84)', `${timeoutFile}:`, '(fail) times out [20.10ms]',
      '  ^ this test timed out after 20ms.', ' 0 pass', ' 1 fail',
      'Ran 1 test across 1 file. [24.00ms]', 'task: Failed to run task "goal:unit-files": exit status 1',
    ].join('\n');
    expect(timedOutTestFiles(timeoutOutput, [timeoutFile])).toEqual([timeoutFile]);
  });

  test('real file-level import errors remain separate signatures and remove cleanly', () => {
    const file = '.temp/goal-gate-probes/f-import-error.test.ts';
    const output = (names: string[]) => [
      `${file}:`, ...names.flatMap(name => ['# Unhandled error between tests', '-------------------------------',
        `error: Cannot find module './${name}.ts'`, '-------------------------------']),
      ' 0 pass', ` ${names.length} fail`, ` ${names.length} error`,
    ].join('\n');
    const main = unitFileErrorDetails(output(['missing-probe-import', 'another-missing']), [file]);
    const branch = unitFileErrorDetails(output(['missing-probe-import']), [file]);
    expect(main).toHaveLength(2);
    expect(branch).toHaveLength(1);
    expect(introducedUnitFailureFiles([file], [], [], branch, main)).toEqual([]);
  });

  test('real combined Bun output attributes each test and unhandled import error', () => {
    const root = process.cwd();
    const files = [
      '.temp/goal-gate-probes/a-typeerror.test.ts', '.temp/goal-gate-probes/b-referenceerror.test.ts',
      '.temp/goal-gate-probes/c-equal-diff.test.ts', '.temp/goal-gate-probes/d-scalar.test.ts',
      '.temp/goal-gate-probes/e-unhandled-rejection.test.ts', '.temp/goal-gate-probes/f-import-error.test.ts',
      '.temp/goal-gate-probes/g-timeout.test.ts',
    ];
    // Captured from one real task goal:unit-files invocation over all seven probes.
    const output = [
      `task: [goal:unit-files] bun test ${files.map(file => `./${file}`).join(' ')}`,
      'bun test v1.4.2 (744846f84)',
      `${files[0]}:`, "1 | import { test } from 'bun:test';", '2 |', "3 | test('throws a TypeError', () => {",
      "4 |   throw new TypeError('native type failure probe');", '                                                     ^',
      'TypeError: native type failure probe', `      at <anonymous> (${root}/${files[0]}:4:50)`,
      '(fail) throws a TypeError [0.26ms]',
      `${files[1]}:`, "1 | import { test } from 'bun:test';", '2 |', "3 | test('throws a ReferenceError', () => {",
      "4 |   throw new ReferenceError('native reference failure probe');", '                                                               ^',
      'ReferenceError: native reference failure probe', `      at <anonymous> (${root}/${files[1]}:4:60)`,
      '(fail) throws a ReferenceError [0.06ms]',
      `${files[2]}:`, "1 | import { expect, test } from 'bun:test';", '2 |', "3 | test('has an object assertion diff', () => {",
      "4 |   expect({ restore: 'new' }).toEqual({ restore: 'old' });", '                                 ^',
      'error: expect(received).toEqual(expected)', '', '  {', '-   "restore": "old",', '+   "restore": "new",', '  }', '',
      '- Expected  - 1', '+ Received  + 1', `      at <anonymous> (${root}/${files[2]}:4:30)`,
      '(fail) has an object assertion diff [0.22ms]',
      `${files[3]}:`, "1 | import { expect, test } from 'bun:test';", '2 |', "3 | test('has a scalar assertion failure', () => {",
      '4 |   expect(2).toBe(1);', '                ^', 'error: expect(received).toBe(expected)', '',
      'Expected: 1', 'Received: 2', `      at <anonymous> (${root}/${files[3]}:4:13)`,
      '(fail) has a scalar assertion failure [0.06ms]',
      `${files[4]}:`, "1 | import { test } from 'bun:test';", '2 |', "3 | test('leaves an unhandled rejection', async () => {",
      '4 |   queueMicrotask(() => { void Promise.reject(new Error(\'unhandled rejection probe\')); });', '                                                     ^',
      'error: unhandled rejection probe', `      at <anonymous> (${root}/${files[4]}:4:50)`,
      '(fail) leaves an unhandled rejection [0.22ms]',
      `${files[5]}:`, '', '# Unhandled error between tests', '-------------------------------',
      `error: Cannot find module './missing-probe-import.ts' from '${root}/${files[5]}'`, '-------------------------------',
      `${files[6]}:`, '(fail) times out [20.07ms]', '  ^ this test timed out after 20ms.',
      ' 0 pass', ' 7 fail', ' 1 error', ' 2 expect() calls', 'Ran 7 tests across 7 files. [26.00ms]',
    ].join('\n');
    expect(failingTestFiles(output, files, root)).toEqual(files);
    expect(unitFailureDetails(output, files, root)).toHaveLength(6);
    expect(unitFileErrorDetails(output, files, root, files)).toHaveLength(1);
    expect(timedOutTestFiles(output, files, root)).toEqual([files[6]!]);
  });

  test('loads reset status by GET, caches it, and projects account runway from the later reset boundary', async () => {
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/codex-reset-status-test-'));
    const cacheFile = join(directory, 'status.json');
    const nowMs = 1_800_000_000_000;
    const now = nowMs / 1000;
    const announcedAt = new Date((now - 12 * 3600) * 1000).toISOString();
    const stub = { data: { latest_reset: { announced_at: announcedAt }, stats: { avg_interval_days: 6.8 } } };
    let calls = 0;
    try {
      const loaded = await loadCodexResetStatus({ cacheFile, nowMs, fetcher: async (url, init) => {
        calls++;
        expect(url).toBe('https://codex-resets.com/api/v1/status');
        expect(init?.method).toBe('GET');
        expect(init?.headers).toEqual({ accept: 'application/json' });
        return new Response(JSON.stringify(stub), { status: 200 });
      } });
      expect(loaded).toMatchObject({ available: true, fetchedAt: nowMs, status: stub });
      const cached = await loadCodexResetStatus({ cacheFile, nowMs: nowMs + 60_000,
        fetcher: async () => { throw new Error('fresh cache should avoid fetch'); } });
      expect(cached.available).toBe(true);
      expect(calls).toBe(1);
      const account: AccountUsage = { account: 'codex', home: '', engines: ['codex'], used: 40,
        windowMinutes: 7 * 24 * 60, windowResetsAt: now + 2 * 24 * 3600, sampledAt: now };
      expect(codexHoursUntil100(account, loaded.status?.data?.latest_reset?.announced_at, nowMs)).toBe(18);
      const oldFullSample = { ...account, used: 100, sampledAt: now - 3600 };
      expect(codexHoursUntil100(oldFullSample, new Date((now - 1800) * 1000).toISOString(), nowMs)).toBeUndefined();
      expect(codexHoursUntil100({ ...oldFullSample, sampledAt: now - 900 },
        new Date((now - 1800) * 1000).toISOString(), nowMs)).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a failed reset fetch reports unavailable and still returns ordinary usage data', async () => {
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/codex-reset-failure-test-'));
    try {
      const report = await usageReport({ cacheFile: join(directory, 'status.json'), fetcher: async () => {
        throw new Error('offline');
      } });
      expect(report.codex_resets).toEqual({ source: 'Data from codex-resets.com', status: 'unavailable' });
      expect(report.claude).toBeDefined();
      expect(report.codex).toHaveLength(2);
      expect(report.codex.every(account => account.hours_until_100_percent === 'unavailable')).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a prompt that starts like an option stays a prompt (brief frontmatter) on every engine', () => {
    const prompt = '---\nid: G-041\n---';
    for (const resume of [false, true]) {
      for (const engine of ['claude', 'sonnet', 'codex', 'luna', 'cursor'] as const) {
        const [, args] = launchCommand({ id: 'G-041', effort: 'high', session: 's', prompt, engine, resume });
        expect(args.slice(-2)).toEqual(['--', prompt]);
        expect(args.filter(arg => arg === prompt)).toHaveLength(1);
      }
      const [, grok] = launchCommand({ id: 'G-041', effort: 'high', session: 's', prompt, engine: 'grok', resume });
      expect(grok.at(-1)).toBe(`--single=${prompt}`);
      expect(grok).not.toContain(prompt);
    }
  });

  test('pins the Opus model, effort and bypass permission mode without inbound session messages', () => {
    const [program, args] = launchCommand({ id: 'G-040', effort: 'medium', session: 's', prompt: 'p', resume: false });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-opus-5-5', '--effort', 'medium',
      '--dangerously-skip-permissions', '--session-id', 's', '-n', 'g-040']));
    expect(args.join(' ')).not.toContain('crossSessionInbound');
    expect(launchCommand({ id: 'G-040', effort: 'high', session: 's', prompt: 'p', resume: true })[1])
      .toEqual(expect.arrayContaining(['--resume', 's']));
  });

  test('runs Fable through Claude Code with its own model and a named session', () => {
    const [program, args] = launchCommand({ id: 'G-041', effort: 'xhigh', session: 's', prompt: 'p', resume: false,
      engine: 'fable' });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', 'claude-fable-5-1', '--effort', 'xhigh',
      '--session-id', 's', '-n', 'g-041']));
  });

  test('runs Sonnet through Claude Code with its own model and a named session', () => {
    const [program, args] = launchCommand({ id: 'G-042', effort: 'high', session: 's', prompt: 'p', resume: false,
      engine: 'sonnet' });
    expect(program).toBe('claude');
    expect(args).toEqual(expect.arrayContaining(['--model', SONNET_MODEL, '--effort', 'high',
      '--session-id', 's', '-n', 'g-042']));
  });

  test('pins GPT-6.1 Sol and the reasoning effort for Codex workers in their worktree', () => {
    const [program, args] = launchCommand({ id: 'G-081', effort: 'xhigh', session: '', prompt: 'p', resume: false,
      engine: 'codex', worktree: '/w', lastMessage: '/r/last.md' });
    expect(program).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['exec', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=xhigh',
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', '/r/last.md', '-C', '/w']));
    expect(launchCommand({ id: 'G-081', effort: 'high', session: 't', prompt: 'p', resume: true, engine: 'codex' })[1]
      .slice(0, 3)).toEqual(['exec', 'resume', 't']);
  });

  test('runs Sol on the second Codex account with the same flags; its account is chosen by environment', () => {
    const [program, args] = launchCommand({ id: 'G-101', effort: 'max', session: '', prompt: 'p', resume: false,
      engine: 'codex-1', worktree: '/w', lastMessage: '/r/a.md' });
    expect(program).toBe('codex');
    expect(args).toEqual(expect.arrayContaining(['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=max', '-C', '/w']));
  });

  test('runs Grok 4.7 through Cursor Agent with the effort in the model ID', () => {
    const [program, args] = launchCommand({ id: 'G-102', effort: 'xhigh', session: 'c', prompt: 'p', resume: true,
      engine: 'cursor', worktree: '/w' });
    expect(program).toBe('cursor-agent');
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'grok-4.7-xhigh', '--force', '--trust',
      '--output-format', 'json', '--workspace', '/w', '--resume', 'c']));
  });

  test('pins GPT-6 Luna through Codex and Grok 4.7 in bypass mode for simpler workers', () => {
    const luna = launchCommand({ id: 'G-094', effort: 'high', session: '', prompt: 'p', resume: false,
      engine: 'luna', worktree: '/w', lastMessage: '/r/l.md' });
    expect(luna[0]).toBe('codex');
    expect(luna[1]).toEqual(expect.arrayContaining(['-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=high']));
    const [program, args] = launchCommand({ id: 'G-095', effort: 'high', session: 's', prompt: 'p', resume: true,
      engine: 'grok', worktree: '/w' });
    expect(program).toBe('grok');
    expect(args).toEqual(expect.arrayContaining(['-m', 'grok-4.7', '--permission-mode', 'bypassPermissions',
      '--no-subagents', '--output-format', 'json', '--cwd', '/w', '-r', 's']));
  });

  test('accepts the efforts each engine supports and rejects unknown engines', () => {
    const brief = (engine: string, effort: string) =>
      parseBrief(`---\nid: G-081\ntitle: t\neffort: ${effort}\nengine: ${engine}\n---\n`);
    expect(validateBrief(brief('codex', 'ultra'))).toEqual([]);
    expect(validateBrief(brief('claude', 'max'))).toEqual([]);
    expect(validateBrief(brief('fable', 'max'))).toEqual([]);
    expect(validateBrief(brief('sonnet', 'max'))).toEqual([]);
    expect(validateBrief(brief('codex-1', 'ultra'))).toEqual([]);
    expect(validateBrief(brief('astra', 'high')).join()).toContain('engine must be one of');
    expect(validateBrief(brief('cursor', 'xhigh'))).toEqual([]);
    expect(validateBrief(brief('luna', 'ultra')).join()).toContain('luna effort');
    expect(validateBrief(brief('grok', 'xhigh')).join()).toContain('grok effort');
    expect(validateBrief(brief('gemini', 'high')).join()).toContain('engine must be one of');
  });
});

function gitShow(rev: string, path: string): string {
  const result = spawnSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

describe('goalctl composition merge', () => {
  const signatures = (source: string) => source.split('\n').filter(line => /^(export )?function /.test(line));

  test('normalizes the G-629 union chain without rewriting signatures', () => {
    // fdcb726e is the rebased app.ts goalctl then rewrote in ee678f81: realmAdminRoutes twice, a `;`
    // in the middle of the chain, and the mountedReads parameter still present.
    const input = gitShow('fdcb726e', 'services/main/src/app.ts');
    const broken = [
      '    .use(realmAdminRoutes(work));',
      '    .use(realmAdminRoutes(work))',
      '    .use(memberReplyRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
    ].join('\n');
    const fixed = [
      '    .use(realmAdminRoutes(work))',
      '    .use(memberReplyRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
    ].join('\n');
    expect(input).toContain(broken);
    expect(input).toContain('function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>)');
    expect(compositionSyntaxFailure('services/main/src/app.ts', input)).toContain('services/main/src/app.ts');

    const decision = prepareCompositionMerge([{ file: 'services/main/src/app.ts', source: input }]);
    expect(decision.fastForward).toBe(true);
    expect(decision.files[0]!.source).toBe(input.replace(broken, fixed));
    expect(signatures(decision.files[0]!.source)).toEqual(signatures(input));
    expect(decision.files[0]!.source).toContain('.use(domainRoutes(fuseki, work, () => new Set(app.routes');
    expect(normalizeUseChains(decision.files[0]!.source)).toBe(decision.files[0]!.source);
    // ee678f81 is the normalization that dropped the parameter. That rewrite must not come back.
    const dropped = gitShow('ee678f81', 'services/main/src/app.ts');
    expect(dropped).toContain('function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies) {');
    expect(decision.files[0]!.source).not.toBe(dropped);
  });

  test('keeps .use() calls that differ and leaves a clean composition root unchanged', () => {
    const distinct = [
      'function domainRoutes(work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>) {',
      '  return new Elysia()',
      '    .use(entityPageRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads));',
      '}',
      '',
    ].join('\n');
    expect(normalizeUseChains(distinct)).toBe(distinct);
    const current = readFileSync('services/main/src/app.ts', 'utf8');
    expect(normalizeUseChains(current)).toBe(current);
    expect(prepareCompositionMerge([{ file: 'services/main/src/app.ts', source: current }]).fastForward).toBe(true);
  });

  test('refuses the merge when a composition root still does not parse', () => {
    const source = [
      'function domainRoutes(fuseki: FusekiClient, work: SearchRouteDependencies, mountedReads: () => ReadonlySet<string>) {',
      '  return new Elysia()',
      '    .use(realmAdminRoutes(work))',
      '    .use(entityPageRoutes(work, mountedReads)',
      '}',
      '',
    ].join('\n');
    const decision = prepareCompositionMerge([{ file: 'services/main/src/app.ts', source }]);
    expect(decision.fastForward).toBe(false);
    expect(decision.state).toBe('conflict');
    expect(decision.error).toContain('services/main/src/app.ts');
    expect(decision.error).toMatch(/:\d+:\d+:/);
    expect(decision.files[0]!.source).toContain('mountedReads: () => ReadonlySet<string>');
    expect(signatures(decision.files[0]!.source)).toEqual(signatures(source));
  });
});

describe('goalctl close', () => {
  test('keeps a removed worktree\'s .temp artifacts beside the task run records', () => {
    const base = mkdtempSync(join(tmpdir(), 'goalctl-close-'));
    try {
      const worktree = join(base, 'wt'), runDir = join(base, 'runs', 'G-1');
      mkdirSync(join(worktree, '.temp', 'g-1'), { recursive: true });
      writeFileSync(join(worktree, '.temp', 'g-1', 'fix.patch'), 'patch');
      const first = preserveWorktreeArtifacts(worktree, runDir)!;
      expect(readFileSync(join(first, 'g-1', 'fix.patch'), 'utf8')).toBe('patch');
      expect(existsSync(join(worktree, '.temp'))).toBe(false);
      mkdirSync(join(worktree, '.temp'), { recursive: true });
      const second = preserveWorktreeArtifacts(worktree, runDir)!;
      expect(second).not.toBe(first);
      expect(preserveWorktreeArtifacts(worktree, runDir)).toBeNull();
    } finally { rmSync(base, { recursive: true, force: true }); }
  });
});

describe('goalctl Goals', () => {
  test('a brief belongs to the Goal whose directory holds it; the pre-Goal tasks directory has none', () => {
    expect(goalOfBriefPath('docs/goals/addresses-discovery/tasks/G-1065.md')).toBe('addresses-discovery');
    expect(goalOfBriefPath('docs/goals/tasks/G-1064.md')).toBeUndefined();
    expect(goalOfBriefPath('docs/goals/tasks/tasks/G-1064.md')).toBeUndefined();
    expect(goalOfBriefPath('docs/goals/addresses-discovery/GOAL.md')).toBeUndefined();
  });

  test('another active Goal\'s areas refuse a claim; the own Goal\'s and unowned paths do not', () => {
    const areas = { discovery: goalAreas('---\nareas: [services/main/src/modules/discovery/**, apps/web/features/discover/**]\n---\n# Goal\n'),
      production: [] };
    expect(areas.discovery).toEqual(['services/main/src/modules/discovery/**', 'apps/web/features/discover/**']);
    expect(areaConflicts(['services/main/src/modules/discovery/read.ts'], 'production', areas))
      .toEqual(['path services/main/src/modules/discovery/read.ts lies in Goal discovery\'s area services/main/src/modules/discovery/**']);
    expect(areaConflicts(['apps/web/features/**'], 'production', areas)).toHaveLength(1);
    expect(areaConflicts(['services/main/src/modules/discovery/**'], 'discovery', areas)).toEqual([]);
    expect(areaConflicts(['services/main/src/modules/poll/**'], 'production', areas)).toEqual([]);
    expect(goalAreas('# A Goal without frontmatter\n')).toEqual([]);
    expect(goalAreas('---\n# areas: other Goals keep out\nareas:\n  - services/main/src/modules/feed/**  # the feeds\n  - apps/web/features/shell/**\n---\n'))
      .toEqual(['services/main/src/modules/feed/**', 'apps/web/features/shell/**']);
  });

  test('IDs continue after every used, reserved and archived number', () => {
    expect(nextTaskId(['G-1063', 'G-999', 'G-040', 'notes'], 1064)).toBe('G-1065');
    expect(nextTaskId(['G-1066'], 1064)).toBe('G-1067');
    expect(nextTaskId([])).toBe('G-001');
  });

  test('a manager may change only its own Goal\'s tasks', () => {
    expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' }, 'production')).toContain('belongs to Goal discovery');
    expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' }, 'discovery')).toBeUndefined();
    const goal = process.env.GOAL_ID;
    delete process.env.GOAL_ID;
    try { expect(ownerRefusal({ id: 'G-1065', goal: 'discovery' })).toBeUndefined(); }
    finally { if (goal === undefined) delete process.env.GOAL_ID; else process.env.GOAL_ID = goal; }
    expect(ownerRefusal({ id: 'G-900' }, 'production')).toBeUndefined();
  });

  test('affected sets, whole tiers and --heavy runs are heavy; explicit files and plans are not', () => {
    expect(isHeavyTest(['--affected'])).toBe(true);
    expect(isHeavyTest(['--affected=main~3'])).toBe(true);
    expect(isHeavyTest(['--tier', 'integration'])).toBe(true);
    expect(isHeavyTest(['--result-file', 'slot.json', '--tier', 'integration'])).toBe(true);
    expect(isHeavyTest(['--tier', 'integration', '--file', 'tests/qa/integration/a.test.ts'])).toBe(false);
    expect(isHeavyTest(['--result-file', 'slot.json', '--tier', 'owner', '--file', 'scripts/goal/regress.test.ts'])).toBe(false);
    for (const tier of ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'load']) {
      expect(isHeavyTest(['--tier', tier, '--file', 'tests/example.test.ts'])).toBe(false);
    }
    for (const tier of ['e2e', 'accounts:storybook', 'future-browser']) {
      expect(isHeavyTest(['--tier', tier, '--file', 'apps/web/tests/example.e2e.ts'])).toBe(true);
      expect(isHeavyTest(['--result-file', 'slot.json', '--tier', tier, '--file', 'apps/web/tests/example.e2e.ts'])).toBe(true);
    }
    expect(isHeavyTest(['--tier', 'e2e', '--storybook', '--file', 'apps/web/tests/example.e2e.ts'])).toBe(true);
    expect(isHeavyTest(['--heavy', 'tests/qa/integration/a.test.ts'])).toBe(true);
    expect(isHeavyTest(['--affected', '--list'])).toBe(false);
    expect(isHeavyTest(['tests/qa/integration/a.test.ts'])).toBe(false);
  });
});

describe('goalctl reclaim', () => {
  interface LedgerFile { tasks: Record<string, { paths: string[]; brief: string }> }

  /** Two active Goals and an exited task whose brief can be replaced without a worktree. */
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-reclaim-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, encoding: 'utf8' });
    mkdirSync(join(dir, 'docs/goals/alpha'), { recursive: true });
    mkdirSync(join(dir, 'docs/goals/beta'), { recursive: true });
    writeFileSync(join(dir, 'docs/goals/alpha/GOAL.md'),
      '---\nareas: [services/main/src/modules/alpha/**]\n---\n# Alpha\n');
    writeFileSync(join(dir, 'docs/goals/beta/GOAL.md'),
      '---\nareas: [services/main/src/modules/beta/**]\n---\n# Beta\n');
    const task = (id: string, goal: string, paths: string[], state: string) => ({
      id, title: id, effort: 'high', engine: 'grok', cases: [], paths, migrations: [], shared: [],
      depends: [], brief: join(dir, `${id}.md`), worktree: join(dir, 'absent-worktree'),
      branch: `goal/${id.toLowerCase()}`, base: '0', state, attempts: [], goal,
    });
    const ledger = {
      goals: {
        alpha: { manager: 'alpha-manager', startedAt: '2026-10-05T00:00:00.000Z' },
        beta: { manager: 'beta-manager', startedAt: '2026-10-05T00:00:00.000Z' },
      },
      tasks: {
        'G-010': task('G-010', 'alpha', ['services/main/src/modules/alpha/read.ts'], 'exited'),
        'G-011': task('G-011', 'beta', ['services/main/src/modules/beta/held.ts'], 'running'),
      },
    };
    mkdirSync(join(dir, '.temp/goal-orchestration'), { recursive: true });
    writeFileSync(join(dir, '.temp/goal-orchestration/ledger.json'), `${JSON.stringify(ledger, null, 2)}\n`);
    return dir;
  }

  function writeBrief(dir: string, paths: string): string {
    const path = join(dir, 'brief.md');
    writeFileSync(path, ['---', 'id: G-010', 'title: Alpha work', 'effort: high', 'engine: grok', 'cases: []',
      `paths: [${paths}]`, 'migrations: []', 'shared: []', 'depends: []', '---', '', '## Outcome', '', 'Outcome.', '',
      '## Mechanisms', '', 'none', ''].join('\n'));
    return path;
  }

  function run(dir: string, args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_COMMON_DIR;
    delete env.GIT_INDEX_FILE;
    return spawnSync('bun', [join(import.meta.dir, 'goalctl.ts'), ...args], { cwd: dir, encoding: 'utf8', env });
  }

  function ledgerOf(dir: string): LedgerFile {
    return JSON.parse(readFileSync(join(dir, '.temp/goal-orchestration/ledger.json'), 'utf8')) as LedgerFile;
  }

  test('refuses a path in another Goal\'s area without --allow-area', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/read.ts');
      const result = run(dir, ['reclaim', 'G-010', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'path services/main/src/modules/beta/read.ts lies in Goal beta\'s area services/main/src/modules/beta/**');
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/read.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('accepts another Goal\'s area when --allow-area is set', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/read.ts');
      const result = run(dir, ['reclaim', 'G-010', path, '--allow-area']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('G-010 claims replaced');
      const task = ledgerOf(dir).tasks['G-010']!;
      expect(task.paths).toEqual(['services/main/src/modules/beta/read.ts']);
      expect(task.brief).toBe(path);
      expect(ledgerOf(dir).tasks['G-011']!.paths).toEqual(['services/main/src/modules/beta/held.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('still refuses a claim overlap with another open task when --allow-area is set', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/beta/held.ts');
      const result = run(dir, ['reclaim', '--allow-area', 'G-010', path]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'path services/main/src/modules/beta/held.ts overlaps G-011 services/main/src/modules/beta/held.ts');
      expect(result.stderr).not.toContain('lies in Goal');
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/read.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('still replaces a claim inside the task\'s own area without the flag', () => {
    const dir = repo();
    try {
      const path = writeBrief(dir, 'services/main/src/modules/alpha/next.ts');
      const result = run(dir, ['reclaim', 'G-010', path]);
      expect(result.status).toBe(0);
      expect(ledgerOf(dir).tasks['G-010']!.paths).toEqual(['services/main/src/modules/alpha/next.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('dispatch and reclaim refuse a file an exited task committed outside its claim until that task is verified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-unlanded-'));
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha', GOAL_MEMORY_FLOOR_GIB: '0', GOAL_MAX_WORKERS: '25' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
    const run = (args: string[]) => spawnSync('bun', [join(import.meta.dir, 'goalctl.ts'), ...args],
      { cwd: dir, encoding: 'utf8', env });
    const writeBrief = (id: string, paths: string[]) => {
      const path = join(dir, `${id}.md`);
      writeFileSync(path, ['---', `id: ${id}`, 'title: Claim a path', 'effort: high', 'engine: grok', 'cases: []',
        `paths: [${paths.join(', ')}]`, 'migrations: []', 'shared: []', 'depends: []', '---', '',
        '## Mechanisms', '', 'none', ''].join('\n'));
      return path;
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'goal@example.invalid');
      git('config', 'user.name', 'goalctl test');
      writeFileSync(join(dir, 'README'), 'start\n');
      writeFileSync(join(dir, '.gitattributes'), 'union-file.ts merge=union\n');
      git('add', '.');
      git('commit', '-qm', 'start');
      const worktree = join(dir, '.temp/worktrees/g-001');
      git('worktree', 'add', '-q', '-b', 'goal/g-001', worktree, 'main');
      mkdirSync(join(worktree, '.temp/goal'), { recursive: true });
      writeFileSync(join(worktree, 'claimed.ts'), 'export {};\n');
      writeFileSync(join(worktree, 'caller.ts'), 'export {};\n');
      mkdirSync(join(worktree, 'generated'), { recursive: true });
      writeFileSync(join(worktree, 'generated/note.json'), '{}\n');
      writeFileSync(join(worktree, 'union-file.ts'), 'export {};\n');
      expect(spawnSync('git', ['-C', worktree, 'add', 'claimed.ts', 'caller.ts', 'generated/note.json', 'union-file.ts'],
        { encoding: 'utf8', env }).status).toBe(0);
      expect(spawnSync('git', ['-C', worktree, 'commit', '-qm', 'Change a caller outside the claim'],
        { encoding: 'utf8', env }).status).toBe(0);
      writeFileSync(join(worktree, 'dirty.ts'), 'export {};\n');
      const held = (id: string, paths: string[], branch: string, tree: string) => ({
        id, title: id, effort: 'high', engine: 'grok', cases: [], paths, migrations: [], shared: [],
        depends: [], brief: join(dir, `${id}.md`), worktree: tree, branch, base: '0', state: 'exited' as string,
        attempts: [], goal: 'alpha',
      });
      const ledger = {
        goals: { alpha: { manager: 'alpha-manager', startedAt: '2026-10-09T00:00:00.000Z' } },
        tasks: {
          'G-001': held('G-001', ['claimed.ts'], 'goal/g-001', worktree),
          'G-002': held('G-002', ['other.ts'], 'goal/g-002', join(dir, 'absent-worktree')),
        },
      };
      mkdirSync(join(dir, '.temp/goal-orchestration'), { recursive: true });
      const ledgerPath = join(dir, '.temp/goal-orchestration/ledger.json');
      const save = () => writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      save();
      const caller = writeBrief('G-003', ['caller.ts']);
      const refused = run(['dispatch', caller, '--dry-run']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('Claim conflict for G-003:\n  path caller.ts changed by G-001 (unlanded)');
      expect(refused.stderr).not.toContain('overlaps');
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).tasks['G-003']).toBeUndefined();
      const glob = run(['dispatch', writeBrief('G-004', ['caller.*']), '--dry-run']);
      expect(glob.status).toBe(1);
      expect(glob.stderr).toContain('path caller.* changed by G-001 (unlanded)');
      const reclaim = run(['reclaim', 'G-002', writeBrief('G-002', ['caller.ts'])]);
      expect(reclaim.status).toBe(1);
      expect(reclaim.stderr).toContain('path caller.ts changed by G-001 (unlanded)');
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).tasks['G-002'].paths).toEqual(['other.ts']);
      const owner = run(['owner', 'caller.ts']);
      expect(owner.status).toBe(1);
      expect(owner.stdout).toContain('caller.ts: changed by G-001 (unlanded)');
      expect(run(['owner', 'claimed.ts']).stdout).toContain('claimed.ts: claimed by G-001 (exited)');
      for (const path of ['generated/note.json', 'union-file.ts', 'dirty.ts', 'fresh.ts']) {
        const result = run(['dispatch', writeBrief('G-005', [path]), '--dry-run']);
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('G-005: claims ok');
        expect(run(['owner', path]).stdout).toContain(`${path}: unclaimed`);
      }
      const adopted = run(['reclaim', 'G-001', writeBrief('G-001', ['claimed.ts', 'caller.ts'])]);
      expect(adopted.stderr).toBe('');
      expect(adopted.status).toBe(0);
      expect(run(['owner', 'caller.ts']).stdout).toContain('caller.ts: claimed by G-001 (exited)');
      const reverted = run(['reclaim', 'G-001', writeBrief('G-001', ['claimed.ts'])]);
      expect(reverted.status).toBe(0);
      expect(run(['owner', 'caller.ts']).stdout).toContain('caller.ts: changed by G-001 (unlanded)');
      ledger.tasks['G-002'].paths = ['other.ts', 'caller.ts'];
      save();
      const kept = run(['reclaim', 'G-002', writeBrief('G-002', ['other.ts', 'caller.ts', 'extra.ts'])]);
      expect(kept.stderr).toBe('');
      expect(kept.status).toBe(0);
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).tasks['G-002'].paths).toEqual(['other.ts', 'caller.ts', 'extra.ts']);
      ledger.tasks['G-002'].paths = ['other.ts'];
      save();
      for (const state of ['running', 'conflict', 'stopped']) {
        ledger.tasks['G-001'].state = state;
        save();
        expect(run(['dispatch', caller, '--dry-run']).stderr).toContain('changed by G-001 (unlanded)');
      }
      ledger.tasks['G-001'].state = 'merged';
      save();
      expect(run(['dispatch', caller, '--dry-run']).status).toBe(0);
      expect(run(['owner', 'caller.ts']).stdout).toContain('caller.ts: unclaimed');
      expect(run(['owner', 'claimed.ts']).stdout).toContain('claimed.ts: claimed by G-001 (merged)');
      ledger.tasks['G-001'].state = 'exited';
      save();
      expect(run(['dispatch', caller, '--dry-run']).stderr).toContain('changed by G-001 (unlanded)');
      ledger.tasks['G-001'].state = 'verified';
      save();
      const allowed = run(['dispatch', caller, '--dry-run']);
      expect(allowed.stderr).toBe('');
      expect(allowed.status).toBe(0);
      expect(allowed.stdout).toContain('G-003: claims ok');
      expect(run(['owner', 'caller.ts']).stdout).toContain('caller.ts: unclaimed');
      const released = run(['reclaim', 'G-002', writeBrief('G-002', ['caller.ts'])]);
      expect(released.status).toBe(0);
      expect(JSON.parse(readFileSync(ledgerPath, 'utf8')).tasks['G-002'].paths).toEqual(['caller.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('lists --allow-area beside reclaim in the usage text', () => {
    const result = spawnSync('bun', [join(import.meta.dir, 'goalctl.ts')], {
      cwd: join(import.meta.dir, '../..'), encoding: 'utf8',
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('reclaim <id> <brief> [--allow-area]');
    expect(result.stderr).toContain('dispatch <brief.md> [--dry-run] [--force-usage] [--allow-area]');
    expect(result.stderr).toContain('gate <id> [--skip-unit-gate] [--skip-type-gate]');
  });
});

describe('pre-merge unit selection', () => {
  test('repository guards join a narrow or empty affected set exactly once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repository-guards-'));
    try {
      const guards = repositoryGuards.map(guard => guard.file);
      for (const file of [...guards, 'operation.test.ts']) {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), '');
      }
      expect(mergeUnitFiles(dir, 'Affected since HEAD: no unit changes')).toEqual([...guards].sort());
      expect(mergeUnitFiles(dir, `Affected since HEAD: fixture\n  unit: operation.test.ts\n  unit: ${guards[0]}\n`))
        .toEqual([...guards, 'operation.test.ts'].sort());
      expect(balanceUnitShards(mergeUnitFiles(dir, 'Affected since HEAD: fixture'), 4).flat().sort())
        .toEqual([...guards].sort());
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('whole-unit widening expands registered defaults and excludes heavier tiers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-selection-'));
    try {
      const defaults = [...testArgs('unit').slice(1), ...unitHarnessFiles];
      for (const file of [...defaults, 'tests/qa/unit/nested/behavior.test.ts', 'extra.test.ts']) {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), '');
      }
      writeFileSync(join(dir, 'tests/qa/unit/notes.ts'), '');
      expect(mergeUnitFiles(dir, [
        'Affected since HEAD: fixture', '  unit: whole tier (dependency changed)',
        '  unit: extra.test.ts', '  unit: extra.test.ts',
        '  integration: never.test.ts', '  model: never.test.ts',
        '  fault/recovery: never.test.ts', '  not run: browser.test.ts',
      ].join('\n'))).toEqual([...defaults, 'tests/qa/unit/nested/behavior.test.ts', 'extra.test.ts'].sort());
      expect(() => mergeUnitFiles(dir, 'unavailable')).toThrow('not produced');
      expect(() => mergeUnitFiles(dir, 'Affected since HEAD: fixture\n  unit: ../outside.test.ts')).toThrow('outside worktree');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('shard sizes differ by at most one and empty shards are omitted', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts', 'f.test.ts', 'g.test.ts', 'h.test.ts'];
    const even = balanceUnitShards(files, 4);
    expect(even).toHaveLength(4);
    expect(even.every(group => group.length === 2)).toBe(true);
    expect(even.flat().sort()).toEqual(files);
    expect(new Set(even.flat()).size).toBe(files.length);
    const odd = balanceUnitShards(files.slice(0, 5), 4);
    expect(odd.map(group => group.length).sort()).toEqual([1, 1, 1, 2]);
    expect(odd.flat().sort()).toEqual(files.slice(0, 5));
    expect(balanceUnitShards(files, 1)).toEqual([files]);
    expect(balanceUnitShards(files.slice(0, 2), 8)).toHaveLength(2);
    expect(balanceUnitShards([], 4)).toEqual([]);
  });
});

describe('goalctl shared lifecycle and launch gates', () => {
  function repo() {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-lifecycle-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'goal@example.invalid');
    git('config', 'user.name', 'goalctl test');
    mkdirSync(join(dir, 'scripts/goal'), { recursive: true });
    copyFileSync(join(import.meta.dir, 'dedupe-imports.ts'), join(dir, 'scripts/goal/dedupe-imports.ts'));
    copyFileSync(join(import.meta.dir, 'composition-roots.ts'), join(dir, 'scripts/goal/composition-roots.ts'));
    for (const root of ['app.ts', 'index.ts', 'composition.ts', 'routes/dependencies.ts']) {
      mkdirSync(join(dir, 'services/main/src/routes'), { recursive: true });
      writeFileSync(join(dir, 'services/main/src', root), 'export {};\n');
    }
    writeFileSync(join(dir, '.gitignore'), '.temp/\n');
    git('add', '.');
    git('commit', '-qm', 'start');
    mkdirSync(join(dir, '.temp/bin'), { recursive: true });
    const fixture = join(import.meta.dir, 'fixtures/sleep-worker.ts');
    for (const binary of ['grok', 'claude', 'codex', 'codex-1']) {
      writeFileSync(join(dir, '.temp/bin', binary), `#!/usr/bin/env bun\nimport ${JSON.stringify(fixture)};\n`);
      chmodSync(join(dir, '.temp/bin', binary), 0o755);
    }
    writeFileSync(join(dir, '.temp/bin/corepack'), '#!/bin/sh\nexit 0\n');
    for (const binary of ['grok', 'corepack']) chmodSync(join(dir, '.temp/bin', binary), 0o755);
    writeFileSync(join(dir, '.temp/bin/task'), `#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'install') process.exit(0);
if (args.includes('--list')) {
  console.log('Affected since HEAD: fixture');
  if (process.env.GOAL_TEST_PLAN) console.log(readFileSync(process.env.GOAL_TEST_PLAN, 'utf8'));
  process.exit(0);
}
if (process.env.GOAL_TEST_LOG) appendFileSync(process.env.GOAL_TEST_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (process.env.GOAL_TEST_RUNNER_FAILURE) {
  console.error(process.env.GOAL_TEST_RUNNER_FAILURE);
  process.exit(1);
}
// Capture the child gate and forward it on this task's own pipes. The parent gate already
// collects those pipes. Inheriting would print the child's transcript into whatever is running this task.
const child = spawn('bun', ['test', ...args.slice(2)], { stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on('close', code => process.exit(code ?? 1));
`);
    chmodSync(join(dir, '.temp/bin/task'), 0o755);
    const ready = join(dir, '.temp/ready');
    mkdirSync(ready);
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_ID: 'alpha', GOAL_MAX_WORKERS: '25', GOAL_MEMORY_FLOOR_GIB: '0',
      GOAL_CODEX_HOME: join(dir, '.temp/codex'), GOAL_CODEX_1_HOME: join(dir, '.temp/codex-1'),
      GOAL_USAGE_FILE: join(dir, '.temp/usage.json'), GOAL_SLEEP_READY_DIR: ready,
      PATH: `${join(dir, '.temp/bin')}:${process.env.PATH}` };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
    const ledgerPath = join(dir, '.temp/goal-orchestration/ledger.json');
    const ledger = (): Ledger => JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger;
    const save = (value: Ledger) => writeFileSync(ledgerPath, JSON.stringify(value));
    const run = (args: string[], overrides: NodeJS.ProcessEnv = {}, timeout = 45_000) => spawnSync('bun',
      [join(import.meta.dir, 'goalctl.ts'), ...args], { cwd: dir, encoding: 'utf8', env: { ...env, ...overrides }, timeout });
    for (const goal of ['alpha', 'beta']) {
      mkdirSync(join(dir, 'docs/goals', goal), { recursive: true });
      writeFileSync(join(dir, 'docs/goals', goal, 'GOAL.md'), '---\nareas: []\n---\n');
      expect(run(['goal', 'start', goal, '--manager', `${goal}-manager`], { GOAL_ID: goal }).status).toBe(0);
    }
    git('add', '.');
    git('commit', '-qm', 'Goals');
    const brief = (id: string, options: { worktree?: string; depends?: string; engine?: string } = {}) => {
      const path = join(dir, '.temp', `${id}.md`);
      writeFileSync(path, ['---', `id: ${id}`, 'title: Sleeping test worker', 'effort: high',
        `engine: ${options.engine ?? 'grok'}`, `paths: [worker-${id.slice(2)}.ts]`, `depends: [${options.depends ?? ''}]`,
        ...options.worktree ? [`worktree: ${options.worktree}`] : [], '---', '', '## Mechanisms', '', 'none', ''].join('\n'));
      return path;
    };
    const workers = new Map<string, { worker: number; child: number }>();
    const start = async (id: string, goal = 'alpha', worktree?: string) => {
      const result = run(['dispatch', brief(id, { worktree })], { GOAL_ID: goal });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const deadline = Date.now() + 5000;
      while (!existsSync(join(ready, id)) && Date.now() < deadline) await Bun.sleep(20);
      const pids = JSON.parse(readFileSync(join(ready, id), 'utf8')) as { worker: number; child: number };
      workers.set(id, pids);
      return ledger().tasks[id]!;
    };
    const alive = (pid: number) => processRunning(pid);
    const stopFixture = async (id: string) => {
      const pids = workers.get(id)!;
      for (const pid of [pids.worker, pids.child]) { try { process.kill(pid, 'SIGTERM'); } catch { /* exited */ } }
      const deadline = Date.now() + 5000;
      while ([pids.worker, pids.child].some(alive) && Date.now() < deadline) await Bun.sleep(20);
      const value = ledger();
      value.tasks[id]!.state = 'exited';
      save(value);
    };
    const commit = (task: Task, path = `worker-${task.id.slice(2)}.ts`) => {
      writeFileSync(join(task.worktree, path), `export const value = '${task.id.slice(2)}';\n`);
      const result = spawnSync('git', ['-C', task.worktree, 'add', path], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', `Deliver ${task.id}`]).status).toBe(0);
    };
    const cleanup = () => {
      for (const entry of readdirSync('/proc')) {
        if (!/^\d+$/.test(entry)) continue;
        try {
          if (readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0').includes(`GOAL_SLEEP_READY_DIR=${ready}`)) {
            process.kill(Number(entry), 'SIGKILL');
          }
        } catch { /* exited */ }
      }
      for (const { worker, child } of workers.values()) {
        for (const pid of [worker, child]) { try { process.kill(pid, 'SIGKILL'); } catch { /* exited */ } }
      }
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, git, env, run, ledger, save, brief, start, workers, alive, stopFixture, commit, cleanup };
  }

  test('stop preserves a live sharer, its detached children, commits and shared stack', async () => {
    const r = repo();
    let server: ChildProcess | undefined;
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      r.commit(second);
      const head = r.git('rev-parse', first.branch);
      const env = { ...r.env };
      delete env.GOAL_TASK_ID;
      server = spawn('bun', [join(import.meta.dir, 'fixtures/sleep-worker.ts'), '--child'],
        { cwd: first.worktree, detached: true, stdio: 'ignore', env });
      const dockerLog = join(r.dir, '.temp/docker.log');
      writeFileSync(join(r.dir, '.temp/bin/docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dockerLog}'\necho container\n`);
      chmodSync(join(r.dir, '.temp/bin/docker'), 0o755);
      expect(r.run(['stop', first.id]).status).toBe(0);
      await Bun.sleep(100);
      expect(r.alive(r.workers.get(first.id)!.worker)).toBe(false);
      expect(r.alive(r.workers.get(first.id)!.child)).toBe(false);
      expect(r.alive(r.workers.get(second.id)!.worker)).toBe(true);
      expect(r.alive(r.workers.get(second.id)!.child)).toBe(true);
      expect(r.alive(server.pid!)).toBe(true);
      expect(existsSync(dockerLog)).toBe(false);
      expect(r.git('rev-parse', first.branch)).toBe(head);
      expect(r.ledger().tasks[first.id]!.state).toBe('stopped');
      expect(r.run(['stop', second.id]).status).toBe(0);
      await Bun.sleep(100);
      expect(r.alive(server.pid!)).toBe(false);
      expect(readFileSync(dockerLog, 'utf8')).toContain(`compose -p rezics-qa-wt-${second.worktree.split('/').at(-1)} down -v`);
    } finally { server?.kill('SIGKILL'); r.cleanup(); }
  }, 30_000);

  test('merges the shared branch once, accepts both claims and records all open sharers', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      r.commit(second);
      await r.stopFixture(first.id);
      await r.stopFixture(second.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', first.id]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const tasks = r.ledger().tasks;
      expect(tasks[first.id]!.state).toBe('merged');
      expect(tasks[second.id]!.state).toBe('merged');
      expect(tasks[first.id]!.mergedCommit).toBe(r.git('rev-parse', 'main'));
      expect(tasks[second.id]!.mergedCommit).toBe(tasks[first.id]!.mergedCommit);
      const events = () => readFileSync(join(r.dir, '.temp/goal-orchestration/merges.jsonl'), 'utf8')
        .trim().split('\n').map(line => JSON.parse(line));
      expect(events()).toEqual([{ before, after: tasks[first.id]!.mergedCommit, goal: 'alpha',
        taskIds: [first.id, second.id], files: ['worker-001.ts', 'worker-002.ts'], at: expect.any(String) }]);
      expect(r.run(['merge', second.id]).status).toBe(0);
      // A resumed sharer may finish without new commits; the no-op merge still records its delivered work.
      await r.stopFixture(second.id);
      expect(r.run(['merge', first.id]).status).toBe(0);
      expect(r.ledger().tasks[second.id]!.state).toBe('merged');
      expect(r.ledger().tasks[second.id]!.mergedCommit).toBe(tasks[first.id]!.mergedCommit);
      expect(events()).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 30_000);

  test('changing the affected text format does not change the selected files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'typed-affected-plan-'));
    try {
      writeFileSync(join(dir, 'present.test.ts'), '');
      writeFileSync(join(dir, 'owner.test.ts'), '');
      const typed: AffectedPlan = {
        base: 'abc', changed: ['src/a.ts'], tasks: [], frontend: [],
        tests: {
          unit: ['present.test.ts', 'absent.test.ts'], owner: ['owner.test.ts', 'missing.test.ts'],
          integration: [], model: [], 'fault/recovery': [],
        },
        widened: [], deferred: [], ignored: [],
      };
      expect(unitFilesFromPlan(dir, typed)).toEqual(['present.test.ts']);
      expect(ownerFilesFromPlan(dir, typed)).toEqual(['owner.test.ts']);
      expect(unitFilesFromPlan(dir, typed)).toEqual(mergeUnitFiles(dir, formatPlan(typed)));
      expect(ownerFilesFromPlan(dir, typed)).toEqual(mergeOwnerFiles(dir, formatPlan(typed)));
      const rewritten = formatPlan(typed).replace(/^  unit: /gm, '  chosen: ').replace(/^  owner: /gm, '  suite: ');
      expect(mergeUnitFiles(dir, rewritten)).toEqual([]);
      expect(mergeOwnerFiles(dir, rewritten)).toEqual([]);
      expect(unitFilesFromPlan(dir, typed)).toEqual(['present.test.ts']);
      expect(ownerFilesFromPlan(dir, typed)).toEqual(['owner.test.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a missing report, a self-closing testcase, a spoofed transcript and an absolute path keep their files', () => {
    const file = 'services/main/tests/a.test.ts';
    const other = 'services/main/tests/b.test.ts';
    expect(failingTestFiles(`${file}:\n(fail) broke\n`, [file, other])).toEqual([file]);
    const report = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<testsuites>',
      `<testcase name="passes" file="${file}" />`,
      `<testcase name="breaks" file="/repo/${other}"><failure type="AssertionError" message="no" /></testcase>`,
      '</testsuites>',
    ].join('\n');
    const output = [
      `${file}:`, '(fail) spoofed console name',
      `  ${UNIT_JUNIT_MARKER}`,
      `<testsuites><testcase name="spoof" file="${other}"><failure message="spoof" /></testcase></testsuites>`,
      UNIT_JUNIT_MARKER, report,
    ].join('\n');
    expect(unitFailureDetails(output, [file, other], '/repo')).toEqual([{ file: other, test: 'breaks', detail: 'no' }]);
    expect(failingTestFiles(output, [file, other], '/repo')).toEqual([other]);
    expect(timedOutTestFiles([
      UNIT_JUNIT_MARKER,
      `<testsuites><testcase name="hangs" file="/repo/${file}"><failure type="TimeoutError" message="test timed out" /></testcase></testsuites>`,
    ].join('\n'), [file], '/repo')).toEqual([file]);
  });

  test('the unit gate skips affected files the branch does not have', () => {
    const dir = mkdtempSync(join(tmpdir(), 'unit-gate-files-'));
    try {
      writeFileSync(join(dir, 'present.test.ts'), '');
      // main added absent.test.ts after the branch's base; the branch cannot run it.
      expect(mergeUnitFiles(dir, 'Affected since abc: 2 changed paths\n  unit: present.test.ts\n  unit: absent.test.ts\n')).toEqual(['present.test.ts']);
      writeFileSync(join(dir, 'owner.test.ts'), '');
      expect(mergeOwnerFiles(dir, 'Affected since abc: 1 changed path\n  owner: owner.test.ts\n  owner: missing.test.ts\n')).toEqual(['owner.test.ts']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a passing file printed beside a failure is not counted as failing', () => {
    // From a trust-ops merge: bun printed dev-seed-plan's header before the run summary although it passed.
    const output = ['scripts/static/list-convention.test.ts:', '(fail) collection read contracts introduce no new list convention debt [97.20ms]',
      'tests/qa/unit/dev-seed-plan.test.ts:', ' 130 pass', ' 1 fail'].join('\n');
    expect(failingTestFiles(output, ['scripts/static/list-convention.test.ts', 'tests/qa/unit/dev-seed-plan.test.ts']))
      .toEqual(['scripts/static/list-convention.test.ts']);
  });

  test('the unit gate reads failing files from one bun run instead of rerunning each file', () => {
    const output = ['bun test v1.4.2', 'services/main/tests/a.test.ts:', '(fail) a > breaks',
      '/repo/scripts/b.test.ts:', '# Unhandled error between tests', 'services/main/tests/unlisted.test.ts:', ' 1 pass'].join('\n');
    expect(failingTestFiles(output, ['services/main/tests/a.test.ts', 'scripts/b.test.ts', 'scripts/c.test.ts'], '/repo'))
      .toEqual(['scripts/b.test.ts', 'services/main/tests/a.test.ts']);
    expect(failingTestFiles(' 3 pass\n', ['scripts/c.test.ts'])).toEqual([]);
  });

  test('pre-merge unit gate runs without holding the ledger lock', async () => {
    const r = repo();
    try {
      const file = 'lock-free.test.ts';
      const lock = join(r.dir, '.temp/goal-orchestration/ledger.lock');
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(file); r.save(ledger);
      // The unit file itself fails if the gate holds the ledger: other Goals' goalctl would block meanwhile.
      writeFileSync(join(task.worktree, file), `import { test, expect } from 'bun:test';\nimport { existsSync } from 'node:fs';\n`
        + `test('ledger is free', () => expect(existsSync(${JSON.stringify(lock)})).toBe(false));\n`);
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add lock probe']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, `  unit: ${file}\n`);
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(r.ledger().tasks[task.id]!.state).toBe('merged');
    } finally { r.cleanup(); }
  }, 30_000);

  for (const scenario of ['references', 'ordered', 'unrelated-data', 'outside-comment', 'outside-filename', 'outside-reference', 'outside-symlink', 'unsafe-self-reference', 'unsafe-named-reference', 'unsafe-fraction-reference', 'above-head', 'padded', 'multiple-directories', 'ambiguous-directories', 'foreign-directory'] as const) {
    test(`migration normalization handles ${scenario} before the unit gate and fast-forward`, async () => {
      const r = repo();
      try {
        const directory = 'services/main/migrations/access';
        const task = await r.start('G-001');
        const ledger = r.ledger();
        ledger.tasks[task.id]!.paths.push('services/main/migrations/**', 'migration-references.test.ts');
        r.save(ledger);
        // Main advances after dispatch, reproducing reservations merged in another order.
        mkdirSync(join(r.dir, directory), { recursive: true });
        writeFileSync(join(r.dir, directory, '1004_main.sql'), 'SELECT 1;\n');
        if (scenario === 'unrelated-data') {
          mkdirSync(join(r.dir, 'packages/model/src/address'), { recursive: true });
          writeFileSync(join(r.dir, 'packages/model/src/address/unicode-data.ts'), 'export const unicode = [990, 9900, 12];\n');
        }
        if (scenario === 'outside-comment') writeFileSync(join(r.dir, 'other-owner.ts'), '// migration 990\n');
        if (scenario === 'outside-filename') writeFileSync(join(r.dir, 'other-owner.ts'), `export const filename = '${directory}/990_first.sql';\n`);
        if (scenario === 'outside-reference') writeFileSync(join(r.dir, 'other-owner.ts'), 'export const migrationVersion = 990;\n');
        if (scenario === 'outside-symlink') symlinkSync(`${directory}/990_first.sql`, join(r.dir, 'other-owner.ts'));
        r.git('add', '.'); r.git('commit', '-qm', 'Advance main migration head');
        mkdirSync(join(task.worktree, directory), { recursive: true });
        const first = scenario === 'above-head' ? 1010 : 990;
        const digits = scenario === 'padded' ? '0990' : String(first);
        const self = scenario === 'unsafe-self-reference' ? 'INSERT INTO schema_versions VALUES (990);'
          : scenario === 'unsafe-named-reference' ? "SELECT 'schema_migration_990';"
          : scenario === 'unsafe-fraction-reference' ? '-- migration 990.5\nSELECT 1;' : `-- migration ${digits}\nSELECT 1;`;
        writeFileSync(join(task.worktree, directory, `${digits}_first.sql`), `${self}\n`);
        const refs = [`const MIGRATION_VERSION: number = ${first};`,
          `const filename = '${directory}/${digits}_first.sql';`,
          `const unrelated = ${first};`, `const longer = ${first}0;`, `const identifier${first} = true;`];
        if (scenario === 'padded') refs.push("const QUOTED_VERSION = '0990';");
        if (scenario === 'foreign-directory') refs.push("const foreign = 'services/main/migrations/relay/990_first.sql';");
        if (scenario === 'ordered') {
          // An already higher addition still belongs after the low one. Its number is occupied.
          writeFileSync(join(task.worktree, directory, '1005_second.sql'), '-- migration 1005\nSELECT 2;\n');
          refs.push("const second = '1005_second.sql';");
        }
        if (scenario === 'multiple-directories' || scenario === 'ambiguous-directories') {
          const relay = 'services/main/migrations/relay';
          mkdirSync(join(r.dir, relay), { recursive: true });
          writeFileSync(join(r.dir, relay, '1200_main.sql'), 'SELECT 1;\n');
          r.git('add', relay); r.git('commit', '-qm', 'Advance relay head');
          mkdirSync(join(task.worktree, relay), { recursive: true });
          writeFileSync(join(task.worktree, relay, '990_first.sql'), '-- migration 990\nSELECT 2;\n');
          refs.push(`const relay = '${relay}/990_first.sql';`);
          // A bare version cannot choose between the directory-specific assignments.
          if (scenario === 'multiple-directories') refs[0] = 'const unrelatedVersion = 1;';
        }
        if (scenario === 'references') {
          // This assertion can pass only after filenames and constants have been normalized.
          refs.push("import { test, expect } from 'bun:test';", "import { existsSync } from 'node:fs';",
            `test('migration references resolve after normalization', () => { expect(MIGRATION_VERSION).toBe(1005); expect(existsSync(filename)).toBe(true); expect(unrelated).toBe(990); expect(longer).toBe(9900); expect(identifier990).toBe(true); });`);
        }
        writeFileSync(join(task.worktree, 'migration-references.test.ts'), `${refs.join('\n')}\n`);
        expect(spawnSync('git', ['-C', task.worktree, 'add', '.']).status).toBe(0);
        expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add task migrations and references']).status).toBe(0);
        await r.stopFixture(task.id);
        const before = r.git('rev-parse', 'main');
        const plan = join(r.dir, '.temp/unit-plan');
        writeFileSync(plan, scenario === 'references' ? '  unit: migration-references.test.ts\n' : '');
        const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan });
        if (scenario.startsWith('outside-') || scenario.startsWith('unsafe-') || scenario === 'ambiguous-directories' || scenario === 'foreign-directory') {
          expect(result.status).toBe(1);
          expect(result.stderr).toContain(scenario.startsWith('outside-')
            ? "other-owner.ts references old migration number 990 outside the task's changed files"
            : scenario === 'ambiguous-directories' ? 'migration 990 is ambiguous across directories'
            : scenario === 'foreign-directory' ? 'refers to a directory not being renumbered'
            : 'its own migration number 990 occurs outside a proven migration context');
          expect(r.git('rev-parse', 'main')).toBe(before);
          expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
          expect(r.ledger().tasks[task.id]!.refusal).toContain('migration normalization refused; not merging:');
          expect(existsSync(join(task.worktree, directory, '990_first.sql'))).toBe(true);
          expect(spawnSync('git', ['-C', task.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).stdout).toBe('');
        } else {
          expect(result.stderr).toBe('');
          expect(result.status).toBe(0);
          expect(r.ledger().tasks[task.id]!.state).toBe('merged');
          const next = scenario === 'above-head' ? 1010 : scenario === 'ordered' ? 1006 : 1005;
          expect(readFileSync(join(r.dir, directory, `${next}_first.sql`), 'utf8')).toBe(`-- migration ${next}\nSELECT 1;\n`);
          expect(readFileSync(join(r.dir, directory, '1004_main.sql'), 'utf8')).toBe('SELECT 1;\n');
          const references = readFileSync(join(r.dir, 'migration-references.test.ts'), 'utf8');
          expect(references).toContain(`${next}_first.sql`);
          expect(references).toContain(`const unrelated = ${first};`);
          if (scenario === 'unrelated-data') {
            expect(readFileSync(join(r.dir, 'packages/model/src/address/unicode-data.ts'), 'utf8')).toBe('export const unicode = [990, 9900, 12];\n');
          }
          if (scenario === 'padded') expect(references).toContain("const QUOTED_VERSION = '1005';");
          expect(result.stdout.includes('Migration normalization:')).toBe(scenario !== 'above-head');
          if (scenario === 'ordered') {
            expect(readFileSync(join(r.dir, directory, '1007_second.sql'), 'utf8')).toBe('-- migration 1007\nSELECT 2;\n');
            expect(references).toContain('1007_second.sql');
          }
          if (scenario === 'multiple-directories') expect(references).toContain('relay/1201_first.sql');
          if (scenario !== 'above-head') expect(r.git('log', '-1', '--format=%s')).toBe('Normalize migration numbers after rebase (goalctl)');
        }
      } finally { r.cleanup(); }
    }, 30_000);
  }

  test('a failed normalized merge can retry exact migration claims above a newly moved head', async () => {
    const r = repo();
    try {
      const directory = 'services/main/migrations/access';
      mkdirSync(join(r.dir, directory), { recursive: true });
      writeFileSync(join(r.dir, directory, '1004_main.sql'), 'SELECT 1;\n');
      r.git('add', '.'); r.git('commit', '-qm', 'Main migration');
      const task = await r.start('G-001');
      const file = 'migration-retry.test.ts';
      const original = `${directory}/990_retry.sql`;
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(original, file); r.save(ledger);
      writeFileSync(join(task.worktree, original), '-- migration 990\nSELECT 2;\n');
      writeFileSync(join(task.worktree, file), "import { test, expect } from 'bun:test';\nimport { existsSync } from 'node:fs';\n"
        + `test('normalized filename resolves', () => expect(existsSync('${original}')).toBe(false));\n`);
      expect(spawnSync('git', ['-C', task.worktree, 'add', '.']).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add migration and failing reference test']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan'); writeFileSync(plan, `  unit: ${file}\n`);
      const first = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan });
      expect(first.status).toBe(1);
      expect(first.stderr).toContain('introduced unit failures');
      expect(r.ledger().tasks[task.id]!.refusal).toContain('introduced unit failures; not merging:');
      expect(r.ledger().tasks[task.id]!.migrationOrigins).toEqual({ [`${directory}/1005_retry.sql`]: original });
      writeFileSync(join(r.dir, directory, '1006_later.sql'), 'SELECT 3;\n');
      r.git('add', '.'); r.git('commit', '-qm', 'Another migration lands before retry');
      const testPath = join(task.worktree, file);
      writeFileSync(testPath, readFileSync(testPath, 'utf8').replace('toBe(false)', 'toBe(true)'));
      expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Fix filename assertion']).status).toBe(0);
      const second = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan });
      expect(second.stderr).toBe('');
      expect(second.status).toBe(0);
      expect(r.ledger().tasks[task.id]!.refusal).toBeUndefined();
      expect(r.ledger().tasks[task.id]!.migrationOrigins).toEqual({ [`${directory}/1007_retry.sql`]: original });
      expect(existsSync(join(r.dir, directory, '1007_retry.sql'))).toBe(true);
      expect(readFileSync(join(r.dir, file), 'utf8')).toContain('1007_retry.sql');
    } finally { r.cleanup(); }
  }, 30_000);

  for (const boundary of ['main-unrelated', 'main-changed-file', 'main-gated-file', 'main-renamed-gated-file', 'main-overlap-twice', 'task', 'sharer'] as const) {
    test(`merge handles ${boundary} moving while the normalized branch is tested`, async () => {
      const r = repo();
      try {
        const sharedFile = 'shared.ts';
        const gatedFile = 'baseline.test.ts';
        writeFileSync(join(r.dir, sharedFile), 'export const main = 0;\n\n\nexport const task = 0;\n');
        writeFileSync(join(r.dir, gatedFile), "import { test } from 'bun:test';\ntest('baseline passes', () => {});\n");
        r.git('add', '.'); r.git('commit', '-qm', 'Baseline moving boundaries');
        const task = await r.start('G-001');
        const file = 'moving-boundary.test.ts';
        const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(file, 'advance.ts', sharedFile); r.save(ledger);
        if (boundary === 'main-changed-file' || boundary === 'main-overlap-twice') {
          writeFileSync(join(task.worktree, sharedFile), 'export const main = 0;\n\n\nexport const task = 1;\n');
        }
        const directory = boundary === 'task' ? task.worktree : r.dir;
        const advancing = boundary === 'main-changed-file' || boundary === 'main-overlap-twice' ? sharedFile
          : boundary === 'main-gated-file' ? gatedFile : 'advance.ts';
        const marker = join(r.dir, '.temp/boundary-moved');
        const ledgerPath = join(r.dir, '.temp/goal-orchestration/ledger.json');
        const edit = boundary === 'sharer'
          ? `const ledger = JSON.parse(readFileSync(${JSON.stringify(ledgerPath)}, 'utf8')); const first = Object.values(ledger.tasks)[0]; const id = 'G-' + '002'; ledger.tasks[id] = { ...first, id }; writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify(ledger));`
          : boundary === 'main-renamed-gated-file'
            ? `expect(spawnSync('git', ['-C', ${JSON.stringify(r.dir)}, 'mv', ${JSON.stringify(gatedFile)}, 'renamed-baseline.test.ts']).status).toBe(0);
expect(spawnSync('git', ['-C', ${JSON.stringify(r.dir)}, 'commit', '-qm', 'Rename gated file']).status).toBe(0);`
          : `writeFileSync(${JSON.stringify(join(directory, advancing))}, ${JSON.stringify(advancing === sharedFile
            ? 'export const main = 1;\n\n\nexport const task = 0;\n'
            : advancing === gatedFile ? "import { test } from 'bun:test';\ntest('advanced baseline passes', () => {});\n" : 'export {};\n')});
`
            + `expect(spawnSync('git', ['-C', ${JSON.stringify(directory)}, 'add', ${JSON.stringify(advancing)}]).status).toBe(0);
`
            + `expect(spawnSync('git', ['-C', ${JSON.stringify(directory)}, 'commit', '-qm', 'Advance boundary']).status).toBe(0);`;
        writeFileSync(join(task.worktree, file), `import { test, expect } from 'bun:test';\n`
          + `import { existsSync, readFileSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n`
          + `test('advance a merge boundary once', () => {\n`
          + `if (existsSync(${JSON.stringify(marker)})) {
`
          + (boundary === 'main-overlap-twice'
            ? `const path = ${JSON.stringify(join(r.dir, sharedFile))}; writeFileSync(path, readFileSync(path, 'utf8').replace('main = 1', 'main = 2'));
expect(spawnSync('git', ['-C', ${JSON.stringify(r.dir)}, 'commit', '-qam', 'Advance boundary again']).status).toBe(0);
`
            : '')
          + `return; }
writeFileSync(${JSON.stringify(marker)}, 'moved');
${edit}
});
`);
        r.commit(task);
        expect(spawnSync('git', ['-C', task.worktree, 'add', '.']).status).toBe(0);
        expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add moving boundary probe']).status).toBe(0);
        await r.stopFixture(task.id);
        const before = r.git('rev-parse', 'main');
        const plan = join(r.dir, '.temp/unit-plan');
        writeFileSync(plan, `  unit: ${file}\n${boundary === 'main-gated-file' || boundary === 'main-renamed-gated-file' ? `  unit: ${gatedFile}\n` : ''}`);
        const log = join(r.dir, '.temp/unit-log');
        const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '1' });
        const refusal = boundary === 'task' || boundary === 'sharer' || boundary === 'main-overlap-twice';
        expect(result.status).toBe(refusal ? 1 : 0);
        if (refusal) {
          expect(result.stderr).toContain(boundary === 'main-overlap-twice' ? 'main touched task or gated files again' : 'changed during the unit gate; retry merge');
          expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
          expect(existsSync(join(r.dir, file))).toBe(false);
          if (boundary === 'task' || boundary === 'sharer') expect(r.git('rev-parse', 'main')).toBe(before);
        } else {
          expect(result.stderr).toBe('');
          expect(r.ledger().tasks[task.id]!.state).toBe('merged');
          expect(existsSync(join(r.dir, file))).toBe(true);
          expect(result.stdout).toContain(boundary === 'main-unrelated' ? 'existing gate remains valid' : 're-running the gate once');
          if (boundary === 'main-changed-file') expect(readFileSync(join(r.dir, sharedFile), 'utf8')).toContain('export const task = 1;');
        }
        const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        expect(runs).toHaveLength(boundary.startsWith('main-') && boundary !== 'main-unrelated' ? 2 : 1);
        const eventsPath = join(r.dir, '.temp/goal-orchestration/merges.jsonl');
        if (!refusal) {
          const event = JSON.parse(readFileSync(eventsPath, 'utf8').trim());
          expect(event.before).not.toBe(before);
          expect(event.after).toBe(r.git('rev-parse', 'main'));
        }
      } finally { r.cleanup(); }
    }, 30_000);
  }

  test('a later merge inherits a guard failure current main already has', async () => {
    const r = repo();
    try {
      const guard = repositoryGuards[0].file;
      mkdirSync(join(r.dir, guard, '..'), { recursive: true });
      writeFileSync(join(r.dir, guard), `import { test, expect } from 'bun:test';\nimport { readFileSync } from 'node:fs';\n`
        + `test('inventory stays valid', () => expect(readFileSync('inventory.ts', 'utf8')).toBe('valid'));\n`);
      writeFileSync(join(r.dir, 'inventory.ts'), 'valid');
      r.git('add', '.'); r.git('commit', '-qm', 'Baseline inventory');
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push('inventory.ts'); r.save(ledger);
      r.commit(task);
      writeFileSync(join(task.worktree, 'inventory.ts'), 'invalid');
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qam', 'Break inventory']).status).toBe(0);
      await r.stopFixture(task.id);
      expect(r.run(['merge', task.id, '--skip-unit-gate']).status).toBe(0);
      const firstMerge = r.git('rev-parse', 'main');
      writeFileSync(join(task.worktree, 'inventory.ts'), 'still invalid');
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qam', 'Continue stream']).status).toBe(0);
      const result = r.run(['merge', task.id]);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`against main ${firstMerge.slice(0, 12)}`);
      expect(result.stdout).toContain('also fails on main');
      expect(r.ledger().tasks[task.id]!.state).toBe('merged');
      expect(r.git('rev-parse', 'main')).toBe(r.git('rev-parse', task.branch));
    } finally { r.cleanup(); }
  }, 30_000);

  test('a stream classifies inherited failures against the current main commit', () => {
    const event = (before: string, after: string, taskIds: string[]) =>
      ({ before, after, taskIds, goal: 'alpha', at: '2026-10-07' });
    const events = [event('a', 'a', ['stream']), event('a', 'b', ['other']),
      event('b', 'c', ['peer', 'stream']), event('d', 'e', ['stream'])];
    expect(streamUnitBaseline(events, ['stream'], 'head')).toBe('head');
    expect(streamUnitBaseline(events, ['peer'], 'head')).toBe('head');
    expect(streamUnitBaseline(events, ['new'], 'head')).toBe('head');
  });

  test('a stream selects its own commits plus earlier merge files and classifies inheritance against current main', () => {
    const own = ['services/main/src/stream-only.ts'];
    expect(streamSelectionFiles(own, [{ before: 'main-a', after: 'merged', goal: 'alpha', taskIds: ['stream'],
      files: ['services/main/src/earlier.ts'], at: 't0' }], ['stream']).sort())
      .toEqual(['services/main/src/earlier.ts', 'services/main/src/stream-only.ts']);
    expect(streamSelectionFiles(own, [{ before: 'main-a', after: 'merged', goal: 'alpha', taskIds: ['other'],
      files: ['infra/jena/Dockerfile'], at: 't0' }], ['stream'])).toEqual(own);
    const plan = (changed: string[]) => planAffected({
      base: 'main', changed, graph: [], sources: new Map(),
      exists: path => path === nativeUnionTest,
      nativeUnionDockerfile: 'FROM eclipse-temurin:21\n',
    });
    expect(plan(own).nativeUnion).toBe('not selected');
    expect(plan(own).tests.unit).not.toContain(nativeUnionTest);
    expect(plan([...own, 'infra/jena/Dockerfile']).nativeUnion).toBe('selected');
    expect(plan([...own, 'infra/jena/Dockerfile']).tests.unit).toContain(nativeUnionTest);
    expect(streamUnitBaseline([{ before: 'first-main', after: 'merged', goal: 'alpha', taskIds: ['stream'], at: 't0' },
      { before: 'later-main', after: 'merged-2', goal: 'alpha', taskIds: ['stream'], at: 't1' }], ['stream'], 'current'))
      .toBe('current');
  });

  test('a classification checkout includes .temp', () => {
    const root = mkdtempSync(join(import.meta.dir, '../../.temp/gate-worktree-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
    const checkout = join(root, '.temp', 'checkout');
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'goal@example.invalid');
      git('config', 'user.name', 'goalctl test');
      writeFileSync(join(root, 'keep.ts'), 'export const value = 1;\n');
      git('add', 'keep.ts');
      git('commit', '-qm', 'start');
      mkdirSync(join(root, '.temp'));
      addGateWorktree(root, checkout, 'HEAD');
      expect(existsSync(join(checkout, '.temp'))).toBe(true);
      expect(existsSync(join(checkout, 'keep.ts'))).toBe(true);
      expect(spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' }).status).toBe(0);
    } finally {
      spawnSync('git', ['-C', root, 'worktree', 'remove', '--force', checkout]);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a merge record with no file list is recovered from its two commits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-merge-files-'));
    const git = (...args: string[]) => {
      const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'goal@example.invalid');
      git('config', 'user.name', 'goalctl test');
      writeFileSync(join(dir, 'base.ts'), 'export const value = 1;\n');
      git('add', 'base.ts');
      git('commit', '-qm', 'base');
      const before = git('rev-parse', 'HEAD');
      writeFileSync(join(dir, 'base.ts'), 'export const value = 2;\n');
      writeFileSync(join(dir, 'added.ts'), 'export const added = true;\n');
      git('add', 'base.ts', 'added.ts');
      git('commit', '-qm', 'change');
      const after = git('rev-parse', 'HEAD');
      const own = ['services/main/src/stream-only.ts'];
      const event = { before, after, goal: 'alpha', taskIds: ['stream'], at: 't0' };
      expect(streamSelectionFiles(own, [event], ['stream'], dir)).toEqual(
        ['added.ts', 'base.ts', 'services/main/src/stream-only.ts']);
      // No checkout to read: a missing list cannot invent paths.
      expect(streamSelectionFiles(own, [event], ['stream'])).toEqual(own);
      expect(streamSelectionFiles(own, [{ ...event, files: ['kept.ts'] }], ['stream'], dir)).toEqual(
        ['kept.ts', 'services/main/src/stream-only.ts']);
      // An explicit empty list is a merge that changed nothing.
      expect(streamSelectionFiles(own, [{ ...event, files: [] }], ['stream'], dir)).toEqual(own);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  /** A `task` that stands in for the owner tier, plus a docker that does not touch the daemon. */
  async function withOwnerStub(mode: 'budget' | 'fail' | 'hang', deadlineMs: number): Promise<{
    result: UnitShardResult; budget: string; args: string[];
  }> {
    const directory = mkdtempSync(join(tmpdir(), 'goalctl-owner-shard-'));
    const bin = join(directory, 'bin');
    const log = join(directory, 'stub.log');
    mkdirSync(bin);
    writeFileSync(join(bin, 'task'), `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const record = process.env.GOAL_STUB_LOG;
if (record) appendFileSync(record, JSON.stringify({ args: process.argv.slice(2), budget: process.env.REZICS_QA_OWNER_BUDGET_MS ?? '' }) + '\\n');
const mode = process.env.GOAL_STUB_MODE;
if (mode === 'hang') {
  const progress = process.env.REZICS_QA_PROGRESS_FILE;
  if (progress) appendFileSync(progress, 'slow.test.ts:\\n');
  await Bun.sleep(60_000);
}
if (mode === 'budget') {
  process.stderr.write('slow.test.ts:\\nQA tier budget exceeded: owner 970000ms\\n');
  process.exit(1);
}
if (mode === 'fail') {
  process.stderr.write('slow.test.ts:\\n(fail) breaks\\n');
  process.exit(1);
}
process.exit(0);
`);
    writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(bin, 'task'), 0o755);
    chmodSync(join(bin, 'docker'), 0o755);
    const previous = { PATH: process.env.PATH, mode: process.env.GOAL_STUB_MODE, log: process.env.GOAL_STUB_LOG };
    process.env.PATH = `${bin}:${process.env.PATH ?? ''}`;
    process.env.GOAL_STUB_MODE = mode;
    process.env.GOAL_STUB_LOG = log;
    try {
      const result = await runOwnerShard(directory, ['slow.test.ts', 'later.test.ts'], Date.now() + deadlineMs);
      const recorded = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; budget: string };
      return { result, budget: recorded.budget, args: recorded.args };
    } finally {
      if (previous.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = previous.PATH;
      if (previous.mode === undefined) delete process.env.GOAL_STUB_MODE;
      else process.env.GOAL_STUB_MODE = previous.mode;
      if (previous.log === undefined) delete process.env.GOAL_STUB_LOG;
      else process.env.GOAL_STUB_LOG = previous.log;
      rmSync(directory, { recursive: true, force: true });
    }
  }

  test('an owner command that stops at its own budget leaves the shard unfinished', async () => {
    expect(ownerTierBudgetMs({})).toBe(600_000);
    expect(ownerTierBudgetMs({ REZICS_QA_OWNER_BUDGET_MS: '' })).toBe(600_000);
    expect(ownerTierBudgetMs({ REZICS_QA_OWNER_BUDGET_MS: '970000' })).toBe(970_000);
    expect(() => ownerTierBudgetMs({ REZICS_QA_OWNER_BUDGET_MS: '600s' })).toThrow('positive integer');
    const stopped = await withOwnerStub('budget', 970_000);
    expect(stopped.args).toEqual(['test', '--', 'slow.test.ts', 'later.test.ts']);
    expect(Number(stopped.budget)).toBeGreaterThan(900_000);
    expect(Number(stopped.budget)).toBeLessThanOrEqual(970_000);
    // The running file is retried alone. The file with no header runs again with the rest of the shard.
    expect(stopped.result).toMatchObject({
      done: false, budgetExpired: true, timedOut: ['slow.test.ts'], files: ['slow.test.ts', 'later.test.ts'], failing: [],
    });
    const failed = await withOwnerStub('fail', 970_000);
    expect(failed.result.done).toBe(true);
    expect(failed.result.budgetExpired).toBeUndefined();
    expect(failed.result.failing).toEqual(['slow.test.ts']);
  }, 20_000);

  test('an outer kill names the owner file that was running', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'goalctl-owner-progress-'));
    const progress = join(directory, 'progress.txt');
    mkdirSync(join(directory, 'nested'));
    writeFileSync(join(directory, 'nested/slow.test.ts'), `import { beforeAll, test } from 'bun:test';\n`
      + `beforeAll(async () => { await Bun.sleep(5_000); });\ntest('holds', () => {});\n`);
    const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true', REZICS_QA_PROGRESS_FILE: progress };
    delete env.AGENT;
    const child = spawn(process.execPath, ['test', '--preload', join(import.meta.dir, '../qa/owner-shard-progress.ts'),
      'nested/slow.test.ts'], { cwd: directory, env, stdio: 'ignore' });
    try {
      const deadline = Date.now() + 1_000;
      let text = '';
      while (Date.now() < deadline) {
        if (existsSync(progress)) text = readFileSync(progress, 'utf8');
        if (text.includes('nested/slow.test.ts:')) break;
        await Bun.sleep(20);
      }
      // Recorded while beforeAll is still running, which is before the reporter would finish.
      expect(text).toContain('nested/slow.test.ts:');
    } finally {
      const closed = new Promise<void>(resolve => {
        if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
        child.once('close', () => resolve());
      });
      child.kill('SIGKILL');
      await closed;
      rmSync(directory, { recursive: true, force: true });
    }
    const killed = await withOwnerStub('hang', 2_000);
    expect(killed.result.done).toBe(false);
    expect(killed.result.budgetExpired).toBe(true);
    expect(killed.result.timedOut).toEqual(['slow.test.ts']);
    expect(killed.result.files).toEqual(['slow.test.ts', 'later.test.ts']);
  }, 20_000);

  for (const outcome of ['introduced', 'inherited'] as const) {
    test(`a guard absent from the affected plan has its ${outcome} failure compared with committed main`, async () => {
      const r = repo();
      try {
        const guard = repositoryGuards[0].file;
        // The guard scans a source outside its imports, reproducing a route or SQL inventory omission.
        const source = `import { test, expect } from 'bun:test';\nimport { readFileSync } from 'node:fs';\n`
          + `test('repository inventory is valid', () => expect(readFileSync('inventory.ts', 'utf8')).toBe('valid'));\n`;
        mkdirSync(join(r.dir, guard, '..'), { recursive: true });
        writeFileSync(join(r.dir, guard), source);
        writeFileSync(join(r.dir, 'inventory.ts'), outcome === 'inherited' ? 'invalid' : 'valid');
        r.git('add', '.'); r.git('commit', '-qm', 'Baseline inventory guard');
        const task = await r.start('G-001');
        const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push('inventory.ts'); r.save(ledger);
        r.commit(task);
        writeFileSync(join(task.worktree, 'inventory.ts'), 'invalid');
        expect(spawnSync('git', ['-C', task.worktree, 'commit', '--allow-empty', '-qam', 'Change inventory']).status).toBe(0);
        await r.stopFixture(task.id);
        const before = r.git('rev-parse', 'main');
        const log = join(r.dir, '.temp/unit-log');
        // The fixture's default affected plan contains no unit entries at all.
        const result = r.run(['merge', task.id], { GOAL_TEST_LOG: log });
        expect(result.status).toBe(outcome === 'introduced' ? 1 : 0);
        if (outcome === 'introduced') {
          expect(result.stderr).toContain(`introduced unit failures; not merging:\n  ${guard}`);
          expect(r.git('rev-parse', 'main')).toBe(before);
          expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
        } else {
          expect(result.stdout).toContain(`${guard} also fails on main`);
          expect(result.stdout).toContain('reported, not blocking');
          expect(r.ledger().tasks[task.id]!.state).toBe('merged');
        }
        const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        // A branch-only failure is rerun alone on the branch and on main after the shared runs.
        expect(runs).toHaveLength(outcome === 'introduced' ? 5 : 3);
        expect(runs[0].cwd).toBe(task.worktree);
        expect(runs[1].cwd).toBe(task.worktree);
        expect(runs[2].cwd).not.toBe(task.worktree);
        if (outcome === 'introduced') {
          expect(runs[3].cwd).toBe(task.worktree);
          expect(runs[4].cwd).not.toBe(task.worktree);
        }
        expect(runs.every(run => run.args.includes(`./${guard}`))).toBe(true);
        expect(r.git('worktree', 'list', '--porcelain')).not.toContain('unit-gate');
      } finally { r.cleanup(); }
    }, 30_000);
  }

  for (const outcome of ['branch-adds-finding', 'identical-findings'] as const) {
    test(`guard failure details classify ${outcome} against a red main baseline`, async () => {
      const r = repo();
      const guard = 'guard-report.test.ts';
      const findings = 'findings.txt';
      try {
        writeFileSync(join(r.dir, guard), `import { expect, test } from 'bun:test';\n`
          + `import { readFileSync } from 'node:fs';\n`
          + `test('inventory guard has no findings', () => {\n`
          + `  const report = readFileSync(${JSON.stringify(findings)}, 'utf8').trim().split('\\n').filter(Boolean);\n`
          + `  expect(report).toEqual([]);\n});\n`);
        writeFileSync(join(r.dir, findings), 'existing finding\n');
        r.git('add', guard, findings); r.git('commit', '-qm', 'Add a red inventory guard baseline');
        const task = await r.start('G-001');
        const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(findings); r.save(ledger);
        r.commit(task);
        if (outcome === 'branch-adds-finding') {
          const source = readFileSync(join(task.worktree, guard), 'utf8');
          writeFileSync(join(task.worktree, guard), `${source}test('branch adds a finding', () => expect(readFileSync(${JSON.stringify(findings)}, 'utf8')).toBe(''));\n`);
          const claimed = r.ledger();
          claimed.tasks[task.id]!.paths.push(guard);
          r.save(claimed);
          expect(spawnSync('git', ['-C', task.worktree, 'add', guard]).status).toBe(0);
          expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add a failing guard case']).status).toBe(0);
        }
        await r.stopFixture(task.id);
        const plan = join(r.dir, '.temp/unit-plan');
        const log = join(r.dir, '.temp/unit-log');
        writeFileSync(plan, `  unit: ${guard}\n`);
        const before = r.git('rev-parse', 'main');
        const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '1' });
        const introduced = outcome === 'branch-adds-finding';
        expect(result.status).toBe(introduced ? 1 : 0);
        if (introduced) {
          expect(result.stderr).toContain(`introduced unit failures; not merging:\n  ${guard}`);
          const deciding = result.stderr.split('inherited on main:')[0] ?? '';
          expect(deciding).toContain('(fail) branch adds a finding');
          expect(deciding).not.toContain('inventory guard has no findings');
          expect(result.stderr.split('inherited on main:')[1]).toContain('inventory guard has no findings');
          expect(r.git('rev-parse', 'main')).toBe(before);
          expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
        } else {
          expect(result.stdout).toContain(`${guard} also fails on main`);
          expect(r.git('rev-parse', 'main')).toBe(r.git('rev-parse', task.branch));
          expect(r.ledger().tasks[task.id]!.state).toBe('merged');
        }
        const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; args: string[] });
        // An extra case is rerun alone on both sides. Identical findings are not.
        expect(runs).toHaveLength(introduced ? 5 : 3);
        expect(runs[0]!.cwd).toBe(task.worktree);
        expect(runs[1]!.cwd).toBe(task.worktree);
        expect(runs[2]!.cwd).not.toBe(task.worktree);
        if (introduced) {
          expect(runs[3]!.cwd).toBe(task.worktree);
          expect(runs[4]!.cwd).not.toBe(task.worktree);
        }
        expect(runs.every(run => run.args.includes(`./${guard}`))).toBe(true);
      } finally { r.cleanup(); }
    }, 30_000);
  }

  for (const outcome of ['introduced', 'inherited', 'skipped', 'dirty-main', 'new-file'] as const) {
    test(`pre-merge unit gate handles ${outcome} failures before fast-forward`, async () => {
      const r = repo();
      try {
        const file = 'operation.test.ts';
        const source = (fails: boolean) => `import { test, expect } from 'bun:test';\ntest('operation stays valid', () => expect(${fails}).toBe(false));\n`;
        if (outcome !== 'new-file') {
          writeFileSync(join(r.dir, file), source(outcome === 'inherited'));
          r.git('add', file); r.git('commit', '-qm', 'Baseline unit');
        }
        const task = await r.start('G-001');
        const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(file); r.save(ledger);
        writeFileSync(join(task.worktree, file), source(true));
        // Inherited failures still need a task commit to exercise a real merge.
        r.commit(task);
        expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
        expect(spawnSync('git', ['-C', task.worktree, 'commit', '--allow-empty', '-qm', 'Change operation']).status).toBe(0);
        await r.stopFixture(task.id);
        const plan = join(r.dir, '.temp/unit-plan');
        writeFileSync(plan, `  unit: ${file}\n  integration: tests/qa/integration/never.test.ts\n  model: model/tests/never.test.ts\n`);
        const log = join(r.dir, '.temp/unit-log');
        const before = r.git('rev-parse', 'main');
        if (outcome === 'dirty-main') writeFileSync(join(r.dir, file), source(true));
        const blocked = ['introduced', 'dirty-main', 'new-file'].includes(outcome);
        const result = r.run(['merge', task.id, ...(outcome === 'skipped' ? ['--skip-unit-gate'] : [])],
          { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log });
        expect(result.status).toBe(blocked ? 1 : 0);
        if (blocked) {
          expect(r.git('rev-parse', 'main')).toBe(before);
          expect(result.stderr).toContain('introduced unit failures');
          expect(result.stderr).toContain('(fail) operation stays valid');
          expect(result.stderr).toContain('Expected: false');
          expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
        } else {
          expect(r.git('rev-parse', 'main')).toBe(r.git('rev-parse', task.branch));
          expect(result.stdout).toContain(outcome === 'skipped' ? '--skip-unit-gate' : 'also fails on main');
        }
        if (outcome === 'introduced' || outcome === 'inherited') {
          expect(result.stdout).toContain('Unit gate evidence (affected,');
          expect(result.stdout).toContain('(fail) operation stays valid');
          expect(result.stdout).toContain('Expected: false');
          const evidenceDir = join(r.dir, '.temp/goal-orchestration/merges');
          const evidenceFiles = readdirSync(evidenceDir).filter(name => name.endsWith('.json'));
          expect(evidenceFiles.length).toBeGreaterThan(0);
          const stored = evidenceFiles.map(name => readFileSync(join(evidenceDir, name), 'utf8')).join('\n');
          expect(stored).toContain('operation stays valid');
          expect(stored).toContain('Expected: false');
        }
        if (outcome === 'inherited') expect(result.stdout).toContain('Unit gate evidence (main,');
        if (outcome === 'skipped') expect(existsSync(log)).toBe(false);
        else {
          const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          // Shard, confirm, then main when the file exists. A branch-only failure is rerun alone on each side it can run.
          expect(runs).toHaveLength(outcome === 'inherited' ? 3 : outcome === 'new-file' ? 3 : 5);
          expect(runs[0].cwd).toBe(task.worktree);
          expect(runs[1].cwd).toBe(task.worktree);
          if (outcome === 'new-file') expect(runs[2].cwd).toBe(task.worktree);
          else expect(runs[2].cwd).not.toBe(task.worktree);
          if (outcome === 'introduced') {
            expect(runs[3].cwd).toBe(task.worktree);
            expect(runs[4].cwd).not.toBe(task.worktree);
          }
          expect(runs.every(run => run.args.includes(`./${file}`))).toBe(true);
          expect(runs.every(run => !run.args.some((arg: string) => arg.includes('never.test')))).toBe(true);
          expect(r.git('worktree', 'list', '--porcelain')).not.toContain('unit-gate');
        }
        if (outcome === 'introduced') {
          writeFileSync(join(task.worktree, file), source(false));
          expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qam', 'Restore operation']).status).toBe(0);
          expect(r.run(['merge', task.id], { GOAL_TEST_PLAN: plan }).status).toBe(0);
          expect(r.ledger().tasks[task.id]!.state).toBe('merged');
        }
      } finally { r.cleanup(); }
    }, 30_000);
  }

  test('an unattributed task runner failure blocks with its diagnostic', async () => {
    const r = repo();
    try {
      const file = 'runner-failure.test.ts';
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(file); r.save(ledger);
      writeFileSync(join(task.worktree, file), "import { expect, test } from 'bun:test';\ntest('passes', () => expect(true).toBe(true));\n");
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add runner failure probe']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      const log = join(r.dir, '.temp/unit-log');
      writeFileSync(plan, `  unit: ${file}\n`);
      const before = r.git('rev-parse', 'main');
      // This exact diagnostic line was captured from the real Taskfile failure probe in .temp/goal-gate-probes.
      const diagnostic = 'task: Task "goal:unit-files-missing-probe" does not exist';
      const result = r.run(['merge', task.id], {
        GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_TEST_RUNNER_FAILURE: diagnostic,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unit gate inconclusive: unattributed affected runner failure; not merging');
      expect(result.stderr).toContain(diagnostic);
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(runs).toHaveLength(1);
      expect(runs[0].args).toContain(`./${file}`);
      expect(r.git('worktree', 'list', '--porcelain')).not.toContain('unit-gate');
    } finally { r.cleanup(); }
  }, 30_000);

  test('eight affected files run as four shards and the union of their failures is reported', async () => {
    const r = repo();
    try {
      const files = Array.from({ length: 8 }, (_, index) => `gate-shard-${index}.test.ts`);
      const failing = new Set([files[0]!, files[7]!]);
      const source = (fails: boolean) => `import { test, expect } from 'bun:test';\n`
        + `test('stays valid', () => expect(${fails}).toBe(false));\n`;
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(...files); r.save(ledger);
      for (const file of files) writeFileSync(join(task.worktree, file), source(failing.has(file)));
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', ...files]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add sharded units']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, files.map(file => `  unit: ${file}`).join('\n') + '\n');
      const log = join(r.dir, '.temp/unit-log');
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '4' });
      expect(result.status).toBe(1);
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      const reported = result.stderr.split('introduced unit failures')[1] ?? '';
      expect(reported).toContain(files[0]!);
      expect(reported).toContain(files[7]!);
      for (const file of files) if (!failing.has(file)) expect(reported).not.toContain(file);
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; args: string[] });
      const filesOf = (run: { args: string[] }) => run.args.filter(arg => arg.endsWith('.test.ts')).sort();
      const confirmed = runs.filter(run => filesOf(run).join() === [`./${files[0]}`, `./${files[7]}`].sort().join());
      expect(confirmed).toHaveLength(1);
      expect(confirmed[0]!.cwd).toBe(task.worktree);
      const shards = runs.filter(run => filesOf(run).length === 2 && run !== confirmed[0]);
      expect(shards).toHaveLength(4);
      for (const file of failing) {
        expect(runs.filter(run => filesOf(run).join() === `./${file}` && run.cwd === task.worktree)).toHaveLength(1);
      }
      expect(shards.every(run => run.cwd === task.worktree)).toBe(true);
      const groups = shards.map(filesOf);
      expect(groups.every(group => group.length === 2)).toBe(true);
      expect(groups.flat().sort()).toEqual(files.map(file => `./${file}`).sort());
      expect(new Set(groups.flat()).size).toBe(files.length);
    } finally { r.cleanup(); }
  }, 45_000);

  test('a failure that disappears when the failing files run together is order-dependent and not blocking', async () => {
    const r = repo();
    try {
      const mate = 'aa-mate.test.ts';
      const stable = 'bb-stable.test.ts';
      const dependent = 'cc-dependent.test.ts';
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(mate, stable, dependent); r.save(ledger);
      writeFileSync(join(task.worktree, mate), `import { test } from 'bun:test';\n`
        + `test('leaves a mark for a later file in this process', () => { (globalThis as { shardMate?: boolean }).shardMate = true; });\n`);
      writeFileSync(join(task.worktree, stable), `import { expect, test } from 'bun:test';\n`
        + `test('stays invalid', () => expect(true).toBe(false));\n`);
      writeFileSync(join(task.worktree, dependent), `import { expect, test } from 'bun:test';\n`
        + `test('passes unless an earlier file in this process left a mark', () => expect((globalThis as { shardMate?: boolean }).shardMate).toBe(undefined));\n`);
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', mate, stable, dependent]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add order-dependent units']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, `  unit: ${mate}\n  unit: ${stable}\n  unit: ${dependent}\n`);
      const log = join(r.dir, '.temp/unit-log');
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '2' });
      expect(result.status).toBe(1);
      expect(r.git('rev-parse', 'main')).toBe(before);
      const reported = result.stderr.split('introduced unit failures')[1] ?? '';
      expect(reported).toContain(stable);
      expect(reported).not.toContain(dependent);
      expect(reported).not.toContain(mate);
      const noted: string[] = [];
      for (const line of (result.stdout.split('order-dependent, reported, not blocking\n')[1] ?? '').split('\n')) {
        if (!line.startsWith('  ')) break;
        noted.push(line.trim());
      }
      expect(noted).toEqual([dependent]);
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; args: string[] });
      const filesOf = (run: { args: string[] }) => run.args.filter(arg => arg.endsWith('.test.ts')).sort();
      const confirmation = runs.filter(run => filesOf(run).join() === [`./${dependent}`, `./${stable}`].sort().join());
      expect(confirmation).toHaveLength(1);
      expect(confirmation[0]!.cwd).toBe(task.worktree);
      expect(runs.filter(run => filesOf(run).includes(`./${mate}`))).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 45_000);

  test('a failure that passes when its file runs alone is order or load dependent and not blocking', async () => {
    const r = repo();
    try {
      const keeper = 'aa-keeps-failing.test.ts';
      const dependent = 'bb-load-dependent.test.ts';
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(keeper, dependent); r.save(ledger);
      writeFileSync(join(task.worktree, keeper), `import { expect, test } from 'bun:test';\n`
        + `test('stays invalid and marks this process', () => { (globalThis as { shardMate?: boolean }).shardMate = true; expect(true).toBe(false); });\n`);
      writeFileSync(join(task.worktree, dependent), `import { expect, test } from 'bun:test';\n`
        + `test('passes unless another file in this process left a mark', () => expect((globalThis as { shardMate?: boolean }).shardMate).toBe(undefined));\n`);
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', keeper, dependent]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add load-dependent units']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, `  unit: ${keeper}\n  unit: ${dependent}\n`);
      const log = join(r.dir, '.temp/unit-log');
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '1' });
      expect(result.status).toBe(1);
      expect(r.git('rev-parse', 'main')).toBe(before);
      const reported = result.stderr.split('introduced unit failures')[1] ?? '';
      expect(reported).toContain(keeper);
      expect(reported).not.toContain(dependent);
      const noted: string[] = [];
      for (const line of (result.stdout.split('order or load dependent, reported, not blocking\n')[1] ?? '').split('\n')) {
        if (!line.startsWith('  ')) break;
        noted.push(line.trim());
      }
      expect(noted).toEqual([dependent]);
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { cwd: string; args: string[] });
      const filesOf = (run: { args: string[] }) => run.args.filter(arg => arg.endsWith('.test.ts')).sort();
      expect(runs.filter(run => filesOf(run).join() === `./${dependent}` && run.cwd === task.worktree)).toHaveLength(1);
      expect(runs.filter(run => filesOf(run).join() === `./${keeper}` && run.cwd === task.worktree)).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 45_000);

  test('a unit gate timeout that remains inconclusive after an isolated retry blocks the merge', async () => {
    const r = repo();
    try {
      const fast = 'gate-fast.test.ts';
      const slow = 'gate-slow.test.ts';
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(fast, slow); r.save(ledger);
      writeFileSync(join(task.worktree, fast), `import { test, expect } from 'bun:test';\n`
        + `test('finishes', () => expect(true).toBe(true));\n`);
      // The timeout is a binding, so the gate cannot extend the shard and still stops at its own budget.
      writeFileSync(join(task.worktree, slow), `import { setDefaultTimeout, test } from 'bun:test';\n`
        + `const gateTimeout = 120_000;\nsetDefaultTimeout(gateTimeout);\ntest('runs past the gate budget', async () => { await Bun.sleep(90_000); });\n`);
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', fast, slow]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add budget probes']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, `  unit: ${fast}\n  unit: ${slow}\n`);
      const log = join(r.dir, '.temp/unit-log');
      const before = r.git('rev-parse', 'main');
      const started = Date.now();
      const result = r.run(['merge', task.id], {
        GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '2', GOAL_UNIT_GATE_BUDGET_MS: '8000',
      }, 40_000);
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(30_000);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('inconclusive');
      expect(result.stderr).toContain('unit gate remains inconclusive after isolated timeout retry');
      expect(result.stdout).toContain(`${slow} timed out on affected; rerunning alone`);
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
      expect(runs).toHaveLength(3);
      expect(runs.map(run => run.args.filter(arg => arg.endsWith('.test.ts')).join(' ')).sort())
        .toEqual([`./${fast}`, `./${slow}`, `./${slow}`]);
      expect(runs[2]!.args.filter(arg => arg.endsWith('.test.ts'))).toEqual([`./${slow}`]);
      const hanging = readdirSync('/proc').some(entry => {
        if (!/^\d+$/.test(entry)) return false;
        try { return readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(slow); }
        catch { return false; }
      });
      expect(hanging).toBe(false);
    } finally { r.cleanup(); }
  }, 60_000);

  test('files a timed-out shard never started run again and the merge lands', async () => {
    const r = repo();
    try {
      const slow = 'aa-slow-once.test.ts';
      const later = ['bb-later.test.ts', 'cc-later.test.ts'];
      const task = await r.start('G-001');
      const ledger = r.ledger(); ledger.tasks[task.id]!.paths.push(slow, ...later); r.save(ledger);
      const seen = join(r.dir, '.temp/slow-once-seen');
      // Slow only on the first run, so the isolated retry of this file finishes.
      // The timeout is a binding, so the gate cannot extend the shard and still stops at its own budget.
      writeFileSync(join(task.worktree, slow), `import { existsSync, writeFileSync } from 'node:fs';\n`
        + `import { setDefaultTimeout, test } from 'bun:test';\nconst gateTimeout = 120_000;\nsetDefaultTimeout(gateTimeout);\n`
        + `test('slow once', async () => { if (existsSync(${JSON.stringify(seen)})) return; writeFileSync(${JSON.stringify(seen)}, ''); await Bun.sleep(90_000); });\n`);
      for (const file of later) {
        writeFileSync(join(task.worktree, file), `import { expect, test } from 'bun:test';\ntest('passes', () => expect(true).toBe(true));\n`);
      }
      r.commit(task);
      expect(spawnSync('git', ['-C', task.worktree, 'add', slow, ...later]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add shard probes']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, [slow, ...later].map(file => `  unit: ${file}`).join('\n') + '\n');
      const log = join(r.dir, '.temp/unit-log');
      const result = r.run(['merge', task.id], {
        GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log, GOAL_UNIT_GATE_SHARDS: '1', GOAL_UNIT_GATE_BUDGET_MS: '8000',
      }, 40_000);
      expect(result.stderr).not.toContain('inconclusive');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('were not reached; continuing');
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] })
        .map(run => run.args.filter(arg => arg.endsWith('.test.ts')));
      expect(runs[0]).toHaveLength(3);
      // Bun names no file before the budget stops it, so the rerun may include the slow one; the rest must be there.
      expect(runs[1]).toEqual(expect.arrayContaining(later.map(file => `./${file}`)));
    } finally { r.cleanup(); }
  }, 60_000);

  test('a manually landed cherry-pick records its boundary and preserves intervening maintainer commits', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task); await r.stopFixture(task.id);
      writeFileSync(join(r.dir, 'maintainer.ts'), 'export {};\n');
      r.git('add', 'maintainer.ts'); r.git('commit', '-qm', 'Maintainer edit');
      const before = r.git('rev-parse', 'main');
      r.git('cherry-pick', task.branch);
      const after = r.git('rev-parse', 'main');
      expect(r.run(['merge', task.id, '--landed']).status).toBe(0);
      const path = join(r.dir, '.temp/goal-orchestration/merges.jsonl');
      expect(JSON.parse(readFileSync(path, 'utf8').trim())).toMatchObject({ before, after, goal: 'alpha', taskIds: [task.id] });
      expect(r.run(['merge', task.id, '--landed']).status).toBe(0);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    } finally { r.cleanup(); }
  }, 30_000);

  test('inbox lists, acknowledges a displayed line and status prints the unacknowledged count', () => {
    const r = repo();
    try {
      const dir = join(r.dir, '.temp/goal-orchestration/inbox'); mkdirSync(dir);
      const entry = { runId: 'run', atCommit: 'sha', failingTests: ['file'], after: 'sha', goal: 'alpha', taskIds: [],
        status: 'inconclusive', classification: 'deterministic', artifactPaths: [] };
      writeFileSync(join(dir, 'alpha.jsonl'), `${JSON.stringify(entry)}\n`);
      expect(r.run(['status']).stdout).toContain('1 unacknowledged regressions');
      expect(JSON.parse(r.run(['inbox']).stdout.trim())).toMatchObject({ number: 1, acknowledged: false });
      expect(r.run(['inbox', '--ack', '1']).status).toBe(0);
      expect(JSON.parse(r.run(['inbox']).stdout.trim())).toMatchObject({ acknowledged: true });
      expect(r.run(['inbox', '--ack', '2']).status).toBe(1);
      expect(r.run(['status']).stdout).not.toContain('1 unacknowledged regressions');
    } finally { r.cleanup(); }
  });

  test('status keeps pending inboxes visible after a Goal closes or leaves the ledger', () => {
    const r = repo();
    try {
      const ledger = r.ledger(); ledger.goals!.alpha!.closedAt = new Date().toISOString(); r.save(ledger);
      const dir = join(r.dir, '.temp/goal-orchestration/inbox'); mkdirSync(dir);
      for (const goal of ['alpha', 'retired-owner']) {
        const entry = { runId: 'run', atCommit: 'sha', failingTests: ['file'], after: 'sha', goal, taskIds: [],
          status: 'inconclusive', classification: 'deterministic', artifactPaths: [] };
        writeFileSync(join(dir, `${goal}.jsonl`), `${JSON.stringify(entry)}\n`);
      }
      const pending = r.run(['status']);
      expect(pending.status).toBe(0);
      for (const goal of ['alpha', 'retired-owner']) {
        expect(pending.stdout).toContain(`Goal ${goal}: inactive; 1 unacknowledged regressions`);
        expect(r.run(['inbox', '--ack', '1'], { GOAL_ID: goal }).status).toBe(0);
      }
      const acknowledged = r.run(['status']);
      expect(acknowledged.status).toBe(0);
      expect(acknowledged.stdout).not.toContain('inactive; 1 unacknowledged regressions');
      expect(acknowledged.stdout).toContain('Goal beta:');
    } finally { r.cleanup(); }
  });

  test('manual merge attribution preserves whitespace that changes a string value', () => {
    const r = repo();
    try {
      const base = r.git('rev-parse', 'HEAD');
      r.git('checkout', '-b', 'worker');
      writeFileSync(join(r.dir, 'value.ts'), "export const value = 'a b';\n");
      r.git('add', 'value.ts'); r.git('commit', '-qm', 'Worker');
      r.git('checkout', 'main');
      writeFileSync(join(r.dir, 'value.ts'), "export const value = 'ab';\n");
      r.git('add', 'value.ts'); r.git('commit', '-qm', 'Different maintainer value');
      const after = r.git('rev-parse', 'HEAD');
      expect(landedBoundary(r.dir, { base, branch: 'worker' }, after)).toBe(after);
    } finally { r.cleanup(); }
  });

  test('test records queue, test and total time and retains its first test argument', () => {
    const r = repo();
    try {
      mkdirSync(join(r.dir, 'scripts/qa'), { recursive: true });
      writeFileSync(join(r.dir, 'scripts/qa/test.ts'), "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.REGRESSION_ARGUMENTS!, JSON.stringify(process.argv.slice(2)));\n");
      writeFileSync(join(r.dir, '.temp/bin/docker'), '#!/bin/sh\nexit 0\n'); chmodSync(join(r.dir, '.temp/bin/docker'), 0o755);
      const report = join(r.dir, '.temp/result.json'); const args = join(r.dir, '.temp/args.json');
      expect(r.run(['test', 'example.test.ts', '--result-file', report], { REGRESSION_ARGUMENTS: args }).status).toBe(0);
      expect(JSON.parse(readFileSync(args, 'utf8'))).toEqual(['example.test.ts']);
      const result = JSON.parse(readFileSync(report, 'utf8'));
      expect(result.code).toBe(0);
      expect(result.totalMs).toBe(result.queueMs + result.testMs);
      expect(result.testMs).toBeGreaterThanOrEqual(0);
    } finally { r.cleanup(); }
  });

  test('refuses a shared merge while another sharer is running', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first);
      await r.stopFixture(first.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', first.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('G-002 is still running; stop it first');
      expect(r.git('rev-parse', 'main')).toBe(before);
    } finally { r.cleanup(); }
  });

  test('refuses files outside every shared claim', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      await r.start('G-002', 'alpha', 'wave-1');
      r.commit(first, 'unclaimed.ts');
      await r.stopFixture(first.id);
      await r.stopFixture('G-002');
      const result = r.run(['merge', first.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unclaimed.ts');
    } finally { r.cleanup(); }
  });

  test('two Goals naming wave-1 get different trees and branches', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001', 'alpha', 'wave-1');
      const second = await r.start('G-002', 'beta', 'wave-1');
      expect(first.worktree).toBe(join(r.dir, '.temp/worktrees/alpha-wave-1'));
      expect(second.worktree).toBe(join(r.dir, '.temp/worktrees/beta-wave-1'));
      expect(first.branch).toBe('goal/alpha-wave-1');
      expect(second.branch).toBe('goal/beta-wave-1');
    } finally { r.cleanup(); }
  });

  test('refuses joining a tree occupied by another Goal even when its worker has exited', async () => {
    const r = repo();
    try {
      await r.start('G-001', 'alpha', 'wave-1');
      await r.stopFixture('G-001');
      const value = r.ledger();
      value.tasks['G-001']!.goal = 'beta';
      r.save(value);
      const result = r.run(['dispatch', r.brief('G-002', { worktree: 'wave-1' }), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('another Goal');
    } finally { r.cleanup(); }
  });

  test('dispatch refuses an unknown dependency with the cross-Goal contract location', () => {
    const r = repo();
    try {
      const result = r.run(['dispatch', r.brief('G-001', { depends: 'G-999' }), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Unknown dependency G-999');
      expect(result.stderr).toContain('docs/goals/program/state.md');
    } finally { r.cleanup(); }
  });

  test('dispatch dry-run refuses a brief without Mechanisms or with an unknown id', () => {
    const r = repo();
    try {
      const missing = join(r.dir, '.temp/no-mechanisms.md');
      writeFileSync(missing, ['---', 'id: G-070', 'title: No mechanisms', 'effort: high', 'engine: grok',
        'paths: [worker-070.ts]', '---', '', '## Outcome', '', 'Do the thing.', ''].join('\n'));
      const refused = r.run(['dispatch', missing, '--dry-run']);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('## Mechanisms');
      expect(r.ledger().tasks['G-070']).toBeUndefined();
      const unknown = join(r.dir, '.temp/unknown-mechanism.md');
      writeFileSync(unknown, ['---', 'id: G-071', 'title: Unknown mechanism', 'effort: high', 'engine: grok',
        'paths: [worker-071.ts]', '---', '', '## Mechanisms', '', '- not-a-mechanism: consume', ''].join('\n'));
      const named = r.run(['dispatch', unknown, '--dry-run']);
      expect(named.status).toBe(1);
      expect(named.stderr).toContain('unknown mechanism: not-a-mechanism');
      const created = r.run(['new', '--goal', 'alpha', 'Example outcome']);
      expect(created.status, created.stderr).toBe(0);
      const written = created.stdout.match(/docs\/goals\/alpha\/tasks\/G-\d+\.md/);
      expect(written).not.toBeNull();
      const text = readFileSync(join(r.dir, written![0]!), 'utf8');
      expect(text).toContain('## Mechanisms');
      expect(text).toContain('\nnone\n');
    } finally { r.cleanup(); }
  });

  function claudeUsage(week: number, fiveHour = 10) {
    const now = Math.floor(Date.now() / 1000);
    return JSON.stringify({ at: now, rate_limits: {
      five_hour: { used_percentage: fiveHour, resets_at: now + 3600 },
      seven_day: { used_percentage: week, resets_at: now + 160 * 3600 } } });
  }

  function admitWake(dir: string, env: NodeJS.ProcessEnv, engine: string) {
    return spawnSync(process.execPath, ['-e',
      `import { managerWakeGates } from ${JSON.stringify(join(import.meta.dir, 'goalctl.ts'))};\n`
      + `console.log(JSON.stringify(managerWakeGates(${JSON.stringify(engine)})));\n`],
      { cwd: dir, encoding: 'utf8', env, timeout: 30_000 });
  }

  test('a Claude manager wake is admitted at restricted and critical usage while workers are at the cap', async () => {
    const r = repo();
    try {
      await r.start('G-001');
      const env = { ...r.env, GOAL_MAX_WORKERS: '1' };
      for (const [week, level] of [[12, 'restricted'], [96, 'critical']] as const) {
        writeFileSync(r.env.GOAL_USAGE_FILE!, claudeUsage(week));
        const result = admitWake(r.dir, env, 'claude');
        expect(result.status, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ live: 1, limit: 1, claude: level });
      }
    } finally { r.cleanup(); }
  });

  test('a Claude worker dispatch is still refused at restricted usage', () => {
    const r = repo();
    try {
      writeFileSync(r.env.GOAL_USAGE_FILE!, claudeUsage(12));
      const result = r.run(['dispatch', r.brief('G-001', { engine: 'claude' }), '--dry-run']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Claude usage is restricted');
      expect(result.stderr).toContain('7d projected');
      expect(r.ledger().tasks['G-001']).toBeUndefined();
    } finally { r.cleanup(); }
  });

  test('a manager wake is refused below the memory floor and when its Codex account is reached', () => {
    const r = repo();
    try {
      writeFileSync(r.env.GOAL_USAGE_FILE!, claudeUsage(12));
      const memory = admitWake(r.dir, { ...r.env, GOAL_MEMORY_FLOOR_GIB: '1000000000' }, 'claude');
      expect(memory.status).toBe(1);
      expect(memory.stderr).toContain('Memory floor reached: host MemAvailable');
      expect(memory.stderr).toContain('GOAL_MEMORY_FLOOR_GIB=1000000000');
      for (const home of [r.env.GOAL_CODEX_HOME!, r.env.GOAL_CODEX_1_HOME!]) {
        const sessions = join(home, 'sessions/2026/10/07');
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: {
          type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 10080,
            resets_at: Date.now() / 1000 + 3600 } } } }));
      }
      // The second account stays open, so only the manager's own reached account refuses the wake.
      writeFileSync(join(r.env.GOAL_CODEX_1_HOME!, 'sessions/2026/10/07/rollout.jsonl'), JSON.stringify({
        type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary: { used_percent: 10,
          window_minutes: 10080, resets_at: Date.now() / 1000 + 3600 } } } }));
      for (const engine of ['codex', 'luna']) {
        const result = admitWake(r.dir, r.env, engine);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('EXHAUSTED');
        expect(result.stderr).not.toContain('Claude usage is restricted');
      }
      const other = admitWake(r.dir, { ...r.env, GOAL_MAX_WORKERS: '0' }, 'codex-1');
      expect(other.status, other.stderr).toBe(0);
      expect(JSON.parse(other.stdout)).toMatchObject({ live: 0, limit: 0, claude: 'restricted' });
    } finally { r.cleanup(); }
  });

  test('status shows the rounded weekly range while Claude dispatch uses its low end', () => {
    const r = repo();
    try {
      const now = Math.floor(Date.now() / 1000);
      const resets = now + 3600;
      const weekResets = now + 160 * 3600;
      const snapshot = (week: number) => JSON.stringify({ at: now, rate_limits: {
        five_hour: { used_percentage: 10, resets_at: resets },
        seven_day: { used_percentage: week, resets_at: weekResets } } });
      writeFileSync(r.env.GOAL_USAGE_FILE!, snapshot(7));
      writeFileSync(join(r.dir, '.temp/goal-orchestration/usage-history.json'), JSON.stringify([
        { at: now - 3600, used: 5, resets, week: 6, weekResets },
      ]));
      const status = r.run(['status']);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain('projected 7–327%');
      expect(status.stdout).toContain('warning');
      const brief = r.brief('G-001', { engine: 'claude' });
      expect(r.run(['dispatch', brief, '--dry-run']).status).toBe(0);
      writeFileSync(r.env.GOAL_USAGE_FILE!, snapshot(12));
      const dispatch = r.run(['dispatch', brief, '--dry-run']);
      expect(dispatch.status).toBe(1);
      expect(dispatch.stderr).toContain('7d projected');
    } finally { r.cleanup(); }
  });

  test('resume checks the live-worker limit even with --force-usage', async () => {
    const r = repo();
    try {
      await r.start('G-001');
      await r.start('G-002');
      await r.stopFixture('G-001');
      for (const flags of [[], ['--force-usage']]) {
        const result = r.run(['resume', 'G-001', '-m', 'continue', ...flags], { GOAL_MAX_WORKERS: '1' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Concurrency limit reached: 1/1 live workers');
        expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(1);
      }
    } finally { r.cleanup(); }
  });

  test('dispatch and resume refuse below the memory floor even with --force-usage', async () => {
    const r = repo();
    try {
      const brief = r.brief('G-001');
      for (const flags of [[], ['--force-usage']]) {
        const result = r.run(['dispatch', brief, ...flags], { GOAL_MEMORY_FLOOR_GIB: '1000000000' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Memory floor reached: host MemAvailable');
        expect(r.ledger().tasks['G-001']).toBeUndefined();
        expect(existsSync(join(r.dir, '.temp/worktrees/g-001'))).toBe(false);
      }
      await r.start('G-001');
      await r.stopFixture('G-001');
      for (const flags of [[], ['--force-usage']]) {
        const result = r.run(['resume', 'G-001', '-m', 'continue', ...flags], { GOAL_MEMORY_FLOOR_GIB: '1000000000' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Memory floor reached: host MemAvailable');
        expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(1);
      }
    } finally { r.cleanup(); }
  });

  test('resume checks the chosen engine usage and --force-usage overrides it', async () => {
    const r = repo();
    try {
      await r.start('G-001');
      await r.stopFixture('G-001');
      writeFileSync(r.env.GOAL_USAGE_FILE!, JSON.stringify({ at: Date.now() / 1000, rate_limits: {
        five_hour: { used_percentage: 100, resets_at: Date.now() / 1000 + 3600 } } }));
      for (const home of [r.env.GOAL_CODEX_HOME!, r.env.GOAL_CODEX_1_HOME!]) {
        const sessions = join(home, 'sessions/2026/10/07');
        mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, 'rollout.jsonl'), JSON.stringify({ type: 'event_msg', payload: {
          type: 'token_count', rate_limits: { primary: { used_percent: 100, window_minutes: 10080,
            resets_at: Date.now() / 1000 + 3600 } } } }));
      }
      for (const engine of ['claude', 'sonnet', 'fable', 'codex', 'codex-1', 'luna']) {
        const result = r.run(['resume', 'G-001', '-m', 'continue', '--engine', engine]);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(engine.startsWith('codex') || engine === 'luna' ? 'EXHAUSTED' : 'Claude usage is critical');
        expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(1);
      }
      // A fake Claude executable proves the escape reaches launch without calling a real engine.
      copyFileSync(join(r.dir, '.temp/bin/grok'), join(r.dir, '.temp/bin/claude'));
      const result = r.run(['resume', 'G-001', '-m', 'continue', '--engine', 'claude', '--force-usage']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const deadline = Date.now() + 5000;
      while (r.workers.get('G-001')!.worker === (JSON.parse(readFileSync(join(r.dir, '.temp/ready/G-001'), 'utf8')) as { worker: number }).worker
        && Date.now() < deadline) await Bun.sleep(20);
      r.workers.set('G-001', JSON.parse(readFileSync(join(r.dir, '.temp/ready/G-001'), 'utf8')) as { worker: number; child: number });
      expect(r.ledger().tasks['G-001']!.attempts).toHaveLength(2);
    } finally { r.cleanup(); }
  });

  test('a rebase conflict records the refusal, status shows it, and resume clears it', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task);
      writeFileSync(join(r.dir, 'worker-001.ts'), `export const value = 'main';\n`);
      r.git('add', 'worker-001.ts');
      r.git('commit', '-qm', 'Main takes the same file');
      await r.stopFixture(task.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('does not rebase onto main');
      const refusal = r.ledger().tasks[task.id]!.refusal;
      expect(refusal).toContain('does not rebase onto main');
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      expect(r.git('rev-parse', 'main')).toBe(before);
      const status = r.run(['status']);
      expect(status.status).toBe(0);
      expect(status.stdout).toContain(refusal!);
      const resumed = r.run(['resume', task.id, '-m', 'continue']);
      expect(resumed.status).toBe(0);
      const deadline = Date.now() + 5000;
      while (r.workers.get(task.id)!.worker === (JSON.parse(readFileSync(join(r.dir, '.temp/ready', task.id), 'utf8')) as { worker: number }).worker
        && Date.now() < deadline) await Bun.sleep(20);
      r.workers.set(task.id, JSON.parse(readFileSync(join(r.dir, '.temp/ready', task.id), 'utf8')) as { worker: number; child: number });
      expect(r.ledger().tasks[task.id]!.state).toBe('running');
      expect(r.ledger().tasks[task.id]!.refusal).toBeUndefined();
    } finally { r.cleanup(); }
  });

  test('a failing generator blocks the merge and leaves the worktree clean', async () => {
    const r = repo();
    try {
      const generator = `import { writeFileSync } from 'node:fs';\n`
        + `writeFileSync('generated-scratch', 'dirty\\n');\nconsole.error('generator failed');\nprocess.exit(1);\n`;
      mkdirSync(join(r.dir, 'scripts'), { recursive: true });
      writeFileSync(join(r.dir, 'scripts/generate.ts'), generator);
      r.git('add', 'scripts/generate.ts');
      r.git('commit', '-qm', 'Add generator');
      const task = await r.start('G-001');
      r.commit(task);
      await r.stopFixture(task.id);
      const before = r.git('rev-parse', 'main');
      const head = r.git('rev-parse', task.branch);
      const blocked = r.run(['merge', task.id]);
      expect(blocked.status).toBe(1);
      expect(blocked.stderr).toContain('generated artifacts could not be regenerated; run task gen');
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      expect(r.ledger().tasks[task.id]!.refusal).toContain('run task gen');
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.git('rev-parse', task.branch)).toBe(head);
      expect(existsSync(join(task.worktree, 'generated-scratch'))).toBe(false);
      expect(spawnSync('git', ['-C', task.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).stdout).toBe('');
    } finally { r.cleanup(); }
  });

  test('regeneration that repairs stale output then passes check does not block the merge', async () => {
    const r = repo();
    try {
      const generator = `import { existsSync, unlinkSync } from 'node:fs';\n`
        + `if (!process.argv.includes('--check') && existsSync('stale-generated')) unlinkSync('stale-generated');\n`
        + `if (process.argv.includes('--check') && existsSync('stale-generated')) { console.error('generated output is stale'); process.exit(1); }\n`;
      mkdirSync(join(r.dir, 'scripts'), { recursive: true });
      writeFileSync(join(r.dir, 'scripts/generate.ts'), generator);
      r.git('add', 'scripts/generate.ts');
      r.git('commit', '-qm', 'Add generator');
      const task = await r.start('G-001');
      const ledger = r.ledger();
      ledger.tasks[task.id]!.paths.push('stale-generated');
      r.save(ledger);
      writeFileSync(join(task.worktree, 'stale-generated'), 'stale\n');
      expect(spawnSync('git', ['-C', task.worktree, 'add', 'stale-generated']).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Leave generated output stale']).status).toBe(0);
      await r.stopFixture(task.id);
      const result = r.run(['merge', task.id, '--skip-unit-gate', '--skip-type-gate']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(r.ledger().tasks[task.id]!.state).toBe('merged');
      expect(existsSync(join(r.dir, 'stale-generated'))).toBe(false);
      expect(r.git('log', '-1', '--format=%s')).toBe('Regenerate generated outputs (goalctl)');
    } finally { r.cleanup(); }
  });

  test('a check that still fails after regeneration blocks even when main is already stale', async () => {
    const r = repo();
    try {
      const generator = `import { existsSync, writeFileSync } from 'node:fs';\n`
        + `if (!process.argv.includes('--check')) writeFileSync('generated-note', 'regenerated\\n');\n`
        + `if (process.argv.includes('--check') && existsSync('stale-generated')) { console.error('generated output is stale'); process.exit(1); }\n`;
      mkdirSync(join(r.dir, 'scripts'), { recursive: true });
      writeFileSync(join(r.dir, 'scripts/generate.ts'), generator);
      writeFileSync(join(r.dir, 'stale-generated'), 'stale\n');
      r.git('add', 'scripts/generate.ts', 'stale-generated');
      r.git('commit', '-qm', 'Main already has stale output');
      const task = await r.start('G-001');
      r.commit(task);
      await r.stopFixture(task.id);
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('generated artifacts are stale after regeneration; run task gen');
      expect(result.stderr).not.toContain('stale on main');
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.git('log', '-1', '--format=%s', task.branch)).toBe('Regenerate generated outputs (goalctl)');
      expect(readFileSync(join(task.worktree, 'generated-note'), 'utf8')).toBe('regenerated\n');
    } finally { r.cleanup(); }
  });

  test('a generated file claimed by another task does not block the merge', async () => {
    const r = repo();
    try {
      const holder = await r.start('G-001');
      await r.stopFixture(holder.id);
      const generated = 'generated/openapi/main/public.json';
      const ledger = r.ledger();
      ledger.tasks[holder.id]!.paths = ['**', generated];
      r.save(ledger);
      const owner = r.run(['owner', generated]);
      expect(owner.status).toBe(0);
      expect(owner.stdout).toContain(`${generated}: unclaimed`);
      ledger.tasks[holder.id]!.paths = [generated];
      r.save(ledger);
      const task = await r.start('G-002');
      r.commit(task);
      mkdirSync(join(task.worktree, 'generated/openapi/main'), { recursive: true });
      writeFileSync(join(task.worktree, generated), '{}\n');
      expect(spawnSync('git', ['-C', task.worktree, 'add', generated]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Refresh generated output']).status).toBe(0);
      await r.stopFixture(task.id);
      const result = r.run(['merge', task.id, '--skip-unit-gate', '--skip-type-gate']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(r.ledger().tasks[task.id]!.state).toBe('merged');
      expect(readFileSync(join(r.dir, generated), 'utf8')).toBe('{}\n');
    } finally { r.cleanup(); }
  });

  test('files a regeneration commit wrote stay inside the claim check when merge prepares again', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task);
      const compose = 'infra/dev/compose.yaml';
      const shape = 'packages/model/src/generated/shape.ts';
      mkdirSync(join(task.worktree, 'infra/dev'), { recursive: true });
      mkdirSync(join(task.worktree, 'packages/model/src/generated'), { recursive: true });
      writeFileSync(join(task.worktree, compose), 'name: dev\n');
      writeFileSync(join(task.worktree, shape), 'export {};\n');
      expect(spawnSync('git', ['-C', task.worktree, 'add', compose, shape]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', REGENERATION_COMMIT_SUBJECT]).status).toBe(0);
      await r.stopFixture(task.id);
      const scope = r.run(['scope', task.id]);
      expect(scope.status).toBe(0);
      expect(scope.stdout).toContain('scope: ok');
      expect(scope.stdout).not.toContain(compose);
      const result = r.run(['merge', task.id, '--skip-unit-gate', '--skip-type-gate']);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(r.ledger().tasks[task.id]!.state).toBe('merged');
      expect(readFileSync(join(r.dir, compose), 'utf8')).toBe('name: dev\n');
      expect(readFileSync(join(r.dir, shape), 'utf8')).toBe('export {};\n');
    } finally { r.cleanup(); }
  });

  test('a task commit of an unclaimed path stays in the claim check after regeneration rewrites it', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      const compose = 'infra/dev/compose.yaml';
      const shape = 'packages/model/src/generated/shape.ts';
      mkdirSync(join(task.worktree, 'infra/dev'), { recursive: true });
      mkdirSync(join(task.worktree, 'packages/model/src/generated'), { recursive: true });
      writeFileSync(join(task.worktree, compose), 'name: task\n');
      expect(spawnSync('git', ['-C', task.worktree, 'add', compose]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Edit the dev compose file']).status).toBe(0);
      writeFileSync(join(task.worktree, compose), 'name: regen\n');
      writeFileSync(join(task.worktree, shape), 'export {};\n');
      expect(spawnSync('git', ['-C', task.worktree, 'add', compose, shape]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', REGENERATION_COMMIT_SUBJECT]).status).toBe(0);
      await r.stopFixture(task.id);
      const result = r.run(['merge', task.id, '--skip-unit-gate', '--skip-type-gate']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('changed files outside its claim');
      expect(result.stderr).toContain(compose);
      expect(result.stderr).not.toContain(shape);
    } finally { r.cleanup(); }
  });

  test('dispatch from a linked worktree keeps the new checkout on the main checkout', async () => {
    const r = repo();
    try {
      const first = await r.start('G-001');
      await r.stopFixture(first.id);
      const result = spawnSync('bun', [join(import.meta.dir, 'goalctl.ts'), 'dispatch', r.brief('G-002')], {
        cwd: first.worktree, encoding: 'utf8', env: r.env,
      });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const second = r.ledger().tasks['G-002']!;
      expect(second.worktree).toBe(join(r.dir, '.temp/worktrees/g-002'));
      expect(second.worktree.startsWith(first.worktree)).toBe(false);
    } finally { r.cleanup(); }
  });

  test('gate runs the pre-merge checks without fast-forwarding main', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task);
      await r.stopFixture(task.id);
      const ledger = r.ledger();
      ledger.tasks[task.id]!.refusal = 'earlier refusal';
      r.save(ledger);
      const before = r.git('rev-parse', 'main');
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, '');
      const passed = r.run(['gate', task.id], { GOAL_TEST_PLAN: plan });
      expect(passed.stderr).toBe('');
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain(`pre-merge gate passed at`);
      expect(passed.stdout).toContain('not merged');
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('exited');
      expect(r.ledger().tasks[task.id]!.refusal).toBe('earlier refusal');
      expect(existsSync(join(r.dir, '.temp/goal-orchestration/merges.jsonl'))).toBe(false);
      const file = 'operation.test.ts';
      writeFileSync(join(task.worktree, file), `import { test, expect } from 'bun:test';\ntest('operation stays valid', () => expect(true).toBe(false));\n`);
      const claimed = r.ledger();
      claimed.tasks[task.id]!.paths.push(file);
      r.save(claimed);
      expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add a failing case']).status).toBe(0);
      writeFileSync(plan, `  unit: ${file}\n`);
      const failed = r.run(['gate', task.id], { GOAL_TEST_PLAN: plan });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('introduced unit failures');
      expect(failed.stderr).toContain('(fail) operation stays valid');
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('exited');
      expect(r.ledger().tasks[task.id]!.refusal).toBe('earlier refusal');
      expect(existsSync(join(r.dir, '.temp/goal-orchestration/merges.jsonl'))).toBe(false);
    } finally { r.cleanup(); }
  }, 30_000);

  test('gate refuses a running worker before it touches the worktree', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      r.commit(task);
      const pid = task.attempts.at(-1)!.pid;
      expect(r.ledger().tasks[task.id]!.state).toBe('running');
      expect(r.alive(pid)).toBe(true);
      const head = spawnSync('git', ['-C', task.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
      writeFileSync(join(task.worktree, 'uncommitted.ts'), 'export {};\n');
      const failed = r.run(['gate', task.id]);
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain(`${task.id} is still running; stop it first`);
      expect(failed.stderr).not.toContain('uncommitted');
      expect(failed.stdout).not.toContain('Unit gate');
      expect(spawnSync('git', ['-C', task.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()).toBe(head);
      expect(spawnSync('git', ['-C', task.worktree, 'status', '--porcelain'], { encoding: 'utf8' }).stdout).toContain('uncommitted.ts');
      expect(r.ledger().tasks[task.id]!.state).toBe('running');
      expect(r.ledger().tasks[task.id]!.refusal).toBeUndefined();
      expect(r.alive(pid)).toBe(true);
    } finally { r.cleanup(); }
  });

  test('an owner-tier plan file runs through task test and a branch-only failure blocks', async () => {
    const r = repo();
    try {
      const file = 'scripts/qa/owner-probe.test.ts';
      const task = await r.start('G-001');
      const ledger = r.ledger();
      ledger.tasks[task.id]!.paths.push(file);
      r.save(ledger);
      mkdirSync(join(task.worktree, 'scripts/qa'), { recursive: true });
      writeFileSync(join(task.worktree, file), `import { expect, test } from 'bun:test';\n`
        + `test('owner probe fails', () => expect(1).toBe(2));\n`);
      expect(spawnSync('git', ['-C', task.worktree, 'add', file]).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Add failing owner probe']).status).toBe(0);
      await r.stopFixture(task.id);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, `  owner: ${file}\n`);
      const log = join(r.dir, '.temp/unit-log');
      const before = r.git('rev-parse', 'main');
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan, GOAL_TEST_LOG: log });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('introduced unit failures');
      expect(result.stderr).toContain(file);
      expect(r.git('rev-parse', 'main')).toBe(before);
      expect(r.ledger().tasks[task.id]!.state).toBe('conflict');
      const runs = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs.every(run => run.args[0] === 'test' && run.args.includes(file))).toBe(true);
    } finally { r.cleanup(); }
  });

  test('a later merge selects the stream\'s own files and classifies failures against current main', async () => {
    const r = repo();
    try {
      const task = await r.start('G-001');
      const ledger = r.ledger();
      ledger.tasks[task.id]!.paths.push('stream-only.ts');
      r.save(ledger);
      r.commit(task);
      await r.stopFixture(task.id);
      const baseline = r.git('rev-parse', 'main');
      expect(r.run(['merge', task.id, '--skip-unit-gate']).status).toBe(0);
      mkdirSync(join(r.dir, 'infra/jena'), { recursive: true });
      writeFileSync(join(r.dir, 'infra/jena/Dockerfile'), 'FROM scratch\n');
      r.git('add', 'infra/jena/Dockerfile');
      r.git('commit', '-qm', 'Main changes the native image');
      const current = r.git('rev-parse', 'main');
      writeFileSync(join(task.worktree, 'stream-only.ts'), `export const stream = true;\n`);
      expect(spawnSync('git', ['-C', task.worktree, 'add', 'stream-only.ts']).status).toBe(0);
      expect(spawnSync('git', ['-C', task.worktree, 'commit', '-qm', 'Stream-only change']).status).toBe(0);
      const plan = join(r.dir, '.temp/unit-plan');
      writeFileSync(plan, '');
      const result = r.run(['merge', task.id], { GOAL_TEST_PLAN: plan });
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`against main ${current.slice(0, 12)}`);
      expect(result.stdout).not.toContain('classification baseline');
      expect(result.stdout).not.toContain(baseline.slice(0, 12));
      expect(result.stdout).toContain('stream-only.ts');
      expect(result.stdout).toContain('worker-001.ts');
      expect(result.stdout).not.toContain('infra/jena/Dockerfile');
    } finally { r.cleanup(); }
  });
});

describe('goalctl history gate', () => {
  test('refuses new task-named files and task IDs a file did not carry', () => {
    expect(historyIntroductions([
      { path: 'tests/qa/integration/g-1065-discover.test.ts', status: 'A', after: 'test()' },
      { path: 'apps/web/tests/g-1065/run.e2e.ts', status: 'A', after: '' },
      { path: 'services/main/src/modules/feed/read.ts', status: 'M', before: '// G-314 keeps it', after: '// G-314 keeps it\n// see G-1065' },
    ])).toEqual([
      'tests/qa/integration/g-1065-discover.test.ts: named after a task; name it by the capability it covers',
      'apps/web/tests/g-1065/run.e2e.ts: named after a task; name it by the capability it covers',
      'services/main/src/modules/feed/read.ts: adds G-1065; state the reason itself instead of citing the task',
    ]);
  });

  test('allows existing mentions to move, task-named files to be renamed and the Goal program to name tasks', () => {
    expect(historyIntroductions([
      { path: 'services/main/src/a.ts', status: 'M', before: 'x // G-314\ny', after: 'y\nx // G-314' },
      { path: 'tests/qa/integration/contribution-loop.test.ts', status: 'R', from: 'tests/qa/integration/g-704-contribution-loop.test.ts',
        before: "test('G-704 loop')", after: "test('G-704 loop')" },
      { path: 'tests/qa/integration/discovery/g-939-reads.test.ts', status: 'R', from: 'tests/qa/integration/g-939-reads.test.ts' },
      { path: 'docs/goals/production/tasks/G-1066.md', status: 'A', after: 'depends: [G-1065]' },
      { path: 'scripts/goal/goalctl.test.ts', status: 'M', before: '', after: "id: 'G-1065'" },
      { path: 'services/main/src/b.ts', status: 'D', before: 'G-1' },
      { path: 'assets/cover.png', status: 'A', after: 'PNG\0G-1065' },
      { path: 'apps/web/tests/agenda-1065.test.ts', status: 'A', after: 'GG-1065x' },
    ])).toEqual([]);
  });
});

describe('goalctl archive', () => {
  const repo = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'goalctl-archive-test-'));
    const run = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 'goal@example.invalid');
    run('config', 'user.name', 'goalctl test');
    mkdirSync(join(dir, 'docs/goals/g/tasks'), { recursive: true });
    writeFileSync(join(dir, 'docs/goals/g/tasks/G-001.md'), 'brief');
    writeFileSync(join(dir, 'code.ts'), '// cites docs/goals/g/tasks/G-002.md\n');
    run('add', '.');
    run('commit', '-q', '-m', 'start');
    return dir;
  };
  const git = (dir: string, ...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();

  for (const operation of ['fast-forward', 'own-only commit'] as const) {
    test(`${operation} retries a held Git index until its owner releases it`, () => {
      const dir = repo();
      const lock = join(dir, '.git/index.lock');
      try {
        let args: string[];
        if (operation === 'fast-forward') {
          git(dir, 'switch', '-qc', 'worker');
          writeFileSync(join(dir, 'worker.ts'), 'worker');
          git(dir, 'add', 'worker.ts');
          git(dir, 'commit', '-qm', 'Worker');
          git(dir, 'switch', '-q', 'main');
          args = ['merge', '--ff-only', 'worker'];
        } else {
          writeFileSync(join(dir, 'peer.ts'), 'peer');
          git(dir, 'add', 'peer.ts');
          writeFileSync(join(dir, 'code.ts'), 'own edit');
          args = ['commit', '--only', '-qm', 'Own edit', '--', 'code.ts'];
        }
        writeFileSync(lock, 'live owner');
        const waits: number[] = [];
        const result = retryGitIndexLock(() => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }), ms => {
          waits.push(ms);
          expect(readFileSync(lock, 'utf8')).toBe('live owner');
          if (waits.length === 2) rmSync(lock); // The simulated owner releases its own lock.
        });
        expect(result.status).toBe(0);
        expect(waits).toEqual([250, 500]);
        if (operation === 'fast-forward') expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'worker'));
        else {
          expect(git(dir, 'show', '--format=', '--name-only', 'HEAD')).toBe('code.ts');
          expect(git(dir, 'diff', '--cached', '--name-only')).toBe('peer.ts');
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  test('Git retries are bounded, preserve a live lock and do not retry unrelated failures', () => {
    const dir = repo();
    const lock = join(dir, '.git/index.lock');
    try {
      writeFileSync(lock, 'live owner');
      let attempts = 0;
      const waits: number[] = [];
      const result = retryGitIndexLock(() => {
        attempts++;
        return spawnSync('git', ['commit', '--only', '-qm', 'Own edit', '--', 'code.ts'], { cwd: dir, encoding: 'utf8' });
      }, ms => waits.push(ms));
      expect(result.status).not.toBe(0);
      expect(attempts).toBe(5);
      expect(waits).toEqual([250, 500, 1000, 2000]);
      expect(readFileSync(lock, 'utf8')).toBe('live owner');
      const unrelated = { status: 1, stderr: 'index.lock: Permission denied' };
      expect(retryGitIndexLock(() => unrelated, () => { throw new Error('unrelated failure retried'); })).toBe(unrelated);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('adds files to the orphan archive branch without moving HEAD and keeps earlier entries', () => {
    const dir = repo();
    try {
      const head = git(dir, 'rev-parse', 'HEAD');
      archiveFiles(dir, [{ path: 'g-2026-10-04/tasks/G-001.md', content: 'brief' }], 'Archive G-001');
      archiveFiles(dir, [{ path: 'g-2026-10-04/handoffs/G-001.md', content: 'handoff' }], 'Archive its handoff');
      expect(git(dir, 'rev-parse', 'HEAD')).toBe(head);
      expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
      expect(git(dir, 'ls-tree', '-r', '--name-only', 'archive/goals').split('\n'))
        .toEqual(['g-2026-10-04/handoffs/G-001.md', 'g-2026-10-04/tasks/G-001.md']);
      expect(git(dir, 'rev-list', '--count', 'archive/goals')).toBe('2');
      expect(git(dir, 'merge-base', 'main', 'archive/goals')).toBe('');
      expect(git(dir, 'status', '--porcelain')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('commits only the removed briefs and leaves what peers staged', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, 'peer.ts'), 'staged by a peer');
      git(dir, 'add', 'peer.ts');
      removeFromTree(dir, ['docs/goals/g/tasks/G-001.md'], 'Archive the closed brief G-001');
      expect(existsSync(join(dir, 'docs/goals/g'))).toBe(false);
      expect(existsSync(join(dir, 'docs'))).toBe(false);
      expect(git(dir, 'show', '--name-status', '--format=%s', 'HEAD').split('\n'))
        .toEqual(['Archive the closed brief G-001', '', 'D\tdocs/goals/g/tasks/G-001.md']);
      expect(git(dir, 'diff', '--cached', '--name-only')).toBe('peer.ts');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('finds citations of a brief outside the excluded paths', () => {
    const dir = repo();
    try {
      expect(treeMentions(dir, ['docs/goals/g/tasks/G-002.md'], { exclude: ['docs/goals/**'] }))
        .toEqual(['code.ts:1:// cites docs/goals/g/tasks/G-002.md']);
      expect(treeMentions(dir, ['G-001'], { words: true })).toEqual([]);
      expect(treeMentions(dir, ['G-001'], { words: true, exclude: [] })).toEqual([]);
      expect(treeMentions(dir, [])).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('heavy QA lock', () => {
  const sixHours = 6 * 3_600_000;

  function unusedPid(): number {
    for (let pid = 2_000_000; pid < 2_001_000; pid++) {
      try { process.kill(pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid;
      }
    }
    throw new Error('no unused pid');
  }

  function ticketRows(queueDir: string): [number, string | undefined, string | undefined, number][] {
    return readdirSync(queueDir).filter(name => name.endsWith('.json')).map(name => {
      const ticket = JSON.parse(readFileSync(join(queueDir, name), 'utf8')) as
        { pid: number; goal?: string; command?: string; arrivedAt: number };
      return [ticket.pid, ticket.goal, ticket.command, ticket.arrivedAt] as [number, string | undefined, string | undefined, number];
    }).sort((a, b) => a[3] - b[3] || a[0] - b[0]);
  }

  /** Pauses a waiter on each poll so the test can choose who looks at the lock next. */
  function gatedSleep() {
    const pending: Array<() => void> = [];
    let arm = () => {};
    return {
      next(): Promise<void> {
        return new Promise(resolve => { arm = resolve; });
      },
      sleep(): Promise<void> {
        return new Promise(resolve => {
          pending.push(resolve);
          arm();
        });
      },
      wake(): void {
        const resume = pending.shift();
        if (!resume) throw new Error('waiter is not sleeping');
        resume();
      },
    };
  }

  test('shared refresh starts while an isolated browser run owns the heavy lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-beside-browser-'));
    const heavy = join(root, 'heavy');
    const lifecycle = join(root, 'shared-lifecycle');
    try {
      const releaseBrowser = await acquireHeavy(['browser'], { lockDir: heavy, bindExit: false });
      const releaseRefresh = await acquireSharedLifecycle(['task', 'dev:refresh'], { lockDir: lifecycle, bindExit: false,
        sleep: () => Promise.reject(new Error('refresh waited for browser')) });
      expect(heavyQaStatus(heavy)).toContain('browser');
      expect(sharedLifecycleStatus(lifecycle)).toContain('task dev:refresh');
      releaseRefresh();
      expect(existsSync(heavy)).toBe(true);
      releaseBrowser();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('pending shared lifecycle is admitted before queued heavy QA without preempting its holder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-admission-'));
    const heavy = join(root, 'heavy');
    const lifecycle = join(root, 'shared-lifecycle');
    const qaGate = gatedSleep();
    const refreshGate = gatedSleep();
    const alive = () => true;
    try {
      const releaseBrowser = await acquireHeavy(['browser'], { lockDir: heavy, alive, bindExit: false });
      const qaSleeping = qaGate.next();
      const nextBrowser = acquireHeavy(['next-browser'], { lockDir: heavy, alive, bindExit: false, pid: 1001,
        sleep: () => qaGate.sleep() });
      await qaSleeping;
      const releaseRepair = await acquireSharedLifecycle(['repair'], { lockDir: lifecycle, alive, bindExit: false });
      const refreshSleeping = refreshGate.next();
      const refresh = acquireSharedLifecycle(['task', 'dev:refresh'], { lockDir: lifecycle, alive, goal: 'program', bindExit: false, pid: 1002,
        sleep: () => refreshGate.sleep() });
      await refreshSleeping;
      expect(heavyQaStatus(heavy, alive)).toContain('browser');
      expect(sharedLifecycleWaiters(lifecycle, alive)).toEqual([
        'Shared lifecycle waiting: Goal program (pid 1002): task dev:refresh',
      ]);
      releaseBrowser();
      releaseRepair();
      // The lifecycle holder released but its queued refresh has not polled yet.
      let slept = qaGate.next();
      qaGate.wake();
      await slept;
      expect(existsSync(heavy)).toBe(false);
      refreshGate.wake();
      const releaseRefresh = await refresh;
      slept = qaGate.next();
      qaGate.wake();
      await slept;
      expect(existsSync(heavy)).toBe(false);
      releaseRefresh();
      qaGate.wake();
      (await nextBrowser)();
      expect(sharedLifecycleStatus(lifecycle, alive)).toBe('free; 0 waiting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('repair takes no QA slot or heavy lease and does not reap isolated stacks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-without-qa-'));
    const slots = join(root, 'qa-slots');
    const heavy = join(slots, 'heavy');
    const lifecycle = join(root, 'shared-lifecycle');
    try {
      for (const path of [heavy, ...[0, 1, 2].map(slot => join(slots, String(slot)))]) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'pid'), String(process.pid));
        writeFileSync(join(path, 'marker'), 'QA owns this');
      }
      const code = await withRecovery(['repair-stack'], { slotDirectory: slots, heavyLockDirectory: heavy,
        lifecycleLockDirectory: lifecycle, slots: 0, reap: () => { throw new Error('repair reaped QA stacks'); },
        runCommand: async (command, env, onStart) => {
          expect(command).toEqual(['repair-stack']);
          expect(env.GOAL_SHARED_LIFECYCLE).toBe('1');
          expect(inheritedSharedLifecycleOwnership(lifecycle, env)?.pid).toBe(process.pid);
          for (const key of ['GOAL_IN_SLOT', 'GOAL_QA_HEAVY_RUN', 'GOAL_QA_SLOT_DIRECTORY', 'GOAL_QA_WAIT_DIR', 'GOAL_QA_COMMAND']) {
            expect(env[key]).toBeUndefined();
          }
          expect(sharedLifecycleStatus(lifecycle)).toContain('command not started');
          onStart();
          expect(sharedLifecycleStatus(lifecycle)).toContain('command started');
          for (const path of [heavy, ...[0, 1, 2].map(slot => join(slots, String(slot)))]) {
            expect(readFileSync(join(path, 'marker'), 'utf8')).toBe('QA owns this');
          }
          return 7;
        } });
      expect(code).toBe(7);
      expect(existsSync(lifecycle)).toBe(false);
      expect(existsSync(join(slots, 'waiters'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed repair releases the lifecycle lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-failure-'));
    const lockDir = join(root, 'shared-lifecycle');
    try {
      await expect(withRecovery(['repair'], { lifecycleLockDirectory: lockDir,
        runCommand: () => Promise.reject(new Error('repair failed')) })).rejects.toThrow('repair failed');
      expect(sharedLifecycleStatus(lockDir)).toBe('free; 0 waiting');
      const release = await acquireSharedLifecycle(['retry'], { lockDir, bindExit: false });
      release();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the staged child keeps the lifecycle lease after its launcher dies and old cleanup cannot erase another lease', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-transfer-'));
    const lockDir = join(root, 'shared-lifecycle');
    const deadParent = unusedPid();
    try {
      const parentRelease = await acquireSharedLifecycle(['task', 'dev:refresh'], { lockDir,
        pid: deadParent, alive: () => true, bindExit: false });
      const childRelease = transferSharedLifecycleOwnership(lockDir, process.pid, deadParent);
      // An old directory is still held by its transferred, live child, even with a dead launcher.
      utimesSync(lockDir, new Date(0), new Date(0));
      parentRelease();
      expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      expect(sharedLifecycleStatus(lockDir)).toContain(`(pid ${process.pid})`);
      let clock = 0;
      await expect(acquireSharedLifecycle(['repair'], { lockDir, bindExit: false, now: () => clock, deadline: 1,
        sleep: async () => { clock = 2; }, announce: () => {} })).rejects.toThrow('shared lifecycle lock stayed held');
      expect(sharedLifecycleWaiters(lockDir)).toEqual([]);
      childRelease();
      const nextRelease = await acquireSharedLifecycle(['next-repair'], { lockDir, bindExit: false });
      parentRelease();
      childRelease();
      expect(sharedLifecycleStatus(lockDir)).toContain('next-repair');
      nextRelease();
      expect(sharedLifecycleStatus(lockDir)).toBe('free; 0 waiting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('nested lifecycle context rejects stale leases and locks from another checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-inherited-'));
    const lockDir = join(root, 'shared-lifecycle');
    try {
      expect(inheritedSharedLifecycleOwnership(lockDir, {})).toBeUndefined();
      const release = await acquireSharedLifecycle(['repair'], { lockDir, bindExit: false });
      const env = sharedLifecycleEnvironment(lockDir);
      expect(inheritedSharedLifecycleOwnership(lockDir, env)?.pid).toBe(process.pid);
      expect(() => inheritedSharedLifecycleOwnership(join(root, 'different'), env)).toThrow('another lock');
      release();
      const nextRelease = await acquireSharedLifecycle(['another-repair'], { lockDir, bindExit: false });
      expect(() => inheritedSharedLifecycleOwnership(lockDir, env)).toThrow('stale');
      expect(() => transferSharedLifecycleOwnership(lockDir, process.pid, unusedPid())).toThrow('changed');
      nextRelease();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an external repair child owns the lease and accepts the inherited caller context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-child-owner-'));
    const lockDir = join(root, 'shared-lifecycle');
    const seen = join(root, 'owner.json');
    try {
      const code = await withRecovery(['bun', '-e', `
        import { writeFileSync } from 'node:fs';
        import { inheritedSharedLifecycleOwnership } from ${JSON.stringify(join(import.meta.dir, 'goalctl.ts'))};
        const inherited = inheritedSharedLifecycleOwnership(${JSON.stringify(lockDir)});
        if (inherited?.pid !== process.pid) throw new Error('repair child does not own its lease');
        writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ pid: process.pid, caller: process.ppid }));
      `], { lifecycleLockDirectory: lockDir });
      expect(code).toBe(0);
      const owner = JSON.parse(readFileSync(seen, 'utf8')) as { pid: number; caller: number };
      expect(owner.pid).not.toBe(process.pid);
      expect(owner.caller).toBe(process.pid);
      expect(sharedLifecycleStatus(lockDir)).toBe('free; 0 waiting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('refresh precedes round-robin Goals and each Goal keeps its arrival order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-goal-turns-'));
    const lockDir = join(root, 'heavy');
    const alive = () => true;
    let clock = 100;
    try {
      const releaseHolder = await acquireHeavy(['holder'], { lockDir, goal: 'a', alive, bindExit: false, now: () => clock });
      const runs = [
        ['a-next', 'a'], ['a-last', 'a'], ['b-next', 'b'], ['b-last', 'b'], ['c-next', 'c'], ['task dev:refresh', 'a'],
      ].map(([command, goal], index) => {
        const gate = gatedSleep();
        const sleeping = gate.next();
        clock++;
        const done = acquireHeavy(command!.split(' '), {
          lockDir, pid: 1000 + index, goal, alive, bindExit: false, now: () => clock, sleep: () => gate.sleep(),
        });
        return { command, gate, sleeping, done };
      });
      await Promise.all(runs.map(run => run.sleeping));
      releaseHolder();
      const served: string[] = [];
      for (const command of ['task dev:refresh', 'b-next', 'c-next', 'a-next', 'b-last', 'a-last']) {
        const run = runs.find(run => run.command === command)!;
        // Polling a later ticket cannot steal the next Goal's turn.
        if (command === 'b-next') {
          const a = runs[0]!;
          const slept = a.gate.next();
          a.gate.wake();
          await slept;
          expect(existsSync(lockDir)).toBe(false);
        }
        run.gate.wake();
        const release = await run.done;
        served.push(JSON.parse(readFileSync(join(lockDir, 'identity.json'), 'utf8')).command);
        release();
      }
      expect(served).toEqual(['task dev:refresh', 'b-next', 'c-next', 'a-next', 'b-last', 'a-last']);
      expect(ticketRows(join(root, 'heavy-queue'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a second queued refresh coalesces immediately without releasing the holder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-refresh-coalesce-'));
    const lockDir = join(root, 'shared-lifecycle');
    const gate = gatedSleep();
    const options = { lockDir, alive: () => true, bindExit: false, coalesceRefresh: true };
    try {
      const releaseHolder = await acquireSharedLifecycle(['holder'], { ...options, coalesceRefresh: false });
      const sleeping = gate.next();
      const first = acquireSharedLifecycle(['task', 'dev:refresh'], { ...options, pid: 1001, sleep: () => gate.sleep() });
      await sleeping;
      const second = await acquireSharedLifecycle(['task', 'dev:refresh'], { ...options, pid: 1002,
        sleep: () => Promise.reject(new Error('duplicate refresh waited')) });
      expect(second).toBeUndefined();
      expect(ticketRows(join(root, 'shared-lifecycle-queue'))).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(lockDir, 'identity.json'), 'utf8')).command).toBe('holder');
      releaseHolder();
      gate.wake();
      (await first)!();
      expect(ticketRows(join(root, 'shared-lifecycle-queue'))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a started refresh cannot absorb a later refresh', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lifecycle-refresh-started-'));
    const lockDir = join(root, 'shared-lifecycle');
    const gate = gatedSleep();
    const options = { lockDir, alive: () => true, bindExit: false, coalesceRefresh: true };
    try {
      const first = await acquireSharedLifecycle(['task', 'dev:refresh'], { ...options, pid: 1001 });
      const sleeping = gate.next();
      let secondStarted = false;
      const second = acquireSharedLifecycle(['task', 'dev:refresh'], { ...options, pid: 1002, sleep: () => gate.sleep() })
        .then(release => { secondStarted = true; return release; });
      await sleeping;
      expect(secondStarted).toBe(false);
      expect(ticketRows(join(root, 'shared-lifecycle-queue'))).toHaveLength(1);
      first!();
      gate.wake();
      (await second)!();
      expect(secondStarted).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('two heavy waiters are served in arrival order even when the earlier one polls later', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-order-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const earlier = 1_010_101;
    const later = 2_020_202;
    const alive = (pid: number) => pid === earlier || pid === later || pid === process.pid;
    let clock = Date.now();
    const firstAt = clock;
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    writeFileSync(join(lockDir, 'marker'), 'held');
    const first = gatedSleep();
    const second = gatedSleep();
    const served: string[] = [];
    const firstSlept = first.next();
    const firstDone = acquireHeavy(['first'], {
      lockDir, pid: earlier, goal: 'goal-a', now: () => clock, alive, bindExit: false, sleep: () => first.sleep(),
    }).then(release => { served.push('first'); return release; });
    const secondSlept = second.next();
    let secondDone: Promise<() => void> | undefined;
    try {
      expect(await Promise.race([
        firstSlept.then(() => 'slept' as const),
        firstDone.then(() => 'acquired' as const),
      ])).toBe('slept');
      expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
      expect(existsSync(join(lockDir, 'identity.json'))).toBe(false);
      clock = firstAt + 5;
      rmSync(lockDir, { recursive: true, force: true });
      secondDone = acquireHeavy(['second'], {
        lockDir, pid: later, goal: 'goal-b', now: () => clock, alive, bindExit: false, sleep: () => second.sleep(),
      }).then(release => { served.push('second'); return release; });
      expect(await Promise.race([
        secondSlept.then(() => 'slept' as const),
        secondDone.then(() => 'acquired' as const),
      ])).toBe('slept');
      expect(existsSync(lockDir)).toBe(false);
      expect(served).toEqual([]);
      expect(ticketRows(queueDir)).toEqual([
        [earlier, 'goal-a', 'first', firstAt],
        [later, 'goal-b', 'second', firstAt + 5],
      ]);
      first.wake();
      const releaseFirst = await firstDone;
      expect(served).toEqual(['first']);
      expect(ticketRows(queueDir)).toEqual([[later, 'goal-b', 'second', firstAt + 5]]);
      expect(JSON.parse(readFileSync(join(lockDir, 'identity.json'), 'utf8'))).toMatchObject({
        pid: earlier, goal: 'goal-a', command: 'first',
      });
      releaseFirst();
      expect(existsSync(lockDir)).toBe(false);
      expect(existsSync(queueDir)).toBe(true);
      second.wake();
      const releaseSecond = await secondDone;
      expect(served).toEqual(['first', 'second']);
      expect(ticketRows(queueDir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(lockDir, 'identity.json'), 'utf8')).pid).toBe(later);
      releaseSecond();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a dead heavy waiter\'s ticket does not block', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-dead-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const dead = unusedPid();
    mkdirSync(queueDir, { recursive: true });
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(dead));
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockDir, stale, stale);
    writeFileSync(join(queueDir, 'dead.json'), JSON.stringify({ pid: dead, goal: 'gone', command: 'old run', arrivedAt: 1 }));
    writeFileSync(join(queueDir, 'broken.json'), '{');
    writeFileSync(join(queueDir, 'partial.json'), JSON.stringify({ pid: process.pid, command: 'no arrival' }));
    try {
      const release = await acquireHeavy(['next'], {
        lockDir, pid: process.pid, goal: 'scoped-subjects', now: () => 2, bindExit: false,
        sleep: () => Promise.reject(new Error('waiter slept behind a dead ticket')),
      });
      expect(ticketRows(queueDir)).toEqual([]);
      expect(JSON.parse(readFileSync(join(lockDir, 'identity.json'), 'utf8'))).toMatchObject({
        pid: process.pid, goal: 'scoped-subjects', command: 'next',
      });
      expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      release();
      expect(existsSync(lockDir)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a heavy waiter that times out leaves no ticket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-timeout-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'pid'), String(process.pid));
    writeFileSync(join(lockDir, 'marker'), 'held');
    let now = Date.now();
    const opened = now;
    let polls = 0;
    try {
      await expect(acquireHeavy(['wait'], {
        lockDir, pid: process.pid, goal: 'scoped-subjects', now: () => now, bindExit: false,
        sleep: async (ms: number) => {
          expect(ms).toBe(10_000);
          polls += 1;
          if (polls === 1) {
            expect(ticketRows(queueDir)).toHaveLength(1);
            now = opened + sixHours - 1;
            return;
          }
          if (polls === 2) {
            now = opened + sixHours + 1;
            return;
          }
          throw new Error(`polled ${polls} times`);
        },
      })).rejects.toThrow('The heavy QA lock stayed held for six hours');
      expect(polls).toBe(2);
      expect(readdirSync(queueDir).filter(name => name.endsWith('.json'))).toEqual([]);
      expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
      expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      expect(existsSync(join(lockDir, 'identity.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('status shows the heavy holder and the number of waiting tickets', () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-status-'));
    const lockDir = join(root, 'heavy');
    const queueDir = join(root, 'heavy-queue');
    const dead = unusedPid();
    try {
      expect(heavyQaStatus(join(root, 'missing'))).toBe('free; 0 waiting');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'identity.json'), JSON.stringify({
        pid: process.pid, token: 'status-token', goal: 'scoped-subjects', command: 'bun test affected',
        startedAt: '2026-10-04T00:00:00.000Z', commandStartedAt: null,
      }));
      mkdirSync(queueDir);
      writeFileSync(join(queueDir, 'a.json'), JSON.stringify({ pid: process.pid, command: 'a', arrivedAt: 2 }));
      writeFileSync(join(queueDir, 'b.json'), JSON.stringify({ pid: process.pid, command: 'b', arrivedAt: 3 }));
      writeFileSync(join(queueDir, 'dead.json'), JSON.stringify({ pid: dead, command: 'gone', arrivedAt: 1 }));
      expect(heavyQaStatus(lockDir)).toBe(
        `Goal scoped-subjects since 2026-10-04T00:00:00.000Z (pid ${process.pid}): bun test affected (command not started); 2 waiting`);
      expect(heavyQaWaiters(lockDir)).toHaveLength(2);
      expect(heavyQaWaiters(lockDir)[0]).toContain('QA waiting for heavy turn:');
      markHeavyCommandStarted(lockDir);
      expect(heavyQaStatus(lockDir)).toContain('command started');
      expect(existsSync(join(queueDir, 'dead.json'))).toBe(false);
      writeFileSync(join(lockDir, 'identity.json'), JSON.stringify({
        pid: dead, token: 'status-token', goal: 'scoped-subjects', command: 'bun test affected',
        startedAt: '2026-10-04T00:00:00.000Z',
      }));
      expect(heavyQaStatus(lockDir)).toBe('free; 2 waiting');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a heavy waiter names its turn in output and status', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-wait-status-'));
    const lockDir = join(root, 'heavy');
    const alive = () => true;
    const messages: string[] = [];
    let releaseHolder: (() => void) | undefined;
    try {
      releaseHolder = await acquireHeavy(['holder'], { lockDir, alive, bindExit: false });
      await expect(acquireHeavy(['next'], { lockDir, pid: 1001, goal: 'program', alive, bindExit: false,
        announce: message => messages.push(message), sleep: async () => {
          expect(heavyQaWaiters(lockDir, alive)).toEqual(['QA waiting for heavy turn: Goal program (pid 1001): next']);
          throw new Error('stop after observing the wait');
        } })).rejects.toThrow('stop after observing the wait');
      expect(messages[0]).toStartWith('waiting for heavy QA turn');
    } finally { releaseHolder?.(); rmSync(root, { recursive: true, force: true }); }
  });

  test('status identifies memory waits and removes records from dead processes', () => {
    const root = mkdtempSync(join(tmpdir(), 'qa-wait-status-'));
    const slots = join(root, 'qa-slots');
    const waiters = join(slots, 'waiters');
    const dead = unusedPid();
    mkdirSync(waiters, { recursive: true });
    try {
      writeFileSync(join(waiters, 'memory.json'), JSON.stringify({ pid: process.pid, goal: 'program',
        command: 'bun test selected', waitingFor: 'memory', message: 'Waiting; QA memory: host is short', since: '2026-10-07T00:00:00.000Z' }));
      writeFileSync(join(waiters, 'dead.json'), JSON.stringify({ pid: dead, command: 'gone', waitingFor: 'slot', since: 'now' }));
      expect(qaWaitStatusLines(slots)).toEqual([
        `QA waiting for memory: Goal program (pid ${process.pid}): bun test selected; Waiting; QA memory: host is short`,
      ]);
      expect(existsSync(join(waiters, 'dead.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('heavy runs use only the heavy lock when all ordinary slots are occupied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-no-slot-'));
    const slots = join(root, 'qa-slots');
    const heavy = join(slots, 'heavy');
    mkdirSync(slots, { recursive: true });
    for (let index = 0; index < 3; index++) {
      const path = join(slots, String(index));
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
    }
    try {
      const code = await withSlot(['fake heavy run'], true, undefined, {
        slotDirectory: slots,
        reap: () => {},
        runCommand: async (_command, env, onStart) => {
          expect([0, 1, 2].every(index => existsSync(join(slots, String(index))))).toBe(true);
          expect(env.GOAL_QA_HEAVY_RUN).toBe('1');
          expect(heavyQaStatus(heavy)).toContain('command not started');
          onStart();
          expect(heavyQaStatus(heavy)).toContain('command started');
          return 0;
        },
      });
      expect(code).toBe(0);
      expect([0, 1, 2].every(index => existsSync(join(slots, String(index))))).toBe(true);
      expect(existsSync(heavy)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the real QA CLI reaches stack startup with all ordinary slots held during a heavy run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heavy-qa-cli-slots-'));
    const slots = join(root, 'qa-slots');
    const marker = join(root, 'stack-startup-reached');
    const holders: ChildProcess[] = [];
    mkdirSync(slots, { recursive: true });
    try {
      for (let index = 0; index < 3; index++) {
        const holder = spawn('bun', ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        holders.push(holder);
        await new Promise<void>((resolve, reject) => {
          holder.once('spawn', () => resolve());
          holder.once('error', reject);
        });
        const path = join(slots, String(index));
        mkdirSync(path);
        writeFileSync(join(path, 'pid'), String(holder.pid));
      }
      const script = join(root, 'qa-cli-heavy.test.ts');
      const cli = join(import.meta.dir, '../qa/cli.ts');
      const startup = join(import.meta.dir, '../qa/stack-startup.ts');
      writeFileSync(script, `
        import { expect, mock, test } from 'bun:test';
        import { writeFileSync } from 'node:fs';
        const marker = process.env.QA_CLI_STARTUP_MARKER!;
        // Keep the module's other exports so a new import in cli.ts does not break this stub.
        const actual = await import(${JSON.stringify(startup)});
        mock.module(${JSON.stringify(startup)}, () => ({
          ...actual,
          runQaStartupChildAsync: async () => {
            writeFileSync(marker, 'reached after QA slot admission');
            return { ok: false, timedOut: false, elapsedMs: 0, activeElapsedMs: 0, output: 'startup stubbed' };
          },
        }));
        test('heavy QA CLI skips both ordinary slot acquisitions', async () => {
          const argv = process.argv;
          process.argv = ['bun', ${JSON.stringify(cli)}, '--tier', 'integration', '--file',
            'tests/qa/integration/fresh-install.test.ts', '--keep'];
          try {
            await import(${JSON.stringify(cli)});
            expect(await Bun.file(marker).exists()).toBe(true);
          } finally {
            process.argv = argv;
            process.exitCode = 0;
          }
        });
      `);
      const result = spawnSync('bun', ['test', script], { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GOAL_QA_HEAVY_RUN: '1', GOAL_QA_SLOTS: '3',
          GOAL_QA_SLOT_DIRECTORY: slots, QA_CLI_STARTUP_MARKER: marker,
          REZICS_QA_HOST_MEMORY_GIB: '0.001', REZICS_QA_HOST_RESERVE_GIB: '0' } });
      if (result.status !== 0) throw new Error(`nested QA CLI test exited ${result.status}:\n${result.stdout}\n${result.stderr}`);
      expect(result.stdout + result.stderr).toContain('1 pass');
      expect(readFileSync(marker, 'utf8')).toBe('reached after QA slot admission');
      expect([0, 1, 2].every(index => existsSync(join(slots, String(index))))).toBe(true);
    } finally {
      for (const holder of holders) holder.kill('SIGTERM');
      rmSync(root, { recursive: true, force: true });
    }
  }, 35_000);

  for (const args of [
    ['scripts/qa/cli.ts', '--tier', 'model', '--file', 'model/tests/native-equivalence.test.ts'],
    ['scripts/qa/test.ts', '--tier', 'model', '--file', 'model/tests/native-equivalence.test.ts'],
    ['scripts/qa/test.ts', 'tests/qa/integration/access-download-api.test.ts'],
    ['scripts/qa/test.ts', 'scripts/goal/goalctl.test.ts'],
    ['scripts/qa/test.ts', '--tier', 'unit', '--file', 'tests/qa/unit/qa-harness.test.ts'],
  ]) {
    test(`light harness dispatch defers its ordinary slot: ${args.join(' ')}`, async () => {
      const root = mkdtempSync(join(process.cwd(), '.temp', 'deferred-harness-slot-'));
      const slots = join(root, 'slots');
      mkdirSync(slots);
      mkdirSync(join(slots, '0'));
      writeFileSync(join(slots, '0', 'pid'), String(process.pid));
      try {
        expect(await withSlot(['bun', ...args], false, undefined, {
          slotDirectory: slots, slots: 1, timeoutMs: 0,
          reap: () => {}, sleep: async () => { throw new Error('Dispatcher waited for a slot'); },
          runCommand: async (_command, env, onStart) => {
            expect(env.GOAL_IN_SLOT).toBe('0');
            expect(env.GOAL_QA_SLOT_DIRECTORY).toBe(slots);
            expect(env.GOAL_QA_SLOTS).toBe('1');
            expect(readFileSync(join(slots, '0', 'pid'), 'utf8')).toBe(String(process.pid));
            onStart();
            return 0;
          },
        })).toBe(0);
        expect(existsSync(join(slots, '0'))).toBe(true);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  for (const args of [
    ['scripts/qa/test.ts', 'tests/qa/unit/qa-harness.test.ts'],
    ['scripts/qa/test.ts', 'apps/web/features/manage/members.stories.tsx'],
    ['scripts/qa/test.ts', '--affected', '--list'],
  ]) {
    test(`light non-harness dispatch retains its ordinary slot: ${args.join(' ')}`, async () => {
      const root = mkdtempSync(join(process.cwd(), '.temp', 'non-harness-slot-'));
      const slots = join(root, 'slots');
      try {
        expect(await withSlot(['bun', ...args], false, undefined, {
          slotDirectory: slots, slots: 1, reap: () => {},
          runCommand: async (_command, env, onStart) => {
            expect(env.GOAL_IN_SLOT).toBe('1');
            expect(readFileSync(join(slots, '0', 'pid'), 'utf8')).toBe(String(process.pid));
            onStart();
            return 0;
          },
        })).toBe(0);
        expect(existsSync(join(slots, '0'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test('a slot waiter reports its reason and appears in status until a slot opens', async () => {
    const root = mkdtempSync(join(tmpdir(), 'slot-wait-status-'));
    const slots = join(root, 'qa-slots');
    mkdirSync(slots, { recursive: true });
    for (let index = 0; index < 3; index++) {
      const path = join(slots, String(index));
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
    }
    const messages: string[] = [];
    try {
      const code = await withSlot(['fake light run'], false, undefined, {
        slotDirectory: slots, slots: 3, pollMs: 1,
        announce: message => messages.push(message),
        sleep: async () => {
          expect(qaWaitStatusLines(slots, () => true)[0]).toContain(`QA waiting for slot: Goal `);
          expect(qaWaitStatusLines(slots, () => true)[0]).toContain(`(pid ${process.pid}): fake light run; 3/3 ordinary slots busy`);
          rmSync(join(slots, '1'), { recursive: true, force: true });
        },
        reap: () => {},
        runCommand: async (_command, _env, onStart) => { onStart(); return 0; },
      });
      expect(code).toBe(0);
      expect(messages).toEqual(['waiting for QA slot; 3/3 ordinary slots busy']);
      expect(qaWaitStatusLines(slots, () => true)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a heavy waiter removes its ticket on exit and on signal', async () => {
    const goalctl = join(import.meta.dir, 'goalctl.ts');
    const repo = join(import.meta.dir, '../..');
    for (const mode of ['exit', 'signal'] as const) {
      const root = mkdtempSync(join(tmpdir(), 'heavy-exit-'));
      const lockDir = join(root, 'heavy');
      const queueDir = join(root, 'heavy-queue');
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'pid'), String(process.pid));
      writeFileSync(join(lockDir, 'marker'), 'held');
      const watch = mode === 'exit'
        ? `let stopping = false;
setInterval(() => {
  if (stopping) return;
  try {
    if (readdirSync(${JSON.stringify(queueDir)}).some(name => name.endsWith('.json'))) {
      stopping = true;
      writeFileSync(join(${JSON.stringify(queueDir)}, 'seen'), '1');
      setTimeout(() => process.exit(0), 30);
    }
  } catch { /* the queue directory is created with the ticket */ }
}, 15);`
        : '';
      writeFileSync(join(root, 'waiter.ts'), `import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireHeavy } from ${JSON.stringify(goalctl)};
${watch}
await acquireHeavy(['blocked'], { lockDir: ${JSON.stringify(lockDir)}, pollMs: 30_000, deadline: Date.now() + 60_000 });
`);
      const child = spawn('bun', [join(root, 'waiter.ts')], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = (chunk: unknown) => { output += String(chunk); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      let settled = false;
      const exited = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', code => { settled = true; resolve(code); });
      });
      try {
        await waitForWaiter(child, () => mode === 'exit'
          ? existsSync(join(queueDir, 'seen'))
          : existsSync(queueDir) && readdirSync(queueDir).some(name => name.endsWith('.json')), () => output);
        if (mode === 'signal') child.kill('SIGTERM');
        expect(await exited).toBe(mode === 'signal' ? 143 : 0);
        expect(readdirSync(queueDir).filter(name => name.endsWith('.json'))).toEqual([]);
        expect(readFileSync(join(lockDir, 'marker'), 'utf8')).toBe('held');
        expect(readFileSync(join(lockDir, 'pid'), 'utf8')).toBe(String(process.pid));
      } finally {
        if (!settled) child.kill('SIGKILL');
        await exited;
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

function waitForWaiter(child: ChildProcess, ready: () => boolean, output: () => string): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (ready()) return resolve();
      if (child.exitCode !== null) return reject(new Error(`waiter exited ${child.exitCode} before queuing\n${output()}`));
      if (Date.now() - started > 12_000) return reject(new Error(`waiter did not queue\n${output()}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}


describe('Goal coordinator enrollment CLI', () => {
  const enrollment = ['program', '--session', '01a114cb-4d63-7f23-bf70-1610b4db2b2b', '--effort', 'high', '--cwd', '/manager'];
  const ownerFlag = ['--previous-owner-pid', String(process.pid)];
  const socket = process.env.GOAL_TEST_TMUX_SOCKET ?? `/tmp/tmux-${process.getuid?.()}/default`;
  let independentServer: ReturnType<typeof tmuxServer> | undefined;
  try {
    const server = tmuxServer(socket);
    if (server.cgroup !== processIdentity(process.pid)!.cgroup) independentServer = server;
  } catch { /* Enrollment needs the same independent server as the real coordinator. */ }

  test.skipIf(!independentServer)('enrolls two Goals with the engine account homes and preserves the first handover', () => {
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/coordinator-enrollment-'));
    const homes = { codex: join(directory, 'codex'), 'codex-1': join(directory, 'codex-1') };
    const env = { ...process.env, CODEX_HOME: '/inherited-worker-account', GOAL_MAIL_STATE_DIR: directory,
      GOAL_CODEX_HOME: homes.codex, GOAL_CODEX_1_HOME: homes['codex-1'] };
    const invoke = (args: string[]) => spawnSync(process.execPath, [join(import.meta.dir, 'goalctl.ts'), 'coordinator', ...args],
      { cwd: join(import.meta.dir, '../..'), env, encoding: 'utf8' });
    const sessions = ['01a114cb-4d63-7f23-bf70-1610b4db2b2b', '01a114cb-4d63-7f23-bf70-1610b4db2b2c'];
    try {
      writeFileSync(join(directory, 'ledger.json'), JSON.stringify({ tasks: {}, goals: {
        program: { manager: 'program-manager', startedAt: '2026-01-01T00:00:00Z' },
        kernel: { manager: 'kernel-manager', startedAt: '2026-01-01T00:00:00Z' },
      } }));
      const enrolled: LaunchDescriptor[] = [];
      for (const [index, engine] of (['codex', 'codex-1'] as const).entries()) {
        const session = sessions[index]!;
        const goal = index === 0 ? 'program' : 'kernel';
        const home = homes[engine];
        mkdirSync(join(home, 'sessions'), { recursive: true });
        writeFileSync(join(home, 'sessions', `rollout-test-${session}.jsonl`), `${JSON.stringify({ type: 'session_meta',
          payload: { id: session, cwd: directory } })}\n`);
        const result = invoke(['enroll', goal, '--session', session, '--engine', engine, '--effort', 'high',
          '--cwd', directory, ...ownerFlag, '--tmux-socket', socket]);
        expect(result.status, result.stderr).toBe(0);
        const descriptor = JSON.parse(result.stdout) as LaunchDescriptor;
        expect(descriptor).toMatchObject({ goal, session, engine, home, env: { CODEX_HOME: home, GOAL_ID: goal,
          GOAL_MANAGER: `${goal}-manager` }, previousOwner: { pid: process.pid } });
        expect(descriptor.args.slice(0, 3)).toEqual(['exec', 'resume', session]);
        // Verification uses the real independent server, without starting any manager turn.
        expect(() => new TmuxLauncher(directory).verify(descriptor)).not.toThrow();
        enrolled.push(descriptor);
      }
      const result = invoke(['status']);
      expect(result.status, result.stderr).toBe(0);
      const status = JSON.parse(result.stdout) as { managers: (LaunchDescriptor & { ownership: string })[]; attempts: unknown[]; wakes: unknown[] };
      expect(status.managers).toHaveLength(2);
      for (const descriptor of enrolled) {
        expect(status.managers.find(manager => manager.goal === descriptor.goal))
          .toEqual({ ...descriptor, ownership: `waiting for previous owner ${process.pid}` });
      }
      expect(status.attempts).toEqual([]);
      expect(status.wakes).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('a launched worker cannot inherit its manager native session ownership', () => {
    const parent = { ...process.env, CODEX_SESSION_ID: 'manager-session', CODEX_THREAD_ID: 'manager-session',
      CODEX_HOME: '/worker-account', GOAL_MANAGER: 'manager', GOAL_ID: 'program' };
    const child = spawnSync(process.execPath, ['-e', `console.log(JSON.stringify({
      session: process.env.CODEX_SESSION_ID ?? null, thread: process.env.CODEX_THREAD_ID ?? null,
      home: process.env.CODEX_HOME, manager: process.env.GOAL_MANAGER, goal: process.env.GOAL_ID }))`],
      { env: workerSessionEnvironment(parent), encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ session: null, thread: null, home: '/worker-account', manager: 'manager', goal: 'program' });
    expect(parent.CODEX_SESSION_ID).toBe('manager-session');
    expect(parent.CODEX_THREAD_ID).toBe('manager-session');
  });

  test('records the named live owner identity and accepts every supported engine', () => {
    for (const engine of ['codex', 'codex-1', 'luna']) {
      const options = coordinatorEnrollmentOptions([...enrollment, ...ownerFlag, '--engine', engine, '--tmux-socket', '/socket']);
      expect(options).toMatchObject({ goal: 'program', session: enrollment[2], engine, effort: 'high', cwd: '/manager',
        socket: '/socket', previousOwner: { pid: process.pid } });
      expect(options.previousOwner.start).toMatch(/^\d+$/);
      expect(options.previousOwner.boot).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      expect(options.previousOwner.cgroup).toBe(readFileSync(`/proc/${process.pid}/cgroup`, 'utf8').trim());
    }
    expect(coordinatorEnrollmentOptions([...enrollment, ...ownerFlag]).engine).toBe('codex');
  });

  test('requires an explicit positive integer PID and refuses a vanished previous owner', () => {
    expect(() => coordinatorEnrollmentOptions(enrollment)).toThrow('--previous-owner-pid <pid>');
    for (const pid of ['0', '-1', '1.5', 'NaN', 'Infinity', '+1', ' 1', '1e3', '9007199254740992']) {
      expect(() => coordinatorEnrollmentOptions([...enrollment, '--previous-owner-pid', pid])).toThrow('positive integer PID');
    }
    const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
    expect(exited.status).toBe(0);
    const pid = exited.pid;
    expect(() => coordinatorEnrollmentOptions([...enrollment, '--previous-owner-pid', String(pid)]))
      .toThrow(`Cannot establish the live previous owner ${pid}`);
  });

  test('rejects duplicate, unknown and valueless options and invalid launch selections', () => {
    const valid = [...enrollment, ...ownerFlag];
    for (const extra of [['--previous-owner-pid', String(process.pid)], ['--unknown', 'value'], ['--tmux-socket'],
      ['--tmux-socket', '--engine', 'codex']]) {
      expect(() => coordinatorEnrollmentOptions([...valid, ...extra])).toThrow('Invalid option');
    }
    expect(() => coordinatorEnrollmentOptions([...valid, '--engine', 'claude'])).toThrow('--model <id>');
    expect(coordinatorEnrollmentOptions([...valid, '--engine', 'claude', '--model', 'claude-opus-5-5']))
      .toMatchObject({ engine: 'claude', model: 'claude-opus-5-5' });
    expect(() => coordinatorEnrollmentOptions([...valid, '--engine', 'grok'])).toThrow('Codex and Claude managers only');
    expect(() => coordinatorEnrollmentOptions([...valid, '--model', 'gpt-6.1-sol'])).toThrow('--model is only for --engine claude');
    expect(() => coordinatorEnrollmentOptions([...enrollment.slice(0, 4), 'invalid', ...enrollment.slice(5), ...ownerFlag]))
      .toThrow('Enrollment requires');
  });
});

describe('Goal mail CLI', () => {
  test('lost sender response and acknowledgement retries preserve IDs and each Goal receipt', () => {
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/goal-mail-command-'));
    const payload = join(directory, 'request.md');
    const options = { stateDir: directory, goals: ['program', 'kernel'] };
    writeFileSync(payload, 'Please review this request; it conveys no permission.');
    try {
      const first = JSON.parse(mailCommand(['send', 'program', '--file', payload, '--key', 'retry-send'], options)[0]!);
      const repeated = JSON.parse(mailCommand(['send', 'program', '--file', payload, '--key', 'retry-send'], options)[0]!);
      expect(repeated.id).toBe(first.id);
      const inbox = () => mailCommand(['inbox'], {...options, callerGoal:'program'}).map(line => JSON.parse(line));
      expect(inbox()).toHaveLength(1);
      expect(inbox()[0].acknowledged).toBe(false);
      expect(mailCommand(['inbox', 'kernel'], options)).toEqual([]);
      const acknowledged = JSON.parse(mailCommand(['ack',first.id], {...options,callerGoal:'program'})[0]!);
      const retry = JSON.parse(mailCommand(['ack',first.id,'--goal','program'], options)[0]!);
      expect(retry.acknowledgedAt).toBe(acknowledged.acknowledgedAt);
      expect(inbox()[0].acknowledged).toBe(true);
      expect(() => mailCommand(['ack',first.id,'--goal','kernel'],options)).toThrow('not delivered');
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });

  test('unknown Goals and malformed CLI options cannot send or implicitly acknowledge', () => {
    const directory = mkdtempSync(join(import.meta.dir, '../../.temp/goal-mail-refusal-'));
    const payload = join(directory,'request.md');
    writeFileSync(payload,'Request');
    const options = {stateDir:directory,goals:['program']};
    try {
      expect(() => mailCommand(['send','missing','--file',payload,'--key','a'],options)).toThrow('Unknown');
      expect(() => mailCommand(['send','program','--file',payload],options)).toThrow('needs');
      expect(() => mailCommand(['send','program','--file',payload,'--key','a','--key','b'],options)).toThrow('Invalid option');
      expect(() => mailCommand(['inbox','program','--ack','1'],options)).toThrow('one Goal');
      expect(() => mailCommand(['inbox'],options)).toThrow('GOAL_ID');
      expect(() => mailCommand(['ack','regression:program:1'],{...options,callerGoal:'program'})).toThrow('inbox --ack');
      expect(existsSync(join(directory,'mail.sqlite'))).toBe(false);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });

  test('worker launch adapters retain native resume, model, effort and account tier arguments', () => {
    const prior = process.env.GOAL_CODEX_SERVICE_TIER;
    process.env.GOAL_CODEX_SERVICE_TIER = 'default';
    try {
      for (const engine of ['codex','codex-1','luna'] as const) {
        const [program,args] = launchCommand({id:'program',engine,effort:'high',session:'native-session',prompt:'mail prompt',
          resume:true,worktree:'/manager',lastMessage:'/manager/last.md'});
        expect(program).toBe('codex');
        expect(args.slice(0,3)).toEqual(['exec','resume','native-session']);
        expect(args).toContain(engine === 'luna' ? 'gpt-6-luna' : 'gpt-6.1-sol');
        expect(args).toContain('model_reasoning_effort=high');
        expect(args).toContain('service_tier="default"');
        expect(args.slice(-4)).toEqual(['-o','/manager/last.md','--','mail prompt']);
      }
    } finally { if (prior === undefined) delete process.env.GOAL_CODEX_SERVICE_TIER; else process.env.GOAL_CODEX_SERVICE_TIER = prior; }
  });
});

describe('registered Goal mail lifecycle', () => {
  test('a closed registered Goal keeps its durable address, inbox and receipt across CLI processes', () => {
    const directory = mkdtempSync(join(import.meta.dir,'../../.temp/goal-closed-mail-'));
    const payload = join(directory,'request.md');
    writeFileSync(payload,'A durable request for a registered Goal.');
    writeFileSync(join(directory,'ledger.json'),JSON.stringify({tasks:{},goals:{program:{manager:'throwaway',
      startedAt:'2026-01-01T00:00:00Z',closedAt:'2026-02-01T00:00:00Z'}}}));
    const invoke = (args: string[]) => {
      const result = spawnSync(process.execPath,[join(import.meta.dir,'goalctl.ts'),'mail',...args],{
        cwd:join(import.meta.dir,'../..'),encoding:'utf8',
        env:{...process.env,GOAL_MAIL_STATE_DIR:directory,GOAL_ID:'program'}});
      expect(result.status).toBe(0);
      return result.stdout.trim().split('\n').map(line=>JSON.parse(line));
    };
    try {
      const sent = invoke(['send','program','--file',payload,'--key','closed-goal-request'])[0];
      expect(invoke(['inbox'])[0]).toMatchObject({id:sent.id,acknowledged:false});
      const ack = invoke(['ack',sent.id])[0];
      expect(invoke(['ack',sent.id])[0].acknowledgedAt).toBe(ack.acknowledgedAt);
      expect(invoke(['inbox'])[0].acknowledged).toBe(true);
    } finally { rmSync(directory,{recursive:true,force:true}); }
  });
});

describe('pre-merge type check', () => {
  const error = (file: string, line: number, message: string, code = 2769) => `${file}(${line},5): error TS${code}: ${message}`;

  test('maps changed sources and configs to the workspaces whose type check covers them', () => {
    expect(typecheckWorkspaces(['services/main/tests/list.test.ts', 'services/main/src/app.ts', 'apps/web/src/a.tsx']))
      .toEqual(['main', 'web']);
    expect(typecheckWorkspaces(['packages/model/package.json', 'scripts/observability/probe.ts', 'apphost/apphost.mts']))
      .toEqual(['model', 'observability-scripts', 'apphost']);
    expect(typecheckWorkspaces(['packages/observability/src/a.ts'])).toEqual(['observability']);
    expect(typecheckWorkspaces(['docs/goals/README.md', 'services/main/README.md', 'services/main/migrations/001.sql']))
      .toEqual([]);
    expect(typecheckWorkspaces(['scripts/goal/goalctl.ts', 'scripts/goal/tsconfig.json'])).toEqual(['goal']);
  });

  test('every mapped workspace is a Task type check of exactly one command', () => {
    const { tasks } = Bun.YAML.parse(readFileSync(join(import.meta.dir, '../../Taskfile.yml'), 'utf8')) as
      { tasks: Record<string, { cmds?: unknown[] } | undefined> };
    for (const [workspace] of TYPECHECK_WORKSPACES) {
      const task = tasks[`${workspace}:typecheck`];
      expect(task, `${workspace}:typecheck is not a Task task`).toBeDefined();
      // Task stops at the first failing command, so a second project would hide the errors of the next.
      expect(task!.cmds?.length, `${workspace}:typecheck must check one TypeScript project`).toBe(1);
      expect(typeof task!.cmds![0]).toBe('string');
    }
  });

  test('keys diagnostics without positions and keeps repeats and continuation lines', () => {
    const output = [error('tests/a.test.ts', 10, 'No overload matches this call.'), '  Argument of type X is not assignable.',
      error('tests/a.test.ts', 40, 'No overload matches this call.'), 'Found 2 errors.'].join('\n');
    const diagnostics = typecheckDiagnostics(output);
    expect(diagnostics).toEqual([
      'tests/a.test.ts: error TS2769: No overload matches this call.',
      'tests/a.test.ts: error TS2769: No overload matches this call. Argument of type X is not assignable.']);
    expect(typecheckDiagnostics(error('tests/a.test.ts', 99, 'No overload matches this call.')))
      .toEqual(['tests/a.test.ts: error TS2769: No overload matches this call.']);
    expect(introducedTypecheckDiagnostics(['a', 'a', 'b'], ['a'])).toEqual(['a', 'b']);
    expect(introducedTypecheckDiagnostics(['a'], ['a', 'a'])).toEqual([]);
  });

  const stub = (runs: Record<string, Partial<Record<'branch' | 'main', TypecheckRun>>>) => {
    const calls: string[] = [];
    const run = async (workspace: string, side: 'branch' | 'main'): Promise<TypecheckRun> => {
      calls.push(`${workspace}:${side}`);
      const result = runs[workspace]?.[side];
      if (!result) throw new Error(`unexpected ${workspace}:${side}`);
      return result;
    };
    return { run, calls };
  };
  const pass: TypecheckRun = { done: true, status: 0, output: '' };
  const fail = (...lines: string[]): TypecheckRun => ({ done: true, status: 2, output: lines.join('\n') });

  test('a diagnostic only on the branch blocks the merge', async () => {
    const { run, calls } = stub({ main: { branch: fail(error('tests/a.test.ts', 3, 'bad call')), main: pass }, web: { branch: pass } });
    const refusal = await typecheckGate(['main', 'web'], run, 1000);
    expect(refusal).toContain('introduced type errors');
    expect(refusal).toContain('main: tests/a.test.ts: error TS2769: bad call');
    expect(calls.sort()).toEqual(['main:branch', 'main:main', 'web:branch']);
  });

  test('a diagnostic already on main is reported and does not block', async () => {
    const old = error('src/old.ts', 7, 'old problem');
    const { run } = stub({ main: { branch: fail(error('src/old.ts', 9, 'old problem')), main: fail(old) } });
    expect(await typecheckGate(['main'], run, 1000)).toBeUndefined();
  });

  test('only the diagnostics beyond main block, and a clean branch never type-checks main', async () => {
    const { run, calls } = stub({
      main: { branch: fail(error('src/old.ts', 9, 'old problem'), error('src/new.ts', 1, 'new problem')), main: fail(error('src/old.ts', 7, 'old problem')) },
      model: { branch: pass },
    });
    const refusal = await typecheckGate(['main', 'model'], run, 1000);
    expect(refusal).toContain('src/new.ts: error TS2769: new problem');
    expect(refusal).not.toContain('old problem');
    expect(calls).not.toContain('model:main');
  });

  test('an unfinished run or a failure without diagnostics is inconclusive', async () => {
    expect(await typecheckGate(['main'], stub({ main: { branch: { done: false, status: null, output: '' } } }).run, 1000))
      .toContain('type check inconclusive');
    expect(await typecheckGate(['main'], stub({ main: { branch: fail('tsc: command not found') } }).run, 1000))
      .toContain('failed without diagnostics');
    expect(await typecheckGate(['main'], stub({ main: { branch: fail(error('a.ts', 1, 'x')), main: { done: false, status: null, output: '' } } }).run, 1000))
      .toContain('inconclusive');
  });

  test('a location-free diagnostic only on the branch blocks even when main has other diagnostics', async () => {
    const missing = "error TS6053: File 'tests/gone.ts' not found.";
    expect(typecheckDiagnostics(`${missing}\n${error('src/old.ts', 7, 'old problem')}`))
      .toEqual([missing, 'src/old.ts: error TS2769: old problem']);
    const { run } = stub({ main: { branch: fail(missing, error('src/old.ts', 9, 'old problem')), main: fail(error('src/old.ts', 7, 'old problem')) } });
    const refusal = await typecheckGate(['main'], run, 1000);
    expect(refusal).toContain('introduced type errors');
    expect(refusal).toContain(`main: ${missing}`);
    const inherited = stub({ main: { branch: fail(missing), main: fail(missing, error('src/old.ts', 7, 'old problem')) } });
    expect(await typecheckGate(['main'], inherited.run, 1000)).toBeUndefined();
  });

  test('an error line the parser cannot classify is inconclusive on either side', async () => {
    const pretty = "src/a.ts:3:5 - error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(unclassifiedTypecheckLines(`${pretty}\n${error('a.ts', 1, 'x')}\n  continued error TS1`)).toEqual([pretty]);
    const branch = await typecheckGate(['main'], stub({ main: { branch: fail(pretty, error('src/old.ts', 9, 'old problem')) } }).run, 1000);
    expect(branch).toContain('type check inconclusive');
    expect(branch).toContain('unrecognised');
    const main = await typecheckGate(['main'], stub({ main: { branch: fail(error('a.ts', 1, 'x')), main: fail(pretty, error('a.ts', 1, 'x')) } }).run, 1000);
    expect(main).toContain('type check on main is inconclusive');
  });

  test('every main-side comparison shares one deadline, as every branch run does', async () => {
    let clock = 0;
    const deadlines: string[] = [];
    const run = async (workspace: string, side: 'branch' | 'main', deadline: number): Promise<TypecheckRun> => {
      deadlines.push(`${workspace}:${side}:${deadline}`);
      clock += 100;
      return side === 'branch' ? fail(error(`${workspace}.ts`, 1, 'x')) : fail(error(`${workspace}.ts`, 1, 'x'));
    };
    expect(await typecheckGate(['main', 'web', 'model'], run, 500, () => clock)).toBeUndefined();
    // Branch runs start together at 0; the first main run starts at 300 and the next two inherit its deadline.
    expect(deadlines).toEqual(['main:branch:500', 'web:branch:500', 'model:branch:500',
      'main:main:800', 'web:main:800', 'model:main:800']);
  });

  test('no touched workspace runs nothing', async () => {
    expect(await typecheckGate([], stub({}).run, 1000)).toBeUndefined();
  });
});

describe('main fast-forward', () => {
  const gates = (files: string[] = [], over: Partial<FastForwardGates> = {}): FastForwardGates =>
    ({ gatedFiles: new Set(files), regated: false, typechecked: [], retyped: false, ...over });

  const prepared = (before: string, after: string): PreparedMerge =>
    ({ before, baseline: before, after, worktree: '/w', branch: 'goal/g', sharers: ['G-1'], committed: ['a.ts'] });

  /** A linear history of commit names; a task commit lists its parent. */
  const history = (parents: Record<string, string | undefined>, touched: Record<string, string[]>, heads: string[], tail: Record<string, PreparedMerge>) => {
    const ancestors = (commit: string): string[] => commit ? [commit, ...ancestors(parents[commit] ?? '')] : [];
    const log: string[] = [];
    let head = heads.shift()!;
    let forwarded: string | undefined;
    const ff = [...heads];
    const refreshes = { ...tail };
    const sync: MainSync = {
      head: () => head,
      isAncestor: (ancestor, descendant) => ancestors(descendant).includes(ancestor),
      mergeBase: (a, b) => ancestors(a).find(commit => ancestors(b).includes(commit))!,
      touched: (from, to) => ancestors(to).slice(0, ancestors(to).indexOf(from)).flatMap(commit => touched[commit] ?? []),
      changed: (from, to) => ancestors(to).slice(0, ancestors(to).indexOf(from)).flatMap(commit => touched[commit] ?? []),
      refresh: () => {
        log.push('rebase');
        const next = refreshes[head];
        if (!next) throw new Error('does not rebase onto main; conflicts:\n  a.ts');
        return next;
      },
      fastForward: after => {
        log.push(`ff ${after}`);
        if (!ancestors(after).includes(head)) return { status: 128, stderr: 'fatal: Diverging branches can\'t be fast-forwarded' };
        forwarded = after;
        return { status: 0, stderr: '' };
      },
    };
    return { sync, log, forwarded: () => forwarded, advance: () => { head = ff.shift() ?? head; } };
  };

  test('a main that already sits under the branch fast-forwards without a rebase', () => {
    const h = history({ t1: 'm1', m1: 'm0' }, {}, ['m1'], {});
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(), () => {})).toEqual({ kind: 'merged', prepared: prepared('m1', 't1') });
    expect(h.log).toEqual(['ff t1']);
  });

  test('a main that moved after the gated rebase is rebased once and fast-forwarded', () => {
    // m2 landed after the task was rebased onto m1; the gate selected b.ts and m2 touched c.ts.
    const rebased = prepared('m2', 't2');
    const h = history({ t1: 'm1', t2: 'm2', m2: 'm1', m1: 'm0' }, { m2: ['c.ts'], t1: ['a.ts'] }, ['m2'], { m2: rebased });
    const notes: string[] = [];
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(['b.ts']), text => notes.push(text)))
      .toEqual({ kind: 'merged', prepared: rebased });
    expect(h.log).toEqual(['rebase', 'ff t2']);
    expect(h.forwarded()).toBe('t2');
    expect(notes[0]).toContain('existing gate remains valid');
  });

  test('new commits that touch gated files rerun the gate once, then refuse the second overlap', () => {
    const rebased = prepared('m2', 't2');
    const h = history({ t1: 'm1', t2: 'm2', m2: 'm1', m1: 'm0' }, { m2: ['b.ts'] }, ['m2'], { m2: rebased });
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(['b.ts']), () => {})).toEqual({ kind: 'regate', prepared: rebased });
    expect(h.log).toEqual(['rebase']);
    const again = history({ t1: 'm1', m2: 'm1', m1: 'm0' }, { m2: ['b.ts'] }, ['m2'], {});
    const stopped = fastForwardMain(again.sync, prepared('m1', 't1'), gates(['b.ts'], { regated: true }), () => {});
    expect(stopped).toMatchObject({ kind: 'stopped', conflict: true });
    expect((stopped as { message: string }).message).toContain('b.ts');
    expect(again.log).toEqual([]);
  });

  test('a main that moves again after the first rebase is rebased once more', () => {
    const second = prepared('m3', 't3');
    const h = history({ t1: 'm1', t2: 'm2', t3: 'm3', m3: 'm2', m2: 'm1', m1: 'm0' }, {}, ['m2', 'm3'], { m2: prepared('m2', 't2'), m3: second });
    // Main moves to m3 between the first rebase and the fast-forward.
    const refresh = h.sync.refresh;
    h.sync.refresh = () => { const next = refresh(); h.advance(); return next; };
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(), () => {})).toEqual({ kind: 'merged', prepared: second });
    expect(h.log).toEqual(['rebase', 'rebase', 'ff t3']);
  });

  describe('type check after the retry rebase', () => {
    const rebased = prepared('m2', 't2');
    const move = (file: string) => history({ t1: 'm1', t2: 'm2', m2: 'm1', m1: 'm0' }, { m2: [file] }, ['m2'], { m2: rebased });

    test('main changing another source of a checked workspace reruns that workspace only', () => {
      const h = move('services/main/src/exported-type.ts');
      expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates([], { typechecked: ['main', 'web'] }), () => {}))
        .toEqual({ kind: 'retypecheck', prepared: rebased, workspaces: ['main'] });
      expect(h.log).toEqual(['rebase']);
      expect(h.forwarded()).toBeUndefined();
    });

    test('a second such change after the retry type check refuses', () => {
      const h = move('services/main/src/exported-type.ts');
      const stopped = fastForwardMain(h.sync, prepared('m1', 't1'), gates([], { typechecked: ['main'], retyped: true }), () => {});
      expect(stopped).toMatchObject({ kind: 'stopped', conflict: true });
      expect((stopped as { message: string }).message).toContain('main');
      expect(h.log).toEqual([]);
    });

    test('changes outside the checked workspaces, or with the type check skipped, fast-forward', () => {
      const other = move('apps/web/src/a.tsx');
      expect(fastForwardMain(other.sync, prepared('m1', 't1'), gates([], { typechecked: ['main'] }), () => {})).toMatchObject({ kind: 'merged' });
      const docs = move('services/main/README.md');
      expect(fastForwardMain(docs.sync, prepared('m1', 't1'), gates([], { typechecked: ['main'] }), () => {})).toMatchObject({ kind: 'merged' });
      const skipped = move('services/main/src/exported-type.ts');
      expect(fastForwardMain(skipped.sync, prepared('m1', 't1'), gates(), () => {})).toMatchObject({ kind: 'merged' });
    });

    test('a unit overlap reruns both gates instead', () => {
      const h = move('services/main/src/exported-type.ts');
      expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(['services/main/src/exported-type.ts'], { typechecked: ['main'] }), () => {}))
        .toEqual({ kind: 'regate', prepared: rebased });
    });
  });

  test('a conflicting second rebase stops before touching main', () => {
    const h = history({ t1: 'm1', m2: 'm1', m1: 'm0' }, {}, ['m2'], {});
    expect(() => fastForwardMain(h.sync, prepared('m1', 't1'), gates(), () => {})).toThrow('does not rebase onto main');
    expect(h.log).toEqual(['rebase']);
    expect(h.forwarded()).toBeUndefined();
  });

  test('a rebase that returns a refusal is passed through without a conflict mark', () => {
    const h = history({ t1: 'm1', m2: 'm1', m1: 'm0' }, {}, ['m2'], {});
    h.sync.refresh = () => 'G-1 composition root does not parse';
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(), () => {}))
      .toEqual({ kind: 'stopped', message: 'G-1 composition root does not parse', conflict: false });
  });

  test('a main that was rewritten refuses instead of rebasing', () => {
    const h = history({ t1: 'm1', x2: 'x1' }, {}, ['x2'], {});
    expect(fastForwardMain(h.sync, prepared('m1', 't1'), gates(), () => {})).toMatchObject({ kind: 'stopped', conflict: true });
    expect(h.log).toEqual([]);
  });
});
