import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');

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

async function typecheck(env: NodeJS.ProcessEnv): Promise<number> {
  const tsc = await command(['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
  if (tsc !== 0) return tsc;
  const constructed = await command(['bun', 'run', 'construct'], env);
  if (constructed !== 0) return constructed;
  // Declaration emission shares this compiler database; it never starts a native check.
  return process.argv.includes('--emit-client') ? command(['bun', 'scripts/client.ts'], env) : 0;
}

export async function runKernelTypecheck(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: {
    place?: typeof runOnCheckHost;
    typecheck?: typeof typecheck;
    withThrowawayDatabase?: typeof withThrowawayDatabase;
  } = {},
): Promise<number> {
  const runPlaced = dependencies.place ?? runOnCheckHost;
  const runCommands = dependencies.typecheck ?? typecheck;
  const withDatabase = dependencies.withThrowawayDatabase ?? withThrowawayDatabase;
  if (env.DATABASE_URL) return runCommands(env);

  // An unset receipt-check host setting selects the local compiler database;
  // the shared explicit placement opt-out also remains authoritative here.
  const placed =
    env.REZICS_STACK_REMOTE === 'off' || !env.KERNEL_CHECK_REMOTE
      ? null
      : await runPlaced(
          {
            label: 'kernel typecheck',
            root: repository,
            cwd: directory,
            command: ['bun', 'scripts/typecheck.ts'],
          },
          env,
        );
  if (placed !== null) return placed;

  return withDatabase((databaseEnv) => runCommands(databaseEnv));
}

if (import.meta.main) {
  try {
    process.exitCode = await runKernelTypecheck();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
