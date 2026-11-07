import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');

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

export async function runAuthTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: CompilerPlacementDependencies & {
    typecheck?: typeof typecheck;
    prepareCompilerDatabase?: typeof prepareCompilerDatabase;
  } = {},
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  env = compilerEnvironment(env, args);
  const runCommands = dependencies.typecheck ?? typecheck;
  const config = compilerConfigArgs(env, repository, [directory]);
  const label = 'auth typecheck';
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
  const compile = (compilerEnv: NodeJS.ProcessEnv) =>
    compilerInfrastructurePhase(label, 'compiler', () => runCommands(compilerEnv));
  if (env.DATABASE_URL) return compile(env);

  // Auth imports Kernel SQL, so both schemas remain alive until this compiler exits.
  const database = await compilerInfrastructurePhase(label, 'database-setup', () =>
    (dependencies.prepareCompilerDatabase ?? prepareCompilerDatabase)(),
  );
  if (database === 75) return 75;
  let result: number;
  let failure: unknown;
  try {
    result = await runCommands({ ...env, DATABASE_URL: database.url });
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
