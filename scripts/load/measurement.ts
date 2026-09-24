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

export function selectPhraseQuery(captured: { sparql: string }[]): string {
  const selected = captured.find(entry => entry.sparql.includes('text:query')
    && entry.sparql.includes('?rawUnit') && entry.sparql.includes('?candidateCount'));
  if (!selected) throw new Error('No public phrase candidate query was captured');
  return selected.sparql;
}

/** A retained backlog must be rising at the end to fail; two writers can leave two in flight. */
export function relayBacklogTrend(values: number[]) {
  if (!values.length || values.some(value => !Number.isSafeInteger(value) || value < 0))
    throw new Error('Relay backlog samples are missing or invalid');
  const size = Math.min(30, Math.max(1, Math.floor(values.length / 3)));
  const mean = (window: number[]) => window.reduce((sum, value) => sum + value, 0) / window.length;
  const firstWindowMean = mean(values.slice(0, size));
  const lastWindowMean = mean(values.slice(-size));
  const endLag = values.at(-1)!;
  return { firstWindowMean, lastWindowMean, endLag,
    growingAtEnd: endLag > 2 && lastWindowMean > firstWindowMean + 2 };
}

/** Counts actual Main→Fuseki HTTP attempts and wire body bytes through a local loopback proxy. */
export function startFusekiMeter(upstream: string) {
  const target = new URL(upstream);
  const counts: CallCounts = { calls: 0, sentBytes: 0, receivedBytes: 0, errors: 0 };
  let capture: { path: string; sparql: string }[] | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const incoming = new URL(request.url);
    const destination = new URL(incoming.pathname + incoming.search, target.origin);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    if (capture && incoming.pathname.endsWith('/query') && body) {
      capture.push({ path: incoming.pathname, sparql: new TextDecoder().decode(body) });
    }
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
    snapshot: (): CallCounts => ({ ...counts }),
    beginCapture: () => { capture = []; },
    endCapture: () => { const result = capture ?? []; capture = undefined; return result; },
    stop: () => server.stop(true) };
}
