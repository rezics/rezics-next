import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const hex = /^[a-f0-9]{64}$/;
export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export class CorruptBytes extends Error { constructor(readonly path: string, readonly digest: string) { super(`Cached bytes are corrupt: ${digest}`); } }
export class RetriesExhausted extends Error { constructor(readonly url: string, readonly status: number) { super(`HTTP ${status}: ${url}`); } }
export class FatalBody extends Error {}
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
type Limit = { intervalMs: number; maxAttempts: number; timeoutMs: number; retryAfterCapMs: number; serverErrorFrom: number; maxBytes?: number; expectedDigest?: string; file?: string; init?: Omit<RequestInit, 'signal'> };
export type Fetched = { status: number; headers: Headers; bytes: Buffer; digest: string; byteLength: number };
async function readBody(response: Response, limit: Limit, url: string): Promise<Pick<Fetched, 'bytes' | 'digest' | 'byteLength'>> {
  const hash = createHash('sha256'); const chunks: Uint8Array[] = []; let size = 0;
  const sink = limit.file === undefined ? undefined : createWriteStream(limit.file);
  const reader = response.body!.getReader();
  try {
    for (;;) {
      const step = await reader.read(); if (step.done) break;
      const block = step.value; size += block.byteLength;
      if (limit.maxBytes !== undefined && size > limit.maxBytes) throw new FatalBody(`Acquisition exceeded ${limit.maxBytes} bytes: ${url}`);
      hash.update(block); if (sink) { if (!sink.write(block)) await new Promise(resolve => sink.once('drain', resolve)); } else chunks.push(block);
    }
  } finally { reader.releaseLock(); if (sink) await new Promise<void>(resolve => sink.end(() => resolve())); }
  const digest = hash.digest('hex'); if (limit.expectedDigest !== undefined && digest !== limit.expectedDigest) throw new FatalBody(`Upstream digest mismatch: ${url}`);
  return { bytes: sink ? Buffer.alloc(0) : Buffer.concat(chunks), digest, byteLength: size };
}
export async function pacedFetch(clock: Pace, url: string, key: string, limit: Limit, fetcher: typeof fetch): Promise<Fetched> {
  for (let attempt = 0; attempt < limit.maxAttempts; attempt++) {
    const now = clock.now(), reserved = Math.max(now, clock.due.get(key) ?? 0);
    clock.due.set(key, reserved + limit.intervalMs); if (reserved > now) await clock.sleep(reserved - now);
    const last = attempt + 1 === limit.maxAttempts; let header = '';
    try {
      const response = await fetcher(url, { ...limit.init, signal: AbortSignal.timeout(limit.timeoutMs) });
      const retry = response.status === 429 || response.status >= limit.serverErrorFrom;
      if (!retry) {
        if (!response.ok || !response.body) { await response.body?.cancel(); return { status: response.status, headers: response.headers, bytes: Buffer.alloc(0), digest: '', byteLength: 0 }; }
        return { status: response.status, headers: response.headers, ...await readBody(response, limit, url) };
      }
      header = response.headers.get('retry-after') ?? ''; await response.body?.cancel();
      if (last) throw new RetriesExhausted(url, response.status);
    } catch (cause) { if (cause instanceof RetriesExhausted || cause instanceof FatalBody || last) throw cause; }
    const delay = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1_000 : Date.parse(header) - clock.now();
    await clock.sleep(Math.max(limit.intervalMs, Math.min(limit.retryAfterCapMs, delay > 0 ? delay : 1_000 * 2 ** attempt))); clock.due.set(key, clock.now());
  }
  throw new Error('Fetch retry state exhausted');
}
