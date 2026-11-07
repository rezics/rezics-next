import { spawnSync } from 'node:child_process';
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
  };
  recordLog(
    interval,
    parseNameOnlyLog(gitText(cwd, ['log', '--reverse', '--name-only', '--pretty=format:%H %P', `${base}..${target}`])),
    true,
  );
  const extras = [...new Set(extraCommits.filter((commit) => !interval.landed.has(commit)))];
  if (!extras.length) return interval;
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

/** Count a range before projecting every changed path; oversized ranges use the complete suite. */
export function countSourceIntervalCommits(cwd: string, base: string, target: string): number {
  const count = Number(gitText(cwd, ['rev-list', '--count', `${base}..${target}`]));
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('git rev-list returned an invalid commit count');
  return count;
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
  excludeTests: readonly string[] = [],
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
    for (const file of siblingTestFilesAtCommit(nonSpecFiles, tracked).filter((path) => !excludeTests.includes(path))) {
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

/** Plan a bounded complete test set for the first round or a change range too large to select from. */
export function createFullVerifierChecks(
  settings: Settings,
  candidate: string,
  excludeTests: readonly string[] = [],
): DevVerifierCheck[] {
  const configured = settings.verifierChecks ?? settings.affectedTests ?? [];
  const checks: Check[] = [
    { command: ['bun', 'scripts/typecheck.ts'], closure: ['**'] },
    ...configured.map((item) => ({ command: [...item.command], closure: [...item.paths] })),
  ];
  if (settings.siblingTests) {
    const tracked = trackedFilesAt(settings.mainCheckout, candidate);
    const tests = [...tracked]
      .filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path))
      .filter((path) => !path.startsWith('services/kernel/'))
      .filter((path) => !excludeTests.includes(path))
      .sort();
    const workspaces = new Map<string, string[]>();
    for (const test of tests) {
      const workspace = bunWorkspace(test, tracked) ?? '';
      workspaces.set(workspace, [...(workspaces.get(workspace) ?? []), test]);
    }
    const chunkSize = 25;
    for (const files of workspaces.values()) {
      for (let offset = 0; offset < files.length; offset += chunkSize) {
        const chunk = files.slice(offset, offset + chunkSize);
        const command = siblingTestCommand(chunk, settings.siblingTests.command);
        if (command) checks.push({ command, closure: chunk });
      }
    }
  }
  const tracked = trackedFilesAt(settings.mainCheckout, candidate);
  const unique = new Map<string, Check>();
  for (const check of checks) unique.set(JSON.stringify(check), check);
  return [...unique.values()].map((check) => placeInWorkspace(check, tracked));
}
