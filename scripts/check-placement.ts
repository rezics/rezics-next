import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const PERFORMANCE_HOST_NAMES = ['a', 'b'] as const;
const MAX_SMALL_UNIT_FILES = 12;
const MAX_SMALL_UNIT_SOURCE_BYTES = 256 * 1024;
const MAX_SMALL_UNIT_IMPORTS = 64;

export type CheckPlacement = {
  placement: 'local' | 'remote';
  reason: string;
};

type EnvironmentCommand = { prefix: string[]; command: string[] };

/** Parse ordinary env-prefix forms without evaluating shell text. */
export function splitEnvironmentCommand(argv: readonly string[]): EnvironmentCommand | undefined {
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
  return resolve(path).split(/[\\/]+/).filter(Boolean);
}

function hasPathPair(path: string, parent: string, child: string): boolean {
  const segments = pathSegments(path);
  return segments.some((segment, index) => segment === parent && segments[index + 1] === child);
}

/** Paths whose runner owns a database, browser, server or other stack admission. */
export function isNativeStackPath(path: string): boolean {
  return (
    hasPathPair(path, 'services', 'kernel') ||
    hasPathPair(path, 'services', 'auth') ||
    hasPathPair(path, 'apps', 'auth') ||
    hasPathPair(path, 'apps', 'web')
  );
}

function isCompilerDatabasePath(path: string): boolean {
  return hasPathPair(path, 'services', 'kernel') || hasPathPair(path, 'services', 'auth');
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

function executableName(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

function bunExecutable(value: string): boolean {
  return value === 'bun' || value === process.execPath || executableName(value) === 'bun';
}

function projectNeedsCompilerDatabase(args: readonly string[], cwd: string): boolean {
  const projects: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const project =
      argument === '-p' || argument === '--project'
        ? args[index + 1]
        : argument.startsWith('--project=')
          ? argument.slice('--project='.length)
          : undefined;
    if (argument === '-p' || argument === '--project') {
      if (!project || project.startsWith('-')) return true;
      projects.push(project);
      index += 1;
    } else if (argument.startsWith('--project=')) {
      if (!project) return true;
      projects.push(project);
    }
  }
  if (projects.length > 1) return true;
  return isCompilerDatabasePath(resolve(cwd, projects[0] ?? '.'));
}

function pureCompilerOrTool(command: string, args: readonly string[], cwd: string): boolean {
  const name = executableName(command);
  if (name === 'oxlint' || name === 'oxfmt') return true;
  if (name === 'tsc') return args.includes('--noEmit') && !projectNeedsCompilerDatabase(args, cwd);
  if (name === 'check') {
    const hasProject = args.some(
      (argument) => argument === '-p' || argument === '--project' || argument.startsWith('--project='),
    );
    return args.includes('--no-script') && hasProject && !projectNeedsCompilerDatabase(args, cwd);
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

function repositoryRoot(cwd: string): string {
  let directory = resolve(cwd);
  while (true) {
    if (existsSync(join(directory, '.git')) || existsSync(join(directory, '.git', 'HEAD'))) return directory;
    const parent = resolve(directory, '..');
    if (parent === directory) return resolve(cwd);
    directory = parent;
  }
}

function isPureWebTypecheck(directory: string, script: string, source: string | undefined): boolean {
  const segments = pathSegments(directory);
  return (
    script === 'typecheck' &&
    segments.at(-2) === 'apps' &&
    segments.at(-1) === 'web' &&
    source?.trim() === 'bun run generate && bun run generate:routes && bun check --no-script -p tsconfig.json'
  );
}

function isPureRootTypecheck(directory: string, script: string, source: string | undefined): boolean {
  const manifest = join(directory, 'package.json');
  return (
    script === 'typecheck' &&
    resolve(directory) === resolve(repositoryRoot(directory)) &&
    existsSync(manifest) &&
    source?.trim() === 'bun scripts/typecheck.ts'
  );
}

function suspiciousImport(specifier: string): boolean {
  return (
    /(?:^|[/@.-])(?:playwright|vitest\/browser|storybook|browser|server|database)(?:[/@.-]|$)/i.test(specifier) ||
    /^(?:node:)?(?:pg|postgres|mysql2?|sqlite3?|better-sqlite3|drizzle-orm|kysely|mongodb|ioredis|redis)(?:\/|$)/i.test(
      specifier,
    ) ||
    /^(?:node:)?(?:child_process|cluster|dgram|http2?|https|net|tls|worker_threads)(?:\/|$)/i.test(specifier) ||
    specifier.startsWith('@prisma/client')
  );
}

export function environmentPrefixIsSafe(prefix: readonly string[]): boolean {
  const executableControls = new Set([
    'PATH',
    'NODE_OPTIONS',
    'NODE_PATH',
    'BUN_OPTIONS',
    'BUN_INSTALL_CACHE_DIR',
    'BUN_RUNTIME_TRANSPILER_CACHE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
  ]);
  for (let index = 1; index < prefix.length; index += 1) {
    const argument = prefix[index]!;
    if (argument === '--') break;
    if (argument === '-i' || argument === '--ignore-environment') return false;
    if (argument === '-u' || argument === '--unset') {
      if (executableControls.has(prefix[index + 1] ?? '')) return false;
      index += 1;
      continue;
    }
    if (argument.startsWith('--unset=')) {
      if (executableControls.has(argument.slice('--unset='.length))) return false;
      continue;
    }
    const separator = argument.indexOf('=');
    if (separator > 0 && executableControls.has(argument.slice(0, separator))) return false;
  }
  return true;
}

/** Checks every ordinary env layer, including a nested command after an env `--` separator. */
export function environmentCommandIsSafe(argv: readonly string[], depth = 0): boolean {
  if (depth > 8) return false;
  const parsed = splitEnvironmentCommand(argv);
  if (!parsed || !environmentPrefixIsSafe(parsed.prefix)) return false;
  if ((parsed.command[0]?.split(/[\\/]/).at(-1) ?? '') !== 'env') return true;
  return environmentCommandIsSafe(parsed.command, depth + 1);
}

function importsOf(source: string): string[] {
  const imports: string[] = [];
  const expression =
    /(?:\bfrom\s*|\bimport\s*\(|\bimport\s+|\brequire\s*\()(['"])([^'"\n]+)\1/g;
  for (const match of source.matchAll(expression)) imports.push(match[2]!);
  return imports;
}

function smallUnitFile(root: string, file: string, seen: Set<string>): boolean {
  const absolute = resolve(file);
  const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || isNativeStackPath(absolute)) return false;
  if (seen.has(absolute)) return true;
  if (seen.size >= MAX_SMALL_UNIT_IMPORTS) return false;
  seen.add(absolute);
  let stat: ReturnType<typeof lstatSync>;
  let source: string;
  try {
    stat = lstatSync(absolute);
    if (!stat.isFile() || stat.size > MAX_SMALL_UNIT_SOURCE_BYTES) return false;
    source = readFileSync(absolute, 'utf8');
  } catch {
    return false;
  }
  if (/\b(?:Bun\.(?:serve|spawn|spawnSync|listen)|Deno\.serve|chromium\.launch|firefox\.launch|webkit\.launch|createServer\s*\(|fetch\s*\(|new\s+Worker\s*\()/.test(source))
    return false;
  if (/\b(?:import|require)\s*\(\s*(?!['"])/.test(source)) return false;
  const imports = importsOf(source);
  if (imports.some((specifier) => suspiciousImport(specifier))) return false;
  for (const specifier of imports) {
    if (!specifier.startsWith('.')) continue;
    const target = resolve(absolute, '..', specifier);
    const candidates = /\.[cm]?[jt]sx?$/.test(target)
      ? [target]
      : [target, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].map((extension) => `${target}${extension}`)];
    const selected = candidates.find((candidate) => {
      try {
        return lstatSync(candidate).isFile();
      } catch {
        return false;
      }
    });
    if (!selected || !smallUnitFile(root, selected, seen)) return false;
  }
  return true;
}

function hasExplicitTestHarness(file: string): boolean {
  try {
    const source = readFileSync(file, 'utf8');
    return /\b(?:from\s*|import\s*\(|require\s*\()\s*['"](?:bun:test|node:test)['"]/.test(source);
  } catch {
    return false;
  }
}

function testFilesAreSmall(args: readonly string[], cwd: string, root: string): boolean {
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
      if (!value) return false;
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
        if (value === undefined) return false;
        if (!inlineValue) index += 1;
        if (preloadOptions.has(option)) return false;
      }
      continue;
    }
    if (/[*?{}\[\]]/.test(argument)) return false;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(argument)) {
      files.push(resolve(directory, argument));
      continue;
    }
    return false;
  }
  if (files.length === 0 || files.length > MAX_SMALL_UNIT_FILES || isNativeStackPath(directory)) return false;
  const seen = new Set<string>();
  return files.every((file) => hasExplicitTestHarness(file) && smallUnitFile(root, file, seen));
}

function classifyCommand(argv: readonly string[], cwd: string, root: string, depth = 0): CheckPlacement {
  if (argv.length === 0 || depth > 4) return { placement: 'remote', reason: 'unknown command' };
  const command = argv[0]!;
  const args = argv.slice(1);
  const name = executableName(command);
  if (['sh', 'bash', 'dash', 'zsh', 'fish', 'pwsh', 'powershell', 'cmd'].includes(name))
    return { placement: 'remote', reason: 'shell commands are not proven local' };

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
    if (operation === 'test') {
      return testFilesAreSmall(rest, directory, root)
        ? { placement: 'local', reason: 'explicit bounded unit test selection' }
        : { placement: 'remote', reason: 'test selection is not proven small and stack-free' };
    }
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
      if (!script) return { placement: 'remote', reason: 'missing package script' };
      const source = packageScript(directory, script);
      if (isPureRootTypecheck(directory, script, source))
        return { placement: 'local', reason: 'root typecheck' };
      if (isPureWebTypecheck(directory, script, source))
        return { placement: 'local', reason: 'web typecheck' };
      const scriptPath = resolve(directory, script);
      if (isNativeStackPath(directory) || isNativeStackPath(scriptPath) || isNativeScript(scriptPath))
        return { placement: 'remote', reason: 'script belongs to a native stack workspace' };
      if (script.includes('/') || script.includes('\\') || /\.(?:[cm]?[jt]sx?)$/.test(script))
        return { placement: 'remote', reason: 'direct script execution is not proven local' };
      if (!source || /[;&|<>`$]/.test(source)) return { placement: 'remote', reason: 'package script is opaque' };
      const nested = classifyCommand(source.trim().split(/\s+/).filter(Boolean), directory, root, depth + 1);
      return nested.placement === 'local'
        ? { placement: 'local', reason: `package script ${script}: ${nested.reason}` }
        : { placement: 'remote', reason: `package script ${script}: ${nested.reason}` };
    }
    if (operation === 'x') {
      const tool = rest[0];
      return tool && pureCompilerOrTool(tool, rest.slice(1), directory)
        ? { placement: 'local', reason: 'pure compiler or formatter' }
        : { placement: 'remote', reason: 'tool command is not proven local' };
    }
    if (operation === 'check' || operation === 'lint') {
      return pureCompilerOrTool(operation, rest, directory)
        ? { placement: 'local', reason: 'pure compiler or linter command' }
        : { placement: 'remote', reason: 'check command may run scripts or tests' };
    }
    if (operation === 'fmt') return { placement: 'local', reason: 'formatter command' };
    return { placement: 'remote', reason: 'unknown Bun command' };
  }

  if (name === 'oxlint' || name === 'oxfmt') return { placement: 'local', reason: 'formatter or linter command' };
  if (name === 'tsc') {
    return pureCompilerOrTool(command, args, cwd)
      ? { placement: 'local', reason: 'pure TypeScript compile' }
      : { placement: 'remote', reason: 'TypeScript command needs a native compiler database or emits output' };
  }
  return { placement: 'remote', reason: 'unknown command' };
}

/** A conservative placement classifier: only proven typing, formatting and bounded unit tests run locally. */
export function classifyCheck(argv: readonly string[], cwd = process.cwd()): CheckPlacement {
  const root = repositoryRoot(cwd);
  const parsed = splitEnvironmentCommand(argv);
  if (!parsed) return { placement: 'remote', reason: 'environment prefix is not understood' };
  if (!environmentPrefixIsSafe(parsed.prefix))
    return { placement: 'remote', reason: 'environment prefix changes local runtime or executable authority' };
  return classifyCommand(parsed.command, resolve(cwd), root);
}

/** Keep placement targets pinned to the two performance-approved check hosts. */
export function performanceHosts<T extends { name: string }>(hosts: readonly T[]): T[] {
  return hosts.filter((host) => (PERFORMANCE_HOST_NAMES as readonly string[]).includes(host.name));
}

/** True only when the actual process is confined to a remote-check run tree; environment markers do not count. */
export function isCheckHostRun(cwd: string, cgroup?: string): boolean {
  const absolute = resolve(cwd);
  const runs = '/srv/rezics-check/runs';
  const inside = relative(runs, absolute);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return false;
  const runId = inside.split(sep)[0];
  if (!runId || !/^[a-z0-9-]+$/i.test(runId)) return false;
  const currentCgroup = cgroup ?? (() => {
    try {
      return readFileSync('/proc/self/cgroup', 'utf8');
    } catch {
      return '';
    }
  })();
  if (!new RegExp(`(?:^|/)rezics-check-${runId}\\.scope(?:/|$)`).test(currentCgroup)) return false;
  const marker = join(runs, runId, '.remote-check-supervisor');
  try {
    const stats = lstatSync(marker);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) return false;
    const owner = JSON.parse(readFileSync(marker, 'utf8')) as { pid?: unknown; started?: unknown; group?: unknown };
    if (
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.started !== 'string' ||
      !/^\d+$/.test(owner.started) ||
      !Number.isSafeInteger(owner.group)
    )
      return false;
    const processStat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    const supervisor = processStat.slice(processStat.lastIndexOf(')') + 1).trim().split(/\s+/);
    return (
      supervisor[0] !== 'Z' &&
      supervisor[0] !== 'X' &&
      supervisor[2] === String(owner.group) &&
      supervisor[19] === owner.started
    );
  } catch {
    return false;
  }
}
