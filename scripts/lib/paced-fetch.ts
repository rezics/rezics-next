import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const digestPattern = /^[a-f0-9]{64}$/;

export const sha256 = (bytes: string | Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

/** A digest address whose file no longer contains those bytes. */
export class CorruptBytes extends Error {
  constructor(
    readonly path: string,
    readonly digest: string,
  ) {
    super(`Cached bytes are corrupt: ${digest}`);
  }
}

/** The attempt bound was spent on retryable responses. */
export class PacedRetriesExhausted extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Paced fetch exhausted retries: HTTP ${status} ${url}`);
  }
}

function assertDigest(digest: string): void {
  if (!digestPattern.test(digest)) throw new Error('Invalid byte digest');
}

/** Read bytes and refuse the file when its contents no longer match the digest. */
export function readVerified(path: string, digest: string): Buffer {
  assertDigest(digest);
  const bytes = readFileSync(path);
  if (sha256(bytes) !== digest) throw new CorruptBytes(path, digest);
  return bytes;
}

/**
 * Store bytes at a caller-chosen digest path. An existing file is kept only
 * when it still verifies; corrupt bytes are refused rather than overwritten.
 */
export function writeVerified(path: string, bytes: Uint8Array, digest: string): void {
  if (sha256(bytes) !== digest) throw new Error(`Byte digest mismatch: ${digest}`);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    readVerified(path, digest);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, bytes);
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * Publish a temporary file the caller already hashed. A verified occupant is
 * kept. Corrupt bytes at the address are removed so this file can replace them.
 */
export function commitVerified(path: string, temporary: string, digest: string): void {
  assertDigest(digest);
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    try {
      readVerified(path, digest);
      return;
    } catch (error) {
      if (!(error instanceof CorruptBytes)) throw error;
      rmSync(path, { force: true });
    }
  }
  renameSync(temporary, path);
}

export type PaceSpacing = 'start' | 'end';

/** Shared spacing for one acquisition process. Keys isolate independent limits. */
export class PaceClock {
  private readonly due = new Map<string, number>();
  constructor(
    readonly sleep: (ms: number) => Promise<void>,
    readonly now: () => number = Date.now,
  ) {}

  async wait(key: string, intervalMs: number, spacing: PaceSpacing): Promise<void> {
    const current = this.now();
    const reserved = Math.max(current, this.due.get(key) ?? 0);
    if (spacing === 'start') this.due.set(key, reserved + intervalMs);
    const wait = reserved - current;
    if (wait > 0) await this.sleep(wait);
  }

  /** The retry wait already elapsed, so the next turn is not postponed again. */
  ready(key: string, at: number): void {
    this.due.set(key, at);
  }

  /** Space the following request from completion. */
  finished(key: string, intervalMs: number): void {
    this.due.set(key, this.now() + intervalMs);
  }
}

export interface PacedFetchPolicy {
  spacing: PaceSpacing;
  intervalMs: number;
  maxAttempts: number;
  retryAfterCapMs: number;
  retryStatus: (status: number) => boolean;
  fallbackWaitMs: (attempt: number) => number;
  /** Milliseconds from Retry-After. Undefined uses the fallback. */
  retryAfterMs: (header: string | null, now: number) => number | undefined;
  /** An Error stops the fetch. Undefined retries a transport failure. */
  onTransport: (cause: unknown, attempt: number, remaining: boolean) => Error | undefined;
  /** True retries a failure while reading an accepted response. */
  retryRead?: (cause: unknown, attempt: number, remaining: boolean) => boolean;
}

export interface PacedRequest {
  url: string;
  paceKey: string;
  timeoutMs: number;
  init?: Omit<RequestInit, 'signal'>;
}

/** Integer seconds or an HTTP-date. Zero and unparseable values are absent. */
export function retryAfterSecondsOrHttpDate(
  header: string | null,
  now: number,
): number | undefined {
  if (header === null) return undefined;
  if (/^\d+$/.test(header)) {
    const ms = Number(header) * 1_000;
    return ms > 0 ? ms : undefined;
  }
  const at = Date.parse(header);
  if (!Number.isFinite(at)) return undefined;
  return at - now;
}

/** Numeric seconds, including zero from a missing header (`Number(null) === 0`). */
export function retryAfterSeconds(header: string | null): number | undefined {
  const seconds = Number(header);
  if (!Number.isFinite(seconds)) return undefined;
  return seconds * 1_000;
}

function retryDelayMs(
  policy: PacedFetchPolicy,
  header: string | null,
  now: number,
  attempt: number,
): number {
  const requested = policy.retryAfterMs(header, now);
  const delay = requested === undefined ? policy.fallbackWaitMs(attempt) : requested;
  return Math.max(policy.intervalMs, Math.min(policy.retryAfterCapMs, delay));
}

/**
 * Pace one key, honor Retry-After, and stop at the attempt bound.
 * The accepted response is consumed inside the same bound.
 */
export async function pacedFetch<T>(
  clock: PaceClock,
  policy: PacedFetchPolicy,
  request: PacedRequest,
  fetcher: typeof fetch,
  accept: (response: Response) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error('Paced fetch requires a positive attempt bound');
  }
  for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
    const remaining = attempt + 1 < policy.maxAttempts;
    await clock.wait(request.paceKey, policy.intervalMs, policy.spacing);
    let response: Response;
    try {
      response = await fetcher(request.url, {
        ...request.init,
        signal: AbortSignal.timeout(request.timeoutMs),
      });
    } catch (cause) {
      const error = policy.onTransport(cause, attempt, remaining);
      if (error) throw error;
      if (!remaining) throw new Error(`Paced fetch failed: ${request.url}`, { cause });
      await clock.sleep(policy.fallbackWaitMs(attempt));
      continue;
    }
    if (policy.retryStatus(response.status)) {
      await response.body?.cancel();
      if (!remaining) throw new PacedRetriesExhausted(request.url, response.status);
      const delay = retryDelayMs(policy, response.headers.get('retry-after'), clock.now(), attempt);
      await clock.sleep(delay);
      clock.ready(request.paceKey, clock.now());
      continue;
    }
    try {
      const value = await accept(response);
      if (policy.spacing === 'end') clock.finished(request.paceKey, policy.intervalMs);
      return value;
    } catch (cause) {
      if (remaining && policy.retryRead?.(cause, attempt, remaining)) {
        await clock.sleep(policy.fallbackWaitMs(attempt));
        continue;
      }
      throw cause;
    }
  }
  throw new Error('Paced fetch retry state exhausted');
}
