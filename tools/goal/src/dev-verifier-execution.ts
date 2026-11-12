import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { repositoryBun } from '../../../scripts/remote-check.ts';
import { runBoundedInstallProcess } from './install-process.ts';
import type { GateRunner } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { classifyRun, infraFailure } from './dev-verifier-classification.ts';
import type { DevVerifierCheck } from './dev-verifier-plan.ts';
import {
  beginCommandRun,
  cachedRun as cachedStoredRun,
  commandRunById,
  completeCommandRun,
  latestCommandRun,
  verifierCommandRunKey,
  type DevVerifierStorage,
} from './dev-verifier-storage.ts';
import type { DevVerifierEvidence, DevVerifierRun, Settings } from './types.ts';

type ExecutionSettings = Pick<Settings, 'mainCheckout' | 'stateDirectory' | 'policy'>;
export type DevVerifierExecution = {
  settings: ExecutionSettings;
  store: DevVerifierStorage;
  roundId?: string;
};
export type CheckExecution = Pick<DevVerifierCheck, 'command' | 'cwd'>;
export type GateOutcome = { passed: boolean; output: string; timedOut: boolean };

function installDependencies(
  tree: string,
  stateDirectory: string,
  execution: DevVerifierExecution,
  commit: string,
  cacheKey: string,
  policy = defaultPolicy,
): { passed: boolean; logPath: string; commandRunIds: string[] } {
  let installLog = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  const roundId = execution.roundId ?? randomUUID();
  const commandRunIds: string[] = [];
  let passed = false;
  for (let attempt = 0; attempt < policy.verifier.installAttempts; attempt++) {
    const id = commandExecutionId(roundId, cacheKey, attempt);
    const runKey = verifierCommandRunKey(id);
    const previous = commandRunById(execution.store, id);
    if (previous) {
      commandRunIds.push(previous.key);
      installLog = previous.evidence.logPath || installLog;
      if (previous.execution?.status !== 'terminal') break;
      passed = previous.execution.outcome === 'pass';
      if (passed) break;
      continue;
    }

    const startedAt = new Date().toISOString();
    const startRun: DevVerifierRun = {
      key: runKey,
      createdAt: startedAt,
      evidence: {
        commit,
        command: ['bun', 'install', '--frozen-lockfile'],
        passed: false,
        timedOut: false,
        output: '',
        logPath: installLog,
        result: 'unknown',
      },
      execution: {
        id,
        roundId,
        cacheKey,
        status: 'running',
        outcome: 'unknown',
        startedAt,
        durationMs: null,
      },
    };
    const started = beginCommandRun(execution.store, startRun);
    if (!started.claimed) {
      commandRunIds.push(started.run.key);
      installLog = started.run.evidence.logPath || installLog;
      if (started.run.execution?.status === 'terminal') {
        passed = started.run.execution.outcome === 'pass';
        if (passed) break;
        continue;
      }
      break;
    }

    let output = '';
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
      output = `${result.stdout}${result.stderr}`;
      appendFileSync(installLog, output);
      passed = true;
    } catch (error) {
      output = `${error instanceof Error ? error.message : String(error)}\n`;
      appendFileSync(installLog, output);
    }

    const completedAt = new Date().toISOString();
    const evidence = createEvidence(
      commit,
      { command: ['bun', 'install', '--frozen-lockfile'] },
      { passed, output, timedOut: false },
      installLog,
      execution.settings.policy?.verifier,
    );
    const completed = completeCommandRun(
      execution.store,
      {
        ...startRun,
        evidence,
        execution: {
          ...startRun.execution!,
          status: 'terminal',
          outcome: evidence.result ?? 'unknown',
          completedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        },
      },
      execution.settings.policy?.verifier,
    );
    commandRunIds.push(completed.key);
    passed = completed.execution?.outcome === 'pass';
    if (passed) break;
  }
  return { passed, logPath: installLog, commandRunIds };
}

export function installDependenciesCached(
  execution: DevVerifierExecution,
  commit: string,
  tree: string,
  key: string,
): { passed: boolean; output: string; logPath: string; commandRunIds: string[] } {
  // A previous tree's successful install cannot populate this fresh tree's node_modules.
  const { stateDirectory } = execution.settings;
  const newLogPath = join(stateDirectory, `dev-verify-install-${randomUUID()}.log`);
  const roundId = execution.roundId ?? randomUUID();
  if (!existsSync(join(tree, 'package.json'))) {
    const commandRunId = recordSkippedCommand(
      execution,
      commit,
      roundId,
      { command: ['bun', 'install', '--frozen-lockfile'] },
      key,
      'Dependency installation is skipped because the captured tree has no package.json.',
    );
    return { passed: true, output: '', logPath: newLogPath, commandRunIds: [commandRunId] };
  }
  if (!existsSync(join(tree, 'bun.lock')))
    return {
      passed: false,
      output: 'Baseline dependency setup failed: bun.lock is absent.',
      logPath: newLogPath,
      commandRunIds: [],
    };

  const installed = installDependencies(
    tree,
    stateDirectory,
    { ...execution, roundId },
    commit,
    key,
    execution.settings.policy,
  );
  let output = '';
  try {
    output = readFileSync(installed.logPath, 'utf8');
  } catch {}
  return { ...installed, output };
}

export function withTreeBun(command: readonly string[], tree: string, fallbackRoot = tree): string[] {
  const hasEnv = command[0] === 'env';
  let index = hasEnv ? 1 : 0;
  while (hasEnv && command[index]) {
    const argument = command[index]!;
    if (argument === '--') {
      index++;
      break;
    }
    if (['-u', '--unset', '-C', '--chdir'].includes(argument)) {
      index += 2;
      continue;
    }
    if (/^(?:--unset=|--chdir=)/u.test(argument) || argument === '-i' || argument === '--ignore-environment') {
      index++;
      continue;
    }
    if (/^-u.+$/u.test(argument) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
      index++;
      continue;
    }
    break;
  }
  if (command[index] !== 'bun') return [...command];
  const artifactRoot = existsSync(join(tree, 'node_modules/bun/package.json')) ? tree : fallbackRoot;
  const executable = repositoryBun(tree, artifactRoot).binary;
  const bins = [...new Set([join(tree, 'node_modules/.bin'), join(fallbackRoot, 'node_modules/.bin')])];
  const path = [...bins, process.env.PATH ?? ''].filter(Boolean).join(':');
  if (!hasEnv) return ['env', `PATH=${path}`, executable, ...command.slice(index + 1)];
  const prefix = command.slice(0, index).filter((argument) => argument !== '--');
  return [...prefix, `PATH=${path}`, executable, ...command.slice(index + 1)];
}

function cachedRun(execution: DevVerifierExecution, key: string): DevVerifierEvidence | undefined {
  try {
    return cachedStoredRun(execution.store, key);
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
  const receipt = latestCommandRun(execution.store, runKey);
  if (receipt) {
    const outcome = receipt.execution?.outcome ?? 'unknown';
    if (outcome === 'infrastructure') return undefined;
    return forCheckAtCommit(
      {
        ...receipt.evidence,
        result: outcome,
        passed: outcome === 'pass',
        commandRunIds: [receipt.key],
      },
      commit,
      check,
    );
  }
  const cached = cachedRun(execution, runKey);
  if (cached) return forCheckAtCommit({ ...cached, passed: false, result: 'unknown' }, commit, check);
  const failed = inputKey ? cachedRun(execution, inputKey) : undefined;
  return failed && classifyRun(failed, policy) === 'fail'
    ? forCheckAtCommit({ ...failed, passed: false, result: 'unknown' }, commit, check)
    : undefined;
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
  roundId: string = randomUUID(),
): Promise<DevVerifierEvidence> {
  const policy = execution.settings.policy ?? defaultPolicy;
  const firstRun = commandRunById(execution.store, commandExecutionId(roundId, key, 0));
  if (!firstRun) {
    const cached = reusableCheckResult(execution, commit, check, key, input);
    if (cached) return cached;
  }

  const commandRunIds: string[] = [];
  const attemptOutputs: string[] = [];
  let latest: DevVerifierRun | undefined;
  for (let attempt = 0; attempt < policy.verifier.checkAttempts; attempt++) {
    if (signal?.aborted) break;
    const id = commandExecutionId(roundId, key, attempt);
    const runKey = verifierCommandRunKey(id);
    const previous = commandRunById(execution.store, id);
    if (previous) {
      commandRunIds.push(previous.key);
      if (previous.execution?.status !== 'terminal') break;
      latest = previous;
      attemptOutputs.push(previous.evidence.output);
      if (previous.evidence.passed || !infraFailure(previous.evidence.output, previous.evidence.timedOut)) break;
      continue;
    }

    const finalLog = join(execution.settings.stateDirectory, `dev-verify-${randomUUID()}.log`);
    const startedAt = new Date().toISOString();
    const startRun: DevVerifierRun = {
      key: runKey,
      createdAt: startedAt,
      evidence: {
        commit,
        command: [...check.command],
        passed: false,
        timedOut: false,
        output: '',
        logPath: finalLog,
        result: 'unknown',
        ...(check.cwd ? { cwd: check.cwd } : {}),
      },
      execution: {
        id,
        roundId,
        cacheKey: key,
        status: 'running',
        outcome: 'unknown',
        startedAt,
        durationMs: null,
      },
    };
    const started = beginCommandRun(execution.store, startRun);
    if (!started.claimed) {
      commandRunIds.push(started.run.key);
      if (started.run.execution?.status === 'terminal') {
        latest = started.run;
        attemptOutputs.push(started.run.evidence.output);
        if (!started.run.evidence.passed && infraFailure(started.run.evidence.output, started.run.evidence.timedOut))
          continue;
      }
      break;
    }

    let final: GateOutcome;
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
    const completedAt = new Date().toISOString();
    const evidence = createEvidence(commit, check, final, finalLog, execution.settings.policy?.verifier);
    const completed: DevVerifierRun = {
      ...startRun,
      evidence,
      execution: {
        ...startRun.execution!,
        status: 'terminal',
        outcome: evidence.result ?? 'unknown',
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      },
    };
    latest = completeCommandRun(execution.store, completed, execution.settings.policy?.verifier);
    commandRunIds.push(latest.key);
    attemptOutputs.push(latest.evidence.output);
    if (latest.evidence.passed || signal?.aborted || !infraFailure(latest.evidence.output, latest.evidence.timedOut))
      break;
  }

  if (!latest) {
    return {
      commit,
      command: [...check.command],
      passed: false,
      timedOut: false,
      output: 'Verifier round ended before the command produced a terminal result.',
      logPath: '',
      result: 'unknown',
      ...(check.cwd ? { cwd: check.cwd } : {}),
      commandRunIds,
    };
  }
  const fullOutput =
    attemptOutputs.length > 1
      ? attemptOutputs
          .map(
            (output, index) =>
              `--- verifier attempt ${index + 1} (${index === attemptOutputs.length - 1 ? 'final' : 'retry'}) ---\n${output}`,
          )
          .join('\n')
      : latest.evidence.output;
  return {
    ...forCheckAtCommit(latest.evidence, commit, check),
    output: fullOutput,
    result: latest.execution?.outcome ?? 'unknown',
    passed: latest.execution?.outcome === 'pass',
    commandRunIds,
  };
}

export function recordSkippedCommand(
  execution: DevVerifierExecution,
  commit: string,
  roundId: string,
  check: CheckExecution,
  cacheKey: string,
  reason: string,
): string {
  const id = commandExecutionId(roundId, cacheKey, -1);
  const completedAt = new Date().toISOString();
  const run: DevVerifierRun = {
    key: verifierCommandRunKey(id),
    createdAt: completedAt,
    evidence: {
      commit,
      command: [...check.command],
      passed: false,
      timedOut: false,
      output: reason,
      logPath: '',
      result: 'skipped',
      ...(check.cwd ? { cwd: check.cwd } : {}),
    },
    execution: {
      id,
      roundId,
      cacheKey,
      status: 'terminal',
      outcome: 'skipped',
      completedAt,
      durationMs: null,
    },
  };
  return completeCommandRun(execution.store, run, execution.settings.policy?.verifier).key;
}

function commandExecutionId(roundId: string, cacheKey: string, attempt: number): string {
  return createHash('sha256')
    .update(JSON.stringify([roundId, cacheKey, attempt]))
    .digest('hex');
}
