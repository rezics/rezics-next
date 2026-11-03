#!/usr/bin/env bun
import { scriptPolicy, withScriptPolicy } from '../src/script-policy.ts';
import type { ControlPolicy } from '../src/policy.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { JSON5 } from 'bun';
import { CHECK_COMPATIBILITY_CONTRACT } from '../src/check-compatibility.ts';
import { runBoundedProcess, type BoundedProcessResult } from '../src/lifecycle-fixture.ts';

export type ParityOptions = { inputRoot: string; scriptsRoot: string; policy?: ControlPolicy | undefined };
type Identity = { root: string; commit: string; tree: string; status: string };
export type ParityCommand = {
  id: string;
  owner: string;
  checkout: 'input' | 'scripts';
  cwd: string;
  argv: string[];
  timeoutMs: number;
  testName?: string;
};
export type ParityBoundary = { id: string; owner: string; detail: string };
export type ParityPlan = {
  input: Identity;
  scripts: Identity;
  compatibility: { contract: string; version: number };
  commands: ParityCommand[];
  unavailable: ParityBoundary[];
  obligations: readonly string[];
  ownership: { runtime: string; environment: string; cleanup: string; deadlineMs: number };
};
export type ParityResult = {
  status: 'deferred' | 'unavailable' | 'failed';
  plan: ParityPlan;
  executions: Array<{ command: ParityCommand; cwd: string; argv: string[]; result: BoundedProcessResult }>;
  cleanup: 'not-started' | 'removed' | 'refused';
  failure?: string;
};

// These are proof obligations, not inferred capabilities or passing scenarios.
export const PARITY_OBLIGATIONS = [
  'Actual worker and selected root workspace checks execute the same candidate and selection.',
  'Auth owns nested native execution, its database lane, executable, cwd and production environment.',
  'The synced workspace supports Git history, index, status and reference lookup during execution.',
  'Concurrent native Web runtimes isolate persisted sessions and survive independent sibling cleanup.',
] as const;

const ROOT = resolve(import.meta.dir, '../../..');
const gateFixture =
  "a group's transport failure is retried once and a load-induced workspace is rerun within its group";
const authFixture =
  'placed runner preserves executable, caller cwd, production environment, reference and exact test filter';
const persistenceFixture = 'owns temporary Worker persistence per config and preserves caller and sibling paths';
const webFixture = 'isolates concurrent shared-helper and legacy Vite Worker state, sessions, and cleanup';

function within(root: string, path: string): boolean {
  const name = relative(root, path);
  return name !== '' && name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], {
    encoding: 'utf8',
    timeout: scriptPolicy().gateParity.gitTimeoutMs,
    maxBuffer: scriptPolicy().gateParity.gitBufferBytes,
  });
  if (result.status !== 0 || result.error)
    throw new Error(result.error?.message ?? result.stderr.trim() ?? 'Git identity unavailable');
  return result.stdout.trimEnd();
}

function identity(root: string): Identity {
  const canonical = realpathSync(root);
  if (realpathSync(git(canonical, 'rev-parse', '--show-toplevel')) !== canonical)
    throw new Error(`Parity root must be a checkout root: ${root}`);
  return {
    root: canonical,
    commit: git(canonical, 'rev-parse', 'HEAD'),
    tree: git(canonical, 'rev-parse', 'HEAD^{tree}'),
    status: git(canonical, 'status', '--porcelain=v1', '--untracked-files=normal'),
  };
}

function source(root: string, path: string): string | undefined {
  const file = resolve(root, path);
  try {
    if (!within(root, realpathSync(file)) || !lstatSync(file).isFile()) return undefined;
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function exportsFunction(root: string, file: string, name: string): boolean {
  const text = source(root, file);
  if (!text) return false;
  try {
    return new Bun.Transpiler({ loader: 'ts' }).scan(text).exports.includes(name);
  } catch {
    return false;
  }
}

function namesTest(root: string, file: string, name: string): boolean {
  const text = source(root, file);
  if (!text) return false;
  try {
    // Compile without evaluating producer code. Comments and type-only declarations disappear.
    // This selects evidence to execute; only the later bounded test result can validate the fixture.
    const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(text);
    return [...compiled.matchAll(/^test\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,/gm)].some(
      (match) => JSON5.parse(match[1]!) === name,
    );
  } catch {
    return false;
  }
}

/** Read-only discovery. A delivered fixture is executable evidence to collect, never a parity pass. */
export function planGateParity(options: ParityOptions): ParityPlan {
  return withScriptPolicy(options.policy ?? scriptPolicy(), () => planGateParityWithPolicy(options));
}

function planGateParityWithPolicy(options: ParityOptions): ParityPlan {
  const input = identity(resolve(options.inputRoot));
  const scripts = identity(resolve(options.scriptsRoot));
  const commands: ParityCommand[] = [];
  const unavailable: ParityBoundary[] = [];
  const missing = (id: string, owner: string, detail: string) => unavailable.push({ id, owner, detail });
  for (const [name, value] of [
    ['input', input],
    ['scripts', scripts],
  ] as const)
    if (value.status)
      missing(
        `${name}.clean-candidate`,
        'control-plane',
        'Commit candidate changes before parity; a clone cannot reproduce dirty or untracked source.',
      );

  const fixture = (id: string, owner: string, file: string, testName: string, requirements: boolean) => {
    if (!requirements || !namesTest(scripts.root, file, testName)) {
      missing(id, owner, `Delivered producer fixture or its supported exports are unavailable: ${file} :: ${testName}`);
      return;
    }
    commands.push({
      id,
      owner,
      checkout: 'scripts',
      cwd: '.',
      argv: [
        'bun',
        'test',
        '--timeout',
        String(scriptPolicy().gateParity.testTimeoutMs),
        '--test-name-pattern',
        `^${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        file,
      ],
      timeoutMs: scriptPolicy().gateParity.fixtureTimeoutMs,
      testName,
    });
  };
  const contract = CHECK_COMPATIBILITY_CONTRACT;
  if (
    source(input.root, 'tools/goal/scripts/check-compatibility.ts') &&
    source(scripts.root, contract.workerCheck.script) &&
    source(scripts.root, contract.remoteCheck.script)
  ) {
    commands.push({
      id: 'check-script-compatibility',
      owner: 'performance',
      checkout: 'input',
      cwd: '.',
      argv: ['bun', 'tools/goal/scripts/check-compatibility.ts', '--scripts-root', '<scripts-root>'],
      timeoutMs: scriptPolicy().gateParity.compatibilityTimeoutMs,
    });
  } else
    missing(
      'check-script-compatibility',
      'performance',
      `The existing ${contract.contract} consumer or delivered worker/remote scripts are unavailable.`,
    );

  // Use delivered producer fixtures; never send a speculative --workspaces flag to an older full gate.
  fixture(
    'selected-root-gate',
    'performance',
    'scripts/gate.test.ts',
    gateFixture,
    !!source(scripts.root, 'scripts/gate.ts'),
  );
  if (
    namesTest(scripts.root, 'services/auth/test/check-placement.test.ts', authFixture) &&
    exportsFunction(scripts.root, 'services/auth/scripts/check.ts', 'checkPlan') &&
    exportsFunction(scripts.root, 'services/auth/scripts/placed-tests.ts', 'runPlacedTests') &&
    exportsFunction(scripts.root, 'services/auth/scripts/database.ts', 'withTestDatabaseLane')
  ) {
    commands.push({
      id: 'auth-placement-runner',
      owner: 'auth',
      checkout: 'scripts',
      cwd: 'services/auth',
      argv: ['bun', 'scripts/check.ts', 'test/check-placement.test.ts'],
      timeoutMs: scriptPolicy().gateParity.budgetMs,
    });
  } else
    missing(
      'auth-placement-runner',
      'auth',
      'Auth checkPlan, placed runner, owned lane or its producer fixture is unavailable.',
    );
  fixture(
    'persistence-ownership',
    'web',
    'scripts/worker-persistence.test.ts',
    persistenceFixture,
    exportsFunction(scripts.root, 'scripts/worker-persistence.ts', 'createWorkerPersistence'),
  );

  // The real runtime regression must enter Web's owner command; raw bun test bypasses placement.
  if (
    namesTest(scripts.root, 'apps/web/tests/worker-persistence-isolation.test.ts', webFixture) &&
    exportsFunction(scripts.root, 'apps/web/scripts/check.ts', 'main') &&
    exportsFunction(scripts.root, 'apps/web/scripts/check.ts', 'placeBrowserCheck')
  ) {
    commands.push({
      id: 'concurrent-web-runtimes',
      owner: 'web',
      checkout: 'scripts',
      cwd: 'apps/web',
      argv: ['bun', 'scripts/check.ts', 'tests/worker-persistence-isolation.test.ts'],
      timeoutMs: scriptPolicy().gateParity.budgetMs,
    });
  } else
    missing(
      'concurrent-web-runtimes',
      'web',
      'The native concurrent persistence fixture and Web placed check command are unavailable; helper directory allocation cannot prove runtime isolation.',
    );

  // Neither the compatibility contract nor the delivered fixtures promise these end-to-end boundaries.
  // Keep them unavailable until an owner delivers an executable contract; do not invent check-git exports,
  // native lane injection, a raw database environment, or a second root gate implementation.
  missing(
    'worker-root-workspace-parity',
    'performance',
    'No delivered fixture compares the actual worker and selected root workspace commands on the same candidate; the selected-gate fixture alone is insufficient.',
  );
  missing(
    'synced-usable-git',
    'performance',
    'The remote-check contract does not promise synced Git history/index/status. workspaceFiles, when delivered, selects source files and is not a usable-Git contract.',
  );
  missing(
    'auth-native-nested-placement',
    'auth',
    'The placed runner fixture supplies a lane implementation; a genuine nested native Auth check with its owned database is still required.',
  );
  return {
    input,
    scripts,
    compatibility: { contract: contract.contract, version: contract.version },
    commands,
    unavailable,
    obligations: PARITY_OBLIGATIONS,
    ownership: {
      runtime: 'Bootstrap with the caller Bun; producer commands use the installed scripts-root contract runtime.',
      environment:
        'Inherit ordinary caller placement settings; clear database, lane, recursion and explicit persistence overrides. Own TMPDIR/TMP/TEMP and prepend the installed runtime to PATH.',
      cleanup:
        'Only detached child groups and nonce-marked clones under this consumer worktree .temp/goal are owned; native owners retain their resource cleanup.',
      deadlineMs: scriptPolicy().gateParity.budgetMs,
    },
  };
}

/** Explicit postintegration execution of delivered producer evidence, with unavailable boundaries retained. */
export async function driveGateParity(
  options: ParityOptions & { execute?: boolean; report?: (plan: ParityPlan) => void },
): Promise<ParityResult> {
  return withScriptPolicy(options.policy ?? scriptPolicy(), () => driveGateParityWithPolicy(options));
}

async function driveGateParityWithPolicy(
  options: ParityOptions & { execute?: boolean; report?: (plan: ParityPlan) => void },
): Promise<ParityResult> {
  const plan = planGateParity(options);
  options.report?.(plan); // All unavailable boundaries are reported once, before any producer executes.
  const result: ParityResult = { status: 'deferred', plan, executions: [], cleanup: 'not-started' };
  if (!options.execute) return result;
  result.status = 'unavailable';
  if (plan.unavailable.some(({ id }) => id.endsWith('.clean-candidate'))) return result;
  const base = join(ROOT, '.temp/goal');
  mkdirSync(base, { recursive: true });
  if (!within(realpathSync(ROOT), realpathSync(base))) throw new Error('Parity scratch directory escaped the worktree');
  const scratch = mkdtempSync(join(base, 'gate-parity-'));
  const token = randomUUID();
  const owner = join(scratch, '.owner');
  writeFileSync(owner, token, { flag: 'wx', mode: 0o600 });
  const deadline = Date.now() + scriptPolicy().gateParity.budgetMs;
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
  // A caller's database/lane/runtime overrides are not authority for a new owned check.
  for (const key of [
    'DATABASE_URL',
    'AUTH_TEST_DATABASE_URL',
    'AUTH_CHECK_CONTAINER',
    'AUTH_CHECK_LANE_OWNER',
    'WEB_TEST_STATE_DIR',
    'WEB_TEST_STATE_INSTANCE_DIR',
    'AUTH_TEST_STATE_INSTANCE_DIR',
    'REZICS_STACK_SLOT',
    'REZICS_STACK_LEASE',
    'KERNEL_CHECK_ON_REMOTE',
  ])
    delete environment[key];
  const run = async (argv: string[], cwd: string, timeoutMs: number) =>
    runBoundedProcess(argv[0]!, argv.slice(1), {
      cwd,
      env: environment,
      timeoutMs: Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
      policy: scriptPolicy().launchSmoke,
      outputLimit: scriptPolicy().gateParity.outputBytes,
    });
  try {
    const roots = { input: join(scratch, 'input'), scripts: join(scratch, 'scripts') };
    for (const name of ['input', 'scripts'] as const) {
      const snapshot = plan[name];
      // Never add a worktree or update refs/config in either supplied checkout.
      const argv = ['git', 'clone', '--no-hardlinks', '--no-checkout', snapshot.root, roots[name]];
      const clone = await run(argv, scratch, scriptPolicy().gateParity.cloneTimeoutMs);
      if (clone.status !== 0 || clone.timedOut || clone.error)
        throw new Error(`Parity clone failed: ${clone.error ?? clone.stderr}`);
      const checkout = await run(
        ['git', 'checkout', '--detach', snapshot.commit],
        roots[name],
        scriptPolicy().gateParity.checkoutTimeoutMs,
      );
      if (checkout.status !== 0 || checkout.timedOut || checkout.error)
        throw new Error(`Parity checkout failed: ${checkout.error ?? checkout.stderr}`);
    }
    const runtime = join(roots.scripts, CHECK_COMPATIBILITY_CONTRACT.workerCheck.bun.lookup);
    for (const root of Object.values(roots)) {
      if (!source(root, 'package.json')) continue;
      const install = await run(
        [process.execPath, 'install', '--frozen-lockfile'],
        root,
        scriptPolicy().gateParity.installTimeoutMs,
      );
      if (install.status !== 0 || install.timedOut || install.error)
        throw new Error(`Parity dependency preparation failed: ${install.error ?? install.stderr}`);
    }
    environment.PATH = `${join(roots.scripts, 'node_modules/.bin')}:${process.env.PATH ?? ''}`;
    for (const command of plan.commands) {
      if (Date.now() >= deadline) {
        result.status = 'failed';
        break;
      }
      const cwd = resolve(roots[command.checkout], command.cwd);
      const argv = command.argv.map((part) =>
        part === '<scripts-root>'
          ? roots.scripts
          : part === 'bun'
            ? source(roots.scripts, 'package.json')
              ? runtime
              : process.execPath
            : part,
      );
      const execution = await run(argv, cwd, command.timeoutMs);
      result.executions.push({ command, cwd, argv, result: execution });
      if (
        execution.status !== 0 ||
        execution.timedOut ||
        execution.error ||
        (command.testName && !/(?:^|\s)1\s+pass\b/.test(execution.stdout + execution.stderr))
      ) {
        result.status = 'failed';
        break;
      }
    }
  } catch (error) {
    result.status = 'failed';
    result.failure = String(error);
  } finally {
    // A sibling or replaced directory is never ours to delete.
    try {
      if (
        lstatSync(scratch).isSymbolicLink() ||
        realpathSync(scratch) !== scratch ||
        readFileSync(owner, 'utf8') !== token
      )
        throw new Error('Parity scratch ownership changed; refusing cleanup');
      rmSync(scratch, { recursive: true, force: false });
      result.cleanup = 'removed';
    } catch (error) {
      result.cleanup = 'refused';
      result.status = 'failed';
      result.failure ??= String(error);
    }
  }
  return result;
}

export function parseParityArguments(args: string[]): ParityOptions & { execute: boolean } {
  let inputRoot: string | undefined;
  let scriptsRoot: string | undefined;
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--execute' && !execute) execute = true;
    else if (
      (flag === '--input-root' || flag === '--scripts-root') &&
      args[index + 1] &&
      !args[index + 1]!.startsWith('--')
    ) {
      const value = resolve(args[++index]!);
      if (flag === '--input-root' && !inputRoot) inputRoot = value;
      else if (flag === '--scripts-root' && !scriptsRoot) scriptsRoot = value;
      else throw new Error(`Duplicate parity argument: ${flag}`);
    } else throw new Error(`Invalid parity argument: ${flag}`);
  }
  if (!inputRoot || !scriptsRoot)
    throw new Error('Expected --input-root <candidate> --scripts-root <delivered-dev-checkout> [--execute]');
  return { inputRoot, scriptsRoot, execute };
}

if (import.meta.main) {
  try {
    const result = await driveGateParity({
      ...parseParityArguments(process.argv.slice(2)),
      policy: (await import('../src/config.ts')).loadSettings().policy,
      report: (plan) => console.log(JSON.stringify({ phase: 'plan', ...plan })),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'failed' ? 1 : result.status === 'unavailable' ? 2 : 0;
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
