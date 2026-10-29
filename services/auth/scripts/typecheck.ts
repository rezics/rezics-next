import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCompilerDatabase } from '../../../scripts/compiler-database.ts';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';

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
  dependencies: {
    place?: typeof runOnCheckHost;
    typecheck?: typeof typecheck;
    prepareCompilerDatabase?: typeof prepareCompilerDatabase;
  } = {},
): Promise<number> {
  const runCommands = dependencies.typecheck ?? typecheck;
  if (env.DATABASE_URL) return runCommands(env);

  const placed = await (dependencies.place ?? runOnCheckHost)(
    {
      label: 'auth typecheck',
      root: repository,
      cwd: directory,
      command: ['bun', 'scripts/typecheck.ts'],
    },
    env,
  );
  if (placed !== null) return placed;

  // Use the same compiler database as Auth's check: imported kernel SQL also needs its schema.
  const database = await (dependencies.prepareCompilerDatabase ?? prepareCompilerDatabase)();
  try {
    return await runCommands({ ...env, DATABASE_URL: database.url });
  } finally {
    await database.remove();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runAuthTypecheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
