import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { readFlow, readLandingOperations, summarizeLandingOperations } from './flow.ts';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { StaleAttemptError } from './contracts.ts';
import { SqliteLandingQueue } from './land.ts';
import { failingTestFiles, MergeTrain, devPushScript, rebaseOnto, resolveMechanicalConflicts } from './merge-train.ts';
import { firstFailure, gateRunner, git } from './merge.ts';
import { parseBrief, protectedRiskAreasForBrief, readRiskOwnership } from './briefs.ts';
import { WorkerStore } from './store.ts';
import { TrainResolver } from './train-resolver.ts';
import { completeContinuation, harvestContinuations } from './continuation.ts';
import { readControlPolicy } from './policy.ts';
import { integrationHarness, markdown, repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  let current = 1;
  const fence: AttemptFence = {
    assertCurrent(ref) {
      if (current !== ref.attempt) throw new StaleAttemptError(ref, current);
    },
    commitMerge(ref, merge) {
      return db
        .transaction(() => {
          fence.assertCurrent(ref);
          return merge();
        })
        .immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  return {
    ...repo,
    db,
    queue,
    fence,
    outcomes,
    stale() {
      current++;
    },
    options: {
      mainCheckout: repo.main,
      stateDirectory: join(repo.path, 'state'),
      worktreeRoot: join(repo.path, 'trees'),
      queue,
      fence,
      sink: {
        onGateOutcome(outcome: GateOutcome) {
          outcomes.push(outcome);
        },
      },
    },
    close() {
      db.close();
      repo.close();
    },
  };
}

test('tracked continuation custody leaves one clean product landing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head(),
      task = h.dispatch('result.txt');
    const continuation = completeContinuation(
      markdown
        .replace('goal: fixture\n', `goal: fixture\nmanager: ${JSON.stringify(task.brief.manager)}\n`)
        .replace(
          'paths: [result.txt]\nwaiting: []',
          `paths: [follow-up.txt]\nwaiting: []\nafter: ${JSON.stringify([task.id])}`,
        )
        .replace('Write the requested result and commit it.', 'Finish the follow-up slice.'),
      task,
      undefined,
    );
    const ordinary = completeContinuation(
      continuation
        .replace('follow-up.txt', 'ordinary.txt')
        .replace('Finish the follow-up slice.', 'Finish the ordinary slice.'),
      task,
      undefined,
    );
    const planned = join(task.worktree, '.temp/goal/expected-continuation.md');
    mkdirSync(dirname(planned), { recursive: true });
    writeFileSync(planned, continuation);
    writeFileSync(join(dirname(planned), 'expected-ordinary.md'), ordinary);
    writeFileSync(
      h.settings.pools[0]!.command,
      `#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const p=JSON.parse(readFileSync('.temp/worker-plan.json','utf8')); mkdirSync('.temp/continuation',{recursive:true}); writeFileSync(p.file,p.content);
for(const [name,expected] of [['follow-up','continuation'],['ordinary','ordinary']]) writeFileSync('.temp/continuation/'+name+'.md',readFileSync('.temp/goal/expected-'+expected+'.md'));
for(const args of [['add','--',p.file],['add','-f','--','.temp/continuation/follow-up.md'],['commit','-qm','Complete fixture']]) execFileSync('git',args);
for(const item of [{type:'thread.started',thread_id:'tracked-continuation'},{type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}},{type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}]) console.log(JSON.stringify(item));
`,
    );
    h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
    h.settings.formatCommand = ['sh', '-c', 'for f do case "$f" in .temp/continuation/*) exit 1;; esac; done', 'guard'];

    await h.start(task);
    const source = git(task.worktree, 'rev-parse', task.branch),
      backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    const backlogBriefs = readdirSync(backlog)
      .filter((name) => name.endsWith('.md'))
      .map((name) => readFileSync(join(backlog, name), 'utf8'))
      .sort();
    expect(backlogBriefs).toEqual([continuation, ordinary].sort());
    expect(
      harvestContinuations(h.store, h.settings, h.store.task(task.id), { taskId: task.id, attempt: 1 }).queued,
    ).toEqual([]);

    await h.train(async () => ({ passed: true, output: '', timedOut: false }));
    const candidate = h.head(),
      introduced = git(h.root, 'rev-list', `${base}..${candidate}`).split('\n').filter(Boolean);
    expect(
      introduced.every((commit) => !git(h.root, 'ls-tree', '-r', '--name-only', commit, '--', '.temp/continuation')),
    ).toBe(true);
    expect(git(h.root, 'show', `${candidate}:result.txt`)).toBe('result.txt');
    expect([
      git(task.worktree, 'rev-parse', task.branch),
      git(task.worktree, 'status', '--porcelain', '--untracked-files=all'),
    ]).toEqual([source, '']);
    expect(h.store.task(task.id)).toMatchObject({ state: 'integrated', currentAttempt: 1 });
    expect(h.store.retryIntent({ taskId: task.id, attempt: 1 })).toBeUndefined();
  } finally {
    await h.disposeAsync();
  }
}, 30_000);

test('dev origin pushes are shared across train instances, throttled for a minute, and nonfatal on failure', () => {
  const repo = repository();
  try {
    const origin = join(repo.path, 'origin.git');
    git(repo.main, 'init', '--bare', '-q', origin);
    git(repo.main, 'remote', 'add', 'origin', origin);
    git(repo.main, 'branch', 'dev');
    const state = join(repo.path, 'state');
    const push = () =>
      Bun.spawnSync(['sh', '-c', `sleep() { printf 'cooldown:%s\\n' "$1"; exit 0; }\n${devPushScript(state, 'dev')}`], {
        cwd: repo.main,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10000,
      });
    const original = git(repo.main, 'rev-parse', 'dev');
    expect(push().exitCode).toBe(0);
    expect(git(repo.main, '--git-dir', origin, 'rev-parse', 'dev')).toBe(original);
    repo.commit('next');
    git(repo.main, 'branch', '-f', 'dev', 'HEAD');
    const throttled = push();
    expect(throttled.exitCode).toBe(0);
    expect(throttled.stdout.toString()).toMatch(/^cooldown:\d+/);
    expect(git(repo.main, '--git-dir', origin, 'rev-parse', 'dev')).toBe(original);
    git(repo.main, 'remote', 'set-url', 'origin', join(repo.path, 'unreachable.git'));
    writeFileSync(join(state, 'dev-origin-push.timestamp'), '0');
    const failed = push();
    expect(failed.exitCode).toBe(0);
    expect(failed.stderr.toString()).toContain('background dev push failed; landing continues');
    expect(Number(readFileSync(join(state, 'dev-origin-push.timestamp'), 'utf8'))).toBeGreaterThan(0);
  } finally {
    repo.close();
  }
});

describe('sequential integration', () => {
  test('rebases two queued branches onto moving main and leaves worker branches untouched', async () => {
    const s = setup();
    try {
      const first = s.branch('alpha', 'a');
      const second = s.branch('beta', 'b');
      const original = git(second.worktree, 'rev-parse', 'HEAD');
      s.queue.enqueue(first);
      s.queue.enqueue(second);
      s.commit('before');
      const gates: string[] = [];
      await new MergeTrain({
        ...s.options,
        runGate: async (_, cwd) => {
          expect(cwd).not.toBe(first.worktree);
          expect(cwd).not.toBe(second.worktree);
          gates.push(git(cwd, 'rev-parse', 'HEAD'));
          expect(existsSync(join(cwd, 'before'))).toBe(true);
          if (gates.length === 1) s.commit('during');
          else expect(existsSync(join(cwd, 'during'))).toBe(true);
          if (existsSync(join(cwd, 'b'))) expect(existsSync(join(cwd, 'a'))).toBe(true);
          return { passed: true, output: '', timedOut: false };
        },
      }).run();
      expect(gates).toHaveLength(3);
      expect(s.outcomes.map((o) => [o.taskId, o.passed])).toEqual([
        ['alpha', true],
        ['beta', true],
      ]);
      const landingEvents = readFlow(s.db).filter((event) => event.operationId);
      for (const taskId of ['alpha', 'beta']) {
        const events = landingEvents.filter((event) => event.taskId === taskId);
        expect(events.map((event) => event.action)).toEqual(['enqueued', 'started', 'finished']);
        expect(new Set(events.map((event) => event.operationId)).size).toBe(1);
      }
      expect(git(second.worktree, 'rev-parse', 'HEAD')).toBe(original);
      expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
      expect(git(s.main, 'worktree', 'list', '--porcelain')).not.toContain(`worktree ${s.options.worktreeRoot}/`);
      expect(readFileSync(join(s.main, 'a'), 'utf8')).toBe('a');
      expect(readFileSync(join(s.main, 'b'), 'utf8')).toBe('b');
    } finally {
      s.close();
    }
  });
  test('a branch passing alone fails after its predecessor merges; baseline distinguishes failure', async () => {
    const s = setup();
    try {
      const first = s.branch('alpha', 'a');
      const second = s.branch('beta', 'b');
      const gate = [
        'bun',
        '-e',
        "if (require('fs').existsSync('a') && require('fs').existsSync('b')) { console.error('error: expected compatible features at /tmp/test.ts:21:3 in 12ms'); process.exit(1) }",
      ];
      expect((await gateRunner()(gate, second.worktree, join(s.path, 'alone.log'))).passed).toBe(true);
      s.queue.enqueue(first);
      s.queue.enqueue({ ...second, gate });
      await new MergeTrain(s.options).run();
      const refused = s.outcomes[1]!;
      expect(refused.passed).toBe(false);
      expect(refused.stage).toBe('gate');
      expect(refused.firstFailure?.fingerprint).toHaveLength(64);
      expect(refused.failsOnMain).toBe(false);
      expect(existsSync(join(s.main, 'a'))).toBe(true);
      expect(existsSync(join(s.main, 'b'))).toBe(false);
    } finally {
      s.close();
    }
  });
  test('scope checks both sides of renames and refuses changes in protected paths', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'allowed');
      git(request.worktree, 'mv', 'base', 'renamed');
      const script = 'services/auth/scripts/probe.ts';
      mkdirSync(dirname(join(request.worktree, script)), { recursive: true });
      writeFileSync(join(request.worktree, script), 'probe\n');
      git(request.worktree, 'add', '--', script);
      git(request.worktree, 'commit', '-m', 'Rename');
      s.queue.enqueue({
        ...request,
        declaredPaths: ['allowed', 'renamed'],
        protectedPaths: ['base', '**/auth/**'],
      });
      let called = false;
      await new MergeTrain({
        ...s.options,
        runGate: async () => {
          called = true;
          return { passed: true, output: '', timedOut: false };
        },
      }).run();
      expect(s.outcomes[0]?.stage).toBe('scope');
      expect(called).toBe(false);
      expect(s.outcomes[0]?.changedFiles).toContain('base');
      expect(s.outcomes[0]?.changedFiles).toContain(script);
    } finally {
      s.close();
    }
  });
  test('an undeclared auth tooling edit integrates through the supported landing path', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'allowed.txt');
      const script = 'services/auth/scripts/dev-stack.ts';
      mkdirSync(dirname(join(request.worktree, script)), { recursive: true });
      writeFileSync(join(request.worktree, script), 'local development stack\n');
      git(request.worktree, 'add', '--', script);
      git(request.worktree, 'commit', '-m', 'Update local auth development stack');
      const ownership = readRiskOwnership(join(import.meta.dir, '../risk-areas.json'));
      s.queue.enqueue({
        ...request,
        declaredPaths: ['allowed.txt'],
        protectedRiskAreas: protectedRiskAreasForBrief(ownership, []),
      });
      await new MergeTrain({
        ...s.options,
        riskAreasFile: join(import.meta.dir, '../risk-areas.json'),
        runGate: async () => ({ passed: true, output: '', timedOut: false }),
      }).run();
      expect(s.outcomes[0]?.passed).toBe(true);
      expect(existsSync(join(s.main, script))).toBe(true);
    } finally {
      s.close();
    }
  }, 60_000);
  test('refuses stale enqueue, queued attempts and attempts invalidated during the gate', async () => {
    for (const when of ['enqueue', 'queued', 'gate']) {
      const s = setup();
      try {
        const request = s.branch('alpha', 'a');
        if (when === 'enqueue') {
          s.stale();
          expect(() => s.queue.enqueue(request)).toThrow(StaleAttemptError);
          continue;
        }
        s.queue.enqueue(request);
        if (when === 'queued') s.stale();
        await new MergeTrain({
          ...s.options,
          runGate: async () => {
            s.stale();
            return { passed: true, output: '', timedOut: false };
          },
        }).run();
        expect(s.outcomes).toEqual([]);
        expect(existsSync(join(s.main, 'a'))).toBe(false);
      } finally {
        s.close();
      }
    }
  });
  test('checks the fence again immediately before merging', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'a');
      s.queue.enqueue(request);
      const candidate = s.queue.candidate.bind(s.queue);
      s.queue.candidate = (id, commit) => {
        candidate(id, commit);
        s.stale();
      };
      await new MergeTrain(s.options).run();
      expect(s.outcomes).toEqual([]);
      expect(existsSync(join(s.main, 'a'))).toBe(false);
    } finally {
      s.close();
    }
  }, 60_000);
  test('reports Git refusal as a merge failure and never switches main checkout HEAD', async () => {
    const s = setup();
    try {
      const request = s.branch('alpha', 'base', 'candidate');
      s.queue.enqueue(request);
      writeFileSync(join(s.main, 'base'), 'maintainer change');
      await new MergeTrain(s.options).run();
      expect(s.outcomes[0]?.stage).toBe('merge');
      expect(s.outcomes[0]?.passed).toBe(false);
      expect(readFileSync(join(s.main, 'base'), 'utf8')).toBe('maintainer change');
      expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    } finally {
      s.close();
    }
  });
  test('marks the same assertion on main and preserves timeout information', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      await new MergeTrain({
        ...s.options,
        runGate: async () => ({
          passed: false,
          output: 'AssertionError: expected healthy environment',
          timedOut: true,
        }),
      }).run();
      expect(s.outcomes[0]?.failsOnMain).toBe(true);
      expect(s.outcomes[0]?.timedOut).toBe(true);
    } finally {
      s.close();
    }
  });
  test('only one train process may run; pending requests survive reopening the store', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      let release!: () => void;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const running = new MergeTrain({
        ...s.options,
        runGate: async () => {
          started();
          await blocked;
          return { passed: true, output: '', timedOut: false };
        },
      }).run();
      await ready;
      await expect(new MergeTrain(s.options).run()).rejects.toThrow('Lease held');
      release();
      await running;
      const queue = new SqliteLandingQueue(s.db, s.fence);
      expect(queue.next()).toBeUndefined();
    } finally {
      s.close();
    }
  });
  test('recovers a committed merge after the sink failed and redelivers the saved outcome', async () => {
    const s = setup();
    try {
      s.queue.enqueue(s.branch('alpha', 'a'));
      await expect(
        new MergeTrain({
          ...s.options,
          sink: {
            onGateOutcome() {
              throw new Error('sink unavailable');
            },
          },
        }).run(),
      ).rejects.toThrow('sink unavailable');
      expect(s.queue.next()?.outcome?.passed).toBe(true);
      await new MergeTrain(s.options).run();
      expect(s.outcomes).toHaveLength(1);
      expect(s.queue.next()).toBeUndefined();
    } finally {
      s.close();
    }
  });

  test('resolver continuation closes one operation and starts a distinct requeued operation', () => {
    const s = setup();
    try {
      const request = s.branch('resolver', 'resolved-file');
      s.queue.enqueue(request);
      const original = s.queue.next()!;
      const continued = {
        ...request,
        devResolution: {
          attempts: 1,
          commit: 'resolved-commit',
          targetHead: 'dev-head',
          method: 'resolver' as const,
          tokens: { input: 0, output: 0, cached: 0, total: 0 },
          paths: ['resolved-file'],
        },
      };
      s.queue.requeueResolved(original.id, continued);
      s.queue.requeueResolved(original.id, continued);

      const retry = s.queue.next()!;
      expect(retry.operationId).not.toBe(original.operationId);
      const outcome: GateOutcome = {
        taskId: request.taskId,
        attempt: request.attempt,
        passed: true,
        stage: 'merge',
        logPath: 'landing.log',
        hostMs: 0,
        changedFiles: [],
        diffLines: 0,
      };
      s.queue.finish(retry.id, outcome);

      const events = readFlow(s.db).filter((event) => event.taskId === request.taskId && event.operationId);
      expect(events.filter((event) => event.operationId === original.operationId).map((event) => event.action)).toEqual(
        ['enqueued', 'started', 'resolver-requeued'],
      );
      expect(events.filter((event) => event.operationId === retry.operationId).map((event) => event.action)).toEqual([
        'enqueued',
        'started',
        'finished',
      ]);
      expect(
        summarizeLandingOperations(readLandingOperations(s.db, '2000-01-01T00:00:00Z', '2100-01-01T00:00:00Z')),
      ).toMatchObject({
        terminalCount: 2,
        measuredCount: 2,
        unknownDurationCount: 0,
        outcomes: { 'resolver-requeued': 1, finished: 1 },
      });
    } finally {
      s.close();
    }
  });
});

test('a repeated Bun failure summary after a passing file heading cannot attribute an earlier failure to that passing file', () => {
  expect(
    failingTestFiles(`tools/goal/src/config.test.ts:
(fail) legacy affected and integration checks migrate to post-integration verifier settings [102.06ms]
(pass) an explicit verifierChecks setting is strict and replaces legacy validation selections [93.84ms]

tools/goal/src/efficiency-report.test.ts:
(pass) hourly report uses timestamped outcomes and leaves missing lifecycle evidence unknown [78.48ms]
(pass) hourly delivery stores one timestamped outcome and discards notifier output [93.80ms]

1 tests failed:
(fail) legacy affected and integration checks migrate to post-integration verifier settings [102.06ms]
`),
  ).toEqual(['tools/goal/src/config.test.ts']);
});

test('failure fingerprint ignores paths, line numbers, durations, stack frames and assertion order', () => {
  const first = firstFailure(
    'FAIL /tmp/a.test.ts:12:8 [12ms]\nAssertionError: expected true\nExpected: true\nReceived: false\n  at /tmp/a.ts:21:1',
  );
  const second = firstFailure(
    'Received: false\nFAIL /home/other/b.test.ts:99:2 [800ms]\nExpected: true\nAssertionError: expected true\n  at /home/other/b.ts:91:8',
  );
  expect(first.fingerprint).toBe(second.fingerprint);
  expect(firstFailure('AssertionError: expected false').fingerprint).not.toBe(first.fingerprint);
});

test('recovery distinguishes an unmerged prepared candidate from a completed Git advance', async () => {
  const s = setup();
  try {
    const request = s.branch('alpha', 'a');
    s.queue.enqueue(request);
    s.queue.candidate(s.queue.next()!.id, git(request.worktree, 'rev-parse', 'HEAD'));
    const finish = s.queue.finish.bind(s.queue);
    s.queue.finish = () => {
      throw new Error('Crash after Git advanced');
    };
    await expect(new MergeTrain(s.options).run()).rejects.toThrow('Crash after Git advanced');
    expect(existsSync(join(s.main, 'a'))).toBe(true);
    s.queue.finish = finish;
    await new MergeTrain({
      ...s.options,
      runGate: async () => {
        throw new Error('An already merged candidate should not run again');
      },
    }).run();
    expect(s.outcomes[0]?.passed).toBe(true);
    expect(s.outcomes[0]?.mergedCommit).toBe(git(s.main, 'rev-parse', 'HEAD'));
  } finally {
    s.close();
  }
});

test('main moving during baseline comparison discards the obsolete failure', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    let calls = 0;
    await new MergeTrain({
      ...s.options,
      runGate: async () => {
        calls++;
        if (calls === 2) s.commit('fixed');
        return { passed: calls >= 3, timedOut: false, output: 'AssertionError: obsolete failure' };
      },
    }).run();
    expect(calls).toBe(3);
    expect(s.outcomes[0]?.passed).toBe(true);
    expect(s.outcomes[0]?.firstFailure).toBeUndefined();
    expect(s.outcomes[0]?.failsOnMain).toBeUndefined();
  } finally {
    s.close();
  }
});

test('a checkout HEAD change during the gate cannot merge into another branch', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    await new MergeTrain({
      ...s.options,
      runGate: async () => {
        git(s.main, 'switch', '-c', 'maintenance');
        return { passed: true, timedOut: false, output: '' };
      },
    }).run();
    expect(s.outcomes[0]?.stage).toBe('merge');
    expect(s.outcomes[0]?.passed).toBe(false);
    expect(git(s.main, 'symbolic-ref', 'HEAD')).toBe('refs/heads/maintenance');
    expect(existsSync(join(s.main, 'a'))).toBe(false);
  } finally {
    s.close();
  }
});

test('a conflicting rebase is reported without changing the worker branch', async () => {
  const s = setup();
  try {
    const request = s.branch('alpha', 'base', 'candidate');
    s.queue.enqueue(request);
    s.commit('base', 'main change');
    const worker = git(request.worktree, 'rev-parse', 'HEAD');
    await new MergeTrain(s.options).run();
    expect(s.outcomes[0]?.stage).toBe('rebase');
    expect(git(request.worktree, 'rev-parse', 'HEAD')).toBe(worker);
  } finally {
    s.close();
  }
});

test('a gate cannot validate uncommitted tracked changes instead of the candidate tip', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    await new MergeTrain({
      ...s.options,
      runGate: async (_, cwd) => {
        writeFileSync(join(cwd, 'a'), 'changed by gate');
        return { passed: true, timedOut: false, output: '' };
      },
    }).run();
    expect(s.outcomes[0]?.stage).toBe('gate');
    expect(s.outcomes[0]?.passed).toBe(false);
    expect(existsSync(join(s.main, 'a'))).toBe(false);
  } finally {
    s.close();
  }
});

test('main baseline is cached durably per main commit and gate command', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.branch('alpha', 'a'));
    s.queue.enqueue(s.branch('beta', 'b'));
    let baselines = 0;
    const runGate = async (_argv: readonly string[], cwd: string) => {
      if (
        !existsSync(join(cwd, 'a')) &&
        !existsSync(join(cwd, 'b')) &&
        !existsSync(join(cwd, 'c')) &&
        !existsSync(join(cwd, 'd'))
      )
        baselines++;
      return { passed: false, output: 'AssertionError: unhealthy baseline', timedOut: false };
    };
    await new MergeTrain({ ...s.options, runGate }).run();
    expect(baselines).toBe(1);
    s.commit('main-change');
    s.queue.enqueue(s.branch('gamma', 'c'));
    await new MergeTrain({ ...s.options, runGate }).run();
    expect(baselines).toBe(2);
    s.queue.enqueue({ ...s.branch('delta', 'd'), gate: ['another-command'] });
    await new MergeTrain({ ...s.options, runGate }).run();
    expect(baselines).toBe(3);
  } finally {
    s.close();
  }
});

test('a gate does not inherit the identity of the process that drives the train', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'goal-gate-env-'));
  const saved = { manager: process.env.GOAL_MANAGER, thread: process.env.CODEX_THREAD_ID };
  process.env.GOAL_MANAGER = 'kernel';
  process.env.CODEX_THREAD_ID = 'thread';
  try {
    const result = await gateRunner(10_000)(
      ['sh', '-c', 'test -z "$GOAL_MANAGER" && test -z "$CODEX_THREAD_ID" && test -n "$PATH"'],
      directory,
      join(directory, 'gate.log'),
    );
    expect(result.passed).toBe(true);
  } finally {
    if (saved.manager === undefined) delete process.env.GOAL_MANAGER;
    else process.env.GOAL_MANAGER = saved.manager;
    if (saved.thread === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = saved.thread;
  }
});

function controlPlaneLanding(path: string, mainRelease = true) {
  const s = setup();
  mkdirSync(join(s.main, 'scripts'), { recursive: true });
  writeFileSync(join(s.main, 'scripts/architecture.ts'), 'process.exit(0);\n');
  git(s.main, 'add', '--', 'scripts/architecture.ts');
  git(s.main, 'commit', '-m', 'Architecture checker');
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
${mainRelease ? 'target: main\n' : ''}
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
  test('mixed release source retains dev conflict resolution without admitting a main proof', async () => {
    const s = controlPlaneLanding('tools/goal/src/mixed.ts');
    try {
      const task = new WorkerStore(s.goalDb).task(s.request.taskId);
      new WorkerStore(s.db).createTask(
        task.brief,
        {
          briefPath: task.briefPath,
          worktree: s.request.worktree,
          branch: s.request.branch,
          base: git(s.main, 'rev-parse', 'main'),
        },
        'implementation',
        s.request.taskId,
      );
      const product = 'scripts/product.ts';
      writeFileSync(join(s.request.worktree, product), 'export const value = "worker";\n');
      git(s.request.worktree, 'add', '--', product);
      git(s.request.worktree, 'commit', '-m', 'Product repair');
      const devTree = join(s.path, 'dev-conflict');
      git(s.main, 'worktree', 'add', devTree, 'dev');
      writeFileSync(join(devTree, product), 'export const value = "dev";\n');
      git(devTree, 'add', '--', product);
      git(devTree, 'commit', '-m', 'Concurrent product change');
      const main = git(s.main, 'rev-parse', 'main');
      const queued = s.queue.nextBatch(1, [], 'main')[0]!;
      const resolver = new TrainResolver(new WorkerStore(s.goalDb));
      resolver.devConflictStarted = () => {};
      resolver.devConflictReturned = () => {};
      let resolutions = 0;
      resolver.compose = async () => {
        resolutions++;
        throw new Error('Original product conflict remains owned');
      };
      let smokeRuns = 0;
      await new MergeTrain({
        ...s.options,
        integrationBranch: 'dev',
        trainResolver: resolver,
        runGate: async () => ({ passed: true, output: '', timedOut: false }),
        runLaunchSmoke: async () => {
          smokeRuns++;
          return { passed: true, output: '', timedOut: false };
        },
      }).run();
      expect(s.outcomes.map((outcome) => outcome.firstFailure?.assertion)).toEqual([
        expect.stringContaining('Original product conflict remains owned'),
      ]);
      expect(resolutions).toBe(1);
      expect(smokeRuns).toBe(0);
      expect(s.outcomes[0]?.passed).toBe(false);
      expect(s.outcomes[0]?.conflictedFiles).toContain(product);
      expect(s.outcomes[0]?.firstFailure?.assertion).toContain('Original product conflict remains owned');
      expect(git(s.main, 'rev-parse', 'main')).toBe(main);
      expect(existsSync(join(s.options.stateDirectory, `control-plane-proof-${queued.id}.json`))).toBe(false);
    } finally {
      s.goalDb.close();
      s.close();
    }
  });

  test('untargeted control-plane work lands on dev without the main release proof', async () => {
    const s = controlPlaneLanding('tools/goal/src/dev-change.ts', false);
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
      expect(git(s.main, 'show', 'dev:tools/goal/src/dev-change.ts')).toBe('candidate');
      expect(readFileSync(join(s.main, 'tools/goal/src/dev-change.ts'), 'utf8')).toBe('base\n');
    } finally {
      s.goalDb.close();
      s.close();
    }
  });

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
          const candidate = git(cwd, 'rev-parse', 'HEAD');
          const devScriptTree = git(cwd, 'rev-parse', 'refs/heads/dev');
          expect(command).toEqual([
            'bun',
            'tools/goal/scripts/launch-smoke.ts',
            '--expected-dev-script-tree',
            devScriptTree,
          ]);
          expect(readFileSync(join(cwd, 'tools/goal/src/launch.ts'), 'utf8')).toBe('candidate\n');
          return {
            passed: true,
            output:
              `start: passed\nwake: passed\nsuccess: passed\n` +
              `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} scenarios=launch:passed lifecycle-regressions=retry:passed\n`,
            timedOut: false,
          };
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

  test('runs the complete lifecycle suite for every control-plane path', async () => {
    const s = controlPlaneLanding('tools/goal/src/other.ts');
    try {
      let smokeRuns = 0;
      await new MergeTrain({
        ...s.options,
        integrationBranch: 'dev',
        runGate: async () => ({ passed: true, output: '', timedOut: false }),
        runLaunchSmoke: async (_command, cwd) => {
          smokeRuns++;
          const candidate = git(cwd, 'rev-parse', 'HEAD');
          const devScriptTree = git(cwd, 'rev-parse', 'refs/heads/dev');
          return {
            passed: true,
            output: `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} scenarios=landing:passed lifecycle-regressions=landing:passed\n`,
            timedOut: false,
          };
        },
      }).run();
      expect(smokeRuns).toBe(1);
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

function conflictStages(root: string, file: string, base: string, dev: string, task: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  mkdirSync(join(root, '.temp'), { recursive: true });
  writeFileSync(join(root, file), 'unmerged content\n');
  const blobs = [base, task, dev].map((content) => {
    const path = join(root, '.temp/union-stage');
    writeFileSync(path, content);
    return git(root, 'hash-object', '-w', path);
  });
  const staged = spawnSync('git', ['update-index', '--index-info'], {
    cwd: root,
    encoding: 'utf8',
    input: `${blobs.map((blob, index) => `100644 ${blob} ${index + 1}\t${file}`).join('\n')}\n`,
  });
  expect(staged.status).toBe(0);
}

const duplicateTable = `| Source | Table |
| --- | --- |
| vndb | vn |`;

describe('Markdown union', () => {
  test('keeps the integration block when dev collapsed a table the task edited, and names the union', () => {
    const repo = repository();
    const file = 'README.md';
    try {
      const base = `# Guide\n\n## Importers\n\n${duplicateTable}\n\n${duplicateTable}\n\n## Notes\n`;
      writeFileSync(join(repo.main, file), base);
      git(repo.main, 'add', '--', file);
      git(repo.main, 'commit', '-m', 'Add README');
      const originalBase = git(repo.main, 'rev-parse', 'HEAD');
      const worker = join(repo.path, 'worker');
      git(repo.main, 'worktree', 'add', '-b', 'worker', worker, originalBase);
      writeFileSync(
        join(worker, file),
        `# Guide\n\n## Importers\n\n${duplicateTable}\n\n| Source | Table |\n| --- | --- |\n| vndb | vn |\n| mal | anime |\n\n## Notes\n`,
      );
      git(worker, 'add', '--', file);
      git(worker, 'commit', '-m', 'Add importer row');
      writeFileSync(join(repo.main, file), `# Guide\n\n## Importers\n\n${duplicateTable}\n\n## Notes\n`);
      git(repo.main, 'add', '--', file);
      git(repo.main, 'commit', '-m', 'Collapse importer table');
      const log = join(repo.path, 'rebase.log');
      rebaseOnto(worker, git(repo.main, 'rev-parse', 'HEAD'), originalBase, log, []);
      const landed = readFileSync(join(worker, file), 'utf8');
      expect(landed.match(/\| Source \| Table \|/g)).toHaveLength(1);
      expect(landed).toContain('| mal | anime |');
      expect(landed).not.toContain(`${duplicateTable}\n\n${duplicateTable}`);
      expect(readFileSync(log, 'utf8')).toContain(`Markdown union: ${file}`);
    } finally {
      repo.close();
    }
  });

  test('sends a new duplicate heading to the resolver with the three Git stages', () => {
    const repo = repository();
    const file = 'guide.md';
    try {
      const base = '# Doc\n\nKeep.\n';
      const dev = '# Doc\n\nKeep.\n\n## Auth\n\nDev note.\nSomething common.\nDev tail.\n';
      const task = '# Doc\n\nKeep.\n\nSomething common.\n## Auth\n\nTask note.\n';
      conflictStages(repo.main, file, base, dev, task);
      expect(() => resolveMechanicalConflicts(repo.main, [file], undefined, 'union')).toThrow(
        `Worker change conflicts with dev in ${file}: union introduced a duplicate heading, table row or paragraph`,
      );
      expect(readFileSync(join(repo.main, file), 'utf8')).toBe('unmerged content\n');
      expect(git(repo.main, 'show', `:${1}:${file}`)).toBe(base.trimEnd());
      expect(git(repo.main, 'show', `:${2}:${file}`)).toBe(task.trimEnd());
      expect(git(repo.main, 'show', `:${3}:${file}`)).toBe(dev.trimEnd());
    } finally {
      repo.close();
    }
  });

  test('still unions independent insertions and still rejects a task deletion that remains', () => {
    const repo = repository();
    try {
      const inserted = '.temp/independent-union.md';
      conflictStages(
        repo.main,
        inserted,
        'before\nafter\n',
        'before\ndev insertion\nafter\n',
        'before\ntask insertion\nafter\n',
      );
      expect(resolveMechanicalConflicts(repo.main, [inserted], undefined, 'union')).toEqual([inserted]);
      const merged = readFileSync(join(repo.main, inserted), 'utf8');
      expect(merged).toContain('dev insertion');
      expect(merged).toContain('task insertion');

      const deleted = '.temp/deleted-union.md';
      conflictStages(
        repo.main,
        deleted,
        'before\nold permission\nafter\n',
        'before\nold permission\ndev note\nafter\n',
        'before\nnew permission\nafter\n',
      );
      expect(() => resolveMechanicalConflicts(repo.main, [deleted], undefined, 'union')).toThrow(
        `Worker change conflicts with dev in ${deleted}: task-deleted lines remain: "old permission"`,
      );
    } finally {
      repo.close();
    }
  });
});
