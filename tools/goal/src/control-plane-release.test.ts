import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MergeTrain, type TrainOptions } from './merge-train.ts';
import { git, type GateRunner } from './merge.ts';
import type { GateOutcome } from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { integrationHarness, markdown } from './test-support.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';

type ReleaseHooks = Partial<
  Pick<
    TrainOptions,
    | 'beforeIntegrationAdvance'
    | 'beforePromotionAdvance'
    | 'beforeRelease'
    | 'codeIsCurrent'
    | 'handOff'
    | 'controlPlaneDevLeaseTimeoutMs'
  >
>;
type SmokeRunner = GateRunner;

const success: GateRunner = async () => ({ passed: true, output: '', timedOut: false });

function dispatchControlPlane(
  h: ReturnType<typeof integrationHarness>,
  file = 'tools/goal/src/release.ts',
  manager = 'control-manager',
) {
  const brief = join(h.settings.stateDirectory, `control-plane-${crypto.randomUUID()}.md`);
  writeFileSync(
    brief,
    markdown
      .replace('goal: fixture', `goal: control-plane\ntarget: main\nmanager: ${manager}`)
      .replace('paths: [result.txt]', `paths: [${file}]`)
      .replace('command: [bun, test]', 'command: ["true"]'),
  );
  const task = h.tasks.dispatch(brief);
  mkdirSync(dirname(join(task.worktree, file)), { recursive: true });
  writeFileSync(join(task.worktree, file), 'candidate\n');
  mkdirSync(join(task.worktree, '.temp'), { recursive: true });
  writeFileSync(join(task.worktree, '.temp/worker-plan.json'), JSON.stringify({ file, content: 'candidate\n' }));
  return task;
}

async function releaseEvidence(command: readonly string[], cwd: string) {
  const candidate = git(cwd, 'rev-parse', 'HEAD');
  const devScriptTree = git(cwd, 'rev-parse', 'refs/heads/dev');
  const expected = command[command.indexOf('--expected-dev-script-tree') + 1];
  const passed = expected === devScriptTree;
  return {
    passed,
    output:
      `start: passed\nwake: passed\nsuccess: passed\n` +
      `release evidence: candidate=${candidate} dev-script-tree=${devScriptTree} ` +
      `scenarios=worker-wake:passed,retry:passed lifecycle-regressions=release:passed\n`,
    timedOut: false,
  };
}

async function train(
  h: ReturnType<typeof integrationHarness>,
  runGate: GateRunner = success,
  runLaunchSmoke: SmokeRunner = releaseEvidence,
  hooks: ReleaseHooks = {},
  mode: 'run' | 'pump' = 'run',
) {
  await new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        h.outcomes.push(outcome);
        h.job.onGateOutcome(outcome);
      },
    },
    runGate,
    runLaunchSmoke,
    ...hooks,
  })[mode]();
  await h.job.drain();
}

function addBranchCommit(
  h: ReturnType<typeof integrationHarness>,
  branch: string,
  files: Record<string, string>,
): string {
  const base = h.head(branch);
  const tree = join(h.settings.worktreeRoot, `release-race-${crypto.randomUUID()}`);
  mkdirSync(h.settings.worktreeRoot, { recursive: true });
  git(h.root, 'worktree', 'add', '--detach', tree, base);
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(tree, file)), { recursive: true });
      writeFileSync(join(tree, file), content);
    }
    git(tree, 'add', '-A');
    git(tree, 'commit', '-m', `Advance ${branch} during validation`);
    const commit = git(tree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', `refs/heads/${branch}`, commit, base);
    return commit;
  } finally {
    git(h.root, 'worktree', 'remove', '--force', tree);
  }
}

function addMainCommit(h: ReturnType<typeof integrationHarness>, file: string): string {
  writeFileSync(join(h.root, file), 'unrelated main work\n');
  git(h.root, 'add', '--', file);
  git(h.root, 'commit', '-m', 'Advance main during validation');
  return h.head('main');
}

function releaseRecords(h: ReturnType<typeof integrationHarness>) {
  return readdirSync(h.settings.stateDirectory)
    .filter((name) => /^control-plane-release-.*\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(join(h.settings.stateDirectory, name), 'utf8')) as Record<string, unknown>);
}

test('ordinary release waits for dev drain before capturing refs and retains both leases through publication', async () => {
  const h = integrationHarness();
  const resumeDev = Promise.withResolvers<void>();
  const waitingForDev = Promise.withResolvers<void>();
  let running: Promise<void> | undefined;
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const devTask = h.dispatch('dev-result.txt');
    const task = dispatchControlPlane(h);
    await h.start(devTask);
    await h.start(task);
    let devDrained = false;
    let gateCalls = 0;
    let smokeCalls = 0;
    let published = false;
    let owners: string[] | undefined;
    const assertLeases = () => {
      const current = ['train-main.lease', 'train.lease'].map((name) => {
        const path = join(h.settings.stateDirectory, name);
        expect(() => acquireDirectoryLease(path)).toThrow(LeaseHeldError);
        const files = readdirSync(path);
        expect(files).toHaveLength(1);
        return readFileSync(join(path, files[0]!), 'utf8');
      });
      owners ??= current;
      expect(current).toEqual(owners);
    };
    running = train(
      h,
      async () => {
        gateCalls++;
        assertLeases();
        return { passed: true, output: '', timedOut: false };
      },
      async (command, cwd) => {
        smokeCalls++;
        assertLeases();
        return releaseEvidence(command, cwd);
      },
      {
        codeIsCurrent: () => {
          if (devDrained && existsSync(join(h.settings.stateDirectory, 'train-main.lease'))) waitingForDev.resolve();
          return true;
        },
        beforeRelease: async () => {
          if (devDrained) return;
          devDrained = true;
          await resumeDev.promise;
        },
        beforePromotionAdvance: () => {
          assertLeases();
          published = true;
        },
      },
    );
    await waitingForDev.promise;
    expect(gateCalls).toBe(0);
    expect(smokeCalls).toBe(0);
    const capturedDev = h.head('dev');
    expect(capturedDev).toBe(h.store.task(devTask.id).integratedCommit!);
    resumeDev.resolve();
    await running;
    expect(h.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      [devTask.id, true],
      [task.id, true],
    ]);
    expect(gateCalls).toBeGreaterThan(0);
    expect(smokeCalls).toBe(1);
    expect(published).toBe(true);
    expect(releaseRecords(h)[0]?.devScriptTree).toBe(capturedDev);
    expect(git(h.root, 'merge-base', '--is-ancestor', capturedDev, 'dev')).toBe('');
    expect(existsSync(join(h.settings.stateDirectory, 'train-main.lease'))).toBe(false);
    expect(existsSync(join(h.settings.stateDirectory, 'train.lease'))).toBe(false);
  } finally {
    resumeDev.resolve();
    await running;
    h.dispose();
  }
});

test('ordinary release contention is bounded and preserves the live dev owner and pending request', async () => {
  const h = integrationHarness();
  let owner: ReturnType<typeof acquireDirectoryLease> | undefined;
  try {
    h.ensureDev();
    const base = h.head('main');
    const task = dispatchControlPlane(h);
    await h.start(task);
    const entry = h.queue.next()!;
    const path = join(h.settings.stateDirectory, 'train.lease');
    owner = acquireDirectoryLease(path);
    const ownerFiles = readdirSync(path);
    const identity = readFileSync(join(path, ownerFiles[0]!), 'utf8');
    let gates = 0;
    const started = performance.now();
    await train(
      h,
      async () => {
        gates++;
        return { passed: true, output: '', timedOut: false };
      },
      releaseEvidence,
      { controlPlaneDevLeaseTimeoutMs: 25 },
      'pump',
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(gates).toBe(0);
    expect(h.outcomes).toEqual([]);
    expect(h.queue.entry({ taskId: task.id, attempt: 1 })).toMatchObject({
      id: entry.id,
      delivered: 0,
      outcome: null,
      candidate: null,
    });
    expect([h.head('main'), h.head('dev')]).toEqual([base, base]);
    expect(readdirSync(path)).toEqual(ownerFiles);
    expect(readFileSync(join(path, ownerFiles[0]!), 'utf8')).toBe(identity);
    expect(() => acquireDirectoryLease(path)).toThrow(LeaseHeldError);
    expect(existsSync(join(h.settings.stateDirectory, 'train-main.lease'))).toBe(false);
    expect(readFileSync(join(h.settings.stateDirectory, `landing-${entry.id}.log`), 'utf8')).toContain(
      'release deferred: dev train lease held after waiting 25ms; request remains pending',
    );
    owner.release();
    await train(h);
    expect(h.outcomes[0]?.passed).toBe(true);
  } finally {
    owner?.release();
    h.dispose();
  }
});

for (const failure of ['gate refusal', 'gate exception', 'cancelled attempt'] as const) {
  test(`ordinary release releases both leases after ${failure}`, async () => {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const base = h.head('main');
      const task = dispatchControlPlane(h);
      await h.start(task);
      await train(h, async () => {
        expect(() => acquireDirectoryLease(join(h.settings.stateDirectory, 'train.lease'))).toThrow(LeaseHeldError);
        if (failure === 'gate exception') throw new Error('fixture gate exception');
        if (failure === 'cancelled attempt')
          h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (attempt) => {
            attempt.state = 'cancelled';
          });
        return { passed: false, output: 'fixture gate refusal', timedOut: false };
      });
      expect([h.head('main'), h.head('dev')]).toEqual([base, base]);
      expect(h.outcomes.some((outcome) => outcome.passed)).toBe(false);
      if (failure === 'cancelled attempt') expect(h.outcomes).toEqual([]);
      else expect(h.outcomes[0]?.firstFailure?.assertion).toContain(`fixture ${failure}`);
      for (const name of ['train-main.lease', 'train.lease']) {
        const path = join(h.settings.stateDirectory, name);
        expect(existsSync(path)).toBe(false);
        acquireDirectoryLease(path).release();
      }
    } finally {
      h.dispose();
    }
  });
}

test('ordinary release refuses repeated external dev drift at the final atomic ref fence', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatchControlPlane(h);
    await h.start(task);
    let external = base;
    let attempts = 0;
    let suites = 0;
    let contracts = 0;
    let lifecycles = 0;
    await train(
      h,
      async (command) => {
        if (command[1] === 'test') suites++;
        if (command[1] === 'tools/goal/scripts/check-compatibility.ts') contracts++;
        return { passed: true, output: '', timedOut: false };
      },
      async (command, cwd) => {
        lifecycles++;
        return releaseEvidence(command, cwd);
      },
      {
        beforePromotionAdvance: () => {
          attempts++;
          expect(() => acquireDirectoryLease(join(h.settings.stateDirectory, 'train.lease'))).toThrow(LeaseHeldError);
          external = addBranchCommit(h, 'dev', { 'external.txt': `external change ${attempts}\n` });
        },
      },
    );
    expect([attempts, suites, contracts, lifecycles]).toEqual([5, 5, 5, 5]);
    expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual([base, base, external]);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('refs kept moving during five validation attempts');
    expect(releaseRecords(h)).toEqual([]);
    expect(existsSync(join(h.settings.stateDirectory, 'train-main.lease'))).toBe(false);
    expect(existsSync(join(h.settings.stateDirectory, 'train.lease'))).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a checked candidate publishes main, stabilize and dev together with exact release evidence', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatchControlPlane(h);
    await h.start(task);
    const commands: string[][] = [];
    await train(h, async (command) => {
      commands.push([...command]);
      return { passed: true, output: '', timedOut: false };
    });

    const main = h.head('main');
    const stabilize = h.head('stabilize');
    const dev = h.head('dev');
    expect(main).not.toBe(base);
    expect(git(h.root, 'rev-parse', 'stabilize^2')).toBe(main);
    expect(git(h.root, 'rev-parse', 'dev^2')).toBe(stabilize);
    expect(git(h.root, 'merge-base', '--is-ancestor', main, stabilize)).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', stabilize, dev)).toBe('');
    expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
    expect(commands).toContainEqual(['bun', 'test', '--timeout', '30000', 'tools/goal/src']);
    expect(commands.some((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toBe(true);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.mergedCommit).toBe(main);

    const [record] = releaseRecords(h);
    expect(record).toMatchObject({
      mainCommit: main,
      mainExpected: base,
      devScriptTree: base,
      stabilizeCommit: stabilize,
      devCommit: dev,
    });
    expect(record?.lifecycleEvidence).toContain(`candidate=${main} dev-script-tree=${base}`);
    expect(record?.lifecycleEvidence).toContain('scenarios=worker-wake:passed,retry:passed');
    expect(record?.compatibilityCommand).toContain('tools/goal/scripts/check-compatibility.ts');
    expect(git(h.root, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  } finally {
    h.dispose();
  }
});

test('an absent stabilize branch prepares main directly into dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatchControlPlane(h);
    await h.start(task);
    await train(h);

    const main = h.head('main');
    const dev = h.head('dev');
    expect(git(h.root, 'branch', '--list', 'stabilize')).toBe('');
    expect(git(h.root, 'rev-parse', 'dev^2')).toBe(main);
    expect(git(h.root, 'merge-base', '--is-ancestor', main, dev)).toBe('');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('preparing main directly into dev');
    expect(h.outcomes[0]?.passed).toBe(true);
  } finally {
    h.dispose();
  }
});

for (const movingBranch of ['main', 'stabilize', 'dev'] as const) {
  test(`${movingBranch} movement during validation discards the stale release and reruns its checks`, async () => {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const base = h.head('main');
      if (movingBranch === 'stabilize') git(h.root, 'branch', 'stabilize', base);
      const task = dispatchControlPlane(h);
      await h.start(task);
      let raced = false;
      let unrelated = '';
      let suiteRuns = 0;
      let contractRuns = 0;
      const runGate: GateRunner = async (command) => {
        if (JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', 'tools/goal/src']))
          suiteRuns++;
        if (command[1] === 'tools/goal/scripts/check-compatibility.ts') contractRuns++;
        if (!raced) {
          raced = true;
          if (movingBranch === 'main') unrelated = addMainCommit(h, 'main-race.txt');
          else unrelated = addBranchCommit(h, movingBranch, { [`${movingBranch}-race.txt`]: 'unrelated work\n' });
        }
        return { passed: true, output: '', timedOut: false };
      };
      await train(h, runGate);

      expect(raced).toBe(true);
      expect(suiteRuns).toBe(2);
      expect(contractRuns).toBe(1);
      expect(h.outcomes[0]?.passed).toBe(true);
      expect(git(h.root, 'merge-base', '--is-ancestor', unrelated, movingBranch)).toBe('');
      expect(git(h.root, `show`, `${movingBranch}:${movingBranch}-race.txt`)).toContain(
        movingBranch === 'main' ? 'unrelated main work' : 'unrelated work',
      );
      expect(git(h.root, 'merge-base', '--is-ancestor', h.head('main'), 'dev')).toBe('');
      if (movingBranch === 'stabilize') {
        expect(git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toBe('');
      }
    } finally {
      h.dispose();
    }
  });
}

test('a repeated propagation conflict is notified once, quarantined, and leaves all refs unchanged', async () => {
  const h = integrationHarness();
  try {
    const file = 'tools/goal/src/conflict.ts';
    mkdirSync(dirname(join(h.root, file)), { recursive: true });
    writeFileSync(join(h.root, file), 'base\n');
    git(h.root, 'add', '--', file);
    git(h.root, 'commit', '-m', 'Add conflict base');
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    addBranchCommit(h, 'stabilize', { [file]: 'stabilize side\n' });
    const stabilize = h.head('stabilize');
    const task = dispatchControlPlane(h, file);
    await h.start(task);
    const dev = h.head('dev');

    await train(h);
    await train(h);

    expect(h.head('main')).toBe(base);
    expect(h.head('stabilize')).toBe(stabilize);
    expect(h.head('dev')).toBe(dev);
    expect(h.store.task(task.id).state).toBe('stopped');
    expect(h.outcomes).toHaveLength(2);
    expect(h.outcomes.every((outcome) => !outcome.passed && outcome.conflictedFiles?.includes(file))).toBe(true);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain(`files=[${file}]`);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('cause=');
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log.match(/Prepared control-plane merge .* failed/g)).toHaveLength(1);
    expect(log).toContain(file);
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.integration.inboxDirectory);
    const notices = inbox
      .read('control-manager')
      .map(({ event }) => event.summary)
      .filter((summary) => summary.includes('conflicts with stabilize'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain(file);
    expect(notices[0]).toContain('Cause:');
  } finally {
    h.dispose();
  }
});

test('a known dev add/add conflict prevents main and stabilize from advancing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const conflictFile = 'tools/goal/src/web-landing-smoke.test.ts';
    const main = h.head('main');
    git(h.root, 'branch', 'stabilize', main);
    const dev = addBranchCommit(h, 'dev', { [conflictFile]: 'dev-side launch scenario\n' });
    const task = dispatchControlPlane(h, conflictFile);
    await h.start(task);

    await train(h);

    expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual([main, main, dev]);
    expect(git(h.root, 'show', `dev:${conflictFile}`)).toBe('dev-side launch scenario');
    expect(h.store.task(task.id).state).not.toBe('merged');
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.conflictedFiles).toContain(conflictFile);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain(`files=[${conflictFile}]`);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('cause=');
    expect(releaseRecords(h)).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test('a durable record recovers a fully published release interrupted before queue completion', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const base = h.head('main');
    git(h.root, 'branch', 'stabilize', base);
    const task = dispatchControlPlane(h);
    await h.start(task);
    const originalFinish = h.queue.finish.bind(h.queue);
    h.queue.finish = ((..._args: Parameters<typeof h.queue.finish>) => {
      throw new Error('interrupted after atomic ref publication');
    }) as typeof h.queue.finish;

    await expect(train(h)).rejects.toThrow('interrupted after atomic ref publication');
    const published = [h.head('main'), h.head('stabilize'), h.head('dev')];
    expect(published[0]).not.toBe(base);
    expect(releaseRecords(h)).toHaveLength(1);
    h.queue.finish = originalFinish;
    let gatesAfterRecovery = 0;
    await train(
      h,
      async () => {
        gatesAfterRecovery++;
        throw new Error('recovery must use the durable release record');
      },
      async () => {
        gatesAfterRecovery++;
        return { passed: false, output: '', timedOut: false };
      },
    );

    expect(gatesAfterRecovery).toBe(0);
    expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual(published);
    expect(h.outcomes.at(-1)?.passed).toBe(true);
    expect(h.outcomes.at(-1)?.mergedCommit).toBe(published[0]);
    expect(releaseRecords(h)[0]).toMatchObject({
      mainCommit: published[0],
      stabilizeCommit: published[1],
      devCommit: published[2],
    });
  } finally {
    h.dispose();
  }
});

test('a nonzero main/dev compatibility contract result leaves main and dev unchanged', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const dev = h.head('dev');
    const task = dispatchControlPlane(h);
    await h.start(task);
    let smokeRuns = 0;
    await train(
      h,
      async (command) =>
        command[1] === 'tools/goal/scripts/check-compatibility.ts'
          ? { passed: false, output: 'worker-check compatibility mismatch', timedOut: false }
          : { passed: true, output: '', timedOut: false },
      async () => {
        smokeRuns++;
        return { passed: true, output: '', timedOut: false };
      },
    );

    expect(h.head('main')).toBe(main);
    expect(h.head('dev')).toBe(dev);
    expect(smokeRuns).toBe(0);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('worker-check compatibility mismatch');
  } finally {
    h.dispose();
  }
});

test('a lifecycle capacity timeout is unverified and cannot certify main', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const dev = h.head('dev');
    const task = dispatchControlPlane(h);
    await h.start(task);
    await train(h, success, async () => ({
      passed: false,
      output: 'smoke budget exhausted while waiting for shared check capacity',
      timedOut: false,
    }));

    expect(h.head('main')).toBe(main);
    expect(h.head('dev')).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.timedOut).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('smoke budget exhausted');
  } finally {
    h.dispose();
  }
});

test('an emergency supermanager task uses the same control-plane release gates', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatchControlPlane(h, 'tools/goal/src/emergency.ts', 'supermanager');
    await h.start(task);
    const commands: string[][] = [];
    const smokeCommands: string[][] = [];
    await train(
      h,
      async (command) => {
        commands.push([...command]);
        return { passed: true, output: '', timedOut: false };
      },
      async (command, cwd) => {
        smokeCommands.push([...command]);
        return releaseEvidence(command, cwd);
      },
    );

    const dev = h.head('dev');
    const candidate = h.head('main');
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.store.task(task.id).brief.manager).toBe('supermanager');
    expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
    expect(commands).toContainEqual(['bun', 'test', '--timeout', '30000', 'tools/goal/src']);
    expect(commands.some((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toBe(true);
    expect(smokeCommands).toEqual([
      ['bun', 'tools/goal/scripts/launch-smoke.ts', '--expected-dev-script-tree', expect.any(String)],
    ]);
    expect(git(h.root, 'merge-base', '--is-ancestor', candidate, dev)).toBe('');
    const [record] = releaseRecords(h);
    expect(record?.lifecycleEvidence).toContain(`candidate=${candidate} dev-script-tree=`);
  } finally {
    h.dispose();
  }
});

// Cohort specifications use the existing real-Git/SQLite harness and native worker outcome sink.
import { existsSync } from 'node:fs';
import { captureControlPlaneBatch, receiveControlPlaneBatch } from './control-plane-batch.ts';
import { requestManagerLanding } from './manager-landing.ts';
import type { ControlPlaneBatchManifest } from './contracts.ts';
import type { Task } from './types.ts';

function acceptedBatch(h: ReturnType<typeof integrationHarness>, tasks: readonly Task[]): ControlPlaneBatchManifest {
  const manifest = captureControlPlaneBatch(h.store, h.queue, 'control-manager');
  expect(manifest.members.map((member) => member.taskId).sort()).toEqual(tasks.map((task) => task.id).sort());
  for (const task of tasks)
    requestManagerLanding(task.id, 'control-manager', h.store, h.queue, (id) => {
      const current = h.store.task(id);
      return {
        taskId: id,
        attempt: current.currentAttempt,
        branch: current.branch,
        worktree: current.worktree,
        declaredPaths: current.brief.paths,
        protectedPaths: h.tasks.protectedPaths(current.brief),
        gate: current.brief.acceptance.command,
      };
    });
  return manifest;
}

function batchTrain(h: ReturnType<typeof integrationHarness>, runGate: GateRunner = success, hooks: ReleaseHooks = {}) {
  return new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        h.outcomes.push(outcome);
        h.job.onGateOutcome(outcome);
      },
    },
    runGate,
    runLaunchSmoke: releaseEvidence,
    ...hooks,
  });
}

const isFullControlPlaneSuite = (command: readonly string[]) =>
  JSON.stringify(command) === JSON.stringify(['bun', 'test', '--timeout', '30000', 'tools/goal/src']);

test('One accepted control-plane main cohort validates its combined final head once and publishes every current member atomically with original attribution', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    git(h.root, 'branch', 'stabilize', main);
    const independent = addBranchCommit(h, 'dev', { 'independent.txt': 'retained development\n' });
    const tasks = [
      dispatchControlPlane(h, 'tools/goal/src/cohort-a.ts'),
      dispatchControlPlane(h, 'tools/goal/src/cohort-b.ts'),
    ];
    for (const task of tasks) await h.start(task);
    const manifest = acceptedBatch(h, tasks);
    const originals = tasks.map((task) => h.store.attempt({ taskId: task.id, attempt: 1 }).result);
    const commands: string[][] = [];
    const heads: string[] = [];
    let publications = 0;
    const result = await batchTrain(
      h,
      async (command, cwd) => {
        commands.push([...command]);
        if (isFullControlPlaneSuite(command)) {
          heads.push(git(cwd, 'rev-parse', 'HEAD'));
          for (const task of tasks) expect(existsSync(join(cwd, task.brief.paths[0]!))).toBe(true);
        }
        expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual([main, main, independent]);
        return { passed: true, output: '', timedOut: false };
      },
      {
        beforeIntegrationAdvance() {
          publications++;
          expect(tasks.map((task) => h.store.task(task.id).state)).toEqual(['landing', 'landing']);
          expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual([main, main, independent]);
        },
      },
    ).releaseControlPlaneBatch(manifest);
    await h.job.drain();
    expect(publications).toBe(1);
    expect(heads).toEqual([h.head('main')]);
    expect(commands.filter((command) => command[1] === 'run' && command.includes('typecheck'))).toHaveLength(1);
    expect(commands.filter((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toHaveLength(1);
    expect(
      result.members.every((member) => member.disposition === 'released' && member.mergedCommit === heads[0]),
    ).toBe(true);
    expect(h.outcomes).toHaveLength(2);
    for (const [index, task] of tasks.entries()) {
      const source = manifest.members.find((member) => member.taskId === task.id)!.acceptedCommit;
      expect(git(h.root, 'merge-base', '--is-ancestor', source, 'main')).toBe('');
      expect(git(task.worktree, 'rev-parse', 'HEAD')).toBe(source);
      expect(h.store.task(task.id)).toMatchObject({ state: 'merged', mergedCommit: heads[0] });
      expect(h.store.attempt({ taskId: task.id, attempt: 1 }).result).toBe(originals[index]!);
      expect(h.outcomes.find((outcome) => outcome.taskId === task.id)).toMatchObject({
        mergedCommit: heads[0],
        changedFiles: [task.brief.paths[0]],
        diffLines: 1,
      });
    }
    expect(git(h.root, 'merge-base', '--is-ancestor', independent, 'dev')).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('main'), 'stabilize')).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('stabilize'), 'dev')).toBe('');
    expect(h.queue.nextBatch(10)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('failing combined cohorts bisect instead of serial fallback and preserve grouped passing subsets across restart', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const files = ['group-a.ts', 'group-b.ts', 'group-c.ts', 'group-bad.ts'].map((file) => `tools/goal/src/${file}`);
    const tasks = files.map((file) => dispatchControlPlane(h, file));
    for (const task of tasks) await h.start(task);
    const manifest = acceptedBatch(h, tasks);
    const sizes: number[] = [];
    const result = await batchTrain(h, async (command, cwd) => {
      if (!isFullControlPlaneSuite(command)) return { passed: true, output: '', timedOut: false };
      sizes.push(git(cwd, 'diff', '--name-only', 'main', 'HEAD').split('\n').filter(Boolean).length);
      const failed = existsSync(join(cwd, files[3]!));
      return {
        passed: !failed,
        output: failed ? 'exact failing cohort assertion\nfull native output\n' : '',
        timedOut: false,
      };
    }).releaseControlPlaneBatch(manifest);
    expect(sizes).toEqual([4, 2, 2, 1, 1]);
    expect(result.members.map((member) => member.disposition)).toEqual([
      'released',
      'released',
      'released',
      'excluded',
    ]);
    expect(result.members[0]!.mergedCommit).toBe(result.members[1]!.mergedCommit);
    expect(readFileSync(result.members[3]!.logPath, 'utf8')).toContain(
      'exact failing cohort assertion\nfull native output',
    );
    expect(h.store.task(tasks[3]!.id).state).toBe('landing');
    expect(h.queue.nextBatch(20)).toEqual([]); // No ordinary serial drain can pick up a failed cohort's members.
    const replay = await batchTrain(h, async () => {
      throw new Error('durable split decisions must not rerun checks');
    }).releaseControlPlaneBatch(manifest);
    expect(replay).toEqual(result);
  } finally {
    h.dispose();
  }
});

test('a stale cohort generation cannot be hidden by collective green', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main'),
      dev = h.head('dev');
    const tasks = [
      dispatchControlPlane(h, 'tools/goal/src/stale-a.ts'),
      dispatchControlPlane(h, 'tools/goal/src/stale-b.ts'),
    ];
    for (const task of tasks) await h.start(task);
    const manifest = acceptedBatch(h, tasks);
    let moved = false;
    await expect(
      batchTrain(h, async (command) => {
        if (isFullControlPlaneSuite(command) && !moved) {
          moved = true;
          const member = manifest.members[1]!;
          const retained = h.store.attempt(member);
          h.store.nextAttempt(member, (attempt) => ({
            ...retained,
            attempt,
            state: 'pending',
            startedAt: new Date().toISOString(),
            endedAt: null,
            process: null,
            driver: null,
            auxiliaryProcesses: [],
            session: null,
            logPath: join(h.settings.stateDirectory, 'runs', member.taskId, `${attempt}.jsonl`),
            evidencePath: join(h.settings.stateDirectory, 'evidence', member.taskId, String(attempt)),
            before: null,
            after: null,
            exitCode: null,
            result: '',
          }));
        }
        return { passed: true, output: '', timedOut: false };
      }).releaseControlPlaneBatch(manifest),
    ).rejects.toThrow('stale');
    expect([h.head('main'), h.head('dev')]).toEqual([main, dev]);
    expect(h.outcomes).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('a batch publication ref race preserves independent dev work and rebuilds only the combined candidate', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const tasks = [
      dispatchControlPlane(h, 'tools/goal/src/race-a.ts'),
      dispatchControlPlane(h, 'tools/goal/src/race-b.ts'),
    ];
    for (const task of tasks) await h.start(task);
    const manifest = acceptedBatch(h, tasks);
    let suites = 0,
      publications = 0,
      raced = '';
    const result = await batchTrain(
      h,
      async (command) => {
        if (isFullControlPlaneSuite(command)) suites++;
        return { passed: true, output: '', timedOut: false };
      },
      {
        beforeIntegrationAdvance() {
          publications++;
          if (!raced) raced = addBranchCommit(h, 'dev', { 'dev-race.txt': 'independent during CAS\n' });
        },
      },
    ).releaseControlPlaneBatch(manifest);
    expect(suites).toBe(2);
    expect(publications).toBe(2);
    expect(result.members.every((member) => member.mergedCommit === h.head('main'))).toBe(true);
    expect(git(h.root, 'merge-base', '--is-ancestor', raced, 'dev')).toBe('');
    expect(git(h.root, 'show', 'dev:dev-race.txt')).toBe('independent during CAS');
  } finally {
    h.dispose();
  }
});

test('published cohorts recover all original outcomes after interruption and checkout cleanup failure without another proof', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const tasks = [
      dispatchControlPlane(h, 'tools/goal/src/recover-a.ts'),
      dispatchControlPlane(h, 'tools/goal/src/recover-b.ts'),
    ];
    for (const task of tasks) await h.start(task);
    const manifest = acceptedBatch(h, tasks);
    const finish = h.queue.finish.bind(h.queue);
    h.queue.finish = () => {
      throw new Error('interrupted batch after ref transaction');
    };
    await expect(
      batchTrain(h, success, {
        beforeIntegrationAdvance() {
          writeFileSync(join(h.root, 'README.md'), 'local checkout edit\n');
        },
      }).releaseControlPlaneBatch(manifest),
    ).rejects.toThrow('interrupted batch after ref transaction');
    const published = [h.head('main'), h.head('dev')];
    expect(published[0]).not.toBe(main);
    expect(h.outcomes).toEqual([]);
    h.queue.finish = finish;
    const result = await batchTrain(h, async () => {
      throw new Error('published proof must survive cleanup failure');
    }).releaseControlPlaneBatch(manifest);
    expect([h.head('main'), h.head('dev')]).toEqual(published);
    expect(h.outcomes).toHaveLength(2);
    expect(result.members.every((member) => member.mergedCommit === published[0])).toBe(true);
    expect(readFileSync(result.members[0]!.logPath, 'utf8')).toContain('checkout synchronization deferred');
    expect(readFileSync(join(h.root, 'README.md'), 'utf8')).toBe('local checkout edit\n');
    const replay = await batchTrain(h, async () => {
      throw new Error('idempotent replay cannot run proof');
    }).releaseControlPlaneBatch(manifest);
    expect(replay).toEqual(result);
    expect(h.outcomes).toHaveLength(2);
  } finally {
    h.dispose();
  }
});

test('batch receiving refuses GOAL_MANAGER without a persisted authenticated manager session', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatchControlPlane(h);
    await h.start(task);
    const manifest = captureControlPlaneBatch(h.store, h.queue, 'control-manager');
    await expect(
      receiveControlPlaneBatch(
        manifest,
        {
          store: h.store,
          queue: h.queue,
          train: batchTrain(h),
          landing() {
            throw new Error('unauthenticated caller cannot authorize requests');
          },
        },
        { GOAL_MANAGER: 'control-manager' },
      ),
    ).rejects.toThrow('authenticated');
    expect(h.queue.entry(manifest.members[0]!)?.request.managerLanding).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('an accepted source already represented by main has an honest zero-delta disposition', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const first = dispatchControlPlane(h, 'tools/goal/src/represented.ts');
    const second = dispatchControlPlane(h, 'tools/goal/src/new-contribution.ts');
    await h.start(first);
    await h.start(second);
    const manifest = acceptedBatch(h, [first, second]);
    const path = first.brief.paths[0]!;
    mkdirSync(dirname(join(h.root, path)), { recursive: true });
    writeFileSync(join(h.root, path), 'candidate\n');
    git(h.root, 'add', '--', path);
    git(h.root, 'commit', '-m', 'Independently represent the accepted implementation');
    let suites = 0;
    const result = await batchTrain(h, async (command) => {
      if (isFullControlPlaneSuite(command)) suites++;
      return { passed: true, output: '', timedOut: false };
    }).releaseControlPlaneBatch(manifest);
    expect(suites).toBe(1);
    expect(result.members.map((member) => member.disposition)).toEqual(['already-represented', 'released']);
    expect(h.outcomes.find((outcome) => outcome.taskId === first.id)).toMatchObject({ changedFiles: [], diffLines: 0 });
    expect(git(h.root, 'log', '--format=%s', 'main')).not.toContain(`Merge accepted source ${first.branch}`);
    expect(git(first.worktree, 'rev-parse', 'HEAD')).toBe(manifest.members[0]!.acceptedCommit);
  } finally {
    h.dispose();
  }
});

// Controlled scheduling cases exercise the real train, queue, leases and Git publication path.
import { processGroupRunner } from './merge.ts';

async function schedulingUntil(condition: () => boolean) {
  for (let turn = 0; turn < 200 && !condition(); turn++) await Bun.sleep(10);
  expect(condition()).toBe(true);
}

function ordinaryProofs(h: ReturnType<typeof integrationHarness>, id: number) {
  return JSON.parse(readFileSync(join(h.settings.stateDirectory, `control-plane-proof-${id}.json`), 'utf8')) as {
    attempts: {
      source: string;
      candidate?: string;
      status: string;
      logPath: string;
      reason?: string;
      outcome?: GateOutcome;
      snapshot: { devHead: string };
    }[];
  };
}

function commandAlive(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
  } catch {
    return false;
  }
}

test('A queued product dev landing advances through its ordinary lane while a slow control-plane main proof is pending without weakening final proof or stealing live custody', async () => {
  const h = integrationHarness();
  let running: Promise<void> | undefined;
  const gateRelease = join(h.settings.stateDirectory, 'release-slow-proof');
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const main = h.head('main');
    git(h.root, 'branch', 'stabilize', main);
    const control = dispatchControlPlane(h);
    await h.start(control);
    const source = h.head(control.branch);
    const workerEvidence = h.store.attempt({ taskId: control.id, attempt: 1 }).result;
    const entry = h.queue.entry({ taskId: control.id, attempt: 1 })!;
    const pidFiles: string[] = [];
    const native = processGroupRunner(5000);
    let smokeCalls = 0;
    running = train(
      h,
      async (command, cwd, log, options) => {
        if (!isFullControlPlaneSuite(command) && !command.includes('typecheck')) return success(command, cwd, log);
        const pidFile = join(h.settings.stateDirectory, `slow-proof-${pidFiles.length}.pid`);
        pidFiles.push(pidFile);
        return native(
          [
            'sh',
            '-c',
            `echo $$ > '${pidFile}'; echo partial-proof-output; while [ ! -f '${gateRelease}' ]; do sleep 1; done`,
          ],
          cwd,
          log,
          options,
        );
      },
      async (...args) => {
        smokeCalls++;
        return releaseEvidence(args[0], args[1]);
      },
    );
    await schedulingUntil(() => pidFiles.length === 2 && pidFiles.every((file) => existsSync(file)));
    const pids = pidFiles.map((file) => Number(readFileSync(file, 'utf8').trim()));
    const ownerPaths = ['train-main.lease', 'train.lease'].map((name) => join(h.settings.stateDirectory, name));
    const owners = ownerPaths.map((path) => readFileSync(join(path, readdirSync(path)[0]!), 'utf8'));
    // Another real train cannot steal either live owner, even though its initial idle dev drain has no work.
    await train(
      h,
      async () => {
        throw new Error('A second controller must not run the held proof');
      },
      releaseEvidence,
      {},
      'pump',
    );
    expect(ownerPaths.map((path) => readFileSync(join(path, readdirSync(path)[0]!), 'utf8'))).toEqual(owners);
    const product = h.dispatch('arrived-during-main.txt');
    await h.start(product);
    await schedulingUntil(() => h.head('dev') !== main);
    expect(existsSync(gateRelease)).toBe(false);
    expect(h.store.task(product.id).state).toBe('integrated');
    expect(h.head('main')).toBe(main);
    expect(h.head('stabilize')).toBe(main);
    await running;
    expect(pids.every((pid) => !commandAlive(pid))).toBe(true);
    expect(h.head(control.branch)).toBe(source);
    expect(h.store.attempt({ taskId: control.id, attempt: 1 }).result).toBe(workerEvidence);
    expect(h.store.task(control.id).state).toBe('landing');
    expect(h.queue.entry({ taskId: control.id, attempt: 1 })?.outcome).toBeNull();
    expect(h.outcomes.map((outcome) => outcome.taskId)).toEqual([product.id]);
    expect(smokeCalls).toBe(0);
    expect(releaseRecords(h)).toEqual([]);
    const interrupted = ordinaryProofs(h, entry.id).attempts[0]!;
    expect(interrupted).toMatchObject({ status: 'interrupted', source, candidate: expect.any(String) });
    expect(interrupted.outcome).toBeUndefined();
    expect(interrupted.reason).toContain('Product dev request');
    expect(readFileSync(interrupted.logPath, 'utf8')).toContain('proof remains non-green');
    expect(readFileSync(`${interrupted.logPath}.check-0`, 'utf8')).toContain('partial-proof-output');
    for (const path of ownerPaths) expect(existsSync(path)).toBe(false);

    const capturedDev = h.head('dev');
    const commands: string[][] = [];
    let publications = 0;
    // A later finite controller performs a fresh, complete proof for the changed dev capture.
    await train(
      h,
      async (command, cwd, log) => {
        commands.push([...command]);
        return success(command, cwd, log);
      },
      releaseEvidence,
      {
        beforePromotionAdvance() {
          publications++;
          expect([h.head('main'), h.head('stabilize'), h.head('dev')]).toEqual([main, main, capturedDev]);
        },
      },
    );
    expect(publications).toBe(1);
    expect(commands.filter(isFullControlPlaneSuite)).toHaveLength(1);
    expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
    expect(commands.some((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toBe(true);
    expect(releaseRecords(h)[0]).toMatchObject({ mainCommit: h.head('main'), devScriptTree: capturedDev });
    expect(h.head('main')).not.toBe(main);
    expect(git(h.root, 'merge-base', '--is-ancestor', capturedDev, 'dev')).toBe('');
    expect(git(h.root, 'merge-base', '--is-ancestor', h.head('main'), 'stabilize')).toBe('');
    expect(ordinaryProofs(h, entry.id).attempts.map((attempt) => attempt.status)).toEqual(['interrupted', 'finished']);
    expect(readFileSync(interrupted.logPath, 'utf8')).toContain('proof remains non-green');
    expect(h.head(control.branch)).toBe(source);
  } finally {
    writeFileSync(gateRelease, 'release fixture groups\n');
    await running?.catch(() => {});
    h.dispose();
  }
});

test('ordinary dev independence: startup backlog lands before main captures proof refs', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const control = dispatchControlPlane(h);
    const product = h.dispatch('startup-product.txt');
    await h.start(control);
    await h.start(product);
    let captured = '';
    await train(h, async (command, cwd, log) => {
      expect(h.store.task(product.id).state).toBe('integrated');
      captured = h.store.task(product.id).integratedCommit!;
      expect(h.head('dev')).toBe(captured);
      return success(command, cwd, log);
    });
    expect(h.outcomes.map((outcome) => outcome.taskId)).toEqual([product.id, control.id]);
    expect(releaseRecords(h)[0]?.devScriptTree).toBe(captured);
  } finally {
    h.dispose();
  }
});

test('ordinary dev independence: stale proof hands off without reusing partial evidence or taking a live dev lease', async () => {
  const h = integrationHarness();
  let current = true;
  let owner: ReturnType<typeof acquireDirectoryLease> | undefined;
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const main = h.head('main');
    const control = dispatchControlPlane(h);
    await h.start(control);
    const source = h.head(control.branch);
    const entry = h.queue.entry({ taskId: control.id, attempt: 1 })!;
    let handoffs = 0;
    await train(
      h,
      async (_command, _cwd, _log, options) => {
        current = false;
        await new Promise<void>((resolve) =>
          options!.signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { passed: true, output: 'partial immutable-tree evidence', timedOut: false };
      },
      releaseEvidence,
      {
        codeIsCurrent: () => current,
        handOff() {
          handoffs++;
        },
      },
    );
    expect(handoffs).toBe(1);
    expect([h.head('main'), h.head('dev'), h.head(control.branch)]).toEqual([main, main, source]);
    expect(h.outcomes).toEqual([]);
    expect(ordinaryProofs(h, entry.id).attempts[0]?.status).toBe('interrupted');
    // Model a controller exit between its running record and terminal journal write.
    const crashed = ordinaryProofs(h, entry.id);
    crashed.attempts[0]!.status = 'running';
    writeFileSync(join(h.settings.stateDirectory, `control-plane-proof-${entry.id}.json`), JSON.stringify(crashed));
    const path = join(h.settings.stateDirectory, 'train.lease');
    owner = acquireDirectoryLease(path);
    const files = readdirSync(path);
    const identity = readFileSync(join(path, files[0]!), 'utf8');
    await train(
      h,
      async () => {
        throw new Error('Restart cannot take live custody');
      },
      releaseEvidence,
      { controlPlaneDevLeaseTimeoutMs: 1 },
      'pump',
    );
    expect(readFileSync(join(path, files[0]!), 'utf8')).toBe(identity);
    owner.release();
    current = true;
    await train(h, async () => {
      throw new Error('Unchanged interrupted source and refs must not hot-loop');
    });
    expect(ordinaryProofs(h, entry.id).attempts).toHaveLength(1);
    expect(ordinaryProofs(h, entry.id).attempts[0]?.reason).toContain('Previous controller exited');
    expect(h.outcomes).toEqual([]);
    expect(releaseRecords(h)).toEqual([]);
    const product = h.dispatch('fresh-capture.txt');
    await h.start(product);
    await train(h);
    expect(h.store.task(control.id).state).toBe('merged');
    expect(h.head(control.branch)).toBe(source);
    expect(ordinaryProofs(h, entry.id).attempts).toHaveLength(2);
  } finally {
    owner?.release();
    h.dispose();
  }
});

test('ordinary dev independence: a launch assertion stays failed when product progress changes dev', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const main = h.head('main');
    const control = dispatchControlPlane(h);
    const product = h.dispatch('after-failed-launch.txt');
    await h.start(control);
    let launches = 0;
    const options: TrainOptions = {
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          h.outcomes.push(outcome);
        },
      },
      runGate: success,
      runLaunchSmoke: async () => {
        launches++;
        await h.start(product);
        return {
          passed: false,
          output: 'AssertionError: exact launch failure requiring a source fix',
          timedOut: false,
        };
      },
    };
    await new MergeTrain(options).run();
    expect(h.head('main')).toBe(main);
    expect(h.head('dev')).not.toBe(main);
    expect(h.outcomes.find((outcome) => outcome.taskId === control.id)).toMatchObject({
      passed: false,
      stage: 'gate',
      firstFailure: { assertion: expect.stringContaining('exact launch failure') },
    });
    expect(releaseRecords(h)).toEqual([]);
    await new MergeTrain(options).pump();
    expect(launches).toBe(1);
    expect(h.head('main')).toBe(main);
  } finally {
    h.dispose();
  }
});

test('ordinary dev independence: repeated interrupted admissions are finite across controllers', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const main = h.head('main');
    const control = dispatchControlPlane(h);
    await h.start(control);
    const entry = h.queue.entry({ taskId: control.id, attempt: 1 })!;
    const source = h.head(control.branch);
    let gateCalls = 0;
    for (let turn = 0; turn < 3; turn++) {
      let current = true;
      await train(
        h,
        async (_command, _cwd, _log, options) => {
          gateCalls++;
          current = false;
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { passed: true, output: '', timedOut: false };
        },
        releaseEvidence,
        { codeIsCurrent: () => current, handOff() {} },
      );
      expect(h.head('main')).toBe(main);
      const product = h.dispatch(`between-proofs-${turn}.txt`);
      await h.start(product);
    }
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          h.outcomes.push(outcome);
        },
      },
      runGate: async () => {
        throw new Error('Admission budget must stop unchanged source proofs');
      },
      runLaunchSmoke: releaseEvidence,
    }).pump();
    expect(gateCalls).toBe(3);
    expect(h.head('main')).toBe(main);
    expect(h.head(control.branch)).toBe(source);
    const proof = ordinaryProofs(h, entry.id);
    expect(proof.attempts).toHaveLength(3);
    expect(proof.attempts.every((attempt) => attempt.status === 'interrupted' && existsSync(attempt.logPath))).toBe(
      true,
    );
    expect(h.outcomes.find((outcome) => outcome.taskId === control.id)).toMatchObject({
      passed: false,
      firstFailure: { assertion: expect.stringContaining('owning source decision required') },
    });
    expect(releaseRecords(h)).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('ordinary dev independence: accepted source movement at publication cannot certify the old proof', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const main = h.head('main');
    const control = dispatchControlPlane(h);
    await h.start(control);
    const source = h.head(control.branch);
    let moved = '';
    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: {
        onGateOutcome(outcome) {
          h.outcomes.push(outcome);
        },
      },
      runGate: success,
      runLaunchSmoke: releaseEvidence,
      beforePromotionAdvance() {
        moved = addBranchCommit(h, control.branch, { 'tools/goal/src/moved-source.ts': 'later source\n' });
      },
    }).run();
    expect(moved).not.toBe(source);
    expect([h.head('main'), h.head('dev')]).toEqual([main, main]);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({
      passed: false,
      firstFailure: { assertion: expect.stringContaining('source ref changed during proof') },
    });
    expect(releaseRecords(h)).toEqual([]);
  } finally {
    h.dispose();
  }
});

import { agentAdapter, withAgentAdapter } from './agents.ts';
import { TrainResolver } from './train-resolver.ts';
import { controlPlaneBatchId } from './control-plane-batch.ts';
import type { LandingRequest } from './contracts.ts';

const semanticFile = 'tools/goal/src/semantic.ts';
const combinedSemantic = 'export const left = true;\nexport const right = true;\n';

async function semanticSources(h: ReturnType<typeof integrationHarness>) {
  mkdirSync(dirname(join(h.root, semanticFile)), { recursive: true });
  writeFileSync(join(h.root, semanticFile), 'export const left = false;\nexport const right = false;\n');
  git(h.root, 'add', '--', semanticFile);
  git(h.root, 'commit', '-m', 'Seed semantic composition fixture');
  h.ensureDev();
  const tasks = [dispatchControlPlane(h, semanticFile), dispatchControlPlane(h, semanticFile)];
  for (const [index, task] of tasks.entries()) {
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({
        file: semanticFile,
        content:
          index === 0
            ? 'export const left = true;\nexport const right = false;\n'
            : 'export const left = false;\nexport const right = true;\n',
      }),
    );
    await h.start(task);
  }
  return { tasks, manifest: acceptedBatch(h, tasks) };
}

function semanticTrain(h: ReturnType<typeof integrationHarness>, runGate: GateRunner = success) {
  return new MergeTrain({
    ...h.settings,
    queue: h.queue,
    fence: h.store,
    sink: {
      onGateOutcome(outcome) {
        h.outcomes.push(outcome);
        h.job.onGateOutcome(outcome);
      },
    },
    runGate,
    runLaunchSmoke: releaseEvidence,
    trainResolver: new TrainResolver(h.store, h.tasks),
  });
}

function managerSession(h: ReturnType<typeof integrationHarness>) {
  h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db
    .query('INSERT OR REPLACE INTO manager_sessions VALUES (?,?)')
    .run(
      'control-manager',
      JSON.stringify({ id: 'control-manager', kind: 'managed', status: 'running', threadId: 'cohort-owner-session' }),
    );
  return { CODEX_THREAD_ID: 'cohort-owner-session', GOAL_MANAGER: 'control-manager' };
}

function batchRuntime(h: ReturnType<typeof integrationHarness>, train = semanticTrain(h)) {
  return {
    store: h.store,
    queue: h.queue,
    train,
    landing(taskId: string): LandingRequest {
      const task = h.store.task(taskId);
      return {
        taskId,
        attempt: task.currentAttempt,
        branch: task.branch,
        worktree: task.worktree,
        declaredPaths: task.brief.paths,
        protectedPaths: h.tasks.protectedPaths(task.brief),
        gate: task.brief.acceptance.command,
      };
    },
  };
}

/** The pre-adapter controller's actual journal shape: exclusions left node.indices before any native proof. */
function preparationJournal(h: ReturnType<typeof integrationHarness>, manifest: ControlPlaneBatchManifest) {
  const batchId = controlPlaneBatchId(manifest);
  h.queue.claimControlPlaneBatch(batchId, manifest.members);
  const path = join(h.settings.stateDirectory, `control-plane-batch-${batchId}.json`);
  const logPath = join(h.settings.stateDirectory, `control-plane-batch-${batchId}-root.log`);
  const journal = {
    version: 1,
    batchId,
    manifest,
    nodes: { root: { indices: [] as number[], attempts: 1, logPath, completed: true } },
    results: manifest.members.map((member) => ({
      ...member,
      disposition: 'excluded',
      files: [semanticFile],
      logPath,
      reason: `Source ${member.acceptedCommit}: Error: Source merge conflicts: ${semanticFile}; owning manager must fix files`,
    })),
  };
  writeFileSync(path, JSON.stringify(journal));
  return { batchId, path, journal };
}

test('A main cohort uses the delivered bounded train resolver for real code conflicts and can re-admit only exact completed-preparation exclusions without worker retries or serial gates', async () => {
  const h = integrationHarness();
  try {
    const { tasks, manifest } = await semanticSources(h);
    const priorManifest = { ...manifest, members: [manifest.members[1]!] };
    const prior = preparationJournal(h, priorManifest);
    const priorBytes = readFileSync(prior.path, 'utf8');
    const adapterSource = dispatchControlPlane(h, 'tools/goal/src/cohort-adapter.ts');
    await h.start(adapterSource);
    const adapterMember = captureControlPlaneBatch(h.store, h.queue, 'control-manager').members.find(
      (member) => member.taskId === adapterSource.id,
    )!;
    requestManagerLanding(adapterSource.id, 'control-manager', h.store, h.queue, batchRuntime(h).landing);
    const next = {
      ...manifest,
      members: [manifest.members[0]!, { ...manifest.members[1]!, readmitFrom: prior.batchId }, adapterMember],
    };
    let calls = 0,
      suites = 0,
      compatibility = 0,
      typing = 0;
    const adapter = {
      ...agentAdapter('codex'),
      start(options: Parameters<ReturnType<typeof agentAdapter>['start']>[0]): [string, string[]] {
        calls++;
        expect(options.profile).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' });
        expect(options.consultation).toBe(true);
        const data = JSON.parse(options.prompt.split('\nDATA:\n')[1]!);
        expect(data.targetContracts).toContainEqual(
          expect.objectContaining({
            taskId: tasks[0]!.id,
            source: manifest.members[0]!.acceptedCommit,
            brief: tasks[0]!.brief.markdown,
          }),
        );
        expect(h.store.task(tasks[0]!.id).state).toBe('landing');
        return [
          process.execPath,
          [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(semanticFile)}, ${JSON.stringify(combinedSemantic)})`,
          ],
        ];
      },
    };
    const result = await withAgentAdapter(adapter, () =>
      receiveControlPlaneBatch(
        next,
        batchRuntime(
          h,
          semanticTrain(h, async (command, cwd) => {
            if (isFullControlPlaneSuite(command)) {
              suites++;
              expect(readFileSync(join(cwd, semanticFile), 'utf8')).toBe(combinedSemantic);
              expect(existsSync(join(cwd, adapterSource.brief.paths[0]!))).toBe(true);
            }
            if (command.includes('typecheck')) typing++;
            if (command.includes('tools/goal/scripts/check-compatibility.ts')) compatibility++;
            return { passed: true, output: '', timedOut: false };
          }),
        ),
        managerSession(h),
      ),
    );
    await h.job.drain();
    expect([calls, suites, typing, compatibility]).toEqual([1, 1, 1, 1]);
    expect(result.members.every((member) => member.disposition === 'released')).toBe(true);
    expect(h.outcomes).toHaveLength(3);
    expect(readFileSync(prior.path, 'utf8')).toBe(priorBytes);
    for (const task of [...tasks, adapterSource]) expect(h.store.task(task.id).currentAttempt).toBe(1);
    const claims = h.store.db
      .query('SELECT batch, previous_batch FROM landing_batch_claims WHERE task=?')
      .all(tasks[1]!.id);
    expect(claims).toContainEqual({ batch: prior.batchId, previous_batch: null });
    expect(claims).toContainEqual({ batch: result.batchId, previous_batch: prior.batchId });
    expect(h.queue.nextBatch(20)).toEqual([]);
    const replay = await receiveControlPlaneBatch(
      next,
      batchRuntime(
        h,
        semanticTrain(h, async () => {
          throw new Error('Published readmission must recover without new checks');
        }),
      ),
      managerSession(h),
    );
    expect(replay).toEqual(result);
  } finally {
    h.dispose();
  }
}, 30_000);

test('the delivered resolver refuses frozen conflicts and wrong accepted source before calling its adapter', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    const tree = join(h.settings.worktreeRoot, 'guarded-resolver');
    const request = h.queue.entry(manifest.members[1]!)!.request;
    git(h.root, 'worktree', 'add', '--detach', tree, manifest.members[0]!.acceptedCommit);
    const log = join(h.settings.stateDirectory, 'guarded-resolver.log');
    let calls = 0;
    await withAgentAdapter(
      {
        ...agentAdapter('codex'),
        start() {
          calls++;
          throw new Error('Forbidden adapter call');
        },
      },
      async () => {
        const resolver = new TrainResolver(h.store, h.tasks);
        const refused = await resolver.compose(
          request,
          tree,
          manifest.members[0]!.acceptedCommit,
          'refs/heads/main',
          manifest.members[1]!.acceptedCommit,
          [semanticFile],
          log,
        );
        expect(refused?.resolvedCommit).toBeUndefined();
        expect(refused?.detail).toContain('frozen or protected');
        git(tree, 'merge', '--abort');
        await expect(
          resolver.compose(
            {
              ...request,
              managerLanding: { ...request.managerLanding!, acceptedCommit: manifest.members[0]!.acceptedCommit },
            },
            tree,
            manifest.members[0]!.acceptedCommit,
            'refs/heads/main',
            manifest.members[1]!.acceptedCommit,
            [],
            log,
          ),
        ).rejects.toThrow('accepted landing request');
      },
    );
    expect(calls).toBe(0);
  } finally {
    h.dispose();
  }
}, 30_000);

test('the real resolver receipt refuses index tampering and leaves an explicit source exclusion', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    let calls = 0,
      suites = 0;
    const result = await withAgentAdapter(
      {
        ...agentAdapter('codex'),
        start(): [string, string[]] {
          calls++;
          return [
            process.execPath,
            [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(semanticFile)}, ${JSON.stringify(combinedSemantic)}); require('node:child_process').spawnSync('git',['add','--',${JSON.stringify(semanticFile)}]);`,
            ],
          ];
        },
      },
      () =>
        semanticTrain(h, async (command) => {
          if (isFullControlPlaneSuite(command)) suites++;
          return { passed: true, output: '', timedOut: false };
        }).releaseControlPlaneBatch(manifest),
    );
    expect([calls, suites]).toEqual([1, 1]);
    expect(result.members.map((member) => member.disposition)).toEqual(['released', 'excluded']);
    expect(result.members[1]).toMatchObject({
      phase: 'preparation',
      acceptedCommit: manifest.members[1]!.acceptedCommit,
      files: [semanticFile],
    });
    expect(result.members[1]!.reason).toContain('refs or index');
    expect(h.store.events(manifest.members[1]!.taskId, 1).some((event) => event.kind === 'train-resolution')).toBe(
      false,
    );
  } finally {
    h.dispose();
  }
}, 30_000);

test('only actual typing diagnostics permit one bounded compiler repair before the one final-head suite', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    let calls = 0,
      typing = 0,
      suites = 0;
    const result = await withAgentAdapter(
      {
        ...agentAdapter('codex'),
        start(options): [string, string[]] {
          calls++;
          const content =
            calls === 1
              ? combinedSemantic + 'const integration: number = "broken";\n'
              : combinedSemantic + 'const integration: number = 1;\n';
          if (calls === 2) expect(options.prompt).toContain('error TS2322');
          return [
            process.execPath,
            ['-e', `require('node:fs').writeFileSync(${JSON.stringify(semanticFile)}, ${JSON.stringify(content)})`],
          ];
        },
      },
      () =>
        semanticTrain(h, async (command, cwd) => {
          if (command.includes('typecheck')) {
            typing++;
            if (typing === 1)
              return {
                passed: false,
                timedOut: false,
                output: `${semanticFile}(3,7): error TS2322: Type 'string' is not assignable to type 'number'.`,
              };
          }
          if (isFullControlPlaneSuite(command)) {
            suites++;
            expect(readFileSync(join(cwd, semanticFile), 'utf8')).toContain('integration: number = 1');
          }
          return { passed: true, output: '', timedOut: false };
        }).releaseControlPlaneBatch(manifest),
    );
    expect([calls, typing, suites]).toEqual([2, 2, 1]);
    expect(result.members.every((member) => member.mergedCommit === h.head('main'))).toBe(true);
    expect(
      h.store.events(manifest.members[1]!.taskId, 1).filter((event) => event.kind === 'train-resolver-started'),
    ).toHaveLength(2);
  } finally {
    h.dispose();
  }
}, 30_000);

test('readmission refuses an active prior controller or nonterminal journal without releasing any claim', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    const prior = preparationJournal(h, { ...manifest, members: [manifest.members[1]!] });
    const next = {
      ...manifest,
      members: [manifest.members[0]!, { ...manifest.members[1]!, readmitFrom: prior.batchId }],
    };
    const env = managerSession(h);
    const runtime = batchRuntime(
      h,
      semanticTrain(h, async () => {
        throw new Error('No native work during refusal');
      }),
    );
    const lease = acquireDirectoryLease(join(h.settings.stateDirectory, 'train-main.lease'));
    try {
      await expect(receiveControlPlaneBatch(next, runtime, env)).rejects.toThrow('Lease held');
    } finally {
      lease.release();
    }
    prior.journal.nodes.root.completed = false;
    writeFileSync(prior.path, JSON.stringify(prior.journal));
    await expect(receiveControlPlaneBatch(next, runtime, env)).rejects.toThrow('terminal');
    expect(h.queue.entry(manifest.members[0]!)?.batchId).toBeNull();
    expect(h.queue.entry(manifest.members[1]!)?.batchId).toBe(prior.batchId);
  } finally {
    h.dispose();
  }
}, 30_000);

test('readmission refuses wrong owners, worker sessions, changed contracts, sources and attempts', async () => {
  const h = integrationHarness();
  try {
    const { manifest, tasks } = await semanticSources(h);
    const prior = preparationJournal(h, { ...manifest, members: [manifest.members[1]!] });
    const next = { ...manifest, members: [{ ...manifest.members[1]!, readmitFrom: prior.batchId }] };
    const runtime = batchRuntime(
      h,
      semanticTrain(h, async () => {
        throw new Error('No native work during refusal');
      }),
    );
    const env = managerSession(h);
    await expect(receiveControlPlaneBatch({ ...next, managerId: 'another-owner' }, runtime, env)).rejects.toThrow(
      'authenticated',
    );
    await expect(receiveControlPlaneBatch(next, runtime, { ...env, GOAL_TASK_ID: tasks[1]!.id })).rejects.toThrow(
      'authenticated',
    );
    await expect(
      receiveControlPlaneBatch({ ...next, members: [{ ...next.members[0]!, attempt: 2 }] }, runtime, env),
    ).rejects.toThrow('stale');
    await expect(
      receiveControlPlaneBatch(
        { ...next, members: [{ ...next.members[0]!, acceptedCommit: manifest.members[0]!.acceptedCommit }] },
        runtime,
        env,
      ),
    ).rejects.toThrow('source moved');
    h.store.updateTask(manifest.members[1]!, (task) => {
      task.brief.markdown += '\nChanged ownership contract\n';
    });
    await expect(receiveControlPlaneBatch(next, runtime, env)).rejects.toThrow('generation');
    expect(h.queue.entry(manifest.members[1]!)?.batchId).toBe(prior.batchId);
  } finally {
    h.dispose();
  }
}, 30_000);

test('native assertion failures and any candidate, outcome or delivered row cannot be readmitted as preparation exclusions', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatchControlPlane(h);
    await h.start(task);
    const manifest = acceptedBatch(h, [task]);
    const failed = await batchTrain(h, async (command) => ({
      passed: !isFullControlPlaneSuite(command),
      output: 'native assertion failed',
      timedOut: false,
    })).releaseControlPlaneBatch(manifest);
    expect(failed.members[0]?.disposition).toBe('excluded');
    const next = { ...manifest, members: [{ ...manifest.members[0]!, readmitFrom: failed.batchId }] };
    const env = managerSession(h);
    await expect(receiveControlPlaneBatch(next, batchRuntime(h), env)).rejects.toThrow('preparation-only');
    expect(h.queue.entry(manifest.members[0]!)?.batchId).toBe(failed.batchId);
  } finally {
    h.dispose();
  }
  for (const mutation of ['candidate', 'outcome', 'delivered'] as const) {
    const fixture = integrationHarness();
    try {
      const { manifest } = await semanticSources(fixture);
      const member = manifest.members[1]!;
      const prior = preparationJournal(fixture, { ...manifest, members: [member] });
      const entry = fixture.queue.entry(member)!;
      if (mutation === 'candidate') fixture.queue.candidate(entry.id, member.acceptedCommit);
      if (mutation === 'outcome')
        fixture.queue.finish(entry.id, {
          ...member,
          passed: false,
          stage: 'gate',
          logPath: 'native.log',
          hostMs: 0,
          changedFiles: [],
          diffLines: 0,
        });
      if (mutation === 'delivered') fixture.queue.acknowledge(entry.id);
      await expect(
        receiveControlPlaneBatch(
          { ...manifest, members: [{ ...member, readmitFrom: prior.batchId }] },
          batchRuntime(fixture),
          managerSession(fixture),
        ),
      ).rejects.toThrow();
      expect(fixture.queue.entry(member)?.batchId).toBe(prior.batchId);
    } finally {
      fixture.dispose();
    }
  }
}, 30_000);

test('a preparation exclusion after earlier native participation cannot erase that native history', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    const member = manifest.members[1]!;
    const prior = preparationJournal(h, { ...manifest, members: [member] });
    // A ref-rebuild can later exclude a previously checked row; the durable native set must still refuse it.
    writeFileSync(
      prior.path,
      JSON.stringify({
        ...prior.journal,
        nodes: { root: { ...prior.journal.nodes.root, nativeMembers: [0] } },
        results: prior.journal.results.map((result) => ({ ...result, phase: 'preparation' })),
      }),
    );
    await expect(
      receiveControlPlaneBatch(
        { ...manifest, members: [{ ...member, readmitFrom: prior.batchId }] },
        batchRuntime(h),
        managerSession(h),
      ),
    ).rejects.toThrow('preparation-only');
    expect(h.queue.entry(member)?.batchId).toBe(prior.batchId);
    expect(h.queue.entry(manifest.members[0]!)?.batchId).toBeNull();
  } finally {
    h.dispose();
  }
}, 30_000);

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { processIdentity, type ProcessIdentity } from './process.ts';
import { receiveControlPlaneBatchSupersession } from './control-plane-batch.ts';
import type { ControlPlaneBatchSupersession } from './contracts.ts';

type RecoveryJournal = {
  controller?: ProcessIdentity;
  nodes: Record<
    string,
    {
      indices: number[];
      attempts: number;
      failure?: string;
      completed?: boolean;
      proofs: {
        candidate: string;
        result: { passed: boolean; negativeOnly?: boolean; failedCommand?: string[]; output: string };
      }[];
    }
  >;
  results: { disposition: string }[];
  superseded?: { status: string };
};

function cohortJournal(h: ReturnType<typeof integrationHarness>, manifest: ControlPlaneBatchManifest) {
  const path = join(h.settings.stateDirectory, `control-plane-batch-${controlPlaneBatchId(manifest)}.json`);
  return { path, value: JSON.parse(readFileSync(path, 'utf8')) as RecoveryJournal };
}

test('a failed native proof is durable and classified before moved refs and survives interruption before splitting', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = dispatchControlPlane(h);
    await h.start(task);
    const manifest = acceptedBatch(h, [task]);
    const main = h.head('main');
    let suites = 0;
    const result = await batchTrain(h, async (command) => {
      if (!isFullControlPlaneSuite(command)) return success(command, h.root, '');
      suites++;
      addBranchCommit(h, 'dev', { 'moved-during-failed-proof.txt': 'independent dev change\n' });
      return { passed: false, timedOut: false, output: 'retained native assertion failure\n' };
    }).releaseControlPlaneBatch(manifest);
    expect(suites).toBe(1);
    expect(h.head('main')).toBe(main);
    expect(result.members[0]).toMatchObject({ disposition: 'excluded', phase: 'native' });
    const journal = cohortJournal(h, manifest);
    const root = journal.value.nodes.root!;
    expect(root.attempts).toBe(1);
    expect(root.proofs).toHaveLength(1);
    expect(root.proofs[0]!.result).toMatchObject({
      passed: false,
      failedCommand: ['bun', 'test', '--timeout', '30000', 'tools/goal/src'],
      output: 'retained native assertion failure\n',
    });
    expect(git(h.root, 'rev-parse', `refs/goal/control-plane-proof/${controlPlaneBatchId(manifest)}/root/1`)).toBe(
      root.proofs[0]!.candidate,
    );
    // Model the crash window after the durable proof and before its split/disposition writes.
    delete root.failure;
    journal.value.results = [];
    writeFileSync(journal.path, JSON.stringify(journal.value));
    const replay = await batchTrain(h, async () => {
      throw new Error('A completed negative must not run unchanged again');
    }).releaseControlPlaneBatch(manifest);
    expect(replay).toEqual(result);
    expect(h.queue.entry(manifest.members[0]!)?.outcome).toBeNull();
  } finally {
    h.dispose();
  }
}, 30_000);

for (const probeFails of [false, true])
  test(`bisection file probes are negative-only when the probe ${probeFails ? 'fails' : 'passes'}`, async () => {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const suspect = 'tools/goal/src/negative-probe.test.ts';
      const tasks = [dispatchControlPlane(h, suspect), dispatchControlPlane(h, 'tools/goal/src/independent-probe.ts')];
      for (const task of tasks) await h.start(task);
      const manifest = acceptedBatch(h, tasks);
      let fulls = 0,
        probes = 0,
        compatibility = 0;
      const result = await batchTrain(h, async (command, cwd) => {
        if (command.includes('tools/goal/scripts/check-compatibility.ts')) compatibility++;
        if (isFullControlPlaneSuite(command)) {
          fulls++;
          return {
            passed: !existsSync(join(cwd, suspect)),
            timedOut: false,
            output: `${suspect}:\n(fail) retained failing case\n`,
          };
        }
        if (command[0] === 'bun' && command[1] === 'test') {
          probes++;
          expect(command).toEqual(['bun', 'test', '--timeout', '30000', suspect]);
          return { passed: !probeFails, timedOut: false, output: 'focused negative observation\n' };
        }
        return { passed: true, timedOut: false, output: '' };
      }).releaseControlPlaneBatch(manifest);
      expect([fulls, probes, compatibility]).toEqual([probeFails ? 2 : 3, 1, 1]);
      expect(result.members.find((member) => member.taskId === tasks[0]!.id)).toMatchObject({
        disposition: 'excluded',
        phase: 'native',
      });
      expect(result.members.find((member) => member.taskId === tasks[1]!.id)).toMatchObject({
        disposition: 'released',
        mergedCommit: h.head('main'),
      });
      const journal = cohortJournal(h, manifest).value;
      expect(journal.nodes['root-left']!.proofs[0]!.result.negativeOnly).toBe(probeFails ? true : undefined);
      expect(h.outcomes).toHaveLength(1);
    } finally {
      h.dispose();
    }
  }, 30_000);

/** An actual process incarnation that has exited; no live operation or fabricated physical receipt. */
async function exitedController(): Promise<ProcessIdentity> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `import { processIdentity } from ${JSON.stringify(join(import.meta.dir, 'process.ts'))}; console.log(JSON.stringify(processIdentity()));`,
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code).toBe(0);
  return JSON.parse(output.trim()) as ProcessIdentity;
}

async function interruptedCohort(h: ReturnType<typeof integrationHarness>, publish = false) {
  h.ensureDev();
  const source = dispatchControlPlane(h, 'tools/goal/src/interrupted-source.ts');
  await h.start(source);
  const prior = acceptedBatch(h, [source]);
  await batchTrain(h, async (command) => ({
    passed: publish || !isFullControlPlaneSuite(command),
    timedOut: false,
    output: !publish && isFullControlPlaneSuite(command) ? 'actual retained negative on old combined head\n' : '',
  })).releaseControlPlaneBatch(prior);
  const journal = cohortJournal(h, prior);
  journal.value.controller = await exitedController();
  delete journal.value.nodes.root!.failure;
  writeFileSync(journal.path, JSON.stringify(journal.value));
  const producer = dispatchControlPlane(h, 'tools/goal/src/omitted-producer-fix.ts');
  await h.start(producer);
  const fresh = acceptedBatch(h, [producer]);
  const replacement = { ...prior, members: [...prior.members, ...fresh.members] };
  const input: ControlPlaneBatchSupersession = {
    version: 1,
    previousBatchId: controlPlaneBatchId(prior),
    replacement,
    handoff: {
      journalHash: createHash('sha256').update(readFileSync(journal.path)).digest('hex'),
      controller: journal.value.controller,
      ownedCommands: [],
      evidence: 'fixture: exited controller and empty owned-command inventory',
    },
    changedInputs: [
      {
        taskId: producer.id,
        path: producer.brief.paths[0]!,
        reason: 'Adds omitted producer required by the old source',
      },
    ],
  };
  return { prior, journal, producer, input, env: managerSession(h) };
}

test('owner supersession retains the old negative and transfers exact claims to a changed cohort needing a fresh complete proof', async () => {
  const h = integrationHarness();
  try {
    const { prior, journal, input, env } = await interruptedCohort(h);
    const oldProof = journal.value.nodes.root!.proofs[0]!;
    const oldResults = journal.value.results;
    const oldAttempt = h.store.attempt(prior.members[0]!).result;
    const oldMain = h.head('main');
    const runtime = batchRuntime(
      h,
      batchTrain(h, async () => {
        throw new Error('Supersession never runs a gate');
      }),
    );
    const transferred = await receiveControlPlaneBatchSupersession(input, runtime, env);
    expect(transferred).toMatchObject({
      status: 'superseded/interrupted',
      replacementBatchId: controlPlaneBatchId(input.replacement),
      members: [{ ...prior.members[0]!, disposition: 'failed' }],
    });
    expect(h.head('main')).toBe(oldMain);
    const closed = JSON.parse(readFileSync(journal.path, 'utf8')) as RecoveryJournal;
    expect(closed.nodes.root!.proofs[0]).toEqual(oldProof);
    expect(closed.results).toEqual(oldResults);
    expect(closed.superseded?.status).toBe('superseded/interrupted');
    for (const member of input.replacement.members)
      expect(h.queue.entry(member)).toMatchObject({
        batchId: transferred.replacementBatchId,
        outcome: null,
        candidate: null,
        delivered: 0,
      });
    expect(h.queue.controlPlaneSupersession(input.previousBatchId)).toBeTruthy();
    expect(await receiveControlPlaneBatchSupersession(input, runtime, env)).toEqual(transferred);
    await expect(batchTrain(h).releaseControlPlaneBatch(prior)).rejects.toThrow('superseded/interrupted');
    const commands: string[][] = [];
    const result = await receiveControlPlaneBatch(
      input.replacement,
      batchRuntime(
        h,
        batchTrain(h, async (command, cwd) => {
          commands.push([...command]);
          if (isFullControlPlaneSuite(command)) expect(git(cwd, 'rev-parse', 'HEAD')).not.toBe(oldProof.candidate);
          return { passed: true, output: '', timedOut: false };
        }),
      ),
      env,
    );
    expect(commands.filter(isFullControlPlaneSuite)).toHaveLength(1);
    expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
    expect(commands.some((command) => command.includes('tools/goal/scripts/check-compatibility.ts'))).toBe(true);
    expect(result.members.every((member) => member.disposition === 'released')).toBe(true);
    expect(h.store.attempt(prior.members[0]!).result).toBe(oldAttempt);
    expect((JSON.parse(readFileSync(journal.path, 'utf8')) as RecoveryJournal).nodes.root!.proofs[0]).toEqual(oldProof);
    expect(
      h.store.db
        .query('SELECT COUNT(*) AS n FROM landing_batch_claims WHERE task=? AND attempt=?')
        .get(prior.members[0]!.taskId, 1),
    ).toEqual({ n: 2 });
  } finally {
    h.dispose();
  }
}, 30_000);

for (const refusal of [
  'active-controller',
  'active-command',
  'active-lease',
  'stale-journal',
  'stale-generation',
  'unchanged-input',
  'other-claim',
] as const)
  test(`supersession refuses ${refusal} without closing a journal or releasing a claim`, async () => {
    const h = integrationHarness();
    try {
      const { prior, journal, input, env } = await interruptedCohort(h);
      const oldBytes = readFileSync(journal.path, 'utf8');
      let lease: ReturnType<typeof acquireDirectoryLease> | undefined;
      if (refusal === 'active-controller') input.handoff.controller = processIdentity()!;
      if (refusal === 'active-command') input.handoff.ownedCommands = [processIdentity()!];
      if (refusal === 'active-lease')
        lease = acquireDirectoryLease(join(h.settings.stateDirectory, 'train-main.lease'));
      if (refusal === 'stale-journal') input.handoff.journalHash = '0'.repeat(64);
      if (refusal === 'stale-generation')
        input.replacement = {
          ...input.replacement,
          members: input.replacement.members.map((member, index) => (index === 0 ? { ...member, attempt: 2 } : member)),
        };
      if (refusal === 'unchanged-input')
        input.changedInputs = [{ ...input.changedInputs[0]!, path: 'tools/goal/src/absent.ts' }];
      if (refusal === 'other-claim') h.queue.claimControlPlaneBatch('a'.repeat(64), [input.replacement.members[1]!]);
      try {
        await expect(receiveControlPlaneBatchSupersession(input, batchRuntime(h), env)).rejects.toThrow();
      } finally {
        lease?.release();
      }
      expect(readFileSync(journal.path, 'utf8')).toBe(oldBytes);
      expect(h.queue.entry(prior.members[0]!)?.batchId).toBe(controlPlaneBatchId(prior));
      expect(h.queue.controlPlaneSupersession(input.previousBatchId)).toBeUndefined();
    } finally {
      h.dispose();
    }
  }, 30_000);

import {
  controlPlaneScopeApproval,
  controlPlaneScopeApprovalIdentity,
  parseControlPlaneScopeApproval,
  receiveControlPlaneScopeApproval,
} from './control-plane-batch.ts';
import type { ControlPlaneScopeApprovalRequest } from './contracts.ts';

const approvedCustodyFiles = ['tools/goal/src/lease.ts', 'tools/goal/src/process.ts', 'tools/goal/src/tasks.ts'];

async function scopeApprovalSource(h: ReturnType<typeof integrationHarness>) {
  h.ensureDev();
  const task = dispatchControlPlane(h, 'tools/goal/src/publication.ts');
  for (const file of approvedCustodyFiles) writeFileSync(join(task.worktree, file), 'export const custody = true;\n');
  // The fixture worker commits these staged producer edits together with its declared implementation.
  git(task.worktree, 'add', '--', ...approvedCustodyFiles);
  await h.start(task);
  const manifest = acceptedBatch(h, [task]);
  const source = manifest.members[0]!;
  const runtime = batchRuntime(h);
  const input: ControlPlaneScopeApprovalRequest = {
    version: 1,
    managerId: manifest.managerId,
    ...source,
    ...controlPlaneScopeApprovalIdentity(source, runtime),
    additionalPaths: approvedCustodyFiles.map((path) => ({
      path,
      reason: 'Required for accepted publication custody',
    })),
  };
  return { task, manifest, source, runtime, input, env: managerSession(h) };
}

test('native owner scope approval is exact, immutable and separate from worker contract, queue and acceptance history', async () => {
  const h = integrationHarness();
  try {
    const { source, runtime, input, env } = await scopeApprovalSource(h);
    const oldTask = h.store.task(source.taskId);
    const oldAttempt = h.store.attempt(source);
    const rawQueue = () =>
      h.store.db.query('SELECT * FROM landing_queue WHERE task=? AND attempt=?').get(source.taskId, source.attempt);
    const queue = rawQueue();
    const events = h.store.events(source.taskId, source.attempt);
    // A generic event, including one written by a worker, cannot manufacture native scope authority.
    h.store.event(source, 'control-plane-scope-approved', {
      ...input,
      actor: { managerId: input.managerId, sessionId: env.CODEX_THREAD_ID },
    });
    expect(controlPlaneScopeApproval(source, runtime)).toBeUndefined();
    const receipt = receiveControlPlaneScopeApproval(parseControlPlaneScopeApproval(input), runtime, env);
    expect(receipt.actor).toEqual({ managerId: input.managerId, sessionId: env.CODEX_THREAD_ID });
    expect(receipt.additionalPaths.map((addition) => addition.path)).toEqual(approvedCustodyFiles);
    expect(controlPlaneScopeApproval(source, runtime)).toEqual(receipt);
    expect(receiveControlPlaneScopeApproval(input, runtime, env)).toEqual(receipt);
    expect(() =>
      receiveControlPlaneScopeApproval({ ...input, additionalPaths: [input.additionalPaths[0]!] }, runtime, env),
    ).toThrow('Conflicting immutable');
    expect(() =>
      h.store.db.query('UPDATE landing_scope_approvals SET body=? WHERE task=?').run('{}', source.taskId),
    ).toThrow('immutable');
    expect(h.store.task(source.taskId)).toEqual(oldTask);
    expect(h.store.attempt(source)).toEqual(oldAttempt);
    expect(rawQueue()).toEqual(queue);
    expect(h.store.events(source.taskId, source.attempt).slice(0, events.length)).toEqual(events);
    expect(h.store.events(source.taskId, source.attempt)).toHaveLength(events.length + 2);
    expect(releaseRecords(h)).toHaveLength(0);
  } finally {
    h.dispose();
  }
}, 30_000);

test('scope receiving refuses unauthenticated, worker, foreign, stale, wrong-source and malformed authority', async () => {
  const h = integrationHarness();
  try {
    const { input, runtime, env, source, task } = await scopeApprovalSource(h);
    const attempts: [ControlPlaneScopeApprovalRequest, NodeJS.ProcessEnv][] = [
      [input, {}],
      [input, { GOAL_MANAGER: input.managerId }],
      [input, { ...env, GOAL_TASK_ID: source.taskId, GOAL_ATTEMPT: String(source.attempt) }],
      [{ ...input, managerId: 'foreign-owner' }, env],
      [{ ...input, attempt: source.attempt + 1 }, env],
      [{ ...input, acceptedCommit: h.head('main') }, env],
      [{ ...input, contractIdentity: '0'.repeat(64) }, env],
      [{ ...input, requestIdentity: '0'.repeat(64) }, env],
      ...[
        'tools/goal/**',
        'services/kernel/src/file.ts',
        'tools/goal/../file.ts',
        '/tools/goal/src/file.ts',
        'tools/goal/src',
        'tools/goal/src/missing.ts',
      ].map(
        (path) =>
          [{ ...input, additionalPaths: [{ path, reason: 'Cannot grant this scope' }] }, env] as [
            ControlPlaneScopeApprovalRequest,
            NodeJS.ProcessEnv,
          ],
      ),
    ];
    for (const [request, session] of attempts)
      expect(() => receiveControlPlaneScopeApproval(request, runtime, session)).toThrow();
    // A changed current brief invalidates an approval captured against its earlier immutable contract.
    h.store.updateTask(source, (current) => {
      current.brief = { ...current.brief, markdown: current.brief.markdown + '\nChanged contract.\n' };
    });
    expect(() => receiveControlPlaneScopeApproval(input, runtime, env)).toThrow('identity changed');
    h.store.updateTask(source, (current) => {
      current.brief = task.brief;
    });
    writeFileSync(join(task.worktree, approvedCustodyFiles[0]!), 'unaccepted dirty edit\n');
    expect(() => receiveControlPlaneScopeApproval(input, runtime, env)).toThrow('clean worktree');
    expect(controlPlaneScopeApproval(source, runtime)).toBeUndefined();
  } finally {
    h.dispose();
  }
}, 30_000);

test('scope approval cannot grant frozen or protected files, processed requests or another Goal', async () => {
  const h = integrationHarness();
  try {
    const { input, runtime, env, source, task } = await scopeApprovalSource(h);
    h.store.updateTask(source, (current) => {
      (current as Task & { frozenFiles: { path: string; hash: string }[] }).frozenFiles = [
        { path: approvedCustodyFiles[0]!, hash: 'retained-frozen-hash' },
      ];
    });
    expect(() =>
      receiveControlPlaneScopeApproval(
        { ...input, ...controlPlaneScopeApprovalIdentity(source, runtime) },
        runtime,
        env,
      ),
    ).toThrow('frozen or protected');
    h.store.updateTask(source, (current) => {
      delete (current as Task & { frozenFiles?: unknown }).frozenFiles;
    });
    const risk = join(h.settings.stateDirectory, 'scope-risk.json');
    writeFileSync(risk, JSON.stringify({ version: 1, areas: { custody: [approvedCustodyFiles[0]] } }));
    expect(() => receiveControlPlaneScopeApproval(input, { ...runtime, riskAreasFile: risk }, env)).toThrow(
      'frozen or protected',
    );
    h.store.updateTask(source, (current) => {
      current.brief = { ...current.brief, goal: 'foreign-goal' };
    });
    expect(() => receiveControlPlaneScopeApproval(input, runtime, env)).toThrow('control-plane main source');
    h.store.updateTask(source, (current) => {
      current.brief = task.brief;
    });
    const entry = h.queue.entry(source)!;
    h.queue.candidate(entry.id, source.acceptedCommit);
    expect(() => receiveControlPlaneScopeApproval(input, runtime, env)).toThrow('unprocessed, unpublished');
    expect(controlPlaneScopeApproval(source, runtime)).toBeUndefined();
  } finally {
    h.dispose();
  }
}, 30_000);

for (const proof of ['full-pass', 'native-failure', 'audit-tamper-at-publication'] as const)
  test(`exact additional scope still requires full native proof and unchanged final fences: ${proof}`, async () => {
    const h = integrationHarness();
    try {
      const { source, manifest, runtime, input, env } = await scopeApprovalSource(h);
      const receipt = receiveControlPlaneScopeApproval(input, runtime, env);
      const before = h.head('main');
      const commands: string[][] = [];
      const native = batchTrain(
        h,
        async (command) => {
          commands.push([...command]);
          return {
            passed: proof !== 'native-failure' || !isFullControlPlaneSuite(command),
            timedOut: false,
            output: 'Actual fixture native command output\n',
          };
        },
        proof === 'audit-tamper-at-publication'
          ? {
              beforeIntegrationAdvance() {
                h.store.db
                  .query('UPDATE worker_events SET body=? WHERE task_id=? AND kind=?')
                  .run('{}', source.taskId, 'control-plane-scope-approved');
              },
            }
          : {},
      );
      if (proof === 'audit-tamper-at-publication') {
        await expect(receiveControlPlaneBatch(manifest, batchRuntime(h, native), env)).rejects.toThrow('audit changed');
        expect(h.head('main')).toBe(before);
        return;
      }
      const result = await receiveControlPlaneBatch(manifest, batchRuntime(h, native), env);
      expect(commands.filter(isFullControlPlaneSuite)).toHaveLength(1);
      expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
      const journal = JSON.parse(
        readFileSync(join(h.settings.stateDirectory, `control-plane-batch-${result.batchId}.json`), 'utf8'),
      );
      expect(journal.scopeApprovals[source.taskId]).toEqual(receipt);
      expect(journal.nodes.root.proofs[0].scopeApprovals[source.taskId]).toBe(receipt.id);
      if (proof === 'native-failure') {
        expect(result.members[0]).toMatchObject({ disposition: 'excluded', phase: 'native' });
        expect(h.head('main')).toBe(before);
        expect(journal.nodes.root.proofs[0].result.passed).toBe(false);
      } else {
        expect(result.members[0]?.disposition).toBe('released');
        expect(commands.some((command) => command.includes('tools/goal/scripts/check-compatibility.ts'))).toBe(true);
        expect(releaseRecords(h)[0]?.scopeApprovals).toEqual({ [source.taskId]: receipt.id });
        for (const file of approvedCustodyFiles)
          expect(git(h.root, 'show', `main:${file}`)).toBe('export const custody = true;');
        // Approval is bound to this exact source, not the path or owning manager globally.
        const unrelated = dispatchControlPlane(h, 'tools/goal/src/another-publication.ts');
        writeFileSync(join(unrelated.worktree, approvedCustodyFiles[0]!), 'export const unrelated = true;\n');
        git(unrelated.worktree, 'add', '--', approvedCustodyFiles[0]!);
        await h.start(unrelated);
        const next = acceptedBatch(h, [unrelated]);
        const unapproved = await receiveControlPlaneBatch(
          next,
          batchRuntime(
            h,
            batchTrain(h, async () => {
              throw new Error('An unapproved source must not reach native proof');
            }),
          ),
          env,
        );
        expect(unapproved.members[0]).toMatchObject({ disposition: 'excluded', phase: 'preparation' });
        expect(unapproved.members[0]?.reason).toContain('scope approval');
      }
    } finally {
      h.dispose();
    }
  }, 30_000);

test('supersession refuses published cohorts and other owners while preserving their native outcomes', async () => {
  const h = integrationHarness();
  try {
    const { prior, journal, input, env } = await interruptedCohort(h, true);
    const outcome = h.queue.entry(prior.members[0]!)!.outcome;
    expect(outcome?.passed).toBe(true);
    const old = readFileSync(journal.path, 'utf8');
    await expect(
      receiveControlPlaneBatchSupersession(
        { ...input, replacement: { ...input.replacement, managerId: 'another-owner' } },
        batchRuntime(h),
        env,
      ),
    ).rejects.toThrow('authenticated');
    await expect(receiveControlPlaneBatchSupersession(input, batchRuntime(h), env)).rejects.toThrow('published');
    expect(h.queue.entry(prior.members[0]!)?.outcome).toEqual(outcome);
    expect(readFileSync(journal.path, 'utf8')).toBe(old);
    expect(h.queue.controlPlaneSupersession(input.previousBatchId)).toBeUndefined();
  } finally {
    h.dispose();
  }
}, 30_000);

test('supersession accepts omitted old producer inputs, keeps unknown exclusions and refuses to check a replacement that omits them again', async () => {
  const h = integrationHarness();
  try {
    const { manifest } = await semanticSources(h);
    await withAgentAdapter(
      {
        ...agentAdapter('codex'),
        start(): [string, string[]] {
          return [
            process.execPath,
            [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(semanticFile)}, ${JSON.stringify(combinedSemantic)}); require('node:child_process').spawnSync('git',['add','--',${JSON.stringify(semanticFile)}]);`,
            ],
          ];
        },
      },
      () =>
        semanticTrain(h, async (command) => ({
          passed: !isFullControlPlaneSuite(command),
          timedOut: false,
          output: isFullControlPlaneSuite(command) ? 'retained failure without omitted producer\n' : '',
        })).releaseControlPlaneBatch(manifest),
    );
    const journal = cohortJournal(h, manifest);
    expect(journal.value.results.map((result) => result.disposition)).toEqual(['excluded', 'excluded']);
    journal.value.controller = await exitedController();
    writeFileSync(journal.path, JSON.stringify(journal.value));
    const adapter = dispatchControlPlane(h, 'tools/goal/src/receiving-adapter.ts');
    await h.start(adapter);
    const fresh = acceptedBatch(h, [adapter]);
    const replacement = { ...manifest, members: [...manifest.members, ...fresh.members] };
    const input: ControlPlaneBatchSupersession = {
      version: 1,
      previousBatchId: controlPlaneBatchId(manifest),
      replacement,
      handoff: {
        journalHash: createHash('sha256').update(readFileSync(journal.path)).digest('hex'),
        controller: journal.value.controller,
        ownedCommands: [],
        evidence: 'fixture: verified exited controller inventory',
      },
      changedInputs: [
        {
          taskId: manifest.members[1]!.taskId,
          path: semanticFile,
          reason: 'Omitted semantic producer required by the first source',
        },
      ],
    };
    const env = managerSession(h);
    const result = await receiveControlPlaneBatchSupersession(input, batchRuntime(h), env);
    expect(result.members.map((member) => member.disposition)).toEqual(['failed', 'unknown']);
    await expect(
      receiveControlPlaneBatch(
        replacement,
        batchRuntime(
          h,
          semanticTrain(h, async () => {
            throw new Error('An omitted required producer must refuse before native checks');
          }),
        ),
        env,
      ),
    ).rejects.toThrow('omitted its changed producer inputs');
    const old = JSON.parse(readFileSync(journal.path, 'utf8')) as RecoveryJournal;
    expect(old.nodes.root!.proofs[0]!.result.passed).toBe(false);
    expect(old.superseded?.status).toBe('superseded/interrupted');
    expect(h.outcomes).toHaveLength(0);
    expect(h.queue.entry(manifest.members[0]!)?.outcome).toBeNull();
  } finally {
    h.dispose();
  }
}, 30_000);

import { receiveControlPlaneBatchDevHandoff, parseControlPlaneBatchSupersession } from './control-plane-batch.ts';

/** The current corrected worker is produced by the public retry API; its prior queue row stays historical. */
async function correctedCohortWithDeferral(h: ReturnType<typeof integrationHarness>, legacy = false) {
  const { tasks, manifest: prior } = await semanticSources(h);
  await withAgentAdapter(
    {
      ...agentAdapter('codex'),
      start(): [string, string[]] {
        return [process.execPath, ['-e', 'process.exit(0)']];
      },
    },
    () =>
      semanticTrain(h, async (command) => ({
        passed: !isFullControlPlaneSuite(command),
        timedOut: false,
        output: isFullControlPlaneSuite(command) ? 'retained native failure before corrected producer\n' : '',
      })).releaseControlPlaneBatch(prior),
  );
  const journal = cohortJournal(h, prior);
  journal.value.controller = await exitedController();
  if (legacy) delete (journal.value as RecoveryJournal & { identities?: unknown }).identities;
  writeFileSync(journal.path, JSON.stringify(journal.value));
  const corrected = tasks[0]!;
  const brief = join(h.settings.stateDirectory, 'corrected-contract.md');
  writeFileSync(brief, corrected.brief.markdown + '\nCorrect the producer required by the retained failure.\n');
  writeFileSync(
    join(corrected.worktree, '.temp/worker-plan.json'),
    JSON.stringify({
      file: semanticFile,
      content: 'export const left = true;\nexport const right = false;\nexport const corrected = true;\n',
    }),
  );
  await h.job.start(corrected.id, { brief });
  await h.job.drain();
  const replacement = acceptedBatch(h, [h.store.task(corrected.id)]);
  const input: ControlPlaneBatchSupersession = {
    version: 1,
    previousBatchId: controlPlaneBatchId(prior),
    replacement,
    handoff: {
      controller: journal.value.controller,
      ownedCommands: [],
      inventory: 'legacy-inventory-unavailable',
      journalHash: createHash('sha256').update(readFileSync(journal.path)).digest('hex'),
      evidence:
        'fixture: known publisher group exited; legacy child inventory is unavailable, no physical capacity released',
    },
    memberMapping: [
      { previous: prior.members[0]!, disposition: 'replacement', current: replacement.members[0]! },
      {
        previous: prior.members[1]!,
        disposition: 'deferred-to-dev',
        cause: 'Preparation conflict deferred by the owning manager Root order',
      },
    ],
    deferralAuthorization: {
      order: 'fixture: corrected main cohort first, migration immediately, excluded sources on dev',
      expectedDeferredCount: 1,
    },
    changedInputs: [{ taskId: corrected.id, path: semanticFile, reason: 'Corrects the producer in the failed cohort' }],
  };
  return { prior, journal, input, env: managerSession(h) };
}

for (const legacy of [false, true])
  test(`complete supersession mapping preserves ${legacy ? 'legacy' : 'snapshotted'} old failures and hands preparation claims to dev only after the corrected full proof`, async () => {
    const h = integrationHarness();
    try {
      const { prior, journal, input, env } = await correctedCohortWithDeferral(h, legacy);
      const oldProofs = journal.value.nodes.root!.proofs;
      const oldResults = journal.value.results;
      const oldRequest = h.queue.entry(prior.members[0]!)!.request;
      const oldAttempt = h.store.attempt(prior.members[0]!);
      const before = h.head('main');
      const runtime = batchRuntime(h);
      const result = await receiveControlPlaneBatchSupersession(
        parseControlPlaneBatchSupersession(input),
        runtime,
        env,
      );
      expect(result.members.map((member) => member.disposition)).toEqual(['failed', 'unknown']);
      expect(result.physicalInventory).toBe('legacy-inventory-unavailable');
      expect(h.head('main')).toBe(before);
      expect(h.queue.entry(prior.members[0]!)).toMatchObject({
        batchId: input.previousBatchId,
        request: oldRequest,
        outcome: null,
      });
      expect(h.store.attempt(prior.members[0]!)).toEqual(oldAttempt);
      expect(h.queue.entry(input.replacement.members[0]!)?.batchId).toBe(result.replacementBatchId);
      expect(result.devHandoff).toMatchObject({
        ownerId: input.replacement.managerId,
        members: [
          {
            ...prior.members[1]!,
            claimBatchId: input.previousBatchId,
            request: h.queue.entry(prior.members[1]!)!.request,
            cause: input.memberMapping![1]!.disposition === 'deferred-to-dev' ? input.memberMapping![1]!.cause : '',
          },
        ],
      });
      let migrations = 0;
      const handoffRequest = { previousBatchId: input.previousBatchId, replacementBatchId: result.replacementBatchId };
      const receiver = {
        train: runtime.train,
        receiveDev() {
          migrations++;
        },
      };
      await expect(receiveControlPlaneBatchDevHandoff(handoffRequest, receiver, env)).rejects.toThrow();
      expect(migrations).toBe(0);
      expect(h.queue.entry(prior.members[1]!)?.batchId).toBe(input.previousBatchId);
      const commands: string[][] = [];
      await receiveControlPlaneBatch(
        input.replacement,
        batchRuntime(
          h,
          batchTrain(h, async (command) => {
            commands.push([...command]);
            return { passed: true, timedOut: false, output: '' };
          }),
        ),
        env,
      );
      expect(commands.filter(isFullControlPlaneSuite)).toHaveLength(1);
      expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
      expect(commands.some((command) => command.includes('tools/goal/scripts/check-compatibility.ts'))).toBe(true);
      // A receiver that does not actually migrate the tasks cannot release any claim.
      await expect(receiveControlPlaneBatchDevHandoff(handoffRequest, receiver, env)).rejects.toThrow(
        'normal dev lane',
      );
      expect(h.queue.entry(prior.members[1]!)?.batchId).toBe(input.previousBatchId);
      const nativeReceiver = {
        train: runtime.train,
        receiveDev(handoff: import('./contracts.ts').ControlPlaneBatchDevHandoff) {
          migrations++;
          for (const member of handoff.members)
            h.store.updateTask(member, (task) => {
              task.brief = { ...task.brief, goal: 'dev-fixture' };
            });
        },
      };
      expect(await receiveControlPlaneBatchDevHandoff(handoffRequest, nativeReceiver, env)).toEqual(result.devHandoff!);
      const count = migrations;
      expect(await receiveControlPlaneBatchDevHandoff(handoffRequest, nativeReceiver, env)).toEqual(result.devHandoff!);
      expect(migrations).toBe(count);
      expect(h.queue.nextBatch(10, [], 'dev').map((entry) => entry.request.taskId)).toContain(prior.members[1]!.taskId);
      expect(h.queue.nextBatch(10, [], 'main')).toHaveLength(0);
      expect(h.queue.entry(prior.members[1]!)).toMatchObject({
        batchId: null,
        outcome: null,
        candidate: null,
        delivered: 0,
      });
      const closed = JSON.parse(readFileSync(journal.path, 'utf8')) as RecoveryJournal;
      expect(closed.nodes.root!.proofs).toEqual(oldProofs);
      expect(closed.results).toEqual(oldResults);
      expect(h.queue.entry(prior.members[0]!)?.request).toEqual(oldRequest);
      expect(
        h.store.db.query('SELECT COUNT(*) AS n FROM landing_batch_claims WHERE batch=?').get(input.previousBatchId),
      ).toEqual({ n: 2 });
    } finally {
      h.dispose();
    }
  }, 30_000);

for (const refusal of [
  'forgotten-member',
  'arbitrary-task',
  'native-deferral',
  'wrong-count',
  'broken-retry-lineage',
  'stale-current',
  'live-known-command',
  'unchanged-producer',
] as const)
  test(`complete supersession mapping refuses ${refusal} atomically`, async () => {
    const h = integrationHarness();
    try {
      const { prior, journal, input, env } = await correctedCohortWithDeferral(h);
      if (refusal === 'forgotten-member') input.memberMapping = input.memberMapping!.slice(0, 1);
      if (refusal === 'arbitrary-task')
        input.memberMapping = input.memberMapping!.map((mapping, index) =>
          index ? mapping : { ...mapping, disposition: 'replacement', current: prior.members[1]! },
        );
      if (refusal === 'native-deferral') {
        // Swap the retained failed member into the deferred position; all identities still map completely.
        const fresh = dispatchControlPlane(h, 'tools/goal/src/actual-added-producer.ts');
        await h.start(fresh);
        const current = acceptedBatch(h, [h.store.task(prior.members[0]!.taskId), fresh]);
        input.replacement = {
          ...current,
          members: [prior.members[1]!, current.members.find((member) => member.taskId === fresh.id)!],
        };
        input.memberMapping = [
          {
            previous: prior.members[0]!,
            disposition: 'deferred-to-dev',
            cause: 'Cannot defer this retained native failure',
          },
          { previous: prior.members[1]!, disposition: 'replacement', current: prior.members[1]! },
        ];
      }
      if (refusal === 'wrong-count') input.deferralAuthorization!.expectedDeferredCount = 2;
      if (refusal === 'broken-retry-lineage')
        h.store.updateTask(input.replacement.members[0]!, (task) => {
          task.brief = { ...task.brief, markdown: task.brief.markdown + '\nUnrecorded contract change.\n' };
        });
      if (refusal === 'stale-current') input.replacement = { ...input.replacement, members: [prior.members[0]!] };
      if (refusal === 'live-known-command') input.handoff.ownedCommands = [processIdentity()!];
      if (refusal === 'unchanged-producer')
        input.changedInputs = [{ ...input.changedInputs[0]!, path: 'tools/goal/src/absent-producer.ts' }];
      const bytes = readFileSync(journal.path, 'utf8');
      await expect(receiveControlPlaneBatchSupersession(input, batchRuntime(h), env)).rejects.toThrow();
      expect(readFileSync(journal.path, 'utf8')).toBe(bytes);
      expect(h.queue.controlPlaneSupersession(input.previousBatchId)).toBeUndefined();
      for (const member of prior.members) expect(h.queue.entry(member)?.batchId).toBe(input.previousBatchId);
    } finally {
      h.dispose();
    }
  }, 30_000);

import { acquireControlPlaneDevLane, CONTROL_PLANE_CHECKS } from './merge-train.ts';
import { receiveControlPlaneBatchRefContinuation } from './control-plane-batch.ts';
import type { ControlPlaneBatchRefContinuation } from './contracts.ts';

async function refExhaustedCohort(h: ReturnType<typeof integrationHarness>) {
  h.ensureDev();
  const task = dispatchControlPlane(h, 'tools/goal/src/ref-starved.ts');
  await h.start(task);
  const manifest = acceptedBatch(h, [task]);
  let suites = 0;
  await expect(
    batchTrain(h, async (command) => {
      if (isFullControlPlaneSuite(command)) {
        suites++;
        // An external writer deliberately bypasses the ordinary lease; CAS must remain truthful.
        addBranchCommit(h, 'dev', { [`external-ref-${suites}.txt`]: 'external publication\n' });
      }
      return { passed: true, timedOut: false, output: 'retained positive full check\n' };
    }).releaseControlPlaneBatch(manifest),
  ).rejects.toThrow('exhausted three candidate/ref attempts');
  expect(suites).toBe(3);
  const journal = cohortJournal(h, manifest);
  journal.value.controller = await exitedController();
  writeFileSync(journal.path, JSON.stringify(journal.value));
  const raw = readFileSync(journal.path, 'utf8');
  const logPath = join(h.settings.stateDirectory, `control-plane-batch-${controlPlaneBatchId(manifest)}-root.log`);
  const input: ControlPlaneBatchRefContinuation = {
    version: 1,
    manifest,
    logHash: createHash('sha256').update(readFileSync(logPath)).digest('hex'),
    handoff: {
      journalHash: createHash('sha256').update(raw).digest('hex'),
      controller: journal.value.controller,
      ownedCommands: [],
      inventory: 'legacy-inventory-unavailable',
      evidence: 'fixture: exact publisher exited; unknown legacy children grant no cleanup or capacity',
    },
  };
  return { input, journal, raw, logPath, env: managerSession(h) };
}

test('a concurrent ordinary dev publication queues behind the native release lease and resumes with its source intact', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const source = dispatchControlPlane(h);
    await h.start(source);
    const manifest = acceptedBatch(h, [source]);
    const devTask = h.dispatch('queued-dev.txt');
    await h.start(devTask);
    const capturedDev = h.head('dev');
    const devTrain = batchTrain(h);
    let suites = 0;
    const result = await batchTrain(h, async (command) => {
      if (isFullControlPlaneSuite(command)) {
        suites++;
        await devTrain.pump();
        expect(h.head('dev')).toBe(capturedDev);
        expect(h.queue.entry({ taskId: devTask.id, attempt: 1 })).toMatchObject({ outcome: null, delivered: 0 });
      }
      return success(command, h.root, '');
    }).releaseControlPlaneBatch(manifest);
    expect(suites).toBe(1);
    expect(result.members[0]?.disposition).toBe('released');
    expect(releaseRecords(h)[0]?.devScriptTree).toBe(capturedDev);
    const main = h.head('main');
    await devTrain.pump();
    expect(h.queue.entry({ taskId: devTask.id, attempt: 1 })?.outcome?.passed).toBe(true);
    expect(git(h.root, 'show', 'dev:queued-dev.txt')).toBe('queued-dev.txt');
    expect(git(h.root, 'merge-base', '--is-ancestor', main, h.head('dev'))).toBe('');
  } finally {
    h.dispose();
  }
}, 30_000);

test('bounded dev lease contention preserves its live owner and native failure releases both ordinary lanes', async () => {
  const h = integrationHarness();
  let owner: ReturnType<typeof acquireDirectoryLease> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    h.ensureDev();
    const source = dispatchControlPlane(h);
    await h.start(source);
    const manifest = acceptedBatch(h, [source]);
    const directory = join(h.settings.stateDirectory, 'train.lease');
    owner = acquireDirectoryLease(directory);
    const name = readdirSync(directory)[0]!;
    const bytes = readFileSync(join(directory, name), 'utf8');
    await expect(acquireControlPlaneDevLane(h.settings.stateDirectory, 0)).rejects.toThrow('Dev train lease held');
    expect(readFileSync(join(directory, name), 'utf8')).toBe(bytes);
    let gates = 0;
    const release = batchTrain(h, async () => {
      gates++;
      throw new Error('fixture candidate check interruption');
    }).releaseControlPlaneBatch(manifest);
    expect(gates).toBe(0);
    expect(() => acquireDirectoryLease(join(h.settings.stateDirectory, 'train-main.lease'))).toThrow('Lease held');
    expect(readFileSync(join(directory, name), 'utf8')).toBe(bytes);
    timer = setTimeout(() => {
      owner!.release();
      owner = undefined;
    }, 10);
    await expect(release).rejects.toThrow('fixture candidate check interruption');
    expect(gates).toBeGreaterThan(0);
    for (const lane of ['train-main.lease', 'train.lease'])
      acquireDirectoryLease(join(h.settings.stateDirectory, lane)).release();
  } finally {
    if (timer) clearTimeout(timer);
    owner?.release();
    h.dispose();
  }
}, 30_000);

test('exact ref-only continuation retains three partial positive proofs and admits one fresh complete native proof with idempotent replay', async () => {
  const h = integrationHarness();
  try {
    const { input, journal, raw, logPath, env } = await refExhaustedCohort(h);
    const oldRoot = structuredClone(journal.value.nodes.root);
    const oldLog = readFileSync(logPath, 'utf8');
    const oldAttempt = h.store.attempt(input.manifest.members[0]!).result;
    const commands: string[][] = [];
    const native = batchTrain(h, async (command) => {
      commands.push([...command]);
      return success(command, h.root, '');
    });
    const result = await receiveControlPlaneBatchRefContinuation(input, { train: native }, env);
    expect(result.members[0]?.disposition).toBe('released');
    const current = cohortJournal(h, input.manifest).value;
    expect(current.nodes.root).toEqual(oldRoot);
    expect(current.controller).toEqual(input.handoff.controller);
    expect(current.nodes['ref-continuation']?.attempts).toBe(1);
    expect(current.nodes['ref-continuation']?.proofs).toHaveLength(1);
    expect(readFileSync(logPath, 'utf8')).toBe(oldLog);
    expect(h.store.attempt(input.manifest.members[0]!).result).toEqual(oldAttempt);
    for (const command of CONTROL_PLANE_CHECKS)
      expect(commands.filter((value) => JSON.stringify(value) === JSON.stringify(command))).toHaveLength(
        command === CONTROL_PLANE_CHECKS[0] ? 2 : 1,
      );
    expect(commands.filter((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toHaveLength(1);
    expect(releaseRecords(h)[0]?.lifecycleEvidence).toContain(`candidate=${h.head('main')}`);
    const receiptBytes = h.queue.controlPlaneRefContinuation(result.batchId)!;
    const receipt = JSON.parse(receiptBytes);
    expect(receipt.previousJournal).toBe(raw);
    expect(receipt.previousController).toEqual(input.handoff.controller);
    expect(receipt.controller).toEqual(processIdentity());
    expect(receipt.actor).toEqual({ managerId: input.manifest.managerId, sessionId: env.CODEX_THREAD_ID });
    const count = commands.length;
    expect(await receiveControlPlaneBatchRefContinuation(input, { train: native }, env)).toEqual(result);
    expect(commands).toHaveLength(count);
    expect(h.queue.controlPlaneRefContinuation(result.batchId)).toBe(receiptBytes);
    await expect(
      receiveControlPlaneBatchRefContinuation({ ...input, logHash: '0'.repeat(64) }, { train: native }, env),
    ).rejects.toThrow('immutable authority');
    await expect(native.releaseControlPlaneBatch(input.manifest)).rejects.toThrow(
      'authenticated continuation receiver',
    );
    const completed = readFileSync(journal.path, 'utf8');
    const tampered = JSON.parse(completed);
    delete tampered.nodes['ref-continuation'].prepared;
    writeFileSync(journal.path, JSON.stringify(tampered));
    await expect(receiveControlPlaneBatchRefContinuation(input, { train: native }, env)).rejects.toThrow('spent');
    expect(commands).toHaveLength(count);
    writeFileSync(journal.path, completed);
  } finally {
    h.dispose();
  }
}, 30_000);

test('ref continuation refuses failed, incomplete, live, stale, tampered and worker-authorized inputs without changing retained history', async () => {
  const h = integrationHarness();
  try {
    const { input, journal, raw, env } = await refExhaustedCohort(h);
    const native = batchTrain(h, async () => {
      throw new Error('refused receiving must not run checks');
    });
    const receive = (value = input, auth: NodeJS.ProcessEnv = env) =>
      receiveControlPlaneBatchRefContinuation(value, { train: native }, auth);
    await expect(receive(input, { ...env, GOAL_TASK_ID: input.manifest.members[0]!.taskId })).rejects.toThrow(
      'authenticated',
    );
    await expect(receive({ ...input, handoff: { ...input.handoff, journalHash: '0'.repeat(64) } })).rejects.toThrow(
      'exhaustion',
    );
    await expect(
      receive({ ...input, handoff: { ...input.handoff, ownedCommands: [processIdentity()!] } }),
    ).rejects.toThrow('still active');
    await expect(receive({ ...input, logHash: '0'.repeat(64) })).rejects.toThrow('retained three-attempt log');
    for (const refusal of [
      'failed',
      'timed-out',
      'unknown',
      'proof-incomplete',
      'prepared',
      'published',
      'live-controller',
    ] as const) {
      const altered = JSON.parse(raw);
      const root = altered.nodes.root;
      if (refusal === 'failed') root.proofs[0].result.passed = false;
      if (refusal === 'timed-out') root.proofs[0].result.timedOut = true;
      if (refusal === 'unknown') delete root.proofs[0].result.passed;
      if (refusal === 'proof-incomplete') root.proofs.pop();
      if (refusal === 'prepared') root.prepared = {};
      if (refusal === 'published') root.completed = true;
      if (refusal === 'live-controller') altered.controller = processIdentity();
      const bytes = JSON.stringify(altered);
      writeFileSync(journal.path, bytes);
      await expect(
        receive({
          ...input,
          handoff: {
            ...input.handoff,
            controller: altered.controller,
            journalHash: createHash('sha256').update(bytes).digest('hex'),
          },
        }),
      ).rejects.toThrow();
      expect(readFileSync(journal.path, 'utf8')).toBe(bytes);
      expect(h.queue.controlPlaneRefContinuation(controlPlaneBatchId(input.manifest))).toBeUndefined();
    }
    writeFileSync(journal.path, raw);
    addBranchCommit(h, h.store.task(input.manifest.members[0]!.taskId).branch, {
      'stale-source.txt': 'source changed\n',
    });
    await expect(receive()).rejects.toThrow('source, contract, request or claim changed');
    expect(readFileSync(journal.path, 'utf8')).toBe(raw);
    expect(h.queue.controlPlaneRefContinuation(controlPlaneBatchId(input.manifest))).toBeUndefined();
  } finally {
    h.dispose();
  }
}, 30_000);

test('a ref continuation receives no inherited suite pass and cannot obtain a second candidate after its new native failure', async () => {
  const h = integrationHarness();
  try {
    const { input, journal, env } = await refExhaustedCohort(h);
    let suites = 0;
    const native = batchTrain(h, async (command) => {
      if (isFullControlPlaneSuite(command)) {
        suites++;
        return { passed: false, timedOut: false, output: 'new native failure\n' };
      }
      return success(command, h.root, '');
    });
    const main = h.head('main');
    const result = await receiveControlPlaneBatchRefContinuation(input, { train: native }, env);
    expect(result.members[0]).toMatchObject({ disposition: 'excluded', phase: 'native' });
    expect(h.head('main')).toBe(main);
    expect(releaseRecords(h)).toHaveLength(0);
    expect(cohortJournal(h, input.manifest).value.nodes.root).toEqual(journal.value.nodes.root);
    expect(await receiveControlPlaneBatchRefContinuation(input, { train: native }, env)).toEqual(result);
    expect(suites).toBe(1);
  } finally {
    h.dispose();
  }
}, 30_000);

test('an external main CAS change spends the single continuation without overwriting main or repeating any mandatory gate', async () => {
  const h = integrationHarness();
  try {
    const { input, journal, env } = await refExhaustedCohort(h);
    let suites = 0;
    let externalMain = '';
    const native = batchTrain(
      h,
      async (command) => {
        if (isFullControlPlaneSuite(command)) suites++;
        return success(command, h.root, '');
      },
      {
        beforeIntegrationAdvance() {
          externalMain = addMainCommit(h, 'external-main-cas.txt');
        },
      },
    );
    await expect(receiveControlPlaneBatchRefContinuation(input, { train: native }, env)).rejects.toThrow(
      'exhausted its single candidate/ref attempt',
    );
    expect(h.head('main')).toBe(externalMain);
    expect(h.queue.entry(input.manifest.members[0]!)?.outcome).toBeNull();
    const current = cohortJournal(h, input.manifest).value;
    expect(current.nodes.root).toEqual(journal.value.nodes.root);
    expect(current.nodes['ref-continuation']?.attempts).toBe(1);
    expect(current.nodes['ref-continuation']?.proofs).toHaveLength(1);
    await expect(receiveControlPlaneBatchRefContinuation(input, { train: native }, env)).rejects.toThrow('spent');
    expect(suites).toBe(1);
  } finally {
    h.dispose();
  }
}, 30_000);

for (const passed of [true, false]) {
  test(`ordinary release cleanup refusal preserves its ${passed ? 'published success' : 'failed lifecycle proof'} without another gate`, async () => {
    const h = integrationHarness();
    let retainedTree = '';
    try {
      h.ensureDev();
      const main = h.head('main');
      const task = dispatchControlPlane(h);
      await h.start(task);
      const source = h.head(task.branch);
      const workerResult = h.store.attempt({ taskId: task.id, attempt: 1 }).result;
      const entry = h.queue.entry({ taskId: task.id, attempt: 1 })!;
      const commands: string[][] = [];
      let launches = 0;
      const native = new MergeTrain({
        ...h.settings,
        queue: h.queue,
        fence: h.store,
        sink: {
          onGateOutcome(outcome) {
            h.outcomes.push(outcome);
          },
        },
        runGate: async (command, cwd, log) => {
          commands.push([...command]);
          return success(command, cwd, log);
        },
        runLaunchSmoke: async (command, cwd) => {
          launches++;
          // A real Git refusal is deterministic without changing permissions or leaving a live command behind.
          git(h.root, 'worktree', 'lock', '--reason', 'fixture retains exact cleanup evidence', cwd);
          retainedTree = cwd;
          return passed
            ? releaseEvidence(command, cwd)
            : {
                passed: false,
                timedOut: false,
                output: 'AssertionError: lifecycle failed before cleanup\n',
              };
        },
      });
      await native.run();
      expect(commands.filter(isFullControlPlaneSuite)).toHaveLength(1);
      expect(commands).toContainEqual(['bun', 'run', '--cwd', 'tools/goal', 'typecheck']);
      expect(commands.some((command) => command[1] === 'tools/goal/scripts/check-compatibility.ts')).toBe(true);
      expect(launches).toBe(1);
      expect(h.outcomes).toHaveLength(1);
      const outcome = h.outcomes[0]!;
      expect(outcome.passed).toBe(passed);
      expect(h.head(task.branch)).toBe(source);
      expect(h.store.attempt({ taskId: task.id, attempt: 1 }).result).toBe(workerResult);
      expect(existsSync(retainedTree)).toBe(true);
      expect(readFileSync(outcome.logPath, 'utf8')).toContain(`Train tree cleanup deferred: ${retainedTree}:`);
      expect(readFileSync(outcome.logPath, 'utf8')).toContain('locked');
      expect(ordinaryProofs(h, entry.id).attempts).toMatchObject([{ status: 'finished', outcome: { passed } }]);
      if (passed) {
        expect(h.head('main')).not.toBe(main);
        expect(outcome.mergedCommit).toBe(h.head('main'));
        expect(releaseRecords(h)[0]).toMatchObject({ mainCommit: h.head('main') });
        expect(git(h.root, 'merge-base', '--is-ancestor', h.head('main'), 'dev')).toBe('');
      } else {
        expect([h.head('main'), h.head('dev')]).toEqual([main, main]);
        expect(outcome).toMatchObject({
          stage: 'gate',
          timedOut: false,
          firstFailure: { assertion: expect.stringContaining('lifecycle failed before cleanup') },
        });
        expect(releaseRecords(h)).toEqual([]);
      }
      for (const name of ['train-main.lease', 'train.lease']) {
        expect(existsSync(join(h.settings.stateDirectory, name))).toBe(false);
      }
      const completedCommands = commands.length;
      await native.pump();
      expect(commands).toHaveLength(completedCommands);
      expect(launches).toBe(1);
      expect(h.outcomes).toHaveLength(1);
    } finally {
      if (retainedTree) {
        git(h.root, 'worktree', 'unlock', retainedTree);
        git(h.root, 'worktree', 'remove', '--force', retainedTree);
      }
      h.dispose();
    }
  });
}
