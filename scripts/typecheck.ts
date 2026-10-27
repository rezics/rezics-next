#!/usr/bin/env bun
// Typecheck every workspace from the repository root. One throwaway database receives the kernel and Auth
// schemas, is shared, then removed.
import { dirname, join, relative, resolve } from 'node:path';

export type StartedDatabase = {
  url: string;
  remove: () => void | Promise<void>;
};

export type TypecheckOptions = {
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
type WorkspaceResult = { block: string; code: number };

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
        (await Bun.file(join(directory, 'tsconfig.json')).text().catch(() => '')).includes('"contentMappers"'),
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
  for (let grew = true; grew; ) {
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
): WorkspaceResult {
  const output = code === 0 ? '' : [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
  const relativeDirectory = workspace.directory.startsWith(`${root}/`)
    ? workspace.directory.slice(root.length + 1)
    : relative(root, workspace.directory);
  const block = [
    `Workspace ${workspace.name} finished in ${(durationMs / 1000).toFixed(2)}s`,
    `$ ${workspace.command.join(' ')}  (${relativeDirectory})`,
    output,
  ]
    .filter(Boolean)
    .join('\n');
  return { block: `${block}\n\n`, code };
}

async function runWorkspace(root: string, workspace: Workspace, env: Record<string, string>): Promise<WorkspaceResult> {
  const startedAt = performance.now();
  // The root gate refuses a workspace without a check script, so promotion could not gate any commit that has one.
  if (!workspace.hasCheck)
    return blockFor(root, workspace, 1, '', 'error: package.json has no check script, which the root gate requires', 0);
  try {
    const child = Bun.spawn(workspace.command, {
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
    return blockFor(root, workspace, 1, '', message, performance.now() - startedAt);
  }
}

async function runWorkspaces(
  root: string,
  workspaces: readonly Workspace[],
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => void,
): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl && workspaces.some((workspace) => workspace.needsDatabase))
    throw new Error('DATABASE_URL is not set');
  const childEnv = environmentWith(env, databaseUrl ?? '');
  if (!databaseUrl) delete childEnv.DATABASE_URL;
  const failures: string[] = [];
  await Promise.all(
    workspaces.map(async (workspace) => {
      const result = await runWorkspace(root, workspace, childEnv);
      if (result.code === 0) write(result.block);
      else failures.push(result.block);
    }),
  );
  for (const block of failures) write(block);
  return failures.length === 0 ? 0 : 1;
}

async function withStartedDatabase(
  startDatabase: () => Promise<StartedDatabase>,
  run: (env: NodeJS.ProcessEnv) => Promise<number>,
): Promise<number> {
  const database = await startDatabase();
  let removed = false;
  const remove = async (): Promise<void> => {
    if (removed) return;
    removed = true;
    await database.remove();
  };
  const onSigint = (): void => {
    void remove().finally(() => process.exit(130));
  };
  const onSigterm = (): void => {
    void remove().finally(() => process.exit(143));
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  try {
    return await run({ ...process.env, DATABASE_URL: database.url });
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await remove();
  }
}

/** Run every workspace typecheck. Returns 1 when any workspace fails. */
export async function typecheck(options: TypecheckOptions = {}): Promise<number> {
  const root = resolve(options.root ?? process.env.TYPECHECK_ROOT ?? process.cwd());
  const write = (chunk: string): void => {
    (options.stdout ?? process.stdout).write(chunk);
  };
  const changed =
    options.changedFiles ??
    (process.env.TYPECHECK_CHANGED === undefined
      ? undefined
      : process.env.TYPECHECK_CHANGED.split('\n').filter(Boolean));
  const all = await loadWorkspaces(root);
  const workspaces = affectedWorkspaces(root, all, changed);
  if (workspaces.length < all.length)
    write(`Checking ${workspaces.length} of ${all.length} workspaces the change can affect.\n`);
  if (workspaces.length === 0) return 0;
  const run = (env: NodeJS.ProcessEnv): Promise<number> => runWorkspaces(root, workspaces, env, write);
  // The compiler database only serves workspaces that type .sql imports; starting it costs most of a minute.
  if (!workspaces.some((workspace) => workspace.needsDatabase)) return run(process.env);
  if (options.startDatabase) return withStartedDatabase(options.startDatabase, run);
  const { prepareCompilerDatabase } = await import('./compiler-database.ts');
  return withStartedDatabase(prepareCompilerDatabase, run);
}

if (import.meta.main) {
  try {
    process.exit(await typecheck());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
