import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';
import { schemaDumps, validateMigrationVersions } from './database.ts';

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');

function workspacePath(path: string): string | undefined {
  const relativePath = relative(repository, path);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || relativePath === '')
    return undefined;
  return relativePath.split(sep).join('/');
}

function returnedPaths(
  env: NodeJS.ProcessEnv,
  emitClient: boolean,
  emitSchema: string | undefined,
): string[] | undefined {
  // Client declarations are a complete import tree, larger than the bounded return
  // contract. Leave returns undefined so StackRun retains every emitted file locally,
  // including the selected schema when both emission modes are requested.
  if (emitClient) return undefined;

  // Keep external Reylo projects local: their configuration and retained analyses are
  // outside the workspace-relative placement contract, even though we do not return them.
  const projectDirectory = env.REYLO_CONFIG ? dirname(resolve(directory, env.REYLO_CONFIG)) : directory;
  if (workspacePath(resolve(projectDirectory, '.reylo')) === undefined) return undefined;

  // tsc, construct and optional client emission consume the compiler's `.reylo/`
  // analyses before placement returns. The caller consumes only their status and
  // requested generated outputs. Release analyses are generated separately by analyse.ts;
  // returning this cache would recursively include entries from unrelated databases/runs.
  const paths: string[] = [];
  if (emitSchema === 'core') paths.push('services/kernel/db/schema.sql');
  if (
    emitSchema !== undefined &&
    /^[a-z][a-z0-9_]*$/.test(emitSchema) &&
    emitSchema !== 'migrations' &&
    isDirectory(resolve(directory, 'db', emitSchema, 'migrations'))
  ) {
    const schema = workspacePath(resolve(directory, 'db', emitSchema, 'schema.sql'));
    if (schema !== undefined) paths.push(schema);
  }
  return paths;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function command(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(args, {
    cwd: directory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

async function typecheck(env: NodeJS.ProcessEnv, emitClient: boolean, emitSchema?: string): Promise<number> {
  const tsc = await command(['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
  if (tsc !== 0) return tsc;
  const constructed = await command(['bun', 'run', 'construct'], env);
  if (constructed !== 0) return constructed;
  // Migration work can refresh its own snapshot using this same compiler database.
  // No additional database, native check or change to other modules' snapshots is needed.
  if (emitSchema !== undefined) {
    const path = emitSchema === 'core' ? 'db/schema.sql' : `db/${emitSchema}/schema.sql`;
    const dump = schemaDumps(env.DATABASE_URL!, directory)[path];
    if (dump === undefined) throw new Error(`Unknown schema module: ${emitSchema}`);
    await Bun.write(resolve(directory, path), dump);
  }
  // Declaration emission shares this compiler database; it never starts a native check.
  return emitClient ? command(['bun', 'scripts/client.ts'], env) : 0;
}

export async function runKernelTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    place?: typeof runOnCheckHost;
    typecheck?: typeof typecheck;
    withThrowawayDatabase?: typeof withThrowawayDatabase;
  } = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  // The compiler database applies the same migrations as derived generation.
  validateMigrationVersions(
    Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory })),
    new Date(),
  );
  const emitClient = args.includes('--emit-client');
  const emitSchema = args.find((arg) => arg.startsWith('--emit-schema='))?.slice('--emit-schema='.length);
  const runPlaced = dependencies.place ?? runOnCheckHost;
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  const compile = (databaseEnv: NodeJS.ProcessEnv) =>
    emitSchema === undefined ? runCommands(databaseEnv, emitClient) : runCommands(databaseEnv, emitClient, emitSchema);
  if (env.DATABASE_URL) return compile(env);

  // Preserve default host discovery unless the caller explicitly opts out.
  const returns = returnedPaths(env, emitClient, emitSchema);
  const placed =
    !env.GOAL_TASK_ID && env.REZICS_STACK_REMOTE === 'off'
      ? null
      : await runPlaced(
          {
            label: 'kernel typecheck',
            root: repository,
            cwd: directory,
            command: [
              'bun',
              'scripts/typecheck.ts',
              ...(emitClient ? ['--emit-client'] : []),
              ...(emitSchema === undefined ? [] : [`--emit-schema=${emitSchema}`]),
            ],
            keepsFiles: emitClient || emitSchema !== undefined || returns === undefined,
            ...(returns === undefined ? {} : { returns }),
          },
          env,
        );
  if (placed !== null) return placed;

  return withDatabase(compile);
}

if (import.meta.main) {
  try {
    process.exitCode = await runKernelTypecheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
