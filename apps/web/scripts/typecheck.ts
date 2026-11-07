import {
  compilerConfigArgs,
  compilerEnvironment,
  isLocalTypecheckLanding,
  placeCompilerRun,
  typecheck,
} from '../../../scripts/typecheck.ts';
import { withCommandPhase } from '../../../services/kernel/scripts/command-phases.ts';
import {
  prepareReyloAnalysisCache,
  type ReyloAnalysisPreparation,
} from '../../../services/kernel/scripts/reylo-cache.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repository = resolve(directory, '../..');

/** Official typecheck and the check gate compile these two programs with the same tsc guidance. */
export const WEB_COMPILER_PROGRAMS = [
  ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.json'],
  ['tsc', '--noEmit', '--runExternalCode', '-p', 'tsconfig.scripts.json'],
] as const;

/** Both programs always run; the first nonzero status is kept so a red web program cannot skip the scripts. */
export async function compileWebPrograms(run: (args: readonly string[]) => Promise<number>): Promise<number> {
  let result = 0;
  for (const args of WEB_COMPILER_PROGRAMS) {
    const code = await run(args);
    if (result === 0) result = code;
  }
  return result;
}

type WebSqlAnalysis = Pick<
  ReyloAnalysisPreparation,
  'available' | 'environment' | 'analyzedFiles' | 'totalFiles' | 'dispose'
>;

export type WebCompilerDependencies = {
  run: (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<number>;
  prepareSqlAnalysis?: (env: NodeJS.ProcessEnv) => Promise<WebSqlAnalysis>;
  write?: (chunk: string) => unknown;
};

async function timedPhase<T>(
  phase: string,
  label: string,
  env: NodeJS.ProcessEnv,
  write: (chunk: string) => unknown,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await withCommandPhase(phase, run, env);
  } finally {
    write(`Web typecheck phase ${label} finished ${((performance.now() - startedAt) / 1000).toFixed(2)}s.\n`);
  }
}

/** Prepare SQL types once, then compile both programs against the same private Reylo view. */
export async function compileWebProgramsWithSqlAnalysis(
  env: NodeJS.ProcessEnv,
  dependencies: WebCompilerDependencies,
): Promise<number> {
  const write = dependencies.write ?? ((chunk: string) => process.stdout.write(chunk));
  const prepare = dependencies.prepareSqlAnalysis ?? ((source: NodeJS.ProcessEnv) => prepareReyloAnalysisCache(source));
  const analysis = await timedPhase('web-sql-analysis', 'SQL type analysis', env, write, () => prepare(env));
  try {
    if (analysis.available)
      write(
        `Web SQL analysis cache: analyzed ${analysis.analyzedFiles}, reused ${analysis.totalFiles - analysis.analyzedFiles} of ${analysis.totalFiles} files.\n`,
      );
    const compilerEnv = { ...analysis.environment };
    if (analysis.available) delete compilerEnv.DATABASE_URL;
    return await compileWebPrograms((args) => {
      const scripts = args.at(-1) === 'tsconfig.scripts.json';
      return timedPhase(
        scripts ? 'web-tsconfig-scripts' : 'web-tsconfig',
        scripts ? 'tsconfig.scripts.json' : 'tsconfig.json',
        env,
        write,
        () => dependencies.run(args, compilerEnv),
      );
    });
  } finally {
    analysis.dispose();
  }
}

async function command(args: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = Bun.spawn([...args], {
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
  ]) {
    const code = await command(args, env);
    if (code !== 0) return code;
  }
  // Tooling imports Kernel/Auth's Node interfaces. Its owning config includes every script with Bun/Node globals;
  // the product program keeps Cloudflare Worker globals. Both retain the inherited Reylo content mapper.
  // Both programs run even when the web program has diagnostics; the scripts are never skipped by a red web program.
  return compileWebProgramsWithSqlAnalysis(env, { run: (args, compilerEnv) => command(args, compilerEnv) });
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
