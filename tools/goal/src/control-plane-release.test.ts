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
      .replace('goal: fixture', `goal: control-plane\nmanager: ${manager}`)
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
