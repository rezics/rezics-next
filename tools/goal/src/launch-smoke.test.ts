import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import {
  createSmokeDirectory,
  launchSmokeBrief,
  main,
  observeSmokeAdapter,
  parseSmokeArguments,
  requireSmokeWaitingCheckId,
  resolveSmokeReportPath,
  runLaunchSmoke,
  saveSmokeEvidence,
  smokeRunSuffix,
  SMOKE_ACCEPTANCE_COMMAND,
  type SmokeLaunchEvidence,
} from '../scripts/launch-smoke.ts';
import { launchSmokeRequired } from './merge-train.ts';
import { codexAdapter } from './agents/codex.ts';
import { fixturePool, harness, reading } from './test-support.ts';
import { loadSettings, mainCheckout } from './config.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import { classifyTask, readRouting } from './routing.ts';
import { git as fixtureGit, WorkerTasks } from './tasks.ts';

test('smoke evidence observes actual start and resume argv without exposing prompts or account configuration', () => {
  const disposable = createSmokeDirectory(root, 'launch-smoke-test-');
  try {
    const cli = join(disposable.path, 'cli');
    writeFileSync(cli, '#!/usr/bin/env bun\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
    chmodSync(cli, 0o755);
    writeFileSync(
      join(disposable.path, 'config.toml'),
      `api_key = "account-secret-never-record"\n[features]\nunified_exec = false\nshell_tool = true\n[mcp_servers.private]\ncommand = "private-server-never-record"\n`,
    );
    const launches: SmokeLaunchEvidence[] = [];
    const adapter = observeSmokeAdapter(codexAdapter, (value) => launches.push(value));
    const options = {
      pool: { ...fixturePool(disposable.path), command: cli },
      profile: { cli: 'codex' as const, model: 'fixture-model', effort: 'low' as const, poolClass: 'codex' },
      worktree: disposable.path,
      prompt: 'private-prompt-never-record',
    };
    const commands = [adapter.start(options), adapter.resume({ ...options, session: 'actual-session' })];
    for (const [index, command] of commands.entries()) {
      const actual = spawnSync(command[0], command[1], { cwd: disposable.path, encoding: 'utf8', timeout: 2000 });
      expect(actual.status).toBe(0);
      const argv = JSON.parse(actual.stdout) as string[];
      expect(argv).toEqual(command[1]);
      expect(argv.at(-1)).toBe(options.prompt);
      const launch = launches[index]!;
      expect(launch.program).toBe(cli);
      expect(launch.profile).toEqual(options.profile);
      expect(launch.pool).toBe(options.pool.name);
      expect(launch.worktree).toBe(disposable.path);
      expect(launch.argv).toContain('features.unified_exec=true');
      expect(launch.configuredFeatures).toEqual({ unified_exec: false, shell_tool: true });
      expect(launch.argv.at(-1)).toBe('<prompt omitted>');
    }
    expect(launches[0]!.mode).toBe('start');
    expect(launches[0]!.session).toBeNull();
    expect(launches[1]!.mode).toBe('resume');
    expect(launches[1]!.session).toBe('actual-session');
    expect(launches[1]!.argv).toContain('actual-session');
    const evidence = join(disposable.path, 'evidence.json');
    saveSmokeEvidence(evidence, { launches });
    const saved = readFileSync(evidence, 'utf8');
    expect(saved).not.toContain(options.prompt);
    expect(saved).not.toContain('account-secret-never-record');
    expect(saved).not.toContain('private-server-never-record');
    expect(lstatSync(evidence).mode & 0o777).toBe(0o600);
  } finally {
    disposable.remove();
  }
});

test('bounded evidence survives fixture cleanup with only the current run result and relevant log suffix', () => {
  const disposable = createSmokeDirectory(root, 'launch-smoke-test-');
  const retained = createSmokeDirectory(root, 'launch-smoke-test-');
  try {
    const oldWaiting =
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'stale previous waiting result' },
      }) + '\n';
    const currentResult = {
      status: 'blocked',
      summary: 'current tool unavailable',
      blocker: { kind: 'tool', detail: 'No callable shell tool in current session' },
    };
    const log = join(disposable.path, 'worker.log');
    writeFileSync(
      log,
      oldWaiting +
        [
          { type: 'thread.started', thread_id: 'current-session' },
          {
            type: 'item.completed',
            item: {
              type: 'mcp_tool_call',
              name: 'shell',
              arguments: { api_key: 'raw-arguments-never-record' },
              result: 'raw-tool-output-never-record',
              status: 'failed',
            },
          },
          { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(currentResult) } },
          { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 4 } },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n') +
        '\n',
    );
    const evidence = join(retained.path, 'run.json');
    saveSmokeEvidence(evidence, {
      candidate: 'exact-candidate',
      current: { taskId: 'current-task', attempt: 2, session: 'current-session', result: currentResult },
      logSuffix: smokeRunSuffix(log, Buffer.byteLength(oldWaiting)),
      password: 'credential-never-record',
      error: 'authorization: Bearer token-never-record',
      bulk: Array.from({ length: 100 }, () => '\u0000'.repeat(10000)),
    });
    disposable.remove();
    const saved = readFileSync(evidence, 'utf8');
    expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(64 * 1024);
    const parsed = JSON.parse(saved);
    expect(parsed.current).toEqual({
      taskId: 'current-task',
      attempt: 2,
      session: 'current-session',
      result: currentResult,
    });
    expect(parsed.logSuffix.at(-2).text).toBe(JSON.stringify(currentResult));
    expect(saved).not.toContain('stale previous waiting result');
    expect(saved).not.toContain('raw-arguments-never-record');
    expect(saved).not.toContain('raw-tool-output-never-record');
    expect(saved).not.toContain('credential-never-record');
    expect(saved).not.toContain('token-never-record');
  } finally {
    disposable.remove();
    retained.remove();
  }
});

test('smoke drives start, waiting, wake result and success with a fake agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-smoke-agent-'));
  const agent = join(dir, 'agent');
  writeFileSync(
    agent,
    '#!/bin/sh\ncase "$1" in\nstart) echo "waiting worker-check-abc123";;\nwake) test "$REZICS_SMOKE_CHECK_ID" = worker-check-abc123 && echo "result passed";;\nsuccess) echo success;;\nesac\n',
  );
  chmodSync(agent, 0o755);
  try {
    await expect(runLaunchSmoke(agent)).resolves.toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke names the failed step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-smoke-agent-'));
  const agent = join(dir, 'agent');
  writeFileSync(agent, '#!/bin/sh\nif [ "$1" = start ]; then exit 5; fi\n');
  chmodSync(agent, 0o755);
  try {
    await expect(runLaunchSmoke(agent)).rejects.toThrow('start:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const root = resolve(import.meta.dir, '../../..');

test('generated smoke brief keeps its real acceptance command and WorkerTasks selects the configured specification profile', async () => {
  const h = harness();
  let worktree = '';
  let branch = '';
  try {
    h.settings.integrationBranch = 'main';
    const workerCheckScript = join(h.root, 'scripts/worker-check.ts');
    writeFileSync(workerCheckScript, '#!/usr/bin/env bun\n');
    fixtureGit(h.root, ['add', 'scripts/worker-check.ts']);
    fixtureGit(h.root, ['commit', '-m', 'Fixture check runner']);

    const markdown = launchSmokeBrief(workerCheckScript, ['result.txt']);
    const brief = parseBrief(markdown, readRiskOwnership(h.settings.riskAreasFile));
    expect(brief.acceptance.command).toEqual([...SMOKE_ACCEPTANCE_COMMAND]);
    expect(brief.model).toBeUndefined();
    expect(brief.effort).toBeUndefined();
    expect(markdown).not.toContain('<id>');
    expect(markdown).not.toMatch(/^\s*(?:run|invoke)\s+.*--wait/m);

    const base = fixtureGit(h.root, ['rev-parse', 'refs/heads/main']);
    branch = `launch-smoke-${randomUUID()}`;
    worktree = join(h.settings.worktreeRoot, branch);
    mkdirSync(join(h.settings.worktreeRoot), { recursive: true });
    fixtureGit(h.root, ['worktree', 'add', '-b', branch, worktree, base]);
    const briefPath = join(h.settings.stateDirectory, 'briefs', 'generated-smoke.md');
    mkdirSync(join(h.settings.stateDirectory, 'briefs'), { recursive: true });
    writeFileSync(briefPath, markdown);
    const task = h.store.createTask(brief, { briefPath, worktree, branch, base }, classifyTask(brief));
    let launched: { attempt: { profile: unknown }; prompt: string } | undefined;
    const tasks = new WorkerTasks(
      h.settings,
      h.store,
      (pool) => reading(pool),
      async (_store, _task, attempt, _pool, prompt) => {
        launched = { attempt, prompt };
        return { attempt, exited: Promise.resolve({ code: 0, signal: null }) };
      },
    );
    await tasks.retry(task.id);

    const configured = readRouting(h.settings.routingFile).classes.specification.first;
    expect(launched?.attempt.profile).toEqual(configured);
    expect(launched?.prompt).toContain(JSON.stringify([...SMOKE_ACCEPTANCE_COMMAND]));
    expect(launched?.prompt).toContain('{"status":"waiting","checks":["<bare UUID>"]}');
    expect(launched?.prompt).toContain('Do not invoke `bun scripts/worker-check.ts --wait <id>`');
    const pollingInstructions = (launched?.prompt ?? '')
      .split(/(?<=[.!?])\s+/)
      .filter(
        (sentence) =>
          /\b(?:poll(?:ing)?|--wait)\b/i.test(sentence) &&
          !/\b(?:do not|don't|never|obsolete|superseded|previous session may contain)\b/i.test(sentence),
      );
    expect(pollingInstructions).toEqual([]);
  } finally {
    if (worktree && existsSync(worktree)) fixtureGit(h.root, ['worktree', 'remove', '--force', worktree]);
    if (branch) {
      try {
        fixtureGit(h.root, ['branch', '-D', branch]);
      } catch {
        /* No branch was created. */
      }
    }
    h.dispose();
  }
});

test('real worker-check starts the generated acceptance command once and its returned UUID is required', () => {
  const disposable = createSmokeDirectory(root, 'launch-smoke-test-');
  let devTree = '';
  const runGit = (cwd: string, args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    if (result.status !== 0)
      throw new Error(result.stderr?.trim() || result.error?.message || `git ${args[0]} exited ${result.status}`);
    return result.stdout.trim();
  };
  try {
    const settings = loadSettings({ cwd: root });
    devTree = join(disposable.path, 'dev');
    mkdirSync(join(devTree, 'scripts'), { recursive: true });
    runGit(root, ['init', '--quiet', devTree]);
    const sourceRef = `refs/heads/${settings.integrationBranch}`;
    for (const file of ['worker-check.ts', 'remote-check.ts', 'check-ledger.ts', 'stack-lease.ts', 'check-memory.ts'])
      writeFileSync(join(devTree, 'scripts', file), fixtureGit(root, ['show', `${sourceRef}:scripts/${file}`]));
    mkdirSync(join(devTree, 'scripts', 'check-host'), { recursive: true });
    writeFileSync(
      join(devTree, 'scripts', 'check-host', 'docker'),
      fixtureGit(root, ['show', `${sourceRef}:scripts/check-host/docker`]),
    );

    const script = join(devTree, 'scripts/worker-check.ts');
    const marker = join(disposable.path, 'command-starts.txt');
    const start = spawnSync(process.execPath, [script, '--local', '--', ...SMOKE_ACCEPTANCE_COMMAND], {
      cwd: devTree,
      env: {
        ...process.env,
        REZICS_CHECK_MEMORY: 'off',
        REZICS_CHECK_SCOPE: 'off',
        REZICS_STACK_LEASE: 'off',
        REZICS_LAUNCH_SMOKE_CHECK_MARKER: marker,
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (start.status !== 0)
      throw new Error(
        `worker-check start failed with status ${String(start.status)}: ${start.stderr?.trim() || start.stdout?.trim() || start.error?.message || 'no diagnostic output'}`,
      );
    const id = /check: id ([0-9a-f-]{36})/i.exec(start.stdout)?.[1];
    const returnedId = requireSmokeWaitingCheckId(id === undefined ? [] : [id]);
    expect(returnedId).toBe(id!);
    expect(() => requireSmokeWaitingCheckId([])).toThrow('one bare worker-check UUID');
    expect(() => requireSmokeWaitingCheckId(['<id>'])).toThrow('one bare worker-check UUID');

    const waited = spawnSync(process.execPath, [script, '--wait', returnedId], {
      cwd: devTree,
      env: {
        ...process.env,
        REZICS_CHECK_MEMORY: 'off',
        REZICS_CHECK_SCOPE: 'off',
        REZICS_STACK_LEASE: 'off',
      },
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    expect(waited.status).toBe(0);
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
    const record = JSON.parse(readFileSync(join(devTree, '.temp/goal/checks/results', `${returnedId}.json`), 'utf8'));
    expect(record).toMatchObject({ id: returnedId, status: 'finished', exitCode: 0 });
  } finally {
    disposable.remove();
  }
});

function structuredFakeAgent(): { directory: string; agent: string } {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const directory = mkdtempSync(join(root, '.temp', 'launch-smoke-test-'));
  const agent = join(directory, 'agent');
  writeFileSync(
    agent,
    `#!/bin/sh
if [ "$REZICS_SMOKE_FAIL_STEP" = "$1" ]; then echo "injected $1 failure" >&2; exit 7; fi
case "$1" in
  start) printf '{"status":"waiting","session":"%s","checks":["%s"]}\\n' "$REZICS_SMOKE_SESSION" "$REZICS_SMOKE_CHECK_ID" ;;
  wake) test -f "$REZICS_SMOKE_RESULT" && grep -q '"exitCode":0' "$REZICS_SMOKE_RESULT" && echo "result passed" ;;
  success) printf '{"status":"success","summary":"done"}\\n' ;;
  *) exit 8 ;;
esac
`,
  );
  chmodSync(agent, 0o755);
  return { directory, agent };
}

test('smoke validates a real-shaped waiting id, the passing result, and a success exit', async () => {
  const fixture = structuredFakeAgent();
  const lines: string[] = [];
  try {
    await expect(runLaunchSmoke(fixture.agent, { root, report: (line) => lines.push(line) })).resolves.toBeUndefined();
    expect(lines).toEqual(['start: passed', 'wake: passed', 'success: passed']);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('smoke reports which fake-agent step fails', async () => {
  const fixture = structuredFakeAgent();
  try {
    for (const step of ['start', 'wake', 'success']) {
      const lines: string[] = [];
      await expect(
        runLaunchSmoke(fixture.agent, {
          root,
          env: { REZICS_SMOKE_FAIL_STEP: step },
          report: (line) => lines.push(line),
        }),
      ).rejects.toThrow(`${step}:`);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith(`${step}: failed:`)).toBe(true);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('script exits nonzero and names each failed fake-agent step', async () => {
  const fixture = structuredFakeAgent();
  try {
    for (const step of ['start', 'wake', 'success']) {
      const lines: string[] = [];
      const exitCode = await main(() =>
        runLaunchSmoke(fixture.agent, {
          root,
          env: { REZICS_SMOKE_FAIL_STEP: step },
          report: (line) => lines.push(line),
        }),
      );
      expect(exitCode).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.startsWith(`${step}: failed:`)).toBe(true);
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('launch smoke accepts one explicit evidence report path and rejects ambiguous arguments', () => {
  expect(parseSmokeArguments(['--report', '.temp/goal/lifecycle-smoke/manual.json'])).toEqual({
    reportPath: '.temp/goal/lifecycle-smoke/manual.json',
  });
  expect(() => parseSmokeArguments(['--report'])).toThrow('--report requires a path');
  expect(() => parseSmokeArguments(['--unknown'])).toThrow('unknown launch-smoke argument: --unknown');
  expect(() => parseSmokeArguments(['--report', 'one.json', '--report', 'two.json'])).toThrow(
    '--report can be supplied only once',
  );
  expect(resolveSmokeReportPath(root, '.temp/goal/lifecycle-smoke/manual.json')).toBe(
    join(root, '.temp/goal/lifecycle-smoke/manual.json'),
  );
  expect(() => resolveSmokeReportPath(root, '../outside.json')).toThrow(
    'lifecycle report path must stay inside the worktree',
  );
});

test('launch smoke refuses report paths that traverse a symlink out of the worktree', () => {
  const link = join(root, '.temp/goal/lifecycle-smoke', `report-link-${randomUUID()}`);
  mkdirSync(join(root, '.temp/goal/lifecycle-smoke'), { recursive: true });
  symlinkSync(tmpdir(), link, 'dir');
  try {
    expect(() => resolveSmokeReportPath(root, `${relative(root, link)}/report.json`)).toThrow(
      'lifecycle report path cannot traverse a symbolic link',
    );
  } finally {
    rmSync(link, { force: true });
  }
});

test('launch smoke path list covers the launch path, schema, agents, and prompt in launch.ts', () => {
  const launchPaths = [
    'tools/goal/src/launch.ts',
    'tools/goal/src/settle.ts',
    'tools/goal/src/job.ts',
    'tools/goal/src/records.ts',
    'tools/goal/src/worker-slice.ts',
    'tools/goal/src/agent-adapter.ts',
    'tools/goal/src/codex-agent.ts',
    'tools/goal/src/agents/codex.ts',
    'tools/goal/worker-result.schema.json',
  ];
  expect(launchPaths.every((path) => launchSmokeRequired([path]))).toBe(true);
  expect(launchSmokeRequired(['tools/goal/src/landing.ts'])).toBe(false);
});

import { openDb } from './db.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { WorkerStore } from './store.ts';
import { repository } from './test-support.ts';
import type { AttemptFence, GateOutcome } from './contracts.ts';

function landingFixture(path: string) {
  const repo = repository();
  mkdirSync(join(repo.main, path, '..'), { recursive: true });
  writeFileSync(join(repo.main, path), 'base\n');
  git(repo.main, 'add', '--', path);
  git(repo.main, 'commit', '-m', 'Smoke fixture base');
  git(repo.main, 'branch', 'dev', 'main');
  const request = repo.branch('smoke-candidate', path, 'candidate\n');
  const stateDirectory = join(repo.path, 'state');
  mkdirSync(stateDirectory, { recursive: true });
  const db = openDb(join(stateDirectory, 'goal.sqlite'));
  const store = new WorkerStore(db);
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
Exercise candidate gating.
`,
    readRiskOwnership(join(import.meta.dir, '../risk-areas.json')),
  );
  store.createTask(
    brief,
    {
      briefPath: join(stateDirectory, 'brief.md'),
      worktree: request.worktree,
      branch: request.branch,
      base: git(repo.main, 'rev-parse', 'main'),
    },
    'implementation',
    request.taskId,
  );
  const fence: AttemptFence = {
    assertCurrent() {},
    commitMerge(_, merge) {
      return merge();
    },
  };
  const queue = new SqliteLandingQueue(db, fence);
  queue.enqueue(request);
  const outcomes: GateOutcome[] = [];
  return {
    ...repo,
    outcomes,
    options: {
      mainCheckout: repo.main,
      stateDirectory,
      worktreeRoot: join(repo.path, 'trees'),
      integrationBranch: 'dev',
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

test('a control-plane launch-path landing runs the smoke on the checked candidate and lands only if it passes', async () => {
  for (const passed of [true, false]) {
    const s = landingFixture('tools/goal/src/launch.ts');
    const order: string[] = [];
    try {
      await new MergeTrain({
        ...s.options,
        runGate: async () => {
          order.push('check');
          return { passed: true, output: '', timedOut: false };
        },
        runLaunchSmoke: async (command, cwd) => {
          order.push('smoke');
          expect(command).toEqual(['bun', 'tools/goal/scripts/launch-smoke.ts']);
          expect(readFileSync(join(cwd, 'tools/goal/src/launch.ts'), 'utf8')).toBe('candidate\n');
          return {
            passed,
            output: passed ? 'success: passed' : 'wake: failed: injected resume failure',
            timedOut: false,
          };
        },
      }).run();
      expect(order.at(-1)).toBe('smoke');
      expect(order.filter((step) => step === 'check').length).toBeGreaterThan(1);
      expect(s.outcomes[0]?.passed).toBe(passed);
      expect(readFileSync(join(s.main, 'tools/goal/src/launch.ts'), 'utf8')).toBe(passed ? 'candidate\n' : 'base\n');
      if (!passed) expect(s.outcomes[0]?.firstFailure?.assertion).toContain('wake: failed: injected resume failure');
    } finally {
      s.close();
    }
  }
});

test('a control-plane landing outside the worker launch path does not run the smoke', async () => {
  const s = landingFixture('tools/goal/src/unrelated.ts');
  let smokeRuns = 0;
  try {
    await new MergeTrain({
      ...s.options,
      runGate: async () => ({ passed: true, output: '', timedOut: false }),
      runLaunchSmoke: async () => {
        smokeRuns++;
        return { passed: true, output: '', timedOut: false };
      },
    }).run();
    expect(smokeRuns).toBe(0);
    expect(s.outcomes[0]?.passed).toBe(true);
    expect(existsSync(join(s.main, 'tools/goal/src/unrelated.ts'))).toBe(true);
  } finally {
    s.close();
  }
});

test('smoke cleanup removes its immutable store without changing outside symlink or hardlink targets', async () => {
  const holder = mkdtempSync(join(root, '.temp/launch-smoke-cleanup-'));
  const owned = createSmokeDirectory(holder, 'launch-smoke-test-');
  const sibling = createSmokeDirectory(holder, 'launch-smoke-test-');
  const outside = join(holder, 'live-dependency-store');
  mkdirSync(outside);
  const sentinel = join(outside, 'sentinel');
  writeFileSync(sentinel, 'outside content');
  chmodSync(sentinel, 0o444);
  chmodSync(outside, 0o555);
  writeFileSync(join(sibling.path, 'sentinel'), 'another smoke');
  const store = join(owned.path, 'dependency-stores/hash/node_modules/.bun/package');
  mkdirSync(store, { recursive: true });
  linkSync(sentinel, join(store, 'hardlink'));
  symlinkSync(outside, join(owned.path, 'outside-store'), 'dir');
  symlinkSync(sentinel, join(store, 'outside-file'));
  symlinkSync(sibling.path, join(owned.path, 'another-smoke'), 'dir');
  for (const path of [
    store,
    join(store, '..'),
    join(store, '../..'),
    join(store, '../../..'),
    join(owned.path, 'dependency-stores'),
    owned.path,
  ])
    chmodSync(path, 0o555);
  const beforeFile = lstatSync(sentinel);
  const beforeDirectory = lstatSync(outside);
  const beforeSibling = lstatSync(sibling.path);
  const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: outside, stdio: 'ignore' });
  try {
    owned.remove();
    expect(existsSync(owned.path)).toBe(false);
    expect(lstatSync(sentinel).ino).toBe(beforeFile.ino);
    expect(lstatSync(sentinel).mode).toBe(beforeFile.mode);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside content');
    expect(lstatSync(outside).mode).toBe(beforeDirectory.mode);
    expect(lstatSync(outside).ino).toBe(beforeDirectory.ino);
    expect(lstatSync(sibling.path).mode).toBe(beforeSibling.mode);
    expect(lstatSync(sibling.path).ino).toBe(beforeSibling.ino);
    expect(readFileSync(join(sibling.path, 'sentinel'), 'utf8')).toBe('another smoke');
    expect(survivor.exitCode).toBeNull();
    expect(process.kill(survivor.pid!, 0)).toBe(true);
  } finally {
    if (survivor.exitCode === null && survivor.signalCode === null) {
      const exited = new Promise((done) => survivor.once('close', done));
      survivor.kill();
      await exited;
    }
    owned.remove();
    sibling.remove();
    chmodSync(outside, 0o755);
    rmSync(holder, { recursive: true, force: true });
  }
});

test('smoke worker root cleanup safely removes its own immutable dependency cache', () => {
  const holder = mkdtempSync(join(root, '.temp/launch-smoke-worker-root-'));
  const workerRoot = createSmokeDirectory(holder, 'launch-smoke-workers-');
  const outside = join(holder, 'live-dependency-store');
  mkdirSync(outside);
  const sentinel = join(outside, 'sentinel');
  writeFileSync(sentinel, 'outside content');
  chmodSync(sentinel, 0o444);
  chmodSync(outside, 0o555);
  const store = join(workerRoot.path, 'dependency-stores/hash/node_modules/.bun/package');
  mkdirSync(store, { recursive: true });
  linkSync(sentinel, join(store, 'hardlink'));
  symlinkSync(outside, join(workerRoot.path, 'outside-store'), 'dir');
  symlinkSync(sentinel, join(store, 'outside-file'));
  for (const path of [
    store,
    join(store, '..'),
    join(store, '../..'),
    join(store, '../../..'),
    join(workerRoot.path, 'dependency-stores'),
    workerRoot.path,
  ])
    chmodSync(path, 0o555);
  const beforeFile = lstatSync(sentinel);
  const beforeDirectory = lstatSync(outside);
  try {
    workerRoot.remove();
    expect(existsSync(workerRoot.path)).toBe(false);
    expect(lstatSync(sentinel).ino).toBe(beforeFile.ino);
    expect(lstatSync(sentinel).mode).toBe(beforeFile.mode);
    expect(readFileSync(sentinel, 'utf8')).toBe('outside content');
    expect(lstatSync(outside).ino).toBe(beforeDirectory.ino);
    expect(lstatSync(outside).mode).toBe(beforeDirectory.mode);
  } finally {
    workerRoot.remove();
    chmodSync(outside, 0o755);
    rmSync(holder, { recursive: true, force: true });
  }
});

test('smoke cleanup rejects a root replaced by a symlink or another worktree directory', () => {
  for (const replacement of ['symlink', 'directory']) {
    const holder = mkdtempSync(join(root, '.temp/launch-smoke-identity-'));
    const owned = createSmokeDirectory(holder, 'launch-smoke-test-');
    const saved = join(holder, 'original');
    const outside = join(holder, 'other-worktree');
    mkdirSync(outside);
    writeFileSync(join(outside, 'sentinel'), 'keep');
    renameSync(owned.path, saved);
    if (replacement === 'symlink') symlinkSync(outside, owned.path, 'dir');
    else renameSync(outside, owned.path);
    const target = replacement === 'symlink' ? outside : owned.path;
    chmodSync(target, 0o555);
    const before = lstatSync(target);
    try {
      expect(() => owned.remove()).toThrow('Refusing cleanup of replaced smoke directory:');
      expect(readFileSync(join(owned.path, 'sentinel'), 'utf8')).toBe('keep');
      expect(lstatSync(replacement === 'symlink' ? outside : owned.path).mode).toBe(before.mode);
      expect(lstatSync(replacement === 'symlink' ? outside : owned.path).ino).toBe(before.ino);
      expect(existsSync(saved)).toBe(true);
    } finally {
      chmodSync(target, 0o755);
      if (replacement === 'symlink') unlinkSync(owned.path);
      else renameSync(owned.path, outside);
      rmSync(holder, { recursive: true, force: true });
    }
  }
});

test('smoke cleanup rejects replacement of its parent with an outside symlink', () => {
  const holder = mkdtempSync(join(root, '.temp/launch-smoke-identity-'));
  const owned = createSmokeDirectory(holder, 'launch-smoke-test-');
  const saved = join(holder, 'original-parent');
  const outside = join(holder, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'keep');
  const before = lstatSync(outside);
  renameSync(join(holder, '.temp'), saved);
  symlinkSync(outside, join(holder, '.temp'), 'dir');
  try {
    expect(() => owned.remove()).toThrow('Refusing cleanup of replaced smoke directory:');
    expect(lstatSync(outside).ino).toBe(before.ino);
    expect(lstatSync(outside).mode).toBe(before.mode);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('keep');
  } finally {
    unlinkSync(join(holder, '.temp'));
    rmSync(holder, { recursive: true, force: true });
  }
});

test('a failed smoke preserves its original failure after cleaning an immutable disposable store', async () => {
  const fixture = structuredFakeAgent();
  const directoryFile = join(fixture.directory, 'smoke-directory');
  writeFileSync(
    fixture.agent,
    `#!/usr/bin/env bun
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.REZICS_SMOKE_RESULT.split('/.temp/goal/checks/results/')[0];
writeFileSync(${JSON.stringify(directoryFile)}, directory);
const store = join(directory, 'dependency-stores/hash/node_modules/.bun/package');
mkdirSync(store, { recursive: true });
writeFileSync(join(store, 'file'), 'private fixture');
for (const path of [store, join(store, '..'), join(store, '../..')]) chmodSync(path, 0o555);
process.stderr.write('injected start failure');
process.exit(7);
`,
  );
  const lines: string[] = [];
  try {
    let failure: unknown;
    try {
      await runLaunchSmoke(fixture.agent, { root, report: (line) => lines.push(line) });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('start: injected start failure');
    expect(lines).toEqual(['start: failed: injected start failure']);
    expect(existsSync(readFileSync(directoryFile, 'utf8'))).toBe(false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
