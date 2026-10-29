export const MAX_IMPORT_BODY_BYTES = 2097152;
export const MAX_IMPORT_RESPONSE_BYTES = 1048576;
export const MAX_IMPORT_WAIT_MS = 30000;
export const MAX_IMPORT_TOTAL_WAIT_MS = 60000;
export const MAX_IMPORT_DEADLINE_MS = 120000;
export const MAX_IMPORT_ATTEMPTS = 5;

/** Local retry admission only: no remote body, header text or credential is retained. */
export type ImportRetryState = Readonly<{
  notBefore?: number;
  deadline: number;
  stopped?: 'unrepresentable-delay' | 'wait-limit' | 'total-wait-limit' | 'deadline';
}>;
const retryStates = new WeakMap<Response, ImportRetryState>();
export const importRetryState = (response: Response): ImportRetryState | undefined => retryStates.get(response);

export type ImportHttpOptions = {
  origin: string;
  token: (fresh?: boolean) => Promise<string>;
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
};

// Only the structured-field string identity is inspected here, never write semantics.
const sfString = String.raw`"(?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"`;
const sfBare = String.raw`(?:${sfString}|-?\d{1,12}\.\d{1,3}|-?\d{1,15}|\?[01]|:[A-Za-z0-9+/]*={0,2}:|[A-Za-z*][A-Za-z0-9!#$%&'*+.^_\x60|~:/-]*)`;
const idempotencyHeader = new RegExp(String.raw`^(${sfString})(?:; *[a-z*][a-z0-9_.*-]*(?:=${sfBare})?)*[ \t]*$`);

function hasIdempotencyKey(header: string | null): boolean {
  if (header === null) return false;
  const match = idempotencyHeader.exec(header);
  if (!match || match[1]!.length > 512) return false;
  const key: string = JSON.parse(match[1]!);
  return key.length > 0 && key.length <= 255;
}

function mayRetry(request: Request, body: Uint8Array | null): boolean {
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  if (request.method === 'PUT')
    return (
      /^\/v1\/subjects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/source-statistics\/vndb$/.test(
        new URL(request.url).pathname,
      ) && hasIdempotencyKey(request.headers.get('idempotency-key'))
    );
  if (request.method !== 'POST') return false;
  if (hasIdempotencyKey(request.headers.get('idempotency-key'))) return true;
  if (new URL(request.url).pathname !== '/v1/subjects:batchWrite' || body === null) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (typeof value !== 'object' || value === null || !('commands' in value)) return false;
    const commands: unknown = value.commands;
    if (!Array.isArray(commands) || commands.length === 0) return false;
    const keys = new Set<string>();
    for (const command of commands) {
      if (
        typeof command !== 'object' ||
        command === null ||
        typeof command.key !== 'string' ||
        command.key.length === 0
      )
        return false;
      if (keys.has(command.key)) return false;
      keys.add(command.key);
    }
    return true;
  } catch {
    return false;
  }
}

// Register before invoking work: injected hooks may synchronously abort, or never settle.
function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return work();
      })
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}

function cancel(body: ReadableStream<Uint8Array> | null): Promise<void> {
  // A broken/locked stream must not replace the actual HTTP or transport outcome.
  return body?.cancel().catch(() => {}) ?? Promise.resolve();
}

function tooLarge(): RangeError {
  return new RangeError('Import request body exceeds maxBodyBytes');
}

function checkBodySize(body: BodyInit | null | undefined, limit: number): void {
  if (typeof body === 'string') {
    // Count UTF-8 without allocating an unbounded encoded copy in Request's constructor.
    let bytes = 0;
    for (let index = 0; index < body.length; index++) {
      const unit = body.charCodeAt(index);
      if (unit < 0x80) bytes++;
      else if (unit < 0x800) bytes += 2;
      else if (
        unit >= 0xd800 &&
        unit <= 0xdbff &&
        index + 1 < body.length &&
        body.charCodeAt(index + 1) >= 0xdc00 &&
        body.charCodeAt(index + 1) <= 0xdfff
      ) {
        bytes += 4;
        index++;
      } else bytes += 3;
      if (bytes > limit) throw tooLarge();
    }
  } else if (body instanceof Blob) {
    if (body.size > limit) throw tooLarge();
  } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    // Request may copy direct input, so admit the entire producer backing first.
    const backing = body instanceof ArrayBuffer ? body : body.buffer;
    if (backing.byteLength > MAX_IMPORT_BODY_BYTES || body.byteLength > limit) throw tooLarge();
  }
}

async function readBody(
  request: Request,
  limit: number,
  body: ReadableStream<Uint8Array> | null,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return null;
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > limit) {
    void cancel(body);
    throw tooLarge();
  }
  const reader = body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(request.signal, () => reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Import request body must contain bytes');
      // Even an empty view can pin excessive backing; check before copying any bytes.
      if (value.buffer.byteLength > MAX_IMPORT_BODY_BYTES || value.byteLength > limit - size) throw tooLarge();
      // Grow within the cap, without retaining source backing buffers or an
      // object per chunk when a hostile stream supplies many tiny chunks.
      if (size + value.byteLength > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(size + value.byteLength, bytes.byteLength * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return bytes.subarray(0, size);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const weekday = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
// HTTP-date accepts IMF-fixdate and the two obsolete HTTP date forms.
const httpDate = new RegExp(
  `^(?:${weekday}, \\d{2} ${month} \\d{4} \\d{2}:\\d{2}:\\d{2} GMT|` +
    `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} \\d{2}:\\d{2}:\\d{2} GMT|` +
    `${weekday} ${month} (?: \\d|\\d{2}) \\d{2}:\\d{2}:\\d{2} \\d{4})$`,
);

function retryAfter(response: Response, receivedAt: number): number | null | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  let notBefore: number;
  if (/^\d+$/.test(header)) notBefore = receivedAt + Number(header) * 1000;
  else if (httpDate.test(header) && Number.isFinite(Date.parse(header)))
    notBefore = Math.max(receivedAt, Date.parse(header));
  else return undefined;
  // An unrepresentable advertised time cannot safely become a shorter backoff.
  return Number.isSafeInteger(Math.ceil(notBefore)) ? Math.ceil(notBefore) : null;
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30000);
}

function nativeSchedule(callback: () => void, ms: number): () => void {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
}

function timerSleep(
  ms: number,
  signal: AbortSignal,
  schedule: (callback: () => void, ms: number) => () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let clear = () => {};
    let settled = false;
    const aborted = () => {
      settled = true;
      signal.removeEventListener('abort', aborted);
      clear();
      reject(signal.reason);
    };
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      clear = schedule(() => {
        settled = true;
        signal.removeEventListener('abort', aborted);
        clear();
        resolve();
      }, ms);
      // An injected scheduler may complete or abort synchronously.
      if (settled) clear();
    } catch (error) {
      signal.removeEventListener('abort', aborted);
      reject(error);
    }
  });
}

function boundedSetting(value: number | undefined, fallback: number, ceiling: number, minimum = 0): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < minimum || result > ceiling)
    throw new RangeError(`Import limit must be an integer from ${minimum} to ${ceiling}`);
  return result;
}

async function boundedResponse(response: Response, limit: number, signal: AbortSignal): Promise<Response> {
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let bytes = new Uint8Array(0);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(signal, () => reader.read());
      if (done) break;
      // Check the backing store before touching bytes: a tiny view may pin a huge buffer.
      if (!(value instanceof Uint8Array)) throw new TypeError('Import response body must contain bytes');
      if (value.buffer.byteLength > MAX_IMPORT_RESPONSE_BYTES || value.byteLength > limit - size)
        throw new RangeError('Import response body exceeds maxResponseBytes');
      if (size + value.byteLength > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(limit, Math.max(size + value.byteLength, bytes.byteLength * 2)));
        expanded.set(bytes);
        bytes = expanded;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    signal.throwIfAborted();
    return new Response(bytes.subarray(0, size), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Transport for createKernelClient; session state and write validation remain with the client/server. */
export function createImportFetch(options: ImportHttpOptions): typeof fetch {
  const origin = new URL(options.origin);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new TypeError('Expected an API origin');
  const maxAttempts = boundedSetting(options.maxAttempts, 3, MAX_IMPORT_ATTEMPTS, 1);
  const maxBodyBytes = boundedSetting(options.maxBodyBytes, MAX_IMPORT_BODY_BYTES, MAX_IMPORT_BODY_BYTES);
  const maxResponseBytes = boundedSetting(
    options.maxResponseBytes,
    MAX_IMPORT_RESPONSE_BYTES,
    MAX_IMPORT_RESPONSE_BYTES,
  );
  const maxWaitMs = boundedSetting(options.maxWaitMs, MAX_IMPORT_WAIT_MS, MAX_IMPORT_WAIT_MS);
  const maxTotalWaitMs = boundedSetting(options.maxTotalWaitMs, MAX_IMPORT_TOTAL_WAIT_MS, MAX_IMPORT_TOTAL_WAIT_MS);
  const deadlineMs = boundedSetting(options.deadlineMs, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_DEADLINE_MS, 1);
  const upstream = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? nativeSchedule;
  const sleep = (ms: number, signal: AbortSignal) =>
    abortable(signal, () => (options.sleep ? options.sleep(ms) : timerSleep(ms, signal, schedule)));

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin.origin || !url.pathname.startsWith('/v1/') || url.username || url.password)
      throw new TypeError('Import requests must target the configured API origin under /v1/');
    const caller = init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal;
    caller?.throwIfAborted();
    const controller = new AbortController();
    const signal = controller.signal;
    const aborted = () => controller.abort(caller?.reason);
    caller?.addEventListener('abort', aborted, { once: true });
    const deadline = now() + deadlineMs;
    let clearDeadline: (() => void) | undefined;
    try {
      clearDeadline = schedule(
        () => controller.abort(new DOMException('Import request deadline exceeded', 'TimeoutError')),
        deadlineMs,
      );
      signal.throwIfAborted();
      checkBodySize(init?.body, maxBodyBytes);
      // Copy metadata without cloning/teeing a supplied Request's stream: teeing can
      // prefetch past the cap and leaves an unread branch retaining the entire body.
      const request =
        input instanceof Request
          ? new Request(url.href, {
              ...init,
              method: init?.method ?? input.method,
              headers: init?.headers ?? input.headers,
              cache: init?.cache ?? input.cache,
              credentials: init?.credentials ?? input.credentials,
              integrity: init?.integrity ?? input.integrity,
              keepalive: init?.keepalive ?? input.keepalive,
              mode: init?.mode ?? input.mode,
              referrer: init?.referrer ?? input.referrer,
              referrerPolicy: init?.referrerPolicy ?? input.referrerPolicy,
              signal,
              redirect: 'manual',
            })
          : new Request(url.href, { ...init, signal, redirect: 'manual' });
      const source = input instanceof Request && init?.body == null ? input.body : request.body;
      if (source !== null && (request.method === 'GET' || request.method === 'HEAD'))
        throw new TypeError('GET/HEAD import requests cannot have a body');
      if (input instanceof Request && init?.body == null && (input.bodyUsed || source?.locked))
        throw new TypeError('Import request body has already been used');
      const body = await readBody(request, maxBodyBytes, source);
      request.signal.throwIfAborted();
      const retryable = mayRetry(request, body);
      const headers = new Headers(request.headers);
      headers.set('authorization', `Bearer ${await abortable(request.signal, options.token)}`);
      let scheduledWait = 0;
      let renewedAfterDenial = false;
      for (let attempt = 1; ; attempt++) {
        request.signal.throwIfAborted();
        const next = new Request(request, { headers, ...(body === null ? {} : { body }), redirect: 'manual' });
        let response: Response;
        try {
          response = await abortable(request.signal, async () => {
            const result = await upstream(next);
            if (request.signal.aborted) {
              void cancel(result.body);
              request.signal.throwIfAborted();
            }
            return result;
          });
        } catch (error) {
          request.signal.throwIfAborted();
          const delay = backoff(attempt);
          if (!retryable || attempt === maxAttempts || delay > maxWaitMs || delay > maxTotalWaitMs - scheduledWait)
            throw error;
          scheduledWait += delay;
          await sleep(delay, request.signal);
          continue;
        }
        if (response.status === 401 && !renewedAfterDenial && options.token.length > 0) {
          renewedAfterDenial = true;
          await abortable(request.signal, () => cancel(response.body));
          headers.set('authorization', `Bearer ${await abortable(request.signal, () => options.token(true))}`);
          attempt--;
          continue;
        }
        const receivedAt = now();
        let buffered = false;
        const adaptable = response.status === 429 || response.status === 503;
        const hint = adaptable ? retryAfter(response, receivedAt) : undefined;
        let overload = response.status === 429;
        if (response.status === 503 && hint !== undefined) {
          // Interpret 503 hints only for the same public retryable classifier as
          // the coordinator. Buffer before parsing, under the existing body cap.
          response = await boundedResponse(response, maxResponseBytes, signal);
          buffered = true;
          const problem: unknown = await abortable(signal, () =>
            response
              .clone()
              .json()
              .catch(() => null),
          );
          overload =
            typeof problem === 'object' && problem !== null && 'retryable' in problem && problem.retryable === true;
        }
        const notBefore = overload ? hint : undefined;
        const delay =
          notBefore === null ? null : notBefore === undefined ? backoff(attempt) : Math.max(0, notBefore - now());
        const stopped = (): ImportRetryState['stopped'] =>
          delay === null
            ? 'unrepresentable-delay'
            : delay > maxWaitMs
              ? 'wait-limit'
              : delay > maxTotalWaitMs - scheduledWait
                ? 'total-wait-limit'
                : notBefore !== undefined && now() + delay >= deadline
                  ? 'deadline'
                  : undefined;
        const finish = async (refused = false) => {
          const result = buffered ? response : await boundedResponse(response, maxResponseBytes, signal);
          if (adaptable && (notBefore !== undefined || refused)) {
            const reason = stopped();
            retryStates.set(
              result,
              Object.freeze({
                deadline,
                ...(notBefore === undefined || notBefore === null ? {} : { notBefore }),
                ...(reason === undefined ? {} : { stopped: reason }),
              }),
            );
          }
          return result;
        };
        if (
          !retryable ||
          attempt === maxAttempts ||
          !(response.status === 429 || (response.status >= 500 && response.status <= 599))
        )
          return await finish();
        if (stopped() !== undefined) return await finish(true);
        // stopped() rejects the null (unrepresentable) case before scheduling.
        if (delay === null) return await finish(true);
        scheduledWait += delay;
        await abortable(request.signal, () => cancel(response.body));
        await sleep(delay, request.signal);
      }
    } finally {
      caller?.removeEventListener('abort', aborted);
      clearDeadline?.();
    }
  }) as typeof fetch;
}
