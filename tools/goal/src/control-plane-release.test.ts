import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MergeTrain, type TrainOptions } from './merge-train.ts';
import { git, type GateRunner } from './merge.ts';
import type { GateOutcome } from './contracts.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { integrationHarness, markdown } from './test-support.ts';

type ReleaseHooks = Partial<Pick<TrainOptions, 'beforeIntegrationAdvance' | 'beforePromotionAdvance'>>;
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
  }).run();
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
