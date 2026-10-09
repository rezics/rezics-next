import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const hex = /^[a-f0-9]{64}$/;
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class CorruptBytes extends Error { constructor(readonly path: string, readonly digest: string) { super(`Cached bytes are corrupt: ${digest}`); } }
export class RetriesExhausted extends Error { constructor(readonly url: string, readonly status: number) { super(`HTTP ${status}: ${url}`); } }
export function readVerified(path: string, digest: string): Buffer {
  const bytes = hex.test(digest) ? readFileSync(path) : undefined;
  if (!bytes || sha256(bytes) !== digest) throw bytes ? new CorruptBytes(path, digest) : new Error('Invalid byte digest');
  return bytes;
}
function place(path: string, digest: string, write: () => void): void {
  mkdirSync(dirname(path), { recursive: true });
  try { if (existsSync(path)) { readVerified(path, digest); return; } }
  catch (error) { if (!(error instanceof CorruptBytes)) throw error; rmSync(path, { force: true }); }
  write();
}
export function writeVerified(path: string, bytes: Uint8Array, expected?: string): string {
  const digest = sha256(bytes); if (expected !== undefined && expected !== digest) throw new Error(`Byte digest mismatch: ${expected}`);
  const temporary = `${path}.${process.pid}.tmp`;
  place(path, digest, () => { writeFileSync(temporary, bytes); try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); } }); return digest;
}
export function commitVerified(path: string, temporary: string, digest: string): void {
  if (!hex.test(digest)) throw new Error('Invalid byte digest'); place(path, digest, () => renameSync(temporary, path));
}
export type Pace = { sleep: (ms: number) => Promise<void>; now: () => number; due: Map<string, number> };
export const pace = (sleep: Pace['sleep'], now = Date.now): Pace => ({ sleep, now, due: new Map() });
type Limit = { intervalMs: number; maxAttempts: number; timeoutMs: number; retryAfterCapMs: number; serverErrorFrom: number; init?: Omit<RequestInit, 'signal'> };
export async function pacedFetch(clock: Pace, url: string, key: string, limit: Limit, fetcher: typeof fetch): Promise<Response> {
  for (let attempt = 0; attempt < limit.maxAttempts; attempt++) {
    const now = clock.now(), reserved = Math.max(now, clock.due.get(key) ?? 0);
    clock.due.set(key, reserved + limit.intervalMs); if (reserved > now) await clock.sleep(reserved - now);
    const last = attempt + 1 === limit.maxAttempts; let response: Response | undefined;
    try { response = await fetcher(url, { ...limit.init, signal: AbortSignal.timeout(limit.timeoutMs) }); }
    catch (cause) { if (last) throw cause; }
    if (response && response.status !== 429 && response.status < limit.serverErrorFrom) return response;
    await response?.body?.cancel(); if (last) throw new RetriesExhausted(url, response?.status ?? 0);
    const header = response?.headers.get('retry-after') ?? '', delay = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1_000 : Date.parse(header) - clock.now();
    await clock.sleep(Math.max(limit.intervalMs, Math.min(limit.retryAfterCapMs, delay > 0 ? delay : 1_000 * 2 ** attempt))); clock.due.set(key, clock.now());
  }
  throw new Error('Fetch retry state exhausted');
}
