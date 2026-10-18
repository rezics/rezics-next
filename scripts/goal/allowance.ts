import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { configuredAccounts, type CodexAccount, type SettingsOptions } from './config.ts';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

type Method = 'initialize' | 'account/read' | 'account/rateLimits/read' | 'account/rateLimitResetCredit/consume';
export interface AllowanceTransport {
  request(method: Method, params: Record<string, unknown>): Promise<unknown>;
  notify(method: 'initialized'): void;
  close(): Promise<void>;
}
interface AllowanceOptions {
  continue?: boolean;
  settings?: SettingsOptions;
  connect?: (account: CodexAccount) => Promise<AllowanceTransport>;
  now?: () => number;
  lockDirectory?: string;
  requestTimeoutMs?: number;
  leaseTimeoutMs?: number;
}
type Redemption = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | 'unconfirmed';
interface Window { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }
export interface AllowanceReport {
  account: string | null;
  checkedAt: string | null;
  authenticated: boolean | null;
  ordinaryUsageAllowed: boolean | null;
  status: 'included' | 'credits-available' | 'exhausted' | 'permission-unknown' | 'unauthenticated' | 'unavailable';
  canResume: boolean;
  next: 'resume' | 'resume-with-existing-credits' | 'continue' | 'wait-for-reset' | 'retry-status' | 'authenticate' | 'check-configuration';
  quota: { primary: Window | null; secondary: Window | null; spendControlReached: boolean | null; rateLimitReachedType: string | null } | null;
  credits: { authorized: boolean; hasCredits: boolean | null; unlimited: boolean | null; balance: string | null };
  resetCards: { authorized: boolean; availableCount: number | null; eligibleInDetails: number | null };
  redemption: Redemption | null;
  error: 'configuration' | 'transport' | 'timeout' | 'protocol' | 'busy' | 'account-home' | 'account-changed' | 'intent' | null;
}

class AllowanceError extends Error {
  constructor(readonly code: NonNullable<AllowanceReport['error']>) { super(code); }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const boolean = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const integer = (value: unknown): number | null => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
function window(value: unknown): Window | null {
  const raw = object(value), usedPercent = integer(raw.usedPercent);
  return usedPercent === null ? null : { usedPercent, windowDurationMins: integer(raw.windowDurationMins), resetsAt: integer(raw.resetsAt) };
}
function canonicalHome(home: string): string {
  try { return realpathSync(home); } catch { return resolve(home); }
}

interface ResetIntent { version: 1; accountKey: string; creditId: string; idempotencyKey: string }
const MAX_INTENT_BYTES = 4096;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
function accountKey(value: unknown): string | null {
  return identifier(value) ? createHash('sha256').update(value).digest('hex') : null;
}
function readIntent(path: string): ResetIntent | null {
  try {
    if (statSync(path).size > MAX_INTENT_BYTES) throw new Error('oversized');
    const raw = object(JSON.parse(readFileSync(path, 'utf8')));
    if (raw.version !== 1 || typeof raw.accountKey !== 'string' || !/^[0-9a-f]{64}$/.test(raw.accountKey)
      || !identifier(raw.creditId) || typeof raw.idempotencyKey !== 'string'
      || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(raw.idempotencyKey)) throw new Error('invalid');
    return { version: 1, accountKey: raw.accountKey, creditId: raw.creditId, idempotencyKey: raw.idempotencyKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new AllowanceError('intent');
  }
}
function syncIntentDirectory(path: string): void {
  const descriptor = openSync(dirname(path), 'r');
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function saveIntent(path: string, intent: ResetIntent): void {
  try {
    const body = JSON.stringify(intent);
    if (Buffer.byteLength(body) > MAX_INTENT_BYTES) throw new Error('oversized');
    // One slot per home survives process loss; exclusive creation fails closed on an existing intent.
    const descriptor = openSync(path, 'wx', 0o600);
    try { writeFileSync(descriptor, body); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    syncIntentDirectory(path);
  } catch { throw new AllowanceError('intent'); }
}
function clearIntent(path: string): void {
  try { unlinkSync(path); syncIntentDirectory(path); }
  catch { throw new AllowanceError('intent'); }
}

function emptyReport(): AllowanceReport {
  return { account: null, checkedAt: null, authenticated: null, ordinaryUsageAllowed: null,
    status: 'unavailable', canResume: false, next: 'retry-status', quota: null,
    credits: { authorized: false, hasCredits: null, unlimited: null, balance: null },
    resetCards: { authorized: false, availableCount: null, eligibleInDetails: null }, redemption: null, error: null };
}

function applyStatus(report: AllowanceReport, value: unknown, now: number, continuing: boolean): Array<{ id: string; expiresAt: number | null }> {
  const raw = object(value);
  if (!raw.rateLimits || typeof raw.rateLimits !== 'object' || Array.isArray(raw.rateLimits)) throw new AllowanceError('protocol');
  const byId = object(raw.rateLimitsByLimitId);
  const limit = object(byId.codex ?? raw.rateLimits), credits = object(limit.credits), resets = object(raw.rateLimitResetCredits);
  const reached = limit.rateLimitReachedType;
  report.quota = { primary: window(limit.primary), secondary: window(limit.secondary), spendControlReached: boolean(limit.spendControlReached),
    rateLimitReachedType: reached == null ? null : ['rate_limit_reached', 'workspace_owner_credits_depleted', 'workspace_member_credits_depleted',
      'workspace_owner_usage_limit_reached', 'workspace_member_usage_limit_reached'].includes(String(reached)) ? String(reached) : 'unknown' };
  report.credits = { ...report.credits, hasCredits: boolean(credits.hasCredits), unlimited: boolean(credits.unlimited),
    balance: typeof credits.balance === 'string' && /^\d{1,30}(?:\.\d{1,30})?$/.test(credits.balance) ? credits.balance : null };
  report.resetCards.availableCount = integer(resets.availableCount);
  const cards = Array.isArray(resets.credits) ? resets.credits.map(object).filter(card => card.status === 'available'
    && card.resetType === 'codexRateLimits' && identifier(card.id)
    && (card.expiresAt === null || (integer(card.expiresAt) !== null && (card.expiresAt as number) > now / 1000)))
    .map(card => ({ id: card.id as string, expiresAt: card.expiresAt as number | null }))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) : null;
  report.resetCards.eligibleInDetails = cards?.length ?? null;
  report.ordinaryUsageAllowed = boolean(raw.ordinaryUsageAllowed);
  report.checkedAt = new Date(now).toISOString();
  report.canResume = false;
  if (report.ordinaryUsageAllowed === true) {
    report.status = 'included'; report.canResume = true; report.next = 'resume';
  } else if (report.ordinaryUsageAllowed === null) {
    report.status = 'permission-unknown'; report.next = 'retry-status';
  } else if (continuing && report.credits.authorized && (report.credits.hasCredits === true || report.credits.unlimited === true)
    && report.quota.spendControlReached !== true && [null, 'rate_limit_reached'].includes(report.quota.rateLimitReachedType)) {
    report.status = 'credits-available'; report.canResume = true; report.next = 'resume-with-existing-credits';
  } else {
    report.status = 'exhausted';
    report.next = !continuing && ((report.resetCards.authorized && (report.resetCards.availableCount ?? 0) > 0)
      || (report.credits.authorized && (report.credits.hasCredits === true || report.credits.unlimited === true))) ? 'continue' : 'wait-for-reset';
  }
  return (report.resetCards.availableCount ?? 0) > 0 ? cards ?? [] : [];
}

/** Every spend decision reads authenticated status inside the same cross-process account lease. */
export async function inspectAllowance(engine: string, options: AllowanceOptions = {}): Promise<AllowanceReport> {
  const report = emptyReport();
  let rpc: AllowanceTransport | undefined;
  let release: (() => void) | undefined;
  try {
    const account = configuredAccounts(options.settings).find(account => account.engine === engine);
    if (!account) throw new AllowanceError('configuration');
    report.account = account.engine;
    rpc = await (options.connect?.(account) ?? connectAllowance(account, options.requestTimeoutMs));
    const initialized = object(await rpc.request('initialize', { clientInfo: { name: 'rezics_goal_allowance', version: '1.0' },
      capabilities: { experimentalApi: true } }));
    if (typeof initialized.codexHome !== 'string' || !isAbsolute(initialized.codexHome)
      || (account.home && canonicalHome(initialized.codexHome) !== canonicalHome(account.home))) throw new AllowanceError('account-home');
    rpc.notify('initialized');
    // Keep durable intent in the account home, outside the disposable lease directory.
    const intentPath = join(canonicalHome(initialized.codexHome), '.rezics-allowance-reset.json');
    let intent: ResetIntent | null = null;
    if (options.continue) {
      const directory = options.lockDirectory ?? join(tmpdir(), 'rezics-allowance-leases');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const lock = join(directory, createHash('sha256').update(canonicalHome(initialized.codexHome)).digest('hex'));
      const deadline = Date.now() + (options.leaseTimeoutMs ?? 15_000);
      let lease = tryAcquireDirectoryLease(lock, { mode: 0o700 });
      while (lease === 'held') {
        if (Date.now() >= deadline) throw new AllowanceError('busy');
        await Bun.sleep(25);
        lease = tryAcquireDirectoryLease(lock, { mode: 0o700 });
      }
      release = lease.release;
      intent = readIntent(intentPath);
      if (intent) report.redemption = 'unconfirmed';
    }
    let policy: string[] = [];
    const authorize = () => {
      const current = configuredAccounts(options.settings).find(item => item.engine === engine);
      if (!current || current.home !== account.home || current.launcher !== account.launcher) throw new AllowanceError('configuration');
      policy = current.pastAllowance ?? [];
      report.credits.authorized = policy.includes('credits');
      report.resetCards.authorized = policy.includes('resetCards');
    };
    // Reload authority after waiting and after status requests, immediately before any spend.
    authorize();
    const auth = object(await rpc.request('account/read', { refreshToken: false }));
    report.authenticated = object(auth.account).type === 'chatgpt';
    if (!report.authenticated) { report.status = 'unauthenticated'; report.next = 'authenticate'; return report; }
    const read = async (expectedAccount?: string) => {
      const raw = object(await rpc!.request('account/rateLimits/read', { excludeResetCreditDetails: false, supportsLunaReserve: false }));
      authorize();
      const key = accountKey(raw.accountId);
      if (expectedAccount && key === null) throw new AllowanceError('protocol');
      if (expectedAccount && key !== expectedAccount) throw new AllowanceError('account-changed');
      return { raw, key, cards: applyStatus(report, raw, (options.now ?? Date.now)(), options.continue === true) };
    };
    const state = await read(intent?.accountKey);
    if (intent && report.ordinaryUsageAllowed === true) { clearIntent(intentPath); return report; }
    const preferred = policy.find(resource => resource === 'credits' ? report.status === 'credits-available'
      : resource === 'resetCards' && (intent !== null || state.cards.length > 0));
    if (!options.continue || report.ordinaryUsageAllowed !== false || preferred !== 'resetCards') return report;
    const details = object(state.raw.rateLimitResetCredits).credits;
    const pendingCard = intent?.creditId;
    // A redeeming card is still in flight. Missing rows never establish cancellation.
    if (pendingCard && Array.isArray(details) && details.some(card => object(card).id === pendingCard && object(card).status === 'redeeming')) return report;
    if (!intent) {
      if (state.key === null) throw new AllowanceError('protocol');
      intent = { version: 1, accountKey: state.key, creditId: state.cards[0]!.id, idempotencyKey: randomUUID() };
      saveIntent(intentPath, intent);
    }
    report.redemption = 'unconfirmed';
    try {
      const redeemed = object(await rpc.request('account/rateLimitResetCredit/consume', { creditId: intent.creditId, idempotencyKey: intent.idempotencyKey }));
      if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(String(redeemed.outcome))) throw new AllowanceError('protocol');
      report.redemption = redeemed.outcome as Redemption;
    } catch (error) { report.error = error instanceof AllowanceError ? error.code : 'transport'; }
    if (report.redemption !== 'unconfirmed') clearIntent(intentPath);
    const confirmed = await read(intent.accountKey);
    // Permission can recover even when the actual consume response remains unknown.
    if (report.redemption === 'unconfirmed' && confirmed.raw.ordinaryUsageAllowed === true) clearIntent(intentPath);
  } catch (error) {
    report.status = 'unavailable'; report.canResume = false;
    report.error ??= error instanceof AllowanceError ? error.code : 'configuration';
    report.next = ['configuration', 'account-home', 'account-changed', 'intent'].includes(report.error) ? 'check-configuration' : 'retry-status';
  } finally {
    // The lease serializes callers; unresolved backend work remains durable after close.
    try { await rpc?.close(); }
    catch { report.error ??= 'transport'; }
    finally { release?.(); }
  }
  return report;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Listing config launches no MCP servers and includes layers outside the account's config.toml. */
function inheritedMcp(account: CodexAccount, env: NodeJS.ProcessEnv, timeout: number): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(account.launcher ?? 'codex', ['mcp', 'list', '--json'],
      { env, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '', bytes = 0;
    let failure: AllowanceError | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* Already exited. */ }
    };
    const interrupt = () => {
      failure ??= new AllowanceError('transport');
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 500);
    };
    // Enumeration precedes the app-server transport, so it owns signal cleanup until reaped.
    process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
    const timer = setTimeout(interrupt, timeout);
    child.once('error', interrupt);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (failure) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_RESPONSE_BYTES) { interrupt(); return; }
      stdout += chunk;
    });
    child.once('close', code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      kill('SIGKILL');
      process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
      if (failure || code !== 0) { reject(failure ?? new AllowanceError('transport')); return; }
      try {
        const servers: unknown = JSON.parse(stdout);
        if (!Array.isArray(servers) || servers.some(server => typeof object(server).name !== 'string')) throw new AllowanceError('protocol');
        // Empty tables merge with inherited config; explicitly disable every effective server.
        const disabled = servers.map(server => `${JSON.stringify(object(server).name)}={enabled=false}`);
        resolveResult(disabled.length ? ['-c', `mcp_servers={${disabled.join(',')}}`] : []);
      } catch { reject(new AllowanceError('protocol')); }
    });
  });
}

async function connectAllowance(account: CodexAccount, requestTimeout = 10_000): Promise<AllowanceTransport> {
  const env: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: 'off' };
  // Launcher-only accounts select their own home; never inherit the calling worker's account.
  delete env.CODEX_HOME;
  if (account.home) env.CODEX_HOME = account.home;
  const overrides = await inheritedMcp(account, env, requestTimeout);
  const child = spawn(account.launcher ?? 'codex', ['app-server', '--stdio', ...overrides],
    { env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  let sequence = 0, buffer = '', bytes = 0;
  let failure: AllowanceError | undefined;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const fail = (error: AllowanceError) => {
    failure ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const kill = (signal: NodeJS.Signals) => {
    try { if (child.pid) process.kill(-child.pid, signal); } catch { /* Already exited. */ }
  };
  const interrupted = () => { fail(new AllowanceError('transport')); kill('SIGTERM'); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  const exited = new Promise<void>(resolveExit => {
    child.once('close', () => { fail(new AllowanceError('transport')); resolveExit(); });
  });
  child.once('error', () => fail(new AllowanceError('transport')));
  child.stdin.on('error', () => fail(new AllowanceError('transport')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_RESPONSE_BYTES) { fail(new AllowanceError('protocol')); kill('SIGTERM'); return; }
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(line)); } catch { fail(new AllowanceError('protocol')); return; }
      const request = typeof message.id === 'number' && !message.method ? pending.get(message.id) : undefined;
      if (!request) continue;
      clearTimeout(request.timer); pending.delete(message.id as number);
      if (Object.hasOwn(message, 'error')) request.reject(new AllowanceError('transport'));
      else if (Object.hasOwn(message, 'result')) request.resolve(message.result);
      else request.reject(new AllowanceError('protocol'));
    }
  });
  return {
    request(method, params) {
      if (failure) return Promise.reject(failure);
      const id = ++sequence;
      return new Promise((resolveResult, reject) => {
        const timer = setTimeout(() => { fail(new AllowanceError('timeout')); kill('SIGTERM'); }, requestTimeout);
        pending.set(id, { resolve: resolveResult, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    notify(method) {
      if (failure) throw failure;
      child.stdin.write(`${JSON.stringify({ method })}\n`);
    },
    async close() {
      fail(new AllowanceError('transport'));
      child.stdin.end(); kill('SIGTERM');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exited, new Promise<void>(resolveWait => { timer = setTimeout(resolveWait, 500); })]);
        kill('SIGKILL');
        await exited;
      } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      }
    },
  };
}

export async function allowanceCommand(args: string[], options: AllowanceOptions & { print?: (line: string) => void } = {}): Promise<number> {
  const print = options.print ?? console.log;
  const [engine, flag] = args;
  if (!engine || engine.startsWith('-') || args.length > 2 || (flag !== undefined && flag !== '--continue')) {
    print('Usage: goalctl allowance <account> [--continue]'); return 2;
  }
  const report = await inspectAllowance(engine, { ...options, continue: flag === '--continue' });
  print(JSON.stringify(report, null, 2));
  if (report.error === 'configuration') return 2;
  if (report.status === 'unavailable' || report.status === 'unauthenticated') return 1;
  return flag === '--continue' && !report.canResume ? 2 : 0;
}
