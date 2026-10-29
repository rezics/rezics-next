import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.ts';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { StaleAttemptError } from './contracts.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { firstFailure, gateRunner, git } from './merge.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { WorkerStore } from './store.ts';
import { repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  let current = 1;
  const fence: AttemptFence = { assertCurrent(ref) { if (current !== ref.attempt) throw new StaleAttemptError(ref, current); }, commitMerge(ref, merge) { return db.transaction(() => { fence.assertCurrent(ref); return merge(); }).immediate(); } };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  return { ...repo, db, queue, fence, outcomes, stale() { current++; },
    options: { mainCheckout: repo.main, stateDirectory: join(repo.path, 'state'), worktreeRoot: join(repo.path, 'trees'), queue, fence,
      sink: { onGateOutcome(outcome: GateOutcome) { outcomes.push(outcome); } } },
    close() { db.close(); repo.close(); } };
}

describe('sequential integration', () => {
  test('rebases two queued branches onto moving main and leaves worker branches untouched', async () => {
    const s = setup();
    try {
      const first = s.branch('alpha', 'a'); const second = s.branch('beta', 'b');
      const original = git(second.worktree, 'rev-parse', 'HEAD');
      s.queue.enqueue(first); s.queue.enqueue(second); s.commit('before');
      const gates: string[] = [];
      await new MergeTrain({ ...s.options, runGate: async (_, cwd) => {
        expect(cwd).not.toBe(first.worktree); expect(cwd).not.toBe(second.worktree);
        gates.push(git(cwd, 'rev-parse', 'HEAD'));
        expect(existsSync(join(cwd, 'before'))).toBe(true);
        if (gates.length === 1) s.commit('during');
        else expect(existsSync(join(cwd, 'during'))).toBe(true);
        if (existsSync(join(cwd, 'b'))) expect(existsSync(join(cwd, 'a'))).toBe(true);
        return { passed: true, output: '', timedOut: false };
      } }).run();
      expect(gates).toHaveLength(3);
      expect(s.outcomes.map(o => [o.taskId, o.passed])).toEqual([['alpha', true], ['beta', true]]);
      expect(git(second.worktree, 'rev-parse', 'HEAD')).toBe(original);
      expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(readFileSync(join(s.main, 'a'), 'utf8')).toBe('a');
      expect(readFileSync(join(s.main, 'b'), 'utf8')).toBe('b');
    } finally { s.close(); }
  });
  test('a branch passing alone fails after its predecessor merges; baseline distinguishes failure', async () => {
    const s = setup();
    try {
      const first = s.branch('alpha', 'a'); const second = s.branch('beta', 'b');
      const gate = ['bun', '-e', "if (require('fs').existsSync('a') && require('fs').existsSync('b')) { console.error('error: expected compatible features at /tmp/test.ts:21:3 in 12ms'); process.exit(1) }"];
      expect((await gateRunner()(gate, second.worktree, join(s.path, 'alone.log'))).passed).toBe(true);
      s.queue.enqueue(first); s.queue.enqueue({ ...second, gate });
      await new MergeTrain(s.options).run();
      const refused = s.outcomes[1]!;
      expect(refused.passed).toBe(false); expect(refused.stage).toBe('gate');
      expect(refused.firstFailure?.fingerprint).toHaveLength(64); expect(refused.failsOnMain).toBe(false);
      expect(existsSync(join(s.main, 'a'))).toBe(true); expect(existsSync(join(s.main, 'b'))).toBe(false);
    } finally { s.close(); }
  });
  test('scope checks both sides of renames and refuses changes in protected paths', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'allowed');
      git(request.worktree, 'mv', 'base', 'renamed'); git(request.worktree, 'commit', '-m', 'Rename');
      s.queue.enqueue({ ...request, declaredPaths: ['allowed', 'renamed'], protectedPaths: ['base'] });
      let called = false;
      await new MergeTrain({ ...s.options, runGate: async () => { called = true; return { passed: true, output: '', timedOut: false }; } }).run();
      expect(s.outcomes[0]?.stage).toBe('scope'); expect(called).toBe(false);
      expect(s.outcomes[0]?.changedFiles).toContain('base');
    } finally { s.close(); }
  });
  test('refuses stale enqueue, queued attempts and attempts invalidated during the gate', async () => {
    for (const when of ['enqueue', 'queued', 'gate']) {
      const s = setup();
      try {
        const request = s.branch('alpha', 'a');
        if (when === 'enqueue') { s.stale(); expect(() => s.queue.enqueue(request)).toThrow(StaleAttemptError); continue; }
        s.queue.enqueue(request); if (when === 'queued') s.stale();
        await new MergeTrain({ ...s.options, runGate: async () => {
          s.stale(); return { passed: true, output: '', timedOut: false };
        } }).run();
        expect(s.outcomes).toEqual([]);
        expect(existsSync(join(s.main, 'a'))).toBe(false);
      } finally { s.close(); }
    }
  });
  test('checks the fence again immediately before merging', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'a'); s.queue.enqueue(request);
      const candidate = s.queue.candidate.bind(s.queue);
      s.queue.candidate = (id, commit) => { candidate(id, commit); s.stale(); };
      await new MergeTrain(s.options).run();
      expect(s.outcomes).toEqual([]);
      expect(existsSync(join(s.main, 'a'))).toBe(false);
    } finally { s.close(); }
  });
  test('reports Git refusal as a merge failure and never switches main checkout HEAD', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'base', 'candidate'); s.queue.enqueue(request);
      writeFileSync(join(s.main, 'base'), 'maintainer change');
      await new MergeTrain(s.options).run();
      expect(s.outcomes[0]?.stage).toBe('merge'); expect(s.outcomes[0]?.passed).toBe(false);
      expect(readFileSync(join(s.main, 'base'), 'utf8')).toBe('maintainer change');
      expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    } finally { s.close(); }
  });
  test('marks the same assertion on main and preserves timeout information', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      await new MergeTrain({ ...s.options, runGate: async () => ({ passed: false, output: 'AssertionError: expected healthy environment', timedOut: true }) }).run();
      expect(s.outcomes[0]?.failsOnMain).toBe(true); expect(s.outcomes[0]?.timedOut).toBe(true);
    } finally { s.close(); }
  });
  test('only one train process may run; pending requests survive reopening the store', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      let release!: () => void; let started!: () => void;
      const ready = new Promise<void>(resolve => { started = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const running = new MergeTrain({ ...s.options, runGate: async () => {
        started(); await blocked; return { passed: true, output: '', timedOut: false };
      } }).run();
      await ready;
      await expect(new MergeTrain(s.options).run()).rejects.toThrow('Lease held');
      release(); await running;
      const queue = new SqliteLandingQueue(s.db, s.fence);
      expect(queue.next()).toBeUndefined();
    } finally { s.close(); }
  });
  test('recovers a committed merge after the sink failed and redelivers the saved outcome', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      await expect(new MergeTrain({ ...s.options, sink: { onGateOutcome() { throw new Error('sink unavailable'); } } }).run()).rejects.toThrow('sink unavailable');
      expect(s.queue.next()?.outcome?.passed).toBe(true);
      await new MergeTrain(s.options).run(); expect(s.outcomes).toHaveLength(1); expect(s.queue.next()).toBeUndefined();
    } finally { s.close(); }
  });
});

test('failure fingerprint ignores paths, line numbers, durations, stack frames and assertion order', () => {
  const first = firstFailure('FAIL /tmp/a.test.ts:12:8 [12ms]\nAssertionError: expected true\nExpected: true\nReceived: false\n  at /tmp/a.ts:21:1');
  const second = firstFailure('Received: false\nFAIL /home/other/b.test.ts:99:2 [800ms]\nExpected: true\nAssertionError: expected true\n  at /home/other/b.ts:91:8');
  expect(first.fingerprint).toBe(second.fingerprint);
  expect(firstFailure('AssertionError: expected false').fingerprint).not.toBe(first.fingerprint);
});

test('recovery distinguishes an unmerged prepared candidate from a completed Git advance', async () => {
  const s = setup();
  try {
    const request = s.branch('alpha', 'a'); s.queue.enqueue(request);
    s.queue.candidate(s.queue.next()!.id, git(request.worktree, 'rev-parse', 'HEAD'));
    const finish = s.queue.finish.bind(s.queue);
    s.queue.finish = () => { throw new Error('Crash after Git advanced'); };
    await expect(new MergeTrain(s.options).run()).rejects.toThrow('Crash after Git advanced');
    expect(existsSync(join(s.main, 'a'))).toBe(true);
    s.queue.finish = finish;
    await new MergeTrain({ ...s.options, runGate: async () => { throw new Error('An already merged candidate should not run again'); } }).run();
    expect(s.outcomes[0]?.passed).toBe(true); expect(s.outcomes[0]?.mergedCommit).toBe(git(s.main, 'rev-parse', 'HEAD'));
  } finally { s.close(); }
});

test('main moving during baseline comparison discards the obsolete failure', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    let calls = 0;
    await new MergeTrain({ ...s.options, runGate: async () => {
      calls++;
      if (calls === 2) s.commit('fixed');
      return { passed: calls >= 3, timedOut: false, output: 'AssertionError: obsolete failure' };
    } }).run();
    expect(calls).toBe(3); expect(s.outcomes[0]?.passed).toBe(true);
    expect(s.outcomes[0]?.firstFailure).toBeUndefined(); expect(s.outcomes[0]?.failsOnMain).toBeUndefined();
  } finally { s.close(); }
});

test('a checkout HEAD change during the gate cannot merge into another branch', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    await new MergeTrain({ ...s.options, runGate: async () => {
      git(s.main, 'switch', '-c', 'maintenance'); return { passed: true, timedOut: false, output: '' };
    } }).run();
    expect(s.outcomes[0]?.stage).toBe('merge'); expect(s.outcomes[0]?.passed).toBe(false);
    expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/maintenance');
    expect(existsSync(join(s.main, 'a'))).toBe(false);
  } finally { s.close(); }
});

test('a conflicting rebase is reported without changing the worker branch', async () => {
  const s = setup();
  try {
    const request = s.branch('alpha', 'base', 'candidate'); s.queue.enqueue(request); s.commit('base', 'main change');
    const worker = git(request.worktree, 'rev-parse', 'HEAD');
    await new MergeTrain(s.options).run();
    expect(s.outcomes[0]?.stage).toBe('rebase'); expect(git(request.worktree, 'rev-parse', 'HEAD')).toBe(worker);
  } finally { s.close(); }
});

test('a gate cannot validate uncommitted tracked changes instead of the candidate tip', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    await new MergeTrain({ ...s.options, runGate: async (_, cwd) => {
      writeFileSync(join(cwd, 'a'), 'changed by gate'); return { passed: true, timedOut: false, output: '' };
    } }).run();
    expect(s.outcomes[0]?.stage).toBe('gate'); expect(s.outcomes[0]?.passed).toBe(false);
    expect(existsSync(join(s.main, 'a'))).toBe(false);
  } finally { s.close(); }
});

test('main baseline is cached durably per main commit and gate command', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a')); s.queue.enqueue(s.branch('beta', 'b'));
    let baselines = 0;
    const runGate = async (_argv: readonly string[], cwd: string) => {
      if (!existsSync(join(cwd, 'a')) && !existsSync(join(cwd, 'b')) && !existsSync(join(cwd, 'c')) && !existsSync(join(cwd, 'd'))) baselines++;
      return { passed: false, output: 'AssertionError: unhealthy baseline', timedOut: false };
    };
    await new MergeTrain({ ...s.options, runGate }).run(); expect(baselines).toBe(1);
    s.commit('main-change'); s.queue.enqueue(s.branch('gamma', 'c'));
    await new MergeTrain({ ...s.options, runGate }).run(); expect(baselines).toBe(2);
    s.queue.enqueue({ ...s.branch('delta', 'd'), gate: ['another-command'] });
    await new MergeTrain({ ...s.options, runGate }).run(); expect(baselines).toBe(3);
  } finally { s.close(); }
});

test('a gate does not inherit the identity of the process that drives the train', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-gate-env-'));
  const saved = { manager: process.env.GOAL_MANAGER, thread: process.env.CODEX_THREAD_ID };
  process.env.GOAL_MANAGER = 'kernel'; process.env.CODEX_THREAD_ID = 'thread';
  try {
    const result = await gateRunner(10_000)(['sh', '-c', 'test -z "$GOAL_MANAGER" && test -z "$CODEX_THREAD_ID" && test -n "$PATH"'], directory, join(directory, 'gate.log'));
    expect(result.passed).toBe(true);
  } finally {
    if (saved.manager === undefined) delete process.env.GOAL_MANAGER; else process.env.GOAL_MANAGER = saved.manager;
    if (saved.thread === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = saved.thread;
  }
});

function controlPlaneLanding(path: string) {
  const s = setup();
  mkdirSync(join(s.main, path, '..'), { recursive: true });
  writeFileSync(join(s.main, path), 'base\n');
  git(s.main, 'add', '--', path);
  git(s.main, 'commit', '-m', 'Control-plane base');
  git(s.main, 'branch', 'dev', 'main');
  const request = s.branch('alpha', path, 'candidate\n');
  mkdirSync(s.options.stateDirectory, { recursive: true });
  const goalDb = openDb(join(s.options.stateDirectory, 'goal.sqlite'));
  const store = new WorkerStore(goalDb);
  const brief = parseBrief(
    `---
goal: control-plane
kind: implementation
paths: [${path}]
riskAreas: []
acceptance:
  command: ["true"]
  tests: [smoke]
  failing: true
estimate:
  lines: 1
  files: 1
criticalPath: false
waiting: []
---
Update the control plane.
`,
    readRiskOwnership(join(import.meta.dir, '../risk-areas.json')),
  );
  store.createTask(
    brief,
    {
      briefPath: join(s.options.stateDirectory, 'alpha.md'),
      worktree: request.worktree,
      branch: request.branch,
      base: git(s.main, 'rev-parse', 'main'),
    },
    'implementation',
    request.taskId,
  );
  s.queue.enqueue(request);
  return { ...s, request, goalDb };
}

describe('control-plane launch smoke gate', () => {
  test('runs after control-plane checks for a launch-path candidate', async () => {
    const s = controlPlaneLanding('tools/goal/src/launch.ts');
    try {
      const order: string[] = [];
      await new MergeTrain({
        ...s.options,
        integrationBranch: 'dev',
        runGate: async (command, cwd) => {
          order.push(`check:${command.join(' ')}`);
          expect(existsSync(join(cwd, 'tools/goal/src/launch.ts'))).toBe(true);
          return { passed: true, output: '', timedOut: false };
        },
        runLaunchSmoke: async (command, cwd) => {
          order.push('smoke');
          expect(command).toEqual(['bun', 'tools/goal/scripts/launch-smoke.ts']);
          expect(readFileSync(join(cwd, 'tools/goal/src/launch.ts'), 'utf8')).toBe('candidate\n');
          return { passed: true, output: 'start: passed\nwake: passed\nsuccess: passed\n', timedOut: false };
        },
      }).run();
      expect(order.at(-1)).toBe('smoke');
      expect(order.filter((entry) => entry.startsWith('check:')).length).toBeGreaterThan(1);
      expect(s.outcomes[0]?.passed).toBe(true);
      expect(readFileSync(join(s.main, 'tools/goal/src/launch.ts'), 'utf8')).toBe('candidate\n');
    } finally {
      s.goalDb.close();
      s.close();
    }
  });

  test('does not run the smoke for a control-plane candidate outside the launch path', async () => {
    const s = controlPlaneLanding('tools/goal/src/other.ts');
    try {
      let smokeRuns = 0;
      await new MergeTrain({
        ...s.options,
        integrationBranch: 'dev',
        runGate: async () => ({ passed: true, output: '', timedOut: false }),
        runLaunchSmoke: async () => {
          smokeRuns++;
          return { passed: true, output: '', timedOut: false };
        },
      }).run();
      expect(smokeRuns).toBe(0);
      expect(s.outcomes[0]?.passed).toBe(true);
      expect(readFileSync(join(s.main, 'tools/goal/src/other.ts'), 'utf8')).toBe('candidate\n');
    } finally {
      s.goalDb.close();
      s.close();
    }
  });

  test('returns a smoke failure with its step output and does not land the candidate', async () => {
    const s = controlPlaneLanding('tools/goal/src/job.ts');
    try {
      await new MergeTrain({
        ...s.options,
        integrationBranch: 'dev',
        runGate: async () => ({ passed: true, output: '', timedOut: false }),
        runLaunchSmoke: async () => ({
          passed: false,
          output: 'start: passed\nwake: failed: resume session mismatch\n',
          timedOut: false,
        }),
      }).run();
      expect(s.outcomes[0]?.passed).toBe(false);
      expect(s.outcomes[0]?.stage).toBe('gate');
      expect(s.outcomes[0]?.firstFailure?.assertion).toContain('wake: failed: resume session mismatch');
      expect(readFileSync(join(s.main, 'tools/goal/src/job.ts'), 'utf8')).toBe('base\n');
    } finally {
      s.goalDb.close();
      s.close();
    }
  });
});
