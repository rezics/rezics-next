import { readFileSync } from 'node:fs';

export interface CallCounts { calls: number; sentBytes: number; receivedBytes: number; errors: number }

export function delta(after: CallCounts, before: CallCounts): CallCounts {
  return { calls: after.calls - before.calls, sentBytes: after.sentBytes - before.sentBytes,
    receivedBytes: after.receivedBytes - before.receivedBytes, errors: after.errors - before.errors };
}

export function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  if (fraction <= 0 || fraction > 1) throw new Error('percentile must be in (0,1]');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

export function processHighWaterKiB(pid: number): number | null {
  try {
    const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmHWM:\s+(\d+) kB$/m);
    return match ? Number(match[1]) : null;
  } catch { return null; }
}

/** Counts actual Main→Fuseki HTTP attempts and wire body bytes through a local loopback proxy. */
export function startFusekiMeter(upstream: string) {
  const target = new URL(upstream);
  const counts: CallCounts = { calls: 0, sentBytes: 0, receivedBytes: 0, errors: 0 };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const incoming = new URL(request.url);
    const destination = new URL(incoming.pathname + incoming.search, target.origin);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    counts.calls++;
    counts.sentBytes += body?.byteLength ?? 0;
    try {
      const response = await fetch(destination, { method: request.method,
        headers: request.headers, body, signal: request.signal });
      const bytes = await response.arrayBuffer();
      counts.receivedBytes += bytes.byteLength;
      if (response.status >= 500) counts.errors++;
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      return new Response(bytes, { status: response.status, headers });
    } catch {
      counts.errors++;
      return new Response('upstream unavailable', { status: 502 });
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/rezics/`,
    snapshot: (): CallCounts => ({ ...counts }), stop: () => server.stop(true) };
}
