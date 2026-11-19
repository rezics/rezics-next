#!/usr/bin/env bun
// The repository's landing gate runs every workspace check and the control plane's own gate. When a readable
// KERNEL_CHECK_REMOTE hosts file is configured, the root gate splits the work between two check-host runs.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readHosts } from './remote-check.ts';
import { hostsLocation, onCheckHost } from './stack-run.ts';
import { classifyLoadInducedOutput } from './test-lanes.ts';

const root = process.cwd();
const CONTROL_GATE = 'tools/goal/scripts/gate.ts';
export const DEFAULT_DURATIONS: Record<string, number> = {
  'apps/web': 2882,
  'services/kernel': 2821,
  'services/auth': 1810,
  'apps/auth': 1257,
  'packages/ui': 565,
  // Reuse the former combined UI estimate for the extracted browser suite until measured independently.
  'packages/editor': 565,
  'services/importer': 304,
  'packages/document': 211,
  'packages/definitions': 73,
  // The supplied measurements report each remaining workspace below 25 seconds. Use a stable midpoint estimate
  // until a result file provides measured durations.
  'packages/auth-contract': 20,
  'packages/client': 20,
  'packages/composition': 20,
  'packages/conversion': 20,
  'packages/filter': 20,
};

export type Workspace = { name: string; directory: string; checkScript: string };
export type WorkspaceOutcome = {
  name: string;
  directory: string;
  host: string;
  passed: boolean;
  durationSeconds: number;
  failingFiles: string[];
  loadSensitiveTests: string[];
};
type WorkspaceResult = {
  block: string;
  code: number;
  durationMs: number;
  directory: string;
  retryable: boolean;
  failingFiles: string[];
  loadSensitiveTests: string[];
  workspace: Workspace;
};
export type GateControlPlaneOutcome = { passed: boolean; durationSeconds: number; host: string };
export type GateResultFile = {
  workspaces: WorkspaceOutcome[];
  controlPlane?: GateControlPlaneOutcome;
};

export const MAX_GATE_REPORT_BYTES = 1024 * 1024;

export type GateReportDecode =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'decoded'; value: unknown };

export type RemoteGateGroupReport = {
  groupIndex: number;
  workspaces: Workspace[];
  controlPlane: boolean;
  exitCode: number;
  report: GateReportDecode;
  launched: boolean;
};

export type RemoteGateReportSummary = {
  exitCode: number;
  result: GateResultFile;
  errors: string[];
};

/** Decode a report body only after bounding its UTF-8 representation. */
export function decodeGateReport(text: string | null): GateReportDecode {
  if (text === null) return { kind: 'missing' };
  if (Buffer.byteLength(text, 'utf8') > MAX_GATE_REPORT_BYTES) {
    return { kind: 'invalid', reason: `report exceeds ${MAX_GATE_REPORT_BYTES} bytes` };
  }
  try {
    return { kind: 'decoded', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'invalid', reason: 'report is not valid JSON' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateWorkspaceOutcome(value: unknown): WorkspaceOutcome | null {
  if (!isRecord(value)) return null;
  if (
    !validText(value.name) ||
    !validText(value.directory) ||
    !validText(value.host) ||
    typeof value.passed !== 'boolean' ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds < 0 ||
    !Array.isArray(value.failingFiles) ||
    !value.failingFiles.every((entry) => typeof entry === 'string') ||
    !Array.isArray(value.loadSensitiveTests) ||
    !value.loadSensitiveTests.every((entry) => typeof entry === 'string')
  ) {
    return null;
  }
  return {
    name: value.name,
    directory: value.directory,
    host: value.host,
    passed: value.passed,
    durationSeconds: value.durationSeconds,
    failingFiles: value.failingFiles,
    loadSensitiveTests: value.loadSensitiveTests,
  };
}

function validateControlPlaneOutcome(value: unknown): GateControlPlaneOutcome | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.passed !== 'boolean' ||
    typeof value.durationSeconds !== 'number' ||
    !Number.isFinite(value.durationSeconds) ||
    value.durationSeconds < 0 ||
    !validText(value.host)
  ) {
    return null;
  }
  return { passed: value.passed, durationSeconds: value.durationSeconds, host: value.host };
}

function unknownWorkspaceOutcome(workspace: Workspace): WorkspaceOutcome {
  return {
    name: workspace.name,
    directory: workspace.directory,
    host: 'unknown',
    passed: false,
    durationSeconds: 0,
    failingFiles: [],
    loadSensitiveTests: [],
  };
}

function unknownControlPlaneOutcome(): GateControlPlaneOutcome {
  return { passed: false, durationSeconds: 0, host: 'unknown' };
}

/** Reconcile each launched remote report against only the work dispatched to that group. */
export function aggregateRemoteGateReports(groups: RemoteGateGroupReport[]): RemoteGateReportSummary {
  const outcomes: WorkspaceOutcome[] = [];
  const errors: string[] = [];
  let controlPlane: GateControlPlaneOutcome | undefined;

  for (const group of groups) {
    const label = `group ${group.groupIndex + 1}`;
    if (!group.launched) {
      if (group.workspaces.length > 0 || group.controlPlane) {
        errors.push(`${label}: expected work was not launched`);
        outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
        if (group.controlPlane && !controlPlane) controlPlane = unknownControlPlaneOutcome();
      }
      continue;
    }

    if (group.report.kind === 'missing') {
      errors.push(`${label}: result report is missing`);
      outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
      if (group.controlPlane) controlPlane ??= unknownControlPlaneOutcome();
      continue;
    }
    if (group.report.kind === 'invalid') {
      errors.push(`${label}: ${group.report.reason}`);
      outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
      if (group.controlPlane) controlPlane ??= unknownControlPlaneOutcome();
      continue;
    }

    const value = group.report.value;
    if (!isRecord(value) || !Array.isArray(value.workspaces)) {
      errors.push(`${label}: result must contain a workspace outcomes array`);
      outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
      if (group.controlPlane) controlPlane ??= unknownControlPlaneOutcome();
      continue;
    }

    const expectedByDirectory = new Map(group.workspaces.map((workspace) => [workspace.directory, workspace]));
    const seen = new Set<string>();
    const groupOutcomes: WorkspaceOutcome[] = [];
    let invalidReason: string | undefined;
    for (const entry of value.workspaces) {
      const outcome = validateWorkspaceOutcome(entry);
      if (!outcome) {
        invalidReason = 'workspace outcome has invalid fields';
        break;
      }
      if (seen.has(outcome.directory)) {
        invalidReason = `duplicate workspace outcome for ${outcome.directory}`;
        break;
      }
      if (!expectedByDirectory.has(outcome.directory)) {
        invalidReason = `workspace outcome does not belong to this group: ${outcome.directory}`;
        break;
      }
      seen.add(outcome.directory);
      groupOutcomes.push(outcome);
    }

    const hasControlPlane = Object.hasOwn(value, 'controlPlane');
    let reportedControl: GateControlPlaneOutcome | undefined;
    if (!invalidReason && group.controlPlane && hasControlPlane) {
      reportedControl = validateControlPlaneOutcome(value.controlPlane) ?? undefined;
      if (!reportedControl) invalidReason = 'control-plane outcome has invalid fields';
    } else if (!invalidReason && !group.controlPlane && hasControlPlane) {
      invalidReason = 'control-plane outcome was not requested for this group';
    }

    if (invalidReason) {
      errors.push(`${label}: ${invalidReason}`);
      outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
      if (group.controlPlane) controlPlane ??= unknownControlPlaneOutcome();
      continue;
    }

    const missingWorkspaces = group.workspaces.filter((workspace) => !seen.has(workspace.directory));
    const missingControlPlane = group.controlPlane && !reportedControl;
    if (group.exitCode === 0 && (missingWorkspaces.length > 0 || missingControlPlane)) {
      const missing = [
        ...missingWorkspaces.map((workspace) => workspace.directory),
        ...(missingControlPlane ? [CONTROL_GATE] : []),
      ];
      errors.push(`${label}: result is incomplete; missing ${missing.join(', ')}`);
      outcomes.push(...group.workspaces.map(unknownWorkspaceOutcome));
      if (group.controlPlane) controlPlane ??= unknownControlPlaneOutcome();
      continue;
    }

    outcomes.push(...groupOutcomes);
    if (missingWorkspaces.length > 0) {
      errors.push(
        `${label}: result is incomplete; missing ${missingWorkspaces.map((workspace) => workspace.directory).join(', ')}`,
      );
      outcomes.push(...missingWorkspaces.map(unknownWorkspaceOutcome));
    }
    if (group.controlPlane) {
      if (reportedControl) {
        if (controlPlane) {
          errors.push(`${label}: control-plane outcome was reported by more than one group`);
          controlPlane = unknownControlPlaneOutcome();
        } else {
          controlPlane = reportedControl;
        }
      } else {
        errors.push(`${label}: requested control-plane outcome is missing`);
        controlPlane ??= unknownControlPlaneOutcome();
      }
    }
  }

  const result: GateResultFile = {
    workspaces: outcomes.sort((left, right) => left.directory.localeCompare(right.directory)),
    ...(controlPlane ? { controlPlane } : {}),
  };
  const nativeExitCode = groups.find((group) => group.exitCode !== 0)?.exitCode;
  const outcomeFailed = outcomes.some((outcome) => !outcome.passed) || Boolean(controlPlane && !controlPlane.passed);
  return {
    exitCode: nativeExitCode ?? (errors.length > 0 || outcomeFailed ? 1 : 0),
    result,
    errors,
  };
}

function writeOutput(
  text: string,
  stream: 'stdout' | 'stderr' = 'stdout',
  env: Record<string, string | undefined> = process.env,
): void {
  const output = process[stream];
  const host = env.REMOTE_CHECK_HOST;
  if (!host) {
    output.write(text);
    return;
  }
  output.write(
    text
      .split(/(?<=\n)/)
      .map((line) => (line.length === 0 ? '' : `${host}: ${line}`))
      .join(''),
  );
}

export type GatePlacement =
  | { kind: 'local'; reason: 'already on a check host' }
  | { kind: 'remote'; hostsFile: string }
  | { kind: 'unavailable'; reason: string };

/** Resolve placement from the physical checkout path and supported hosts-file location only. */
export function gatePlacement(
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): GatePlacement {
  if (onCheckHost(cwd)) return { kind: 'local', reason: 'already on a check host' };

  const located = hostsLocation(cwd, env);
  if ('reason' in located) return { kind: 'unavailable', reason: located.reason };
  try {
    readHosts(located.file);
  } catch (error) {
    return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
  }
  return { kind: 'remote', hostsFile: located.file };
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return number;
}

function workspaceManifestPaths(gateRoot = root): string[] {
  return [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: gateRoot })].sort();
}

async function readWorkspaces(gateRoot = root): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  for (const manifest of workspaceManifestPaths(gateRoot)) {
    const { name, scripts } = (await Bun.file(join(gateRoot, manifest)).json()) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!scripts?.check) throw new Error(`${manifest} has no check script`);
    workspaces.push({
      name: name ?? dirname(manifest),
      directory: join(gateRoot, dirname(manifest)).slice(gateRoot.length + 1),
      checkScript: scripts.check,
    });
  }
  return workspaces;
}

function readWorkspaceSelection(args: string[]): { directories: Set<string> | null; controlPlane: boolean } {
  const index = args.indexOf('--workspaces');
  if (index === -1) return { directories: null, controlPlane: true };
  const named = args.slice(index + 1);
  if (named.length === 0) throw new Error('--workspaces needs at least one directory');
  const directories = new Set(named.filter((entry) => entry !== CONTROL_GATE));
  return { directories, controlPlane: named.includes(CONTROL_GATE) };
}

export function loadDurationTable(
  workspaces: Workspace[],
  file = process.env.GATE_DURATIONS_FILE,
): Map<string, number> {
  const defaults = new Map(
    workspaces.map((workspace) => [workspace.directory, DEFAULT_DURATIONS[workspace.directory] ?? 20]),
  );
  if (!file) return defaults;
  try {
    accessSync(file, constants.R_OK);
  } catch {
    return defaults;
  }

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { workspaces?: unknown }).workspaces)
      ? (parsed as { workspaces: unknown[] }).workspaces
      : null;
  if (!entries) throw new Error(`${file} must contain a workspace result array`);
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const directory = typeof record.directory === 'string' ? record.directory : null;
    const duration = record.durationSeconds ?? record.duration;
    if (!directory || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) continue;
    defaults.set(directory, duration);
  }
  return defaults;
}

export function splitWorkspaces(workspaces: Workspace[], durations: Map<string, number>): [Workspace[], Workspace[]] {
  const groups: [Workspace[], Workspace[]] = [[], []];
  const totals: [number, number] = [0, 0];
  const longestFirst = [...workspaces].sort(
    (left, right) =>
      (durations.get(right.directory) ?? 20) - (durations.get(left.directory) ?? 20) ||
      left.directory.localeCompare(right.directory),
  );
  for (const workspace of longestFirst) {
    const group = totals[0] <= totals[1] ? 0 : 1;
    groups[group].push(workspace);
    totals[group] += durations.get(workspace.directory) ?? 20;
  }
  return groups;
}

function groupTotals(groups: [Workspace[], Workspace[]], durations: Map<string, number>): [number, number] {
  return groups.map((group) =>
    group.reduce((sum, workspace) => sum + (durations.get(workspace.directory) ?? 20), 0),
  ) as [number, number];
}

/** Runs one remote group and forwards a signal so the host can clean up before this gate exits. */
async function runRemoteAttempt(
  groupIndex: number,
  workspaces: Workspace[],
  controlPlane: boolean,
  slots: number,
  concurrency: string | undefined,
  partPath: string,
  hostsFile: string,
): Promise<number> {
  const remoteCheck = join(import.meta.dir, 'remote-check.ts');
  rmSync(resolve(root, partPath), { force: true });
  const command = [
    process.execPath,
    remoteCheck,
    '--gate',
    '--slots',
    String(slots),
    '--returns',
    partPath,
    root,
    '--',
    'env',
    `GATE_GROUP_INDEX=${groupIndex}`,
    `GATE_RESULT_FILE=${partPath}`,
    ...(concurrency === undefined ? [] : [`GATE_CONCURRENCY=${concurrency}`]),
    'bun',
    'scripts/gate.ts',
    '--workspaces',
    ...workspaces.map((workspace) => workspace.directory),
    ...(controlPlane ? [CONTROL_GATE] : []),
  ];
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, KERNEL_CHECK_REMOTE: hostsFile },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const forwarders = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((name) => {
    const forward = () => child.kill(name);
    process.on(name, forward);
    return [name, forward] as const;
  });
  try {
    return await child.exited;
  } finally {
    for (const [name, forward] of forwarders) process.off(name, forward);
  }
}

/** Retries this group's dropped remote connection once. */
async function runRemoteGroup(
  groupIndex: number,
  workspaces: Workspace[],
  controlPlane: boolean,
  slots: number,
  concurrency: string | undefined,
  partPath: string,
  hostsFile: string,
): Promise<number> {
  return await runRemoteAttempt(groupIndex, workspaces, controlPlane, slots, concurrency, partPath, hostsFile);
}

function hostsForGroups(hostsFile: string, slots: number): [string, string] {
  const eligible = readHosts(hostsFile).filter((host) => host.slots >= slots);
  if (eligible.length < 2) return [hostsFile, hostsFile];

  const groups: [typeof eligible, typeof eligible] = [[], []];
  const capacities: [number, number] = [0, 0];
  for (const host of [...eligible].sort(
    (left, right) => right.slots - left.slots || left.name.localeCompare(right.name),
  )) {
    const group = capacities[0] <= capacities[1] ? 0 : 1;
    groups[group].push(host);
    capacities[group] += host.slots;
  }
  const directory = join(root, '.temp/gate/hosts');
  mkdirSync(directory, { recursive: true });
  return groups.map((hosts, index) => {
    const path = join(directory, `group-${index + 1}.json`);
    writeFileSync(path, `${JSON.stringify({ hosts }, null, 2)}\n`);
    return path;
  }) as [string, string];
}

async function runRemoteGroups(
  workspaces: Workspace[],
  includeControlPlane: boolean,
  hostsFile: string,
): Promise<number> {
  const durations = loadDurationTable(workspaces);
  const groups = splitWorkspaces(workspaces, durations);
  const totals = groupTotals(groups, durations);
  const controlGroup = includeControlPlane ? (totals[0] <= totals[1] ? 0 : 1) : -1;
  const slots = positiveInteger('GATE_REMOTE_SLOTS', process.env.GATE_REMOTE_SLOTS ?? '4');
  const concurrency = process.env.GATE_CONCURRENCY;
  const partPaths = ['.temp/gate/parts/group-1.json', '.temp/gate/parts/group-2.json'] as const;
  const hostPaths = hostsForGroups(hostsFile, slots);
  for (const path of partPaths) rmSync(resolve(root, path), { force: true });
  const results = await Promise.all(
    groups.map((group, index) => {
      const controlPlane = index === controlGroup;
      if (group.length === 0 && !controlPlane) return Promise.resolve(0);
      return runRemoteGroup(index, group, controlPlane, slots, concurrency, partPaths[index]!, hostPaths[index]!);
    }),
  );

  const summary = aggregateRemoteGateReports(
    groups.map((group, index) => ({
      groupIndex: index,
      workspaces: group,
      controlPlane: index === controlGroup,
      exitCode: results[index]!,
      report: readResultFile(resolve(root, partPaths[index]!)),
      launched: group.length > 0 || index === controlGroup,
    })),
  );
  for (const error of summary.errors) writeOutput(`Invalid remote gate result: ${error}\n`, 'stderr');
  const outcomes = summary.result.workspaces;
  const controlPlane = summary.result.controlPlane;
  const failedDirectories = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.directory);
  if (controlPlane && !controlPlane.passed) failedDirectories.push(CONTROL_GATE);
  if (summary.exitCode !== 0 || failedDirectories.length > 0) {
    writeOutput(`Failed workspaces: ${failedDirectories.join(' ')}\n`);
    writeResultFile(process.env.GATE_RESULT_FILE ?? '.temp/gate/result.json', summary.result);
    return summary.exitCode;
  }
  writeResultFile(process.env.GATE_RESULT_FILE ?? '.temp/gate/result.json', summary.result);
  return 0;
}

/** Bun.spawn("bun") selects the caller's executable even when PATH names a newer Bun. */
export function resolveBunCommand(command: string[], directory = root): string[] {
  const pinned = join(directory, 'node_modules/.bin/bun');
  return command[0] === 'bun' && existsSync(pinned) ? [pinned, ...command.slice(1)] : command;
}

async function run(
  command: string[],
  cwd: string,
  gateRoot = root,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  writeOutput(`$ ${command.join(' ')}  (${cwd === gateRoot ? '.' : cwd.slice(gateRoot.length + 1)})\n`, 'stdout', env);
  const child = Bun.spawn(resolveBunCommand(command, gateRoot), {
    cwd,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const forward = async (source: ReadableStream<Uint8Array>, stream: 'stdout' | 'stderr'): Promise<void> => {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/(?<=\n)/);
      pending = lines.pop() ?? '';
      if (lines.length > 0) writeOutput(lines.join(''), stream, env);
      if (done) break;
    }
    if (pending) writeOutput(pending, stream, env);
  };
  const [code] = await Promise.all([child.exited, forward(child.stdout, 'stdout'), forward(child.stderr, 'stderr')]);
  return code;
}

// Bound the text passed to Bun's diagnostic classifier and host-prefix formatter. A failed
// DOM assertion can print a large object graph before the runner prints its file summary.
const workspaceExcerptBytes = 64 * 1024;
const workspaceProgressPrefixes: Partial<Record<string, string>> = {
  'apps/web': '[web-file] ',
  'services/kernel': '[kernel-file] ',
};

async function readWorkspaceOutput(stream: ReadableStream<Uint8Array>, onLine?: (line: string) => void) {
  const head = Buffer.allocUnsafe(workspaceExcerptBytes);
  const tail = Buffer.allocUnsafe(workspaceExcerptBytes);
  let bytes = 0;
  let tailOffset = 0;
  const files = new Set<string>();
  const tests = new Set<string>();
  let remainingFiles = 0;
  let remainingTests = 0;
  let activeTestFile: string | undefined;
  let pending = '';
  let longLine = false;
  let previousCR = false;
  let metadataBytes = 0;
  let metadataOverflow = false;
  const decoder = new TextDecoder();

  function remember(entries: Set<string>, value: string) {
    if (metadataOverflow || entries.has(value)) return;
    metadataBytes += Buffer.byteLength(value) + 1;
    if (metadataBytes > MAX_GATE_REPORT_BYTES) metadataOverflow = true;
    else entries.add(value);
  }

  function readLine(line: string) {
    onLine?.(line);
    const trimmed = line.trim();
    if (remainingFiles && trimmed) {
      remember(files, trimmed);
      remainingFiles--;
    }
    if (remainingTests) {
      if (trimmed) remember(tests, trimmed);
      remainingTests--;
    }
    const testLine = trimmed.match(
      /^((?:apps|services|packages|test|tests|src|tools)\/[^\s:]+\.test\.[cm]?[jt]sx?)(?::\d+(?::\d+)?|\(\d+,\d+\))?:(.*)$/,
    );
    if (testLine) {
      const [, file, detail] = testLine;
      if (!detail!.trim()) activeTestFile = file;
      else if (/^\s*(?:error|fail(?:ed)?)(?:\s|:|$)/i.test(detail!)) remember(files, file!);
    }
    if (activeTestFile && (/^\(fail\)\s/.test(trimmed) || trimmed === '# Unhandled error between tests'))
      remember(files, activeTestFile);
    if (/^(?:bun test |\d+ tests? failed:|Ran \d+ tests?)/.test(trimmed)) activeTestFile = undefined;
    const summary = line.match(/tests failed for (\d+) file\(s\):/i);
    if (summary) {
      activeTestFile = undefined;
      remainingFiles = Number(summary[1]);
    }
    const heading = line.match(/^Load-sensitive (?:tests|growth checks) \(.*\):\s*(\d+)\s*$/);
    if (heading) remainingTests = Number(heading[1]);
  }

  function scan(text: string) {
    if (!text) return;
    if (previousCR && text.startsWith('\n')) text = text.slice(1);
    previousCR = text.endsWith('\r');
    let start = 0;
    for (const separator of text.matchAll(/\r\n?|\n/g)) {
      const end = separator.index!;
      if (!longLine && pending.length + end - start <= workspaceExcerptBytes) {
        readLine(pending + text.slice(start, end));
      }
      pending = '';
      longLine = false;
      start = end + separator[0].length;
    }
    if (pending.length + text.length - start > workspaceExcerptBytes) longLine = true;
    if (!longLine) pending += text.slice(start);
  }

  for await (const chunk of stream) {
    for (let start = 0; start < chunk.length; start += workspaceExcerptBytes) {
      const part = chunk.subarray(start, start + workspaceExcerptBytes);
      const headCount = Math.min(part.length, Math.max(0, head.length - bytes));
      if (headCount) head.set(part.subarray(0, headCount), bytes);
      const rest = part.subarray(headCount);
      const count = Math.min(rest.length, tail.length - tailOffset);
      tail.set(rest.subarray(0, count), tailOffset);
      tail.set(rest.subarray(count), 0);
      tailOffset = (tailOffset + rest.length) % tail.length;
      bytes += part.length;
      scan(decoder.decode(part, { stream: true }));
    }
  }
  scan(decoder.decode());
  if (pending && !longLine) readLine(pending);
  const omitted = Math.max(0, bytes - head.length - tail.length);
  const text = omitted
    ? head.toString() +
      `\n[Gate omitted ${omitted} diagnostic bytes]\n` +
      Buffer.concat([tail.subarray(tailOffset), tail.subarray(0, tailOffset)]).toString()
    : Buffer.concat([
        head.subarray(0, Math.min(bytes, head.length)),
        tail.subarray(0, Math.max(0, bytes - head.length)),
      ]).toString();
  return { text, omitted, files, tests, metadataOverflow };
}

async function checkWorkspace(
  workspace: Workspace,
  gateRoot = root,
  env: Record<string, string | undefined> = process.env,
): Promise<WorkspaceResult> {
  const command = ['bun', 'run', 'check'];
  const startedAt = performance.now();
  const child = Bun.spawn(resolveBunCommand(command, gateRoot), {
    cwd: join(gateRoot, workspace.directory),
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const progressPrefix = workspaceProgressPrefixes[workspace.directory];
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    readWorkspaceOutput(child.stdout, (line) => {
      if (progressPrefix && line.startsWith(progressPrefix)) writeOutput(`${line}\n`, 'stdout', env);
    }),
    readWorkspaceOutput(child.stderr),
  ]);
  const durationMs = performance.now() - startedAt;
  const metadataOverflow = stdout.metadataOverflow || stderr.metadataOverflow;
  const output = [
    stdout.text.trimEnd(),
    stderr.text.trimEnd(),
    metadataOverflow ? 'Gate workspace report entries exceed the report size limit.' : '',
  ]
    .filter(Boolean)
    .join('\n');
  // Missing diagnostic context must never authorize a second whole-workspace check.
  const retryable =
    code !== 0 &&
    !metadataOverflow &&
    !stdout.omitted &&
    !stderr.omitted &&
    !/\bscripts\/check\.ts\b/.test(workspace.checkScript) &&
    !!classifyLoadInducedOutput(output)?.length;
  const block = [
    `Workspace ${workspace.name} finished in ${(durationMs / 1000).toFixed(2)}s`,
    `$ ${command.join(' ')}  (${workspace.directory})`,
    output,
  ]
    .filter(Boolean)
    .join('\n');
  return {
    block: `${block}\n\n`,
    code: metadataOverflow && code === 0 ? 1 : code,
    durationMs,
    directory: workspace.directory,
    retryable,
    workspace,
    failingFiles: [...new Set([...stdout.files, ...stderr.files])].sort(),
    loadSensitiveTests: [...new Set([...stdout.tests, ...stderr.tests])].sort(),
  };
}

function outcomeFrom(
  result: WorkspaceResult,
  env: Record<string, string | undefined>,
  retry?: WorkspaceResult,
): WorkspaceOutcome {
  return {
    name: result.workspace.name,
    directory: result.directory,
    host: env.REMOTE_CHECK_HOST ?? 'local',
    passed: (retry ?? result).code === 0,
    durationSeconds: Number(((result.durationMs + (retry?.durationMs ?? 0)) / 1000).toFixed(3)),
    failingFiles: [...new Set([...result.failingFiles, ...(retry?.failingFiles ?? [])])].sort(),
    loadSensitiveTests: [...new Set([...result.loadSensitiveTests, ...(retry?.loadSensitiveTests ?? [])])].sort(),
  };
}

function resultPath(path: string, gateRoot = root): string {
  return resolve(gateRoot, path);
}

function writeResultFile(
  path: string,
  result: GateResultFile,
  gateRoot = root,
  env: Record<string, string | undefined> = process.env,
): void {
  const target = resultPath(path, gateRoot);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  writeOutput(`Gate result: ${path}\n`, 'stdout', env);
}

function readResultFile(path: string): GateReportDecode {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const bytes = Buffer.allocUnsafe(MAX_GATE_REPORT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_GATE_REPORT_BYTES) {
      return { kind: 'invalid', reason: `report exceeds ${MAX_GATE_REPORT_BYTES} bytes` };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    } catch {
      return { kind: 'invalid', reason: 'report is not valid UTF-8' };
    }
    return decodeGateReport(text);
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code === 'ENOENT') return { kind: 'missing' };
    return {
      kind: 'invalid',
      reason: `unable to read report: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function runLocalGate(
  args: string[],
  gateRoot = root,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const selection = readWorkspaceSelection(args);
  const allWorkspaces = await readWorkspaces(gateRoot);
  const workspaces = selection.directories
    ? allWorkspaces.filter((workspace) => selection.directories!.has(workspace.directory))
    : allWorkspaces;
  if (selection.directories) {
    const known = new Set([...allWorkspaces.map((workspace) => workspace.directory), CONTROL_GATE]);
    const unknown = [...selection.directories].filter((directory) => !known.has(directory));
    if (unknown.length > 0) throw new Error(`Unknown workspace directory: ${unknown.join(', ')}`);
  }

  let code = await run(['bun', 'install', '--frozen-lockfile'], gateRoot, gateRoot, env);
  // Install supplies the exact canary; hosts and the caller may use an older Bun to bootstrap it.
  env.PATH = `${join(gateRoot, 'node_modules/.bin')}:${env.PATH ?? ''}`;
  if (code === 0 && existsSync(join(gateRoot, 'scripts/toolchain.test.ts'))) {
    code = await run(
      ['bun', 'test', 'scripts/toolchain.test.ts', 'scripts/toolchain-workspaces.test.ts'],
      gateRoot,
      gateRoot,
      env,
    );
  }
  const configuredConcurrency = env.GATE_CONCURRENCY;
  const concurrency = configuredConcurrency === undefined ? workspaces.length : Number(configuredConcurrency);
  if (workspaces.length > 0 && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
    throw new Error(`GATE_CONCURRENCY must be a positive integer, received ${JSON.stringify(configuredConcurrency)}`);
  }

  let nextWorkspace = 0;
  const outcomes: WorkspaceOutcome[] = [];
  const failures: WorkspaceResult[] = [];
  const worker = async (): Promise<void> => {
    while (nextWorkspace < workspaces.length) {
      const index = nextWorkspace++;
      const result = await checkWorkspace(workspaces[index]!, gateRoot, env);
      outcomes.push(outcomeFrom(result, env));
      if (result.code === 0) writeOutput(result.block, 'stdout', env);
      else failures.push(result);
    }
  };

  if (code === 0) await Promise.all(Array.from({ length: Math.min(concurrency, workspaces.length) }, () => worker()));

  const failedByDirectory = new Map(failures.map((failure) => [failure.workspace.directory, failure]));
  const remainingFailures: WorkspaceResult[] = [];
  const gateLoadSensitive: string[] = [];
  for (const workspace of workspaces) {
    const failure = failedByDirectory.get(workspace.directory);
    if (!failure) continue;
    if (!failure.retryable) {
      remainingFailures.push(failure);
      continue;
    }

    const again = await checkWorkspace(workspace, gateRoot, env);
    const existing = outcomes.find((outcome) => outcome.directory === workspace.directory)!;
    Object.assign(existing, outcomeFrom(failure, env, again));
    if (again.code === 0) {
      writeOutput(failure.block, 'stdout', env);
      writeOutput(again.block, 'stdout', env);
      gateLoadSensitive.push(`${workspace.name} (${failure.directory})`);
    } else {
      remainingFailures.push({
        ...again,
        block: `${failure.block}Workspace ${workspace.name} failed again alone:\n${again.block}`,
      });
    }
  }

  if (gateLoadSensitive.length > 0) {
    writeOutput(
      `Load-sensitive workspaces (passed on retry): ${gateLoadSensitive.length}\n${gateLoadSensitive.join('\n')}\n`,
      'stdout',
      env,
    );
  }

  for (const failure of remainingFailures) writeOutput(failure.block, 'stdout', env);
  if (remainingFailures.length > 0)
    writeOutput(
      `Failed workspaces: ${remainingFailures.map((failure) => failure.directory).join(' ')}\n`,
      'stdout',
      env,
    );

  let controlPlane: GateResultFile['controlPlane'];
  if (code === 0 && remainingFailures.length === 0 && selection.controlPlane) {
    const started = performance.now();
    const controlCode = await run(['bun', CONTROL_GATE], gateRoot, gateRoot, env);
    controlPlane = {
      passed: controlCode === 0,
      durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      host: env.REMOTE_CHECK_HOST ?? 'local',
    };
    if (controlCode !== 0) {
      code = controlCode;
      writeOutput(`Failed workspaces: ${CONTROL_GATE}\n`, 'stdout', env);
    }
  }

  const resultFile: GateResultFile = {
    workspaces: outcomes.sort((left, right) => left.directory.localeCompare(right.directory)),
  };
  if (controlPlane) resultFile.controlPlane = controlPlane;
  writeResultFile(env.GATE_RESULT_FILE ?? '.temp/gate/result.json', resultFile, gateRoot, env);

  if (code !== 0) return code;
  return remainingFailures.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const selection = readWorkspaceSelection(args);
  const placement = gatePlacement(root, process.env);
  if (placement.kind === 'local') return await runLocalGate(args);
  if (placement.kind === 'unavailable') throw new Error(`gate: ${placement.reason}; refusing to run the gate locally`);

  const allWorkspaces = await readWorkspaces();
  const workspaces = selection.directories
    ? allWorkspaces.filter((workspace) => selection.directories!.has(workspace.directory))
    : allWorkspaces;
  if (selection.directories) {
    const known = new Set([...allWorkspaces.map((workspace) => workspace.directory), CONTROL_GATE]);
    const unknown = [...selection.directories].filter((directory) => !known.has(directory));
    if (unknown.length > 0) throw new Error(`Unknown workspace directory: ${unknown.join(', ')}`);
  }
  return await runRemoteGroups(workspaces, selection.controlPlane, placement.hostsFile);
}

if (import.meta.main) process.exitCode = await main();
