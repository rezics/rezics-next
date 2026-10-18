import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
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
  error: 'configuration' | 'transport' | 'timeout' | 'protocol' | 'busy' | 'account-home' | null;
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
    && card.resetType === 'codexRateLimits' && typeof card.id === 'string' && card.id.trim().length > 0
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
    }
    // Reload authority after waiting: a queued continuation must respect a revoked policy.
    const current = configuredAccounts(options.settings).find(item => item.engine === engine);
    if (!current || current.home !== account.home || current.launcher !== account.launcher) throw new AllowanceError('configuration');
    report.credits.authorized = current.pastAllowance?.includes('credits') === true;
    report.resetCards.authorized = current.pastAllowance?.includes('resetCards') === true;
    const auth = object(await rpc.request('account/read', { refreshToken: false }));
    report.authenticated = object(auth.account).type === 'chatgpt';
    if (!report.authenticated) { report.status = 'unauthenticated'; report.next = 'authenticate'; return report; }
    const read = async () => applyStatus(report, await rpc!.request('account/rateLimits/read',
      { excludeResetCreditDetails: false, supportsLunaReserve: false }), (options.now ?? Date.now)(), options.continue === true);
    const cards = await read();
    if (options.continue && report.ordinaryUsageAllowed === false && report.resetCards.authorized && cards.length) {
      // A lost response is ambiguous. Do not retry a spend; read the backend's permission again.
      report.redemption = 'unconfirmed';
      try {
        const redeemed = object(await rpc.request('account/rateLimitResetCredit/consume', { creditId: cards[0]!.id, idempotencyKey: randomUUID() }));
        if (['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(String(redeemed.outcome))) report.redemption = redeemed.outcome as Redemption;
      } catch { /* A fresh read can confirm recovery even when the redemption response was lost. */ }
      await read();
    }
  } catch (error) {
    report.status = 'unavailable'; report.canResume = false;
    report.error = error instanceof AllowanceError ? error.code : 'configuration';
    report.next = report.error === 'configuration' || report.error === 'account-home' ? 'check-configuration' : 'retry-status';
  } finally {
    // Keep the lease until the request process is gone, including timed-out redemptions.
    try { await rpc?.close(); }
    finally { release?.(); }
  }
  return report;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Listing config launches no MCP servers and includes layers outside the account's config.toml. */
function inheritedMcp(account: CodexAccount, env: NodeJS.ProcessEnv, timeout: number): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    execFile(account.launcher ?? 'codex', ['mcp', 'list', '--json'], { env, timeout, maxBuffer: MAX_RESPONSE_BYTES, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) { reject(new AllowanceError('transport')); return; }
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
