import { Buffer } from 'node:buffer';
import { MAX_ORDER_TRANSACTIONS, StripeUnavailableError } from './model.ts';

// Derived from the existing webhook body limit, snapshot cap and effects worker concurrency.
const BODY_BYTES = 256 * 1024;
const HEADER_BYTES = BODY_BYTES / 16;
const MAX_CONTAINERS = MAX_ORDER_TRANSACTIONS * 16;
const MAX_DEPTH = 16;
const CAPACITY = 8;
let unsettledOperations = 0;

function unavailable(): StripeUnavailableError {
  return new StripeUnavailableError('Stripe request outcome is unavailable');
}

/** Internal, invocation-bound transport; every actual caller creates one of these, never a shared deadline. */
export function stripeTransport(options: {
  timeoutMs: number;
  retries: number;
  requests: number;
  signal?: AbortSignal;
}) {
  if (unsettledOperations >= CAPACITY || options.signal?.aborted) throw unavailable();
  unsettledOperations++;
  const abort = new AbortController();
  const deadline = performance.now() + options.timeoutMs;
  let sends = 0;
  let responseBytes = 0;
  let requestBytes = 0;
  let containers = 0;
  let feeDetails = 0;
  let physical = 0;
  let returned = false;
  let released = false;
  const maxBytes = BODY_BYTES * options.requests;
  // The SDK may retry a closed connection once even when maxNetworkRetries is zero.
  const maxSends = options.requests * Math.max(2, options.retries + 1);
  let rejectStopped: (error: Error) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectStopped = reject;
  });
  // A deadline can expire during SDK retry sleep, when no fetch/body promise is being awaited.
  void stopped.catch(() => {});
  function stop() {
    if (!abort.signal.aborted) {
      abort.abort(unavailable());
      rejectStopped(unavailable());
    }
  }
  const timer = setTimeout(stop, options.timeoutMs);
  options.signal?.addEventListener('abort', stop, { once: true });
  function check() {
    if (performance.now() >= deadline) stop();
    if (abort.signal.aborted) throw unavailable();
  }
  function release() {
    // Public timeout/cancellation is not physical settlement. No slot is reused while fetch/cancel is alive.
    if (returned && physical === 0 && !released) {
      released = true;
      unsettledOperations--;
    }
  }
  function limit(condition: boolean) {
    if (condition) {
      stop();
      throw unavailable();
    }
  }
  function inspect(value: unknown, input = false) {
    const stack = [{ values: [value], index: 0, depth: 0 }];
    let inputBytes = 0;
    let inputContainers = 0;
    while (stack.length) {
      check();
      const frame = stack[stack.length - 1]!;
      if (frame.index === frame.values.length) {
        stack.pop();
        continue;
      }
      const item = frame.values[frame.index++];
      limit(frame.depth > MAX_DEPTH);
      if (typeof item === 'string' && input) {
        // Check length before encoding; percent-encoding and SDK form keys need bounded headroom.
        limit(item.length > HEADER_BYTES);
        inputBytes += Buffer.byteLength(item);
        limit(inputBytes > HEADER_BYTES);
      }
      if (!item || typeof item !== 'object') continue;
      if (input) limit(++inputContainers > MAX_CONTAINERS);
      else limit(++containers > MAX_CONTAINERS);
      if (!input && !Array.isArray(item) && 'fee_details' in item) {
        const fees = item.fee_details;
        limit(!Array.isArray(fees));
        feeDetails += (fees as unknown[]).length;
        limit(feeDetails > MAX_ORDER_TRANSACTIONS);
      }
      const values = Object.values(item);
      // Depth-first frames retain at most MAX_DEPTH ancestor arrays, rather than one frame per element.
      stack.push({ values, index: 0, depth: frame.depth + 1 });
    }
  }
  const boundedFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    check();
    limit(++sends > maxSends);
    const body = init?.body;
    limit(body !== undefined && body !== null && typeof body !== 'string');
    const outgoing = typeof body === 'string' ? Buffer.byteLength(body) : 0;
    const address = String(url);
    limit(address.length > BODY_BYTES);
    requestBytes += outgoing + Buffer.byteLength(address);
    limit(outgoing > BODY_BYTES || requestBytes > maxBytes);
    let requestHeaders = 0;
    for (const [name, value] of new Headers(init?.headers)) {
      requestHeaders += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      limit(requestHeaders > HEADER_BYTES);
    }
    const signal = init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal;
    physical++;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      // Fetch must not follow a redirect with the provider Authorization header.
      response = await fetch(url, { ...init, signal, redirect: 'manual' });
      check();
      let headers = 0;
      for (const [name, value] of response.headers) {
        headers += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
        limit(headers > HEADER_BYTES);
      }
      const length = response.headers.get('content-length');
      limit(
        length !== null && (!/^\d+$/.test(length) || Number(length) > Math.min(BODY_BYTES, maxBytes - responseBytes)),
      );
      limit(response.status >= 300 && response.status < 400);
      reader = response.body?.getReader();
      let bytes = 0;
      const buffer = new Uint8Array(Math.min(BODY_BYTES, maxBytes - responseBytes));
      while (reader) {
        check();
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        responseBytes += chunk.value.byteLength;
        limit(bytes > BODY_BYTES || responseBytes > maxBytes);
        // Copy only admitted bytes; neither chunk count nor chunk size can grow retained storage.
        buffer.set(chunk.value, bytes - chunk.value.byteLength);
      }
      complete = true;
      check();
      const data = buffer.subarray(0, bytes);
      // JSON parsing is now byte bounded. Inspect every nested expansion before the SDK normalizes it.
      const text = new TextDecoder().decode(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* The SDK owns invalid-JSON error mapping. */
      }
      inspect(parsed);
      return new Response(data, { status: response.status, headers: response.headers });
    } finally {
      // Await actual body cancellation, even if the public operation has already rejected.
      if (!complete) {
        if (reader) await reader.cancel().catch(() => {});
        else if (response?.body) await response.body.cancel().catch(() => {});
      }
      reader?.releaseLock();
      physical--;
      release();
    }
  };
  return {
    fetch: boundedFetch as typeof fetch,
    inspectInput: (value: unknown) => inspect(value, true),
    async run<T>(operation: () => Promise<T>): Promise<T> {
      try {
        check();
        const value = await Promise.race([operation(), stopped]);
        check();
        return value;
      } finally {
        returned = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', stop);
        // Retried SDK callbacks may still wake after this public operation ends; they can never send again.
        stop();
        release();
      }
    },
  };
}
