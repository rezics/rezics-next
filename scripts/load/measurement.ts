import { readFileSync } from 'node:fs';

export interface CallCounts { calls: number; sentBytes: number; receivedBytes: number; errors: number }
export interface SearchProofCounts {
  fullInventories: number;
  deltaRequests: number;
  deltaAvailable: number;
  deltaUnavailable: number;
}

export function searchProofDelta(after: SearchProofCounts, before: SearchProofCounts): SearchProofCounts {
  return { fullInventories: after.fullInventories - before.fullInventories,
    deltaRequests: after.deltaRequests - before.deltaRequests,
    deltaAvailable: after.deltaAvailable - before.deltaAvailable,
    deltaUnavailable: after.deltaUnavailable - before.deltaUnavailable };
}

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

/** Require every public lane's k6 latency sample in retained load evidence. */
export function laneReadLatencies(metrics: Record<string, Record<string, number>>) {
  const result: Record<'main' | 'realm' | 'content', { reads: number; p95Ms: number; p99Ms: number }> =
    {} as Record<'main' | 'realm' | 'content', { reads: number; p95Ms: number; p99Ms: number }>;
  for (const lane of ['main', 'realm', 'content'] as const) {
    const reads = metrics[`practical_${lane}_reads`]?.count;
    const p95Ms = metrics[`practical_${lane}_read_ms`]?.['p(95)'];
    const p99Ms = metrics[`practical_${lane}_read_ms`]?.['p(99)'];
    if (typeof reads !== 'number' || !Number.isSafeInteger(reads) || reads <= 0
      || typeof p95Ms !== 'number' || !Number.isFinite(p95Ms)
      || typeof p99Ms !== 'number' || !Number.isFinite(p99Ms))
      throw new Error(`${lane} public read latency evidence missing`);
    result[lane] = { reads, p95Ms, p99Ms };
  }
  return result;
}

export function laneReadP95Within(latencies: ReturnType<typeof laneReadLatencies>, limitMs: number) {
  return Object.values(latencies).every(lane => lane.p95Ms <= limitMs);
}

/** Split container memory into anonymous JVM/process pages and page cache. */
export function parseCgroupMemory(raw: string) {
  const [current, peak, maximum, ...stat] = raw.trim().split('\n');
  const values = Object.fromEntries(stat.map(line => line.trim().split(/\s+/)));
  const number = (value: string | undefined) => {
    const parsed = Number(value);
    if (!value || !Number.isSafeInteger(parsed) || parsed < 0)
      throw new Error('invalid container memory counter');
    return parsed;
  };
  return { currentBytes: number(current), peakBytes: number(peak),
    limitBytes: maximum === 'max' ? null : number(maximum),
    anonBytes: number(values.anon), fileBytes: number(values.file) };
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
  const searchProof: SearchProofCounts = { fullInventories: 0, deltaRequests: 0,
    deltaAvailable: 0, deltaUnavailable: 0 };
  let capture: { path: string; sparql: string }[] | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const incoming = new URL(request.url);
    const destination = new URL(incoming.pathname + incoming.search, target.origin);
    const body = ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer();
    if (incoming.pathname.endsWith('/query') && body) {
      const sparql = new TextDecoder().decode(body);
      if (sparql.includes('COUNT(?indexedUnit)') && sparql.includes('"body:*"')) {
        searchProof.fullInventories++;
      }
      if (capture) capture.push({ path: incoming.pathname, sparql });
    }
    const deltaRequest = incoming.pathname.endsWith('/command')
      && incoming.searchParams.has('deltaSince');
    if (deltaRequest) searchProof.deltaRequests++;
    counts.calls++;
    counts.sentBytes += body?.byteLength ?? 0;
    try {
      const response = await fetch(destination, { method: request.method,
        headers: request.headers, body, signal: request.signal });
      const bytes = await response.arrayBuffer();
      counts.receivedBytes += bytes.byteLength;
      if (response.status >= 500) counts.errors++;
      if (deltaRequest) {
        try {
          const proof = JSON.parse(new TextDecoder().decode(bytes)) as { available?: unknown };
          if (response.ok && proof.available === true) searchProof.deltaAvailable++;
          else searchProof.deltaUnavailable++;
        } catch { searchProof.deltaUnavailable++; }
      }
      const headers = new Headers(response.headers);
      headers.delete('content-encoding');
      headers.delete('content-length');
      headers.delete('transfer-encoding');
      return new Response(bytes, { status: response.status, headers });
    } catch {
      counts.errors++;
      if (deltaRequest) searchProof.deltaUnavailable++;
      return new Response('upstream unavailable', { status: 502 });
    }
  } });
  return { url: `http://127.0.0.1:${server.port}/rezics/`,
    snapshot: (): CallCounts => ({ ...counts }),
    searchProofSnapshot: (): SearchProofCounts => ({ ...searchProof }),
    beginCapture: () => { capture = []; },
    endCapture: () => { const result = capture ?? []; capture = undefined; return result; },
    stop: () => server.stop(true) };
}
