#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeSync } from 'node:fs';
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
  recordScopedPeak,
} from './check-memory.ts';

const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
} as const;

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

export async function runWorkerCheck(argv: readonly string[], cwd = process.cwd()): Promise<number> {
  if (argv.length === 0) throw new Error('A check command is required');
  const root = resolve(cwd);
  const file = logPath(root);
  const descriptor = openSync(file, 'wx', 0o600);
  const wait = checkWaitRecorder(process.env.GOAL_CHECK_WAIT_FILE);
  const env = { ...process.env };
  // The wrapper records the complete command duration; nested stack and remote wait recorders would double-count it.
  delete env.GOAL_CHECK_WAIT_FILE;
  const commandClass = checkClass(argv, root);
  const directory = memoryLeaseDirectory(env);
  const capacity = checkMemoryCapacity(env);
  const weight = checkMemoryWeight(readPeaks(directory)[commandClass] ?? [], capacity);
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
  const relativeLogPath = relative(root, file);
  process.stdout.write(`check: exit status ${signalNumber === undefined ? code : 128 + signalNumber}\n`);
  if (code !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
  process.stdout.write(`check: log ${relativeLogPath}\n`);
  return signalNumber === undefined ? code : 128 + signalNumber;
}

function parse(argv: string[]): string[] {
  // Bun consumes the conventional `--` separator before exposing Bun.argv; accept it too for direct Node execution.
  const command = argv[0] === '--' ? argv.slice(1) : argv;
  if (command.length === 0) {
    throw new Error('Usage: worker-check.ts -- <command...>');
  }
  return command;
}

if (import.meta.main) {
  try {
    process.exitCode = await runWorkerCheck(parse(Bun.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
