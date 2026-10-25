type Options = {
  origin: string;
  token: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  maxBodyBytes?: number;
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
    if (body.byteLength > limit) throw tooLarge();
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
      if (value.byteLength > limit - size) throw tooLarge();
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

function retryDelay(response: Response, attempt: number, now: () => number): number | null {
  const fallback = backoff(attempt);
  const header = response.status === 429 ? response.headers.get('retry-after') : null;
  if (header === null) return fallback;
  let delay: number;
  if (/^\d+$/.test(header)) delay = Number(header) * 1000;
  else if (httpDate.test(header) && Number.isFinite(Date.parse(header)))
    delay = Math.max(0, Date.parse(header) - now());
  else return fallback;
  // An unrepresentable advertised delay cannot safely be shortened to a backoff.
  return Number.isSafeInteger(Math.ceil(delay)) ? Math.ceil(delay) : null;
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 30000);
}

function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) {
      signal.removeEventListener('abort', aborted);
      aborted();
    }
  });
}

async function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  // Native timers overflow above this interval and would otherwise retry early.
  while (ms > 0) {
    const interval = Math.min(ms, 2147483647);
    await timerSleep(interval, signal);
    ms -= interval;
  }
}

/** Transport for createKernelClient; session state and write validation remain with the client/server. */
export function createImportFetch(options: Options): typeof fetch {
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
  const maxAttempts = options.maxAttempts ?? 3;
  const maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
    throw new RangeError('maxAttempts must be an integer from 1 to 5');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0)
    throw new RangeError('maxBodyBytes must be a nonnegative safe integer');
  const upstream = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const sleep = (ms: number, signal: AbortSignal) =>
    abortable(signal, () => (options.sleep ? options.sleep(ms) : defaultSleep(ms, signal)));

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin.origin || !url.pathname.startsWith('/v1/') || url.username || url.password)
      throw new TypeError('Import requests must target the configured API origin under /v1/');
    const signal = init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal;
    signal?.throwIfAborted();
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
            signal: init?.signal === undefined ? input.signal : init.signal,
            redirect: 'manual',
          })
        : new Request(url.href, { ...init, redirect: 'manual' });
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
        if (!retryable || attempt === maxAttempts) throw error;
        await sleep(backoff(attempt), request.signal);
        continue;
      }
      if (
        !retryable ||
        attempt === maxAttempts ||
        !(response.status === 429 || (response.status >= 500 && response.status <= 599))
      )
        return response;
      const delay = retryDelay(response, attempt, now);
      if (delay === null) return response;
      await abortable(request.signal, () => cancel(response.body));
      await sleep(delay, request.signal);
    }
  }) as typeof fetch;
}
