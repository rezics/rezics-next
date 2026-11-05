import { spawn } from 'node:child_process';
import { text } from 'node:stream/consumers';
import options from '../project.inlang/paraglide.config.ts';

const compilerModule = process.env.REZICS_PARAGLIDE_COMPILER_MODULE ?? '@inlang/paraglide-js';
const { compile } = await import(compilerModule);

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
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename], {
      cwd: process.cwd(),
      env: { ...process.env, [workerEnvironment]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
    const [exitCode, stdout, stderr] = await Promise.all([exited, text(child.stdout), text(child.stderr)]);
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
      if (exitCode !== 0) process.exitCode = exitCode;
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
    process.exitCode = exitCode || 1;
    break;
  }
}
