import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export interface WorkerPreview {
  root: string; directory: string; env: NodeJS.ProcessEnv; port: string; buildFailure: string;
  buildCommand?: readonly string[]; serveCommand?: readonly string[];
}
function command(override: readonly string[] | undefined, fallback: readonly string[]): [string, ...string[]] {
  const [tool, ...args] = override ?? fallback;
  if (!tool) throw new Error('Preview command is empty');
  return [tool, ...args];
}

/** Build, release `holderPid` when set, then serve so the worker binds only after that release. */
export async function runWorkerPreview(preview: WorkerPreview, holderPid = 0): Promise<void> {
  const [build, ...buildArgs] = command(preview.buildCommand, [join(preview.root, 'node_modules/.bin/vinext'), 'build']);
  const built = spawnSync(build, buildArgs, { cwd: preview.directory, env: preview.env, stdio: 'inherit' });
  if (built.error || built.status !== 0) throw built.error ?? new Error(preview.buildFailure);
  if (Number.isInteger(holderPid) && holderPid > 0) {
    const { releaseHeldWebPort } = await import('../qa/e2e.ts');
    await releaseHeldWebPort(holderPid, Number(preview.port));
  }
  const [serve, ...serveArgs] = command(preview.serveCommand, [join(preview.root, 'node_modules/.bin/wrangler'), 'dev',
    '--config', 'dist/server/wrangler.json', '--ip', '127.0.0.1', '--port', preview.port]);
  const worker = spawn(serve, serveArgs, { cwd: preview.directory, env: preview.env, stdio: 'inherit' });
  const stop = () => worker.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const code = await new Promise<number | null>(resolveExit => worker.once('exit', resolveExit));
  process.off('SIGINT', stop); process.off('SIGTERM', stop);
  if (code !== 0 && code !== null) process.exitCode = code;
}
