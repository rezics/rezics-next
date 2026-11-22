import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export type JavaRuntime = { executable: string; major: number; architecture: string };

type ProbeOptions = { requiredMajor?: number; signal?: AbortSignal; timeoutMs?: number };

const probeArgs = ['-XshowSettings:properties', '-version'];
const outputLimit = 32_768;
const javaOverrides = new Set([
  '_JAVA_OPTIONS',
  'JAVA_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'IBM_JAVA_OPTIONS',
]);
const architectures = new Map([
  ['amd64', 'x64'],
  ['x86_64', 'x64'],
  ['aarch64', 'arm64'],
  ['x86', 'ia32'],
  ['i386', 'ia32'],
  ['i486', 'ia32'],
  ['i586', 'ia32'],
  ['i686', 'ia32'],
  ['armv7l', 'arm'],
  ['ppc64le', 'ppc64'],
]);

export function javaEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !javaOverrides.has(key.toUpperCase())));
}

function localAbsolutePath(file: string): boolean {
  return (
    isAbsolute(file) &&
    !/[\u0000-\u001f]/u.test(file) &&
    (process.platform !== 'win32' || /^(?:\\\\\?\\)?[a-z]:[\\/]/iu.test(file))
  );
}

function javaFileName(file: string): string {
  return process.platform === 'win32' ? basename(file).toLowerCase() : basename(file);
}

async function resolveExecutable(file: string): Promise<string> {
  const windows = process.platform === 'win32';
  const consoleName = windows ? 'java.exe' : 'java';
  const selectionHint = windows
    ? 'Choose a local Java bin\\java.exe or switch to managed Java.'
    : 'Choose a local Java bin/java or switch to managed Java.';
  if (
    !localAbsolutePath(file) ||
    (javaFileName(file) !== consoleName && !(windows && javaFileName(file) === 'javaw.exe'))
  ) {
    throw new Error(selectionHint);
  }

  try {
    let executable = await realpath(file);
    if (windows && javaFileName(executable) === 'javaw.exe') {
      const directory = dirname(executable);
      executable = await realpath(join(directory, consoleName));
      if (dirname(executable).toLowerCase() !== directory.toLowerCase()) throw new Error(selectionHint);
    }
    if (
      !localAbsolutePath(executable) ||
      javaFileName(executable) !== consoleName ||
      !(await stat(executable)).isFile()
    ) {
      throw new Error(selectionHint);
    }
    await access(executable, constants.X_OK);
    return executable;
  } catch {
    throw new Error(`The selected Java executable could not be opened. ${selectionHint}`);
  }
}

function runProbe(executable: string, timeout: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, probeArgs, {
      cwd: dirname(executable),
      env: javaEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const hint = 'Choose another Java executable or switch to managed Java.';
    let bytes = 0;
    let failure: Error | undefined;

    function stop(error: Error) {
      if (failure) return;
      failure = error;
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill('SIGKILL');
    }

    function collect(chunks: Buffer[]) {
      return (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > outputLimit) stop(new Error(`Java returned too much output. ${hint}`));
        else chunks.push(chunk);
      };
    }

    const abort = () => stop(new Error('The Java compatibility check was cancelled.'));
    const timer = setTimeout(() => stop(new Error(`The Java compatibility check did not finish. ${hint}`)), timeout);
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', () => {
      failure ??= new Error(`Java could not be verified. ${hint}`);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Java could not be verified. ${hint}`));
      else resolve(`${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

function describeRuntime(output: string): Omit<JavaRuntime, 'executable'> {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(java\.version|os\.arch)\s*=\s*(\S+)\s*$/u.exec(line);
    if (match?.[1] && match[2]) properties.set(match[1], match[2]);
  }
  const major = Number(/^(?:1\.)?([1-9]\d*)(?=[._+\-]|$)/u.exec(properties.get('java.version') ?? '')?.[1]);
  const architecture = (properties.get('os.arch') ?? '').toLowerCase();
  if (!Number.isSafeInteger(major) || !/^[a-z][a-z0-9_]*$/u.test(architecture)) {
    throw new Error(
      'Java did not report its version and architecture. Choose another Java executable or use managed Java.',
    );
  }
  return { major, architecture: architectures.get(architecture) ?? architecture };
}

export async function probeJavaRuntime(file: string, options: ProbeOptions = {}): Promise<JavaRuntime> {
  const { signal, requiredMajor } = options;
  signal?.throwIfAborted();
  const executable = await resolveExecutable(file);
  signal?.throwIfAborted();
  const timeout = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 15_000) throw new Error('Invalid Java probe timeout.');
  const output = await runProbe(executable, timeout, signal);
  const runtime = describeRuntime(output);
  const windows = process.platform === 'win32';
  const expectedArchitecture = windows ? 'x64' : process.arch;
  if (runtime.architecture !== expectedArchitecture) {
    const target = windows ? 'Windows x64' : expectedArchitecture;
    throw new Error(
      `Java reported ${runtime.architecture}. Choose a Java runtime for ${target} or switch to managed Java.`,
    );
  }
  if (requiredMajor !== undefined && runtime.major !== requiredMajor) {
    throw new Error(
      `This Minecraft release requires Java ${requiredMajor}. The selected runtime is Java ${runtime.major}. Choose Java ${requiredMajor} or switch to managed Java.`,
    );
  }
  return { executable, ...runtime };
}
