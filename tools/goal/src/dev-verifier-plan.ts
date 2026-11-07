import { spawnSync } from 'node:child_process';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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

const WEB_ROOT = 'apps/web';
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const HOST_TEST_FILE = /\.host\.test\.[cm]?[jt]sx?$/iu;
const webLaneEnvironment = new Set([
  'WEB_BROWSER_CHECK_CONCURRENCY',
  'WEB_UNIT_CHECK_CONCURRENCY',
  'WEB_CHECK_SERIAL_LANES',
]);
const bunTestFlagsWithValue = new Set([
  '--timeout',
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
const envOptionsWithValue = new Set(['-u', '--unset', '-C', '--chdir']);

type CommandPrefix = { commandIndex: number; prefix: string[]; cwd?: string };
type BunTestInvocation = {
  prefix: CommandPrefix;
  argumentIndex: number;
  testFlags: string[];
  selectors: string[];
  programArgs: string[];
  commandCwd?: string;
};
type Placement = { check: DevVerifierCheck; webEntries?: { file: string; prefix: string[] }[] };

function commandPrefix(command: readonly string[]): CommandPrefix {
  if (command[0] !== 'env') return { commandIndex: 0, prefix: [] };
  let index = 1;
  let cwd: string | undefined;
  while (index < command.length) {
    const argument = command[index]!;
    if (argument === '--') return { commandIndex: index + 1, prefix: command.slice(0, index), ...(cwd ? { cwd } : {}) };
    if (envOptionsWithValue.has(argument)) {
      const value = command[index + 1];
      if (argument === '-C' || argument === '--chdir') cwd = value;
      index += 2;
      continue;
    }
    if (/^(?:--unset=|--chdir=)/u.test(argument)) {
      if (argument.startsWith('--chdir=')) cwd = argument.slice('--chdir='.length);
      index++;
      continue;
    }
    if (argument === '-i' || argument === '--ignore-environment' || /^-u.+$/u.test(argument)) {
      index++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
      index++;
      continue;
    }
    break;
  }
  return { commandIndex: index, prefix: command.slice(0, index), ...(cwd ? { cwd } : {}) };
}

function bunTestInvocation(command: readonly string[], prefix: CommandPrefix): BunTestInvocation | undefined {
  const index = prefix.commandIndex;
  if (command[index] !== 'bun') return undefined;
  let argumentIndex: number;
  let commandCwd: string | undefined;
  if (command[index + 1] === 'test') argumentIndex = index + 2;
  else if (command[index + 1] === 'run') {
    let script = index + 2;
    while (script < command.length && command[script]!.startsWith('-')) {
      if (command[script] === '--cwd') {
        commandCwd = command[script + 1];
        script += 2;
      } else if (command[script] === '--if-present' || command[script] === '--filter') script += 2;
      else script++;
    }
    if (command[script] !== 'test') return undefined;
    argumentIndex = script + 1;
  } else return undefined;

  const testFlags: string[] = [];
  const selectors: string[] = [];
  let programArgs: string[] = [];
  for (let cursor = argumentIndex; cursor < command.length; cursor++) {
    const argument = command[cursor]!;
    if (argument === '--') {
      programArgs = command.slice(cursor + 1);
      break;
    }
    const name = argument.split('=', 1)[0]!;
    if (argument.startsWith('-')) {
      testFlags.push(argument);
      if (!argument.includes('=') && bunTestFlagsWithValue.has(name) && cursor + 1 < command.length)
        testFlags.push(command[++cursor]!);
      continue;
    }
    selectors.push(argument);
  }
  return { prefix, argumentIndex, testFlags, selectors, programArgs, ...(commandCwd ? { commandCwd } : {}) };
}

function resolveWorkspaceDirectory(path: string, base: string, checkout?: string): string {
  if (isAbsolute(path)) {
    if (!checkout) return path.replaceAll('\\', '/');
    const inside = relative(resolve(checkout), resolve(path));
    return inside === '' ? '.' : inside.split(sep).join('/');
  }
  if (checkout) {
    const inside = relative(resolve(checkout), resolve(checkout, base, path));
    return inside === '' ? '.' : inside.split(sep).join('/');
  }
  const joined = [base, path].filter((part) => part && part !== '.').join('/');
  const parts: string[] = [];
  for (const part of joined.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/') || '.';
}

function workspaceCwd(check: DevVerifierCheck, prefix: CommandPrefix, checkout?: string, commandCwd?: string): string {
  let cwd = check.cwd?.replaceAll('\\', '/').replace(/^\.\//u, '') || '.';
  if (prefix.cwd !== undefined) cwd = resolveWorkspaceDirectory(prefix.cwd, cwd, checkout);
  if (commandCwd !== undefined) cwd = resolveWorkspaceDirectory(commandCwd, cwd, checkout);
  return cwd;
}

function repositoryPath(argument: string, cwd: string, checkout?: string): string {
  const normalized = argument.replaceAll('\\', '/');
  if (normalized.startsWith(WEB_ROOT + '/')) return normalized;
  if (isAbsolute(argument) && checkout) {
    const inside = relative(resolve(checkout), resolve(argument));
    return inside === '' ? '.' : inside.split(sep).join('/');
  }
  if (checkout) {
    const base = isAbsolute(cwd) ? cwd : resolve(checkout, cwd);
    return relative(resolve(checkout), resolve(base, argument)).split(sep).join('/') || '.';
  }
  const joined = [cwd === '.' ? '' : cwd, normalized].filter(Boolean).join('/');
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function isWebWorkspacePath(path: string): boolean {
  return path === WEB_ROOT || path.startsWith(WEB_ROOT + '/');
}

function globExpression(pattern: string): RegExp {
  let expression = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index++;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else if ('\\^$+?.()|{}[]'.includes(character)) expression += '\\' + character;
    else expression += character;
  }
  return new RegExp(expression + '$', 'u');
}

function expandWebSelectors(selectors: readonly string[], files: readonly string[]): string[] {
  if (!selectors.length) return files.filter((file) => !HOST_TEST_FILE.test(file)).sort();
  const selected: string[] = [];
  for (const selector of selectors) {
    const pattern = selector.replaceAll('\\', '/').replace(/^\.\//u, '');
    let matches: string[];
    if (pattern.includes('*') || pattern.includes('?')) {
      const expression = globExpression(pattern);
      matches = files.filter(
        (file) => expression.test(file) || (!pattern.includes('/') && expression.test(file.split('/').at(-1) ?? '')),
      );
    } else if (files.includes(pattern)) matches = [pattern];
    else if (files.some((file) => file.startsWith(pattern.replace(/\/$/u, '') + '/')))
      matches = files.filter((file) => file.startsWith(pattern.replace(/\/$/u, '') + '/'));
    else if (pattern.includes('/')) matches = files.filter((file) => file.includes(pattern));
    else matches = files.filter((file) => file.split('/').at(-1)?.includes(pattern));
    if (!HOST_TEST_FILE.test(pattern)) matches = matches.filter((file) => !HOST_TEST_FILE.test(file));
    selected.push(...(matches.length ? matches : [pattern]));
  }
  return [...new Set(selected)];
}

function routedEnvironmentPrefix(prefix: readonly string[]): string[] {
  if (!prefix.length) return ['env'];
  const result = prefix.slice(0, 1);
  for (let index = 1; index < prefix.length; index++) {
    const argument = prefix[index]!;
    if (argument === '--') continue;
    if (argument === '-C' || argument === '--chdir') {
      index++;
      continue;
    }
    if (argument.startsWith('--chdir=')) continue;
    const assignment = argument.indexOf('=');
    if (assignment > 0 && webLaneEnvironment.has(argument.slice(0, assignment))) continue;
    result.push(argument);
  }
  return result;
}

function preparePlacement(check: DevVerifierCheck, tracked: ReadonlySet<string>, checkout?: string): Placement {
  const prefix = commandPrefix(check.command);
  const invocation = bunTestInvocation(check.command, prefix);
  if (!invocation) return { check: placeNonWebInWorkspace(check, tracked, prefix, checkout) };
  const currentCwd = workspaceCwd(check, prefix, checkout, invocation.commandCwd);
  const repoSelectors = invocation.selectors.map((selector) => repositoryPath(selector, currentCwd, checkout));
  const selectedWorkspace = new Set(repoSelectors.map((path) => bunWorkspace(path, tracked)));
  const hasWebSelector = repoSelectors.some(isWebWorkspacePath);
  const allSelectorsAreWeb = repoSelectors.every(isWebWorkspacePath);
  const webContext =
    currentCwd === WEB_ROOT ||
    currentCwd.startsWith(WEB_ROOT + '/') ||
    (check.closure.some(isWebWorkspacePath) && (repoSelectors.length === 0 || hasWebSelector)) ||
    hasWebSelector;
  if (
    !webContext ||
    (repoSelectors.length > 0 && !allSelectorsAreWeb) ||
    (selectedWorkspace.size > 1 && !hasWebSelector)
  )
    return { check: placeNonWebInWorkspace(check, tracked, prefix) };

  const webFiles = [...tracked]
    .filter((path) => path.startsWith(WEB_ROOT + '/') && TEST_FILE.test(path))
    .map((path) => path.slice(WEB_ROOT.length + 1))
    .sort();
  const normalizedSelectors = repoSelectors.map((path) =>
    isWebWorkspacePath(path) ? path.slice(WEB_ROOT.length + 1) : path,
  );
  const selectedFiles = expandWebSelectors(normalizedSelectors, webFiles);
  const envPrefix = [
    ...routedEnvironmentPrefix(invocation.prefix.prefix),
    'WEB_BROWSER_CHECK_CONCURRENCY=1',
    'WEB_UNIT_CHECK_CONCURRENCY=1',
    'WEB_CHECK_SERIAL_LANES=1',
    'bun',
    'scripts/check.ts',
  ];
  const webEntries = selectedFiles.map((file) => ({
    file,
    prefix: HOST_TEST_FILE.test(file)
      ? [
          ...envPrefix,
          '--host',
          file,
          ...invocation.testFlags,
          ...(invocation.programArgs.length ? ['--', ...invocation.programArgs] : []),
        ]
      : [
          ...envPrefix,
          '--skip-format',
          ...invocation.testFlags,
          file,
          ...(invocation.programArgs.length ? ['--', ...invocation.programArgs] : []),
        ],
  }));
  const webPrefix = [...envPrefix, '--skip-format', ...invocation.testFlags];
  const routed: DevVerifierCheck = {
    ...check,
    cwd: WEB_ROOT,
    command: webEntries.length ? [...webEntries[0]!.prefix] : webPrefix,
  };
  return { check: routed, webEntries };
}

function placeNonWebInWorkspace(
  check: DevVerifierCheck,
  tracked: ReadonlySet<string>,
  prefix: CommandPrefix,
  checkout?: string,
): DevVerifierCheck {
  const invocation = bunTestInvocation(check.command, prefix);
  if (!invocation) return check;
  const currentCwd = workspaceCwd(check, prefix, checkout, invocation.commandCwd);
  const files = invocation.selectors.map((file) => repositoryPath(file, currentCwd, checkout));
  const workspaces = new Set(files.map((file) => bunWorkspace(file, tracked)));
  const [workspace] = workspaces;
  if (!files.length || workspaces.size !== 1 || !workspace) return check;
  const normalized = new Map(
    invocation.selectors.map((source, index) => [source, files[index]!.slice(workspace.length + 1)]),
  );
  const command = check.command.map((argument, position) =>
    position >= invocation.argumentIndex && normalized.has(argument) ? normalized.get(argument)! : argument,
  );
  return { ...check, cwd: workspace, command };
}

function splitWebPlacement(placement: Placement): DevVerifierCheck[] {
  if (!placement.webEntries?.length) return [placement.check];
  return placement.webEntries.map(({ prefix }) => ({
    ...placement.check,
    command: prefix,
  }));
}

/** Place a test command in its owning workspace; Web tests go through Web's routed, isolated check entrypoint. */
export function placeInWorkspace(
  check: DevVerifierCheck,
  tracked: ReadonlySet<string>,
  checkout?: string,
): DevVerifierCheck {
  return preparePlacement(check, tracked, checkout).check;
}

/** Split selected Web files into independently attributable, deadline-carryable checks. */
export function placeInWorkspaceChecks(
  check: DevVerifierCheck,
  tracked: ReadonlySet<string>,
  checkout?: string,
): DevVerifierCheck[] {
  return splitWebPlacement(preparePlacement(check, tracked, checkout));
}

/** Boot smoke uses the documented focused Web runner and avoids the full Web check preparation. */
export function placeBootSmokeCheck(
  check: DevVerifierCheck,
  tracked: ReadonlySet<string>,
  checkout?: string,
): DevVerifierCheck[] {
  const prefix = commandPrefix(check.command);
  const invocation = bunTestInvocation(check.command, prefix);
  if (!invocation) return placeInWorkspaceChecks(check, tracked, checkout);
  const cwd = workspaceCwd(check, prefix, checkout, invocation.commandCwd);
  const repoSelectors = invocation.selectors.map((file) => repositoryPath(file, cwd, checkout));
  if (!repoSelectors.some(isWebWorkspacePath)) return placeInWorkspaceChecks(check, tracked, checkout);
  const envPrefix = invocation.prefix.prefix.length ? routedEnvironmentPrefix(invocation.prefix.prefix) : [];
  return repoSelectors.map((path) => {
    const file = isWebWorkspacePath(path) ? path.slice(WEB_ROOT.length + 1) : path;
    return {
      ...check,
      cwd: WEB_ROOT,
      command: [
        ...envPrefix,
        'bun',
        'scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        ...invocation.testFlags,
        file,
        ...(invocation.programArgs.length ? ['--', ...invocation.programArgs] : []),
      ],
    };
  });
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
  return checks.flatMap((check) => placeInWorkspaceChecks(check, tracked, checkout));
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
  return [...unique.values()].flatMap((check) => placeInWorkspaceChecks(check, tracked, settings.mainCheckout));
}
