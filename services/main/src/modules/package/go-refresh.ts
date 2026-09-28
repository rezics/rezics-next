import { createHash } from 'node:crypto';
import { GO_LIVE_LIMITS, GO_PROXY_ORIGIN, goProxyResponseLoader, solveGoLiveGraph,
  type GoLiveOutcome, type GoProxyResponseLoader } from './go-live-mvs.ts';
import { compareGoLanguage, parseGoModFile } from './go-modfile.ts';
import { SourceRunInvalid, SourceRunUnavailable, type CaptureRequest,
  type SourceRunProviderAdapter, type SourceRunStore, type SourceRunView } from '../source/acquisition-run.ts';

export const GO_PROXY_LIVE_RUN = 'go-proxy-live-run-v1';
export const GO_PROXY_TERMS = 'https://go.dev/ref/mod#module-proxy';
export const GO_PROXY_CAPTURE_BYTES = 65_536;
export const GO_PROXY_CAPTURE_LIMIT = 2_048;
export const GO_PROXY_LIVE_RUN_TIMEOUT_MS = 120_000;

export interface GoProxyLiveRunRequest {
  profile: typeof GO_PROXY_LIVE_RUN;
  mainModule: string;
}

export interface GoProxyLiveRunResult {
  run: SourceRunView;
  resolution: GoLiveOutcome | null;
  replayed: boolean;
}

class GoProxyCaptureFailure extends Error {
  constructor(readonly outcome: 'failed' | 'unqualified', readonly reason: string) {
    super(`Go proxy run capture failed: ${reason}`);
  }
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkedRequest(input: GoProxyLiveRunRequest): GoProxyLiveRunRequest {
  if (input.profile !== GO_PROXY_LIVE_RUN || typeof input.mainModule !== 'string'
    || Buffer.byteLength(input.mainModule, 'utf8') > GO_PROXY_CAPTURE_BYTES) {
    throw new SourceRunInvalid('Go live run requires a bounded main go.mod');
  }
  const parsed = parseGoModFile(input.mainModule, 'strict');
  if (parsed.errors.length || !parsed.module || !parsed.go || parsed.require.length === 0
    || compareGoLanguage(parsed.go, '1.17') < 0 || compareGoLanguage(parsed.go, '1.27.1') > 0
    || parsed.replace.length || parsed.exclude.length) {
    throw new SourceRunInvalid('Go live run needs a pruned main module in the supported profile');
  }
  return { profile: GO_PROXY_LIVE_RUN, mainModule: input.mainModule };
}

export function goProxyCaptureRequest(path: string): CaptureRequest {
  if (path.length > 500 || !/^[a-z0-9!._~/+@-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new SourceRunInvalid('Go proxy request path exceeds the source record limit');
  }
  return { requestKey: `GET ${path}`, path, namespace: 'go-proxy-response', externalId: path,
    coverageScope: 'go-module-proxy-response-v1', captureProfile: 'go-proxy-run-capture-v1',
    validate: value => value === null || value instanceof Uint8Array ? null : 'malformed' };
}

/** Go proxy adapter. A 404 or 410 is frozen with its exact status and empty body;
 * it remains distinct from a failed fetch and decodes to null for cmd/go semantics. */
export function goProxyRunAdapter(loader: GoProxyResponseLoader): SourceRunProviderAdapter {
  return { provider: 'proxy.golang.org', termsReference: GO_PROXY_TERMS,
    reserve: async () => undefined,
    fetch: async (request, signal) => {
      let result: Awaited<ReturnType<GoProxyResponseLoader>>;
      try { result = await loader(request.path, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : '';
        const reason = /budget exhausted|exceeds byte limit/i.test(message) ? 'oversized'
          : /HTTP [0-9]{3}/i.test(message) ? 'http-status' : 'network';
        return { ok: false, outcome: 'failed', reason, status: null };
      }
      const payload = result.bytes === null ? Buffer.alloc(0) : Buffer.from(result.bytes);
      return { ok: true, url: new URL(request.path, GO_PROXY_ORIGIN).toString(),
        status: result.status, mediaType: 'text/plain',
        bytes: payload, parsed: result.bytes === null ? null : new Uint8Array(result.bytes),
        etag: null, lastModified: null, fetchedAt: new Date().toISOString() };
    },
    decode: (bytes, status) => {
      if (status === 404 || status === 410) return null;
      if (status !== 200) throw new SourceRunUnavailable('frozen Go proxy status differs');
      return new Uint8Array(bytes);
    } };
}

const goSurface = [{ surface: 'proxy-metadata', namespace: 'go-proxy-response', required: true,
  captureLimit: GO_PROXY_CAPTURE_LIMIT }];

/**
 * Acquire and solve one Go module graph from a frozen source run. The run admits at most
 * 2,048 proxy requests, 64 KiB per response, 32 MiB total and two minutes of solver time;
 * reads and replay perform no network call. Each new capture is one indexed lookup and one
 * fixed-size transaction.
 */
export async function runGoProxyLive(runs: SourceRunStore, principalId: string, key: string,
  input: GoProxyLiveRunRequest,
  loader = goProxyResponseLoader(undefined, runs.fetcher, GO_PROXY_CAPTURE_BYTES)):
  Promise<GoProxyLiveRunResult> {
  const request = checkedRequest(input);
  const digest = sha(`${request.profile}\0${request.mainModule}`);
  const adapter = goProxyRunAdapter(loader);
  const started = await runs.start(principalId, key, adapter.provider, GO_PROXY_LIVE_RUN, digest,
    goSurface, adapter.termsReference);

  const readResult = async (resolution: GoLiveOutcome | null): Promise<GoProxyLiveRunResult> => {
    const run = await runs.read(principalId, started.runId);
    if (!run) throw new SourceRunUnavailable('Go proxy source run receipt is unavailable');
    return { run, resolution, replayed: !started.created };
  };

  const prior = !started.created && await runs.isComplete(started.runId);
  if (prior) {
    const run = await runs.read(principalId, started.runId);
    if (!run) throw new SourceRunUnavailable('Go proxy source run receipt is unavailable');
    if (run.completion?.outcome !== 'completed') return { run, resolution: null, replayed: true };
    const resolution = await solveGoLiveGraph({ mainModule: request.mainModule,
      limits: { ...GO_LIVE_LIMITS, maxFileBytes: GO_PROXY_CAPTURE_BYTES },
      deadline: performance.now() + GO_PROXY_LIVE_RUN_TIMEOUT_MS,
      loader: async (path, signal) => {
        if (signal?.aborted) return null;
        if (!(await runs.retentionPermitted(adapter.provider, 'go-proxy-response'))) {
          throw new SourceRunUnavailable('current source terms prohibit replaying retained bytes');
        }
        const capture = await runs.frozen(started.runId, `GET ${path}`);
        if (!capture) throw new SourceRunUnavailable('Go proxy replay needs an uncaptured request');
        return capture.bytes === null ? null : adapter.decode(capture.bytes, capture.status) as Uint8Array | null;
      } });
    return readResult(resolution);
  }

  let resolution: GoLiveOutcome | null = null;
  await runs.exclusive(started.runId, async () => {
    if (await runs.isComplete(started.runId)) return;
    if ((await runs.settledSurfaces(started.runId)).has('proxy-metadata')) return;
    try {
      resolution = await solveGoLiveGraph({ mainModule: request.mainModule,
        limits: { ...GO_LIVE_LIMITS, maxFetches: GO_PROXY_CAPTURE_LIMIT,
          maxBytes: 32 * 1024 * 1024, maxFileBytes: GO_PROXY_CAPTURE_BYTES },
        deadline: performance.now() + GO_PROXY_LIVE_RUN_TIMEOUT_MS,
        loader: async (path, signal) => {
          const result = await runs.acquire(principalId, started.runId, 'proxy-metadata',
            goProxyCaptureRequest(path), adapter, signal);
          if (!result.ok) throw new GoProxyCaptureFailure(result.outcome, result.reason);
          return result.parsed as Uint8Array | null;
        } });
      await runs.settle(started.runId, 'proxy-metadata', 'qualified', 'complete',
        { resolution: resolution.status, cost: resolution.cost });
    } catch (error) {
      if (!(error instanceof GoProxyCaptureFailure)) throw error;
      await runs.settle(started.runId, 'proxy-metadata', error.outcome, error.reason);
      resolution = null;
    }
    await runs.complete(started.runId);
  });
  return readResult(resolution);
}
