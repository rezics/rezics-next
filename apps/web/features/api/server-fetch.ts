/** Deadlines cover the response body as well as connection establishment. */
export const SERVER_READ_LIMITS = {
  metadata: 4_000,
  read: 8_000,
  transfer: 60_000,
  page: 15_000,
} as const;
export const SERVER_DEADLINE_HEADER = 'x-rezics-server-deadline';
export type FetchSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type TransportReason = 'cancelled' | 'deadline' | 'connection' | 'response-interrupted' | 'unavailable';
export class ServerTransportError extends Error {
  constructor(cause: unknown, readonly reason: TransportReason,
    readonly phase: 'connect' | 'response-body', readonly attempts: number) {
    super(cause instanceof Error ? cause.message : 'Upstream request failed', { cause });
    this.name = cause instanceof Error ? cause.name : 'Error';
  }
}

/** The upstream answered, but its body could not finish; this is not an offline reader. */
export class UpstreamResponseError extends ServerTransportError {
  constructor(cause: unknown, reason: TransportReason = 'response-interrupted', attempts = 1) {
    super(cause, reason, 'response-body', attempts);
    this.message = 'Upstream response interrupted';
    this.name = 'UpstreamResponseError';
  }
}

export function deadlineFromHeaders(headers: Headers): number | undefined {
  const value = Number(headers.get(SERVER_DEADLINE_HEADER));
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, Date.now() + SERVER_READ_LIMITS.transfer)
    : undefined;
}

export interface ServerFetchOptions {
  fetch?: FetchSender;
  timeoutMs?: number;
  /** Absolute caller deadline: retries and dependent reads spend the same budget. */
  deadlineAt?: number;
  /** Internal service hops receive the same absolute deadline, never a renewed duration. */
  forwardDeadline?: boolean;
  /** Only explicitly classified read operations may replay a POST body. */
  idempotentRead?: boolean;
  /** Media/download bodies keep backpressure; JSON reads finish before returning. */
  stream?: boolean | ((response: Response) => boolean);
}

/** A caller joining a shared read may run out of time before its owner does.
 * Release that caller without aborting work other requests still need. */
export async function waitForServerRead<T>(pending: Promise<T>, deadlineAt?: number, signal?: AbortSignal): Promise<T> {
  const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
  if (signal?.aborted) {
    void pending.catch(() => {});
    throw signal.reason;
  }
  if (remaining === Infinity && !signal) return pending;
  if (remaining <= 0) {
    void pending.catch(() => {});
    throw new DOMException('Upstream deadline exceeded', 'TimeoutError');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        if (remaining !== Infinity) timer = setTimeout(
          () => reject(new DOMException('Upstream deadline exceeded', 'TimeoutError')), remaining);
        abort = () => reject(signal!.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
  }
}

/** Buffer only replayable reads; cancel a stalled upload when its caller leaves. */
export async function serverRequestText(request: Request, deadlineAt: number, signal = request.signal): Promise<string> {
  signal.throwIfAborted();
  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let body = '';
  try {
    while (true) {
      const chunk = await waitForServerRead(reader.read(), deadlineAt, signal);
      if (chunk.done) return body + decoder.decode();
      body += decoder.decode(chunk.value, { stream: true });
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

function connectionLost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  // Workers explicitly marks connection loss retryable. Do not replay a timeout,
  // HTTP refusal, malformed JSON, or any write (including OAuth token rotation).
  // https://developers.cloudflare.com/workers/observability/errors/
  return (
    /connection (?:lost|closed|reset)|socket (?:closed|hang up)/i.test(
      error.message,
    ) ||
    ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ConnectionClosed'].includes(code ?? '') ||
    (error.cause !== undefined && connectionLost(error.cause))
  );
}

/** One server transport for Main, Account and other origins. An explicit race
 * releases callers even if a transport ignores abort; cancellation is best effort
 * and never awaited on the failure path. No pending upstream Promise is cached. */
export async function serverFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ServerFetchOptions = {},
): Promise<Response> {
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init.headers ?? request?.headers);
  const operationDeadline = options.deadlineAt ?? deadlineFromHeaders(headers);
  const deadlineAt = Math.min(
    Date.now() + (options.timeoutMs ?? SERVER_READ_LIMITS.read),
    operationDeadline ?? Infinity,
  );
  headers.delete(SERVER_DEADLINE_HEADER);
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  const read =
    method === 'GET' ||
    method === 'HEAD' ||
    (options.idempotentRead === true && method === 'POST' && typeof init.body === 'string');
  const callerSignal = init.signal ?? request?.signal;
  let receivedResponse = false;
  let attempts = 0;
  const transportError = (error: unknown): ServerTransportError => {
    const reason = callerSignal?.aborted ? 'cancelled' : Date.now() >= deadlineAt ||
      error instanceof Error && error.name === 'TimeoutError' ? 'deadline' :
      receivedResponse ? 'response-interrupted' : connectionLost(error) ? 'connection' : 'unavailable';
    return receivedResponse && connectionLost(error) ? new UpstreamResponseError(error, reason, attempts)
      : new ServerTransportError(error, reason, receivedResponse ? 'response-body' : 'connect', attempts);
  };
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal])
      : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false;
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const cancel = (reason: unknown) => {
      void reader?.cancel(reason).catch(() => {});
    };
    const onAbort = () => {
      if (finished) return;
      rejectAbort(signal.reason);
      streamController?.error(transportError(signal.reason));
      cancel(signal.reason);
      cleanup();
    };
    const remaining = deadlineAt - Date.now();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Upstream deadline exceeded', 'TimeoutError')),
      Math.max(0, remaining),
    );
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // A streamed response can abort after serverFetch returns, when no race is
    // listening any more. Keep that rejection handled too.
    void aborted.catch(() => {});
    try {
      if (remaining <= 0)
        controller.abort(new DOMException('Upstream deadline exceeded', 'TimeoutError'));
      if (signal.aborted) throw signal.reason;
      const attemptHeaders = new Headers(headers);
      if (options.forwardDeadline) attemptHeaders.set(SERVER_DEADLINE_HEADER,
        String(Number.isFinite(operationDeadline) ? operationDeadline : deadlineAt));
      // The failed socket has been aborted. HTTP/1 also asks the retry to close
      // its connection; Bun's keepalive:false opts out of its pool on the retry.
      if (attempt) attemptHeaders.set('connection', 'close');
      attempts++;
      const pending = (options.fetch ?? fetch)(input, {
        ...init,
        method,
        headers: attemptHeaders,
        signal,
        cache: 'no-store',
        ...(attempt ? { keepalive: false } : {}),
      });
      void pending.then(
        (response) => {
          if (signal.aborted) void response.body?.cancel(signal.reason).catch(() => {});
        },
        () => {},
      );
      const response = await Promise.race([pending, aborted]);
      receivedResponse = true;
      if (!response.body) {
        cleanup();
        return response;
      }
      reader = response.body.getReader();
      if (typeof options.stream === 'function' ? options.stream(response) : options.stream) {
        const body = new ReadableStream<Uint8Array>({
          start(value) {
            streamController = value;
          },
          async pull(value) {
            if (finished || signal.aborted) return;
            try {
              const chunk = await Promise.race([reader!.read(), aborted]);
              if (signal.aborted) return;
              if (chunk.done) {
                cleanup();
                value.close();
              } else value.enqueue(chunk.value);
            } catch (error) {
              if (!signal.aborted) value.error(transportError(error));
              cancel(error);
              cleanup();
            }
          },
          cancel(reason) {
            controller.abort(reason);
            cancel(reason);
            cleanup();
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        chunks.push(chunk.value);
        length += chunk.value.byteLength;
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      cleanup();
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      controller.abort(error);
      cancel(error);
      cleanup();
      if (
        attempt ||
        !read ||
        callerSignal?.aborted ||
        Date.now() >= deadlineAt ||
        !connectionLost(error)
      )
        throw transportError(error);
    }
  }
}
