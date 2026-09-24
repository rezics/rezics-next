import { mkdir, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:net';

export type Sample = { ms: number; requests: number; sentBytes: number; receivedBytes: number; resultRows?: number };
export type Series = { cold: Sample; warm: Sample[]; p50: number; p95: number; p99: number };

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('port unavailable'));
      server.close(() => resolve(address.port));
    });
  });
}

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  return Number(sorted[Math.ceil(fraction * sorted.length) - 1]!.toFixed(3));
}

export async function measure(fn: () => Promise<Sample>, rounds = 15): Promise<Series> {
  const cold = await fn();
  const warm: Sample[] = [];
  for (let i = 0; i < rounds; i++) warm.push(await fn());
  const latencies = warm.map(s => s.ms);
  return { cold, warm, p50: percentile(latencies, .5), p95: percentile(latencies, .95), p99: percentile(latencies, .99) };
}

export async function request(url: string, contentType: string, body: string, timeoutMs = 20_000): Promise<{ status: number; text: string; sample: Sample }> {
  const start = performance.now();
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': contentType, accept: 'application/json' }, body,
    signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const sample = { ms: Number((performance.now() - start).toFixed(3)), requests: 1,
    sentBytes: Buffer.byteLength(body), receivedBytes: Buffer.byteLength(text) };
  return { status: response.status, text, sample };
}

export async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) total += await directoryBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export async function ensure(path: string): Promise<void> { await mkdir(path, { recursive: true }); }

export function assertStatus(status: number, body: string, description: string): void {
  if (status < 200 || status >= 300) throw new Error(`${description}: HTTP ${status}: ${body.slice(0, 1000)}`);
}
