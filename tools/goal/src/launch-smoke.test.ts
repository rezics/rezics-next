import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { main, runLaunchSmoke } from '../scripts/launch-smoke.ts';
import { launchSmokeRequired } from './merge-train.ts';

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

import { existsSync, readFileSync } from 'node:fs';
import { openDb } from './db.ts';
import { parseBrief, readRiskOwnership } from './briefs.ts';
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
