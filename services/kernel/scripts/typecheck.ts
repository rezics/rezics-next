import { statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCompilerDatabaseReady, keepCompilerStatusAfterCleanup } from '../../../scripts/compiler-database.ts';
import { KERNEL_CLIENT_OUTPUT, withKernelClientOutput } from '../../../scripts/check-output-tree.ts';
import { withThrowawayDatabase } from './derived.ts';
import {
  compilerConfigArgs,
  compilerEnvironment,
  compilerInfrastructureFailure,
  compilerInfrastructurePhase,
  compilerPlacementResult,
  isLocalTypecheckLanding,
  placeCompilerRun,
  reclaimAdmittedFileCache,
  type CompilerPlacementDependencies,
} from '../../../scripts/typecheck.ts';
import { schemaDumps } from './database.ts';
import { validateKernelMigrationVersions } from './migration-versions.ts';
import { prepareReyloAnalysisCache } from './reylo-cache.ts';
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
  for (const module of schemaModules(emitSchema))
    paths.push(module === 'core' ? 'services/kernel/db/schema.sql' : `services/kernel/db/${module}/schema.sql`);
  return paths;
}

function schemaModules(selection: string | undefined): string[] {
  if (selection === undefined) return [];
  return [...new Set(selection.split(','))].map((module) => {
    if (
      module !== 'core' &&
      (!/^[a-z][a-z0-9_]*$/.test(module) ||
        module === 'migrations' ||
        !isDirectory(resolve(directory, 'db', module, 'migrations')))
    )
      throw new Error(`Unknown schema module: ${module}`);
    return module;
  });
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
  prepareSqlAnalysis: typeof prepareReyloAnalysisCache = prepareReyloAnalysisCache,
  generationOnly = false,
): Promise<number> {
  const incremental = localCompilerStateArgs(env);
  const analysis = await withCommandPhase('sql-analysis', () => prepareSqlAnalysis(env), env);
  if (analysis.available)
    process.stdout.write(
      `Kernel SQL analysis cache: analyzed ${analysis.analyzedFiles}, reused ${analysis.totalFiles - analysis.analyzedFiles} of ${analysis.totalFiles} files.\n`,
    );
  const compilerEnv = analysis.available ? analysis.environment : env;
  const typecheckEnv = { ...compilerEnv };
  if (analysis.available) delete typecheckEnv.DATABASE_URL;
  reclaimAdmittedFileCache();
  let compiled: number;
  try {
    compiled = await withCommandPhase(
      'compiler',
      async () => {
        // Client-dependent tests must see declarations from the source being checked.
        // The generator checks all source modules; the full workspace checks still run before publication.
        if (emitClient) {
          // The emitter discards the caller's Reylo project and needs the compiler database directly.
          const emitted = await compilerCommand('client-emit', ['bun', 'scripts/client.ts'], compilerEnv);
          if (emitted !== 0) return emitted;
        }
        // Artifact publication checks production API roots in client.ts. Full project typing also
        // includes tests and operator scripts, and remains a separate command when generating only.
        if (!generationOnly) {
          const tsc = await withCommandPhase(
            'typecheck',
            () =>
              compilerCommand(
                'tsc',
                ['tsc', '--noEmit', ...incremental, '--runExternalCode', '-p', 'tsconfig.json'],
                typecheckEnv,
              ),
            env,
          );
          if (tsc !== 0) return tsc;
        }
        const constructed = await compilerCommand('construct', ['bun', 'run', 'construct'], compilerEnv);
        if (constructed !== 0) return constructed;
        if (emitOpenApi) {
          const contract = await compilerCommand('openapi', ['bun', 'scripts/openapi.ts'], compilerEnv);
          if (contract !== 0) return contract;
        }
        return 0;
      },
      env,
    );
  } finally {
    analysis.dispose();
  }
  if (compiled !== 0) return compiled;
  // Migration work can refresh its own snapshot using this same compiler database.
  // No additional database, native check or change to other modules' snapshots is needed.
  if (emitSchema !== undefined) {
    await withCommandPhase(
      'sql-schema',
      async () => {
        const dumps = schemaDumps(env.DATABASE_URL!, directory);
        for (const module of schemaModules(emitSchema)) {
          const path = module === 'core' ? 'db/schema.sql' : `db/${module}/schema.sql`;
          const dump = dumps[path];
          if (dump === undefined) throw new Error(`Unknown schema module: ${module}`);
          await Bun.write(resolve(directory, path), dump);
        }
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
    prepareSqlAnalysis?: typeof prepareReyloAnalysisCache;
    withThrowawayDatabase?: typeof withThrowawayDatabase;
    outputTree?: typeof withKernelClientOutput;
    assertCompilerDatabaseReady?: typeof assertCompilerDatabaseReady;
  } = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  env = compilerEnvironment(env, args);
  const emitClient = args.includes('--emit-client');
  const emitOpenApi = args.includes('--emit-openapi');
  const generationOnly = args.includes('--generate-only');
  if (generationOnly && !emitClient) throw new Error('Generation-only mode requires --emit-client');
  const emitSchema = args.find((arg) => arg.startsWith('--emit-schema='))?.slice('--emit-schema='.length);
  schemaModules(emitSchema);
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  const checkDatabaseReady = dependencies.assertCompilerDatabaseReady ?? assertCompilerDatabaseReady;
  const label = generationOnly ? 'kernel generation' : 'kernel typecheck';
  let databasePhase = 'database-setup';
  let compilerResult: number | undefined;
  const compile = async (databaseEnv: NodeJS.ProcessEnv) => {
    const compilerEnv =
      env.REYLO_CONFIG === undefined ? databaseEnv : { ...databaseEnv, REYLO_CONFIG: env.REYLO_CONFIG };
    const container = compilerEnv.KERNEL_DATABASE_CONTAINER;
    if (container && compilerEnv.DATABASE_URL) {
      process.stdout.write(`${label} database container=${container}\n`);
      const readiness = await compilerInfrastructurePhase(label, 'database-readiness', () =>
        withCommandPhase(
          'database-readiness',
          () => checkDatabaseReady(container, compilerEnv.DATABASE_URL!),
          compilerEnv,
        ),
      );
      if (readiness === 75) {
        databasePhase = 'database-cleanup';
        compilerResult = 75;
        return 75;
      }
    }
    const result = await compilerInfrastructurePhase(label, 'compiler', () =>
      runCommands(compilerEnv, emitClient, emitSchema, emitOpenApi, dependencies.prepareSqlAnalysis, generationOnly),
    );
    if (result !== 0 && container && compilerEnv.DATABASE_URL) {
      try {
        await withCommandPhase(
          'database-readiness',
          () => checkDatabaseReady(container, compilerEnv.DATABASE_URL!),
          compilerEnv,
        );
      } catch (error) {
        console.error(`${label} compiler database failure: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    databasePhase = 'database-cleanup';
    compilerResult = result;
    return result;
  };
  const config = compilerConfigArgs(env, repository, [directory]);
  const returns = returnedPaths(env, emitClient, emitSchema, emitOpenApi);
  const remoteCommand = [
    'bun',
    'scripts/typecheck.ts',
    ...(emitClient ? ['--emit-client'] : []),
    ...(emitOpenApi ? ['--emit-openapi'] : []),
    ...(generationOnly ? ['--generate-only'] : []),
    ...(emitSchema === undefined ? [] : [`--emit-schema=${emitSchema}`]),
    ...config,
  ];
  const placed = isLocalTypecheckLanding(env)
    ? null
    : await compilerInfrastructurePhase(label, 'placement', () =>
        placeCompilerRun(
          {
            label,
            root: repository,
            cwd: directory,
            command: remoteCommand,
            keepsFiles: emitClient || emitOpenApi || emitSchema !== undefined || returns === undefined,
            ...(returns === undefined ? {} : { returns }),
          },
          directory,
          env,
          dependencies,
        ),
      );
  if (placed !== null) return compilerPlacementResult(label, placed);
  writeCommandObservation(label, commandObservation(remoteCommand, repository, env), env);
  // The compiler database applies the same migrations as derived generation, in admitted custody only.
  validateKernelMigrationVersions(directory, new Date());
  // The analysis cache is prepared by typecheck itself, with its own phases, so the seam must not prepare it again.
  const run = async () => {
    if (env.DATABASE_URL) return compile(env);
    try {
      return await withDatabase(compile, { analysis: false });
    } catch (error) {
      if (databasePhase === 'database-cleanup') return keepCompilerStatusAfterCleanup(compilerResult, error, label);
      return compilerInfrastructureFailure(label, databasePhase, error);
    }
  };
  // Verify prepared source custody outside the callback so refusal happens before database and compiler work.
  return emitClient
    ? compilerInfrastructurePhase(label, 'output-publication', () =>
        (dependencies.outputTree ?? withKernelClientOutput)(repository, run, { returns: returns ?? [] }),
      )
    : run();
}

if (import.meta.main) {
  try {
    process.exit(await runKernelTypecheck());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
