import { createHash } from 'node:crypto';
import { spawn, type SpawnOptions } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  validateCheckRunPreparedDescriptor,
  type CheckRunInvocationBinding,
  type CheckRunPreparedDescriptor,
} from '../../../scripts/check-run-settlement.ts';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const TERMINATION_GRACE_MS = 15_000;
const TERMINATION_SETTLE_MS = 5_000;
const OUTPUT_SETTLE_MS = 5_000;
const HASH = /^[a-f0-9]{64}$/;

export type CheckRunBinding = CheckRunInvocationBinding;
export type PreparedCheckRunDescriptor = CheckRunPreparedDescriptor;

export type WebCheckPrivateFiles = {
  directory: string;
  environmentFile: string;
  descriptorFile: string;
  close: () => void;
};

export type WebCheckDriverProcess = {
  code: number | null;
  signal: NodeJS.Signals | null;
  closed: boolean;
  output: string;
  outputOverflow: boolean;
};

export type WebCheckDriverInvocation = {
  phase: 'prepare' | 'run-prepared';
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onReceipt?: (chunk: Uint8Array) => void;
};

export type WebCheckCustodyRuntime = {
  invoke: (input: WebCheckDriverInvocation) => Promise<WebCheckDriverProcess>;
  cleanup: (files: WebCheckPrivateFiles) => void | Promise<void>;
};

export type WebCheckCustodyOutcome = {
  code: number;
  invocationId: string | null;
  descriptorFile: string;
};

type ExpectedInvocation = {
  sourceRevision: string;
  cwd: string;
  commandSha256: string;
  semanticEnvironmentSha256: string;
  relocatedEnvironmentSha256: string;
  hostsFile: string;
  returnsSha256: string;
};

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonSha256(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function hashEnvironment(values: Record<string, string>, priority: string | null): string {
  return jsonSha256({ values: Object.entries(values).sort(([left], [right]) => left.localeCompare(right)), priority });
}

function expectedInvocation(input: {
  hostsFile: string;
  cwd: string;
  sourceRevision: string;
  command: readonly string[];
  environment: Record<string, string>;
  priority: string | null;
  returns: readonly string[];
}): ExpectedInvocation {
  const hostStats = lstatSync(input.hostsFile);
  if (!hostStats.isFile() || hostStats.isSymbolicLink())
    throw new Error('Web check custody: hosts file is not a regular file');
  const environmentHash = hashEnvironment(input.environment, input.priority);
  return {
    sourceRevision: input.sourceRevision,
    cwd: input.cwd,
    commandSha256: jsonSha256([...input.command]),
    semanticEnvironmentSha256: environmentHash,
    relocatedEnvironmentSha256: environmentHash,
    hostsFile: resolve(input.hostsFile),
    returnsSha256: jsonSha256([...new Set(input.returns)]),
  };
}

function parsePreparedDescriptor(
  output: string,
  files: WebCheckPrivateFiles,
  expected: ExpectedInvocation,
): PreparedCheckRunDescriptor | null {
  if (!output.endsWith('\n') || output.includes('\r') || output.split('\n').length !== 2) return null;
  let descriptor: PreparedCheckRunDescriptor;
  try {
    descriptor = validateCheckRunPreparedDescriptor(JSON.parse(output.slice(0, -1)));
  } catch {
    return null;
  }
  const binding = descriptor.binding;
  if (
    binding.sourceRevision !== expected.sourceRevision ||
    binding.cwd !== expected.cwd ||
    binding.argvSha256 !== expected.commandSha256 ||
    binding.semanticEnvironmentSha256 !== expected.semanticEnvironmentSha256 ||
    binding.relocatedEnvironmentSha256 !== expected.relocatedEnvironmentSha256 ||
    binding.hostsSha256 !== sha256(readFileSync(expected.hostsFile)) ||
    binding.returnsSha256 !== expected.returnsSha256 ||
    !HASH.test(binding.argvSha256)
  )
    return null;
  try {
    const persisted = readFileSync(files.descriptorFile);
    if (!persisted.equals(Buffer.from(output))) return null;
  } catch {
    return null;
  }
  return descriptor;
}

function assertPrivateFiles(files: WebCheckPrivateFiles, workspace: string): void {
  if (![files.directory, files.environmentFile, files.descriptorFile].every(isAbsolute))
    throw new Error('Web check custody: private file paths must be absolute');
  const directory = resolve(files.directory);
  if (
    directory !== files.directory ||
    files.environmentFile !== join(directory, 'environment.json') ||
    files.descriptorFile !== join(directory, 'prepared-descriptor.json')
  )
    throw new Error('Web check custody: private file layout differs from the receiving contract');
  const candidate = realpathSync(workspace);
  const inside = relative(candidate, directory);
  if (inside === '' || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw new Error('Web check custody: private descriptor must be outside candidate source');
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    realpathSync(directory) !== directory ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid())
  )
    throw new Error('Web check custody: invocation directory is not owner-private');
}

export function disposeWebCheckEnvironmentInput(files: WebCheckPrivateFiles): void {
  if (files.environmentFile !== join(resolve(files.directory), 'environment.json'))
    throw new Error('Web check custody: private environment path escaped its invocation directory');
  try {
    const stat = lstatSync(files.environmentFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new Error('Web check custody: private environment input is not an owner-private regular file');
    unlinkSync(files.environmentFile);
    const directory = openSync(files.directory, 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function commandForPrepare(input: {
  driverRoot: string;
  hostsFile: string;
  workspace: string;
  cwd: string;
  sourceRevision: string;
  environmentFile: string;
  descriptorFile: string;
  command: readonly string[];
  returns: readonly string[];
}): string[] {
  return [
    'bun',
    join(input.driverRoot, 'scripts/check-run.ts'),
    'prepare',
    '--descriptor',
    input.descriptorFile,
    '--hosts',
    input.hostsFile,
    '--workspace',
    input.workspace,
    '--cwd',
    input.cwd,
    '--source-revision',
    input.sourceRevision,
    '--env-file',
    input.environmentFile,
    ...input.returns.flatMap((path) => ['--returns', path]),
    '--',
    ...input.command,
  ];
}

function commandForRunPrepared(driverRoot: string, descriptorFile: string): string[] {
  return ['bun', join(driverRoot, 'scripts/check-run.ts'), 'run-prepared', '--descriptor', descriptorFile];
}

function baseEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.WEB_STORYBOOK_LOCAL_PUBLICATION_REVISION === undefined) return env;
  const output = { ...env };
  delete output.WEB_STORYBOOK_LOCAL_PUBLICATION_REVISION;
  return output;
}

function outputCode(result: WebCheckDriverProcess): number {
  if (result.code !== null) return result.code;
  if (result.signal)
    return (
      128 + (result.signal === 'SIGINT' ? 2 : result.signal === 'SIGTERM' ? 15 : result.signal === 'SIGHUP' ? 1 : 0)
    );
  return 75;
}

function signalCode(signal?: AbortSignal): number {
  const reason = signal?.reason;
  if (reason === 129 || reason === 'SIGHUP') return 129;
  if (reason === 130 || reason === 'SIGINT') return 130;
  return 143;
}

async function finishInvocation(
  runtime: WebCheckCustodyRuntime,
  files: WebCheckPrivateFiles,
  code: number,
  invocationId: string | null,
): Promise<WebCheckCustodyOutcome> {
  try {
    disposeWebCheckEnvironmentInput(files);
  } catch {
    /* Best-effort private input removal never replaces this invocation's result. */
  }
  try {
    await runtime.cleanup(files);
  } catch {
    /* Leftover files from this invocation are ignored by the next one. */
  }
  return { code, invocationId, descriptorFile: files.descriptorFile };
}

/** Place this invocation on a host and return its result. Earlier journals never refuse a new run. */
export async function runPreparedWebCheck(
  input: {
    driverRoot: string;
    hostsFile: string;
    workspace: string;
    cwd: string;
    sourceRevision: string;
    command: readonly string[];
    environment: Record<string, string>;
    priority: string | null;
    returns: readonly string[];
    env: NodeJS.ProcessEnv;
    files: WebCheckPrivateFiles;
  },
  runtime: WebCheckCustodyRuntime = webCheckCustodyRuntime,
  signal?: AbortSignal,
): Promise<WebCheckCustodyOutcome> {
  assertPrivateFiles(input.files, input.workspace);
  if (signal?.aborted) return finishInvocation(runtime, input.files, signalCode(signal), null);
  const expected = expectedInvocation(input);
  const command = commandForPrepare({
    ...input,
    environmentFile: input.files.environmentFile,
    descriptorFile: input.files.descriptorFile,
  });
  let prepare: WebCheckDriverProcess;
  try {
    prepare = await runtime.invoke({
      phase: 'prepare',
      command,
      cwd: input.workspace,
      env: baseEnvironment(input.env),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return finishInvocation(runtime, input.files, signal?.aborted ? signalCode(signal) : 75, null);
  }
  if (signal?.aborted) return finishInvocation(runtime, input.files, signalCode(signal), null);
  if (!prepare.closed || prepare.code !== 0 || prepare.outputOverflow)
    return finishInvocation(runtime, input.files, prepare.code === 0 ? 75 : outputCode(prepare), null);
  const descriptor = parsePreparedDescriptor(prepare.output, input.files, expected);
  if (!descriptor) return finishInvocation(runtime, input.files, 75, null);
  let run: WebCheckDriverProcess;
  try {
    run = await runtime.invoke({
      phase: 'run-prepared',
      command: commandForRunPrepared(input.driverRoot, input.files.descriptorFile),
      cwd: input.workspace,
      env: {
        ...baseEnvironment(input.env),
        REMOTE_CHECK_RECEIPT_FD: '3',
        REMOTE_CHECK_RECEIPT_NONCE: descriptor.nonce,
        REMOTE_CHECK_INVOCATION_ID: descriptor.invocationId,
      },
      ...(signal ? { signal } : {}),
      onReceipt() {
        /* Drain FD 3 so the driver can finish; this invocation's exit code is the result. */
      },
    });
  } catch {
    return finishInvocation(runtime, input.files, signal?.aborted ? signalCode(signal) : 75, descriptor.invocationId);
  }
  return finishInvocation(
    runtime,
    input.files,
    signal?.aborted ? signalCode(signal) : outputCode(run),
    descriptor.invocationId,
  );
}

export type WebCheckDriverProcessRuntime = {
  spawn: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
  setTimer: (callback: () => void, delayMs: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

const processRuntime: WebCheckDriverProcessRuntime = {
  spawn: (command, args, options) => spawn(command, args, options),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Start and stop only the driver process this invocation created. */
export function runWebCheckDriverProcess(
  input: WebCheckDriverInvocation,
  processAdapter: WebCheckDriverProcessRuntime = processRuntime,
): Promise<WebCheckDriverProcess> {
  return new Promise((resolvePromise) => {
    const isReceipt = input.phase === 'run-prepared';
    const stdio: ('inherit' | 'ignore' | 'pipe')[] = isReceipt
      ? ['ignore', 'inherit', 'inherit', 'pipe']
      : ['ignore', 'pipe', 'inherit'];
    const child = processAdapter.spawn(input.command[0]!, input.command.slice(1), {
      cwd: input.cwd,
      env: input.env,
      stdio,
    });
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let outputOverflow = false;
    let parentClosed = false;
    let outputClosed = !(isReceipt ? child.stdio[3] : child.stdout);
    let code: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let received: NodeJS.Signals | null = null;
    let terminationStarted = false;
    let resolved = false;
    let signalHandler: (() => void) | undefined;
    const timers = new Set<unknown>();
    const schedule = (callback: () => void, delay: number) => {
      if (resolved) return;
      const timer = processAdapter.setTimer(() => {
        timers.delete(timer);
        callback();
      }, delay);
      timers.add(timer);
    };
    const clearTimers = () => {
      for (const timer of timers) processAdapter.clearTimer(timer);
      timers.clear();
    };
    const finish = (closed: boolean) => {
      if (resolved) return;
      resolved = true;
      clearTimers();
      if (input.signal && signalHandler) input.signal.removeEventListener('abort', signalHandler);
      else if (signalHandler) {
        process.off('SIGINT', signalHandler);
        process.off('SIGTERM', signalHandler);
        process.off('SIGHUP', signalHandler);
      }
      resolvePromise({
        code,
        signal: signal ?? received,
        closed,
        output: Buffer.concat(outputChunks, outputBytes).toString('utf8'),
        outputOverflow,
      });
    };
    const maybeFinish = () => {
      if (parentClosed && outputClosed) finish(true);
    };
    const signalProcess = (next: NodeJS.Signals) => {
      try {
        child.kill(next);
      } catch {
        /* This child is already gone. */
      }
    };
    const beginTermination = (next: NodeJS.Signals = 'SIGTERM') => {
      if (terminationStarted || (parentClosed && outputClosed)) return;
      terminationStarted = true;
      received = next;
      signalProcess('SIGTERM');
      schedule(() => {
        if (parentClosed && outputClosed) return finish(true);
        signalProcess('SIGKILL');
        schedule(() => finish(parentClosed && outputClosed), TERMINATION_SETTLE_MS);
      }, TERMINATION_GRACE_MS);
    };
    child.once('exit', (exitCode, exitSignal) => {
      parentClosed = true;
      code = exitCode;
      signal = exitSignal;
      if (outputClosed) maybeFinish();
      else schedule(() => finish(parentClosed && outputClosed), OUTPUT_SETTLE_MS);
    });
    child.once('close', (exitCode, exitSignal) => {
      if (!parentClosed) {
        parentClosed = true;
        code = exitCode;
        signal = exitSignal;
      }
      outputClosed = true;
      maybeFinish();
    });
    child.once('error', () => {
      /* Wait for close so this invocation still has a process result. */
    });
    const outputStream = isReceipt ? null : child.stdout;
    const receiptStream = isReceipt ? child.stdio[3] : null;
    outputStream?.on('data', (chunk: Buffer) => {
      if (outputOverflow || outputBytes + chunk.length > MAX_DESCRIPTOR_BYTES) {
        outputOverflow = true;
        return;
      }
      outputChunks.push(Buffer.from(chunk));
      outputBytes += chunk.length;
    });
    receiptStream?.on('data', (chunk: Buffer) => input.onReceipt?.(chunk));
    outputStream?.once('close', () => {
      outputClosed = true;
      maybeFinish();
    });
    receiptStream?.once('close', () => {
      outputClosed = true;
      maybeFinish();
    });
    if (input.signal) {
      signalHandler = () => beginTermination();
      input.signal.addEventListener('abort', signalHandler, { once: true });
      if (input.signal.aborted) signalHandler();
    } else {
      signalHandler = () => beginTermination();
      process.on('SIGINT', signalHandler);
      process.on('SIGTERM', signalHandler);
      process.on('SIGHUP', signalHandler);
    }
  });
}

/** Worker TMPDIR may live inside the candidate worktree; private files must never do so. */
function privateTemporaryRoot(): string {
  const base = realpathSync(tmpdir());
  let root = realpathSync(process.cwd());
  while (!existsSync(join(root, '.git'))) {
    const parent = dirname(root);
    if (parent === root) return base;
    root = parent;
  }
  const inside = relative(root, base);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)) ? realpathSync('/tmp') : base;
}

export function createWebCheckPrivateFiles(values: Record<string, string>): WebCheckPrivateFiles {
  const directory = mkdtempSync(join(privateTemporaryRoot(), 'rezics-web-check-'));
  chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const environmentFile = join(directory, 'environment.json');
  const descriptorFile = join(directory, 'prepared-descriptor.json');
  const environmentHandle = openSync(environmentFile, 'wx', PRIVATE_FILE_MODE);
  try {
    writeSync(environmentHandle, JSON.stringify(values));
    fsyncSync(environmentHandle);
  } finally {
    closeSync(environmentHandle);
  }
  return {
    directory,
    environmentFile,
    descriptorFile,
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export const webCheckCustodyRuntime: WebCheckCustodyRuntime = {
  invoke: runWebCheckDriverProcess,
  cleanup: (files) => files.close(),
};
