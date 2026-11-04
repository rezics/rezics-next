import {
  compilerConfigArgs,
  compilerEnvironment,
  isLocalTypecheckLanding,
  placeCompilerRun,
  typecheck,
} from '../../../scripts/typecheck.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function compile(env: NodeJS.ProcessEnv): Promise<number> {
  for (const args of [
    ['bun', 'run', 'generate'],
    ['bun', 'run', 'generate:routes'],
    ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
  ]) {
    const code = await command(args, env);
    if (code !== 0) return code;
  }
  return 0;
}

async function run(args: readonly string[]): Promise<number> {
  const rootRun = args.includes('--root');
  if (
    args.some((arg) => arg !== '--root' && !arg.startsWith('--reylo-config=')) ||
    args.filter((arg) => arg === '--root').length > 1
  )
    throw new Error('Unsupported Web typecheck arguments');
  const env = compilerEnvironment(process.env, args);
  if (!rootRun)
    return await typecheck({
      root: repository,
      env,
      changedFiles: ['apps/web/scripts/typecheck.ts'],
    });

  if (!env.DATABASE_URL) {
    console.error(
      'Web typecheck unavailable: the root compiler entry requires a migrated DATABASE_URL; run "bun run typecheck" to acquire it.',
    );
    return 75;
  }
  const config = compilerConfigArgs(env, repository, [directory]);
  if (!isLocalTypecheckLanding(env)) {
    const placed = await placeCompilerRun(
      {
        label: 'web typecheck',
        root: repository,
        cwd: directory,
        command: ['bun', 'scripts/typecheck.ts', '--root', ...config],
      },
      directory,
      env,
      {},
    );
    if (placed !== null) return placed;
  }
  return await compile(env);
}

if (import.meta.main) {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    console.error(`Web typecheck infrastructure failure: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 75;
  }
}
