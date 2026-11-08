import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isTransportTimeout } from './check-failure.ts';
import { CHECK_HOST_TRANSPORT } from './records.ts';
import type {
  DevVerifierCommand,
  DevVerifierDiagnostic,
  DevVerifierDiagnosticLocation,
  DevVerifierEvidence,
} from './types.ts';

export type DiagnosticWorkspaceContext = {
  repositoryRoot?: string;
  /** The check's repository-relative cwd, used until output names a nested workspace. */
  workspace?: string;
};

type VerifierCheckInput = Pick<DevVerifierEvidence, 'command' | 'cwd' | 'output'>;

const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const TEST_FLAGS_WITH_VALUE = new Set([
  '--timeout',
  '--preload',
  '--rerun-each',
  '--retry',
  '--coverage-reporter',
  '--coverage-dir',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--changed',
  '--seed',
  '--shard',
  '--timings',
  '--parallel-delay',
  '--parallel',
  '-t',
]);
const WORKSPACE_COMMAND = /^\s*\$\s+.+\s+\(((?:apps|services|packages|tools)\/[^)]+)\)\s*$/;
const TSV_DIAGNOSTIC = /^\s*(.+?\.(?:[cm]?[jt]sx?))\((\d+),\s*(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/;
const TSV_DIAGNOSTIC_COLON = /^\s*(.+?\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.*)$/;
const CLEANUP_FAILURE =
  /(?:cleanup|resource settlement|resource cleanup).{0,100}(?:could not be proven|failed|incomplete|unsettled|timed out|malformed|unknown)|(?:could not be proven|failed|incomplete|unsettled|timed out|malformed).{0,100}(?:cleanup|resource settlement|resource cleanup)/i;
const RSYNC_TELEMETRY =
  /^\s*(?:total bytes (?:received|sent):\s*\d+|sent\s+\d+\s+bytes\s+received\s+\d+\s+bytes\b|total size is\s+\d+\s+speedup is\s+[\d.]+)/i;

function repoRelativePath(
  rawPath: string,
  context: DiagnosticWorkspaceContext,
  workspace: string,
): {
  file: string;
  resolved: boolean;
} {
  const normalized = rawPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const repositoryRoot = context.repositoryRoot ? resolve(context.repositoryRoot) : undefined;
  if (!repositoryRoot) return { file: normalized, resolved: false };
  if (/^[A-Za-z]:\//.test(normalized) && !isAbsolute(normalized)) return { file: normalized, resolved: false };

  const currentWorkspace = workspace.replace(/\/+$/, '');
  const pathNamesWorkspace =
    !!currentWorkspace && (normalized === currentWorkspace || normalized.startsWith(currentWorkspace + '/'));
  const pathNamesAnotherWorkspace =
    /^(?:apps|services|packages|tools)\/[^/]+\//.test(normalized) && !pathNamesWorkspace;
  const repositoryPath =
    pathNamesWorkspace ||
    pathNamesAnotherWorkspace ||
    (!workspace && /^(?:apps|services|packages|tools|scripts|docs)\//.test(normalized));
  if (!repositoryPath && !workspace && context.workspace === undefined) return { file: normalized, resolved: false };
  const absolute = isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(repositoryRoot, ...(repositoryPath ? [] : workspace ? [workspace] : []), normalized);
  const relativePath = relative(repositoryRoot, absolute).split(sep).join('/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath))
    return { file: normalized, resolved: false };
  return { file: relativePath, resolved: true };
}

function workspaceForOutputLine(line: string, current: string): string {
  return WORKSPACE_COMMAND.exec(line)?.[1] ?? current;
}

function parseTypeScriptLocation(
  line: string,
): { file: string; line: number; column: number; code: string; message: string } | undefined {
  const match = TSV_DIAGNOSTIC.exec(line) ?? TSV_DIAGNOSTIC_COLON.exec(line);
  if (!match) return undefined;
  return {
    file: match[1]!.replaceAll('\\', '/'),
    line: Number(match[2]),
    column: Number(match[3]),
    code: match[4]!,
    message: match[5]!.trim(),
  };
}

function location(
  rawPath: string,
  line: number | undefined,
  column: number | undefined,
  workspace: string,
  context: DiagnosticWorkspaceContext,
): DevVerifierDiagnosticLocation {
  const path = repoRelativePath(rawPath, context, workspace);
  return {
    file: path.file,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(workspace ? { workspace } : {}),
    resolved: path.resolved,
  };
}

export function commandMetadata(check: Pick<VerifierCheckInput, 'command' | 'cwd'>): DevVerifierCommand {
  return { argv: [...check.command], ...(check.cwd ? { cwd: check.cwd } : {}) };
}

export function extractTypeScriptDiagnostics(
  output: string,
  context: DiagnosticWorkspaceContext = {},
): DevVerifierDiagnostic[] {
  let workspace = context.workspace ?? '';
  const diagnostics: DevVerifierDiagnostic[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    workspace = workspaceForOutputLine(line, workspace);
    const parsed = parseTypeScriptLocation(line);
    if (!parsed) continue;
    const diagnosticLocation = location(parsed.file, parsed.line, parsed.column, workspace, context);
    const key = JSON.stringify([parsed.code, diagnosticLocation.file, parsed.line, parsed.column, parsed.message]);
    if (seen.has(key)) continue;
    seen.add(key);
    diagnostics.push({
      cause: 'compiler',
      message: parsed.message,
      code: parsed.code,
      location: diagnosticLocation,
    });
  }
  return diagnostics;
}

type NormalizedTestPath = { file: string; resolved: boolean };

export type DevVerifierTestOutcome = {
  file: string;
  resolved: boolean;
  result: 'pass' | 'fail';
  output: string;
  failureOutputs: string[];
};

export type DevVerifierTestAttribution = {
  outcomes: DevVerifierTestOutcome[];
  ambiguous: boolean;
  unhandled: boolean;
};

function normalizedTestPath(
  rawPath: string,
  workspace: string,
  context: DiagnosticWorkspaceContext,
): NormalizedTestPath | undefined {
  const result = repoRelativePath(rawPath, context, workspace);
  if (!TEST_FILE.test(result.file) || result.file.includes('*')) return undefined;
  return result;
}

function authCheckCommandIndex(command: readonly string[]): number {
  return command.findIndex(
    (argument, index) =>
      argument === 'check' &&
      command[index - 1] === 'services/auth' &&
      command[index - 2] === '--cwd' &&
      command[index - 3] === 'run' &&
      command[index - 4] === 'bun',
  );
}

function authCheckTestFiles(
  check: Pick<VerifierCheckInput, 'command'>,
  context: DiagnosticWorkspaceContext,
): NormalizedTestPath[] {
  const index = authCheckCommandIndex(check.command);
  if (index < 0) return [];
  const files: NormalizedTestPath[] = [];
  for (let cursor = index + 1; cursor < check.command.length; cursor++) {
    const argument = check.command[cursor]!;
    if (argument === '--') break;
    if (!argument || argument.startsWith('-')) {
      if (TEST_FLAGS_WITH_VALUE.has(argument) && cursor + 1 < check.command.length) cursor++;
      continue;
    }
    const file = normalizedTestPath(argument, 'services/auth', context);
    if (file) files.push(file);
  }
  return files;
}

function selectedOperands(
  command: readonly string[],
  start: number,
  end: number,
  workspace: string,
  context: DiagnosticWorkspaceContext,
): NormalizedTestPath[] {
  const files = new Map<string, NormalizedTestPath>();
  for (let cursor = start; cursor < end; cursor++) {
    const argument = command[cursor]!;
    if (argument === '--') break;
    if (!argument || argument.startsWith('-')) {
      if (TEST_FLAGS_WITH_VALUE.has(argument) && cursor + 1 < end) cursor++;
      continue;
    }
    if (!TEST_FILE.test(argument)) continue;
    const file = normalizedTestPath(argument, workspace, context);
    if (file) files.set(file.file, file);
  }
  return [...files.values()];
}

function commandTestFiles(
  check: Pick<VerifierCheckInput, 'command' | 'cwd'>,
  context: DiagnosticWorkspaceContext,
): NormalizedTestPath[] {
  const authFiles = authCheckTestFiles(check, context);
  if (authFiles.length) return authFiles;
  const workspace = check.cwd ?? context.workspace ?? '';
  const webCheck = webCheckCommandIndex(check.command);
  if (webCheck >= 0) {
    const separator = check.command.indexOf('--', webCheck + 1);
    const end = separator < 0 ? check.command.length : separator;
    const hostFlag = check.command.indexOf('--host', webCheck + 1);
    const selected =
      hostFlag >= 0 && hostFlag + 1 < end
        ? [normalizedTestPath(check.command[hostFlag + 1]!, workspace, context)].filter(
            (file): file is NormalizedTestPath => !!file,
          )
        : selectedOperands(check.command, webCheck + 1, end, workspace, context);
    return selected;
  }
  const start = testOperandStart(check.command);
  if (start < 0) return [];
  return selectedOperands(check.command, start, check.command.length, workspace, context);
}

function webCheckCommandIndex(command: readonly string[]): number {
  return command.findIndex(
    (argument, index) => argument.replaceAll('\\', '/') === 'scripts/check.ts' && command[index - 1] === 'bun',
  );
}

function testOperandStart(command: readonly string[]): number {
  let index = 0;
  if (command[index] === 'env') {
    index++;
    while (command[index] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!) || command[index] === '-u')) {
      if (command[index] === '-u') index++;
      index++;
    }
  }
  const executable = command[index]?.replaceAll('\\', '/').split('/').at(-1);
  if (executable === 'bun') {
    if (command[index + 1] === 'test') return index + 2;
    if (command[index + 1] === 'run') {
      let cursor = index + 2;
      while (command[cursor]?.startsWith('-')) {
        cursor++;
        if (['--cwd', '--preload', '--env-file'].includes(command[cursor - 1] ?? '')) cursor++;
      }
      return /^test(?::|$)/.test(command[cursor] ?? '') ? cursor + 1 : -1;
    }
  }
  if (executable === 'node' && command[index + 1] === '--test') return index + 2;
  if (['vitest', 'jest', 'mocha', 'ava', 'tap'].includes(executable ?? '')) return index + 1;
  return -1;
}

function reporterFilePath(
  line: string,
  workspace: string,
  context: DiagnosticWorkspaceContext,
):
  | { path: NormalizedTestPath; result: 'pass' | 'fail'; explicit: true }
  | { path: NormalizedTestPath; explicit: false }
  | undefined {
  const explicit = /^\s*(PASS|FAIL)\s+(.+?\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?|\s+\[[^\]]+\])?\s*$/i.exec(
    line,
  );
  if (explicit) {
    const path = normalizedTestPath(explicit[2]!, workspace, context);
    if (path) return { path, result: explicit[1]!.toLowerCase() === 'pass' ? 'pass' : 'fail', explicit: true };
  }
  const authLaneFailure = /^\s*((?:test|scripts)[\\/](?:[^:]+)\.(?:test|spec)\.[cm]?[jt]sx?):\s+bun test\b/i.exec(line);
  if (authLaneFailure) {
    const path = normalizedTestPath(authLaneFailure[1]!, 'services/auth', context);
    if (path) return { path, result: 'fail', explicit: true };
  }
  const header =
    /^\s*((?:(?:[A-Za-z]:)?(?:\.{0,2}[\\/])?[\w.@+-]+[\\/])+[\w.@+-]+\.(?:test|spec)\.[cm]?[jt]sx?)\s*:\s*$/i.exec(
      line,
    );
  if (header) {
    const path = normalizedTestPath(header[1]!, workspace, context);
    if (path) return { path, explicit: false };
  }
  return undefined;
}

function reporterOutcome(line: string): 'pass' | 'fail' | undefined {
  const bun = /^\s*\((pass|fail)\)\s+.+?(?:\s+\[[\d.]+\s*m?s\])?\s*$/i.exec(line);
  if (bun) return bun[1]!.toLowerCase() as 'pass' | 'fail';
  if (/^\s*not ok\s+\d+\b/i.test(line)) return 'fail';
  if (/^\s*ok\s+\d+\b/i.test(line)) return 'pass';
  return undefined;
}

function isUnhandledTestError(line: string): boolean {
  return /\b(?:unhandled error between tests|unhandled errors?|uncaught exception)\b/i.test(line);
}

function isUnattributedFailureDetail(line: string): boolean {
  return /\b(?:AssertionError|Expected:|Received:|Error:|panic|not ok|test failed)\b/i.test(line);
}

function authFailedFiles(
  output: string,
  context: DiagnosticWorkspaceContext,
): {
  complete: boolean;
  files: NormalizedTestPath[];
} {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*Auth tests failed for \d+ file\(s\):\s*$/.test(line));
  if (start < 0) return { complete: false, files: [] };
  const count = Number(lines[start]!.match(/\d+/)?.[0]);
  const files: NormalizedTestPath[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!line) continue;
    const match = /^(?:test|scripts)[\\/][A-Za-z0-9_.@+/-]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.exec(line);
    if (!match) break;
    const file = normalizedTestPath(match[0], 'services/auth', context);
    if (file) files.push(file);
  }
  return { complete: files.length === count, files };
}

function addOutcome(outcomes: Map<string, DevVerifierTestOutcome>, outcome: DevVerifierTestOutcome): void {
  const existing = outcomes.get(outcome.file);
  if (!existing) {
    outcomes.set(outcome.file, outcome);
    return;
  }
  outcomes.set(outcome.file, {
    file: outcome.file,
    resolved: existing.resolved && outcome.resolved,
    result: existing.result === 'fail' || outcome.result === 'fail' ? 'fail' : 'pass',
    output: [existing.output, outcome.output].filter(Boolean).join('\n'),
    failureOutputs: [...new Set([...existing.failureOutputs, ...outcome.failureOutputs])],
  });
}

export function extractTestFileOutcomes(
  check: Pick<VerifierCheckInput, 'command' | 'cwd'> & { closure?: string[] },
  evidence: Pick<DevVerifierEvidence, 'output'>,
  context: DiagnosticWorkspaceContext = {},
): DevVerifierTestAttribution {
  const selected = commandTestFiles(check, context);
  const singleSelected = selected.length === 1 ? selected[0] : undefined;
  const authSelected = authCheckTestFiles(check, context);
  let workspace = authCheckCommandIndex(check.command) >= 0 ? 'services/auth' : (check.cwd ?? context.workspace ?? '');
  const lines = evidence.output.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const outcomes = new Map<string, DevVerifierTestOutcome>();
  let ambiguous = false;
  let unhandled = false;
  let inUnhandledBlock = false;
  let current:
    | {
        path: NormalizedTestPath;
        lines: string[];
        pending: string[];
        failureBlocks: string[];
        result: 'pass' | 'fail' | undefined;
        lastEvent: 'pass' | 'fail' | undefined;
      }
    | undefined;
  const finish = (): void => {
    if (!current || !current.result) {
      current = undefined;
      return;
    }
    if (current.lastEvent === 'fail' && current.failureBlocks.length && current.pending.length) {
      current.failureBlocks[current.failureBlocks.length - 1] = [
        current.failureBlocks.at(-1),
        current.pending.join('\n'),
      ]
        .filter(Boolean)
        .join('\n');
    }
    const failureOutputs =
      current.result === 'fail'
        ? current.failureBlocks.length
          ? current.failureBlocks
          : [current.lines.join('\n')]
        : [];
    addOutcome(outcomes, {
      file: current.path.file,
      resolved: current.path.resolved,
      result: current.result,
      output: current.lines.join('\n'),
      failureOutputs,
    });
    current = undefined;
  };
  for (const line of lines) {
    workspace = workspaceForOutputLine(line, workspace);
    if (parseTypeScriptLocation(line)) continue;
    if (isUnhandledTestError(line)) {
      unhandled = true;
      inUnhandledBlock = true;
      if (current?.lastEvent === 'fail' && current.failureBlocks.length && current.pending.length) {
        current.failureBlocks[current.failureBlocks.length - 1] = [
          current.failureBlocks.at(-1),
          current.pending.join('\n'),
        ]
          .filter(Boolean)
          .join('\n');
      }
      if (current) {
        current.pending = [];
        current.lastEvent = undefined;
      }
      continue;
    }
    const fileReporter = reporterFilePath(line, workspace, context);
    if (fileReporter) {
      inUnhandledBlock = false;
      finish();
      current = {
        path: fileReporter.path,
        lines: [line],
        pending: [line],
        failureBlocks: [],
        result: fileReporter.explicit ? fileReporter.result : undefined,
        lastEvent: undefined,
      };
      continue;
    }
    const event = reporterOutcome(line);
    if (inUnhandledBlock && !event) continue;
    if (event) inUnhandledBlock = false;
    if (
      !current &&
      !event &&
      isUnattributedFailureDetail(line) &&
      !isAuthDatabasePlacementFailure(line) &&
      !isCleanupFailureLine(line) &&
      !CHECK_HOST_TRANSPORT.test(line) &&
      !isTransportTimeout(line) &&
      !isPrecommandRemoteTransport(line)
    )
      ambiguous = true;
    if (current) {
      current.lines.push(line);
      if (event) {
        if (current.lastEvent === 'fail' && current.pending.length) {
          current.failureBlocks[current.failureBlocks.length - 1] = [
            current.failureBlocks.at(-1),
            current.pending.join('\n'),
          ]
            .filter(Boolean)
            .join('\n');
        }
        current.result = event === 'fail' ? 'fail' : (current.result ?? 'pass');
        if (event === 'fail') current.failureBlocks.push([...current.pending, line].join('\n'));
        current.pending = [];
        current.lastEvent = event;
      } else current.pending.push(line);
      continue;
    }
    if (!event) continue;
    if (singleSelected) {
      current = {
        path: singleSelected,
        lines: [line],
        pending: [],
        failureBlocks: event === 'fail' ? [line] : [],
        result: event,
        lastEvent: event,
      };
    } else if (event === 'fail') ambiguous = true;
  }
  finish();

  const authReport = authFailedFiles(evidence.output, context);
  if (authReport.complete) {
    const failed = new Set(authReport.files.map(({ file }) => file));
    const selectedByPath = new Map(authSelected.map((path) => [path.file, path]));
    for (const path of authSelected) {
      const result = failed.has(path.file) ? 'fail' : 'pass';
      if (outcomes.has(path.file)) continue;
      const matching = lines.filter((line) => line.includes(path.file.slice('services/auth/'.length)));
      const output =
        result === 'fail'
          ? matching.join('\n')
          : 'Auth check runner completed this selected file without reporting it as failed.';
      addOutcome(outcomes, {
        file: path.file,
        resolved: path.resolved,
        result,
        output,
        failureOutputs: result === 'fail' ? [output] : [],
      });
    }
    for (const path of authReport.files) {
      if (selectedByPath.has(path.file) || outcomes.has(path.file)) continue;
      const output = lines.filter((line) => line.includes(path.file.slice('services/auth/'.length))).join('\n');
      addOutcome(outcomes, {
        file: path.file,
        resolved: path.resolved,
        result: 'fail',
        output,
        failureOutputs: output ? [output] : [],
      });
    }
  }
  return { outcomes: [...outcomes.values()], ambiguous, unhandled };
}

/** Only reporter-confirmed failed files are returned; command operands and stack paths stay metadata. */
export function extractNamedTestFiles(
  check: Pick<VerifierCheckInput, 'command' | 'cwd'> & { closure?: string[] },
  evidence: Pick<DevVerifierEvidence, 'output'>,
  context: DiagnosticWorkspaceContext = {},
): string[] {
  return extractTestFileOutcomes(check, evidence, context)
    .outcomes.filter((outcome) => outcome.result === 'fail' && outcome.resolved)
    .map(({ file }) => file);
}

export function extractVerifierDiagnostics(
  evidence: Pick<DevVerifierEvidence, 'output' | 'timedOut'>,
  context: DiagnosticWorkspaceContext = {},
): DevVerifierDiagnostic[] {
  const diagnostics = extractTypeScriptDiagnostics(evidence.output, context);
  const lines = evidence.output.split(/\r?\n/);
  const setup = lines.find(isAuthDatabasePlacementFailure);
  if (setup) diagnostics.push({ cause: 'setup', message: setup.trim() });
  const cleanup = lines.find(isCleanupFailureLine);
  if (cleanup) diagnostics.push({ cause: 'cleanup', message: cleanup.trim() });

  const transport =
    CHECK_HOST_TRANSPORT.test(evidence.output) ||
    isTransportTimeout(evidence.output) ||
    isPrecommandRemoteTransport(evidence.output) ||
    evidence.timedOut;
  if (transport) {
    const message = lines.find(
      (line) =>
        /(?:ssh:|rsync error|ETIMEDOUT|connection (?:reset|refused|closed)|no check host answered|transport)/i.test(
          line,
        ) || isPrecommandRemoteTransport(line),
    );
    diagnostics.push({ cause: 'transport', message: message?.trim() ?? 'Verifier transport did not complete.' });
  }
  return diagnostics;
}

/** A slot-take disconnect occurs before a remote command result exists, so custody stays infrastructure evidence. */
export function isPrecommandRemoteTransport(output: string): boolean {
  return /remote-check: connection to .+ failed during slot take before a result/i.test(output);
}

export function isAuthDatabasePlacementFailure(output: string): boolean {
  return /Auth test databases require placement; use bun run --cwd (?:services\/auth|<path>) check (?:<file>|<path>)/i.test(
    output,
  );
}

export function isRsyncTelemetry(line: string): boolean {
  return RSYNC_TELEMETRY.test(line);
}

export function isCleanupFailureLine(line: string): boolean {
  return CLEANUP_FAILURE.test(line);
}

export function isCompilerDiagnosticLine(line: string): boolean {
  return parseTypeScriptLocation(line) !== undefined;
}
