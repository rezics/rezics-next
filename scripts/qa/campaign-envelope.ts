import { spawn } from 'node:child_process';
import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import { testLogEnvironment } from './core.ts';

/** Medium campaign qualification. Preparation and operation are separate active clocks. */
export const CAMPAIGN_QUALIFICATION_FILE = 'tests/qa/fault-recovery/erasure-campaign-qualification.test.ts';
export const CAMPAIGN_PREPARATION_ACTIVE_MS = 600_000;
export const CAMPAIGN_OPERATION_ACTIVE_MS = 360_000;

export type CampaignEnvelopeFailure = 'preparation' | 'operation' | 'deadline';

export interface CampaignEnvelopeLimits {
  preparationActiveMs: number;
  operationActiveMs: number;
}

export interface CampaignPreparationEvidence {
  activeMs: number;
}

export interface CampaignEnvelopeState {
  preparationActiveElapsedMs?: number;
  preparation?: CampaignPreparationEvidence;
}

export interface CampaignEnvelopeInput {
  now: number;
  startedAt: number;
  /** Completed admission wait, plus any wait still open. Excluded from active time only. */
  admissionWaitMs: number;
  admissionOpen: boolean;
  runDeadline: number;
  /** Runner active elapsed when in-budget preparation evidence was first observed. */
  preparationActiveElapsedMs?: number;
  preparation?: CampaignPreparationEvidence;
}

export interface CampaignEnvelopeDecision {
  phase: 'preparation' | 'operation';
  activeElapsedMs: number;
  preparationActiveMs?: number;
  operationActiveMs?: number;
  activeRemainingMs: number;
  /** Milliseconds until the run deadline. Admission does not move it. */
  wallRemainingMs: number;
  failure?: CampaignEnvelopeFailure;
}

export interface CampaignEnvelopeReport {
  phase: 'preparation' | 'operation';
  preparationActiveMs?: number;
  evidencePreparationActiveMs?: number;
  operationActiveMs?: number;
  admissionWaitMs: number;
  wallMs: number;
  runDeadline: number;
  failure?: CampaignEnvelopeFailure;
}

export interface CampaignEnvelopeRun {
  ok: boolean;
  output: string;
  elapsedMs: number;
  activeElapsedMs: number;
  admissionWaitMs: number;
  timedOut: boolean;
  envelopeFailure?: CampaignEnvelopeFailure;
  report: CampaignEnvelopeReport;
}

interface ResolvedLimits {
  preparationActiveMs: number;
  operationActiveMs: number;
}

export function campaignQualificationShard(files: readonly string[]): boolean {
  return files.length === 1 && files[0] === CAMPAIGN_QUALIFICATION_FILE;
}

/** Backstop for a shard that has already enforced the two clocks. Not an operation timeout. */
export function campaignShardActiveMs(limits?: CampaignEnvelopeLimits): number {
  const resolved = resolveLimits(limits);
  return resolved.preparationActiveMs + resolved.operationActiveMs;
}

export function readCampaignPreparation(parsed: unknown): CampaignPreparationEvidence | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!Object.hasOwn(parsed, 'preparation')) return undefined;
  const preparation = (parsed as { preparation?: unknown }).preparation;
  if (preparation === null || typeof preparation !== 'object' || Array.isArray(preparation)) return undefined;
  const activeMs = (preparation as { activeMs?: unknown }).activeMs;
  if (typeof activeMs !== 'number' || !Number.isFinite(activeMs) || activeMs < 0) return undefined;
  return { activeMs };
}

/** Remember the first in-budget observation. A later write cannot move the operation start. */
export function noteCampaignPreparation(
  state: CampaignEnvelopeState,
  activeElapsedMs: number,
  evidence: CampaignPreparationEvidence | undefined,
  limits?: CampaignEnvelopeLimits,
): CampaignEnvelopeState {
  if (!evidence) return state;
  const resolved = resolveLimits(limits);
  const preparation = evidence;
  if (evidence.activeMs > resolved.preparationActiveMs || activeElapsedMs > resolved.preparationActiveMs) {
    return { preparation, preparationActiveElapsedMs: state.preparationActiveElapsedMs };
  }
  if (state.preparationActiveElapsedMs !== undefined) {
    return { preparation, preparationActiveElapsedMs: state.preparationActiveElapsedMs };
  }
  return { preparation, preparationActiveElapsedMs: activeElapsedMs };
}

export function campaignEnvelopeDecision(
  input: CampaignEnvelopeInput,
  limits?: CampaignEnvelopeLimits,
): CampaignEnvelopeDecision {
  const resolved = resolveLimits(limits);
  const activeElapsedMs = activeElapsed(input);
  const wallRemainingMs = input.runDeadline - input.now;
  if (input.preparation && (!Number.isFinite(input.preparation.activeMs) || input.preparation.activeMs < 0)) {
    throw new Error('Invalid campaign envelope clock');
  }
  if (input.preparationActiveElapsedMs !== undefined && input.preparation === undefined) {
    throw new Error('Invalid campaign envelope clock');
  }
  if (
    input.preparationActiveElapsedMs !== undefined &&
    (!Number.isFinite(input.preparationActiveElapsedMs) || input.preparationActiveElapsedMs < 0 ||
      input.preparationActiveElapsedMs > activeElapsedMs)
  ) throw new Error('Invalid campaign envelope clock');
  const evidence = input.preparation;
  const observed = input.preparationActiveElapsedMs;
  const base = { activeElapsedMs, wallRemainingMs };
  if (wallRemainingMs <= 0) {
    return { ...base, phase: observed === undefined ? 'preparation' : 'operation',
      preparationActiveMs: evidence?.activeMs ?? observed, activeRemainingMs: 0, failure: 'deadline' };
  }
  if (evidence && evidence.activeMs > resolved.preparationActiveMs) {
    return { ...base, phase: 'preparation', preparationActiveMs: evidence.activeMs,
      activeRemainingMs: 0, failure: 'preparation' };
  }
  if (observed !== undefined && observed > resolved.preparationActiveMs) {
    return { ...base, phase: 'preparation', preparationActiveMs: observed,
      activeRemainingMs: 0, failure: 'preparation' };
  }
  if (observed === undefined) {
    const over = !input.admissionOpen && activeElapsedMs > resolved.preparationActiveMs;
    return { ...base, phase: 'preparation',
      preparationActiveMs: evidence?.activeMs,
      activeRemainingMs: over || input.admissionOpen
        ? (input.admissionOpen && !over ? Number.POSITIVE_INFINITY : 0)
        : resolved.preparationActiveMs - activeElapsedMs,
      ...(over ? { failure: 'preparation' as const } : {}) };
  }
  const operationActiveMs = activeElapsedMs - observed;
  const over = !input.admissionOpen && operationActiveMs > resolved.operationActiveMs;
  return { ...base, phase: 'operation', preparationActiveMs: evidence?.activeMs ?? observed, operationActiveMs,
    activeRemainingMs: over || input.admissionOpen
      ? (input.admissionOpen && !over ? Number.POSITIVE_INFINITY : 0)
      : resolved.operationActiveMs - operationActiveMs,
    ...(over ? { failure: 'operation' as const } : {}) };
}

export function campaignEnvelopeWaitMs(decision: CampaignEnvelopeDecision): number {
  if (decision.failure) return 0;
  return Math.max(1, Math.min(decision.activeRemainingMs, decision.wallRemainingMs));
}

export function campaignEnvelopeTimeoutReason(
  name: string,
  failure: CampaignEnvelopeFailure,
  limits?: CampaignEnvelopeLimits,
): string {
  const resolved = resolveLimits(limits);
  if (failure === 'deadline') return `${name} reached its run deadline`;
  if (failure === 'preparation') {
    return `${name} preparation exceeded ${resolved.preparationActiveMs} ms of active work`;
  }
  return `${name} timed out after ${resolved.operationActiveMs} ms of active work`;
}

export async function runCampaignEnvelopeProcess(options: {
  root: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  evidencePath: string;
  runDeadline: number;
  onLine?: (line: string) => void;
  limits?: CampaignEnvelopeLimits;
}): Promise<CampaignEnvelopeRun> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const child = spawn(options.command, options.args, {
    cwd: options.root, detached: true,
    env: options.command === 'bun' && options.args[0] === 'test' ? testLogEnvironment(env) : env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '', timedOut = false, timeoutReason = '';
  let envelopeFailure: CampaignEnvelopeFailure | undefined;
  let admissionStarted = 0, admissionWaitMs = 0;
  const waiting = new Set<string>();
  let state: CampaignEnvelopeState = {};
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let force: ReturnType<typeof setTimeout> | undefined;
  let watcher: FSWatcher | undefined;
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const take = (now = Date.now()) => {
    const open = waiting.size ? now - admissionStarted : 0;
    const admission = admissionWaitMs + open;
    return { now, admission, active: now - startedAt - admission };
  };
  const decide = (now = Date.now()) => {
    const sample = take(now);
    return campaignEnvelopeDecision({
      now: sample.now, startedAt, admissionWaitMs: sample.admission, admissionOpen: waiting.size > 0,
      runDeadline: options.runDeadline, preparationActiveElapsedMs: state.preparationActiveElapsedMs,
      preparation: state.preparation,
    }, options.limits);
  };
  const observeEvidence = () => {
    if (!existsSync(options.evidencePath)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(options.evidencePath, 'utf8')); }
    catch { return; }
    const evidence = readCampaignPreparation(parsed);
    if (!evidence) return;
    state = noteCampaignPreparation(state, take().active, evidence, options.limits);
  };
  const expire = (failure: CampaignEnvelopeFailure) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    timedOut = true;
    envelopeFailure = failure;
    timeoutReason = campaignEnvelopeTimeoutReason(options.command, failure, options.limits);
    terminate('SIGTERM');
    force = setTimeout(() => terminate('SIGKILL'), 1_000);
  };
  const arm = () => {
    if (settled) return;
    if (timer) clearTimeout(timer);
    timer = undefined;
    observeEvidence();
    const decision = decide();
    if (decision.failure) { expire(decision.failure); return; }
    timer = setTimeout(arm, Math.min(campaignEnvelopeWaitMs(decision), 200));
  };
  const observeAdmission = (line: string) => {
    const event = /^QA_MEMORY_WAIT_(BEGIN|END) (\d+-\d+)(?: (\d+))?$/.exec(line);
    if (!event) return;
    if (env.REZICS_QA_MEMORY_EVENTS === '1') console.log(line);
    if (event[1] === 'BEGIN') {
      if (!waiting.size) admissionStarted = Date.now();
      waiting.add(event[2]!);
    } else {
      if (!waiting.delete(event[2]!)) return;
      if (!waiting.size) admissionWaitMs += Date.now() - admissionStarted;
    }
    arm();
  };
  const observe = () => {
    let pending = '';
    return (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        if (env.REZICS_QA_STARTUP_SLOT_GATE && /^QA_STARTUP_SLOT_READY \S+ \S+ \d+$/.test(line)) console.log(line);
        observeAdmission(line);
        options.onLine?.(line);
      }
    };
  };
  const observeStdout = observe(), observeStderr = observe();
  child.stdout?.on('data', chunk => { const value = String(chunk); stdout += value; observeStdout(value); });
  child.stderr?.on('data', chunk => { const value = String(chunk); stderr += value; observeStderr(value); });
  try { watcher = watch(dirname(options.evidencePath), () => arm()); }
  catch { /* the preparation timer still refuses an overrun */ }
  let code: number | null = null;
  let spawnError: string | undefined;
  try {
    arm();
    code = await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  } finally {
    settled = true;
    if (timer) clearTimeout(timer);
    if (force) clearTimeout(force);
    watcher?.close();
    if (child.exitCode === null && !child.killed) terminate('SIGKILL');
  }
  if (waiting.size) {
    admissionWaitMs += Date.now() - admissionStarted;
    waiting.clear();
  }
  observeEvidence();
  const final = decide();
  if (!timedOut && final.failure) {
    timedOut = true;
    envelopeFailure = final.failure;
    timeoutReason = campaignEnvelopeTimeoutReason(options.command, final.failure, options.limits);
  }
  const elapsedMs = Date.now() - startedAt;
  const report: CampaignEnvelopeReport = {
    phase: final.phase,
    preparationActiveMs: final.phase === 'operation'
      ? state.preparationActiveElapsedMs
      : state.preparationActiveElapsedMs ?? final.preparationActiveMs ?? final.activeElapsedMs,
    evidencePreparationActiveMs: state.preparation?.activeMs,
    operationActiveMs: final.operationActiveMs,
    admissionWaitMs, wallMs: elapsedMs, runDeadline: options.runDeadline,
    ...(envelopeFailure ? { failure: envelopeFailure } : {}),
  };
  return {
    ok: code === 0 && !timedOut && !spawnError, elapsedMs, activeElapsedMs: final.activeElapsedMs, admissionWaitMs,
    timedOut, envelopeFailure, report,
    output: [stdout, stderr, timeoutReason, spawnError].filter(Boolean).join('\n'),
  };
}

function resolveLimits(limits?: CampaignEnvelopeLimits): ResolvedLimits {
  const preparationActiveMs = limits?.preparationActiveMs ?? CAMPAIGN_PREPARATION_ACTIVE_MS;
  const operationActiveMs = limits?.operationActiveMs ?? CAMPAIGN_OPERATION_ACTIVE_MS;
  if (!Number.isSafeInteger(preparationActiveMs) || preparationActiveMs < 1 ||
    !Number.isSafeInteger(operationActiveMs) || operationActiveMs < 1) {
    throw new Error('Invalid campaign envelope budget');
  }
  return { preparationActiveMs, operationActiveMs };
}

function activeElapsed(input: CampaignEnvelopeInput): number {
  const span = input.now - input.startedAt;
  if (!Number.isFinite(input.now) || !Number.isFinite(input.startedAt) || !Number.isFinite(input.admissionWaitMs) ||
    !Number.isFinite(input.runDeadline) || input.admissionWaitMs < 0 || span < 0 || input.admissionWaitMs > span) {
    throw new Error('Invalid campaign envelope clock');
  }
  return span - input.admissionWaitMs;
}
