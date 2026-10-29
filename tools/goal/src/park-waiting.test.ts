import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadSettings } from './config.ts';
import { launchCommand, workerPrompt } from './launch.ts';
import type { Pool, Profile, Task } from './types.ts';
import { harness } from './test-support.ts';

const repository = resolve(import.meta.dir, '../../..');
// scripts/worker-check.ts is dev tooling; on main (where the control plane runs) it arrives with promotion.
const hasWorkerCheck = existsSync(join(repository, 'scripts/worker-check.ts'));

test.skipIf(!hasWorkerCheck)(
  'a worker waiting for a check is not woken by the model loop until the check ends or prints a failure',
  async () => {
    mkdirSync(join(repository, '.temp'), { recursive: true });
    const root = mkdtempSync(join(repository, '.temp', 'park-waiting-'));
    mkdirSync(join(root, '.temp'), { recursive: true });
    const waitFile = join(root, '.temp', 'check-wait');
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let output = '';
    let stderr = '';
    try {
      child = Bun.spawn(
        [
          process.execPath,
          join(repository, 'scripts/worker-check.ts'),
          '--',
          'sh',
          '-c',
          "printf 'worker check running\\n'; sleep 1; printf 'FAIL: check assertion failed\\n'; exit 7",
        ],
        {
          cwd: root,
          env: { ...process.env, GOAL_CHECK_WAIT_FILE: waitFile },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const stdoutStream = child.stdout;
      const stderrStream = child.stderr;
      if (!stdoutStream || typeof stdoutStream === 'number' || !stderrStream || typeof stderrStream === 'number') {
        throw new Error('The worker check did not expose piped output streams');
      }
      const collect = async (stream: ReadableStream<Uint8Array>, append: (value: string) => void): Promise<void> => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (value) append(decoder.decode(value, { stream: !done }));
          if (done) break;
        }
      };
      const stdout = collect(stdoutStream, (value) => (output += value));
      const errors = collect(stderrStream, (value) => (stderr += value));

      await Bun.sleep(250);
      expect(child.exitCode).toBeNull();
      expect(output).toBe('');
      expect(
        readFileSync(waitFile, 'utf8')
          .split('\n')
          .some((value) => Number(value) > 0),
      ).toBe(true);

      expect(await child.exited).toBe(7);
      await Promise.all([stdout, errors]);
      expect(stderr).toBe('');
      expect(output).toContain('check: exit status 7');
      expect(output).toContain('check: failure summary');
      expect(output).toContain('FAIL: check assertion failed');
      expect(output).toContain('check: log .temp/goal/checks/worker-check-');
      expect(output).not.toContain('worker check running');
    } finally {
      if (child?.exitCode === null) {
        child.kill();
        await child.exited;
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('the worker protocol tells workers to run checks in the foreground and never poll', () => {
  const h = harness();
  try {
    const settings = loadSettings({ cwd: h.root, env: {} });
    expect(settings.codex.backgroundTerminalMaxTimeoutMs).toBe(7_200_000);

    const profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high' } as Profile;
    const pool = { cli: 'codex', command: 'codex', configDirectory: '/tmp/no-codex-config' } as Pool;
    const [, args] = launchCommand({
      profile,
      pool,
      worktree: h.root,
      prompt: 'check prompt',
      logPath: join(h.root, '.temp', 'worker.jsonl'),
      codex: settings.codex,
    });
    expect(args).toContain('features.unified_exec=true');
    expect(args).toContain('background_terminal_max_timeout=7200000');

    const task = {
      worktree: h.root,
      branch: 'worker/test',
      brief: { markdown: 'Check the change.', kind: 'implementation' },
    } as unknown as Task;
    // A base without the wrapper (a stabilize cut older than it) is told to run checks directly.
    const bare = workerPrompt(task, undefined, undefined, [], h.root);
    expect(bare).toContain('This base has no scripts/worker-check.ts');
    // Checks can queue for a long time; uncommitted work at the class time limit was classified as stalled.
    expect(bare).toContain('before you start a check');
    expect(bare).not.toContain('bun scripts/worker-check.ts -- <command...>');
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/worker-check.ts'), '');
    const prompt = workerPrompt(task, undefined, undefined, [], h.root);
    expect(prompt).toContain('one foreground command');
    expect(prompt).toContain('bun scripts/worker-check.ts -- <command...>');
    // One 300 s tool wait was the whole budget: workers ended attempts while their checks ran (2026-10-28).
    expect(prompt).toContain('again and again until it prints an exit status');
    expect(prompt).toContain('never finish your attempt while a check you started is still running');
  } finally {
    h.dispose();
  }
});
