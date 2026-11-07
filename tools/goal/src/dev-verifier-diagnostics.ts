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
const WORKSPACE_COMMAND = /^\s*\$\s+.+\s+\(((?:apps|services|packages|tools)\/[^)]+)\)\s*$/;
const TSV_DIAGNOSTIC =
  /^\s*(.+?\.(?:[cm]?[jt]sx?))\((\d+),\s*(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/;
const TSV_DIAGNOSTIC_COLON =
  /^\s*(.+?\.(?:[cm]?[jt]sx?)):(\d+):(\d+)\s*-\s*error\s+(TS\d+):\s*(.*)$/;
const CLEANUP_FAILURE =
  /(?:cleanup|resource settlement|resource cleanup).{0,100}(?:could not be proven|failed|incomplete|unsettled|timed out|malformed|unknown)|(?:could not be proven|failed|incomplete|unsettled|timed out|malformed).{0,100}(?:cleanup|resource settlement|resource cleanup)/i;
const RSYNC_TELEMETRY =
  /^\s*(?:total bytes (?:received|sent):\s*\d+|sent\s+\d+\s+bytes\s+received\s+\d+\s+bytes\b|total size is\s+\d+\s+speedup is\s+[\d.]+)/i;

function repoRelativePath(rawPath: string, context: DiagnosticWorkspaceContext, workspace: string): {
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
  const repositoryPath = pathNamesWorkspace || pathNamesAnotherWorkspace ||
    (!workspace && /^(?:apps|services|packages|tools|scripts|docs)\//.test(normalized));
  if (!repositoryPath && !workspace && context.workspace === undefined)
    return { file: normalized, resolved: false };
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

function normalizedTestPath(rawPath: string, workspace: string, context: DiagnosticWorkspaceContext): string | undefined {
  const result = repoRelativePath(rawPath, context, workspace);
  if (!TEST_FILE.test(result.file) || !result.resolved || result.file.includes('*')) return undefined;
  return result.file;
}

function commandTestFiles(check: Pick<VerifierCheckInput, 'command' | 'cwd'>, context: DiagnosticWorkspaceContext): string[] {
  const workspace = check.cwd ?? context.workspace ?? '';
  const files = new Set<string>();
  const start = testOperandStart(check.command);
  if (start < 0) return [];
  for (const argument of check.command.slice(start)) {
    // Environment assignments may contain a complete newline-separated source manifest. They are metadata values,
    // never test operands.
    if (!argument || /[=\s]/.test(argument) || argument.startsWith('-')) continue;
    if (!TEST_FILE.test(argument)) continue;
    const file = normalizedTestPath(argument, workspace, context);
    if (file) files.add(file);
  }
  return [...files];
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

export function extractNamedTestFiles(
  check: Pick<VerifierCheckInput, 'command' | 'cwd'> & { closure?: string[] },
  evidence: Pick<DevVerifierEvidence, 'output'>,
  context: DiagnosticWorkspaceContext = {},
): string[] {
  const files = new Set(commandTestFiles(check, context));
  let workspace = check.cwd ?? context.workspace ?? '';
  for (const line of evidence.output.split(/\r?\n/)) {
    workspace = workspaceForOutputLine(line, workspace);
    if (parseTypeScriptLocation(line)) continue;
    const reporterLine = /(?:^|\b)(?:FAIL|failed|fail|at|Test file|Error in)\b/i.test(line) || /\.(?:test|spec)\.[cm]?[jt]sx?\s*[:(]/i.test(line);
    if (!reporterLine) continue;
    const paths = line.matchAll(/((?:[A-Za-z]:)?(?:\.\.?[\\/])?(?:[A-Za-z0-9_.@+-]+[\\/])*[A-Za-z0-9_.@+-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?/gi);
    for (const match of paths) {
      const file = normalizedTestPath(match[1]!, workspace, context);
      if (file) files.add(file);
    }
  }

  if (!files.size) {
    const concrete = (check.closure ?? []).filter((path) => !path.includes('*') && TEST_FILE.test(path));
    if (concrete.length === 1) {
      const file = normalizedTestPath(concrete[0]!, check.cwd ?? context.workspace ?? '', context);
      if (file) files.add(file);
    }
  }
  return [...files];
}

export function extractVerifierDiagnostics(
  evidence: Pick<DevVerifierEvidence, 'output' | 'timedOut'>,
  context: DiagnosticWorkspaceContext = {},
): DevVerifierDiagnostic[] {
  const diagnostics = extractTypeScriptDiagnostics(evidence.output, context);
  const lines = evidence.output.split(/\r?\n/);
  const cleanup = lines.find(isCleanupFailureLine);
  if (cleanup) diagnostics.push({ cause: 'cleanup', message: cleanup.trim() });

  const transport =
    CHECK_HOST_TRANSPORT.test(evidence.output) || isTransportTimeout(evidence.output) || evidence.timedOut;
  if (transport) {
    const message = lines.find((line) => /(?:ssh:|rsync error|ETIMEDOUT|connection (?:reset|refused|closed)|no check host answered|transport)/i.test(line));
    diagnostics.push({ cause: 'transport', message: message?.trim() ?? 'Verifier transport did not complete.' });
  }
  return diagnostics;
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
