import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import type {
  DevVerifierCause,
  DevVerifierDiagnostic,
  DevVerifierEvidence,
  DevVerifierFinding,
  DevVerifierResult,
  Settings,
} from './types.ts';
import { defaultPolicy } from './policy.ts';
import { gateEnvironment, gateRunner, git } from './merge.ts';
import { classifyRun } from './dev-verifier-classification.ts';
import { executeCheck, installDependenciesCached, type DevVerifierExecution } from './dev-verifier-execution.ts';
import type { DevVerifierCheck } from './dev-verifier-plan.ts';
import type { DevVerifierOptions } from './dev-verifier.ts';

type Check = DevVerifierCheck;
export type IndexedCheck = Check & { index: number; signature: string };
export type CheckRun = { check: IndexedCheck; evidence: DevVerifierEvidence };
export type RoundChecks = { results: CheckRun[]; pending: Check[] };
export const VERIFY_CONCURRENCY = 3;

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function environmentIdentity(settings: Settings): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(gateEnvironment(process.env, settings.stateDirectory)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function packageManagerPinAt(checkout: string, commit?: string): string | undefined {
  try {
    const source = commit
      ? git(checkout, 'show', commit + ':package.json')
      : readFileSync(join(checkout, 'package.json'), 'utf8');
    const packageJson = JSON.parse(source) as { packageManager?: unknown };
    return typeof packageJson.packageManager === 'string' && packageJson.packageManager.startsWith('bun@')
      ? packageJson.packageManager.slice('bun@'.length)
      : undefined;
  } catch {
    return undefined;
  }
}

function toolchainIdentity(settings: Settings, commit?: string): unknown {
  let remoteHosts: string | null = null;
  const pinnedBun = packageManagerPinAt(settings.mainCheckout, commit);
  try {
    remoteHosts = readFileSync(join(settings.stateDirectory, 'remote-check-hosts.json'), 'utf8');
  } catch {}
  return {
    bun: pinnedBun ?? Bun.version,
    bunRevision: pinnedBun ? null : Bun.revision,
    platform: process.platform,
    arch: process.arch,
    host: hostname(),
    noCompileCache: '1',
    remoteHosts,
  };
}

export function checkSignature(check: Check, index: number): string {
  return hash({
    version: 4,
    index,
    command: check.command,
    closure: [...check.closure].sort(),
    taskId: check.taskId ?? null,
    cwd: check.cwd ?? null,
  });
}

export function selectionIdentity(checks: readonly IndexedCheck[]): string {
  return hash(checks.map(({ command, closure, taskId, signature }) => ({ command, closure, taskId, signature })));
}

export function dependencySetupKey(settings: Settings, commit: string): string {
  return hash({
    version: 4,
    phase: 'dependency-setup',
    commit,
    command: ['bun', 'install', '--frozen-lockfile'],
    closure: ['package.json', 'bun.lock'],
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings, commit),
  });
}

export function runCacheKey(settings: Settings, commit: string, check: IndexedCheck, selection: string): string {
  return hash({
    version: 4,
    phase: 'head-check',
    commit,
    signature: check.signature,
    selection,
    command: check.command,
    closure: [...check.closure].sort(),
    environment: environmentIdentity(settings),
    toolchain: toolchainIdentity(settings, commit),
  });
}

export function makeFinding(
  check: IndexedCheck,
  base: string,
  target: string,
  test: string | undefined,
  assertion: string,
  status: DevVerifierFinding['status'],
  evidence: DevVerifierEvidence | null,
  reason: string,
  result: DevVerifierResult,
  cause?: DevVerifierCause,
  diagnostic?: DevVerifierDiagnostic,
  diagnosticIdentity?: string,
): DevVerifierFinding {
  const identity = hash(
    test
      ? { test }
      : {
          cause: cause ?? 'unknown',
          diagnostic: diagnosticIdentity ?? diagnostic,
          command: check.command,
          assertion,
        },
  );
  return {
    rangeKey: hash({ identity, target }),
    identity,
    signature: identity,
    baseCommit: base,
    headCommit: target,
    status,
    result,
    check: {
      command: [...check.command],
      closure: [...check.closure],
      ...(check.taskId ? { taskId: check.taskId } : {}),
      ...(check.cwd ? { cwd: check.cwd } : {}),
    },
    assertion,
    ...(test ? { test } : {}),
    ...(cause ? { cause } : {}),
    ...(diagnostic ? { diagnostic } : {}),
    baseline: null,
    head: evidence,
    reason,
    ...(check.taskId ? { taskId: check.taskId } : {}),
    createdAt: new Date().toISOString(),
  };
}

function verifierExecution(options: DevVerifierOptions): DevVerifierExecution {
  return {
    settings: options.settings,
    store: options.store,
  };
}

/** Execute only checks that fit before the round deadline; unstarted checks are returned for the next round. */
export async function runChecksAtHead(
  options: DevVerifierOptions,
  checks: readonly Check[],
  head: string,
  tree: string,
  deadline: number,
  signal: AbortSignal,
  bootSmokeCount = 0,
  roundId: string = randomUUID(),
): Promise<RoundChecks> {
  const settings = options.settings;
  const execution = verifierExecution(options);
  const indexed: IndexedCheck[] = checks.map((check, index) => ({
    ...check,
    index,
    signature: checkSignature(check, index),
  }));
  const selection = selectionIdentity(indexed);
  const bootRunner =
    options.runBootSmoke ??
    options.runGate ??
    gateRunner((settings.policy ?? defaultPolicy).verifier.bootSmokeTimeoutMs);
  const runner = options.runGate ?? gateRunner((settings.policy ?? defaultPolicy).verifier.standaloneGateTimeoutMs);
  const results: CheckRun[] = [];
  const attempted = new Set<number>();

  const runOne = async (check: IndexedCheck, gate: typeof runner) => {
    const key = runCacheKey(settings, head, check, selection);
    const evidence = await executeCheck(execution, gate, check, head, tree, key, undefined, signal, roundId);
    attempted.add(check.index);
    results.push({ check, evidence });
  };

  const bootCount = Math.min(bootSmokeCount, indexed.length);
  for (let index = 0; index < bootCount; index++) {
    if (signal.aborted || Date.now() >= deadline) break;
    await runOne(indexed[index]!, bootRunner);
  }

  let next = bootCount;
  const limit = Math.min(VERIFY_CONCURRENCY, (settings.policy ?? defaultPolicy).verifier.concurrency);
  const lane = async () => {
    while (next < indexed.length) {
      if (signal.aborted || Date.now() >= deadline) return;
      const index = next++;
      await runOne(indexed[index]!, runner);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, indexed.length - bootCount) }, lane));
  results.sort((left, right) => left.check.index - right.check.index);
  return {
    results,
    pending: indexed
      .filter((check) => !attempted.has(check.index))
      .map(({ index: _index, signature: _signature, ...check }) => check),
  };
}
