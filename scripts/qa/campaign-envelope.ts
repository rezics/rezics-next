/** Medium campaign clocks. Preparation and operation stay separate active limits.
 * Copy selection chooses which fault-file invocation runs; it does not change
 * the 600000 ms preparation clock or the 360000 ms operation clock.
 * This module does not start, signal, or reap processes. commandAsync owns that. */

import { admissionIntervalMs, type CommandPhaseSample } from './core.ts';

export type { CommandPhaseSample };
export const CAMPAIGN_QUALIFICATION_FILE = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
export const CAMPAIGN_PREPARATION_ACTIVE_MS = 600_000;
export const CAMPAIGN_OPERATION_ACTIVE_MS = 360_000;

/** Supplied fixture copies use the same id grammar as campaign source selection. */
export const SUPPLIED_RUN_ID = /^fixture-[a-z0-9-]{1,27}$/;

/** Recorded on every copy. The aggregate refuses a file that narrows it. */
export const CAMPAIGN_DESTRUCTION_SCOPE =
  'only the explicitly retired graph/Lucene fileset; retained fixture, owner objects, backups and media are not destroyed';

export interface CampaignCopyLabel {
  /** 0 rolls the candidate back. 1 activates and irreversibly retires the source. */
  index: 0 | 1;
  /** This file is one of the two copy runs a qualification requires. */
  of: 2;
  path: 'rollback' | 'retirement';
  text: string;
}

export function campaignCopyLabel(index: 0 | 1): CampaignCopyLabel {
  const path = index === 0 ? 'rollback' : 'retirement';
  return { index, of: 2, path, text: `copy ${index} of 2` };
}

export type CampaignCopySelection =
  | { kind: 'pair'; sources: readonly [string, string] | undefined }
  | { kind: 'one'; index: 0 | 1; source: string; label: CampaignCopyLabel };

/** Pair mode keeps today's two-source file. One-copy mode is COPY=0 or 1 and exactly one source. */
export function selectCampaignCopies(sources: string | undefined, copy: string | undefined): CampaignCopySelection {
  const ids = sources === undefined ? undefined : sources.split(',');
  if (copy === undefined) {
    if (ids !== undefined && (ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => !SUPPLIED_RUN_ID.test(id)))) {
      throw new Error('Supply two distinct successful fixture:restore source IDs');
    }
    return { kind: 'pair', sources: ids === undefined ? undefined : [ids[0]!, ids[1]!] };
  }
  if (copy !== '0' && copy !== '1') throw new Error('ERASURE_CAMPAIGN_COPY must be 0 or 1');
  // One invocation owns one source. A second source belongs to the other invocation.
  if (ids === undefined || ids.length !== 1 || !SUPPLIED_RUN_ID.test(ids[0]!)) {
    throw new Error('One campaign copy needs exactly one fixture:restore source ID');
  }
  const index = copy === '0' ? 0 : 1;
  return { kind: 'one', index, source: ids[0]!, label: campaignCopyLabel(index) };
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
  | { kind: 'contradicted' }
  | { kind: 'ready'; reportedActiveMs: number; boundaryActiveMs: number };

export interface CampaignEvidenceRead {
  parsed: unknown;
  readError: boolean;
  modifiedAt: number;
  commandStartedAt: number;
  projectRunId: string;
  activeElapsedMs: number;
  observedAt: number;
  admission?: readonly { start: number; end: number }[];
}

/** First fresh preparation proof. Later file writes do not replace these numbers. */
export interface CampaignProof {
  reportedActiveMs: number;
  boundaryActiveMs: number;
}

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

export function classifyCampaignEvidence(input: CampaignEvidenceRead):
  | Exclude<CampaignEvidenceState, { kind: 'ready' | 'contradicted' }>
  | { kind: 'ready'; reportedActiveMs: number } {
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
  return { kind: 'ready', reportedActiveMs };
}

/** Parent active time when the evidence file was written.
 * The delay until this read is active time only after measured admission is removed.
 * An inconsistent gap does not invent a boundary. */
export function preparationBoundaryActiveMs(input: {
  activeElapsedMs: number;
  observedAt: number;
  modifiedAt: number;
  commandStartedAt: number;
  admission?: readonly { start: number; end: number }[];
}): number | undefined {
  if (!Number.isFinite(input.activeElapsedMs) || input.activeElapsedMs < 0) return undefined;
  if (!Number.isFinite(input.observedAt) || !Number.isFinite(input.modifiedAt) || !Number.isFinite(input.commandStartedAt)) {
    return undefined;
  }
  if (input.modifiedAt < input.commandStartedAt) return undefined;
  const gap = input.observedAt - input.modifiedAt;
  if (!Number.isFinite(gap)) return undefined;
  if (gap <= 0) return input.activeElapsedMs;
  const admission = admissionIntervalMs(input.admission ?? [], input.modifiedAt, input.observedAt);
  if (!Number.isFinite(admission) || admission < 0 || admission > gap) return undefined;
  const boundary = input.activeElapsedMs - (gap - admission);
  if (!Number.isFinite(boundary) || boundary < 0) return undefined;
  return boundary;
}

export interface CampaignEvidenceWatch {
  readonly proof: CampaignProof | undefined;
  readonly contradicted: boolean;
  observe(input: CampaignEvidenceRead, when?: 'poll' | 'final'): CampaignEvidenceState;
}

/** Remember the first fresh preparation proof. Later rewrites are checked against it. */
export function openCampaignEvidence(): CampaignEvidenceWatch {
  let proof: CampaignProof | undefined;
  let contradicted = false;
  return {
    get proof() { return proof; },
    get contradicted() { return contradicted; },
    observe(input, when = 'poll') {
      if (contradicted) return { kind: 'contradicted' };
      const evidence = classifyCampaignEvidence(input);
      if (proof === undefined) {
        if (evidence.kind !== 'ready') return evidence;
        const boundaryActiveMs = preparationBoundaryActiveMs(input);
        if (boundaryActiveMs === undefined) return { kind: 'refused' };
        proof = { reportedActiveMs: evidence.reportedActiveMs, boundaryActiveMs };
        return { kind: 'ready', reportedActiveMs: evidence.reportedActiveMs, boundaryActiveMs };
      }
      if (evidence.kind === 'ready' && evidence.reportedActiveMs === proof.reportedActiveMs) {
        return { kind: 'ready', reportedActiveMs: proof.reportedActiveMs, boundaryActiveMs: proof.boundaryActiveMs };
      }
      // A torn rewrite is unreadable JSON. The child is still writing during a poll,
      // so that read keeps the first proof. The read after the command must be whole.
      if (when === 'poll' && evidence.kind === 'ignored') {
        return { kind: 'ready', reportedActiveMs: proof.reportedActiveMs, boundaryActiveMs: proof.boundaryActiveMs };
      }
      contradicted = true;
      return { kind: 'contradicted' };
    },
  };
}

export function campaignPhaseDeadline(
  sample: CommandPhaseSample,
  evidence: CampaignEvidenceState,
  commandName = 'bun',
): CommandPhaseDecision {
  if (!Number.isFinite(sample.activeElapsedMs) || sample.activeElapsedMs < 0) {
    throw new Error('Invalid campaign envelope clock');
  }
  if (evidence.kind === 'contradicted') {
    return {
      phase: 'preparation', activeLimitMs: CAMPAIGN_PREPARATION_ACTIVE_MS,
      reason: `${commandName} campaign evidence was refused`,
    };
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
}): { ok: boolean; failure?: 'preparation' | 'operation' | 'missing-preparation' | 'evidence' } {
  if (input.timedOut || !input.exitOk) return { ok: false };
  if (input.evidence.kind === 'contradicted') return { ok: false, failure: 'evidence' };
  if (input.evidence.kind !== 'ready') return { ok: false, failure: 'missing-preparation' };
  const decision = campaignPhaseDeadline(input.sample, input.evidence);
  if (!decision.reason) return { ok: true };
  return { ok: false, failure: decision.phase === 'operation' ? 'operation' : 'preparation' };
}

const CAMPAIGN_SHA256 = /^[0-9a-f]{64}$/;

function campaignRecord(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Label on one qualification.json. Index, path and the "copy N of 2" text must agree. */
export function readCampaignCopyLabel(value: unknown): CampaignCopyLabel {
  const record = campaignRecord(value, 'Campaign evidence has no copy label');
  const index = record.index;
  if (index !== 0 && index !== 1) throw new Error('Campaign evidence copy index must be 0 or 1');
  const label = campaignCopyLabel(index);
  if (record.of !== label.of || record.path !== label.path || record.text !== label.text) {
    throw new Error('Campaign evidence must say it is one of two');
  }
  return label;
}

function campaignCopyPhases(index: 0 | 1): readonly string[] {
  const common = [
    `source-${index}-start`, `source-${index}-pins`, `source-${index}-work-count`,
    `source-${index}-samples`, `source-${index}-stop`, `copy-${index}-seed`, `copy-${index}-run`,
    `copy-compact-index-${index}`, `verify-${index}`,
  ];
  return index === 0
    ? [...common, 'activation-before-rollback', 'rollback']
    : [...common, 'activation', 'active-restart', 'retirement'];
}

function phaseNamesOtherCopy(index: 0 | 1, name: string): boolean {
  const other = index === 0 ? 1 : 0;
  if (name.startsWith(`source-${other}-`) || name.startsWith(`copy-${other}-`)) return true;
  if (name === `copy-compact-index-${other}` || name === `verify-${other}`) return true;
  if (index === 0) return name === 'activation' || name === 'active-restart' || name === 'retirement';
  return name === 'activation-before-rollback' || name === 'rollback';
}

export interface ReadCampaignCopy {
  label: CampaignCopyLabel;
  profile: string;
  fixtureId: string;
  manifestSha256: string;
  source: string;
  stateVolume: string;
}

/** One invocation's qualification.json: its own copy only, with that copy's phases. */
export function readCampaignCopyEvidence(evidence: unknown): ReadCampaignCopy {
  const record = campaignRecord(evidence, 'Campaign evidence is not an object');
  if (Object.hasOwn(record, 'failure')) throw new Error('Campaign copy evidence records a failure');
  if (typeof record.completedAt !== 'string' || record.completedAt.length === 0) {
    throw new Error('Campaign copy evidence is incomplete');
  }
  const label = readCampaignCopyLabel(record.copy);
  if (record.destructionScope !== CAMPAIGN_DESTRUCTION_SCOPE) {
    throw new Error('Campaign copy destruction scope does not match');
  }
  if (record.profile !== 'small' && record.profile !== 'medium') {
    throw new Error('Campaign copy profile must be small or medium');
  }
  const fixture = campaignRecord(record.fixture, 'Campaign copy evidence has no fixture');
  const manifest = campaignRecord(fixture.manifest, 'Campaign copy evidence has no fixture manifest');
  const fixtureId = manifest.id;
  const manifestSha256 = fixture.manifestSha256;
  if (typeof fixtureId !== 'string' || !fixtureId || /\s/.test(fixtureId)) {
    throw new Error('Campaign copy evidence has no fixture id');
  }
  if (typeof manifestSha256 !== 'string' || !CAMPAIGN_SHA256.test(manifestSha256)) {
    throw new Error('Campaign copy evidence has no fixture manifest digest');
  }
  if (!Array.isArray(record.copies) || record.copies.length !== 1) {
    throw new Error('Campaign evidence must contain exactly one copy');
  }
  const copy = campaignRecord(record.copies[0], 'Campaign evidence must contain exactly one copy');
  const source = copy.id;
  const stateVolume = copy.stateVolume;
  if (typeof source !== 'string' || !SUPPLIED_RUN_ID.test(source)) {
    throw new Error('Campaign copy source id is invalid');
  }
  if (typeof stateVolume !== 'string' || stateVolume.length === 0 || stateVolume === fixtureVolume(fixtureId)) {
    throw new Error('Campaign copy state volume is missing or is the retained fixture');
  }
  if (isRecord(copy.pins) && copy.pins.stateVolume !== undefined && copy.pins.stateVolume !== stateVolume) {
    throw new Error('Campaign copy pins do not match its state volume');
  }
  if (!isRecord(copy.measurements)) throw new Error('Campaign copy evidence is missing measurements');
  if (typeof copy.ready !== 'string' || !copy.ready.includes('campaign-sha256=')) {
    throw new Error('Campaign copy evidence is missing readiness');
  }
  if (label.index === 0) {
    if (Object.hasOwn(copy, 'retirement')) throw new Error('Copy 0 must not retire the source');
  } else {
    const retirement = campaignRecord(copy.retirement, 'Copy 1 has no retirement evidence');
    if (typeof retirement.hash !== 'string' || !CAMPAIGN_SHA256.test(retirement.hash)) {
      throw new Error('Copy 1 has no retirement evidence');
    }
  }
  const phases = campaignRecord(record.phases, 'Campaign copy evidence has no phases');
  const details = campaignRecord(record.phaseDetails, 'Campaign copy evidence has no phases');
  for (const name of Object.keys(phases).concat(Object.keys(details))) {
    if (phaseNamesOtherCopy(label.index, name)) {
      throw new Error(`Campaign copy ${label.index} evidence includes the other copy`);
    }
  }
  for (const name of campaignCopyPhases(label.index)) {
    const elapsed = phases[name];
    const detail = details[name];
    if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0
      || !isRecord(detail) || detail.status !== 'succeeded') {
      throw new Error(`Campaign copy ${label.index} evidence is missing ${name}`);
    }
  }
  return {
    label, profile: record.profile, fixtureId, manifestSha256, source, stateVolume,
  };
}

/** Retained fixture volume the live pin check isolates. Neither copy may be this volume. */
export function fixtureVolume(fixtureId: string): string {
  return `rezics-fixture-${fixtureId}_fuseki_data`;
}

export interface CampaignCopyAggregate {
  fixtureId: string;
  manifestSha256: string;
  profile: string;
  sources: readonly [string, string];
  stateVolumes: readonly [string, string];
}

/** Both one-copy evidence files. Order does not matter. Refuses a shared source or volume. */
export function aggregateCampaignCopies(first: unknown, second: unknown): CampaignCopyAggregate {
  const copies = [readCampaignCopyEvidence(first), readCampaignCopyEvidence(second)];
  const rollback = copies.find(copy => copy.label.index === 0);
  const retirement = copies.find(copy => copy.label.index === 1);
  if (!rollback || !retirement || copies[0]!.label.index === copies[1]!.label.index) {
    throw new Error('Campaign qualification needs copy 0 and copy 1 evidence');
  }
  if (rollback.label.path !== 'rollback' || retirement.label.path !== 'retirement') {
    throw new Error('Campaign copy path does not match its index');
  }
  if (rollback.fixtureId !== retirement.fixtureId || rollback.manifestSha256 !== retirement.manifestSha256) {
    throw new Error('Campaign copies must restore the same fixture');
  }
  if (rollback.profile !== retirement.profile) throw new Error('Campaign copies must use the same profile');
  if (rollback.source === retirement.source) throw new Error('Campaign copies share a source');
  if (rollback.stateVolume === retirement.stateVolume) throw new Error('Campaign copies share a state volume');
  const retained = fixtureVolume(rollback.fixtureId);
  if (rollback.stateVolume === retained || retirement.stateVolume === retained) {
    throw new Error('Campaign copy state volume is the retained fixture');
  }
  return {
    fixtureId: rollback.fixtureId,
    manifestSha256: rollback.manifestSha256,
    profile: rollback.profile,
    sources: [rollback.source, retirement.source],
    stateVolumes: [rollback.stateVolume, retirement.stateVolume],
  };
}
