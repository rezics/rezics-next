import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { lifecycleSpecFromArgv } from './check-lifecycle-child.ts';

export const PERFORMANCE_HOST_NAMES = ['a', 'b'] as const;
export const CHECK_HOST_RUNS_ROOT = '/srv/rezics-check/runs';
export const CHECK_HOST_SUPERVISOR_MARKER = '.remote-check-supervisor';
/** Shared producer/receiver description for the physical lifetime marker. */
export const CHECK_HOST_SUPERVISOR_MARKER_SCHEMA = {
  version: 1,
  fields: ['schema', 'host', 'run', 'pid', 'started', 'group', 'uid'],
  hosts: PERFORMANCE_HOST_NAMES,
  runIdPattern: '^[a-z0-9-]{1,64}$',
  maxBytes: 4096,
  maxPid: Number.MAX_SAFE_INTEGER,
  maxStartDigits: 20,
} as const;
const MAX_SMALL_UNIT_FILES = 12;
const MAX_SMALL_UNIT_SOURCE_BYTES = 256 * 1024;
const MAX_SMALL_UNIT_IMPORTS = 64;
const MAX_CHECK_HOST_MARKER_BYTES = CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.maxBytes;
const MAX_CHECK_HOST_PROC_BYTES = 4096;
// Local tests understand only these harness/assertion modules plus recursively checked relative files. Other bare,
// workspace, builtin, dynamic, or configuration routes are opaque and stay remote. The closure is bounded to 12 test
// entries, 64 source files, 64 static imports per file, and 256 KiB per source; it does not execute sources to inspect
// them and rejects symlinked source parents instead of resolving through them.
const SAFE_SMALL_UNIT_IMPORTS = new Set(['bun:test', 'node:test', 'node:assert', 'node:assert/strict']);

export type CheckPlacement = {
  placement: 'local' | 'remote';
  reason: string;
};

export function checkHostScopeUnitName(runId: string): string {
  return `${checkHostScopeUnitStem(runId)}.scope`;
}

export function checkHostScopeUnitStem(runId: string): string {
  return `rezics-check-${runId}`;
}

export function checkHostRunSliceUnitName(runId: string): string {
  return `rezics-check-${runId.replaceAll('-', '_')}.slice`;
}

export type CheckHostRecognitionReason =
  | 'cwd-not-absolute'
  | 'cwd-outside-runs'
  | 'run-id-invalid'
  | 'runs-root-unavailable'
  | 'runs-root-not-directory'
  | 'run-directory-unavailable'
  | 'run-directory-not-physical'
  | 'cwd-unavailable'
  | 'cwd-not-confined'
  | 'cgroup-unavailable'
  | 'cgroup-invalid'
  | 'scope-mismatch'
  | 'supervisor-marker-missing'
  | 'supervisor-marker-unavailable'
  | 'supervisor-marker-not-regular'
  | 'supervisor-marker-oversized'
  | 'supervisor-marker-invalid'
  | 'supervisor-host-invalid'
  | 'supervisor-run-mismatch'
  | 'supervisor-uid-mismatch'
  | 'supervisor-stat-unavailable'
  | 'supervisor-stat-invalid'
  | 'supervisor-state-unknown'
  | 'supervisor-not-live'
  | 'supervisor-start-mismatch'
  | 'supervisor-group-mismatch'
  | 'evidence-unavailable';

export type CheckHostRecognitionDisposition =
  | {
      outcome: 'admitted';
      runId: string;
      scope: string;
      supervisor: { pid: number; started: string; group: number };
    }
  | { outcome: 'refused'; reason: CheckHostRecognitionReason };

export type CheckHostPathEvidence =
  | { status: 'ok'; kind: 'directory' | 'file' | 'symlink' | 'other'; realPath: string }
  | { status: 'missing' | 'unavailable' };

export type CheckHostReadEvidence =
  | { status: 'ok'; kind: 'regular'; text: string; size: number }
  | { status: 'missing' | 'unavailable' | 'too-large' | 'not-regular' | 'symlink' };

/** Read-only seam for bounded, inert filesystem/proc/uid fixtures. Production callers use the fixed host reader below. */
export type CheckHostRecognitionReader = {
  inspect(path: string): CheckHostPathEvidence;
  read(path: string, maxBytes: number): CheckHostReadEvidence;
  /** Fixed process identity in production; inert readers provide a fixture uid. */
  uid(): number;
};

function hostPathEvidence(path: string): CheckHostPathEvidence {
  try {
    const stats = lstatSync(path);
    const kind = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : 'other';
    return { status: 'ok', kind, realPath: realpathSync(path) };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'missing' } : { status: 'unavailable' };
  }
}

function hostReadEvidence(path: string, maxBytes: number): CheckHostReadEvidence {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) return { status: 'not-regular' };
    if (stats.size > maxBytes) return { status: 'too-large' };
    const bytes = Buffer.alloc(maxBytes + 1);
    const count = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    if (count > maxBytes) return { status: 'too-large' };
    return { status: 'ok', kind: 'regular', text: bytes.subarray(0, count).toString('utf8'), size: count };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { status: 'missing' };
    if (code === 'ELOOP') return { status: 'symlink' };
    return { status: 'unavailable' };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

const hostRecognitionReader: CheckHostRecognitionReader = {
  inspect: hostPathEvidence,
  read: hostReadEvidence,
  uid: () => process.getuid?.() ?? Number.NaN,
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
  return resolve(path)
    .split(/[\\/]+/)
    .filter(Boolean);
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
  const hostLocalSettings = new Set([
    'HOME',
    'USERPROFILE',
    'NODE',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'DBUS_SESSION_BUS_ADDRESS',
    'DEBUGINFOD_IMA_CERT_PATH',
    'MOZ_GMP_PATH',
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
    if (separator > 0) {
      const name = argument.slice(0, separator);
      const value = argument.slice(separator + 1);
      if (
        executableControls.has(name) ||
        hostLocalSettings.has(name) ||
        name.startsWith('NVM_') ||
        /^npm_/i.test(name) ||
        isAbsolute(value)
      )
        return false;
    }
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
  const expression = /(?:\bfrom\s*|\bimport\s*\(|\bimport\s+|\brequire\s*\()(['"])([^'"\n]+)\1/g;
  for (const match of source.matchAll(expression)) imports.push(match[2]!);
  return imports;
}

function pathIsInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/** Reject symlinked source parents and paths that resolve outside the physical checkout. */
function isPhysicalSourcePath(root: string, path: string): boolean {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  if (!pathIsInside(absoluteRoot, absolutePath)) return false;
  try {
    let current = absoluteRoot;
    for (const segment of relative(absoluteRoot, absolutePath).split(sep).filter(Boolean)) {
      current = join(current, segment);
      if (lstatSync(current).isSymbolicLink()) return false;
    }
    return pathIsInside(realpathSync(absoluteRoot), realpathSync(absolutePath));
  } catch {
    return false;
  }
}

function configFileExistsOrIsUnknown(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== 'ENOENT';
  }
}

/**
 * Bun's project bunfig can preload code for the runtime or test runner. Until TOML config is verified,
 * any bunfig on an effective source path is opaque. Inherited NODE_OPTIONS and BUN_OPTIONS can also
 * inject runtime flags, so neither is accepted for local unit placement.
 */
function hasOpaqueTestRuntimeConfiguration(root: string, start: string): boolean {
  const absoluteRoot = resolve(root);
  let directory = resolve(start);
  if (!isPhysicalSourcePath(absoluteRoot, directory)) return true;
  if (process.env.NODE_OPTIONS?.trim() || process.env.BUN_OPTIONS?.trim()) return true;
  while (pathIsInside(absoluteRoot, directory)) {
    if (configFileExistsOrIsUnknown(join(directory, 'bunfig.toml'))) return true;
    if (directory === absoluteRoot) return false;
    const parent = dirname(directory);
    if (parent === directory) return true;
    directory = parent;
  }
  return true;
}

function smallUnitFile(root: string, file: string, seen: Set<string>): boolean {
  const absolute = resolve(file);
  const rel = relative(root, absolute);
  if (
    rel === '..' ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    isNativeStackPath(absolute) ||
    !isPhysicalSourcePath(root, absolute) ||
    hasOpaqueTestRuntimeConfiguration(root, dirname(absolute))
  )
    return false;
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
  if (
    /\b(?:Bun\.(?:serve|spawn|spawnSync|listen|sql|file|write|connect)|Deno\.(?:serve|Command|connect|listen)|process\.(?:dlopen|binding|kill|exit|abort)|chromium\.launch|firefox\.launch|webkit\.launch|createServer\s*\(|fetch\s*\(|new\s+(?:Worker|WebSocket|EventSource)\s*\()/.test(
      source,
    )
  )
    return false;
  if (/\b(?:import|require)\s*\(\s*(?!['"])/.test(source)) return false;
  const imports = importsOf(source);
  if (imports.length > MAX_SMALL_UNIT_IMPORTS) return false;
  for (const specifier of imports) {
    if (!/^(?:\.{1,2})(?:\/|$)/.test(specifier)) {
      if (!SAFE_SMALL_UNIT_IMPORTS.has(specifier)) return false;
      continue;
    }
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
    return importsOf(source).some((specifier) => specifier === 'bun:test' || specifier === 'node:test');
  } catch {
    return false;
  }
}

function testFilesAreSmall(args: readonly string[], cwd: string, root: string): boolean {
  let directory = cwd;
  const files: string[] = [];
  const selectors = new Set(['-t', '--test-name-pattern']);
  const preloadOptions = new Set(['--preload', '--require', '--import', '-r']);
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
        if (value === undefined || value.length === 0) return false;
        if (!inlineValue) index += 1;
        if (preloadOptions.has(option)) return false;
      } else {
        return false;
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
  if (hasOpaqueTestRuntimeConfiguration(root, directory)) return false;
  const seen = new Set<string>();
  return files.every((file) => hasExplicitTestHarness(file) && smallUnitFile(root, file, seen));
}

function classifyCommand(argv: readonly string[], cwd: string, root: string, depth = 0): CheckPlacement {
  if (argv.length === 0 || depth > 4) return { placement: 'remote', reason: 'unknown command' };
  try {
    if (lifecycleSpecFromArgv(argv)) return { placement: 'remote', reason: 'bounded held-child lifecycle probe' };
  } catch {
    return { placement: 'remote', reason: 'invalid held-child lifecycle probe' };
  }
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
      if (isPureRootTypecheck(directory, script, source)) return { placement: 'local', reason: 'root typecheck' };
      if (isPureWebTypecheck(directory, script, source)) return { placement: 'local', reason: 'web typecheck' };
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

function refusal(reason: CheckHostRecognitionReason): CheckHostRecognitionDisposition {
  return { outcome: 'refused', reason };
}

function insidePath(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || !(child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child));
}

function parseSupervisorStat(
  contents: string,
  expectedPid: number,
): { state: string; group: number; started: string } | null {
  const close = contents.lastIndexOf(')');
  if (close < 0 || !new RegExp(`^${expectedPid} \\(`).test(contents)) return null;
  const fields = contents
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  if (fields.length <= 19 || !/^\d+$/.test(fields[2]!) || !/^\d+$/.test(fields[19]!)) return null;
  const group = Number(fields[2]);
  if (!Number.isSafeInteger(group) || group < 1) return null;
  return { state: fields[0]!, group, started: fields[19]! };
}

/**
 * Return a bounded, predicate-specific disposition for the physical run handoff. The injectable reader is a
 * read-only seam for inert tests; runtime callers use the fixed filesystem/proc/uid reader and cannot supply identities.
 */
export function recognizeCheckHostRun(
  cwd: string,
  reader: CheckHostRecognitionReader = hostRecognitionReader,
): CheckHostRecognitionDisposition {
  try {
    if (!isAbsolute(cwd)) return refusal('cwd-not-absolute');
    const absolute = resolve(cwd);
    const inside = relative(CHECK_HOST_RUNS_ROOT, absolute);
    if (!insidePath(CHECK_HOST_RUNS_ROOT, absolute) || inside === '') return refusal('cwd-outside-runs');
    const runId = inside.split(sep)[0] ?? '';
    if (!new RegExp(CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.runIdPattern).test(runId)) return refusal('run-id-invalid');
    const runDirectory = join(CHECK_HOST_RUNS_ROOT, runId);
    if (!insidePath(runDirectory, absolute)) return refusal('cwd-not-confined');

    const runs = reader.inspect(CHECK_HOST_RUNS_ROOT);
    if (runs.status !== 'ok') return refusal('runs-root-unavailable');
    if (runs.kind !== 'directory') return refusal('runs-root-not-directory');
    const run = reader.inspect(runDirectory);
    if (run.status !== 'ok') return refusal('run-directory-unavailable');
    const expectedRunPath = join(runs.realPath, runId);
    if (run.kind !== 'directory' || !insidePath(runs.realPath, run.realPath) || run.realPath !== expectedRunPath)
      return refusal('run-directory-not-physical');

    const current = reader.inspect(absolute);
    if (current.status !== 'ok') return refusal('cwd-unavailable');
    if (current.kind !== 'directory') return refusal('cwd-unavailable');
    if (!insidePath(run.realPath, current.realPath)) return refusal('cwd-not-confined');

    const cgroup = reader.read('/proc/self/cgroup', MAX_CHECK_HOST_PROC_BYTES);
    if (cgroup.status === 'missing' || cgroup.status === 'unavailable') return refusal('cgroup-unavailable');
    if (cgroup.status !== 'ok') return refusal('cgroup-invalid');
    const entries = cgroup.text.split(/\r?\n/).filter((line) => line.startsWith('0::'));
    if (entries.length !== 1) return refusal('cgroup-invalid');
    const cgroupMatch = /^0::\/(.+)$/.exec(entries[0]!);
    if (!cgroupMatch) return refusal('cgroup-invalid');
    const cgroupComponents = cgroupMatch[1]!.split('/');
    if (cgroupComponents.some((component) => !component || component === '.' || component === '..'))
      return refusal('cgroup-invalid');
    const scope = checkHostScopeUnitName(runId);
    const slice = checkHostRunSliceUnitName(runId);
    if (
      cgroupComponents.filter((component) => component === scope).length !== 1 ||
      cgroupComponents.filter((component) => component === slice).length !== 1
    )
      return refusal('scope-mismatch');

    const markerPath = join(runDirectory, CHECK_HOST_SUPERVISOR_MARKER);
    const marker = reader.read(markerPath, MAX_CHECK_HOST_MARKER_BYTES);
    if (marker.status === 'missing') return refusal('supervisor-marker-missing');
    if (marker.status === 'unavailable') return refusal('supervisor-marker-unavailable');
    if (marker.status === 'symlink' || marker.status === 'not-regular') return refusal('supervisor-marker-not-regular');
    if (marker.status === 'too-large' || (marker.status === 'ok' && marker.size > MAX_CHECK_HOST_MARKER_BYTES))
      return refusal('supervisor-marker-oversized');
    if (marker.status !== 'ok') return refusal('supervisor-marker-unavailable');

    let owner: Record<string, unknown>;
    try {
      owner = JSON.parse(marker.text) as Record<string, unknown>;
    } catch {
      return refusal('supervisor-marker-invalid');
    }
    if (
      !owner ||
      typeof owner !== 'object' ||
      Array.isArray(owner) ||
      Object.keys(owner).sort().join(',') !== [...CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.fields].sort().join(',') ||
      !Number.isSafeInteger(owner.schema) ||
      owner.schema !== CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.version ||
      typeof owner.host !== 'string' ||
      typeof owner.run !== 'string' ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) < 2 ||
      (owner.pid as number) > CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.maxPid ||
      typeof owner.started !== 'string' ||
      !new RegExp(`^\\d{1,${CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.maxStartDigits}}$`).test(owner.started) ||
      !Number.isSafeInteger(owner.group) ||
      (owner.group as number) < 1 ||
      !Number.isSafeInteger(owner.uid) ||
      (owner.uid as number) < 0 ||
      (owner.uid as number) > CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.maxPid
    )
      return refusal('supervisor-marker-invalid');
    if (!(CHECK_HOST_SUPERVISOR_MARKER_SCHEMA.hosts as readonly string[]).includes(owner.host))
      return refusal('supervisor-host-invalid');
    if (owner.run !== runId) return refusal('supervisor-run-mismatch');
    let uid: number;
    try {
      uid = reader.uid();
    } catch {
      return refusal('evidence-unavailable');
    }
    if (!Number.isSafeInteger(uid) || uid < 0) return refusal('evidence-unavailable');
    if (owner.uid !== uid) return refusal('supervisor-uid-mismatch');
    if (owner.group !== owner.pid) return refusal('supervisor-group-mismatch');

    const processStat = reader.read(`/proc/${owner.pid}/stat`, MAX_CHECK_HOST_PROC_BYTES);
    if (processStat.status === 'missing' || processStat.status === 'unavailable')
      return refusal('supervisor-stat-unavailable');
    if (processStat.status !== 'ok') return refusal('supervisor-stat-invalid');
    const supervisor = parseSupervisorStat(processStat.text, owner.pid as number);
    if (!supervisor) return refusal('supervisor-stat-invalid');
    if (supervisor.state === 'Z' || supervisor.state === 'X' || supervisor.state === 'x')
      return refusal('supervisor-not-live');
    if (!'RSDTtWIKP'.includes(supervisor.state)) return refusal('supervisor-state-unknown');
    if (supervisor.started !== owner.started) return refusal('supervisor-start-mismatch');
    if (supervisor.group !== owner.group) return refusal('supervisor-group-mismatch');

    return {
      outcome: 'admitted',
      runId,
      scope: checkHostScopeUnitName(runId),
      supervisor: { pid: owner.pid as number, started: owner.started, group: owner.group as number },
    };
  } catch {
    return refusal('evidence-unavailable');
  }
}

/** True only when the actual process is confined to a remote-check run tree; environment markers do not count. */
export function isCheckHostRun(cwd: string): boolean {
  return recognizeCheckHostRun(cwd).outcome === 'admitted';
}

/** Candidate paths get a reason-coded refusal diagnostic; this lexical test grants no physical authority. */
export function isCheckHostRunCandidate(cwd: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const inside = relative(CHECK_HOST_RUNS_ROOT, resolve(cwd));
  return insidePath(CHECK_HOST_RUNS_ROOT, resolve(cwd)) && inside !== '';
}
