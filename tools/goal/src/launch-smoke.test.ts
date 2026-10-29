import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { main, runLaunchSmoke } from '../scripts/launch-smoke.ts';
import { launchSmokeRequired } from './merge-train.ts';

test('smoke drives start, waiting, wake result and success with a fake agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-smoke-agent-'));
  const agent = join(dir, 'agent');
  writeFileSync(agent, '#!/bin/sh\ncase "$1" in\nstart) echo "waiting worker-check-abc123";;\nwake) test "$REZICS_SMOKE_CHECK_ID" = worker-check-abc123 && echo "result passed";;\nsuccess) echo success;;\nesac\n');
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
    await expect(
      runLaunchSmoke(fixture.agent, { root, report: (line) => lines.push(line) }),
    ).resolves.toBeUndefined();
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
