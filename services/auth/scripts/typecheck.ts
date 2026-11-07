import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCompilerDatabaseReady,
  keepCompilerStatusAfterCleanup,
  prepareCompilerDatabase,
  retainOriginalAndCleanupFailure,
} from '../../../scripts/compiler-database.ts';
import {
  compilerConfigArgs,
  compilerEnvironment,
  compilerInfrastructureFailure,
  compilerInfrastructurePhase,
  compilerPlacementResult,
  placeCompilerRun,
  type CompilerPlacementDependencies,
} from '../../../scripts/typecheck.ts';
import { withCommandPhase } from '../../kernel/scripts/command-phases.ts';
import { prepareReyloAnalysisCache, type ReyloAnalysisPreparation } from '../../kernel/scripts/reylo-cache.ts';

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');
const kernelDirectory = resolve(directory, '../kernel');
const label = 'auth typecheck';

async function typecheck(env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn(['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], {
    cwd: directory,
    env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await child.exited;
}

type AuthTypecheckDependencies = CompilerPlacementDependencies & {
  typecheck?: typeof typecheck;
  prepareCompilerDatabase?: typeof prepareCompilerDatabase;
  prepareSqlAnalysis?: (env: NodeJS.ProcessEnv) => Promise<ReyloAnalysisPreparation>;
  write?: (chunk: string) => unknown;
};

type AuthCompilerResult = { result: number; failure?: unknown };

function prepareAuthSqlAnalysis(env: NodeJS.ProcessEnv): Promise<ReyloAnalysisPreparation> {
  return prepareReyloAnalysisCache(env, {
    workspace: directory,
    sourceWorkspaces: [directory, kernelDirectory],
    seedWorkspace: kernelDirectory,
    schemaWorkspace: kernelDirectory,
  });
}

async function compileWithSqlAnalysis(
  env: NodeJS.ProcessEnv,
  runCommands: typeof typecheck,
  prepare: (env: NodeJS.ProcessEnv) => Promise<ReyloAnalysisPreparation>,
  write: (chunk: string) => unknown,
): Promise<AuthCompilerResult> {
  let analysis: ReyloAnalysisPreparation;
  try {
    analysis = await withCommandPhase('sql-analysis', () => prepare(env), env);
  } catch (error) {
    return { result: compilerInfrastructureFailure(label, 'sql-analysis', error), failure: error };
  }

  if (analysis.available) {
    write(
      `Auth SQL analysis cache: analyzed ${analysis.analyzedFiles}, reused ${analysis.totalFiles - analysis.analyzedFiles} of ${analysis.totalFiles} files.\n`,
    );
  }
  const compilerEnv = analysis.available ? { ...analysis.environment } : env;
  if (analysis.available) delete compilerEnv.DATABASE_URL;

  let result: number;
  let compilerFailure: unknown;
  try {
    result = await withCommandPhase(
      'compiler',
      () => withCommandPhase('typecheck', () => runCommands(compilerEnv), env),
      env,
    );
  } catch (error) {
    compilerFailure = error;
    result = compilerInfrastructureFailure(label, 'compiler', error);
  }
  try {
    analysis.dispose();
  } catch (error) {
    const retained = retainOriginalAndCleanupFailure(
      compilerFailure ?? `compiler status ${result}`,
      error,
      'Auth SQL analysis cleanup failed',
    );
    console.error(`${label} infrastructure failure: phase=sql-analysis-cleanup: ${retained.message}`);
  }
  return compilerFailure === undefined ? { result } : { result, failure: compilerFailure };
}

async function runCompiler(
  env: NodeJS.ProcessEnv,
  runCommands: typeof typecheck,
  prepare: (env: NodeJS.ProcessEnv) => Promise<ReyloAnalysisPreparation>,
  write: (chunk: string) => unknown,
  assertReady?: () => void | Promise<void>,
): Promise<AuthCompilerResult> {
  const ready = async (): Promise<void> => {
    if (assertReady) return await assertReady();
    const container = env.KERNEL_DATABASE_CONTAINER;
    const url = env.DATABASE_URL;
    if (container && url) {
      await withCommandPhase('database-readiness', () => assertCompilerDatabaseReady(container, url), env);
    }
  };
  const checksReadiness = Boolean(assertReady || (env.KERNEL_DATABASE_CONTAINER && env.DATABASE_URL));
  if (checksReadiness) {
    try {
      await ready();
    } catch (error) {
      return {
        result: compilerInfrastructureFailure(label, 'database-readiness', error),
        failure: error,
      };
    }
  }
  const compiled = await compileWithSqlAnalysis(env, runCommands, prepare, write);
  const result = compiled.result;
  let failure = compiled.failure;

  if (result !== 0 && checksReadiness) {
    try {
      await ready();
    } catch (error) {
      console.error(`${label} compiler database failure: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failure === undefined ? { result } : { result, failure };
}

export async function runAuthTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AuthTypecheckDependencies = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  env = compilerEnvironment(env, args);
  const runCommands = dependencies.typecheck ?? typecheck;
  const prepareSqlAnalysis = dependencies.prepareSqlAnalysis ?? prepareAuthSqlAnalysis;
  const write = dependencies.write ?? ((chunk: string) => process.stdout.write(chunk));
  const config = compilerConfigArgs(env, repository, [directory]);
  const placed = await compilerInfrastructurePhase(label, 'placement', () =>
    placeCompilerRun(
      {
        label,
        root: repository,
        cwd: directory,
        command: ['bun', 'scripts/typecheck.ts', ...config],
      },
      directory,
      env,
      dependencies,
    ),
  );
  if (placed !== null) return compilerPlacementResult(label, placed);

  if (env.DATABASE_URL) {
    return (await runCompiler(env, runCommands, prepareSqlAnalysis, write)).result;
  }

  const database = await compilerInfrastructurePhase(label, 'database-setup', () =>
    (dependencies.prepareCompilerDatabase ?? prepareCompilerDatabase)(),
  );
  if (database === 75) return 75;

  let result: number;
  let failure: unknown;
  try {
    const compilerEnv = {
      ...env,
      DATABASE_URL: database.url,
      ...(database.container === undefined ? {} : { KERNEL_DATABASE_CONTAINER: database.container }),
    };
    const compiled = await runCompiler(compilerEnv, runCommands, prepareSqlAnalysis, write, database.assertReady);
    result = compiled.result;
    failure = compiled.failure;
  } catch (error) {
    failure = error;
    result = compilerInfrastructureFailure(label, 'compiler', error);
  }
  try {
    await database.remove();
  } catch (error) {
    if (failure !== undefined) {
      return compilerInfrastructureFailure(
        label,
        'database-cleanup',
        retainOriginalAndCleanupFailure(failure, error, 'compiler execution failed'),
      );
    }
    return keepCompilerStatusAfterCleanup(result, error, label);
  }
  return result;
}

if (import.meta.main) {
  try {
    process.exit(await runAuthTypecheck());
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
