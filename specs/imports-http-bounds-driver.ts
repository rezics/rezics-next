import * as production from '../services/importer/src/import-fetch';

/** Exact future adapter signature in services/importer/src/import-fetch.ts.
 * All optional limits are safe integers: byte/wait limits >=0, deadline >=1,
 * attempts >=1. Defaults equal the exported hard ceilings below except attempts
 * (default 3). Configuration can only lower a ceiling. Bulk's 64KiB wrapper
 * remains separate; this service transport accepts at most 2MiB of request bytes.
 * schedule defaults to cancellable native setTimeout, and is used for BOTH the
 * whole-operation deadline and native retry sleeps. now/sleep/schedule are IO
 * seams, never alternative retry or body implementations. The deadline starts
 * before request-body/token IO and covers every attempt, wait and response read.
 * sleep is abort-raced even if an injected implementation ignores cancellation.
 */
export interface ImportHttpOptions {
  origin: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
  maxAttempts?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxWaitMs?: number;
  maxTotalWaitMs?: number;
  deadlineMs?: number;
}
export interface ImportHttpModule {
  createImportFetch(options: ImportHttpOptions): typeof fetch;
  MAX_IMPORT_BODY_BYTES: 2097152;
  MAX_IMPORT_RESPONSE_BYTES: 1048576;
  MAX_IMPORT_WAIT_MS: 30000;
  MAX_IMPORT_TOTAL_WAIT_MS: 60000;
  MAX_IMPORT_DEADLINE_MS: 120000;
  MAX_IMPORT_ATTEMPTS: 5;
}
export interface Observation {
  responseByteVisits: number;
  peakResponseBackingBytes: number;
  databaseCalls: number;
}
export interface HttpBoundsDriver {
  product: ImportHttpModule;
  observe<T>(operation: () => Promise<T>): Promise<{ value: T; observation: Observation }>;
}
/** IMPORT_HTTP_BOUNDS_DRIVER exports only observe, instrumenting ACTUAL nested
 * allocation/copy/scan/stream lifetimes and database calls. It supplies no factory,
 * limits, response parsing, counters inferred from fixture size, or outcome model.
 * Count backing allocations, not view lengths; include live source chunks, owned
 * copies and downstream response buffers, deduplicating shared backing stores.
 * Fixture buffers count only while delivered/retained by production, not while
 * owned solely by the fake remote. Count copies/scans including JSON decoding;
 * release dead stores. An abusive incoming backing must be rejected before copy.
 * No VM heap sampling, expected counters or fixture substitution. Fake ONLY remote
 * fetch; real createImportFetch and real createKernelClient consume actual bodies.
 * No database is needed. N, U*t and partitions are inaccessible here. With A<=5,
 * M<=2MiB request/1MiB decoded response, byte work is O(A*M), retention O(M),
 * single waits <=30s, operation waits <=60s, deadline <=120s; no wall-time oracle.
 * Dump/source streaming is unrelated to the HTTP response budget.
 */
export async function loadHttpBoundsDriver(): Promise<HttpBoundsDriver> {
  const path = process.env.IMPORT_HTTP_BOUNDS_DRIVER;
  if (!path) throw new Error('IMPORT_HTTP_BOUNDS_DRIVER is required: instrument real createImportFetch operations');
  const observer = await import(path);
  return { product: production as unknown as ImportHttpModule, observe: observer.observe };
}
