import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repositoryBun } from '../../../scripts/remote-check.ts';
import { runBoundedInstallProcess } from './install-process.ts';
import type { GateRunner } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { classifyRun, infraFailure } from './dev-verifier-classification.ts';
import type { DevVerifierCheck } from './dev-verifier-plan.ts';
import type { DevVerifierEvidence, DevVerifierRun, Settings } from './types.ts';

type ExecutionSettings = Pick<Settings, 'mainCheckout' | 'stateDirectory' | 'policy'>;
export type DevVerifierExecution = {
  settings: ExecutionSettings;
  readRun: (key: string) => DevVerifierEvidence | undefined;
  saveRun: (run: DevVerifierRun) => void;
};
export type CheckExecution = Pick<DevVerifierCheck, 'command' | 'cwd'>;
export type GateOutcome = { passed: boolean; output: string; timedOut: boolean };

function installDependencies(tree: string, stateDirectory: string, policy = defaultPolicy): boolean {
  if (!existsSync(join(tree, 'package.json')) || !existsSync(join(tree, 'bun.lock'))) return true;
  const installLog = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  for (let attempt = 0; attempt < policy.verifier.installAttempts; attempt++) {
    try {
      // Bootstrap installs dependencies; official check runs resolve the candidate artifact after installation.
      const executable = process.execPath;
      appendFileSync(installLog, `$ ${executable} install --frozen-lockfile (attempt ${attempt + 1})\n`);
      const result = runBoundedInstallProcess({
        command: executable,
        args: ['install', '--frozen-lockfile'],
        cwd: tree,
        step: 'bun install --frozen-lockfile',
        purpose: 'preparation',
        policy,
      });
      appendFileSync(installLog, `${result.stdout}${result.stderr}`);
      return true;
    } catch (error) {
      appendFileSync(installLog, `${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  return false;
}

export function installDependenciesCached(
  execution: DevVerifierExecution,
  commit: string,
  tree: string,
  key: string,
): { passed: boolean; output: string; logPath: string } {
  // A previous tree's successful install cannot populate this fresh tree's node_modules.
  const { stateDirectory } = execution.settings;
  const logPrefix = 'dev-verify-install-';
  const logSuffix = '.log';
  const newLogPath = join(stateDirectory, `${logPrefix}${randomUUID()}${logSuffix}`);
  let result: { passed: boolean; output: string; logPath: string };
  if (!existsSync(join(tree, 'package.json'))) {
    result = { passed: true, output: '', logPath: newLogPath };
  } else if (!existsSync(join(tree, 'bun.lock'))) {
    result = {
      passed: false,
      output: 'Baseline dependency setup failed: bun.lock is absent.',
      logPath: newLogPath,
    };
  } else {
    const previousLogs = new Set(
      readdirSync(stateDirectory).filter((name) => name.startsWith(logPrefix) && name.endsWith(logSuffix)),
    );
    const passed = installDependencies(tree, stateDirectory, execution.settings.policy);
    const logName = readdirSync(stateDirectory).find(
      (name) => name.startsWith(logPrefix) && name.endsWith(logSuffix) && !previousLogs.has(name),
    );
    const logPath = logName ? join(stateDirectory, logName) : newLogPath;
    let output = '';
    try {
      output = readFileSync(logPath, 'utf8');
    } catch {}
    result = { passed, output, logPath };
  }
  const run: DevVerifierRun = {
    key,
    createdAt: new Date().toISOString(),
    evidence: {
      commit,
      command: ['bun', 'install', '--frozen-lockfile'],
      passed: result.passed,
      timedOut: false,
      output: result.output,
      logPath: result.logPath,
      result: result.passed ? 'pass' : 'infrastructure',
    },
  };
  if (result.passed) persistRun(execution, run);
  return result;
}

export function withTreeBun(command: readonly string[], tree: string, fallbackRoot = tree): string[] {
  let index = command[0] === 'env' ? 1 : 0;
  while (command[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(command[index]!)) index++;
  if (command[index] !== 'bun') return [...command];
  const artifactRoot = existsSync(join(tree, 'node_modules/bun/package.json')) ? tree : fallbackRoot;
  const executable = repositoryBun(tree, artifactRoot).binary;
  const bins = [...new Set([join(tree, 'node_modules/.bin'), join(fallbackRoot, 'node_modules/.bin')])];
  const path = [...bins, process.env.PATH ?? ''].filter(Boolean).join(':');
  return ['env', `PATH=${path}`, ...command.map((argument, position) => (position === index ? executable : argument))];
}

function cachedRun(execution: DevVerifierExecution, key: string): DevVerifierEvidence | undefined {
  try {
    return execution.readRun(key);
  } catch {
    return undefined;
  }
}

function forCheckAtCommit(result: DevVerifierEvidence, commit: string, check: CheckExecution): DevVerifierEvidence {
  return {
    ...result,
    commit,
    command: [...check.command],
    ...(check.cwd ? { cwd: check.cwd } : {}),
  };
}

export function reusableCheckResult(
  execution: DevVerifierExecution,
  commit: string,
  check: CheckExecution,
  runKey: string,
  inputKey?: string,
): DevVerifierEvidence | undefined {
  const policy = execution.settings.policy?.verifier;
  const cached = cachedRun(execution, runKey);
  if (cached && classifyRun(cached, policy) !== 'infrastructure') return forCheckAtCommit(cached, commit, check);
  const failed = inputKey ? cachedRun(execution, inputKey) : undefined;
  return failed && classifyRun(failed, policy) === 'fail' ? forCheckAtCommit(failed, commit, check) : undefined;
}

function persistRun(execution: DevVerifierExecution, run: DevVerifierRun): void {
  try {
    execution.saveRun(run);
  } catch {
    // A failed cache write cannot change the fresh gate result.
  }
}

export function createEvidence(
  commit: string,
  check: CheckExecution,
  result: GateOutcome,
  logPath: string,
  policy = defaultPolicy.verifier,
): DevVerifierEvidence {
  return {
    commit,
    command: [...check.command],
    passed: result.passed,
    timedOut: result.timedOut,
    output: result.output,
    logPath,
    result: classifyRun(result, policy),
    ...(check.cwd ? { cwd: check.cwd } : {}),
  };
}

export async function executeCheck(
  execution: DevVerifierExecution,
  run: GateRunner,
  check: CheckExecution,
  commit: string,
  tree: string,
  key: string,
  input?: string,
  signal?: AbortSignal,
): Promise<DevVerifierEvidence> {
  const cached = reusableCheckResult(execution, commit, check, key, input);
  if (cached) return cached;
  const policy = execution.settings.policy ?? defaultPolicy;
  const attempts: string[] = [];
  let final: GateOutcome = { passed: false, output: '', timedOut: false };
  let finalLog = '';
  for (let attempt = 0; attempt < policy.verifier.checkAttempts; attempt++) {
    if (signal?.aborted) {
      final = { passed: false, output: 'Verifier round deadline reached.', timedOut: true };
      break;
    }
    finalLog = join(execution.settings.stateDirectory, `dev-verify-${randomUUID()}.log`);
    try {
      final = await run(
        withTreeBun(check.command, tree, execution.settings.mainCheckout),
        check.cwd ? join(tree, check.cwd) : tree,
        finalLog,
        signal ? { signal } : undefined,
      );
    } catch (error) {
      final = {
        passed: false,
        output: error instanceof Error ? error.message : String(error),
        timedOut: signal?.aborted ?? false,
      };
    }
    attempts.push(`attempt ${attempt + 1}: ${final.output}`);
    if (final.passed || signal?.aborted || !infraFailure(final.output, final.timedOut)) break;
  }
  const fullOutput = attempts.length > 1 ? attempts.join('\n') : final.output;
  const result = createEvidence(
    commit,
    check,
    { ...final, output: fullOutput },
    finalLog,
    execution.settings.policy?.verifier,
  );
  const createdAt = new Date().toISOString();
  if (classifyRun(result, execution.settings.policy?.verifier) !== 'infrastructure')
    persistRun(execution, { key, createdAt, evidence: result });
  if (input && classifyRun(result, execution.settings.policy?.verifier) === 'fail')
    persistRun(execution, { key: input, createdAt, evidence: result });
  return result;
}
