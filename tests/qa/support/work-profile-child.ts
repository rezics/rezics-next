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
  const stdoutPath = `${resultPath}.stdout.log`;
  const stderrPath = `${resultPath}.stderr.log`;
  const failure = (reason: string, stdout = '', stderr = '', cause?: unknown) =>
    new Error(
      `Work profile child ${entry} ${reason}\n` +
        `stdout retained at ${stdoutPath}\nstderr retained at ${stderrPath}\n` +
        `stdout tail (last 2000 characters):\n${stdout.slice(-2000) || '<empty>'}\n` +
        `stderr tail (last 2000 characters):\n${stderr.slice(-2000) || '<empty>'}`,
      { cause },
    );
  // Create both artifacts even when the executable cannot start.
  await Promise.all([Bun.write(stdoutPath, ''), Bun.write(stderrPath, '')]);
  const child = (() => {
    try {
      return Bun.spawn([process.execPath, resolve(root, entry)], {
        cwd: root,
        env: { ...process.env, ...options.env, REZICS_WORK_PROFILE_RESULT: resultPath },
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (cause) {
      throw failure(`could not start: ${String(cause)}`, '', '', cause);
    }
  })();
  let timedOut = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    force = setTimeout(() => child.kill('SIGKILL'), 1000);
  }, timeoutMs);
  try {
    // Stream to disk while the child runs, including output before a deadline.
    // Wait for both drains even if one fails so the process is always reaped.
    const [exit, stdoutCapture, stderrCapture] = await Promise.allSettled([
      child.exited,
      Bun.write(stdoutPath, child.stdout),
      Bun.write(stderrPath, child.stderr),
    ]);
    const [stdout, stderr] = await Promise.all([
      Bun.file(stdoutPath).text(),
      Bun.file(stderrPath).text(),
    ]);
    if (timedOut) throw failure(`exceeded ${timeoutMs}ms`, stdout, stderr);
    if (exit.status === 'rejected')
      throw failure(`could not reap: ${String(exit.reason)}`, stdout, stderr, exit.reason);
    for (const capture of [stdoutCapture, stderrCapture]) {
      if (capture.status === 'rejected')
        throw failure(
          `could not retain output: ${String(capture.reason)}`,
          stdout,
          stderr,
          capture.reason,
        );
    }
    if (exit.value !== 0) throw failure(`failed (${exit.value})`, stdout, stderr);
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
