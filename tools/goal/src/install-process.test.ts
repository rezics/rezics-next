import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BoundedProcessError, runBoundedInstallProcess } from './install-process.ts';
import { temporaryDirectory } from './test-support.ts';

function isAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && isAlive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(isAlive(pid)).toBe(false);
}

function captureFailure(action: () => unknown): BoundedProcessError {
  try {
    action();
  } catch (error) {
    if (error instanceof BoundedProcessError) return error;
    throw error;
  }
  throw new Error('Expected the bounded process to fail');
}

test(
  'a timed out install kills its hanging descendant within the termination budget and names installer output',
  async () => {
    const h = temporaryDirectory();
    try {
      const pidFile = join(h.path, 'descendant.pid');
      const started = performance.now();
      const error = captureFailure(() =>
        runBoundedInstallProcess({
          command: 'sh',
          args: [
            '-c',
            `echo 'Installing package @fixture/hanging-dependency@1.2.3' >&2; sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`,
          ],
          cwd: h.path,
          step: 'bun install --frozen-lockfile',
          limits: { startupMs: 2_000, runMs: 250, terminationMs: 500 },
        }),
      );

      expect(performance.now() - started).toBeLessThan(2_000);
      expect(error.infrastructure).toBe(true);
      expect(error.timedOut).toBe(true);
      expect(error.phase).toBe('run');
      expect(error.step).toBe('bun install --frozen-lockfile');
      expect(error.packageName).toBe('@fixture/hanging-dependency');
      expect(error.message).toContain('workspace=');
      expect(error.stderr).toContain('Installing package @fixture/hanging-dependency@1.2.3');
      await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
    } finally {
      h.close();
    }
  },
  10_000,
);

test('a failed command also reaps its process group while preserving install diagnostics', async () => {
  const h = temporaryDirectory();
  try {
    const pidFile = join(h.path, 'descendant.pid');
    const error = captureFailure(() =>
      runBoundedInstallProcess({
        command: 'sh',
        args: ['-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; echo fixture-install-error >&2; exit 7`],
        cwd: h.path,
        step: 'bun install --frozen-lockfile',
        limits: { startupMs: 2_000, runMs: 2_000, terminationMs: 500 },
      }),
    );

    expect(error.timedOut).toBe(false);
    expect(error.infrastructure).toBe(false);
    expect(error.exitCode).toBe(7);
    expect(error.stderr).toContain('fixture-install-error');
    await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
  } finally {
    h.close();
  }
});

test('a successful install keeps its artifact and output', () => {
  const h = temporaryDirectory();
  try {
    const artifact = join(h.path, 'installed.txt');
    const result = runBoundedInstallProcess({
      command: 'sh',
      args: ['-c', `printf installed > '${artifact}'; printf 'install complete\\n'`],
      cwd: h.path,
      step: 'bun install --frozen-lockfile',
      limits: { startupMs: 2_000, runMs: 2_000, terminationMs: 500 },
    });

    expect(readFileSync(artifact, 'utf8')).toBe('installed');
    expect(result.stdout).toBe('install complete\n');
    expect(result.code).toBe(0);
  } finally {
    h.close();
  }
});

function gateFixture(script: string) {
  const h = temporaryDirectory();
  const workspace = join(h.path, 'tools/goal');
  const bin = join(h.path, 'bin');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: '@fixture/goal' }));
  writeFileSync(join(bin, 'bun'), script, { mode: 0o755 });
  return { ...h, bin };
}

async function invokeGoalGate(root: string, bin: string, limits: object) {
  const gateModule = new URL('../scripts/gate.ts', import.meta.url).href;
  const source = `import { runGoalGate } from ${JSON.stringify(gateModule)}; process.exitCode = runGoalGate(${JSON.stringify(root)}, ${JSON.stringify(limits)});`;
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: `${stdout}${stderr}` };
}

test(
  'the Goal gate bounds install setup, reports the exact step and workspace, and does not start checks after timeout',
  async () => {
    const fixture = gateFixture(
      `#!/bin/sh\necho 'Installing package @fixture/gate-dependency@2.0.0' >&2\nsleep 30 >/dev/null 2>&1 & echo $! > '../../gate-descendant.pid'\nwait\n`,
    );
    try {
      const pidFile = join(fixture.path, 'gate-descendant.pid');
      const started = performance.now();
      const result = await invokeGoalGate(
        fixture.path,
        fixture.bin,
        { install: { startupMs: 2_000, runMs: 250, terminationMs: 500 } },
      );

      expect(performance.now() - started).toBeLessThan(2_500);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('ETIMEDOUT: Infrastructure failure');
      expect(result.output).toContain('step="bun install --frozen-lockfile"');
      expect(result.output).toContain('workspace="@fixture/goal"');
      expect(result.output).toContain('package="@fixture/gate-dependency"');
      expect(result.output).not.toContain('bun run check');
      await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
    } finally {
      fixture.close();
    }
  },
  10_000,
);

test('the Goal gate still completes successful install and check setup steps', async () => {
  const fixture = gateFixture(
    `#!/bin/sh\nif [ "$1" = "install" ]; then echo goal-install-complete; exit 0; fi\nif [ "$1" = "run" ] && [ "$2" = "check" ]; then echo goal-check-complete; exit 0; fi\nexit 9\n`,
  );
  try {
    const result = await invokeGoalGate(fixture.path, fixture.bin, {});
    expect(result.code).toBe(0);
    expect(result.output).toContain('goal-install-complete');
    expect(result.output).toContain('goal-check-complete');
  } finally {
    fixture.close();
  }
});

test(
  'the Goal gate also bounds its check setup step and reaps its descendants',
  async () => {
    const fixture = gateFixture(
      `#!/bin/sh\nif [ "$1" = "install" ]; then echo goal-install-complete; exit 0; fi\necho goal-check-started\nsleep 30 >/dev/null 2>&1 & echo $! > '../../gate-check-descendant.pid'\nwait\n`,
    );
    try {
      const pidFile = join(fixture.path, 'gate-check-descendant.pid');
      const started = performance.now();
      const result = await invokeGoalGate(fixture.path, fixture.bin, {
        check: { startupMs: 2_000, runMs: 250, terminationMs: 500 },
      });

      expect(performance.now() - started).toBeLessThan(2_500);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('goal-install-complete');
      expect(result.output).toContain('goal-check-started');
      expect(result.output).toContain('step="bun run check"');
      expect(result.output).toContain('workspace="@fixture/goal"');
      expect(result.output).not.toContain('package=');
      await expectStopped(Number(readFileSync(pidFile, 'utf8').trim()));
    } finally {
      fixture.close();
    }
  },
  10_000,
);
