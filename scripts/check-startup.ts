#!/usr/bin/env bun
/** One placed run for the compiler, transport and development-stack regression selection. */
import { resolve } from 'node:path';
import {
  keepCompilerStatusAfterCleanup,
  prepareCompilerDatabase,
  retainOriginalAndCleanupFailure,
} from './compiler-database.ts';
import { stackRun } from './stack-run.ts';
import { compilerInfrastructureFailure } from './typecheck.ts';

const root = resolve(import.meta.dir, '..');

export const STARTUP_UNIT_TESTS = [
  'scripts/compiler-database.test.ts',
  'scripts/check-ssh.test.ts',
  'scripts/remote-check.test.ts',
  'scripts/remote-check-inputs.test.ts',
  'scripts/check-run-lifetime.test.ts',
  'scripts/check-run-settlement.test.ts',
  'scripts/command-phases.test.ts',
  'scripts/stack-lease.test.ts',
  'scripts/walk-stack.test.ts',
  'scripts/walk-stack-ports.test.ts',
  'scripts/worker-check.test.ts',
  'scripts/check-memory.test.ts',
  'scripts/typecheck-placement.test.ts',
  'scripts/root-typecheck-placement.test.ts',
  'scripts/check-startup.test.ts',
] as const;

export const AUTH_STARTUP_TESTS = [
  'services/auth/test/dev-stack-config.test.ts',
  'services/auth/scripts/dev-stack.test.ts',
] as const;

export type StartupCommand = { phase: string; argv: readonly string[] };

export type StartupCheckDependencies = {
  prepareCompilerDatabase?: typeof prepareCompilerDatabase;
  runCommand?: (step: StartupCommand, env: NodeJS.ProcessEnv) => Promise<number>;
};

class StartupInterrupted extends Error {
  constructor(readonly status: number) {
    super(`startup-check interrupted with status ${status}`);
  }
}

/** Frozen install publishes Go Task here; native startup must see it before any host PATH. */
export function startupPath(inheritedPath = '', repositoryRoot = root): string {
  const bin = resolve(repositoryRoot, 'node_modules/.bin');
  return inheritedPath ? `${bin}:${inheritedPath}` : bin;
}

/** The native/browser suite and the real root relation suite retain their original acceptance selections. */
export function startupCommands(acceptance: boolean): StartupCommand[] {
  return [
    {
      phase: 'transport-and-placement',
      argv: ['bun', 'test', ...STARTUP_UNIT_TESTS, ...(acceptance ? ['scripts/typecheck.test.ts'] : [])],
    },
    {
      phase: 'kernel-startup',
      argv: [
        'bun',
        'run',
        '--cwd',
        'services/kernel',
        'check',
        'test/check.test.ts',
        'test/search/subject-auto-create.test.ts',
        'test/history/native-composition.test.ts',
        'test/history/record-source-set.test.ts',
      ],
    },
    { phase: 'auth-composition', argv: ['bun', 'test', ...AUTH_STARTUP_TESTS] },
    {
      phase: 'web-programs-and-ratings',
      argv: [
        'bun',
        'apps/web/scripts/focused.ts',
        '--private-network',
        '--',
        'bun',
        'test',
        'scripts/typecheck.test.ts',
        'tests/seeded-content-ratings-reviews.test.ts',
        'tests/subject-entry-state-review.test.tsx',
      ],
    },
    ...(acceptance
      ? [
          {
            phase: 'home-native-browser',
            argv: [
              'bun',
              'services/auth/scripts/dev-stack.ts',
              'walk',
              '--',
              'bun',
              'apps/web/scripts/home-seeded-walk.ts',
            ],
          },
          {
            phase: 'vn-realm-native-browser',
            argv: [
              'bun',
              'services/auth/scripts/dev-stack.ts',
              'walk',
              '--',
              'bun',
              'apps/web/scripts/vn-realm-seeded-walk.ts',
            ],
          },
          {
            phase: 'auth-native-browser',
            argv: ['bun', 'test', 'services/auth/test/dev-stack.test.ts'],
          },
        ]
      : []),
  ];
}

async function command({ phase, argv }: StartupCommand, env: NodeJS.ProcessEnv): Promise<number> {
  console.error(`startup-check: phase=${phase} argv=${JSON.stringify(argv)}`);
  const child = Bun.spawn([...argv], {
    cwd: root,
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  // The outer check owns cancellation; forward it to this child and reap it before returning.
  let interrupted: number | undefined;
  const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      interrupted ??= 128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal];
      child.kill(signal);
    };
    process.on(signal, handler);
    return [signal, handler] as const;
  });
  try {
    const status = await child.exited;
    console.error(`startup-check: phase=${phase} status=${status}`);
    if (interrupted !== undefined) throw new StartupInterrupted(interrupted);
    return status;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

/** SQL imports in the Auth composition suite consume a real, migrated Kernel/Auth compiler database. */
async function authComposition(
  step: StartupCommand,
  env: NodeJS.ProcessEnv,
  run: (step: StartupCommand, env: NodeJS.ProcessEnv) => Promise<number>,
  prepare: typeof prepareCompilerDatabase,
): Promise<number> {
  const database = await prepare();
  let status: number | undefined;
  let failure: unknown;
  try {
    status = await run(step, { ...env, DATABASE_URL: database.url });
    return status;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await database.remove();
    } catch (error) {
      if (status === undefined) {
        throw retainOriginalAndCleanupFailure(failure ?? 'Auth composition did not complete', error, 'Startup check');
      }
      keepCompilerStatusAfterCleanup(status, error, 'Startup check', `Auth composition status ${status}`);
    }
  }
}

export async function checkStartup(
  acceptance = false,
  inherited: NodeJS.ProcessEnv = process.env,
  dependencies: StartupCheckDependencies = {},
): Promise<number> {
  let result = 0;
  const run = dependencies.runCommand ?? command;
  const prepare = dependencies.prepareCompilerDatabase ?? prepareCompilerDatabase;
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    PATH: startupPath(inherited.PATH ?? ''),
  };
  for (const step of startupCommands(acceptance)) {
    // A native checkout prepares its own persistent development DB. Compiler credentials must not override its .env.
    const nativeEnv = { ...env };
    delete nativeEnv.DATABASE_URL;
    let status: number;
    try {
      status =
        step.phase === 'auth-composition'
          ? await authComposition(step, env, run, prepare)
          : await run(step, step.phase.endsWith('-native-browser') ? nativeEnv : env);
    } catch (error) {
      if (error instanceof StartupInterrupted) return error.status;
      status = compilerInfrastructureFailure('startup-check', step.phase, error);
    }
    if (result === 0) result = status;
  }
  return result;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--acceptance') || args.length > 1)
    throw new Error('Usage: bun scripts/check-startup.ts [--acceptance]');
  process.exitCode = await stackRun(
    {
      label: 'integrated startup regressions',
      root,
      cwd: root,
      command: ['bun', 'scripts/check-startup.ts', ...args],
    },
    (leaseEnv) => checkStartup(args.includes('--acceptance'), { ...process.env, ...leaseEnv }),
  );
}
