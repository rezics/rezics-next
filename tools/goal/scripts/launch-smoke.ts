import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Step = 'start' | 'wake' | 'success';
const root = resolve(import.meta.dir, '../../../..');
const timeoutMs = 300_000;

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timed out')); }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolveRun({ code: code ?? 1, output }); });
  });
}

export async function runLaunchSmoke(agent: string, args: string[] = []): Promise<void> {
  const tree = mkdtempSync(join(tmpdir(), 'rezics-launch-smoke-'));
  const worktree = join(tree, 'candidate');
  const runGit = (argv: string[]) => {
    const result = Bun.spawnSync(['git', ...argv], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  try {
    runGit(['worktree', 'add', '--detach', worktree, 'HEAD']);
    let workerCheckId = '';
    for (const step of ['start', 'wake', 'success'] as const) {
      const result = await run(agent, [...args, step], worktree, {
        ...process.env,
        REZICS_SMOKE_WORKTREE: worktree,
        REZICS_SMOKE_CHECK_ID: workerCheckId,
      });
      if (result.code !== 0) throw new Error(`${step}: ${result.output || `agent exited ${result.code}`}`);
      const state = result.output.trim().split('\n').at(-1) ?? '';
      if (step === 'start') {
        const match = state.match(/^waiting (\S+)$/);
        if (!match || !/^worker-check-[A-Za-z0-9_-]+$/.test(match[1]!))
          throw new Error(`start: expected waiting with a worker-check id; got ${state}`);
        workerCheckId = match[1]!;
      } else if (step === 'wake' && state !== 'result passed') {
        throw new Error(`wake: expected worker-check result; got ${state}`);
      } else if (step === 'success' && state !== 'success') {
        throw new Error(`success: expected success exit; got ${state}`);
      }
      console.log(`${step}: passed`);
    }
  } finally {
    const result = Bun.spawnSync(['git', 'worktree', 'remove', '--force', worktree], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) console.error(result.stderr.toString());
    rmSync(tree, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const agent = process.env.REZICS_LAUNCH_SMOKE_AGENT ?? 'codex';
  const args = process.env.REZICS_LAUNCH_SMOKE_AGENT ? [] : ['exec', '--json', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort=low'];
  runLaunchSmoke(agent, args).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message.includes(':') ? message : `start: ${message}`);
    process.exitCode = 1;
  });
}
