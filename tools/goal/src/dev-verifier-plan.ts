import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import type { Settings, Task } from './types.ts';
import { siblingTestCommand, siblingTestFiles } from './affected-tests.ts';
import { defaultPolicy } from './policy.ts';
import type { WorkerStore } from './store.ts';
import { matchesPath } from './briefs.ts';
import { gitOutputError } from './merge.ts';
import { selectAffectedChecks } from './check-plan.ts';

/** `cwd` is the repository-relative workspace a check runs from; command paths are relative to it. */
export type DevVerifierCheck = { command: string[]; closure: string[]; taskId?: string; cwd?: string };
type Check = DevVerifierCheck;

export type SourceInterval = {
  base: string;
  target: string;
  commits: string[];
  landed: Set<string>;
  position: Map<string, number>;
  filesByCommit: Map<string, string[]>;
  parents: Map<string, string[]>;
  gitReads: number;
};
export type RevisionSource = {
  commit: string;
  objects: Map<string, string | null>;
  gitReads: number;
};
export type VerifierLandings = { interval: SourceInterval; tasks: Task[] };

function changedFiles(cwd: string, base: string, target: string): string[] {
  return gitText(cwd, ['diff', '--name-only', '-z', `${base}..${target}`])
    .split('\0')
    .filter(Boolean);
}

export function trackedFilesAt(cwd: string, commit: string): Set<string> {
  return new Set(gitText(cwd, ['ls-tree', '-r', '--name-only', commit]).split('\n').filter(Boolean));
}

function bunWorkspace(path: string, tracked: ReadonlySet<string>): string | undefined {
  const [area, name] = path.split('/');
  if (!name || !['apps', 'services', 'packages'].includes(area!)) return undefined;
  const workspace = `${area}/${name}`;
  return path !== workspace && tracked.has(`${workspace}/bunfig.toml`) ? workspace : undefined;
}

/** Place a test command in its workspace so Bun loads that workspace's bunfig.toml. */
export function placeInWorkspace(check: DevVerifierCheck, tracked: ReadonlySet<string>): DevVerifierCheck {
  let index = 0;
  if (check.command[0] === 'env') {
    index++;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(check.command[index] ?? '')) index++;
  }
  if (check.command[index] !== 'bun' || check.command[index + 1] !== 'test') return check;
  const files = check.command
    .slice(index + 2)
    .filter((argument) => !argument.startsWith('-') && argument.includes('/'));
  const workspaces = new Set(files.map((file) => bunWorkspace(file, tracked)));
  const [workspace] = workspaces;
  if (!files.length || workspaces.size !== 1 || !workspace) return check;
  return {
    ...check,
    cwd: workspace,
    command: check.command.map((argument, position) =>
      position > index + 1 && files.includes(argument) ? argument.slice(workspace.length + 1) : argument,
    ),
  };
}

function siblingTestFilesAtCommit(changedPaths: readonly string[], tracked: ReadonlySet<string>): string[] {
  return siblingTestFiles(changedPaths, tracked);
}

const COMMIT_LINE = /^([0-9a-f]{40,})(?: ([0-9a-f]{40,}(?: [0-9a-f]{40,})*))?$/;

function gitText(cwd: string, args: string[], input?: string): string {
  const policy = defaultPolicy.merge;
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: policy.gitBufferBytes,
    timeout: policy.commandTimeoutMs,
    ...(input === undefined ? {} : { input }),
  });
  const overflow = gitOutputError(result, policy.gitBufferBytes, `git ${args[0]}`);
  if (overflow) throw overflow;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout.trim();
}

/** One batched `cat-file --batch-check` at an immutable revision; never a per-path scan. */
export function projectRevisionSource(cwd: string, commit: string, paths: readonly string[]): RevisionSource {
  const unique = [...new Set(paths.filter(Boolean))];
  const objects = new Map<string, string | null>();
  if (!unique.length) return { commit, objects, gitReads: 0 };
  const output = gitText(
    cwd,
    ['cat-file', '--batch-check'],
    `${unique.map((path) => `${commit}:${path}`).join('\n')}\n`,
  );
  const lines = output ? output.split('\n') : [];
  unique.forEach((path, index) => {
    const line = lines[index] ?? '';
    objects.set(path, line.endsWith(' missing') ? null : line.split(' ')[0] || null);
  });
  return { commit, objects, gitReads: 1 };
}

export function mergeRevisionSource(
  cwd: string,
  commit: string,
  paths: readonly string[],
  existing?: RevisionSource,
): RevisionSource {
  const needed = [...new Set(paths.filter(Boolean))];
  const missing = existing ? needed.filter((path) => !existing.objects.has(path)) : needed;
  if (!missing.length) return existing ?? { commit, objects: new Map(), gitReads: 0 };
  const extra = projectRevisionSource(cwd, commit, missing);
  if (!existing) return extra;
  for (const [path, oid] of extra.objects) existing.objects.set(path, oid);
  existing.gitReads += extra.gitReads;
  return existing;
}

function parseNameOnlyLog(output: string): { commit: string; parents: string[]; files: string[] }[] {
  if (!output) return [];
  return output.split('\n\n').flatMap((chunk) => {
    const lines = chunk.split('\n');
    const match = COMMIT_LINE.exec(lines[0]!.trimEnd());
    if (!match) return [];
    return [
      {
        commit: match[1]!,
        parents: match[2] ? match[2].split(' ') : [],
        files: lines.slice(1).filter(Boolean),
      },
    ];
  });
}

function recordLog(
  interval: SourceInterval,
  records: readonly { commit: string; parents: string[]; files: string[] }[],
  ontoInterval: boolean,
): void {
  for (const record of records) {
    interval.filesByCommit.set(record.commit, record.files);
    interval.parents.set(record.commit, record.parents);
    if (!ontoInterval || interval.landed.has(record.commit)) continue;
    interval.position.set(record.commit, interval.commits.length);
    interval.commits.push(record.commit);
    interval.landed.add(record.commit);
  }
}

/** One bounded Git projection of `base..target`; extra commits are a second batched read, never a per-commit scan. */
export function projectSourceInterval(
  cwd: string,
  base: string,
  target: string,
  extraCommits: readonly string[] = [],
): SourceInterval {
  const interval: SourceInterval = {
    base,
    target,
    commits: [],
    landed: new Set(),
    position: new Map(),
    filesByCommit: new Map(),
    parents: new Map(),
    gitReads: 1,
  };
  recordLog(
    interval,
    parseNameOnlyLog(gitText(cwd, ['log', '--reverse', '--name-only', '--pretty=format:%H %P', `${base}..${target}`])),
    true,
  );
  const extras = [...new Set(extraCommits.filter((commit) => !interval.landed.has(commit)))];
  if (!extras.length) return interval;
  interval.gitReads++;
  recordLog(
    interval,
    parseNameOnlyLog(
      gitText(cwd, ['log', '--no-walk', '--stdin', '--name-only', '--pretty=format:%H %P'], `${extras.join('\n')}\n`),
    ),
    false,
  );
  return interval;
}

const skippedKinds = new Set(['specification', 'research', 'verification']);

function landingTasks(store: Pick<WorkerStore, 'tasks'>, interval: Pick<SourceInterval, 'landed'>): Task[] {
  return store
    .tasks()
    .filter(
      (task) =>
        ['integrated', 'merged'].includes(task.state) &&
        (task.integratedCommit ?? task.mergedCommit) &&
        [...(task.integratedCommits ?? []), task.integratedCommit ?? task.mergedCommit!].some((commit) =>
          interval.landed.has(commit),
        ) &&
        task.brief.kind !== undefined &&
        !skippedKinds.has(task.brief.kind),
    );
}

export function projectVerifierLandings(
  cwd: string,
  store: Pick<WorkerStore, 'tasks'>,
  base: string,
  target: string,
): VerifierLandings {
  const interval = projectSourceInterval(cwd, base, target);
  const tasks = landingTasks(store, interval);
  const extras = [...new Set(tasks.flatMap((task) => task.integratedCommits ?? []))].filter(
    (commit) => !interval.landed.has(commit),
  );
  if (extras.length) {
    interval.gitReads++;
    recordLog(
      interval,
      parseNameOnlyLog(
        gitText(cwd, ['log', '--no-walk', '--stdin', '--name-only', '--pretty=format:%H %P'], `${extras.join('\n')}\n`),
      ),
      false,
    );
  }
  return { interval, tasks };
}

export function matches(file: string, paths: readonly string[], policy = defaultPolicy.brief): boolean {
  return paths.some((path) => matchesPath(file, [path], policy));
}

export function taskCommits(task: Task, interval: SourceInterval): string[] {
  if (task.integratedCommits?.length) return task.integratedCommits;
  const commit = task.integratedCommit ?? task.mergedCommit;
  if (!commit) return [];
  const stop = task.integratedBase ?? task.base;
  const seen = new Set<string>();
  const walked: string[] = [];
  const stack = [commit];
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current) || current === stop) continue;
    seen.add(current);
    if (interval.landed.has(current)) walked.push(current);
    for (const parent of interval.parents.get(current) ?? []) stack.push(parent);
  }
  return walked.sort((left, right) => (interval.position.get(left) ?? -1) - (interval.position.get(right) ?? -1));
}

export function filesInCommits(interval: SourceInterval, commitList: readonly string[]): string[] {
  const files = new Set<string>();
  for (const commit of commitList) for (const file of interval.filesByCommit.get(commit) ?? []) files.add(file);
  return [...files];
}

export function createVerifierChecks(
  settings: Settings,
  history: VerifierLandings,
  candidate = history.interval.target,
): DevVerifierCheck[] {
  const checkout = settings.mainCheckout;
  const files = changedFiles(checkout, history.interval.base, history.interval.target);
  if (!files.length) return [];
  const typecheck = ['bun', 'scripts/typecheck.ts'];
  const checks: Check[] = [
    { command: ['env', `TYPECHECK_CHANGED=${files.join('\n')}`, ...typecheck], closure: ['**'] },
  ];
  for (const affected of selectAffectedChecks(
    files,
    settings.verifierChecks ?? settings.affectedTests ?? [],
    settings.policy?.brief,
  ))
    checks.push({ command: [...affected.command], closure: [...affected.paths] });
  const tracked = trackedFilesAt(checkout, candidate);
  if (settings.siblingTests) {
    const nonSpecFiles = files.filter((file) => !file.startsWith('spec/') && !file.startsWith('specs/'));
    const groups = new Map<string, string[]>();
    for (const file of siblingTestFilesAtCommit(nonSpecFiles, tracked)) {
      const workspace = bunWorkspace(file, tracked) ?? '';
      groups.set(workspace, [...(groups.get(workspace) ?? []), file]);
    }
    for (const siblingFiles of groups.values()) {
      const siblingCommand = siblingTestCommand(siblingFiles, settings.siblingTests.command);
      if (siblingCommand) checks.push({ command: siblingCommand, closure: siblingFiles });
    }
  }
  for (const task of history.tasks) {
    // Worker-owned briefs have no declared command to execute or credit as passed.
    if (task.brief.acceptance.workerOwned && !task.brief.acceptance.command.length) continue;
    checks.push({ command: [...task.brief.acceptance.command], closure: [...task.brief.paths], taskId: task.id });
  }
  return checks.map((check) => placeInWorkspace(check, tracked));
}

function checkSourcePaths(command: readonly string[]): string[] {
  let index = 0;
  if (command[index] === 'env') {
    index++;
    while (command[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) index++;
  }
  const program = basename(command[index] ?? '');
  if (!['bun', 'node', 'tsx', 'ts-node', 'python', 'python3', 'sh', 'bash', 'deno'].includes(program)) return [];
  const paths: string[] = [];
  for (let cursor = index + 1; cursor < command.length; cursor++) {
    const arg = command[cursor]!;
    if (arg === '--') break;
    if (arg === '--cwd' || arg === '--config' || arg === '--loader' || arg === '-r' || arg === '--require') {
      cursor++;
      continue;
    }
    if (['run', 'test', 'x', 'exec', 'check', 'fmt', 'lint', '-e', '-c', '--eval'].includes(arg)) {
      if (['-e', '-c', '--eval'].includes(arg)) cursor++;
      continue;
    }
    if (arg.startsWith('-') || arg.includes('=') || /^https?:/.test(arg)) continue;
    if (/[./\\]/.test(arg) || /\.(?:[cm]?[jt]sx?|py|sh|json)$/i.test(arg)) paths.push(arg);
  }
  return paths;
}

export function checkSourceFiles(check: DevVerifierCheck): string[] {
  return checkSourcePaths(check.command)
    .filter((candidate) => !candidate.startsWith('/'))
    .map((candidate) => {
      const path = candidate.replace(/^[.][/\\]/, '').replaceAll('\\', '/');
      return check.cwd ? `${check.cwd}/${path}` : path;
    });
}

export function checkInputAreas(check: DevVerifierCheck): string[] | undefined {
  const areas = new Set(['package.json', 'bun.lock', ...(check.cwd ? [check.cwd] : [])]);
  for (const path of [...check.closure, ...checkSourceFiles(check)]) {
    const segments = path.split('/');
    const workspace = ['apps', 'services', 'packages'].includes(segments[0]!);
    const area = segments.slice(0, workspace ? 2 : 1);
    if (area.some((segment) => !segment || /[*?{}]/.test(segment))) return undefined;
    areas.add(area.join('/'));
    if (workspace && segments[0] !== 'packages') areas.add('packages');
  }
  return [...areas];
}

export function checkSourceQueryPaths(check: DevVerifierCheck): string[] {
  const files = checkSourceFiles(check);
  const areas = checkInputAreas(check);
  return areas ? [...new Set([...files, ...areas])] : files;
}

export function projectChecksSource(cwd: string, commit: string, checks: readonly DevVerifierCheck[]): RevisionSource {
  return projectRevisionSource(cwd, commit, checks.flatMap(checkSourceQueryPaths));
}

export function sourcePresentAt(source: RevisionSource, check: DevVerifierCheck): boolean {
  return checkSourceFiles(check).every((path) => source.objects.get(path) != null);
}
