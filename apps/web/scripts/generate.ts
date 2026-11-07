import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import type { Readable } from 'node:stream';
import options from '../project.inlang/paraglide.config.ts';

const compilerModule = process.env.REZICS_PARAGLIDE_COMPILER_MODULE ?? '@inlang/paraglide-js';

const workerEnvironment = 'REZICS_PARAGLIDE_GENERATE_WORKER';
const errorMarker = '\0REZICS_PARAGLIDE_GENERATE_ERROR\0';
const outputLimit = 128_000;

if (process.env[workerEnvironment] === '1') {
  try {
    process.stdout.write(`[paraglide] stage=compiler-load pid=${process.pid} start\n`);
    const { compile } = await import(compilerModule);
    process.stdout.write(`[paraglide] stage=compile pid=${process.pid} start\n`);
    await compile({ project: './project.inlang', ...options });
    process.stdout.write(`[paraglide] stage=compile pid=${process.pid} complete\n`);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const payload = {
      message: failure.message.slice(0, 16_000),
      code: 'code' in failure ? failure.code : undefined,
      stack: failure.stack?.slice(0, 48_000),
    };
    process.stderr.write(`${errorMarker}${JSON.stringify(payload)}\n`);
    process.exitCode = 1;
  }
} else {
  const maximumAttempts = 3;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.filename], {
      cwd: process.cwd(),
      env: { ...process.env, [workerEnvironment]: '1' },
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
      const forward = () => child.kill(signal);
      process.on(signal, forward);
      return [signal, forward] as const;
    });
    const pid = child.pid;
    process.stderr.write(
      `[paraglide] stage=compiler attempt=${attempt}/${maximumAttempts} pid=${pid ?? 'unknown'} started\n`,
    );

    const captureTail = async (stream: Readable): Promise<string> => {
      let output = '';
      for await (const chunk of stream) {
        output = `${output}${Buffer.from(chunk as Uint8Array).toString()}`.slice(-outputLimit);
      }
      return output;
    };
    const exited = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code: code ?? 1, signal }));
    });
    let status: { code: number; signal: NodeJS.Signals | null };
    let stderr: string;
    try {
      [status, stderr] = await Promise.all([exited, captureTail(child.stderr)]);
    } finally {
      for (const [signal, forward] of forwarders) process.off(signal, forward);
    }
    const markerIndex = stderr.lastIndexOf(errorMarker);
    const workerError =
      markerIndex < 0
        ? undefined
        : (JSON.parse(stderr.slice(markerIndex + errorMarker.length).trim()) as {
            message: string;
            code?: string;
            stack?: string;
          });
    const exitCode = status.signal === null ? status.code : 128 + (osConstants.signals[status.signal] ?? 1);
    process.stderr.write(
      `[paraglide] stage=compiler attempt=${attempt}/${maximumAttempts} pid=${pid ?? 'unknown'} exit=${exitCode}${status.signal ? ` signal=${status.signal}` : ''}\n`,
    );

    if (!workerError) {
      process.stderr.write(stderr);
      if (exitCode !== 0) process.exitCode = exitCode;
      break;
    }

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
