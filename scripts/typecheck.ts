#!/usr/bin/env bun
// Typecheck every workspace from the repository root. One throwaway database receives the kernel and Auth
// schemas, is shared, then removed.
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBunCommand } from './gate.ts';
import { runOnCheckHost, type StackRun } from './stack-run.ts';
import { recognizeCheckHostRun } from './check-placement.ts';

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)));

export type CompilerPlacementDependencies = {
  place?: typeof runOnCheckHost;
  /** Inert tests may supply physical evidence; environment variables never supply it. */
  recognize?: typeof recognizeCheckHostRun;
};

function unavailable(label: string, reason: string): number {
  console.error(`${label} unavailable: ${reason}`);
  return 75;
}

function infrastructure(label: string, reason: string): number {
  console.error(`${label} infrastructure failure: ${reason}`);
  return 75;
}

const FULL_COMMIT = /^[0-9a-f]{40}$/;

/** The train opts in only with both immutable revisions bound to this local landing check. */
export function isLocalTypecheckLanding(env: NodeJS.ProcessEnv): boolean {
  return (
    env.TYPECHECK_LOCAL === '1' &&
    FULL_COMMIT.test(env.TYPECHECK_DEV_COMMIT ?? '') &&
    FULL_COMMIT.test(env.TYPECHECK_CANDIDATE_COMMIT ?? '')
  );
}

type CompilerState = {
  file: string;
  reused: boolean;
  base: string;
  candidate: string;
  publish: () => void;
  discard: () => void;
};

function compilerStateFingerprint(root: string): string {
  const files = new Set([
    'package.json',
    'bun.lock',
    'node_modules/typescript/package.json',
    'services/kernel/package.json',
    'services/kernel/tsconfig.json',
    'services/kernel/scripts/typecheck.ts',
    'services/auth/scripts/database.ts',
  ]);
  for (const glob of ['services/kernel/db/**/migrations/*.sql', 'services/auth/db/**/migrations/*.sql'])
    for (const file of new Bun.Glob(glob).scanSync({ cwd: root })) files.add(file);

  const hash = createHash('sha256').update(Bun.version).update('\0').update(Bun.revision);
  for (const file of [...files].sort()) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    hash.update(file).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function prepareCompilerState(
  root: string,
  workspaces: readonly Workspace[],
  env: NodeJS.ProcessEnv,
): CompilerState | undefined {
  if (
    !isLocalTypecheckLanding(env) ||
    !workspaces.some((workspace) => relative(root, workspace.directory) === 'services/kernel')
  )
    return undefined;

  const base = env.TYPECHECK_DEV_COMMIT!;
  const candidate = env.TYPECHECK_CANDIDATE_COMMIT!;
  const fingerprint = compilerStateFingerprint(root);
  const stateRoot = join(root, '.temp/typecheck/compiler-state');
  const source = join(stateRoot, base, fingerprint, 'kernel.tsbuildinfo');
  const targetDirectory = join(stateRoot, candidate, fingerprint);
  const target = join(targetDirectory, 'kernel.tsbuildinfo');
  const runs = join(stateRoot, 'runs');
  mkdirSync(runs, { recursive: true });
  const runDirectory = mkdtempSync(join(runs, `${candidate}.`));
  const file = join(runDirectory, 'kernel.tsbuildinfo');
  const reused = existsSync(source);
  if (reused) copyFileSync(source, file);

  return {
    file,
    reused,
    base,
    candidate,
    publish() {
      if (!existsSync(file)) throw new Error('TypeScript did not write incremental compiler state');
      mkdirSync(targetDirectory, { recursive: true });
      const temporary = join(targetDirectory, `.kernel.${process.pid}.tmp`);
      copyFileSync(file, temporary);
      renameSync(temporary, target);
    },
    discard() {
      rmSync(runDirectory, { recursive: true, force: true });
    },
  };
}

/** Null authorizes execution only in the physical directory of the entrypoint's own source. */
export async function placeCompilerRun(
  run: StackRun,
  physicalDirectory: string,
  env: NodeJS.ProcessEnv,
  dependencies: CompilerPlacementDependencies,
): Promise<number | null> {
  const recognition = (dependencies.recognize ?? recognizeCheckHostRun)(physicalDirectory);
  if (recognition.outcome === 'admitted') return null;
  if (env.DATABASE_URL)
    return unavailable(
      run.label,
      'an explicit DATABASE_URL requires an already admitted check-host run; its credentials cannot be relocated',
    );
  const placed = await (dependencies.place ?? runOnCheckHost)(run, env);
  // A placement dependency cannot turn an unrecognized source checkout into an admitted run.
  return placed ?? unavailable(run.label, `physical run recognition refused (${recognition.reason})`);
}

/** Only this bounded, explicit configuration input crosses relocation, as argv rather than environment copying. */
export function compilerConfigArgs(env: NodeJS.ProcessEnv, root: string, directories: readonly string[]): string[] {
  const config = env.REYLO_CONFIG;
  if (config === undefined) return [];
  if (
    !config ||
    config.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(config) ||
    config.startsWith('/') ||
    config.includes('\\')
  )
    throw new Error('Unsupported REYLO_CONFIG: expected a bounded repository-relative project path');
  for (const directory of directories) {
    const path = relative(root, resolve(directory, config));
    if (path === '..' || path.startsWith('../'))
      throw new Error('Unsupported REYLO_CONFIG: external Reylo projects cannot be relocated');
  }
  return [`--reylo-config=${config}`];
}

export function compilerEnvironment(env: NodeJS.ProcessEnv, args: readonly string[]): NodeJS.ProcessEnv {
  const configs = args.filter((arg) => arg.startsWith('--reylo-config='));
  if (configs.length > 1) throw new Error('Duplicate --reylo-config descriptor');
  return configs.length === 0 ? env : { ...env, REYLO_CONFIG: configs[0]!.slice('--reylo-config='.length) };
}

function validateSelection(value: unknown): readonly string[] | undefined {
  if (value === null) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 4096 ||
    value.some(
      (file) =>
        typeof file !== 'string' ||
        !file ||
        file.length > 4096 ||
        /[\x00-\x1f\x7f\\]/.test(file) ||
        file.startsWith('/') ||
        file.split('/').some((part) => part === '..' || part === '.'),
    )
  )
    throw new Error('Invalid typecheck selection: expected bounded workspace-relative changed files');
  return value as string[];
}

export function typecheckSelectionArgument(changedFiles: readonly string[] | undefined): string {
  validateSelection(changedFiles ?? null);
  const descriptor = JSON.stringify({ version: 1, changedFiles: changedFiles ?? null });
  if (Buffer.byteLength(descriptor) > 65_536) throw new Error('Typecheck selection descriptor exceeds 65536 bytes');
  return `--selection=${descriptor}`;
}

/** Decoding never grants placement or expands a selected path into executable code. */
export function parseTypecheckSelection(args: readonly string[]): { changedFiles?: readonly string[] } {
  const descriptors = args.filter((arg) => arg.startsWith('--selection='));
  if (
    args.some((arg) => !arg.startsWith('--selection=') && !arg.startsWith('--reylo-config=')) ||
    descriptors.length > 1
  )
    throw new Error('Unsupported or duplicate typecheck arguments');
  if (descriptors.length === 0) return {};
  const descriptor = descriptors[0]!.slice('--selection='.length);
  if (Buffer.byteLength(descriptor) > 65_536) throw new Error('Typecheck selection descriptor exceeds 65536 bytes');
  const value: unknown = JSON.parse(descriptor);
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'changedFiles,version' ||
    (value as { version: unknown }).version !== 1
  )
    throw new Error('Invalid typecheck selection descriptor');
  // An explicit all-workspace descriptor must override TYPECHECK_CHANGED at the destination.
  const changedFiles = validateSelection((value as { changedFiles: unknown }).changedFiles);
  return changedFiles === undefined ? {} : { changedFiles };
}

export type StartedDatabase = {
  url: string;
  remove: () => void | Promise<void>;
};

export type TypecheckOptions = CompilerPlacementDependencies & {
  /** Repository root. Defaults to TYPECHECK_ROOT or the current working directory. */
  root?: string;
  /** Tests inject this so they do not start Docker. The real run prepares a throwaway database with the kernel and Auth schemas. */
  startDatabase?: () => Promise<StartedDatabase>;
  stdout?: { write(chunk: string): unknown };
  /**
   * Files the change touched, relative to the root. Only the workspaces containing them and the workspaces that depend
   * on those are checked; a file outside every workspace checks all of them. Defaults to the lines of
   * TYPECHECK_CHANGED; unset checks every workspace.
   */
  changedFiles?: readonly string[];
  /** Explicit environment seam for inert composition fixtures. */
  env?: NodeJS.ProcessEnv;
};

type Workspace = {
  name: string;
  directory: string;
  command: string[];
  hasCheck: boolean;
  /** Workspace packages this one depends on. */
  dependencies: string[];
  /** Its typecheck runs external code that types `.sql` imports against the compiler database. */
  needsDatabase: boolean;
};
type WorkspaceOutcome = 'passed' | 'type-errors' | 'infrastructure' | 'execution';
type WorkspaceResult = { block: string; code: number; outcome: WorkspaceOutcome };

/** Keep workspace package scripts on the repository-pinned Bun even when the caller came from PATH. */
export function resolveTypecheckCommand(command: string[], root: string, executable = process.execPath): string[] {
  if (command[0] !== 'bun') return resolveBunCommand(command, root);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
  };
  const expected = manifest.packageManager?.startsWith('bun@') ? manifest.packageManager.slice(4) : '';
  const revision = spawnSync(join(root, 'node_modules/.bin/bun'), ['--eval', 'console.log(Bun.revision)'], {
    encoding: 'utf8',
  });
  if (revision.error || revision.status !== 0) throw revision.error ?? new Error('Could not read pinned Bun revision');
  const pinned = Bun.revision === revision.stdout.trim() ? executable : join(root, 'node_modules/.bin/bun');
  if (!expected) throw new Error('package.json packageManager must pin Bun');
  return [pinned, ...command.slice(1)];
}

function environmentWith(base: NodeJS.ProcessEnv, databaseUrl: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.DATABASE_URL = databaseUrl;
  return env;
}

async function loadWorkspaces(root: string): Promise<Workspace[]> {
  const manifests = [...new Bun.Glob('{apps,services,packages}/*/package.json').scanSync({ cwd: root })].sort();
  const workspaces: Workspace[] = [];
  for (const manifest of manifests) {
    const { name, scripts, dependencies, devDependencies, peerDependencies } = (await Bun.file(
      join(root, manifest),
    ).json()) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const script = scripts?.typecheck;
    const directory = join(root, dirname(manifest));
    workspaces.push({
      name: name ?? dirname(manifest),
      directory,
      command:
        typeof script === 'string' && script.trim() !== ''
          ? ['bun', 'run', 'typecheck']
          : [join(root, 'node_modules/.bin/tsc'), '--noEmit', '-p', 'tsconfig.json'],
      hasCheck: typeof scripts?.check === 'string' && scripts.check.trim() !== '',
      dependencies: Object.entries({ ...dependencies, ...devDependencies, ...peerDependencies })
        .filter(([, version]) => version.startsWith('workspace:'))
        .map(([dependency]) => dependency),
      needsDatabase:
        (typeof script === 'string' && script.includes('--runExternalCode')) ||
        (
          await Bun.file(join(directory, 'tsconfig.json'))
            .text()
            .catch(() => '')
        ).includes('"contentMappers"'),
    });
  }
  return workspaces;
}

/**
 * The workspaces a change can affect: each workspace containing a changed file, and every workspace that depends on
 * one of them. Markdown changes nothing a type checker reads; any other file outside every workspace (the lockfile,
 * the root package.json or tsconfig) can affect all of them.
 */
export function affectedWorkspaces<W extends { name: string; directory: string; dependencies: string[] }>(
  root: string,
  workspaces: readonly W[],
  changedFiles: readonly string[] | undefined,
): W[] {
  if (changedFiles === undefined) return [...workspaces];
  const affected = new Set<string>();
  for (const file of changedFiles) {
    if (file.endsWith('.md')) continue;
    const owner = workspaces.find((workspace) => {
      const directory = relative(root, workspace.directory);
      return file === directory || file.startsWith(`${directory}/`);
    });
    if (!owner) return [...workspaces];
    affected.add(owner.name);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const workspace of workspaces)
      if (!affected.has(workspace.name) && workspace.dependencies.some((dependency) => affected.has(dependency))) {
        affected.add(workspace.name);
        grew = true;
      }
  }
  return workspaces.filter((workspace) => affected.has(workspace.name));
}

function blockFor(
  root: string,
  workspace: Workspace,
  code: number,
  stdout: string,
  stderr: string,
  durationMs: number,
  forcedOutcome?: WorkspaceOutcome,
): WorkspaceResult {
  const output = code === 0 ? '' : [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  const hasDiagnostics = /(?:^|\n)[^\n]*\.(?:[cm]?[jt]sx?)(?:\(\d+,\d+\)|:\d+:\d+)\s*(?::|\s+-)?\s*error\b/m.test(
    output,
  );
  const outcome: WorkspaceOutcome =
    forcedOutcome ??
    (code === 0
      ? 'passed'
      : [75, 124, 130, 143].includes(code)
        ? 'infrastructure'
        : hasDiagnostics
          ? 'type-errors'
          : 'infrastructure');
  const relativeDirectory = workspace.directory.startsWith(`${root}/`)
    ? workspace.directory.slice(root.length + 1)
    : relative(root, workspace.directory);
  const block = [
    `Workspace ${workspace.name} ${outcome === 'passed' ? 'finished' : `${outcome} after`} ${(durationMs / 1000).toFixed(2)}s`,
    `$ ${workspace.command.join(' ')}  (${relativeDirectory})`,
    output,
  ]
    .filter(Boolean)
    .join('\n');
  return { block: `${block}\n\n`, code, outcome };
}

async function runWorkspace(root: string, workspace: Workspace, env: Record<string, string>): Promise<WorkspaceResult> {
  const startedAt = performance.now();
  // The root gate refuses a workspace without a check script, so promotion could not gate any commit that has one.
  if (!workspace.hasCheck)
    return blockFor(
      root,
      workspace,
      1,
      '',
      'error: package.json has no check script, which the root gate requires',
      0,
      'execution',
    );
  try {
    const child = Bun.spawn(resolveTypecheckCommand(workspace.command, root), {
      cwd: workspace.directory,
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return blockFor(root, workspace, code, stdout, stderr, performance.now() - startedAt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return blockFor(root, workspace, 75, '', message, performance.now() - startedAt, 'infrastructure');
  }
}

async function runWorkspaces(
  root: string,
  workspaces: readonly Workspace[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
  state?: CompilerState,
): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl && workspaces.some((workspace) => workspace.needsDatabase))
    throw new Error('DATABASE_URL is not set');
  const childEnv = environmentWith(env, databaseUrl ?? '');
  if (!databaseUrl) delete childEnv.DATABASE_URL;
  const failures: string[] = [];
  const results: WorkspaceResult[] = [];
  await Promise.all(
    workspaces.map(async (workspace) => {
      const workspaceEnv =
        state && relative(root, workspace.directory) === 'services/kernel'
          ? { ...childEnv, TYPECHECK_BUILD_INFO_FILE: state.file }
          : childEnv;
      const result = await runWorkspace(root, workspace, workspaceEnv);
      if (result.code === 0) write(result.block);
      else failures.push(result.block);
      results.push(result);
    }),
  );
  for (const block of failures) write(block);
  if (failures.length === 0) return 0;
  return results.some((result) => result.outcome === 'infrastructure') ? 75 : 1;
}

async function withStartedDatabase(
  startDatabase: () => Promise<StartedDatabase>,
  run: (env: NodeJS.ProcessEnv) => Promise<number>,
  env: NodeJS.ProcessEnv,
  state?: CompilerState,
): Promise<number> {
  let database: StartedDatabase;
  try {
    database = await startDatabase();
  } catch (error) {
    state?.discard();
    return infrastructure(
      'root typecheck',
      `compiler database setup could not be proven: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await database.remove();
  };
  const onSigint = (): void => {
    void remove()
      .catch((error) => {
        console.error(
          `root typecheck infrastructure failure: compiler database cleanup could not be proven: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        state?.discard();
        process.exit(130);
      });
  };
  const onSigterm = (): void => {
    void remove()
      .catch((error) => {
        console.error(
          `root typecheck infrastructure failure: compiler database cleanup could not be proven: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        state?.discard();
        process.exit(143);
      });
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  let result = 75;
  let failure: string | undefined;
  let cleanupFailure: string | undefined;
  try {
    result = await run({ ...env, DATABASE_URL: database.url });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    try {
      await remove();
    } catch (error) {
      cleanupFailure = error instanceof Error ? error.message : String(error);
    }
  }
  if (cleanupFailure) {
    state?.discard();
    return infrastructure('root typecheck', `compiler database cleanup could not be proven: ${cleanupFailure}`);
  }
  if (failure) {
    state?.discard();
    return infrastructure('root typecheck', `compiler run could not be completed: ${failure}`);
  }
  if (result === 0 && state) {
    try {
      state.publish();
    } catch (error) {
      state.discard();
      return infrastructure(
        'root typecheck',
        `incremental compiler state could not be committed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  state?.discard();
  return result;
}

/** Run every workspace typecheck. Returns 1 when any workspace fails. */
export async function typecheck(options: TypecheckOptions = {}): Promise<number> {
  const startedAt = performance.now();
  const env = options.env ?? process.env;
  const root = resolve(options.root ?? env.TYPECHECK_ROOT ?? process.cwd());
  const write = (chunk: string): void => {
    (options.stdout ?? process.stdout).write(chunk);
  };
  const changed =
    options.changedFiles ??
    (env.TYPECHECK_CHANGED === undefined ? undefined : env.TYPECHECK_CHANGED.split('\n').filter(Boolean));
  let all: Workspace[];
  try {
    all = await loadWorkspaces(root);
  } catch (error) {
    return infrastructure(
      'root typecheck',
      `workspace discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const workspaces = affectedWorkspaces(root, all, changed);
  const localLanding = env.TYPECHECK_LOCAL === '1';
  if (localLanding && !isLocalTypecheckLanding(env))
    return infrastructure('root typecheck', 'local landing placement requires full dev and candidate commit bindings');
  const finish = async (result: Promise<number>): Promise<number> => {
    const code = await result;
    const size = changed === undefined ? 'unscoped changes' : `${changed.length} changed paths`;
    write(
      `Typecheck batch completed in ${((performance.now() - startedAt) / 1000).toFixed(2)}s (${size}; ${workspaces.length} workspaces).\n`,
    );
    return code;
  };
  if (workspaces.length < all.length)
    write(`Checking ${workspaces.length} of ${all.length} workspaces the change can affect.\n`);
  if (workspaces.length === 0) {
    return finish(Promise.resolve(0));
  }
  let state: CompilerState | undefined;
  try {
    state = prepareCompilerState(root, workspaces, env);
  } catch (error) {
    return infrastructure(
      'root typecheck',
      `incremental compiler state could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (state)
    write(
      `Kernel incremental state ${state.reused ? 'reused' : 'not found'} for dev ${state.base}; candidate ${state.candidate}.\n`,
    );
  const run = (env: NodeJS.ProcessEnv): Promise<number> => runWorkspaces(root, workspaces, env, write, state);
  const completeWithoutDatabase = async (): Promise<number> => {
    const result = await run(env);
    if (result === 0 && state) {
      try {
        state.publish();
      } catch (error) {
        state.discard();
        return infrastructure(
          'root typecheck',
          `incremental compiler state could not be committed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state?.discard();
    return result;
  };
  const completeWithDatabase = async (): Promise<number> => {
    if (root !== repository && !options.startDatabase)
      return unavailable('root typecheck', 'database-backed checks require the source checkout root');
    if (options.startDatabase) return withStartedDatabase(options.startDatabase, run, env, state);
    const { prepareCompilerDatabase } = await import('./compiler-database.ts');
    return withStartedDatabase(prepareCompilerDatabase, run, env, state);
  };
  // The compiler database only serves workspaces that type .sql imports; starting it costs most of a minute.
  if (!workspaces.some((workspace) => workspace.needsDatabase)) return finish(completeWithoutDatabase());
  if (localLanding) return finish(completeWithDatabase());
  if (root !== repository && !options.place && !options.recognize)
    return unavailable('root typecheck', 'database-backed checks require the source checkout root');
  const config = compilerConfigArgs(
    env,
    root,
    workspaces.filter((w) => w.needsDatabase).map((w) => w.directory),
  );
  let placed: number | null;
  try {
    placed = await placeCompilerRun(
      {
        label: 'root typecheck',
        root,
        cwd: root,
        command: ['bun', 'scripts/typecheck.ts', typecheckSelectionArgument(changed), ...config],
        returns: [],
      },
      repository,
      env,
      options,
    );
  } catch (error) {
    return finish(
      Promise.resolve(
        infrastructure(
          'root typecheck',
          `check-host execution could not be established: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ),
    );
  }
  if (placed !== null) {
    if ([75, 124, 130, 143].includes(placed))
      return finish(
        Promise.resolve(infrastructure('root typecheck', `check-host execution ended with status ${placed}`)),
      );
    return finish(Promise.resolve(placed));
  }
  if (env.DATABASE_URL) return finish(run(env));
  return finish(completeWithDatabase());
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const env = { ...compilerEnvironment(process.env, args) };
    // The descriptor is authoritative over any unrelated destination-side environment selection.
    if (args.some((arg) => arg.startsWith('--selection='))) delete env.TYPECHECK_CHANGED;
    process.exit(await typecheck({ ...parseTypecheckSelection(args), env }));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
