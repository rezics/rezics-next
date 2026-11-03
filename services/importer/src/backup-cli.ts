import {
  backupStoppedState,
  restoreStoppedStateSnapshot,
  validateStoppedStateSnapshot,
  type BackupDocument,
  type BackupOptions,
} from './state-backup.ts';
import { StateBackupFailure, backupExitCode } from './state-backup-errors.ts';

const MAX_ARGUMENTS_WITH_COMMAND = 64;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_TOTAL_ARGUMENT_BYTES = 16_384;
const COMMANDS = new Set(['backup', 'validate-snapshot', 'restore']);

const USAGE = [
  'Usage: rezics-import backup --state <sqlite-path> --output <snapshot-dir> [--json]',
  '       rezics-import validate-snapshot --snapshot <snapshot-dir> [--json]',
  '       rezics-import restore --snapshot <snapshot-dir> --state <new-sqlite-path> [--json]',
  '       rezics-import backup --help',
  'Stopped-state snapshots are local. They do not contact Auth or the API, create an Importer, or resume a run.',
  'A live or unverifiable owner is busy. Restoring cannot undo later native writes or replace ordinary import admission.',
].join('\n');

export type BackupCliResult = Readonly<{ code: number; stdout: string; stderr: string; openHandles: number }>;
export type BackupCliOptions = BackupOptions;

class UsageFailure extends StateBackupFailure {
  constructor(message: string) {
    super(message, 'unsafe-file', 2);
  }
}

type Parsed =
  | { command: 'backup'; state: string; output: string; json: boolean }
  | { command: 'validate-snapshot'; snapshot: string; json: boolean }
  | { command: 'restore'; snapshot: string; state: string; json: boolean };

function jsonSafe(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function boundedArguments(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS_WITH_COMMAND)
    throw new UsageFailure('Snapshot arguments exceed the supported count.');
  let totalBytes = 0;
  for (const argument of argv) {
    if (typeof argument !== 'string' || argument.length > MAX_ARGUMENT_BYTES || argument.includes('\0'))
      throw new UsageFailure('Snapshot arguments exceed the supported size.');
    totalBytes += Buffer.byteLength(argument, 'utf8');
    if (totalBytes > MAX_TOTAL_ARGUMENT_BYTES)
      throw new UsageFailure('Snapshot arguments exceed the supported size.');
  }
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value || !value.trim() || value === '-') throw new UsageFailure(`Snapshot flag ${flag} requires one value.`);
  return value;
}

export function parseBackupArgs(argv: readonly string[]): Parsed | 'help' {
  boundedArguments(argv);
  const command = argv[0];
  if (!command || !COMMANDS.has(command)) throw new UsageFailure('Unknown stopped-state snapshot command.');
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0] === '--help') return 'help';
  const values = new Map<string, string>();
  const valueFlags = new Set(['--state', '--output', '--snapshot']);
  let json = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index]!;
    if (flag === '--help') return 'help';
    if (flag === '--json') {
      if (json) throw new UsageFailure('Snapshot flags cannot be repeated.');
      json = true;
      continue;
    }
    if (!valueFlags.has(flag) || values.has(flag))
      throw new UsageFailure('Unknown, import-only or repeated snapshot flag.');
    const value = rest[++index];
    if (value === undefined || value.length === 0 || value.startsWith('--'))
      throw new UsageFailure(`Snapshot flag ${flag} requires one value.`);
    values.set(flag, value);
  }
  if (command === 'backup') {
    if (values.has('--snapshot')) throw new UsageFailure('backup uses --state and --output.');
    return { command, state: required(values, '--state'), output: required(values, '--output'), json };
  }
  if (command === 'validate-snapshot') {
    if (values.has('--state') || values.has('--output'))
      throw new UsageFailure('validate-snapshot uses --snapshot.');
    return { command, snapshot: required(values, '--snapshot'), json };
  }
  if (values.has('--output')) throw new UsageFailure('restore uses --snapshot and --state.');
  return { command: 'restore', snapshot: required(values, '--snapshot'), state: required(values, '--state'), json };
}

function render(document: BackupDocument): string {
  const lines = [
    `Stopped-state snapshot: ${document.operation}`,
    `Status: ${document.status}`,
  ];
  if (document.snapshot) lines.push(`Snapshot directory: ${JSON.stringify(document.snapshot)}`);
  if (document.state) lines.push(`State file: ${JSON.stringify(document.state)}`);
  if (document.createdAt) lines.push(`Created: ${document.createdAt}`);
  lines.push(`SQLite bytes: ${document.bytes}; SHA-256 ${document.sha256}`);
  lines.push(
    `SQLite compatibility: page size ${document.sqliteCompatibility.pageSize}, pages ${document.sqliteCompatibility.pageCount}, user_version ${document.sqliteCompatibility.userVersion}`,
  );
  if (document.integrityPages !== undefined)
    lines.push(`SQLite integrity_check scanned ${document.integrityPages} pages.`);
  if (document.runs.length === 0) lines.push('Captured runs: none stored.');
  for (const run of document.runs) {
    lines.push(
      `Source ${JSON.stringify(run.source)}: baseline ${run.baselineGeneration ?? 'none'}, active ${run.activeGeneration ?? 'none'}, status ${run.status ?? 'none'}, present ${run.presentCount}, owner row ${run.ownerRow}.`,
    );
  }
  lines.push(document.resume);
  return `${lines.join('\n')}\n`;
}

function errorMessage(error: unknown): { code: number; message: string } {
  if (error instanceof StateBackupFailure) return { code: error.code, message: error.message };
  return { code: 1, message: 'Stopped-state snapshot work failed safely; source files were not replaced.' };
}

function requestedJson(argv: readonly string[]): boolean {
  return Array.isArray(argv) && argv.includes('--json');
}

/** Local snapshot route. It does not construct credentials, transport or importer objects. */
export async function runBackupCli(argv: readonly string[], options: BackupCliOptions = {}): Promise<BackupCliResult> {
  const jsonRequested = requestedJson(argv);
  let parsed: Parsed | 'help';
  try {
    parsed = parseBackupArgs(argv);
    if (parsed === 'help') return { code: 0, stdout: `${USAGE}\n`, stderr: '', openHandles: 0 };
  } catch (error) {
    const detail = errorMessage(error);
    if (jsonRequested)
      return { code: detail.code, stdout: `${jsonSafe({ version: 1, error: detail.message })}\n`, stderr: '', openHandles: 0 };
    return { code: detail.code, stdout: '', stderr: `${terminalSafe(detail.message)}\n${USAGE}\n`, openHandles: 0 };
  }

  let document: BackupDocument | undefined;
  let failure: { code: number; message: string } | undefined;
  try {
    if (parsed.command === 'backup') document = await backupStoppedState({ state: parsed.state, output: parsed.output }, options);
    else if (parsed.command === 'validate-snapshot')
      document = await validateStoppedStateSnapshot({ snapshot: parsed.snapshot }, options);
    else document = await restoreStoppedStateSnapshot({ snapshot: parsed.snapshot, state: parsed.state }, options);
  } catch (error) {
    failure = errorMessage(error);
  }
  if (failure) {
    if (parsed.json)
      return { code: failure.code, stdout: `${jsonSafe({ version: 1, error: failure.message })}\n`, stderr: '', openHandles: 0 };
    return { code: failure.code, stdout: '', stderr: `${terminalSafe(failure.message)}\n`, openHandles: 0 };
  }
  return {
    code: backupExitCode('ready'),
    stdout: parsed.json ? `${jsonSafe(document)}\n` : render(document!),
    stderr: '',
    openHandles: 0,
  };
}
