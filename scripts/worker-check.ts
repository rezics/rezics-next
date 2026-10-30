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
import { checkWaitRecorder, executionCancellation, requestExecutionCancellation, ownedLocalCommand, parseRunLifetimeFailure,
  parseRemotePhysicalRunReceipt, RUN_LIFETIME_FAILURE_MARKER, type RemotePhysicalRunReceipt } from './remote-check.ts';
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

/** The host receipt, rather than exit 124 or test output, establishes a terminal infrastructure timeout. */
export function remoteLifetimeInfrastructureCause(output: string, physical?: RemotePhysicalRunReceipt): string | undefined {
  const receipt = parseRunLifetimeFailure(output);
  return receipt && physical?.lifetimeFailure && physical.exitCode === 124 && receipt.host === physical.host &&
    receipt.run === physical.run && JSON.stringify(receipt) === JSON.stringify(physical.lifetimeFailure)
    ? RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(receipt) : undefined;
}

export function workerCheckCancellation(id: string, cwd = process.cwd()) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid worker check id');
  return { id, file: join(resolve(cwd), '.temp/goal/checks/cancellations', `${id}.json`) };
}

/** Publish durable logical cancellation before the controller invokes its supported owned-process stop protocol. */
export function requestWorkerCheckCancellation(id: string, cwd = process.cwd(), signal: 1 | 2 | 15 = 15): void {
  if (readRecord(resolve(cwd), id).status === 'running')
    requestExecutionCancellation(workerCheckCancellation(id, cwd), signal);
}

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
  physicalRun?: RemotePhysicalRunReceipt;
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
      /error|fail|not ok|assert|expected|received|actual|panic|exception|deadline_exceeded|overloaded|\b503\b/i.test(
        line,
      ),
    );
    const summary = [...new Set(failures.length ? failures : lines.slice(-30))].slice(-30).join('\n');
    return summary.slice(-4_000) || '(the check produced no output)';
  } finally {
    closeSync(fd);
  }
}

type OverloadFailure = { files: string[]; reasons: string[] };

/** Classify complete Bun per-test failures; ambiguous output is never retried. */
function overloadFailure(output: string): OverloadFailure | undefined {
  const singleFailureFallback = (): OverloadFailure | undefined => {
    const count = output.match(/^\s*\(fail\)\s+/gm)?.length ?? 0;
    const errorLines = output.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
    const codes = ['deadline_exceeded', 'overloaded'].filter(
      (code) => errorLines.length === 1 && new RegExp(`\\b${code}\\b`).test(errorLines[0]!),
    );
    if (count !== 1 || errorLines.length !== 1 || !/\b503\b/.test(errorLines[0]!) || codes.length !== 1)
      return undefined;
    const names = new Map<string, string>();
    const absoluteNames = new Map<string, string>();
    for (const match of output.matchAll(
      /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/g,
    )) {
      const path = match[1]!;
      const name = path.split('/').at(-1)!;
      if (!names.has(name) || path.startsWith('/')) names.set(name, path);
      if (path.startsWith('/')) absoluteNames.set(name, path);
    }
    const candidates = absoluteNames.size ? absoluteNames : names;
    return { files: candidates.size === 1 ? [...candidates.values()] : [], reasons: [`HTTP 503 ${codes[0]}`] };
  };
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const failures: Array<{ file?: string; detail: string }> = [];
  const preamble: string[] = [];
  let currentFile: string | undefined;
  let currentFailure: { file?: string; detail: string } | undefined;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/.test(trimmed)) {
      currentFile = trimmed.slice(0, -1).replace(/^(?:\.\.\/|\.\/)/, '');
      continue;
    }
    if (/^\s*\(fail\)\s+/.test(line)) {
      if (currentFailure) failures.push(currentFailure);
      currentFailure = {
        file: currentFile,
        detail: `${failures.length === 0 ? `${preamble.join('\n')}\n` : ''}${line}`,
      };
    } else if (currentFailure) currentFailure.detail += `\n${line}`;
    else preamble.push(line);
  }
  if (currentFailure) failures.push(currentFailure);
  if (failures.length === 0) return singleFailureFallback();
  const reasons: string[] = [];
  for (const failure of failures) {
    const errorLines = failure.detail.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
    const codes = ['deadline_exceeded', 'overloaded'].filter(
      (code) => errorLines.length === 1 && new RegExp(`\\b${code}\\b`).test(errorLines[0]!),
    );
    if (errorLines.length !== 1 || !/\b503\b/.test(errorLines[0]!) || codes.length !== 1)
      return singleFailureFallback();
    reasons.push(`HTTP 503 ${codes[0]}`);
  }
  let files = [
    ...new Set(
      failures
        .map((failure) => {
          if (failure.file) return failure.file;
          return failure.detail.match(
            /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/,
          )?.[1];
        })
        .filter((file): file is string => !!file),
    ),
  ];
  if (files.length !== failures.length) {
    const byName = new Map<string, string>();
    for (const match of output.matchAll(
      /((?:\/?[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/g,
    )) {
      const path = match[1]!;
      const name = path.split('/').at(-1)!;
      if (!byName.has(name) || path.startsWith('/')) byName.set(name, path);
    }
    if (byName.size === failures.length) files = [...byName.values()];
  }
  return { files: files.length === failures.length ? files : [], reasons: [...new Set(reasons)] };
}

function overloadRerunCommand(argv: readonly string[], files: string[], cwd: string): string[] | undefined {
  const isBun = argv[0] === 'bun' || argv[0] === process.execPath || argv[0]!.endsWith('/bun');
  const isTest = isBun && argv[1] === 'test';
  const isCheckRunner = isBun && argv[1] === 'run';
  if (!files.length || (!isTest && !isCheckRunner)) return undefined;
  let testRoot = resolve(cwd);
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === '--cwd' && argv[index + 1]) testRoot = resolve(cwd, argv[index + 1]!);
    else if (argv[index]!.startsWith('--cwd=')) testRoot = resolve(cwd, argv[index]!.slice(6));
  }
  const isTestPath = (arg: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg);
  const command = [...argv];
  const first = command.findIndex(isTestPath);
  const last = command.findLastIndex(isTestPath);
  if (first >= 0) command.splice(first, last - first + 1, ...files);
  else if (isTest) command.push(...files);
  else command.push(...files.map((file) => resolve(testRoot, file)));
  return command;
}

function checkLogContents(file: string): string {
  try {
    const output = readFileSync(file, 'utf8');
    return output.length <= 4_000_000 ? output : '';
  } catch {
    return '';
  }
}

type EnvironmentCommand = { prefix: string[]; command: string[] };

/** Parse the ordinary `env` prefix forms without interpreting shell text. */
function splitEnvironmentCommand(argv: readonly string[]): EnvironmentCommand | undefined {
  const parseOne = (input: readonly string[]): EnvironmentCommand | undefined => {
    const executable = input[0] ?? '';
    const prefix = [executable];
    let index = 1;
    while (index < input.length) {
      const argument = input[index]!;
      if (argument === '--') {
        prefix.push(argument);
        index += 1;
        break;
      }
      if (argument === '-u' || argument === '--unset') {
        const name = input[index + 1];
        if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
        prefix.push(argument, name);
        index += 2;
        continue;
      }
      if (argument.startsWith('--unset=')) {
        const name = argument.slice('--unset='.length);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
        prefix.push(argument);
        index += 1;
        continue;
      }
      if (argument === '-i' || argument === '--ignore-environment') {
        prefix.push(argument);
        index += 1;
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argument)) {
        prefix.push(argument);
        index += 1;
        continue;
      }
      if (argument.startsWith('-')) return undefined;
      break;
    }
    if (index >= input.length) return undefined;
    return { prefix, command: input.slice(index) };
  };

  let command = [...argv];
  const prefix: string[] = [];
  while (command[0]?.split(/[\\/]/).at(-1) === 'env') {
    const parsed = parseOne(command);
    if (!parsed) return undefined;
    prefix.push(...parsed.prefix);
    command = parsed.command;
    if (prefix.includes('--')) break;
  }
  return { prefix, command };
}

function pathSegments(path: string): string[] {
  return resolve(path)
    .split(/[\\/]+/)
    .filter(Boolean);
}

function hasPathPair(path: string, parent: string, child: string): boolean {
  const segments = pathSegments(path);
  return segments.some((segment, index) => segment === parent && segments[index + 1] === child);
}

/** Paths whose runner owns a database, browser, or other stack admission. */
function isNativeStackPath(path: string): boolean {
  return (
    hasPathPair(path, 'services', 'kernel') ||
    hasPathPair(path, 'services', 'auth') ||
    hasPathPair(path, 'apps', 'auth') ||
    hasPathPair(path, 'apps', 'web')
  );
}

function isNativeScript(path: string): boolean {
  const segments = pathSegments(path);
  const entries = [
    ['scripts', 'typecheck.ts'],
    ['scripts', 'typecheck.test.ts'],
    ['scripts', 'remote-check.ts'],
    ['scripts', 'remote-check.test.ts'],
  ];
  return entries.some((entry) =>
    segments.some((segment, index) => segment === entry[0] && segments[index + 1] === entry[1]),
  );
}

function bunExecutable(value: string): boolean {
  return value === 'bun' || value === process.execPath || value.split(/[\\/]/).at(-1) === 'bun';
}

function executableName(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

function projectNeedsNativeStack(args: readonly string[], cwd: string): boolean {
  if (isNativeStackPath(cwd)) return true;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const project =
      argument === '-p' || argument === '--project'
        ? args[index + 1]
        : argument.startsWith('--project=')
          ? argument.slice('--project='.length)
          : undefined;
    if (project && isNativeStackPath(resolve(cwd, project))) return true;
  }
  return false;
}

function pureCompilerOrTool(command: string, args: readonly string[], cwd: string): boolean {
  const name = executableName(command);
  if (name === 'oxlint' || name === 'oxfmt') return true;
  if (name === 'tsc') return args.includes('--noEmit') && !projectNeedsNativeStack(args, cwd);
  if (name === 'check') {
    const hasProject = args.some(
      (argument, index) => argument === '-p' || argument === '--project' || argument.startsWith('--project='),
    );
    return args.includes('--no-script') && hasProject && !projectNeedsNativeStack(args, cwd);
  }
  if (name === 'lint') return args.includes('--no-script');
  return false;
}

function packageScript(cwd: string, script: string): string | undefined {
  let directory = resolve(cwd);
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { scripts?: Record<string, unknown> };
        const value = parsed.scripts?.[script];
        return typeof value === 'string' ? value : undefined;
      } catch {
        return undefined;
      }
    }
    const parent = resolve(directory, '..');
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function testFilesNeedStack(args: readonly string[], cwd: string): boolean {
  let directory = cwd;
  const files: string[] = [];
  const selectors = new Set(['-t', '--test-name-pattern']);
  const preloadOptions = new Set(['--preload', '--require', '-r']);
  const valueOptions = new Set([
    '--bail',
    '--coverage-dir',
    '--coverage-reporter',
    '--coverage-threshold',
    '--max-concurrency',
    '--rerun-each',
    '--timeout',
  ]);
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!optionsEnded && argument === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (argument === '--cwd' || argument.startsWith('--cwd='))) {
      const value = argument === '--cwd' ? args[index + 1] : argument.slice('--cwd='.length);
      if (!value) return true;
      directory = resolve(cwd, value);
      if (argument === '--cwd') index += 1;
      continue;
    }
    if (!optionsEnded && argument.startsWith('-')) {
      const separator = argument.indexOf('=');
      const option = separator < 0 ? argument : argument.slice(0, separator);
      const inlineValue = separator >= 0;
      if (selectors.has(option) || valueOptions.has(option) || preloadOptions.has(option)) {
        const value = inlineValue ? argument.slice(separator + 1) : args[index + 1];
        if (value === undefined) return true;
        if (!inlineValue) index += 1;
        if (preloadOptions.has(option)) {
          if (
            /[*?{}\[\]]/.test(value) ||
            isNativeStackPath(resolve(directory, value)) ||
            isNativeScript(resolve(directory, value)) ||
            (!value.startsWith('.') && !value.startsWith('/') && !value.includes('/') && !value.includes('\\'))
          )
            return true;
        }
      }
      continue;
    }
    if (/[*?{}\[\]]/.test(argument)) return true;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument)) {
      files.push(resolve(directory, argument));
      continue;
    }
    // Extra positional arguments can discover tests or supply an unresolved file or directory.
    return true;
  }
  if (files.length === 0 || isNativeStackPath(directory)) return true;
  return files.some((file) => isNativeStackPath(file) || isNativeScript(file));
}

function classifyWorkerCommand(argv: readonly string[], cwd: string, depth = 0): boolean {
  if (argv.length === 0 || depth > 4) return true;
  const command = argv[0]!;
  const args = argv.slice(1);
  const name = executableName(command);
  if (['sh', 'bash', 'dash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd'].includes(name)) return true;

  if (bunExecutable(command)) {
    let index = 1;
    let directory = cwd;
    while (index < argv.length) {
      const argument = argv[index]!;
      if (argument === '--cwd' && argv[index + 1]) {
        directory = resolve(cwd, argv[index + 1]!);
        index += 2;
      } else if (argument.startsWith('--cwd=')) {
        directory = resolve(cwd, argument.slice('--cwd='.length));
        index += 1;
      } else break;
    }
    const operation = argv[index];
    const rest = argv.slice(index + 1);
    if (operation === 'test') return testFilesNeedStack(rest, directory);
    if (operation === 'run') {
      let scriptIndex = index + 1;
      while (scriptIndex < argv.length) {
        const argument = argv[scriptIndex]!;
        if (argument === '--cwd' && argv[scriptIndex + 1]) {
          directory = resolve(cwd, argv[scriptIndex + 1]!);
          scriptIndex += 2;
        } else if (argument.startsWith('--cwd=')) {
          directory = resolve(cwd, argument.slice('--cwd='.length));
          scriptIndex += 1;
        } else break;
      }
      const script = argv[scriptIndex];
      if (!script || isNativeStackPath(directory)) return true;
      const scriptPath = resolve(directory, script);
      if (isNativeStackPath(scriptPath) || isNativeScript(scriptPath)) return true;
      if (script.includes('/') || script.includes('\\') || /\.(?:[cm]?[jt]sx?)$/.test(script)) return true;
      const source = packageScript(directory, script);
      if (!source || /[;&|<>`$]/.test(source)) return true;
      const tokens = source.trim().split(/\s+/).filter(Boolean);
      return tokens.length === 0 || classifyWorkerCommand(tokens, directory, depth + 1);
    }
    if (operation === 'x') {
      const tool = rest[0];
      if (!tool) return true;
      return !pureCompilerOrTool(tool, rest.slice(1), directory);
    }
    if (operation === 'check' || operation === 'lint') return !pureCompilerOrTool(operation, rest, directory);
    if (operation === 'fmt') return false;
    if (operation && (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(operation) || operation.endsWith('.ts'))) {
      return true;
    }
    return true;
  }

  if (name === 'oxlint' || name === 'oxfmt') return false;
  if (name === 'tsc') return !pureCompilerOrTool(command, args, cwd);
  return true;
}

/** Whether the command has a known stack requirement; unknown commands stay on the existing admission path. */
export function workerCheckNeedsStack(argv: readonly string[], cwd = process.cwd()): boolean {
  const parsed = splitEnvironmentCommand(argv);
  if (!parsed) return true;
  return classifyWorkerCommand(parsed.command, resolve(cwd));
}

export async function runWorkerCheck(
  argv: readonly string[],
  cwd = process.cwd(),
  reportOutput = true,
  recordedLog?: string,
  leaseWaitRepeatMs = 60_000,
  logicalCheckId?: string,
  rerunNumber = 0,
  recordedCheckId?: string,
  allowOverloadRerun = true,
): Promise<number> {
  if (argv.length === 0) throw new Error('A check command is required');
  let localOnly = false;
  const returnPaths: string[] = [];
  while (argv[0]?.startsWith('--') && argv[0] !== '--') {
    if (argv[0] === '--local') {
      localOnly = true;
      argv = argv.slice(1);
    } else if (argv[0] === '--returns') {
      if (!argv[1] || argv[1] === '--') throw new Error('--returns requires a path');
      returnPaths.push(argv[1]);
      argv = argv.slice(2);
    } else break;
  }
  if (argv[0] === '--') argv = argv.slice(1);
  if (argv.length === 0) throw new Error('Usage: worker-check.ts [--local] [--returns <path>...] -- <command...>');
  const root = resolve(cwd);
  const cancellation = workerCheckCancellation(recordedCheckId ?? (/^[0-9a-f-]{36}$/i.test(logicalCheckId ?? '') ? logicalCheckId! : randomUUID()), root);
  const cancelled = () => executionCancellation(cancellation);
  const initialIntent = cancelled();
  if (initialIntent) return 128 + initialIntent.signal;
  const file = recordedLog ?? logPath(root);
  const descriptor = openSync(file, recordedLog ? 'a' : 'wx', 0o600);
  const wait = checkWaitRecorder(process.env.GOAL_CHECK_WAIT_FILE);
  wait.begin();
  const env = { ...process.env };
  env.REMOTE_CHECK_CANCELLATION_FILE = cancellation.file;
  env.REMOTE_CHECK_CANCELLATION_ID = cancellation.id;
  applyTaskPriority(root, env);
  // The wrapper records the complete command duration; nested stack and remote wait recorders would double-count it.
  delete env.GOAL_CHECK_WAIT_FILE;
  const needsStack = workerCheckNeedsStack(argv, root);
  const commandClass = checkClass(argv, root);
  argv = scopeRootTypecheck(argv, root, env, (line) => writeSync(descriptor, `${line}\n`));
  const command = resolveRepositoryBun(argv, root);
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
  if (needsStack && !localOnly && env.KERNEL_CHECK_ON_REMOTE !== '1' && remoteHostsFile && weight >= 2) {
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
    let physical: RemotePhysicalRunReceipt | undefined;
    let transportReason: string | undefined;
    let receiptContents = '';
    const receiptNonce = randomUUID();
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
        ...returnPaths.flatMap((path) => ['--returns', path]),
        root,
        '--',
        ...remoteCommand,
      ],
      {
        cwd: root,
        env: { ...env, REZICS_CHECK_MEMORY: 'off', REZICS_STACK_LEASE: 'off', REMOTE_CHECK_RECEIPT_FD: '3', REMOTE_CHECK_RECEIPT_NONCE: receiptNonce },
        stdio: ['inherit', 'pipe', 'pipe', 'pipe'],
      },
    );
    (remote.stdio[3] as import('node:stream').Readable).on('data', (chunk: Buffer) => {
      receiptContents += chunk.toString('utf8');
      if (receiptContents.length > 512_000) { receiptContents = ''; return; }
      let newline: number;
      while ((newline = receiptContents.indexOf('\n')) >= 0) {
        const line = receiptContents.slice(0, newline);
        receiptContents = receiptContents.slice(newline + 1);
        try {
          const envelope = JSON.parse(line);
          const candidate = parseRemotePhysicalRunReceipt(envelope.receipt);
          if (envelope.nonce === receiptNonce && candidate) physical = candidate;
          const failure = envelope.transportFailure;
          if (envelope.nonce === receiptNonce && failure?.schema === 1 && typeof failure.message === 'string' &&
              failure.message.length <= 2000 && failure.message.startsWith('remote-check: connection to '))
            transportReason = failure.message;
        } catch { /* A malformed channel is unavailable, never a native verdict or fabricated receipt. */ }
      }
    });
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
        requestExecutionCancellation(cancellation, number);
        remote.kill(name);
      };
      process.on(name, forward);
      return [name, forward] as const;
    });
    const cancellationTimer = setInterval(() => {
      const intent = cancelled();
      if (intent) { remoteSignal ??= intent.signal; remote.kill(intent.signal === 1 ? 'SIGHUP' : intent.signal === 2 ? 'SIGINT' : 'SIGTERM'); }
    }, 25);
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
      clearInterval(cancellationTimer);
      for (const [name, forward] of remoteForwarders) process.off(name, forward);
    }
    const lifetimeReason = physical?.lifetimeFailure
      ? remoteLifetimeInfrastructureCause(RUN_LIFETIME_FAILURE_MARKER + JSON.stringify(physical.lifetimeFailure), physical)
      : undefined;
    remoteSignal ??= cancelled()?.signal;
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
      if (recordedCheckId && physical) {
        const record = readRecord(root, recordedCheckId);
        record.physicalRun = physical;
        if (lifetimeReason) record.infrastructureFailure = lifetimeReason;
        writeRecord(record);
      }
      endLedger(remoteSignal === undefined ? remoteCode : 128 + remoteSignal, lifetimeReason ?? transportReason);
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
  const admissionCancellation = cancelled();
  if (admissionCancellation) {
    await lease?.release();
    wait.stop();
    closeSync(descriptor);
    return 128 + admissionCancellation.signal;
  }
  beginLedger(hostname(), 0);
  if (lease)
    env.REZICS_CHECK_MEMORY_LEASE = lease.env.REZICS_STACK_SLOT ?? env.REZICS_CHECK_MEMORY_LEASE ?? 'inherited';
  let child: ReturnType<typeof spawn>;
  let scoped = false;
  const peakFile = join(directory, `peak.${process.pid}.${randomUUID()}.tmp`);
  const ownedCommand = ownedLocalCommand(command);
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
    const intent = cancelled();
    if (intent) {
      wait.stop();
      closeSync(descriptor);
      await lease?.release();
      endLedger(128 + intent.signal);
      return 128 + intent.signal;
    }
    child = spawn(
      scoped ? 'systemd-run' : ownedCommand[0]!,
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
            ...ownedCommand,
          ]
        : ownedCommand.slice(1),
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
      requestExecutionCancellation(cancellation, number);
      child.kill(name);
    };
    process.on(name, forward);
    return [name, forward] as const;
  });
  const localCancellationTimer = setInterval(() => {
    const intent = cancelled();
    if (intent) { signalNumber ??= intent.signal; child.kill(intent.signal === 1 ? 'SIGHUP' : intent.signal === 2 ? 'SIGINT' : 'SIGTERM'); }
  }, 25);

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
    clearInterval(localCancellationTimer);
    clearInterval(progressTimer);
    for (const [name, forward] of forwarders) process.off(name, forward);
    wait.stop();
    closeSync(descriptor);
    await lease?.release();
  }

  signalNumber ??= cancelled()?.signal;

  if (scoped) {
    const peakBytes = recordScopedPeak(directory, commandClass, peakFile);
    if (peakBytes !== undefined) {
      process.stderr.write(
        `worker-check: ${commandClass} peak ${(peakBytes / 2 ** 30).toFixed(1)} GiB (weight ${weight})\n`,
      );
    }
  }
  rmSync(peakFile, { force: true });
  if (code !== 0 && signalNumber === undefined && allowOverloadRerun) {
    const output = checkLogContents(file);
    const overload =
      overloadFailure(output) ??
      (() => {
        const firstFailure = output.indexOf('(fail)');
        const onlyOneFailure = firstFailure >= 0 && output.indexOf('(fail)', firstFailure + 6) < 0;
        const errorLines = output.split(/\r?\n/).filter((line) => /^\s*(?:error|Error):/.test(line));
        const reason =
          errorLines.length === 1
            ? ['deadline_exceeded', 'overloaded'].find((code) =>
                new RegExp(`\\b503\\b.*\\b${code}\\b|\\b${code}\\b.*\\b503\\b`).test(errorLines[0]!),
              )
            : undefined;
        if (!onlyOneFailure || !reason) return undefined;
        const fileHeader = output
          .slice(0, firstFailure)
          .match(/^\s*([^\s]+\.(?:test|spec)\.[cm]?[jt]sx?):\s*$/gm)
          ?.at(-1)
          ?.trim()
          .replace(/:$/, '');
        return { files: fileHeader ? [fileHeader] : [], reasons: [`HTTP 503 ${reason}`] };
      })();
    if (overload) {
      endLedger(code);
      const rerunCommand = overloadRerunCommand(command, overload.files, root);
      const filesLabel = rerunCommand
        ? overload.files.join(', ')
        : overload.files.length
          ? `whole command (could not select attributed files: ${overload.files.join(', ')})`
          : 'whole command (test files could not be attributed)';
      const reason = overload.reasons.join(', ');
      const line = `worker-check: overload rerun files ${filesLabel}; reason: ${reason}; host: ${hostname()}\n`;
      const append = openSync(file, 'a');
      try {
        writeSync(append, line);
      } finally {
        closeSync(append);
      }
      if (recordedCheckId) {
        const record = readRecord(root, recordedCheckId);
        record.reruns = (record.reruns ?? 0) + 1;
        writeRecord(record);
      }
      process.stderr.write(line);
      const rerunStatus = await runWorkerCheck(
        rerunCommand ?? command,
        root,
        false,
        file,
        leaseWaitRepeatMs,
        logicalCheckId,
        rerunNumber + 1,
        recordedCheckId,
        false,
      );
      if (rerunStatus !== 0) {
        const second = overloadFailure(checkLogContents(file));
        if (second) {
          const secondLine = `worker-check: overload rerun failed; second failure reason: ${second.reasons.join(', ')}; host: ${hostname()}\n`;
          const secondAppend = openSync(file, 'a');
          try {
            writeSync(secondAppend, secondLine);
          } finally {
            closeSync(secondAppend);
          }
        }
      }
      if (reportOutput) {
        process.stdout.write(`check: exit status ${rerunStatus}\n`);
        if (rerunStatus !== 0) process.stdout.write(`check: failure summary\n${failureSummary(file)}\n`);
        process.stdout.write(`check: log ${relativeLogPath}\n`);
      }
      return rerunStatus;
    }
  }
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

/** Match landing's changed-file scope for the root typecheck before choosing local or remote placement. */
export function scopeRootTypecheck(
  argv: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): string[] {
  if (!argv.some((argument) => argument === 'scripts/typecheck.ts') || environment.TYPECHECK_CHANGED !== undefined)
    return [...argv];

  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const dev = git(['rev-parse', '--verify', 'dev^{commit}']);
  const base = dev.status === 0 ? git(['merge-base', 'HEAD', 'dev']) : undefined;
  if (base?.status !== 0 || !base?.stdout.trim()) {
    write('worker-check: scripts/typecheck.ts running unscoped (dev ref or merge base unavailable)');
    return [...argv];
  }

  const mergeBase = base.stdout.trim();
  const diff = git(['diff', '--name-only', '--no-renames', mergeBase]);
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (diff.status !== 0 || untracked.status !== 0) {
    write('worker-check: scripts/typecheck.ts running unscoped (could not list changed files)');
    return [...argv];
  }
  const changed = [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))];
  const changedValue = changed.join('\n');
  write(`worker-check: scripts/typecheck.ts scoped to ${changed.length} changed files from ${mergeBase}`);
  return ['env', `TYPECHECK_CHANGED=${changedValue}`, ...argv];
}

/** Use the caller only when it is the repository's pinned Bun; otherwise select the installed repository binary. */
export function resolveRepositoryBun(
  command: readonly string[],
  root: string,
  executable = process.execPath,
): string[] {
  const parsed = splitEnvironmentCommand(command);
  if (!parsed || parsed.command[0] !== 'bun') return [...command];
  const prefix = parsed.prefix;
  const args = parsed.command.slice(1);
  // Test fixtures and standalone check roots may not have a package manifest. In that case the
  // current Bun is the only available runtime; repository checks still enforce the pinned binary.
  if (!existsSync(join(root, 'package.json'))) return [...prefix, executable, ...args];
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
  return [...prefix, pinned, ...args];
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
    const cancellation = executionCancellation(workerCheckCancellation(id, root));
    if (cancellation) {
      write('check: cancellation requested; automatic restart is disabled\n');
      return 128 + cancellation.signal;
    }
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
  const cancellation = executionCancellation(workerCheckCancellation(id, root));
  if (cancellation) return 128 + cancellation.signal;
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
    current.status = 'finished';
    current.exitCode = exitCode;
    writeRecord(current);
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
      id,
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
    throw new Error('Usage: worker-check.ts [--local] [--returns <path>...] -- <command...>');
  }
  return command;
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args[0] === '--wait' && args[1]) process.exitCode = await waitWorkerCheck(args[1]);
    else if (args[0] === '--run' && /^[0-9a-f-]{36}$/i.test(args[1] ?? ''))
      process.exitCode = await runRecordedCheck(args[1]!);
    else {
      const id = startWorkerCheck(parse(args[0] === '--run' ? args.slice(1) : args));
      process.stdout.write(`check: id ${id}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
