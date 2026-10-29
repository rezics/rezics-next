import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';
import { ownDatabase } from './database.ts';

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
    ownDatabase?: typeof ownDatabase;
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

  // Auth's check helper creates and migrates a separate throwaway database.
  const database = (dependencies.ownDatabase ?? ownDatabase)();
  try {
    return await runCommands({ ...env, DATABASE_URL: database.url });
  } finally {
    database.close();
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
