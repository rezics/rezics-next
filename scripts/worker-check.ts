#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { checkWaitRecorder } from './remote-check.ts';
import { acquireStackSlot } from './stack-lease.ts';
import {
  checkClass,
  checkMemoryCapacity,
  checkMemoryWeight,
  memoryLeaseDirectory,
  readPeaks,
  recordPeak,
  recordScopedPeak,
} from './check-memory.ts';

const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const;

type CheckRecord = {
  id: string;
  cwd: string;
  argv: string[];
  status: 'running' | 'finished';
  log: string;
  exitCode?: number;
};

function recordPath(cwd: string, id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`Invalid check id: ${id}`);
  return join(cwd, '.temp', 'goal', 'checks', 'results', `${id}.json`);
}

function readRecord(cwd: string, id: string): CheckRecord {
  const file = recordPath(cwd, id);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CheckRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Unknown check id: ${id}`);
    throw error;
  }
}

function writeRecord(record: CheckRecord): void {
  const file = recordPath(record.cwd, record.id);
  mkdirSync(join(record.cwd, '.temp', 'goal', 'checks', 'results'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function logPath(cwd: string): string {
  const directory = join(cwd, '.temp', 'goal', 'checks');
  mkdirSync(directory, { recursive: true });
  return join(
    directory,
    `worker-check-${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.log`,
  );
}

function failureSummary(file: string): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return '(the check produced no output)';
    const buffer = Buffer.alloc(Math.min(size, 12_000));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    const lines = buffer
      .toString('utf8')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const failures = lines.filter((line) =>
      /error|fail|not ok|assert|expected|received|actual|panic|exception/i.test(line),
    );
    const summary = [...new Set(failures.length ? failures : lines.slice(-30))].slice(-30).join('\n');
    return summary.slice(-4_000) || '(the check produced no output)';
  } finally {
    closeSync(fd);
  }
}

export async function runWorkerCheck(
  argv: readonly string[],
  cwd = process.cwd(),
  reportOutput = true,
  recordedLog?: string,
): Promise<number> {
  if (argv.length === 0) throw new Error('A check command is required');
  const localOnly = argv[0] === '--local';
  if (localOnly) argv = argv.slice(1);
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) throw new Error('Usage: worker-check.ts [--local] -- <command...>');
  const root = resolve(cwd);
  const file = recordedLog ?? logPath(root);
  const descriptor = openSync(file, 'wx', 0o600);
  const wait = checkWaitRecorder(process.env.GOAL_CHECK_WAIT_FILE);
  const env = { ...process.env };
  // The wrapper records the complete command duration; nested stack and remote wait recorders would double-count it.
  delete env.GOAL_CHECK_WAIT_FILE;
  const commandClass = checkClass(argv, root);
  const directory = memoryLeaseDirectory(env);
  const capacity = checkMemoryCapacity(env);
  const weight = checkMemoryWeight(readPeaks(directory)[commandClass] ?? [], capacity);
  const remoteHostsFile = env.KERNEL_CHECK_REMOTE;
  let remoteEligible = false;
  if (!localOnly && remoteHostsFile && weight >= 2) {
    try {
      accessSync(remoteHostsFile, constants.R_OK);
      remoteEligible = true;
    } catch {
      // An unreadable explicit hosts file keeps worker checks local, matching the other placement wrappers.
    }
  }
  const relativeLogPath = relative(root, file);
  const report = (code: number): number => {
    process.stdout.write(`check: exit status ${code}\n`);
    if (code !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
    process.stdout.write(`check: log ${relativeLogPath}\n`);
    return code;
  };
  if (remoteEligible) {
    let remoteOutput = '';
    const remote = spawn(process.execPath, [join(root, 'scripts/remote-check.ts'), root, '--', ...argv], {
      cwd: root,
      env: { ...env, REZICS_CHECK_MEMORY: 'off', REZICS_STACK_LEASE: 'off' },
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const saveRemote = (chunk: Buffer): void => {
      writeSync(descriptor, chunk);
      remoteOutput = (remoteOutput + chunk.toString('utf8')).slice(-16_000);
    };
    remote.stdout?.on('data', saveRemote);
    remote.stderr?.on('data', saveRemote);
    wait.begin();
    let remoteSignal: number | undefined;
    const remoteForwarders = Object.entries(SIGNALS).map(([signal, number]) => {
      const name = signal as keyof typeof SIGNALS;
      const forward = () => {
        remoteSignal ??= number;
        remote.kill(name);
      };
      process.on(name, forward);
      return [name, forward] as const;
    });
    let remoteCode: number;
    try {
      remoteCode = await new Promise<number>((resolveExit, reject) => {
        remote.once('error', reject);
        remote.once('close', (status, signal) => {
          const fromSignal = signal === null ? undefined : SIGNALS[signal as keyof typeof SIGNALS];
          resolveExit(status ?? 128 + (fromSignal ?? 1));
        });
      });
    } finally {
      for (const [name, forward] of remoteForwarders) process.off(name, forward);
    }
    const transportReason = remoteOutput.includes('remote-check: transport failure marker')
      ? remoteOutput.match(/remote-check: connection to .+ failed during .+ before a result/)?.[0]
      : undefined;
    if (remoteCode !== 75 || !transportReason || remoteSignal !== undefined) {
      const peakMiB = remoteOutput.match(/peak memory (\d+) MiB on [^\r\n]+/)?.[1];
      if (peakMiB) {
        const peakBytes = Number(peakMiB) * 2 ** 20;
        recordPeak(directory, commandClass, peakBytes);
        process.stderr.write(
          `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
        );
      }
      wait.stop();
      closeSync(descriptor);
      return report(remoteSignal === undefined ? remoteCode : 128 + remoteSignal);
    }
    const retry = `worker-check: remote transport failed: ${transportReason}; retrying locally under memory lease\n`;
    process.stderr.write(retry);
    writeSync(descriptor, retry);
    wait.stop();
  }
  const leaseEnv = { ...env };
  // The memory lease is independent of any stack lease held by the caller.
  delete leaseEnv.REZICS_STACK_SLOT;
  delete leaseEnv.REZICS_STACK_LEASE;
  if (env.REZICS_CHECK_MEMORY === 'off') leaseEnv.REZICS_STACK_LEASE = 'off';
  if (env.REZICS_CHECK_MEMORY_LEASE !== undefined) leaseEnv.REZICS_STACK_SLOT = env.REZICS_CHECK_MEMORY_LEASE;
  const lease = await acquireStackSlot(
    `worker-check: ${commandClass}`,
    {
      ...leaseEnv,
      REZICS_STACK_SLOTS: String(capacity),
      REZICS_STACK_LEASE_DIR: directory,
    },
    weight,
  );
  env.REZICS_CHECK_MEMORY_LEASE = lease.env.REZICS_STACK_SLOT ?? env.REZICS_CHECK_MEMORY_LEASE ?? 'inherited';
  let child: ReturnType<typeof spawn>;
  let scoped = false;
  const peakFile = join(directory, `peak.${process.pid}.${randomUUID()}.tmp`);
  try {
    let callerSlice = '';
    if (env.REZICS_CHECK_SCOPE !== 'off') {
      try {
        const cgroup =
          readFileSync('/proc/self/cgroup', 'utf8')
            .split('\n')
            .find((line) => line.startsWith('0::'))
            ?.slice(3) ?? '';
        callerSlice =
          cgroup
            .split('/')
            .filter((part) => part.endsWith('.slice'))
            .at(-1) ?? '';
      } catch {
        /* scope support is optional */
      }
    }
    const scopeProbe =
      env.REZICS_CHECK_SCOPE !== 'off' && callerSlice
        ? Bun.spawnSync(
            ['systemd-run', '--user', '--scope', '--collect', `--slice=${callerSlice}`, '--quiet', 'true'],
            { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
          )
        : undefined;
    scoped = scopeProbe?.exitCode === 0;
    const scopeUnit = scoped ? `rezics-check-${process.pid}-${randomUUID().slice(0, 8)}.scope` : undefined;
    // Keep the command as argv, and have the wrapper capture memory.peak while it still belongs to the scope.
    const capture =
      '"$@"; status=$?; cgroup=$(sed -n \'s/^0:://p\' /proc/self/cgroup); if [ -n "$cgroup" ] && [ -r "/sys/fs/cgroup$cgroup/memory.peak" ]; then cat "/sys/fs/cgroup$cgroup/memory.peak" > "$REZICS_CHECK_PEAK_FILE"; fi; exit "$status"';
    child = spawn(
      scoped ? 'systemd-run' : argv[0]!,
      scoped
        ? [
            '--user',
            '--scope',
            '--collect',
            '--unit',
            scopeUnit!,
            `--slice=${callerSlice}`,
            '--quiet',
            '--',
            'sh',
            '-c',
            capture,
            'worker-check-scope',
            ...argv,
          ]
        : argv.slice(1),
      {
        cwd: root,
        env: { ...env, REZICS_CHECK_PEAK_FILE: peakFile },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    closeSync(descriptor);
    await lease.release();
    throw error;
  }

  const save = (chunk: Buffer): void => {
    writeSync(descriptor, chunk);
  };
  child.stdout?.on('data', save);
  child.stderr?.on('data', save);
  wait.begin();

  let signalNumber: number | undefined;
  const forwarders = Object.entries(SIGNALS).map(([signal, number]) => {
    const name = signal as keyof typeof SIGNALS;
    const forward = () => {
      signalNumber ??= number;
      child.kill(name);
    };
    process.on(name, forward);
    return [name, forward] as const;
  });

  let code: number;
  try {
    code = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => {
        const fromSignal = signal === null ? undefined : SIGNALS[signal as keyof typeof SIGNALS];
        resolveExit(status ?? 128 + (fromSignal ?? 1));
      });
    });
  } finally {
    for (const [name, forward] of forwarders) process.off(name, forward);
    wait.stop();
    closeSync(descriptor);
    await lease.release();
  }

  if (scoped) {
    const peakBytes = recordScopedPeak(directory, commandClass, peakFile);
    if (peakBytes !== undefined) {
      process.stderr.write(
        `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
      );
    }
  }
  rmSync(peakFile, { force: true });
  if (reportOutput) {
    process.stdout.write(`check: exit status ${signalNumber === undefined ? code : 128 + signalNumber}\n`);
    if (code !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
    process.stdout.write(`check: log ${relativeLogPath}\n`);
  }
  return signalNumber === undefined ? code : 128 + signalNumber;
}

/** Start a detached check whose durable result can be retrieved by id after this process exits. */
export function startWorkerCheck(argv: readonly string[], cwd = process.cwd()): string {
  if (argv.length === 0) throw new Error('A check command is required');
  const root = resolve(cwd);
  const id = randomUUID();
  const file = logPath(root);
  const record: CheckRecord = { id, cwd: root, argv: [...argv], status: 'running', log: relative(root, file) };
  writeRecord(record);
  const child = spawn(process.execPath, [resolve(import.meta.path), '--run', id], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    record.status = 'finished';
    record.exitCode = 1;
    writeRecord(record);
    process.stderr.write(`worker-check: could not start check ${id}: ${error.message}\n`);
  });
  child.unref();
  return id;
}

/** Wait for a previously started check; timeoutMs is useful to callers that need to yield and retry later. */
export async function waitWorkerCheck(
  id: string,
  cwd = process.cwd(),
  timeoutMs = Number.POSITIVE_INFINITY,
): Promise<number> {
  const root = resolve(cwd);
  const started = Date.now();
  let record = readRecord(root, id);
  while (record.status === 'running') {
    if (Date.now() - started >= timeoutMs) throw new Error(`Wait timed out for check ${id}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    record = readRecord(root, id);
  }
  const code = record.exitCode ?? 1;
  const absoluteLog = join(root, record.log);
  process.stdout.write(`check: exit status ${code}\n`);
  if (code !== 0 && existsSync(absoluteLog))
    process.stdout.write(`check: failure summary\n${failureSummary(absoluteLog)}\n`);
  process.stdout.write(`check: log ${record.log}\n`);
  return code;
}

async function runRecordedCheck(id: string, cwd = process.cwd()): Promise<number> {
  const root = resolve(cwd);
  const record = readRecord(root, id);
  try {
    const exitCode = await runWorkerCheck(record.argv, root, false, join(root, record.log));
    record.status = 'finished';
    record.exitCode = exitCode;
    writeRecord(record);
    return exitCode;
  } catch (error) {
    record.status = 'finished';
    record.exitCode = 1;
    writeRecord(record);
    throw error;
  }
}

function parse(argv: string[]): string[] {
  // Bun consumes the conventional `--` separator before exposing Bun.argv; accept it too for direct Node execution.
  const command = argv[0] === '--' ? argv.slice(1) : argv;
  if (command.length === 0) {
    throw new Error('Usage: worker-check.ts [--local] -- <command...>');
  }
  return command;
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] === '--wait' && args[1]) process.exitCode = await waitWorkerCheck(args[1]);
    else if (args[0] === '--run' && args[1]) process.exitCode = await runRecordedCheck(args[1]);
    else {
      const id = startWorkerCheck(parse(args));
      process.stdout.write(`check: id ${id}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
