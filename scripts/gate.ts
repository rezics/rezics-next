#!/usr/bin/env bun
// The repository's landing gate runs every workspace check and the control plane's own gate. When a readable
// KERNEL_CHECK_REMOTE hosts file is configured, the root gate splits the work between two check-host runs.
import { accessSync, constants, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readHosts } from './remote-check.ts';
import { classifyLoadInducedOutput } from './test-lanes.ts';

const root = process.cwd();
const CONTROL_GATE = 'tools/goal/scripts/gate.ts';
export const DEFAULT_DURATIONS: Record<string, number> = {
  'apps/web': 2882,
  'services/kernel': 2821,
  'services/auth': 1810,
  'apps/auth': 1257,
  'packages/ui': 565,
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
  output: string;
  workspace: Workspace;
};
type GateResultFile = {
  workspaces: WorkspaceOutcome[];
  controlPlane?: { passed: boolean; durationSeconds: number; host: string };
};

function writeOutput(text: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
  const output = process[stream];
  const host = process.env.REMOTE_CHECK_HOST;
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

/** The hosts file when this gate should run on check hosts: named, readable and not already on one. */
function remoteHostsFile(): string | null {
  const file = process.env.KERNEL_CHECK_REMOTE;
  if (!file || process.env.KERNEL_CHECK_ON_REMOTE) return null;
  try {
    accessSync(file, constants.R_OK);
    return file;
  } catch {
    writeOutput(`KERNEL_CHECK_REMOTE ${file} is not readable; running the gate locally\n`, 'stderr');
    return null;
  }
}

function positiveInteger(name: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return number;
}

function workspaceManifestPaths(): string[] {
  return [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
}

async function readWorkspaces(): Promise<Workspace[]> {
  const workspaces: Workspace[] = [];
  for (const manifest of workspaceManifestPaths()) {
    const { name, scripts } = (await Bun.file(join(root, manifest)).json()) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!scripts?.check) throw new Error(`${manifest} has no check script`);
    workspaces.push({
      name: name ?? dirname(manifest),
      directory: join(root, dirname(manifest)).slice(root.length + 1),
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
  const code = await runRemoteAttempt(groupIndex, workspaces, controlPlane, slots, concurrency, partPath, hostsFile);
  if (code !== 75) return code;
  writeOutput(`gate: group ${groupIndex + 1} had a transport failure; retrying once\n`, 'stderr');
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

async function runRemoteGroups(workspaces: Workspace[], hostsFile: string): Promise<number> {
  const durations = loadDurationTable(workspaces);
  const groups = splitWorkspaces(workspaces, durations);
  const totals = groupTotals(groups, durations);
  const controlGroup = totals[0] <= totals[1] ? 0 : 1;
  const slots = positiveInteger('GATE_REMOTE_SLOTS', process.env.GATE_REMOTE_SLOTS ?? '4');
  const concurrency = process.env.GATE_CONCURRENCY;
  const partPaths = ['.temp/gate/parts/group-1.json', '.temp/gate/parts/group-2.json'] as const;
  const hostPaths = hostsForGroups(hostsFile, slots);
  for (const path of partPaths) rmSync(resolve(root, path), { force: true });
  const results = await Promise.all(
    groups.map((group, index) =>
      runRemoteGroup(index, group, index === controlGroup, slots, concurrency, partPaths[index]!, hostPaths[index]!),
    ),
  );

  const groupReports = partPaths.map((path) => readResultFile(resolve(root, path)));
  const outcomes = groupReports.flatMap((report) => report?.workspaces ?? []);
  const reportedDirectories = new Set(outcomes.map((outcome) => outcome.directory));
  let unreportedControlFailure = false;
  for (let index = 0; index < results.length; index += 1) {
    if (results[index] === 0) continue;
    for (const workspace of groups[index]!) {
      if (reportedDirectories.has(workspace.directory)) continue;
      outcomes.push({
        name: workspace.name,
        directory: workspace.directory,
        host: 'unknown',
        passed: false,
        durationSeconds: 0,
        failingFiles: [],
        loadSensitiveTests: [],
      });
      reportedDirectories.add(workspace.directory);
    }
    if (!groupReports[index] && index === controlGroup) unreportedControlFailure = true;
  }
  const controls = groupReports
    .map((report) => report?.controlPlane)
    .filter((control): control is NonNullable<GateResultFile['controlPlane']> => Boolean(control));
  const failedDirectories = outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.directory);
  const controlPlane =
    controls[0] ?? (unreportedControlFailure ? { passed: false, durationSeconds: 0, host: 'unknown' } : undefined);
  if (controlPlane && !controlPlane.passed) failedDirectories.push(CONTROL_GATE);
  const merged: GateResultFile = {
    workspaces: outcomes.sort((left, right) => left.directory.localeCompare(right.directory)),
    ...(controlPlane ? { controlPlane } : {}),
  };
  const failedCode = results.find((code) => code !== 0);
  if (failedCode !== undefined) {
    writeOutput(`Failed workspaces: ${failedDirectories.join(' ')}\n`);
    writeResultFile(process.env.GATE_RESULT_FILE ?? '.temp/gate/result.json', merged);
    return failedCode;
  }
  writeResultFile(process.env.GATE_RESULT_FILE ?? '.temp/gate/result.json', merged);
  return 0;
}

async function run(command: string[], cwd: string): Promise<number> {
  writeOutput(`$ ${command.join(' ')}  (${cwd === root ? '.' : cwd.slice(root.length + 1)})\n`);
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const forward = async (source: ReadableStream<Uint8Array>, stream: 'stdout' | 'stderr'): Promise<void> => {
    const reader = source.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const lines = pending.split(/(?<=\n)/);
      pending = lines.pop() ?? '';
      if (lines.length > 0) writeOutput(lines.join(''), stream);
      if (done) break;
    }
    if (pending) writeOutput(pending, stream);
  };
  const [code] = await Promise.all([child.exited, forward(child.stdout, 'stdout'), forward(child.stderr, 'stderr')]);
  return code;
}

async function checkWorkspace(workspace: Workspace): Promise<WorkspaceResult> {
  const command = ['bun', 'run', 'check'];
  const startedAt = performance.now();
  const child = Bun.spawn(command, {
    cwd: join(root, workspace.directory),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const durationMs = performance.now() - startedAt;
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  const block = [
    `Workspace ${workspace.name} finished in ${(durationMs / 1000).toFixed(2)}s`,
    `$ ${command.join(' ')}  (${workspace.directory})`,
    output,
  ]
    .filter(Boolean)
    .join('\n');
  return { block: `${block}\n\n`, code, durationMs, directory: workspace.directory, output, workspace };
}

function extractFailingFiles(output: string): string[] {
  const files = new Set<string>();
  const lines = output.split(/\r\n?|\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const summary = lines[index]!.match(/tests failed for (\d+) file\(s\):/i);
    if (summary) {
      let remaining = Number(summary[1]);
      for (let cursor = index + 1; cursor < lines.length && remaining > 0; cursor += 1) {
        const candidate = lines[cursor]!.trim();
        if (!candidate) continue;
        files.add(candidate);
        remaining -= 1;
      }
    }
    const direct = lines[index]!.trim().match(
      /^((?:apps|services|packages|test|tests|src|tools)\/[^\s:]+\.test\.[cm]?[jt]sx?)(?::\d+(?::\d+)?)?(?::|\s|$)/,
    );
    if (direct) files.add(direct[1]!);
  }
  return [...files].sort();
}

function extractLoadSensitiveTests(output: string): string[] {
  const lines = output.split(/\r\n?|\n/);
  const tests = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index]!.match(/^Load-sensitive (?:tests|growth checks) \(.*\):\s*(\d+)\s*$/);
    if (!heading) continue;
    const count = Number(heading[1]);
    for (let offset = 1; offset <= count && index + offset < lines.length; offset += 1) {
      const item = lines[index + offset]!.trim();
      if (item) tests.add(item);
    }
  }
  return [...tests].sort();
}

function outcomeFrom(result: WorkspaceResult, extraDurationMs = 0, extraOutput = ''): WorkspaceOutcome {
  const combinedOutput = [result.output, extraOutput].filter(Boolean).join('\n');
  return {
    name: result.workspace.name,
    directory: result.directory,
    host: process.env.REMOTE_CHECK_HOST ?? 'local',
    passed: result.code === 0,
    durationSeconds: Number(((result.durationMs + extraDurationMs) / 1000).toFixed(3)),
    failingFiles: extractFailingFiles(combinedOutput),
    loadSensitiveTests: extractLoadSensitiveTests(combinedOutput),
  };
}

function resultPath(path: string): string {
  return resolve(root, path);
}

function writeResultFile(path: string, result: GateResultFile): void {
  const target = resultPath(path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(result, null, 2)}\n`);
  writeOutput(`Gate result: ${path}\n`);
}

function readResultFile(path: string): GateResultFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as GateResultFile;
  } catch {
    return null;
  }
}

async function runLocalGate(args: string[]): Promise<number> {
  const selection = readWorkspaceSelection(args);
  const allWorkspaces = await readWorkspaces();
  const workspaces = selection.directories
    ? allWorkspaces.filter((workspace) => selection.directories!.has(workspace.directory))
    : allWorkspaces;
  if (selection.directories) {
    const known = new Set([...allWorkspaces.map((workspace) => workspace.directory), CONTROL_GATE]);
    const unknown = [...selection.directories].filter((directory) => !known.has(directory));
    if (unknown.length > 0) throw new Error(`Unknown workspace directory: ${unknown.join(', ')}`);
  }

  let code = await run(['bun', 'install', '--frozen-lockfile'], root);
  const configuredConcurrency = process.env.GATE_CONCURRENCY;
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
      const result = await checkWorkspace(workspaces[index]!);
      outcomes.push(outcomeFrom(result));
      if (result.code === 0) writeOutput(result.block);
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
    const usesCheckRunner = /\bscripts\/check\.ts\b/.test(workspace.checkScript);
    const loadFailures = classifyLoadInducedOutput(failure.output);
    if (usesCheckRunner || !loadFailures || loadFailures.length === 0) {
      remainingFailures.push(failure);
      continue;
    }

    const again = await checkWorkspace(workspace);
    const existing = outcomes.find((outcome) => outcome.directory === workspace.directory)!;
    const aggregate = outcomeFrom(failure, again.durationMs, again.output);
    aggregate.passed = again.code === 0;
    Object.assign(existing, aggregate);
    if (again.code === 0) {
      writeOutput(failure.block);
      writeOutput(again.block);
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
    );
  }

  for (const failure of remainingFailures) writeOutput(failure.block);
  if (remainingFailures.length > 0)
    writeOutput(`Failed workspaces: ${remainingFailures.map((failure) => failure.directory).join(' ')}\n`);

  let controlPlane: GateResultFile['controlPlane'];
  if (code === 0 && remainingFailures.length === 0 && selection.controlPlane) {
    const started = performance.now();
    const controlCode = await run(['bun', CONTROL_GATE], root);
    controlPlane = {
      passed: controlCode === 0,
      durationSeconds: Number(((performance.now() - started) / 1000).toFixed(3)),
      host: process.env.REMOTE_CHECK_HOST ?? 'local',
    };
    if (controlCode !== 0) {
      code = controlCode;
      writeOutput(`Failed workspaces: ${CONTROL_GATE}\n`);
    }
  }

  const resultFile: GateResultFile = {
    workspaces: outcomes.sort((left, right) => left.directory.localeCompare(right.directory)),
  };
  if (controlPlane) resultFile.controlPlane = controlPlane;
  writeResultFile(process.env.GATE_RESULT_FILE ?? '.temp/gate/result.json', resultFile);

  if (code !== 0) return code;
  return remainingFailures.length > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const selection = readWorkspaceSelection(args);
  const hosts = remoteHostsFile();
  if (hosts && selection.directories === null) return await runRemoteGroups(await readWorkspaces(), hosts);
  return await runLocalGate(args);
}

if (import.meta.main) process.exitCode = await main();
