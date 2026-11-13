import { createHash } from 'node:crypto';
import { parseRemotePhysicalRunReceipt } from '../../../scripts/remote-check.ts';

export const DEV_VERIFIER_PHASES = ['queue', 'preparation', 'execution', 'settlement'] as const;
export type DevVerifierPhaseName = (typeof DEV_VERIFIER_PHASES)[number];

export type DevVerifierPhaseRunner =
  | { kind: 'unknown'; id: null }
  | { kind: 'local'; id: string }
  | { kind: 'check-host'; id: string; host: string };

export type DevVerifierPhaseObservation =
  | { status: 'unknown'; reason: string }
  | { status: 'unreached'; reason: string }
  | {
      status: 'measured';
      clockId: string;
      startedMs: number;
      completedMs: number;
      durationMs: number;
    };

export type DevVerifierPhaseEvidence = {
  schema: 1;
  executionId: string;
  commandSha256: string;
  executionBudgetMs?: number;
  runner: DevVerifierPhaseRunner;
  phases: Record<DevVerifierPhaseName, DevVerifierPhaseObservation>;
};

export type DevVerifierPhaseReceipt = {
  schema: 1;
  executionId: string;
  commandSha256: string;
  runner: unknown;
  phases?: unknown;
  /** Existing structured remote-check evidence, wrapped by the runner with this verifier binding. */
  remoteReceipt?: unknown;
};

export type DevVerifierPhaseBinding = {
  executionId: string;
  command: readonly string[];
  cwd?: string;
  executionBudgetMs?: number;
};

const UNKNOWN_RUNNER: DevVerifierPhaseRunner = { kind: 'unknown', id: null };
const PHASE_RECEIPT_MISSING = 'The runner did not provide structured phase evidence.';
const PHASE_RECEIPT_OWNER_MISMATCH = 'The phase receipt does not belong to this command execution.';

export function verifierCommandSha256(command: readonly string[], cwd?: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: [...command], cwd: cwd ?? null }))
    .digest('hex');
}

export function unknownVerifierPhaseEvidence(
  binding: DevVerifierPhaseBinding,
  reason = PHASE_RECEIPT_MISSING,
): DevVerifierPhaseEvidence {
  return {
    schema: 1,
    executionId: binding.executionId,
    commandSha256: verifierCommandSha256(binding.command, binding.cwd),
    ...(binding.executionBudgetMs === undefined ? {} : { executionBudgetMs: binding.executionBudgetMs }),
    runner: { ...UNKNOWN_RUNNER },
    phases: Object.fromEntries(
      DEV_VERIFIER_PHASES.map((phase) => [phase, { status: 'unknown', reason }]),
    ) as Record<DevVerifierPhaseName, DevVerifierPhaseObservation>,
  };
}

export function unreachedVerifierPhaseEvidence(
  binding: DevVerifierPhaseBinding,
  reason: string,
): DevVerifierPhaseEvidence {
  const phaseReason = boundedReason(reason, 'The command was not started.');
  return {
    schema: 1,
    executionId: binding.executionId,
    commandSha256: verifierCommandSha256(binding.command, binding.cwd),
    ...(binding.executionBudgetMs === undefined ? {} : { executionBudgetMs: binding.executionBudgetMs }),
    runner: { ...UNKNOWN_RUNNER },
    phases: Object.fromEntries(
      DEV_VERIFIER_PHASES.map((phase) => [phase, { status: 'unreached', reason: phaseReason }]),
    ) as Record<DevVerifierPhaseName, DevVerifierPhaseObservation>,
  };
}

/** Consume only structured evidence for this command attempt; prose and stale receipts remain unknown. */
export function consumeVerifierPhaseReceipt(
  value: unknown,
  binding: DevVerifierPhaseBinding,
): DevVerifierPhaseEvidence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownVerifierPhaseEvidence(binding);
  const receipt = value as Partial<DevVerifierPhaseReceipt>;
  const commandSha256 = verifierCommandSha256(binding.command, binding.cwd);
  if (
    receipt.schema !== 1 ||
    receipt.executionId !== binding.executionId ||
    receipt.commandSha256 !== commandSha256
  )
    return unknownVerifierPhaseEvidence(binding, PHASE_RECEIPT_OWNER_MISMATCH);

  const runner = parseRunner(receipt.runner);
  if (!runner) return unknownVerifierPhaseEvidence(binding, 'The phase receipt has no valid runner identity.');
  if (receipt.remoteReceipt !== undefined)
    return consumeRemotePhysicalReceipt(receipt.remoteReceipt, runner, binding, commandSha256);

  const supplied = receipt.phases;
  const phases = Object.fromEntries(
    DEV_VERIFIER_PHASES.map((phase) => [phase, parseObservation(asRecord(supplied)?.[phase])]),
  ) as Record<DevVerifierPhaseName, DevVerifierPhaseObservation>;
  if (hasUnreachedPreExecutionPhase(phases) || hasOverlappingPreExecutionPhases(phases)) {
    const reason = 'The phase receipt contradicts its own execution reachability.';
    return {
      schema: 1,
      executionId: binding.executionId,
      commandSha256,
      ...(binding.executionBudgetMs === undefined ? {} : { executionBudgetMs: binding.executionBudgetMs }),
      runner,
      phases: Object.fromEntries(
        DEV_VERIFIER_PHASES.map((phase) => [phase, { status: 'unknown', reason }]),
      ) as Record<DevVerifierPhaseName, DevVerifierPhaseObservation>,
    };
  }
  return {
    schema: 1,
    executionId: binding.executionId,
    commandSha256,
    ...(binding.executionBudgetMs === undefined ? {} : { executionBudgetMs: binding.executionBudgetMs }),
    runner,
    phases,
  };
}

function consumeRemotePhysicalReceipt(
  value: unknown,
  runner: DevVerifierPhaseRunner,
  binding: DevVerifierPhaseBinding,
  commandSha256: string,
): DevVerifierPhaseEvidence {
  const receipt = parseRemotePhysicalRunReceipt(value);
  if (!receipt || runner.kind !== 'check-host' || runner.id !== receipt.run || runner.host !== receipt.host)
    return unknownVerifierPhaseEvidence(binding, 'The remote physical receipt does not match its runner identity.');

  const resources = receipt.resources;
  const clockId = resources ? `check-host:${resources.host}:${resources.boot}` : undefined;
  const hasCommandStart = resources?.commandStartedMonoMs !== null && resources?.commandStartedMonoMs !== undefined;
  const phases: Record<DevVerifierPhaseName, DevVerifierPhaseObservation> = {
    queue: { status: 'unknown', reason: 'The remote physical receipt contains no structured queue boundary.' },
    preparation:
      resources && hasCommandStart
        ? measured(clockId!, resources.startedMonoMs, resources.commandStartedMonoMs!)
        : { status: 'unknown', reason: 'The remote physical receipt contains no complete preparation boundary.' },
    execution:
      resources && hasCommandStart
        ? measured(clockId!, resources.commandStartedMonoMs!, resources.terminalMonoMs)
        : resources
          ? { status: 'unreached', reason: 'The remote physical receipt records no actual command start.' }
          : { status: 'unknown', reason: 'The remote physical receipt contains no command boundary.' },
    settlement: { status: 'unknown', reason: 'The remote physical receipt contains no terminal settlement boundary.' },
  };
  return {
    schema: 1,
    executionId: binding.executionId,
    commandSha256,
    ...(binding.executionBudgetMs === undefined ? {} : { executionBudgetMs: binding.executionBudgetMs }),
    runner,
    phases,
  };
}

function measured(clockId: string, startedMs: number, completedMs: number): DevVerifierPhaseObservation {
  return { status: 'measured', clockId, startedMs, completedMs, durationMs: completedMs - startedMs };
}

function parseRunner(value: unknown): DevVerifierPhaseRunner | undefined {
  const runner = asRecord(value);
  if (
    !runner ||
    typeof runner.id !== 'string' ||
    !runner.id.trim() ||
    runner.id !== runner.id.trim() ||
    runner.id.length > 256
  )
    return undefined;
  if (runner.kind === 'local') return { kind: 'local', id: runner.id };
  if (
    runner.kind === 'check-host' &&
    typeof runner.host === 'string' &&
    runner.host.trim() &&
    runner.host === runner.host.trim() &&
    runner.host.length <= 256
  )
    return { kind: 'check-host', id: runner.id, host: runner.host };
  return undefined;
}

function parseObservation(value: unknown): DevVerifierPhaseObservation {
  const observation = asRecord(value);
  if (!observation) return { status: 'unknown', reason: 'The producer omitted this phase boundary.' };
  if (observation.status === 'unreached')
    return {
      status: 'unreached',
      reason: boundedReason(observation.reason, 'The producer did not reach this phase.'),
    };
  if (observation.status === 'unknown')
    return {
      status: 'unknown',
      reason: boundedReason(observation.reason, 'The producer could not measure this phase.'),
    };
  if (
    observation.status !== 'measured' ||
    typeof observation.clockId !== 'string' ||
    !observation.clockId.trim() ||
    observation.clockId.length > 256 ||
    !finiteNonNegative(observation.startedMs) ||
    !finiteNonNegative(observation.completedMs) ||
    observation.completedMs < observation.startedMs
  )
    return { status: 'unknown', reason: 'The producer supplied an invalid phase boundary.' };

  return {
    status: 'measured',
    clockId: observation.clockId,
    startedMs: observation.startedMs,
    completedMs: observation.completedMs,
    durationMs: observation.completedMs - observation.startedMs,
  };
}

function hasUnreachedPreExecutionPhase(
  phases: Record<DevVerifierPhaseName, DevVerifierPhaseObservation>,
): boolean {
  const preExecution: DevVerifierPhaseName[] = ['queue', 'preparation', 'execution'];
  const unreached = preExecution.findIndex((phase) => phases[phase].status === 'unreached');
  return unreached >= 0 && preExecution.slice(unreached + 1).some((phase) => phases[phase].status !== 'unreached');
}

function hasOverlappingPreExecutionPhases(
  phases: Record<DevVerifierPhaseName, DevVerifierPhaseObservation>,
): boolean {
  const adjacent: [DevVerifierPhaseName, DevVerifierPhaseName][] = [
    ['queue', 'preparation'],
    ['preparation', 'execution'],
  ];
  return adjacent.some(([beforeName, afterName]) => {
    const before = phases[beforeName];
    const after = phases[afterName];
    return (
      before.status === 'measured' &&
      after.status === 'measured' &&
      before.clockId === after.clockId &&
      after.startedMs < before.completedMs
    );
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function boundedReason(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 512) : fallback;
}
