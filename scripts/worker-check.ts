#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkWaitRecorder } from './remote-check.ts';
import { mainCheckout, writeLedger, type CheckLedgerEntry } from './check-ledger.ts';
import { acquireStackSlot } from './stack-lease.ts';
import {
  checkClass,
  checkMemoryCapacity,
  checkMemoryP90,
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
  runnerPid?: number;
  runnerHost?: string;
  exitCode?: number;
  infrastructureFailure?: string;
  reruns?: number;
  infrastructureFailureFinal?: boolean;
};

const LOG_STALL_MS = 10 * 60 * 1000;
const CPU_PROGRESS_INTERVAL_MS = 60_000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_POLL_MS = 25;
const priorityFileWarnings = new Set<string>();

function applyTaskPriority(root: string, env: NodeJS.ProcessEnv): void {
  if (!env.GOAL_TASK_ID) return;
  const file = join(root, '.temp', 'goal', 'task-priority');
  try {
    const value = readFileSync(file, 'utf8').trim();
    if (value !== 'critical' && value !== 'normal')
      throw new Error(`worker-check: ${file} must contain critical or normal`);
    if (value === 'critical') env.REMOTE_CHECK_PRIORITY = 'critical';
    else delete env.REMOTE_CHECK_PRIORITY;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('worker-check:')) throw error;
    if (!priorityFileWarnings.has(file)) {
      priorityFileWarnings.add(file);
      process.stderr.write(`worker-check: ${file} unavailable; using normal priority\n`);
    }
    delete env.REMOTE_CHECK_PRIORITY;
  }
}

type CheckMonitor = {
  stallMs?: number;
  pollMs?: number;
  rerunStallMs?: number;
  write?: (text: string) => void;
};

/** Sum Linux process CPU ticks for a command and all descendants, or return undefined when procfs is unavailable. */
export function processTreeCpuTicks(rootPid: number, procRoot = '/proc'): number | undefined {
  try {
    const children = new Map<number, number[]>();
    const ticks = new Map<number, number>();
    for (const entry of readdirSync(procRoot)) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = readFileSync(join(procRoot, entry, 'stat'), 'utf8');
        const close = stat.lastIndexOf(')');
        if (close < 0) continue;
        const fields = stat
          .slice(close + 2)
          .trim()
          .split(/\s+/);
        const parent = Number(fields[1]);
        const cpuTicks = Number(fields[11]) + Number(fields[12]);
        if (!Number.isInteger(parent) || !Number.isFinite(cpuTicks)) continue;
        ticks.set(pid, cpuTicks);
        const siblings = children.get(parent) ?? [];
        siblings.push(pid);
        children.set(parent, siblings);
      } catch {
        // Processes can disappear between listing procfs and reading their stat file.
      }
    }
    const pending = [rootPid];
    const seen = new Set<number>();
    let total = 0;
    while (pending.length) {
      const pid = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      total += ticks.get(pid) ?? 0;
      pending.push(...(children.get(pid) ?? []));
    }
    return ticks.has(rootPid) ? total : undefined;
  } catch {
    return undefined;
  }
}

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
  leaseWaitRepeatMs = 60_000,
  logicalCheckId?: string,
  rerunNumber = 0,
): Promise<number> {
  if (argv.length === 0) throw new Error('A check command is required');
  const localOnly = argv[0] === '--local';
  if (localOnly) argv = argv.slice(1);
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) throw new Error('Usage: worker-check.ts [--local] -- <command...>');
  const root = resolve(cwd);
  const command = resolveRepositoryBun(argv, root);
  const file = recordedLog ?? logPath(root);
  const descriptor = openSync(file, recordedLog ? 'a' : 'wx', 0o600);
  const wait = checkWaitRecorder(process.env.GOAL_CHECK_WAIT_FILE);
  wait.begin();
  const env = { ...process.env };
  applyTaskPriority(root, env);
  // The wrapper records the complete command duration; nested stack and remote wait recorders would double-count it.
  delete env.GOAL_CHECK_WAIT_FILE;
  const commandClass = checkClass(argv, root);
  const checkout = mainCheckout(root);
  let ledger: CheckLedgerEntry | undefined;
  const beginLedger = (host: string, slotWaitSeconds = 0): void => {
    ledger = {
      runId: randomUUID(),
      ...(logicalCheckId ? { logicalCheckId } : {}),
      rerunNumber,
      host,
      argv: [...argv],
      revision: (() => {
        try {
          return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
        } catch {
          return undefined;
        }
      })(),
      start: new Date().toISOString(),
      terminalStatus: 'running',
      slotWaitSeconds,
    };
    writeLedger(ledger, checkout);
  };
  const endLedger = (code: number, cause?: string): void => {
    if (!ledger) return;
    ledger.end = new Date().toISOString();
    ledger.exitStatus = code;
    ledger.terminalStatus = cause ? 'infrastructure-failure' : code === 0 ? 'passed' : 'failed';
    if (cause) ledger.infrastructureCause = cause;
    writeLedger(ledger, checkout);
  };
  const directory = memoryLeaseDirectory(env);
  const capacity = checkMemoryCapacity(env);
  const weight = checkMemoryWeight(readPeaks(directory)[commandClass] ?? [], capacity);
  const p90 = checkMemoryP90(readPeaks(directory)[commandClass] ?? []);
  const noMemoryLease = weight === 0;
  if (noMemoryLease) {
    const line = `worker-check: ${commandClass} local p90 ${(p90! / 2 ** 20).toFixed(1)} MiB; skipping local memory lease\n`;
    process.stderr.write(line);
    writeSync(descriptor, line);
  }
  const remoteHostsFile = env.KERNEL_CHECK_REMOTE;
  let remoteEligible = false;
  if (!localOnly && env.KERNEL_CHECK_ON_REMOTE !== '1' && remoteHostsFile && weight >= 2) {
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
    const growthProfile = env.GROWTH_PROFILE;
    let growthProfilePath: string | undefined;
    let growthProfileRelative: string | undefined;
    let previousGrowthProfile = '';
    if (growthProfile !== undefined && growthProfile !== '') {
      growthProfilePath = resolve(root, growthProfile);
      const relativeProfile = relative(root, growthProfilePath);
      let resolvedProfile = growthProfilePath;
      try {
        resolvedProfile = realpathSync(growthProfilePath);
      } catch {
        // A profile may be created by the check; the lexical path is still validated below.
      }
      const resolvedRoot = realpathSync(root);
      const resolvedRelative = relative(resolvedRoot, resolvedProfile);
      if (
        relativeProfile === '..' ||
        relativeProfile.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        relativeProfile.startsWith('/') ||
        resolvedRelative === '..' ||
        resolvedRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        resolvedRelative.startsWith('/')
      ) {
        throw new Error(`GROWTH_PROFILE must be inside the worktree: ${growthProfilePath}`);
      }
      growthProfileRelative = relativeProfile.split('\\').join('/');
      if (existsSync(growthProfilePath)) previousGrowthProfile = readFileSync(growthProfilePath, 'utf8');
    }
    beginLedger('remote', 0);
    let remoteOutput = '';
    const remoteCommand =
      growthProfileRelative === undefined
        ? [...argv]
        : ['sh', '-c', 'export GROWTH_PROFILE="$PWD/$1"; shift; exec "$@"', 'sh', growthProfileRelative, ...argv];
    const remote = spawn(
      resolveRepositoryBun(['bun'], root)[0]!,
      [
        join(root, 'scripts/remote-check.ts'),
        '--memory-gib',
        String(weight),
        ...(growthProfileRelative === undefined ? [] : ['--returns', growthProfileRelative]),
        root,
        '--',
        ...remoteCommand,
      ],
      {
        cwd: root,
        env: { ...env, REZICS_CHECK_MEMORY: 'off', REZICS_STACK_LEASE: 'off' },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
    const saveRemote = (chunk: Buffer): void => {
      writeSync(descriptor, chunk);
      remoteOutput = (remoteOutput + chunk.toString('utf8')).slice(-16_000);
    };
    remote.stdout?.on('data', saveRemote);
    remote.stderr?.on('data', saveRemote);
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
    if (growthProfilePath !== undefined && previousGrowthProfile !== '' && existsSync(growthProfilePath)) {
      const returnedProfile = readFileSync(growthProfilePath, 'utf8');
      if (returnedProfile !== previousGrowthProfile) {
        const separator = previousGrowthProfile.endsWith('\n') || returnedProfile === '' ? '' : '\n';
        writeFileSync(growthProfilePath, `${previousGrowthProfile}${separator}${returnedProfile}`);
      }
    }
    if (remoteCode !== 75 || !transportReason || remoteSignal !== undefined) {
      const commandPhases: Record<string, number> = {};
      for (const match of remoteOutput.matchAll(/remote-check: command phase ([^\s]+) ([0-9.]+) s/g))
        commandPhases[match[1]!] = Number(match[2]);
      if (ledger && Object.keys(commandPhases).length) ledger.commandPhases = commandPhases;
      const peakMiB = remoteOutput.match(/peak memory (\d+) MiB on [^\r\n]+/)?.[1];
      if (peakMiB) {
        const peakBytes = Number(peakMiB) * 2 ** 20;
        recordPeak(directory, commandClass, peakBytes);
        process.stderr.write(
          `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
        );
      }
      wait.stop();
      endLedger(remoteSignal === undefined ? remoteCode : 128 + remoteSignal, transportReason);
      closeSync(descriptor);
      return report(remoteSignal === undefined ? remoteCode : 128 + remoteSignal);
    }
    const retry = `worker-check: remote transport failed: ${transportReason}; retrying locally under memory lease\n`;
    process.stderr.write(retry);
    writeSync(descriptor, retry);
    endLedger(remoteCode, transportReason);
    ledger = undefined;
  }
  const leaseEnv = { ...env };
  // The memory lease is independent of any stack lease held by the caller.
  delete leaseEnv.REZICS_STACK_SLOT;
  delete leaseEnv.REZICS_STACK_LEASE;
  if (env.REZICS_CHECK_MEMORY === 'off') leaseEnv.REZICS_STACK_LEASE = 'off';
  if (env.REZICS_CHECK_MEMORY_LEASE !== undefined) leaseEnv.REZICS_STACK_SLOT = env.REZICS_CHECK_MEMORY_LEASE;
  const lease = noMemoryLease
    ? undefined
    : await acquireStackSlot(
        `worker-check: ${commandClass}`,
        {
          ...leaseEnv,
          REZICS_STACK_SLOTS: String(capacity),
          REZICS_STACK_LEASE_DIR: directory,
        },
        weight,
        (line) => writeSync(descriptor, `${line}\n`),
        leaseWaitRepeatMs,
      );
  beginLedger(hostname(), 0);
  if (lease)
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
      scoped ? 'systemd-run' : command[0]!,
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
            ...command,
          ]
        : command.slice(1),
      {
        cwd: root,
        env: { ...env, REZICS_CHECK_PEAK_FILE: peakFile },
        stdio: ['inherit', 'pipe', 'pipe'],
      },
    );
  } catch (error) {
    closeSync(descriptor);
    await lease?.release();
    throw error;
  }

  const save = (chunk: Buffer): void => {
    writeSync(descriptor, chunk);
  };
  child.stdout?.on('data', save);
  child.stderr?.on('data', save);
  wait.begin();

  let reportedCpuTicks = 0;
  const progressIntervalMs = Number(process.env.REZICS_CHECK_PROGRESS_INTERVAL_MS) || CPU_PROGRESS_INTERVAL_MS;
  const procRoot = process.env.REZICS_CHECK_PROC_ROOT || '/proc';
  if (process.env.REZICS_CHECK_PROGRESS_PID_FILE) {
    writeFileSync(process.env.REZICS_CHECK_PROGRESS_PID_FILE, String(child.pid));
  }
  const progressTimer = setInterval(() => {
    const cpuTicks = processTreeCpuTicks(child.pid!, procRoot);
    if (cpuTicks === undefined || cpuTicks - reportedCpuTicks < 100) return;
    reportedCpuTicks = cpuTicks;
    writeSync(descriptor, `worker-check: running, ${Math.floor(cpuTicks / 100)} CPU seconds\n`);
  }, progressIntervalMs);

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
  const physicalStarted = performance.now();
  try {
    code = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => {
        const fromSignal = signal === null ? undefined : SIGNALS[signal as keyof typeof SIGNALS];
        resolveExit(status ?? 128 + (fromSignal ?? 1));
      });
    });
  } finally {
    clearInterval(progressTimer);
    for (const [name, forward] of forwarders) process.off(name, forward);
    wait.stop();
    closeSync(descriptor);
    await lease?.release();
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
  endLedger(signalNumber === undefined ? code : 128 + signalNumber);
  if (ledger) {
    ledger.phases = { ...(ledger.phases ?? {}), command: (performance.now() - physicalStarted) / 1000 };
    writeLedger(ledger, checkout);
  }
  return signalNumber === undefined ? code : 128 + signalNumber;
}

/** Use the caller only when it is the repository's pinned Bun; otherwise select the installed repository binary. */
export function resolveRepositoryBun(
  command: readonly string[],
  root: string,
  executable = process.execPath,
): string[] {
  if (command[0] !== 'bun') return [...command];
  // Test fixtures and standalone check roots may not have a package manifest. In that case the
  // current Bun is the only available runtime; repository checks still enforce the pinned binary.
  if (!existsSync(join(root, 'package.json'))) return [executable, ...command.slice(1)];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const expected = manifest.packageManager?.startsWith('bun@') ? manifest.packageManager.slice(4) : '';
  if (!expected) throw new Error('package.json packageManager must pin Bun');
  const revision = spawnSync(join(root, 'node_modules/.bin/bun'), ['--eval', 'console.log(Bun.revision)'], {
    encoding: 'utf8',
  });
  if (revision.error || revision.status !== 0) throw revision.error ?? new Error('Could not read pinned Bun revision');
  const pinned = Bun.revision === revision.stdout.trim() ? executable : join(root, 'node_modules/.bin/bun');
  return [pinned, ...command.slice(1)];
}

/** Start a detached check whose durable result can be retrieved by id after this process exits. */
export function startWorkerCheck(argv: readonly string[], cwd = process.cwd()): string {
  if (argv.length === 0) throw new Error('A check command is required');
  const root = resolve(cwd);
  const id = randomUUID();
  const file = logPath(root);
  const record: CheckRecord = { id, cwd: root, argv: [...argv], status: 'running', log: relative(root, file) };
  writeRecord(record);
  const descriptor = openSync(file, 'a', 0o600);
  const child = spawn(process.execPath, [resolve(import.meta.path), '--run', id], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  record.runnerPid = child.pid;
  record.runnerHost = hostname();
  writeRecord(record);
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
  timeoutMs = WAIT_TIMEOUT_MS,
  monitor: CheckMonitor = {},
): Promise<number> {
  const root = resolve(cwd);
  const started = Date.now();
  const stallMs = monitor.stallMs ?? LOG_STALL_MS;
  const pollMs = monitor.pollMs ?? WAIT_POLL_MS;
  const write = monitor.write ?? ((text: string) => process.stdout.write(text));
  let record = readRecord(root, id);
  let lastGrowth = 0;
  while (record.status === 'running') {
    if (Date.now() - started >= timeoutMs) {
      if (record.infrastructureFailure) write(`${record.infrastructureFailure}\n`);
      write('check: still running\n');
      const latest = latestLogLine(join(root, record.log));
      if (latest) write(`${latest}\n`);
      write(`check: log ${record.log}\n`);
      return 75;
    }
    const file = join(root, record.log);
    let modifiedAt = Date.now();
    try {
      const stats = statSync(file);
      modifiedAt = stats.mtimeMs;
    } catch {
      // A runner can create its log just after publishing its result record.
    }
    if (lastGrowth === 0) {
      lastGrowth = modifiedAt;
    } else if (modifiedAt > lastGrowth) {
      lastGrowth = modifiedAt;
    }
    const alive = recordedRunnerAlive(record, id);
    if (alive === false) {
      return await rerunInterruptedCheck(
        record,
        root,
        id,
        'runner process exited',
        Math.max(0, timeoutMs - (Date.now() - started)),
        monitor,
      );
    }
    if (Date.now() - lastGrowth >= stallMs) {
      if (alive === true && record.runnerPid !== undefined) stopRunner(record.runnerPid);
      return await rerunInterruptedCheck(
        record,
        root,
        id,
        `log did not grow for ${stallMs < 60_000 ? `${stallMs} ms` : `${Math.round(stallMs / 60_000)} minutes`}`,
        Math.max(0, timeoutMs - (Date.now() - started)),
        monitor,
      );
    }
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - started)))),
    );
    record = readRecord(root, id);
  }
  if (record.infrastructureFailure) {
    write(`${record.infrastructureFailure}\n`);
    if (record.infrastructureFailureFinal) {
      write(`check: exit status 1\ncheck: log ${record.log}\n`);
      return 1;
    }
  }
  const code = record.exitCode ?? 1;
  const absoluteLog = join(root, record.log);
  write(`check: exit status ${code}\n`);
  if (code !== 0 && existsSync(absoluteLog)) write(`check: failure summary\n${failureSummary(absoluteLog)}\n`);
  write(`check: log ${record.log}\n`);
  return code;
}

function recordedRunnerAlive(record: CheckRecord, id: string): boolean | undefined {
  if (record.runnerHost !== hostname() || record.runnerPid === undefined) return undefined;
  try {
    process.kill(record.runnerPid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? undefined : false;
  }
  try {
    const command = readFileSync(`/proc/${record.runnerPid}/cmdline`, 'utf8').split('\0');
    const script = resolve(import.meta.path);
    const isThisRunner = command[1] === script && command[2] === '--run' && command[3] === id;
    return isThisRunner ? true : undefined;
  } catch {
    return undefined;
  }
}

function stopRunner(pid: number): void {
  try {
    // startWorkerCheck creates a detached process group for this runner and its check process.
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The runner may have exited between the liveness check and signal.
    }
  }
}

function latestLogLine(file: string): string {
  try {
    return (
      readFileSync(file, 'utf8')
        .trimEnd()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) ?? ''
    );
  } catch {
    return '';
  }
}

async function rerunInterruptedCheck(
  record: CheckRecord,
  root: string,
  id: string,
  reason: string,
  remainingMs: number,
  monitor: CheckMonitor,
): Promise<number> {
  const rerunStarted = Date.now();
  const host = record.runnerHost ?? hostname();
  const oldLog = record.log;
  if ((record.reruns ?? 0) >= 1) {
    record.status = 'finished';
    record.exitCode = 1;
    record.infrastructureFailureFinal = true;
    record.infrastructureFailure = `worker-check: infrastructure failure (${reason}) on ${host}; second runner failed; log ${oldLog}`;
    writeRecord(record);
    (monitor.write ?? ((text: string) => process.stdout.write(text)))(
      `${record.infrastructureFailure}\ncheck: exit status 1\ncheck: log ${oldLog}\n`,
    );
    return 1;
  }
  const rerunLog = logPath(root);
  record.reruns = 1;
  record.log = relative(root, rerunLog);
  record.runnerPid = undefined;
  record.runnerHost = hostname();
  record.infrastructureFailure = `worker-check: infrastructure failure (${reason}) on ${host}; rerunning once; old log ${oldLog}`;
  writeRecord(record);
  const descriptor = openSync(rerunLog, 'a', 0o600);
  const child = spawn(process.execPath, [resolve(import.meta.path), '--run', id], {
    cwd: root,
    detached: true,
    env: process.env,
    stdio: ['ignore', descriptor, descriptor],
  });
  closeSync(descriptor);
  record.runnerPid = child.pid;
  writeRecord(record);
  child.once('error', (error) => {
    record.status = 'finished';
    record.exitCode = 1;
    record.infrastructureFailure = `worker-check: infrastructure failure (could not start rerun: ${error.message}) on ${hostname()}; old log ${oldLog}`;
    writeRecord(record);
  });
  child.unref();
  return waitWorkerCheck(id, root, Math.max(0, remainingMs - (Date.now() - rerunStarted)), {
    ...monitor,
    ...(monitor.rerunStallMs === undefined ? {} : { stallMs: monitor.rerunStallMs }),
  });
}

async function runRecordedCheck(id: string, cwd = process.cwd()): Promise<number> {
  const root = resolve(cwd);
  const record = readRecord(root, id);
  record.runnerPid = process.pid;
  record.runnerHost = hostname();
  writeRecord(record);
  const finish = (exitCode: number): void => {
    // A superseded runner must never overwrite its detached replacement's result.
    const current = readRecord(root, id);
    if (current.log !== record.log || current.status !== 'running') return;
    record.status = 'finished';
    record.exitCode = exitCode;
    writeRecord(record);
  };
  try {
    const exitCode = await runWorkerCheck(
      record.argv,
      root,
      false,
      join(root, record.log),
      60_000,
      id,
      record.reruns ?? 0,
    );
    finish(exitCode);
    return exitCode;
  } catch (error) {
    finish(1);
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
