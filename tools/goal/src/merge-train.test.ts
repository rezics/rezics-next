import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { StaleAttemptError } from './contracts.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { firstFailure, gateRunner, git } from './merge.ts';
import { repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  let current = 1;
  const fence: AttemptFence = { assertCurrent(ref) { if (current !== ref.attempt) throw new StaleAttemptError(ref, current); } };
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
  test('scope checks both sides of renames and refuses undeclared changes', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'allowed');
      git(request.worktree, 'mv', 'base', 'renamed'); git(request.worktree, 'commit', '-m', 'Rename');
      s.queue.enqueue({ ...request, declaredPaths: ['allowed', 'renamed'] });
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
        expect(s.outcomes[0]?.passed).toBe(false);
        expect(s.outcomes[0]?.firstFailure?.assertion).toContain('stale');
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
      expect(s.outcomes[0]?.stage).toBe('merge'); expect(s.outcomes[0]?.passed).toBe(false);
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
