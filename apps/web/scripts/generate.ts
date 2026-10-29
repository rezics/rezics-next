import { compile } from '@inlang/paraglide-js';
import options from '../project.inlang/paraglide.config';

const workerEnvironment = 'REZICS_PARAGLIDE_GENERATE_WORKER';
const errorMarker = '\0REZICS_PARAGLIDE_GENERATE_ERROR\0';

if (process.env[workerEnvironment] === '1') {
  try {
    await compile({ project: './project.inlang', ...options });
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    process.stderr.write(
      `${errorMarker}${JSON.stringify({ message: failure.message, code: 'code' in failure ? failure.code : undefined, stack: failure.stack })}\n`,
    );
    process.exitCode = 1;
  }
} else {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const result = Bun.spawnSync([process.execPath, import.meta.filename], {
      cwd: process.cwd(),
      env: { ...process.env, [workerEnvironment]: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    const markerIndex = stderr.lastIndexOf(errorMarker);
    const workerError =
      markerIndex < 0
        ? undefined
        : (JSON.parse(stderr.slice(markerIndex + errorMarker.length).trim()) as {
            message: string;
            code?: string;
            stack?: string;
          });

    if (!workerError) {
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
      break;
    }

    process.stdout.write(stdout);
    process.stderr.write(stderr.slice(0, markerIndex));
    const retryable = workerError.code?.startsWith('LIX_') === true || /^(?:Lix |LixError)/u.test(workerError.message);
    if (retryable && attempt < maximumAttempts) {
      const firstLine = workerError.message.split(/\r?\n/u, 1)[0];
      process.stderr.write(
        `Retrying Paraglide compilation (attempt ${attempt + 1}/${maximumAttempts}): ${firstLine}\n`,
      );
      continue;
    }

    process.stderr.write(`${workerError.stack ?? workerError.message}\n`);
    process.exitCode = result.exitCode || 1;
    break;
  }
}
