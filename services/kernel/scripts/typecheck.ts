import { KERNEL_CLIENT_OUTPUT, withKernelClientOutput } from '../../../scripts/check-output-tree.ts';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import {
  compilerConfigArgs,
  compilerEnvironment,
  placeCompilerRun,
  type CompilerPlacementDependencies,
} from '../../../scripts/typecheck.ts';
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
  // External projects cannot be represented by the workspace-relative placement contract.
  const projectDirectory = env.REYLO_CONFIG ? dirname(resolve(directory, env.REYLO_CONFIG)) : directory;
  if (workspacePath(resolve(projectDirectory, '.reylo')) === undefined) return undefined;

  // tsc, construct and optional client emission consume the compiler's `.reylo/`
  // analyses before placement returns. The caller consumes only their status and
  // requested generated outputs. Release analyses are generated separately by analyse.ts;
  // returning this cache would recursively include entries from unrelated databases/runs.
  const paths: string[] = emitClient ? [KERNEL_CLIENT_OUTPUT.transport] : [];
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

async function typecheck(
  env: NodeJS.ProcessEnv,
  emitClient: boolean,
  emitSchema?: string,
  emitClientOnly = false,
): Promise<number> {
  if (!emitClientOnly) {
    const tsc = await command(['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
    if (tsc !== 0) return tsc;
  }
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
  dependencies: CompilerPlacementDependencies & {
    typecheck?: typeof typecheck;
    withThrowawayDatabase?: typeof withThrowawayDatabase;
    outputTree?: typeof withKernelClientOutput;
  } = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  env = compilerEnvironment(env, args);
  const emitClient = args.includes('--emit-client');
  const emitClientOnly = args.includes('--emit-client-only');
  const generateClient = emitClient || emitClientOnly;
  const emitSchema = args.find((arg) => arg.startsWith('--emit-schema='))?.slice('--emit-schema='.length);
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  const compile = (databaseEnv: NodeJS.ProcessEnv) => {
    const compilerEnv =
      env.REYLO_CONFIG === undefined ? databaseEnv : { ...databaseEnv, REYLO_CONFIG: env.REYLO_CONFIG };
    return emitSchema === undefined
      ? runCommands(compilerEnv, generateClient, undefined, emitClientOnly)
      : runCommands(compilerEnv, generateClient, emitSchema, emitClientOnly);
  };
  const config = compilerConfigArgs(env, repository, [directory]);
  const returns = returnedPaths(env, generateClient, emitSchema);
  const placed = await placeCompilerRun(
    {
      label: 'kernel typecheck',
      root: repository,
      cwd: directory,
      command: [
        'bun',
        'scripts/typecheck.ts',
        ...(emitClientOnly ? ['--emit-client-only'] : emitClient ? ['--emit-client'] : []),
        ...(emitSchema === undefined ? [] : [`--emit-schema=${emitSchema}`]),
        ...config,
      ],
      keepsFiles: generateClient || emitSchema !== undefined || returns === undefined,
      ...(returns === undefined ? {} : { returns }),
    },
    directory,
    env,
    dependencies,
  );
  if (placed !== null) return placed;
  // The compiler database applies the same migrations as derived generation, in admitted custody only.
  validateMigrationVersions(
    Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory })),
    new Date(),
  );
  const run = () => (env.DATABASE_URL ? compile(env) : withDatabase(compile));
  return generateClient
    ? (dependencies.outputTree ?? withKernelClientOutput)(repository, run, { returns: returns ?? [] })
    : run();
}

if (import.meta.main) {
  try {
    process.exitCode = await runKernelTypecheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
