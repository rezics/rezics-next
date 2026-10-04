import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

/** Every profile process owns its sink/SDK. Drain both pipes while it runs and
 * reap it before returning, including a deadline or failed calibration. */
export async function runWorkProfileChild(
  entry: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ stdout: string; resultPath: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1)
    throw new Error('Invalid work profile child deadline');
  const resultPath = resolve(
    root,
    '.temp/work-profiles',
    `${process.env.REZICS_QA_RUN_ID ?? process.pid}-${crypto.randomUUID()}.json`,
  );
  const child = Bun.spawn([process.execPath, resolve(root, entry)], {
    cwd: root,
    env: { ...process.env, ...options.env, REZICS_WORK_PROFILE_RESULT: resultPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 1000);
  }, timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`Work profile child ${entry} exceeded ${timeoutMs}ms`);
    if (code !== 0)
      throw new Error(
        `Work profile child ${entry} failed (${code}): ${stderr}\n${stdout.slice(-2000)}`,
      );
    return { stdout, resultPath };
  } finally {
    clearTimeout(deadline);
    if (force) clearTimeout(force);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
