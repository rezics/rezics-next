import { spawn as spawnProcess, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Writable } from 'node:stream';
import { DumpInputError, closeInput, throwIfAborted, type DumpByteProgress } from './dump-input.ts';
import { DEFAULT_DUMP_CHUNK_BYTES, MAX_DUMP_CHUNK_BYTES } from './dumps-bytes.ts';

/** VNDB ustar archives and Wikidata streamed dumps only. Open Library stays on gzip. */
export const ZSTD_DUMP_SOURCES = ['vndb', 'wikidata'] as const;
export const DEFAULT_ZSTD_EXECUTABLE = '/usr/bin/zstd';
/** Decoder window/memory passed as `-M128MB`; matches zstd v1.5.7 `--long=27`. */
export const DEFAULT_ZSTD_MEMORY = '128MB';
export const DEFAULT_DECODED_ZSTD_BYTES = 256 * 1024 ** 3;
export const ZSTD_STDERR_BUDGET = 8192;
export const ZSTD_TERMINATION_GRACE_MS = 2000;
export const ZSTD_PROBE_DEADLINE_MS = 5000;
const MIN_PIPE_CHUNK = 64;

export type ZstdDumpCounters = {
  compressedBytes: number;
  decodedBytes: number;
  peakCompressedWindow: number;
  peakDecodedWindow: number;
  decodeVisits: number;
};

export type ZstdDumpObserver = {
  onDecodedChunk?(bytes: number, backingBytes: number): void;
};

export type ZstdSpawn = (
  executable: string,
  argv: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true; shell: false },
) => ChildProcess;

export function createZstdDumpCounters(): ZstdDumpCounters {
  return { compressedBytes: 0, decodedBytes: 0, peakCompressedWindow: 0, peakDecodedWindow: 0, decodeVisits: 0 };
}

export function zstdDecompressArgv(memory = DEFAULT_ZSTD_MEMORY): readonly string[] {
  if (typeof memory !== 'string' || !/^[1-9][0-9]{0,6}(?:MB|KB|GB)?$/u.test(memory))
    throw new DumpInputError('zstd decoder memory limit is invalid.', 'invalid-input');
  return ['-d', '-c', `-M${memory}`, '--no-pass-through', '-'];
}

export function zstdPipeHighWaterMark(value = DEFAULT_DUMP_CHUNK_BYTES): number {
  if (!Number.isSafeInteger(value) || value < MIN_PIPE_CHUNK || value > MAX_DUMP_CHUNK_BYTES)
    throw new DumpInputError('zstd pipe high-water mark is outside the admitted dump chunk window.', 'invalid-input');
  return value;
}

export function zstdDecodeBudgetLimit(value: number | undefined): number {
  const cap = value === undefined ? DEFAULT_DECODED_ZSTD_BYTES : value;
  if (!Number.isSafeInteger(cap) || cap <= 0)
    throw new DumpInputError('Decoded-byte budget must be a positive safe integer.', 'decode-budget');
  return cap;
}

export function admitZstdCompression(source: string): void {
  if (!(ZSTD_DUMP_SOURCES as readonly string[]).includes(source))
    throw new DumpInputError(
      'zstd compression is only admitted for VNDB archives and Wikidata streamed dumps.',
      'compression-unsupported',
    );
}

function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function copyOf(bytes: Uint8Array, start = 0, end = bytes.byteLength): Uint8Array {
  const owned = new Uint8Array(end - start);
  if (owned.byteLength) owned.set(bytes.subarray(start, end));
  return owned;
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const identity = await stat(path);
    if (!identity.isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function missingExecutable(): never {
  throw new DumpInputError(
    'The zstd executable is missing or not executable. Install zstd 1.5.x with -d, -c, -M# and --no-pass-through, or pass --zstd-executable.',
    'zstd-missing-executable',
  );
}

function incompatibleExecutable(): never {
  throw new DumpInputError(
    'The zstd executable does not support the required decompression flags (-d, -c, -M# and --no-pass-through).',
    'zstd-incompatible-executable',
  );
}

/** Operator `--zstd-executable` must be an absolute local file. Default `/usr/bin/zstd`, then `zstd` on PATH. */
export async function resolveZstdExecutable(explicit?: string): Promise<string> {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit || explicit.includes('\0') || explicit.length > 4096)
      throw new DumpInputError('The zstd executable path is invalid.', 'zstd-missing-executable');
    if (!isAbsolute(explicit))
      throw new DumpInputError('The zstd executable path must be an absolute local file.', 'zstd-missing-executable');
    if (!(await isExecutableFile(explicit))) missingExecutable();
    return explicit;
  }
  if (await isExecutableFile(DEFAULT_ZSTD_EXECUTABLE)) return DEFAULT_ZSTD_EXECUTABLE;
  const pathEnv = process.env.PATH ?? '';
  for (const directory of pathEnv.split(':')) {
    if (!directory || directory.includes('\0')) continue;
    const candidate = join(directory, 'zstd');
    if (await isExecutableFile(candidate)) return candidate;
  }
  missingExecutable();
}

async function collectHelp(child: ChildProcess, signal: AbortSignal, cap: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const take = (stream: NodeJS.ReadableStream | null) =>
    new Promise<void>((resolve, reject) => {
      if (!stream) {
        resolve();
        return;
      }
      stream.on('data', (chunk: Buffer | string) => {
        if (size >= cap) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const next = bytes.subarray(0, cap - size);
        chunks.push(next);
        size += next.byteLength;
      });
      stream.once('error', reject);
      stream.once('end', () => resolve());
    });
  const deadline = AbortSignal.timeout(ZSTD_PROBE_DEADLINE_MS);
  const combined = AbortSignal.any([signal, deadline]);
  const onAbort = () => child.kill('SIGKILL');
  combined.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.all([take(child.stdout), take(child.stderr)]);
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function probeZstdExecutable(
  executable: string,
  options: { spawn?: ZstdSpawn; signal?: AbortSignal } = {},
): Promise<void> {
  const spawn = options.spawn ?? spawnZstd;
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  let child: ChildProcess;
  try {
    child = spawn(executable, ['-H'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  } catch {
    missingExecutable();
  }
  child.stdin?.end();
  let help = '';
  try {
    help = await collectHelp(child, signal, 65_536);
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status) => resolve(status ?? 1));
    });
    if (code !== 0 && !help) incompatibleExecutable();
  } catch (error) {
    child.kill('SIGKILL');
    if (signal.aborted || isAbort(error)) throw signal.reason ?? new DOMException('Import interrupted', 'AbortError');
    if (error instanceof DumpInputError) throw error;
    missingExecutable();
  }
  if (!help.includes('-d') || !help.includes('-c') || !help.includes('-M#') || !help.includes('pass-through'))
    incompatibleExecutable();
}

export function spawnZstd(
  executable: string,
  argv: readonly string[],
  options: { stdio: ['pipe', 'pipe', 'pipe']; windowsHide: true; shell: false },
): ChildProcess {
  return spawnProcess(executable, [...argv], options);
}

function mapZstdFailure(
  error: unknown,
  signal: AbortSignal,
  decodedBytes: number,
  stderr: string,
  exitCode: number | undefined,
): never {
  if (signal.aborted) throw signal.reason ?? new DOMException('Import interrupted', 'AbortError');
  if (error instanceof DumpInputError) throw error;
  if (isAbort(error)) throw error;
  const text = `${stderr}\n${error instanceof Error ? error.message : ''}`;
  if (/premature end/i.test(text))
    throw new DumpInputError('zstd input is truncated before a complete frame.', 'zstd-truncated');
  if (/doesn't match checksum/i.test(text))
    throw new DumpInputError('zstd frame checksum does not match the decompressed data.', 'zstd-integrity');
  if (/too much memory|window size larger/i.test(text))
    throw new DumpInputError('zstd frame window exceeds the decoder memory limit.', 'zstd-window');
  if (/unsupported format|unknown header|cannot be uncompressed/i.test(text)) {
    if (decodedBytes > 0)
      throw new DumpInputError(
        'zstd stream has non-zstd trailing bytes after a complete frame.',
        'zstd-trailing-garbage',
      );
    throw new DumpInputError('Input is not a zstd dump frame.', 'zstd-integrity');
  }
  if (exitCode === 0) throw new DumpInputError('zstd dump failed completeness or integrity checks.', 'zstd-integrity');
  throw new DumpInputError('zstd dump failed completeness or integrity checks.', 'zstd-integrity');
}

async function writePipe(stream: Writable, chunk: Uint8Array, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (stream.destroyed || !stream.writable)
    throw new DumpInputError('zstd input pump broke before the original file reached EOF.', 'zstd-integrity');
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Import interrupted', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    try {
      stream.write(chunk, (error) => {
        cleanup();
        if (error)
          reject(new DumpInputError('zstd input pump broke before the original file reached EOF.', 'zstd-integrity'));
        else resolve();
      });
    } catch {
      cleanup();
      reject(new DumpInputError('zstd input pump broke before the original file reached EOF.', 'zstd-integrity'));
    }
  });
}

async function endPipe(stream: Writable | null): Promise<void> {
  if (!stream || stream.destroyed || !stream.writable) return;
  await new Promise<void>((resolve) => {
    stream.end(() => resolve());
    stream.once('error', () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGTERM');
  } catch {
    return;
  }
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
  const raced = await Promise.race([
    exited.then(() => 'exited' as const),
    delay(graceMs).then(() => 'timeout' as const),
  ]);
  if (raced === 'timeout' && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // The child may have exited between the grace wait and the forced signal.
    }
  }
  await exited;
}

/**
 * Owned zstd transform: descriptor-owned compressed chunks are pumped to a direct
 * child stdin. Concatenated frames, including an empty last frame, and skippable
 * frames are valid (zstd v1.5.7). Trailing non-zstd bytes fail. The generator
 * does not complete until the input pump, decoded stdout, and child exit 0 join.
 */
export async function* decodeZstdDumpChunks(
  input: AsyncIterable<Uint8Array>,
  options: {
    signal: AbortSignal;
    decodeBudget?: number;
    highWaterMark?: number;
    executable?: string;
    memory?: string;
    progress?: DumpByteProgress;
    observer?: ZstdDumpObserver;
    counters?: ZstdDumpCounters;
    spawn?: ZstdSpawn;
    probe?: boolean;
    stderrBudget?: number;
    terminationGraceMs?: number;
  },
): AsyncGenerator<Uint8Array> {
  const highWaterMark = zstdPipeHighWaterMark(options.highWaterMark);
  const budget = zstdDecodeBudgetLimit(options.decodeBudget);
  const counters = options.counters ?? createZstdDumpCounters();
  const spawn = options.spawn ?? spawnZstd;
  const grace = options.terminationGraceMs ?? ZSTD_TERMINATION_GRACE_MS;
  const stderrBudget = options.stderrBudget ?? ZSTD_STDERR_BUDGET;
  const executable = options.executable ?? (await resolveZstdExecutable());
  if (options.probe !== false) await probeZstdExecutable(executable, { spawn, signal: options.signal });
  throwIfAborted(options.signal);

  const argv = zstdDecompressArgv(options.memory);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executable, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
  } catch {
    missingExecutable();
  }
  if (!child.stdin || !child.stdout || !child.stderr) {
    await terminateChild(child, grace);
    throw new DumpInputError('zstd child pipes were not created.', 'zstd-incompatible-executable');
  }

  let firstError: unknown;
  let stderrText = '';
  let exitCode: number | undefined;
  let closed = false;
  const failOnce = (error: unknown) => {
    if (firstError === undefined) firstError = error;
  };
  const iterator = input[Symbol.asyncIterator]();
  let inputEnded = false;

  const exit = new Promise<number>((resolve, reject) => {
    child.once('error', (error) => {
      failOnce(error);
      reject(error);
    });
    child.once('exit', (status, signalName) => {
      exitCode = status ?? (signalName ? 1 : 0);
      resolve(exitCode);
    });
  });
  void exit.catch((error) => failOnce(error));

  const stderrDrain = (async () => {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of child.stderr) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (size < stderrBudget) {
          const next = bytes.subarray(0, stderrBudget - size);
          chunks.push(next);
          size += next.byteLength;
        }
      }
    } catch (error) {
      failOnce(error);
    }
    stderrText = Buffer.concat(chunks).toString('utf8');
  })();
  void stderrDrain.catch((error) => failOnce(error));

  const pump = (async () => {
    try {
      for (;;) {
        throwIfAborted(options.signal);
        const next = await iterator.next();
        if (next.done) {
          inputEnded = true;
          await endPipe(child.stdin);
          return;
        }
        if (!(next.value instanceof Uint8Array))
          throw new DumpInputError('Compressed dump chunk is not a byte window.', 'invalid-input');
        if (!next.value.byteLength) continue;
        for (let offset = 0; offset < next.value.byteLength; offset += highWaterMark) {
          throwIfAborted(options.signal);
          const size = Math.min(highWaterMark, next.value.byteLength - offset);
          const owned = copyOf(next.value, offset, offset + size);
          counters.compressedBytes += size;
          counters.peakCompressedWindow = Math.max(counters.peakCompressedWindow, owned.buffer.byteLength);
          await writePipe(child.stdin, owned, options.signal);
        }
      }
    } finally {
      if (!inputEnded) await closeInput(iterator, options.signal, true);
    }
  })();
  void pump.catch((error) => failOnce(error));

  const close = async (kill: boolean) => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', onAbort);
    if (kill) {
      child.stdin.destroy();
      child.stdout.destroy();
      await terminateChild(child, grace);
    }
    await Promise.allSettled([pump, stderrDrain, exit]);
  };
  const onAbort = () => {
    failOnce(options.signal.reason ?? new DOMException('Import interrupted', 'AbortError'));
    child.stdin.destroy();
    child.stdout.destroy();
    void terminateChild(child, grace);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  const join = async () => {
    let pumpResult: PromiseSettledResult<void>;
    try {
      pumpResult = await Promise.allSettled([pump]).then((results) => results[0]!);
    } catch (error) {
      pumpResult = { status: 'rejected', reason: error };
    }
    await stderrDrain.catch(() => {});
    let code: number;
    try {
      code = await exit;
    } catch (error) {
      await close(true);
      mapZstdFailure(firstError ?? error, options.signal, counters.decodedBytes, stderrText, exitCode);
    }
    if (pumpResult.status === 'rejected') {
      await close(true);
      mapZstdFailure(pumpResult.reason, options.signal, counters.decodedBytes, stderrText, code);
    }
    if (firstError) {
      await close(true);
      mapZstdFailure(firstError, options.signal, counters.decodedBytes, stderrText, code);
    }
    if (code !== 0) {
      await close(true);
      mapZstdFailure(undefined, options.signal, counters.decodedBytes, stderrText, code);
    }
    await close(false);
  };

  const stdout = child.stdout[Symbol.asyncIterator]();
  const consumeStdoutChunk = (chunk: unknown): Uint8Array[] => {
    if (firstError) mapZstdFailure(firstError, options.signal, counters.decodedBytes, stderrText, exitCode);
    const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as Buffer);
    const windows: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += highWaterMark) {
      throwIfAborted(options.signal);
      const size = Math.min(highWaterMark, bytes.byteLength - offset);
      const owned = copyOf(bytes, offset, offset + size);
      counters.decodedBytes += size;
      counters.decodeVisits++;
      counters.peakDecodedWindow = Math.max(counters.peakDecodedWindow, owned.buffer.byteLength);
      options.progress?.add('decodedBytes', size);
      options.observer?.onDecodedChunk?.(size, owned.buffer.byteLength);
      if (counters.decodedBytes > budget)
        throw new DumpInputError(
          `Decoded dump bytes exceeded the ${budget}-byte budget (one transform window overshoot is included).`,
          'decode-budget',
        );
      windows.push(owned);
    }
    return windows;
  };

  let stdoutEnded = false;
  let failed = false;
  try {
    throwIfAborted(options.signal);
    for (;;) {
      throwIfAborted(options.signal);
      if (firstError) mapZstdFailure(firstError, options.signal, counters.decodedBytes, stderrText, exitCode);
      const next = await stdout.next();
      if (next.done) {
        stdoutEnded = true;
        break;
      }
      for (const owned of consumeStdoutChunk(next.value)) yield owned;
    }
    await join();
  } catch (error) {
    failed = true;
    await close(true);
    mapZstdFailure(error, options.signal, counters.decodedBytes, stderrText, exitCode);
  } finally {
    if (!failed && !closed && !options.signal.aborted) {
      try {
        if (!stdoutEnded) {
          for (;;) {
            throwIfAborted(options.signal);
            const next = await stdout.next();
            if (next.done) {
              stdoutEnded = true;
              break;
            }
            consumeStdoutChunk(next.value);
          }
        }
        await join();
      } catch (error) {
        await close(true);
        mapZstdFailure(error, options.signal, counters.decodedBytes, stderrText, exitCode);
      }
    } else if (!closed) {
      await close(true);
    }
  }
}
