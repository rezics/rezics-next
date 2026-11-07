import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const webTestSelectionContextEnvironment = 'REZICS_WEB_TEST_SELECTION_CONTEXT';

const testFile = /\.test\.[cm]?[jt]sx?$/u;
const globCharacters = /[*?{}[\]]/u;
const hostTestFile = /\.host\.test\.[cm]?[jt]sx?$/u;

const bunValueOptions = new Set([
  '--coverage-reporter',
  '--coverage-dir',
  '--env-file',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--preload',
  '--reporter',
  '--reporter-outfile',
  '--rerun-each',
  '--seed',
  '--test-name-pattern',
  '--timeout',
  '-t',
]);

const checkValueOptions = new Set(['--report', '--test-command']);

export type WebTestSelectorSource = 'repository-relative' | 'web-relative' | 'absolute';

export type WebTestSelector = {
  argumentIndex: number;
  input: string;
  source: `${WebTestSelectorSource}${'' | '-glob'}`;
  files: string[];
};

export type WebTestSelectionContext = {
  version: 1;
  source: string;
  invocationCwd: string;
  executionCwd: string;
  originalArgv: string[];
  normalizedArgv: string[];
  selectedFiles: string[];
  selectors: WebTestSelector[];
};

export type WebTestSelection = WebTestSelectionContext & { command: string[] };

export type ResolveWebTestSelectionOptions = {
  rootDirectory: string;
  appDirectory: string;
  invocationDirectory?: string;
  source: string;
  /** `bun test` selectors begin after the executable and subcommand. */
  commandKind?: 'bun-test' | 'web-check';
};

function posix(value: string): string {
  return value.split(sep).join('/');
}

function within(directory: string, path: string): boolean {
  const from = relative(resolve(directory), resolve(path));
  return from === '' || (from !== '..' && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

function testSelector(value: string): boolean {
  return testFile.test(value);
}

function isBunTest(command: string[]): boolean {
  return command[0] === 'bun' && command[1] === 'test';
}

/** Return only positional test selectors; option values and test-program arguments remain opaque. */
export function testSelectorArgumentIndices(
  command: string[],
  commandKind: ResolveWebTestSelectionOptions['commandKind'] = isBunTest(command) ? 'bun-test' : 'web-check',
): number[] {
  const indices: number[] = [];
  const first = commandKind === 'bun-test' ? 2 : 0;
  let skipNext = false;

  for (let index = first; index < command.length; index += 1) {
    const argument = command[index]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (argument === '--') break;
    if (argument.startsWith('-')) {
      const equals = argument.indexOf('=');
      const option = equals < 0 ? argument : argument.slice(0, equals);
      const optionalBailCount = option === '--bail' && /^\d+$/u.test(command[index + 1] ?? '');
      if (
        equals < 0 &&
        (bunValueOptions.has(option) ||
          optionalBailCount ||
          (commandKind === 'web-check' && checkValueOptions.has(option)))
      )
        skipNext = true;
      continue;
    }
    if (testSelector(argument)) indices.push(index);
  }

  return indices;
}

/** Maps an explicit selector without requiring the target to exist, for callers that only need path normalization. */
export function mapWebTestSelector(
  selector: string,
  appDirectory: string,
  rootDirectory = resolve(appDirectory, '../..'),
  invocationDirectory = appDirectory,
): string {
  const app = resolve(appDirectory);
  const root = resolve(rootDirectory);
  if (isAbsolute(selector)) return within(app, selector) ? posix(relative(app, resolve(selector))) || '.' : selector;

  const normalized = posix(selector).replace(/^\.\//u, '');
  const appFromRoot = posix(relative(root, app));
  if (normalized === appFromRoot) return '.';
  if (normalized.startsWith(`${appFromRoot}/`)) return normalized.slice(appFromRoot.length + 1);

  // Web test selectors are Web-relative even when the supported entrypoint is launched from the repository root.
  const invocation = resolve(invocationDirectory);
  if (within(app, invocation)) {
    const local = posix(relative(app, resolve(invocation, normalized)));
    if (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)) return local;
  }
  return normalized;
}

function absoluteGlob(selector: string, app: string): string {
  const normalized = resolve(selector);
  const wildcard = normalized.search(globCharacters);
  const prefix = normalized.slice(0, wildcard);
  const separator = prefix.lastIndexOf(sep);
  const directory = resolve(separator < 0 ? app : prefix.slice(0, separator) || sep);
  if (!within(app, directory)) throw new Error(`Web test selector is outside the Web workspace: ${selector}`);
  const suffix = normalized.slice(directory.length + (normalized[directory.length] === sep ? 1 : 0));
  const pattern = posix(suffix);
  const workspaceDirectory = posix(relative(app, directory));
  return [workspaceDirectory, pattern || '*'].filter(Boolean).join('/');
}

function resolvePattern(
  selector: string,
  options: ResolveWebTestSelectionOptions,
): { pattern: string; source: WebTestSelectorSource; absolute: boolean } {
  const app = resolve(options.appDirectory);
  const root = resolve(options.rootDirectory);
  const invocation = resolve(options.invocationDirectory ?? process.cwd());
  const glob = globCharacters.test(selector);

  if (isAbsolute(selector)) {
    const pattern = glob ? absoluteGlob(selector, app) : posix(relative(app, resolve(selector)));
    if (pattern === '..' || pattern.startsWith('../') || isAbsolute(pattern))
      throw new Error(`Web test selector is outside the Web workspace: ${selector}`);
    return { pattern, source: 'absolute', absolute: true };
  }

  const normalized = posix(selector).replace(/^\.\//u, '');
  const appFromRoot = posix(relative(root, app));
  if (normalized === appFromRoot || normalized.startsWith(`${appFromRoot}/`)) {
    const pattern = normalized === appFromRoot ? '.' : normalized.slice(appFromRoot.length + 1);
    return { pattern, source: 'repository-relative', absolute: false };
  }

  if (within(app, invocation)) {
    const resolved = resolve(invocation, selector);
    if (within(app, resolved)) {
      return { pattern: posix(relative(app, resolved)), source: 'web-relative', absolute: false };
    }
  }

  // From the repository root, short Web selectors such as tests/native/*.host.test.ts belong to apps/web.
  return { pattern: normalized, source: 'web-relative', absolute: false };
}

function matchingFiles(pattern: string, app: string, isGlob: boolean): string[] {
  const candidates = isGlob ? [...new Bun.Glob(pattern).scanSync({ cwd: app })] : [pattern];
  return [...new Set(candidates.map((file) => posix(file).replace(/^\.\//u, '')))]
    .filter((file) => {
      const absolute = resolve(app, file);
      return within(app, absolute) && existsSync(absolute) && statSync(absolute).isFile() && testSelector(file);
    })
    .sort();
}

/** Resolves every selected Web test once, preserving non-selector tokens and expanding each glob in sorted order. */
export function resolveWebTestSelection(command: string[], options: ResolveWebTestSelectionOptions): WebTestSelection {
  const app = resolve(options.appDirectory);
  const root = resolve(options.rootDirectory);
  const invocationCwd = resolve(options.invocationDirectory ?? process.cwd());
  const commandKind = options.commandKind ?? (isBunTest(command) ? 'bun-test' : 'web-check');
  const indices = testSelectorArgumentIndices(command, commandKind);
  const indexSet = new Set(indices);
  const replacements = new Map<number, string[]>();
  const selectors: WebTestSelector[] = [];
  const selected = new Set<string>();

  for (const argumentIndex of indices) {
    const input = command[argumentIndex]!;
    const glob = globCharacters.test(input);
    const resolved = resolvePattern(input, {
      ...options,
      rootDirectory: root,
      appDirectory: app,
      invocationDirectory: invocationCwd,
    });
    const matches = matchingFiles(resolved.pattern, app, glob);
    if (matches.length === 0) {
      throw new Error(
        `Web test selector matched no files: ${JSON.stringify(input)}; invocation cwd=${invocationCwd}; execution cwd=${app}; argv=${JSON.stringify(command)}`,
      );
    }
    const files = matches.filter((file) => {
      if (selected.has(file)) return false;
      selected.add(file);
      return true;
    });
    replacements.set(argumentIndex, files);
    const source: WebTestSelector['source'] =
      resolved.source === 'absolute'
        ? glob
          ? 'absolute-glob'
          : 'absolute'
        : resolved.source === 'repository-relative'
          ? glob
            ? 'repository-relative-glob'
            : 'repository-relative'
          : glob
            ? 'web-relative-glob'
            : 'web-relative';
    selectors.push({
      argumentIndex,
      input,
      source,
      files,
    });
  }

  const normalized: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    if (indexSet.has(index)) normalized.push(...(replacements.get(index) ?? []));
    else normalized.push(command[index]!);
  }

  return {
    version: 1,
    source: options.source,
    invocationCwd,
    executionCwd: app,
    originalArgv: command.slice(),
    normalizedArgv: normalized,
    selectedFiles: [...selected],
    selectors,
    command: normalized,
  };
}

/** Reuses the original selection trace when a placed command is re-entered on its owning check host. */
export function readWebTestSelectionContext(
  environment: NodeJS.ProcessEnv = process.env,
): WebTestSelectionContext | undefined {
  const encoded = environment[webTestSelectionContextEnvironment];
  if (!encoded) return undefined;
  const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  const isStringArray = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.every((item) => typeof item === 'string');
  const isSelectorArray = (candidate: unknown): candidate is WebTestSelector[] =>
    Array.isArray(candidate) &&
    candidate.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        Number.isSafeInteger((item as { argumentIndex?: unknown }).argumentIndex) &&
        typeof (item as { input?: unknown }).input === 'string' &&
        typeof (item as { source?: unknown }).source === 'string' &&
        isStringArray((item as { files?: unknown }).files),
    );
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { source?: unknown }).source !== 'string' ||
    typeof (value as { invocationCwd?: unknown }).invocationCwd !== 'string' ||
    typeof (value as { executionCwd?: unknown }).executionCwd !== 'string' ||
    !isStringArray((value as { originalArgv?: unknown }).originalArgv) ||
    !isStringArray((value as { normalizedArgv?: unknown }).normalizedArgv) ||
    !isStringArray((value as { selectedFiles?: unknown }).selectedFiles) ||
    !isSelectorArray((value as { selectors?: unknown }).selectors)
  )
    throw new Error(`Invalid ${webTestSelectionContextEnvironment} value`);
  return value as WebTestSelectionContext;
}

export function writeWebTestSelectionContext(
  context: WebTestSelectionContext,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    [webTestSelectionContextEnvironment]: Buffer.from(JSON.stringify(context)).toString('base64url'),
  };
}

export function selectedWebTestFiles(
  command: string[],
  selection?: WebTestSelectionContext,
  commandKind: ResolveWebTestSelectionOptions['commandKind'] = isBunTest(command) ? 'bun-test' : 'web-check',
): string[] {
  if (selection) return selection.selectedFiles.slice();
  return testSelectorArgumentIndices(command, commandKind).map((index) => command[index]!);
}

/** Preserve Bun options and operands when one selected file moves to another owning execution lane. */
export function testCommandOptions(command: string[]): string[] {
  if (!isBunTest(command)) return [];
  const selectors = new Set(testSelectorArgumentIndices(command, 'bun-test'));
  return command.filter((_argument, index) => index >= 2 && !selectors.has(index));
}

/** Keep every flag and operand in place while retaining only the requested selector files. */
export function testCommandForFiles(
  command: string[],
  files: string[],
  commandKind: ResolveWebTestSelectionOptions['commandKind'] = isBunTest(command) ? 'bun-test' : 'web-check',
): string[] {
  const fileSet = new Set(files);
  const indices = new Set(testSelectorArgumentIndices(command, commandKind));
  return command.filter((argument, index) => !indices.has(index) || fileSet.has(argument));
}

export function isWebHostTestFile(file: string): boolean {
  return hostTestFile.test(file);
}

export function hasWebHostTestSelector(command: string[]): boolean {
  return testSelectorArgumentIndices(command).some((index) => isWebHostTestFile(command[index]!));
}

/** Explicit host selectors override bunfig's ordinary host-file exclusion. */
export function admitWebHostTestCommand(command: string[]): string[] {
  if (!isBunTest(command) || !hasWebHostTestSelector(command)) return command;
  if (
    command.some((argument) => argument === '--path-ignore-patterns' || argument.startsWith('--path-ignore-patterns='))
  )
    return command;
  return ['bun', 'test', '--path-ignore-patterns=node_modules/**', ...command.slice(2)];
}

/** Insert discovered tests before the `--` test-program argument boundary. */
export function appendTestFiles(command: string[], files: string[]): string[] {
  const separator = command.indexOf('--');
  const index = separator < 0 ? command.length : separator;
  return [...command.slice(0, index), ...files, ...command.slice(index)];
}
