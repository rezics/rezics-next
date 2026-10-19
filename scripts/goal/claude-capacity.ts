import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { settingsDirectory } from './config.ts';
import { git, readLedger, root, stateDir, withLedger } from './ledger.ts';
import { engineOf, isClaudeCode, type Attempt, type Brief, type Ledger, type Task } from './types.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from '../qa/process/identity.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

// Claude Code 2.1.302's native usage reader uses this GET and beta. Never persist its credentials,
// headers or response body. This is a usage read, not a model request or a billing mutation.
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CAPACITY_FRESH_MS = 45_000;
export const CAPACITY_POLL_MS = 30_000;
export const CAPACITY_TIMEOUT_MS = 10_000;
export interface CapacityWindow { used: number; resetsAt: number }
const capacityErrors = ['credentials-missing', 'credentials-expired', 'unauthorized', 'rate-limited', 'request-failed',
  'timeout', 'invalid-response', 'paid-usage-enabled', 'paid-usage-unknown', 'refresh-in-progress'] as const;
export interface CapacityObservation {
  observedAt: number; five_hour?: CapacityWindow; seven_day?: CapacityWindow;
  error?: typeof capacityErrors[number];
}
export interface CapacityCache { current: CapacityObservation; previous?: CapacityObservation }
export interface ClaudeGrant {
  brief: string; digest: string; purpose: 'frontend-implementation' | 'frontend-research'; researchTask: string;
}
export interface CapacityPolicy {
  version: 1; repository: string; enabled: boolean;
  review?: { sha: string; by: 'codex-1/xhigh'; fingerprint: string };
  aboutCompletion?: { verifiedAt: string; evidence: string };
  tasks: Record<string, ClaudeGrant>;
}
interface CapacityPause {
  at: number; stage: 'interrupt' | 'terminate' | 'kill' | 'waiting'; signalledAt: number;
  five_hour?: CapacityWindow; seven_day?: CapacityWindow; reason: string;
}
export type CapacityTask = Task & {
  claudeCapacity?: { attempt: number; owner: ProcessIdentity; observation?: CapacityObservation; pause?: CapacityPause };
};
export const capacityFiles = () => ({ policy: join(settingsDirectory(), 'claude-capacity.user.json'),
  observation: join(stateDir, 'claude-capacity.json') });
export const capacitySourceFiles = ['claude-capacity.ts', 'commands/claude-capacity.ts', 'launch.ts', 'usage.ts',
  'tasks.ts', 'coordinator.ts', 'settle.ts', 'job.ts'].map(file => join(import.meta.dir, file));
export function capacityFingerprint(): string {
  return createHash('sha256').update(capacitySourceFiles.map(file => readFileSync(file, 'utf8')).join('\0')).digest('hex');
}
export function briefDigest(file: string): string { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
export function writeCapacityFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, file);
}
export function readCapacityPolicy(file = capacityFiles().policy): CapacityPolicy | undefined {
  try {
    const policy = JSON.parse(readFileSync(file, 'utf8')) as CapacityPolicy;
    if (policy.version !== 1 || resolve(policy.repository) !== resolve(root) || typeof policy.enabled !== 'boolean'
      || !policy.tasks || typeof policy.tasks !== 'object' || Array.isArray(policy.tasks)) return;
    if (policy.aboutCompletion && (!policy.aboutCompletion.evidence?.trim()
      || !Number.isFinite(Date.parse(policy.aboutCompletion.verifiedAt)))) return;
    return policy;
  } catch { return; }
}
export function readCapacityCache(file = capacityFiles().observation): CapacityCache | undefined {
  // Rebuild rather than trusting a local JSON cast: corrupt/old caches must not disable the stop pass,
  // and unexpected response fields must never escape through status or a later refresh.
  const observation = (value: unknown): CapacityObservation | undefined => {
    const item = value as CapacityObservation | null;
    if (!item || !Number.isFinite(item.observedAt) || (item.error !== undefined && !capacityErrors.includes(item.error))) return;
    const window = (value: CapacityWindow | undefined): CapacityWindow | undefined => value
      && Number.isFinite(value.used) && value.used >= 0 && value.used <= 100 && Number.isFinite(value.resetsAt)
      ? { used: value.used, resetsAt: value.resetsAt } : undefined;
    const five_hour = window(item.five_hour), seven_day = window(item.seven_day);
    return { observedAt: item.observedAt, five_hour, seven_day,
      ...((item.error || !five_hour || !seven_day) ? { error: item.error ?? 'invalid-response' } : {}) };
  };
  try {
    const cache = JSON.parse(readFileSync(file, 'utf8')) as CapacityCache | null;
    const current = observation(cache?.current);
    return current ? { current, previous: observation(cache?.previous) } : undefined;
  } catch { return; }
}
function windowFromProvider(value: unknown): CapacityWindow | undefined {
  const item = value as { utilization?: unknown; resets_at?: unknown } | null;
  if (!item || typeof item.utilization !== 'number' || !Number.isFinite(item.utilization)
    || item.utilization < 0 || item.utilization > 100 || typeof item.resets_at !== 'string') return;
  const resetsAt = Date.parse(item.resets_at);
  return Number.isFinite(resetsAt) ? { used: item.utilization, resetsAt } : undefined;
}
export function normalizeClaudeUsage(value: unknown, observedAt: number): CapacityObservation {
  const body = value as { five_hour?: unknown; seven_day?: unknown; extra_usage?: { is_enabled?: unknown } } | null;
  const five_hour = windowFromProvider(body?.five_hour), seven_day = windowFromProvider(body?.seven_day);
  const error = body?.extra_usage?.is_enabled === true ? 'paid-usage-enabled'
    : body?.extra_usage?.is_enabled !== false ? 'paid-usage-unknown'
    : !five_hour || !seven_day ? 'invalid-response' : undefined;
  return { observedAt, five_hour, seven_day, ...(error ? { error } : {}) };
}
export async function fetchClaudeCapacity(options: {
  credentialFile?: string; now?: () => number; timeoutMs?: number;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
} = {}): Promise<CapacityObservation> {
  const now = options.now ?? Date.now;
  const timeout = Math.min(CAPACITY_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? CAPACITY_TIMEOUT_MS));
  const failure = (error: CapacityObservation['error']): CapacityObservation => ({ observedAt: now(), error });
  let credential: { accessToken?: string; expiresAt?: number } | undefined;
  try {
    const stored = JSON.parse(readFileSync(options.credentialFile
      ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: typeof credential;
    };
    credential = stored.claudeAiOauth;
  } catch { return failure('credentials-missing'); }
  if (!credential?.accessToken || typeof credential.accessToken !== 'string') return failure('credentials-missing');
  if (typeof credential.expiresAt !== 'number' || !Number.isFinite(credential.expiresAt)
    || credential.expiresAt <= now() + timeout + 60_000) return failure('credentials-expired');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await (options.fetcher ?? fetch)(CLAUDE_USAGE_URL, { method: 'GET', redirect: 'error',
          signal: controller.signal, headers: { Authorization: `Bearer ${credential.accessToken}`,
            'anthropic-beta': 'oauth-2025-04-20' } });
        if (response.status === 401) return failure('unauthorized');
        if (response.status === 429) return failure('rate-limited');
        if (!response.ok) return failure('request-failed');
        const reader = response.body?.getReader();
        if (!reader) return failure('invalid-response');
        const decoder = new TextDecoder();
        let body = '', size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 64 * 1024) return failure('invalid-response');
          body += decoder.decode(chunk.value, { stream: true });
        }
        let value: unknown;
        try { value = JSON.parse(body + decoder.decode()); } catch { return failure('invalid-response'); }
        return normalizeClaudeUsage(value, now());
      })(),
      new Promise<CapacityObservation>(resolveTimeout => {
        timer = setTimeout(() => { controller.abort(); resolveTimeout(failure('timeout')); }, timeout);
      }),
    ]);
  } catch { return failure('request-failed'); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function refreshClaudeCapacity(options: Parameters<typeof fetchClaudeCapacity>[0] & { file?: string } = {}): Promise<CapacityCache> {
  const file = options.file ?? capacityFiles().observation;
  mkdirSync(dirname(file), { recursive: true });
  const lease = tryAcquireDirectoryLease(`${file}.lock`);
  if (lease === 'held') return { current: { observedAt: (options.now ?? Date.now)(), error: 'refresh-in-progress' } };
  try {
    const old = readCapacityCache(file);
    const current = await fetchClaudeCapacity(options);
    const previous = old?.current.error ? old.previous : old?.current;
    const cache = { current, previous };
    writeCapacityFile(file, cache);
    return cache;
  } finally { lease.release(); }
}
function validWindow(window: CapacityWindow | undefined, now: number): window is CapacityWindow {
  return !!window && Number.isFinite(window.used) && window.used >= 0 && window.used <= 100
    && Number.isFinite(window.resetsAt) && window.resetsAt > now;
}
export function capacityDecision(cache: CapacityCache | undefined, released = false, now = Date.now()) {
  const current = cache?.current;
  const age = current ? now - current.observedAt : Infinity;
  // A passed timestamp is not a reset observation. In particular a seven-day-only cache cannot admit.
  if (!current || current.error || !Number.isFinite(age) || age < 0 || age > CAPACITY_FRESH_MS
    || !validWindow(current.five_hour, now) || !validWindow(current.seven_day, now)) {
    return { admit: false, stop: true, reason: current?.error ?? 'capacity-unknown', margin: 10, stopAt: released ? 100 : 200 / 3 - 10 };
  }
  const previous = cache?.previous;
  const elapsed = previous ? current.observedAt - previous.observedAt : 0;
  // Two minutes of the measured shared-account rise cover polling, provider lag and cancellation.
  // Ten points is a conservative floor, NOT a measured upper bound on a provider's active call.
  const rise = previous?.five_hour?.resetsAt === current.five_hour.resetsAt && elapsed > 0
    ? Math.max(0, current.five_hour.used - previous.five_hour.used) * 120_000 / elapsed : 0;
  const margin = Math.max(10, rise);
  const stopAt = released ? 100 : 200 / 3 - margin;
  const exhausted = current.seven_day.used >= 100 || current.five_hour.used >= 100;
  const stop = exhausted || current.five_hour.used >= stopAt;
  return { admit: !exhausted && current.five_hour.used < (released ? 100 : stopAt - 5), stop,
    reason: exhausted ? 'allowance-exhausted' : stop ? 'about-reserve' : 'available', margin, stopAt };
}
export function providerReset(previous: CapacityWindow | undefined, current: CapacityWindow | undefined, at: number): boolean {
  // The account is shared: about may already have consumed the new window when we observe it.
  return !!previous && validWindow(current, at) && at >= previous.resetsAt && current.resetsAt > previous.resetsAt;
}
export function capacityStatus() {
  const files = capacityFiles(), policy = readCapacityPolicy(files.policy), cache = readCapacityCache(files.observation);
  return { files, enabled: policy?.enabled === true, reserveReleased: !!policy?.aboutCompletion,
    reviewed: policy?.review?.by === 'codex-1/xhigh' && policy.review.fingerprint === capacityFingerprint(),
    policy, cache, decision: capacityDecision(cache, !!policy?.aboutCompletion) };
}
const refusal = (reason: string): Error => new Error(`Claude usage is restricted (${reason}); capacity refresh/status required`);
export function claudeGrantError(policy: CapacityPolicy, id: string, ledger: Ledger): string | undefined {
  const grant = policy.tasks[id];
  if (!grant || !['frontend-implementation', 'frontend-research'].includes(grant.purpose)) return 'reviewed frontend brief required';
  try {
    const file = resolve(grant.brief);
    if (!file.startsWith(`${resolve(root)}/`) || briefDigest(file) !== grant.digest) return 'reviewed brief changed';
  } catch { return 'reviewed brief missing'; }
  const research = ledger.tasks[grant.researchTask];
  const attempt = research?.attempts.at(-1);
  if (!research || !['verified', 'merged'].includes(research.state) || !attempt
    || engineOf(attempt) !== 'codex-2' || attempt.effort !== 'max') return 'completed codex-2/max research required';
}
export function assertClaudeCapacity(engine: string, task?: Pick<Brief, 'id' | 'land'>, ledger = readLedger()): void {
  if (!isClaudeCode(engine)) return;
  const status = capacityStatus();
  if (!status.enabled || !status.reviewed) throw refusal('policy disabled or independent review missing');
  if (!status.decision.admit) throw refusal(status.decision.reason);
  if (task) {
    if (task.land === 'auto') throw refusal('automatic landing is not allowed');
    const error = claudeGrantError(status.policy!, task.id, ledger);
    if (error) throw refusal(error);
    const managed = ledger.tasks[task.id] as CapacityTask | undefined;
    if (managed && (resolve(managed.brief) !== resolve(status.policy!.tasks[task.id]!.brief)
      || git(managed.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true) !== join(root, '.git'))) {
      throw refusal('worker belongs to another repository or brief');
    }
    if (managed?.claudeCapacity?.pause && !pauseCanResume(managed.claudeCapacity.pause, status.cache!, status.policy?.aboutCompletion)) {
      throw refusal('waiting for provider-confirmed reset');
    }
  }
}
/** Ledger state is checkpointed before signalling. It cannot prove that the old writer has exited. */
export function assertPreviousClaudeExited(task: Task): void {
  const record = (task as CapacityTask).claudeCapacity, attempt = task.attempts.at(-1);
  if (record && attempt && record.attempt === attempt.n && record.owner.pid === attempt.pid
    && isClaudeCode(engineOf(attempt)) && sameProcess(record.owner)) {
    throw new Error(`${task.id}: previous Claude process ${attempt.pid} is still running; wait for it to exit before resuming`);
  }
}
export function recordClaudeLaunch(task: Task, attempt: Attempt): void {
  if (!isClaudeCode(engineOf(attempt))) {
    // An explicit engine handover resumes the task too; a former Claude pause must not suppress
    // settlement of its new engine. Keep the marker that requires a manager landing decision.
    if ((task as CapacityTask).claudeCapacity) delete (task as CapacityTask).claudeCapacity!.pause;
    return;
  }
  const owner = processIdentity(attempt.pid);
  if (!owner) throw refusal('cannot identify launched process');
  const cache = readCapacityCache();
  (task as CapacityTask).claudeCapacity = { attempt: attempt.n, owner,
    observation: cache?.current.error ? cache.previous : cache?.current };
}
export function pauseCanResume(pause: CapacityPause, cache: CapacityCache, completion?: CapacityPolicy['aboutCompletion']): boolean {
  const current = cache.current;
  if (!capacityDecision(cache, !!completion, current.observedAt).admit) return false;
  // Policy, review, grant and observation faults need their actual cause repaired, not a future reset.
  // Both admission and the controller recheck policy/review/grants before using this decision.
  if (pause.reason !== 'about-reserve' && pause.reason !== 'allowance-exhausted') return true;
  // Explicit completion verification releases a reserve pause without pretending a reset happened.
  if (pause.reason === 'about-reserve' && completion && Date.parse(completion.verifiedAt) >= pause.at) return true;
  return pause.seven_day?.used === 100
    ? providerReset(pause.seven_day, current.seven_day, current.observedAt)
    : providerReset(pause.five_hour, current.five_hour, current.observedAt);
}
export function ownsClaudeProcess(task: CapacityTask, procRoot = '/proc'): boolean {
  const record = task.claudeCapacity, attempt = task.attempts.at(-1);
  if (!record || !attempt || record.attempt !== attempt.n || record.owner.pid !== attempt.pid
    || !isClaudeCode(engineOf(attempt)) || !sameProcess(record.owner, procRoot)
    || git(task.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], true) !== join(root, '.git')) return false;
  try {
    const env = readFileSync(join(procRoot, String(record.owner.pid), 'environ'), 'utf8').split('\0');
    return env.includes(`GOAL_TASK_ID=${task.id}`) && env.includes(`GOAL_WORKTREE=${resolve(task.worktree)}`);
  } catch { return false; }
}
export interface CapacityPassOptions {
  policy?: CapacityPolicy; cache?: CapacityCache; now?: number;
  mutate?: (work: (ledger: Ledger) => void) => Promise<unknown>;
  owns?: (task: CapacityTask) => boolean;
  signal?: (task: CapacityTask, signal: NodeJS.Signals) => void;
}
/** The coordinator is the only loop. It checkpoints before interrupting, never sweeps a cwd/group,
 * and never turns an interrupted caller into a completed worker. Native transcripts and dirty files
 * remain in place. SIGINT cannot retract already billed server work; no absolute spend bound exists.
 * https://code.claude.com/docs/en/cli-reference#cli-flags documents the budget flag's overshoot too. */
export async function coordinateClaudeCapacity(options: CapacityPassOptions = {}): Promise<void> {
  const found = options.policy ?? readCapacityPolicy();
  if (!found && !Object.values(readLedger().tasks).some(task => (task as CapacityTask).claudeCapacity)) return;
  const policy: CapacityPolicy = found ?? { version: 1, repository: root, enabled: false, tasks: {} };
  const reviewed = policy.review?.by === 'codex-1/xhigh' && policy.review.fingerprint === capacityFingerprint();
  let now = options.now ?? Date.now();
  let cache = options.cache ?? readCapacityCache();
  if (policy.enabled && !options.cache && (!cache || now < cache.current.observedAt || now - cache.current.observedAt >= CAPACITY_POLL_MS)) {
    cache = await refreshClaudeCapacity();
    now = options.now ?? Date.now();
  }
  const decision = capacityDecision(cache, !!policy.aboutCompletion, now);
  const owns = options.owns ?? ownsClaudeProcess;
  const signal = options.signal ?? ((task, value) => {
    if (ownsClaudeProcess(task)) { try { process.kill(task.claudeCapacity!.owner.pid, value); } catch { /* exited */ } }
  });
  await (options.mutate ?? withLedger)(ledger => {
    for (const entry of Object.values(ledger.tasks)) {
      const task = entry as CapacityTask, record = task.claudeCapacity, attempt = task.attempts.at(-1);
      if (!record || !attempt || record.attempt !== attempt.n || !isClaudeCode(engineOf(attempt))
        || !['running', 'stopped', 'exited'].includes(task.state)) continue;
      if (!record.pause && cache && !cache.current.error && validWindow(cache.current.five_hour, now)
        && validWindow(cache.current.seven_day, now) && now >= cache.current.observedAt
        && now - cache.current.observedAt <= CAPACITY_FRESH_MS) record.observation = cache.current;
      const reason = !policy.enabled ? 'policy-stopped' : !reviewed ? 'source-review-required'
        : decision.stop ? decision.reason : claudeGrantError(policy, task.id, ledger);
      if (!record.pause && owns(task) && reason) {
        const observed = record.observation ?? cache?.previous;
        record.pause = { at: now, signalledAt: now, stage: 'interrupt', reason,
          five_hour: observed?.five_hour, seven_day: observed?.seven_day };
        task.state = 'stopped';
        // The surrounding ledger transaction must reach disk before the signal (below).
      }
    }
  });
  await (options.mutate ?? withLedger)(ledger => {
    for (const entry of Object.values(ledger.tasks)) {
      const task = entry as CapacityTask, record = task.claudeCapacity, pause = record?.pause, attempt = task.attempts.at(-1);
      if (!record || !pause || !attempt || record.attempt !== attempt.n || task.state !== 'stopped') continue;
      if (owns(task)) {
        if (pause.stage === 'interrupt' && now - pause.signalledAt < 5000) signal(task, 'SIGINT');
        else if (pause.stage === 'interrupt' || pause.stage === 'terminate') {
          const value = pause.stage === 'interrupt' ? 'SIGTERM' : 'SIGKILL';
          signal(task, value); pause.stage = value === 'SIGTERM' ? 'terminate' : 'kill'; pause.signalledAt = now;
        } else signal(task, 'SIGKILL');
        continue;
      }
      if (sameProcess(record.owner)) continue;
      attempt.endedAt ??= new Date(now).toISOString();
      pause.stage = 'waiting';
      if (policy.enabled && reviewed && cache && decision.admit && pauseCanResume(pause, cache, policy.aboutCompletion)
        && !claudeGrantError(policy, task.id, ledger) && !task.waitingResume) {
        task.waitingResume = { token: randomUUID(), queuedAt: new Date(now).toISOString(),
          reason: ['about-reserve', 'allowance-exhausted'].includes(pause.reason)
            ? pauseCanResume(pause, cache) ? 'provider-confirmed Claude reset' : 'verified about completion released the reserve'
            : `Claude capacity pause resolved: ${pause.reason}`, fresh: false, forceUsage: false,
          message: 'The capacity controller interrupted your previous turn. Inspect retained dirty files and commits, '
            + 'then resume the reviewed brief from the same native session. The interruption was not a handoff.' };
      }
    }
  });
}
export function editCapacityPolicy(work: (policy: CapacityPolicy) => void): CapacityPolicy {
  const file = capacityFiles().policy;
  mkdirSync(dirname(file), { recursive: true });
  const lease = tryAcquireDirectoryLease(`${file}.lock`);
  if (lease === 'held') throw new Error('Claude capacity policy is being edited');
  try {
    if (existsSync(file) && !readCapacityPolicy(file)) throw new Error('Invalid local Claude capacity policy');
    const policy = readCapacityPolicy(file) ?? { version: 1, repository: root, enabled: false, tasks: {} };
    work(policy); writeCapacityFile(file, policy); return policy;
  } finally { lease.release(); }
}
