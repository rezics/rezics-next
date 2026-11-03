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
};

type Workspace = { name: string; directory: string; command: string[]; hasCheck: boolean };
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
    const { name, scripts } = (await Bun.file(join(root, manifest)).json()) as {
      name?: string;
      scripts?: Record<string, string>;
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
    });
  }
  return workspaces;
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

async function runWorkspaces(root: string, env: NodeJS.ProcessEnv, write: (chunk: string) => void): Promise<number> {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const childEnv = environmentWith(env, databaseUrl);
  const workspaces = await loadWorkspaces(root);
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
  const run = (env: NodeJS.ProcessEnv): Promise<number> => runWorkspaces(root, env, write);
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
