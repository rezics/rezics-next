/** Medium campaign clocks. Preparation and operation stay separate active limits.
 * This module does not start, signal, or reap processes. commandAsync owns that. */

export const CAMPAIGN_QUALIFICATION_FILE = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
export const CAMPAIGN_PREPARATION_ACTIVE_MS = 600_000;
export const CAMPAIGN_OPERATION_ACTIVE_MS = 360_000;

/** Supplied fixture copies use the same id grammar as campaign source selection. */
export const SUPPLIED_RUN_ID = /^fixture-[a-z0-9-]{1,27}$/;

export interface CommandPhaseSample {
  /** Active time already measured by commandAsync. Admission wait is not included. */
  activeElapsedMs: number;
  admissionOpen: boolean;
}

export interface CommandPhaseDecision {
  phase: 'preparation' | 'operation';
  /** Active milliseconds from the command start before this phase is over. */
  activeLimitMs: number;
  /** Set only when this sample must end the command. The run deadline stays the runner's. */
  reason?: string;
}

export type CampaignEvidenceState =
  | { kind: 'absent' }
  | { kind: 'ignored' }
  | { kind: 'refused' }
  | { kind: 'ready'; reportedActiveMs: number; boundaryActiveMs: number };

export function campaignQualificationShard(files: readonly string[]): boolean {
  return files.length === 1 && files[0] === CAMPAIGN_QUALIFICATION_FILE;
}

/** Completion ceiling after both phases. Not a single command timeout. */
export function campaignShardActiveMs(): number {
  return CAMPAIGN_PREPARATION_ACTIVE_MS + CAMPAIGN_OPERATION_ACTIVE_MS;
}

/** Ids in the current source list that match the fixture run grammar. Anything else is not current. */
export function currentSuppliedRunIds(source: string | undefined): ReadonlySet<string> {
  if (source === undefined || source.length === 0) return new Set();
  return new Set(source.split(',').filter(id => SUPPLIED_RUN_ID.test(id)));
}

/** stack:down keeps a caller's current copy. Every other record, including a missing id, resets. */
export function childStackCleanupCommand(
  args: readonly string[],
  supplied: ReadonlySet<string>,
): 'stack:down' | 'stack:reset' {
  const index = args.indexOf('--run-id');
  const runId = index >= 0 ? args[index + 1] : undefined;
  if (runId !== undefined && supplied.has(runId)) return 'stack:down';
  return 'stack:reset';
}

export function classifyCampaignEvidence(input: {
  parsed: unknown;
  readError: boolean;
  modifiedAt: number;
  commandStartedAt: number;
  projectRunId: string;
  activeElapsedMs: number;
  observedAt: number;
}): CampaignEvidenceState {
  if (input.readError) return { kind: 'ignored' };
  if (input.parsed === undefined) return { kind: 'absent' };
  if (!Number.isFinite(input.modifiedAt) || !Number.isFinite(input.commandStartedAt) ||
    !Number.isFinite(input.observedAt) || !Number.isFinite(input.activeElapsedMs) || input.activeElapsedMs < 0) {
    return { kind: 'refused' };
  }
  if (input.modifiedAt < input.commandStartedAt) return { kind: 'refused' };
  if (input.parsed === null || typeof input.parsed !== 'object' || Array.isArray(input.parsed)) {
    return { kind: 'refused' };
  }
  const record = input.parsed as Record<string, unknown>;
  for (const field of ['runId', 'project', 'projectRunId'] as const) {
    const value = record[field];
    if (typeof value === 'string' && value !== input.projectRunId) return { kind: 'refused' };
  }
  if (!Object.hasOwn(record, 'preparation')) return { kind: 'absent' };
  const preparation = record.preparation;
  if (preparation === null || typeof preparation !== 'object' || Array.isArray(preparation)) {
    return { kind: 'refused' };
  }
  const reportedActiveMs = (preparation as { activeMs?: unknown }).activeMs;
  if (typeof reportedActiveMs !== 'number' || !Number.isFinite(reportedActiveMs) || reportedActiveMs < 0) {
    return { kind: 'refused' };
  }
  // The write time is the preparation boundary. Poll delay stays on the preparation
  // side. Reported active time is not added to or subtracted from the parent clock.
  const delay = Math.max(0, input.observedAt - input.modifiedAt);
  const boundaryActiveMs = Math.min(input.activeElapsedMs, Math.max(0, input.activeElapsedMs - delay));
  return { kind: 'ready', reportedActiveMs, boundaryActiveMs };
}

export function campaignPhaseDeadline(
  sample: CommandPhaseSample,
  evidence: CampaignEvidenceState,
  commandName = 'bun',
): CommandPhaseDecision {
  if (!Number.isFinite(sample.activeElapsedMs) || sample.activeElapsedMs < 0) {
    throw new Error('Invalid campaign envelope clock');
  }
  const preparationReason = `${commandName} preparation exceeded ${CAMPAIGN_PREPARATION_ACTIVE_MS} ms of active work`;
  const ready = evidence.kind === 'ready' ? evidence : undefined;
  if (ready && (ready.reportedActiveMs > CAMPAIGN_PREPARATION_ACTIVE_MS ||
    ready.boundaryActiveMs > CAMPAIGN_PREPARATION_ACTIVE_MS)) {
    return { phase: 'preparation', activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS, reason: preparationReason };
  }
  if (!ready) {
    const over = !sample.admissionOpen && sample.activeElapsedMs > CAMPAIGN_PREPARATION_ACTIVE_MS;
    return {
      phase: 'preparation', activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS,
      ...(over ? { reason: preparationReason } : {}),
    };
  }
  const activeLimitMs = ready.boundaryActiveMs + CAMPAIGN_OPERATION_ACTIVE_MS;
  const operationActiveMs = sample.activeElapsedMs - ready.boundaryActiveMs;
  const over = !sample.admissionOpen && operationActiveMs > CAMPAIGN_OPERATION_ACTIVE_MS;
  return {
    phase: 'operation', activeLimitMs,
    ...(over ? { reason: `${commandName} timed out after ${CAMPAIGN_OPERATION_ACTIVE_MS} ms of active work` } : {}),
  };
}

/** A zero exit without fresh in-budget preparation is not an operation success. */
export function campaignCommandAccepted(input: {
  exitOk: boolean;
  timedOut: boolean;
  evidence: CampaignEvidenceState;
  sample: CommandPhaseSample;
}): { ok: boolean; failure?: 'preparation' | 'operation' | 'missing-preparation' } {
  if (input.timedOut || !input.exitOk) return { ok: false };
  if (input.evidence.kind !== 'ready') return { ok: false, failure: 'missing-preparation' };
  const decision = campaignPhaseDeadline(input.sample, input.evidence);
  if (!decision.reason) return { ok: true };
  return { ok: false, failure: decision.phase === 'operation' ? 'operation' : 'preparation' };
}

/** commandAsync does not know this field until the phase-deadline hook lands. The object still carries it. */
export function phaseCommandOptions(options: {
  runDeadline?: number;
  phaseDeadline: (sample: CommandPhaseSample) => CommandPhaseDecision;
}): { runDeadline?: number } {
  return options;
}
