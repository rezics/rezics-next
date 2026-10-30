import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withThrowawayDatabase } from './derived.ts';
import { runOnCheckHost } from '../../../scripts/stack-run.ts';
import { schemaDumps, validateMigrationVersions } from './database.ts';

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

async function typecheck(env: NodeJS.ProcessEnv, emitClient: boolean, emitSchema?: string): Promise<number> {
  const tsc = await command(['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'], env);
  if (tsc !== 0) return tsc;
  const constructed = await command(['bun', 'run', 'construct'], env);
  if (constructed !== 0) return constructed;
  // Migration work can refresh its own snapshot using this same compiler database.
  // No additional database, native check or change to other modules' snapshots is needed.
  if (emitSchema !== undefined) {
    const path = `db/${emitSchema}/schema.sql`;
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
  const placed =
    env.REZICS_STACK_REMOTE === 'off'
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
            // SQL compilation retains the local Reylo query cache. Placement's
            // existing file-retention rule keeps this compiler-only run here.
            keepsFiles: true,
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
