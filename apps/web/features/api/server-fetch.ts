/** Deadlines cover the response body as well as connection establishment. */
export const SERVER_READ_LIMITS = {
  metadata: 4_000,
  read: 8_000,
  transfer: 60_000,
  page: 15_000,
} as const;
export const SERVER_DEADLINE_HEADER = 'x-rezics-server-deadline';
export type FetchSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  /** Only explicitly classified read operations may replay a POST body. */
  idempotentRead?: boolean;
  /** Media/download bodies keep backpressure; JSON reads finish before returning. */
  stream?: boolean | ((response: Response) => boolean);
}

/** A caller joining a shared read may run out of time before its owner does.
 * Release that caller without aborting work other requests still need. */
export async function waitForServerRead<T>(pending: Promise<T>, deadlineAt?: number): Promise<T> {
  if (deadlineAt === undefined) return pending;
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    void pending.catch(() => {});
    throw new DOMException('Upstream deadline exceeded', 'TimeoutError');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new DOMException('Upstream deadline exceeded', 'TimeoutError')),
          remaining,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
  const deadlineAt = Math.min(
    Date.now() + (options.timeoutMs ?? SERVER_READ_LIMITS.read),
    options.deadlineAt ?? deadlineFromHeaders(headers) ?? Infinity,
  );
  headers.delete(SERVER_DEADLINE_HEADER);
  const method = (init.method ?? request?.method ?? 'GET').toUpperCase();
  const read =
    method === 'GET' ||
    method === 'HEAD' ||
    (options.idempotentRead === true && method === 'POST' && typeof init.body === 'string');
  const callerSignal = init.signal ?? request?.signal;
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
      streamController?.error(signal.reason);
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
      // The failed socket has been aborted. HTTP/1 also asks the retry to close
      // its connection; Bun's keepalive:false opts out of its pool on the retry.
      if (attempt) attemptHeaders.set('connection', 'close');
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
              if (!signal.aborted) value.error(error);
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
        throw error;
    }
  }
}
