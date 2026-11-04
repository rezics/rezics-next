import { KERNEL_CLIENT_OUTPUT, withKernelClientOutput } from '../../../scripts/check-output-tree.ts';
import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import {
  compilerConfigArgs,
  compilerEnvironment,
  isLocalTypecheckLanding,
  placeCompilerRun,
  type CompilerPlacementDependencies,
} from '../../../scripts/typecheck.ts';
import { schemaDumps, validateMigrationVersions } from './database.ts';
import { withCommandPhase, writeCommandObservation, commandObservation } from './command-phases.ts';

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
  emitOpenApi: boolean,
): string[] | undefined {
  // External projects cannot be represented by the workspace-relative placement contract.
  const projectDirectory = env.REYLO_CONFIG ? dirname(resolve(directory, env.REYLO_CONFIG)) : directory;
  if (workspacePath(resolve(projectDirectory, '.reylo')) === undefined) return undefined;

  // tsc, construct and optional client emission consume the compiler's `.reylo/`
  // analyses before placement returns. The caller consumes only their status and
  // requested generated outputs. Release analyses are generated separately by analyse.ts;
  // returning this cache would recursively include entries from unrelated databases/runs.
  const paths: string[] = emitClient ? [KERNEL_CLIENT_OUTPUT.transport] : [];
  if (emitOpenApi) paths.push('contracts/openapi.json');
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

async function compilerCommand(phase: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return withCommandPhase(phase, () => command(args, env), env);
}

async function typecheck(
  env: NodeJS.ProcessEnv,
  emitClient: boolean,
  emitSchema?: string,
  emitOpenApi = false,
): Promise<number> {
  const incremental = localCompilerStateArgs(env);
  const compiled = await withCommandPhase(
    'compiler',
    async () => {
      // Client-dependent tests must see declarations from the source being checked.
      // The generator checks all source modules; the full workspace checks still run before publication.
      if (emitClient) {
        const emitted = await compilerCommand('client-emit', ['bun', 'scripts/client.ts'], env);
        if (emitted !== 0) return emitted;
      }
      const tsc = await compilerCommand(
        'tsc',
        ['tsc', '--noEmit', ...incremental, '--runExternalCode', '-p', 'tsconfig.json'],
        env,
      );
      if (tsc !== 0) return tsc;
      const constructed = await compilerCommand('construct', ['bun', 'run', 'construct'], env);
      if (constructed !== 0) return constructed;
      if (emitOpenApi) {
        const contract = await compilerCommand('openapi', ['bun', 'scripts/openapi.ts'], env);
        if (contract !== 0) return contract;
      }
      return 0;
    },
    env,
  );
  if (compiled !== 0) return compiled;
  // Migration work can refresh its own snapshot using this same compiler database.
  // No additional database, native check or change to other modules' snapshots is needed.
  if (emitSchema !== undefined) {
    await withCommandPhase(
      'sql-schema',
      async () => {
        const path = emitSchema === 'core' ? 'db/schema.sql' : `db/${emitSchema}/schema.sql`;
        const dump = schemaDumps(env.DATABASE_URL!, directory)[path];
        if (dump === undefined) throw new Error(`Unknown schema module: ${emitSchema}`);
        await Bun.write(resolve(directory, path), dump);
      },
      env,
    );
  }
  return 0;
}

function localCompilerStateArgs(env: NodeJS.ProcessEnv): string[] {
  if (!isLocalTypecheckLanding(env)) return [];
  const file = env.TYPECHECK_BUILD_INFO_FILE;
  const allowed = `${resolve(repository, '.temp/typecheck/compiler-state/runs')}${sep}`;
  const stateFile = file ? resolve(file) : '';
  if (!stateFile.startsWith(allowed)) throw new Error('Local landing typecheck has no safe compiler state file');
  return ['--incremental', '--tsBuildInfoFile', stateFile];
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
  const emitOpenApi = args.includes('--emit-openapi');
  const emitSchema = args.find((arg) => arg.startsWith('--emit-schema='))?.slice('--emit-schema='.length);
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  const compile = (databaseEnv: NodeJS.ProcessEnv) => {
    const compilerEnv =
      env.REYLO_CONFIG === undefined ? databaseEnv : { ...databaseEnv, REYLO_CONFIG: env.REYLO_CONFIG };
    return emitSchema === undefined
      ? runCommands(compilerEnv, emitClient, undefined, emitOpenApi)
      : runCommands(compilerEnv, emitClient, emitSchema, emitOpenApi);
  };
  const config = compilerConfigArgs(env, repository, [directory]);
  const returns = returnedPaths(env, emitClient, emitSchema, emitOpenApi);
  const remoteCommand = [
    'bun',
    'scripts/typecheck.ts',
    ...(emitClient ? ['--emit-client'] : []),
    ...(emitOpenApi ? ['--emit-openapi'] : []),
    ...(emitSchema === undefined ? [] : [`--emit-schema=${emitSchema}`]),
    ...config,
  ];
  const placed = isLocalTypecheckLanding(env)
    ? null
    : await placeCompilerRun(
    {
      label: 'kernel typecheck',
      root: repository,
      cwd: directory,
      command: remoteCommand,
      keepsFiles: emitClient || emitOpenApi || emitSchema !== undefined || returns === undefined,
      ...(returns === undefined ? {} : { returns }),
    },
    directory,
    env,
    dependencies,
      );
  if (placed !== null) return placed;
  writeCommandObservation('kernel typecheck', commandObservation(remoteCommand, repository, env), env);
  // The compiler database applies the same migrations as derived generation, in admitted custody only.
  validateMigrationVersions(
    Array.from(new Bun.Glob('db/**/migrations/*.sql').scanSync({ cwd: directory })),
    new Date(),
  );
  const run = () => (env.DATABASE_URL ? compile(env) : withDatabase(compile));
  return emitClient
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
