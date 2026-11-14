import {
  createBoundedPublicGet,
  importCorrelationId,
  importNetworkCode,
  MAX_IMPORT_DEADLINE_MS,
} from './import-fetch.ts';

const READINESS_PATH = '/v1/definitions/active';
const RETRY_MS = 1000;
type ReadinessPhase = 'network' | 'http' | 'response' | 'deadline' | 'cancelled';
type Schedule = (callback: () => void, ms: number) => () => void;

export type SeedReadinessOptions = {
  origin: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  schedule?: Schedule;
  deadlineMs?: number;
};

/** Retain the private cause while exposing only bounded local request metadata. */
export class SeedReadinessError extends Error {
  readonly target: string;
  readonly networkCode: string | undefined;

  constructor(
    origin: URL,
    readonly phase: ReadinessPhase,
    readonly status?: number,
    cause?: unknown,
    readonly correlationId?: string,
  ) {
    super('Kernel readiness failed', { cause });
    this.name = 'SeedReadinessError';
    this.target = origin.origin.slice(0, 256) + READINESS_PATH;
    this.networkCode = importNetworkCode(cause);
  }
}

export function formatSeedReadinessError(error: SeedReadinessError): string {
  return (
    `Cross-media seed readiness failed phase=${error.phase} method=GET target=${error.target} ` +
    `status=${error.status ?? 'none'} network=${error.networkCode ?? 'none'} correlation=${error.correlationId ?? 'none'}`
  );
}

const nativeSchedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

function wait(
  ms: number,
  signal: AbortSignal,
  schedule: Schedule,
  sleep?: SeedReadinessOptions['sleep'],
): Promise<void> {
  return new Promise((resolve, reject) => {
    let clear = () => {};
    let settled = false;
    const finish = (aborted: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancelled);
      clear();
      if (aborted) reject(error);
      else resolve();
    };
    const cancelled = () => finish(true, signal.reason);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) return cancelled();
    try {
      if (sleep) {
        Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return sleep(ms);
          })
          .then(
            () => finish(false),
            (error: unknown) => finish(true, error),
          );
      } else {
        clear = schedule(() => finish(false), ms);
        if (settled) clear();
      }
    } catch (error) {
      finish(true, error);
    }
  });
}

/** One anonymous, bounded operation; only HTTP 200 releases development import effects. */
export async function waitForKernelReadiness(options: SeedReadinessOptions): Promise<void> {
  const origin = new URL(options.origin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new TypeError('Expected an API origin');
  const deadlineMs = options.deadlineMs ?? MAX_IMPORT_DEADLINE_MS;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_IMPORT_DEADLINE_MS)
    throw new RangeError(`Readiness deadline must be an integer from 1 to ${MAX_IMPORT_DEADLINE_MS}`);
  const target = new URL(READINESS_PATH, origin).href;
  const upstream = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? nativeSchedule;
  const controller = new AbortController();
  const signal = controller.signal;
  const cancelled = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const deadline = now() + deadlineMs;
  let clearDeadline: (() => void) | undefined;
  let phase: ReadinessPhase = 'network';
  let status: number | undefined;
  let correlationId: string | undefined;
  let cause: unknown;
  // The public reader scopes HTTPS URLs. Its fixed fetch adapter also supports local HTTP,
  // always sending the original API URL with the reader's anonymous, no-redirect policy.
  const readScope = new URL(origin);
  readScope.protocol = 'https:';
  try {
    signal.throwIfAborted();
    clearDeadline = schedule(
      () => controller.abort(new DOMException('Kernel readiness deadline exceeded', 'TimeoutError')),
      Math.max(0, deadline - now()),
    );
    for (;;) {
      signal.throwIfAborted();
      const remaining = Math.min(deadlineMs, deadline - now());
      if (remaining <= 0) {
        controller.abort(new DOMException('Kernel readiness deadline exceeded', 'TimeoutError'));
        signal.throwIfAborted();
      }
      phase = 'network';
      status = undefined;
      correlationId = undefined;
      cause = undefined;
      const read = createBoundedPublicGet({
        origin: readScope.origin,
        pathPrefix: READINESS_PATH,
        deadlineMs: Math.ceil(remaining),
        sleep: options.sleep,
        now,
        schedule,
        fetch: (async (_input, init) => {
          phase = 'network';
          status = undefined;
          correlationId = undefined;
          cause = undefined;
          let response: Response;
          try {
            response = await upstream(target, { ...init, cache: 'no-store' });
          } catch (error) {
            cause = error;
            throw error;
          }
          if (signal.aborted || init?.signal?.aborted) {
            void response.body?.cancel().catch(() => {});
            init?.signal?.throwIfAborted();
            signal.throwIfAborted();
          }
          phase = 'response';
          status = response.status;
          correlationId = importCorrelationId(response);
          return response;
        }) as typeof fetch,
      });
      let retry = false;
      try {
        const response = await read(new URL(READINESS_PATH, readScope).href, signal);
        signal.throwIfAborted();
        if (now() >= deadline) {
          controller.abort(new DOMException('Kernel readiness deadline exceeded', 'TimeoutError'));
          signal.throwIfAborted();
        }
        if (response.status === 200) return;
        phase = 'http';
        // The bounded reader has already admitted or exhausted advertised retry delays.
        // Restarting that series could shorten Retry-After or bypass its wait limits.
        if ((response.status === 429 || response.status === 503) && response.headers.has('retry-after'))
          throw new SeedReadinessError(origin, phase, status, undefined, correlationId);
        retry =
          [202, 204, 404, 408, 425, 429].includes(response.status) ||
          (response.status >= 500 && response.status <= 599);
      } catch (error) {
        if (error instanceof SeedReadinessError) throw error;
        cause ??= error;
        signal.throwIfAborted();
        retry = phase === 'network';
      }
      if (!retry) throw new SeedReadinessError(origin, phase, status, cause, correlationId);
      await wait(Math.min(RETRY_MS, Math.max(0, deadline - now())), signal, schedule, options.sleep);
    }
  } catch (error) {
    if (error instanceof SeedReadinessError) throw error;
    throw new SeedReadinessError(
      origin,
      options.signal?.aborted ? 'cancelled' : signal.aborted ? 'deadline' : phase,
      status,
      options.signal?.aborted ? options.signal.reason : cause ?? error,
      correlationId,
    );
  } finally {
    options.signal?.removeEventListener('abort', cancelled);
    clearDeadline?.();
  }
}
