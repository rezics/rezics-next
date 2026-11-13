import { createHash, randomUUID } from 'node:crypto';

const PHASES = ['queue', 'preparation', 'execution', 'settlement'] as const;
const MAX_CHANNEL_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 16 * 1024;

export type VerifierPhaseChannelBinding = {
  executionId: string;
  command: readonly string[];
  cwd?: string;
  executionBudgetMs: number;
};

type CheckHostRunner = { kind: 'check-host'; id: string; host: string };
type PhaseObservation =
  | { status: 'unknown' | 'unreached'; reason: string }
  | { status: 'measured'; clockId: string; startedMs: number; completedMs: number };
type ParsedPhaseReceipt = {
  runner: CheckHostRunner;
  phases: Record<(typeof PHASES)[number], PhaseObservation>;
  liveExecutionStart: { status: 'observed' } | { status: 'unavailable' };
};

export type VerifierPhaseChannel = {
  environment: { REMOTE_CHECK_RECEIPT_FD: '3'; REMOTE_CHECK_RECEIPT_NONCE: string };
  receive(chunk: string): void;
  finish(): unknown | undefined;
};

/** Bind the root remote-check protocol to one verifier command without importing its runtime module. */
export function createVerifierPhaseChannel(
  binding: VerifierPhaseChannelBinding,
  handlers: { executionStarted(): void; invalid(): void },
): VerifierPhaseChannel {
  const nonce = randomUUID();
  const commandSha256 = createHash('sha256')
    .update(JSON.stringify({ command: [...binding.command], cwd: binding.cwd ?? null }))
    .digest('hex');
  let pending = '';
  let receivedBytes = 0;
  let eventCount = 0;
  let startRunner: CheckHostRunner | undefined;
  let receipt: ParsedPhaseReceipt | undefined;
  let invalid = false;
  let finished = false;

  const invalidate = () => {
    if (invalid) return;
    invalid = true;
    receipt = undefined;
    handlers.invalid();
  };

  const accept = (line: string) => {
    if (!line || Buffer.byteLength(line) > MAX_EVENT_BYTES || line.endsWith('\r')) return invalidate();
    let envelope: Record<string, unknown> | undefined;
    try {
      envelope = asRecord(JSON.parse(line));
    } catch {
      return invalidate();
    }
    if (!envelope || envelope.nonce !== nonce) return invalidate();
    if (++eventCount > 2) return invalidate();
    const event = asRecord(envelope.phaseEvent);
    if (!event || event.schema !== 1) return invalidate();

    if (event.kind === 'execution-started') {
      const runner = parseRunner(event.runner);
      if (eventCount !== 1 || startRunner || receipt || event.authority !== 'remote-command-started-marker' || !runner)
        return invalidate();
      startRunner = runner;
      handlers.executionStarted();
      return;
    }

    if (event.kind !== 'phase-receipt' || receipt) return invalidate();
    const parsed = parseReceipt(event.receipt);
    if (!parsed) return invalidate();
    if (startRunner) {
      if (!sameRunner(startRunner, parsed.runner) || parsed.liveExecutionStart.status !== 'observed')
        return invalidate();
    } else if (parsed.liveExecutionStart.status !== 'unavailable') {
      return invalidate();
    }
    receipt = parsed;
  };

  return {
    environment: { REMOTE_CHECK_RECEIPT_FD: '3', REMOTE_CHECK_RECEIPT_NONCE: nonce },
    receive(chunk) {
      if (finished || invalid) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_CHANNEL_BYTES) return invalidate();
      pending += chunk;
      if (Buffer.byteLength(pending) > MAX_EVENT_BYTES && !pending.includes('\n')) return invalidate();
      while (!invalid) {
        const newline = pending.indexOf('\n');
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        accept(line);
      }
      if (Buffer.byteLength(pending) > MAX_EVENT_BYTES) invalidate();
    },
    finish() {
      if (finished) return receiptValue();
      finished = true;
      if (pending.length || (startRunner && !receipt)) invalidate();
      return receiptValue();
    },
  };

  function receiptValue(): unknown | undefined {
    if (invalid || !receipt) return undefined;
    return {
      schema: 1,
      executionId: binding.executionId,
      commandSha256,
      runner: receipt.runner,
      phases: receipt.phases,
    };
  }
}

/** The boot plan's placed Kernel check wrapper is the only current phase producer. */
export function isPlacedKernelCheckCommand(command: readonly string[]): boolean {
  const index = command.findIndex(
    (part, offset) =>
      part === 'bun' &&
      command[offset + 1] === 'run' &&
      command[offset + 2] === '--cwd' &&
      command[offset + 3] === 'services/kernel' &&
      command[offset + 4] === 'check',
  );
  return (
    index >= 0 && command.slice(index + 5).some((part) => /^(?:\.\/)?test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(part))
  );
}

function parseReceipt(value: unknown): ParsedPhaseReceipt | undefined {
  const receipt = asRecord(value);
  const runner = parseRunner(receipt?.runner);
  const sourcePhases = asRecord(receipt?.phases);
  const live = asRecord(receipt?.liveExecutionStart);
  if (receipt?.schema !== 1 || !runner || !sourcePhases || !live || Object.keys(sourcePhases).length !== PHASES.length)
    return undefined;

  const phases = {} as Record<(typeof PHASES)[number], PhaseObservation>;
  for (const phase of PHASES) {
    const observation = asRecord(sourcePhases[phase]);
    if (!observation) return undefined;
    if (observation.status === 'measured') {
      if (
        typeof observation.clockId !== 'string' ||
        !observation.clockId.trim() ||
        observation.clockId.length > 256 ||
        !finiteNonNegative(observation.startedMs) ||
        !finiteNonNegative(observation.completedMs) ||
        observation.completedMs < observation.startedMs
      )
        return undefined;
      phases[phase] = {
        status: 'measured',
        clockId: observation.clockId,
        startedMs: observation.startedMs,
        completedMs: observation.completedMs,
      };
    } else if (
      (observation.status === 'unknown' || observation.status === 'unreached') &&
      typeof observation.reason === 'string' &&
      observation.reason.trim() &&
      observation.reason.length <= 512
    ) {
      phases[phase] = { status: observation.status, reason: observation.reason };
    } else return undefined;
  }

  if (live.status === 'observed' && live.authority === 'remote-command-started-marker')
    return { runner, phases, liveExecutionStart: { status: 'observed' } };
  if (
    live.status === 'unavailable' &&
    typeof live.reason === 'string' &&
    live.reason.trim() &&
    live.reason.length <= 512
  )
    return { runner, phases, liveExecutionStart: { status: 'unavailable' } };
  return undefined;
}

function parseRunner(value: unknown): CheckHostRunner | undefined {
  const runner = asRecord(value);
  if (runner?.kind !== 'check-host' || !validIdentity(runner.id) || !validIdentity(runner.host)) return undefined;
  return { kind: 'check-host', id: runner.id, host: runner.host };
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && Boolean(value.trim()) && value === value.trim();
}

function sameRunner(left: CheckHostRunner, right: CheckHostRunner): boolean {
  return left.id === right.id && left.host === right.host;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
