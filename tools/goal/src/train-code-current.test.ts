import { expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptFence, GateOutcome } from './contracts.ts';
import { publishCpSyncRefs, type CpSyncRefTransactionContext } from './cp-sync-ref-transaction.ts';
import { codeVersion } from './runtime-version.ts';
import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { acquireDirectoryLease, trainLaneStatus } from './lease.ts';
import { git } from './merge.ts';
import { integrationHarness, repository } from './test-support.ts';

function setup() {
  const repo = repository();
  const db = openDb(join(repo.path, 'state.sqlite'));
  const fence: AttemptFence = {
    assertCurrent() {},
    commitMerge(_ref, merge) {
      return db.transaction(() => merge()).immediate();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  const outcomes: GateOutcome[] = [];
  return {
    repo,
    db,
    queue,
    outcomes,
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

function addControlPlaneSource(main: string): void {
  const path = join(main, 'tools/goal/src/runtime.ts');
  mkdirSync(join(main, 'tools/goal/src'), { recursive: true });
  writeFileSync(path, 'export const revision = 1;\n');
  git(main, 'add', '--', 'tools/goal/src/runtime.ts');
  git(main, 'commit', '-m', 'Add control-plane fixture');
}

test('a train finishes its landing after its code changes and the next train takes the remaining request', async () => {
  const s = setup();
  try {
    addControlPlaneSource(s.repo.main);
    const first = s.repo.branch('first', 'tools/goal/src/runtime.ts', 'export const revision = 2;\n');
    const second = s.repo.branch('second', 'second-result');
    s.queue.enqueue(first);
    s.queue.enqueue(second);

    const originalVersion = codeVersion(s.repo.main, 'tools/goal');
    const gateVersions: string[] = [];
    let handoffs = 0;
    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => codeVersion(s.repo.main, 'tools/goal') === originalVersion,
      handOff() {
        handoffs++;
      },
      async runGate() {
        gateVersions.push(codeVersion(s.repo.main, 'tools/goal'));
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    const currentVersion = codeVersion(s.repo.main, 'tools/goal');
    expect(currentVersion).not.toBe(originalVersion);
    expect(gateVersions).toEqual([originalVersion]);
    expect(handoffs).toBe(1);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([['first', true]]);
    expect(s.queue.next()?.request.taskId).toBe('second');

    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => codeVersion(s.repo.main, 'tools/goal') === currentVersion,
      handOff() {
        handoffs++;
      },
      async runGate() {
        gateVersions.push(codeVersion(s.repo.main, 'tools/goal'));
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    expect(gateVersions).toEqual([originalVersion, currentVersion]);
    expect(handoffs).toBe(1);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(s.queue.next()).toBeUndefined();
  } finally {
    s.close();
  }
}, 15_000);

test('a detached train that finds the lease held exits at once, leaving the request to the owner', async () => {
  const s = setup();
  const request = s.repo.branch('waiting', 'waiting-result');
  s.queue.enqueue(request);
  const lease = acquireDirectoryLease(join(s.options.stateDirectory, 'train.lease'));
  try {
    const started = Date.now();
    // Every settle spawns a detached train; waiting for the owner piled up 304 polling trains.
    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => true,
      async runGate() {
        throw new Error('A train without the lease must not run a landing');
      },
    }).runWaiting();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(s.outcomes).toEqual([]);
    expect(s.queue.next()?.request.taskId).toBe('waiting');
  } finally {
    lease.release();
    s.close();
  }
});

test('a current train continues landing requests while it holds the lease', async () => {
  const s = setup();
  try {
    s.queue.enqueue(s.repo.branch('first', 'first-result'));
    s.queue.enqueue(s.repo.branch('second', 'second-result'));
    let handoffs = 0;

    await new MergeTrain({
      ...s.options,
      codeIsCurrent: () => true,
      handOff() {
        handoffs++;
      },
      async runGate() {
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();

    expect(handoffs).toBe(0);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
    expect(s.queue.next()).toBeUndefined();
  } finally {
    s.close();
  }
});

test('an unrelated main change outside tools/goal does not hand off', async () => {
  const s = setup();
  try {
    addControlPlaneSource(s.repo.main);
    git(s.repo.main, 'branch', 'dev');
    const originalVersion = codeVersion(s.repo.main, 'tools/goal');
    s.queue.enqueue(s.repo.branch('first', 'first-result'));
    s.queue.enqueue(s.repo.branch('second', 'second-result'));
    let handoffs = 0;
    let unrelated = false;
    await new MergeTrain({
      ...s.options,
      integrationBranch: 'dev',
      codeIsCurrent: () => codeVersion(s.repo.main, 'tools/goal') === originalVersion,
      handOff() {
        handoffs++;
      },
      async beforeRelease() {
        if (unrelated) return;
        unrelated = true;
        writeFileSync(join(s.repo.main, 'other.txt'), 'unrelated\n');
        git(s.repo.main, 'add', '--', 'other.txt');
        git(s.repo.main, 'commit', '-m', 'Unrelated main change');
      },
      async runGate() {
        return { passed: true, output: '', timedOut: false };
      },
    }).runWaiting();
    expect(codeVersion(s.repo.main, 'tools/goal')).toBe(originalVersion);
    expect(handoffs).toBe(0);
    expect(s.outcomes.map((outcome) => [outcome.taskId, outcome.passed])).toEqual([
      ['first', true],
      ['second', true],
    ]);
  } finally {
    s.close();
  }
});

function writeTrainCli(root: string, stamp: string): void {
  mkdirSync(join(root, 'tools/goal/src'), { recursive: true });
  writeFileSync(join(root, 'tools/goal/STAMP'), `${stamp}\n`);
  writeFileSync(
    join(root, 'tools/goal/src/cli.ts'),
    `#!/usr/bin/env bun
import { run } from ${JSON.stringify(join(import.meta.dir, 'cli.ts'))};
process.exit(await run(process.argv.slice(2)));
`,
  );
}

async function waitUntil(label: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function stopPids(pids: Iterable<number | undefined | null>): void {
  for (const pid of pids) {
    if (!pid) continue;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {}
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

function cpSyncContext(checkout: string): CpSyncRefTransactionContext {
  const run: CpSyncRefTransactionContext['run'] = (args, options) => {
    const result = spawnSync('git', [...args], {
      cwd: checkout,
      encoding: 'utf8',
      ...(options?.input === undefined ? {} : { input: options.input }),
    });
    return {
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr || result.error?.message || '',
    };
  };
  return {
    checkout,
    main: 'main',
    dev: 'dev',
    conflictPathLimit: 4,
    git: (...args) => git(checkout, ...args),
    run,
    head: (branch) => {
      const result = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      return result.status === 0 ? result.stdout.trim() : undefined;
    },
    isAncestor: (ancestor, descendant) => run(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0,
    changedPaths: (from, to, paths) =>
      git(checkout, 'diff', '--name-only', '-z', from, to, '--', ...paths)
        .split('\0')
        .filter(Boolean),
    replacePaths: () => {
      throw new Error('unexpected path replacement without stabilize');
    },
    commitTree: (tree, parents, message) =>
      git(checkout, 'commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent]), '-m', message),
    assertCheckoutReady: () => {},
    refuse: (message) => {
      throw new Error(message);
    },
    short: (revision) => revision.slice(0, 10),
    redact: (text) => text,
  };
}

function preparePublishedCandidate(checkout: string, stamp: string): { previous: string; candidate: string } {
  const previous = git(checkout, 'rev-parse', 'main');
  writeTrainCli(checkout, stamp);
  git(checkout, 'add', '--', 'tools/goal');
  const candidate = git(checkout, 'commit-tree', git(checkout, 'write-tree'), '-p', previous, '-m', `Publish ${stamp}`);
  git(checkout, 'reset', '-q', '--hard', previous);
  const dev = git(checkout, 'rev-parse', 'dev');
  if (spawnSync('git', ['merge-base', '--is-ancestor', candidate, dev], { cwd: checkout }).status !== 0) {
    const merged = git(
      checkout,
      'commit-tree',
      git(checkout, 'rev-parse', `${dev}^{tree}`),
      '-p',
      dev,
      '-p',
      candidate,
      '-m',
      'Merge published tools/goal into dev',
    );
    git(checkout, 'update-ref', 'refs/heads/dev', merged, dev);
  }
  return { previous, candidate };
}

test('a spawned train finishes its landing after cp-sync publishes tools/goal and the replacement takes the rest', async () => {
  const h = integrationHarness();
  const pids = new Set<number>();
  let child: ChildProcess | undefined;
  const ready = join(h.settings.stateDirectory, 'typecheck-ready');
  const release = join(h.settings.stateDirectory, 'typecheck-release');
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8')) as Record<string, unknown>;
    local.integrationChecks = [];
    local.affectedTests = [];
    local.verifierChecks = [];
    local.derivedFiles = [];
    local.formatCommand = ['true'];
    local.gate = ['true'];
    local.integration = { ...(local.integration as object | undefined), batchSize: 1, devPrelandingTypecheck: true };
    writeFileSync(h.settings.localFile, JSON.stringify(local));

    writeFileSync(
      join(h.root, 'scripts/typecheck.ts'),
      `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(ready)}, '');
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
`,
    );
    git(h.root, 'add', '--', 'scripts/typecheck.ts');
    git(h.root, 'commit', '-m', 'Hold the first typecheck');
    writeTrainCli(h.root, 'v1');
    git(h.root, 'add', '--', 'tools/goal');
    git(h.root, 'commit', '-m', 'Add tools/goal trampoline');
    h.ensureDev();

    const first = h.dispatch('docs/first.md');
    const second = h.dispatch('docs/second.md');
    await h.start(first);
    await h.start(second);

    const oldVersion = codeVersion(h.root, 'tools/goal');
    const prepared = preparePublishedCandidate(h.root, 'v2');
    expect(codeVersion(h.root, 'tools/goal')).toBe(oldVersion);

    child = spawn(process.execPath, [join(h.root, 'tools/goal/src/cli.ts'), 'train'], {
      cwd: h.root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) pids.add(child.pid);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const parentExit = new Promise<number | null>((resolve) => child!.once('exit', resolve));

    await waitUntil('first landing held', () => existsSync(ready));
    const held = trainLaneStatus(h.settings.stateDirectory).find((lane) => lane.state === 'running');
    expect(held?.codeVersion).toBe(oldVersion);
    expect(held?.pid).toBeDefined();
    const oldPid = held!.pid!;
    pids.add(oldPid);

    const listed = spawnSync(process.execPath, [join(h.root, 'tools/goal/src/cli.ts'), 'status'], {
      cwd: h.root,
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    });
    expect(listed.status ?? listed.error?.message).toBe(0);
    const before = JSON.parse(listed.stdout) as {
      trains: { lane: string; state: string; pid?: number; codeVersion?: string }[];
    };
    expect(before.trains.find((lane) => lane.pid === oldPid)).toMatchObject({
      state: 'running',
      codeVersion: oldVersion,
    });

    publishCpSyncRefs(
      cpSyncContext(h.root),
      'sync',
      prepared.previous,
      prepared.candidate,
      ['tools/goal'],
      git(h.root, 'rev-parse', 'dev'),
      () => {},
    );
    const published = codeVersion(h.root, 'tools/goal');
    expect(published).not.toBe(oldVersion);
    expect(trainLaneStatus(h.settings.stateDirectory).find((lane) => lane.pid === oldPid)?.codeVersion).toBe(
      oldVersion,
    );
    expect(published).not.toBe(oldVersion);

    writeFileSync(release, '');
    const parentCode = await parentExit;
    expect(parentCode === 0 ? parentCode : `${parentCode}: ${stderr}`).toBe(0);

    await waitUntil('replacement train from published code', () =>
      trainLaneStatus(h.settings.stateDirectory).some(
        (lane) => lane.state === 'running' && lane.pid !== oldPid && lane.codeVersion === published,
      ),
    );
    const replacement = trainLaneStatus(h.settings.stateDirectory).find(
      (lane) => lane.state === 'running' && lane.pid !== oldPid,
    );
    expect(replacement?.pid).not.toBe(oldPid);
    expect(replacement?.codeVersion).toBe(published);
    if (replacement?.pid) pids.add(replacement.pid);
    const live = spawnSync(process.execPath, [join(h.root, 'tools/goal/src/cli.ts'), 'status'], {
      cwd: h.root,
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    });
    expect(live.status ?? live.error?.message).toBe(0);
    const liveTrains = (
      JSON.parse(live.stdout) as {
        trains: { state: string; pid?: number; codeVersion?: string }[];
      }
    ).trains;
    expect(liveTrains.some((lane) => lane.pid === oldPid && lane.state === 'running')).toBe(false);
    const reportedReplacement = liveTrains.find((lane) => lane.pid === replacement?.pid);
    if (reportedReplacement) expect(reportedReplacement.codeVersion).toBe(published);

    await waitUntil(
      'both landings recorded',
      () =>
        h.store.task(first.id).state === 'integrated' &&
        h.store.task(second.id).state === 'integrated' &&
        h.store.records().filter((record) => record.outcome === 'passed').length === 2,
    );
    expect(h.store.records().map((record) => [record.taskId, record.attempt, record.outcome])).toEqual([
      [first.id, 1, 'passed'],
      [second.id, 1, 'passed'],
    ]);
    expect(h.store.task(first.id).currentAttempt).toBe(1);
    expect(h.store.task(second.id).currentAttempt).toBe(1);
    expect(h.queue.next()).toBeUndefined();
    const after = spawnSync(process.execPath, [join(h.root, 'tools/goal/src/cli.ts'), 'status'], {
      cwd: h.root,
      encoding: 'utf8',
      env: process.env,
      timeout: 20_000,
    });
    expect(after.status ?? after.error?.message).toBe(0);
    const reported = JSON.parse(after.stdout) as {
      trains: { state: string; pid?: number; codeVersion?: string }[];
    };
    expect(reported.trains.some((lane) => lane.pid === oldPid && lane.state === 'running')).toBe(false);
  } finally {
    try {
      writeFileSync(release, '');
    } catch {}
    stopPids([...pids, child?.pid]);
    for (const lane of trainLaneStatus(h.settings.stateDirectory)) stopPids([lane.pid]);
    h.dispose();
  }
}, 60_000);
