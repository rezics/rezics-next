export type SearchQuery = Record<string, string | number | boolean>;

export type OpenSearch = {
  request<T = unknown>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    path: string,
    body?: unknown,
    options?: { query?: SearchQuery; timeoutMs?: number },
  ): Promise<{ status: number; body: T }>;
  bulk<T = unknown>(lines: readonly unknown[], options?: { query?: SearchQuery; timeoutMs?: number }): Promise<T>;
};

export class OpenSearchError extends Error {
  status: number;
  type: string | null;
  reason: string | null;
  body: unknown;

  constructor(status: number, body: unknown) {
    const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    const details = error && typeof error === 'object' ? (error as { type?: unknown; reason?: unknown }) : undefined;
    const type = typeof details?.type === 'string' ? details.type : null;
    const reason = typeof details?.reason === 'string' ? details.reason : null;
    // Native diagnostics are internal metadata, never the error's printable message.
    super(`OpenSearch request failed with HTTP ${status}`);
    this.name = 'OpenSearchError';
    this.status = status;
    this.type = type;
    this.reason = reason;
    this.body = body;
  }
}

export class SearchUnavailableError extends Error {
  constructor(message = 'OpenSearch is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'SearchUnavailableError';
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readResponse(response: Response, controller: AbortController, limit: number): Promise<string> {
  // HEAD may advertise the GET representation's length without containing any response bytes.
  if (!response.body) return '';
  const reader = response.body.getReader();
  try {
    const length = response.headers.get('content-length');
    if (length !== null && /^\d+$/.test(length) && Number(length) > limit) throw new SearchUnavailableError();

    // One fixed-capacity buffer bounds retained state even for millions of tiny chunks. Inspect each native
    // chunk before copying or decoding; neither a small Content-Length nor an error status bypasses this count.
    let bytes: Uint8Array | undefined;
    let used = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > limit - used) throw new SearchUnavailableError();
      if (value.byteLength === 0) continue;
      bytes ??= new Uint8Array(limit);
      bytes.set(value, used);
      used += value.byteLength;
    }
    return bytes ? new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)) : '';
  } catch (error) {
    // Abort the native producer as well as cancelling the stream before relinquishing reader ownership.
    controller.abort();
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function unavailableMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'OpenSearch request timed out';
  return 'OpenSearch is unavailable';
}

export function createOpenSearch(
  url: string,
  options: { timeoutMs?: number; /** Internal tests may only lower the hard ceiling. */ maxResponseBytes?: number } = {},
): OpenSearch {
  const base = new URL(url.endsWith('/') ? url : `${url}/`);
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const responseLimit = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > MAX_RESPONSE_BYTES)
    throw new RangeError('OpenSearch response limit must be a positive integer at most 4 MiB');

  async function send<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
    path: string,
    body: string | undefined,
    contentType: string | undefined,
    requestOptions: { query?: SearchQuery; timeoutMs?: number } = {},
  ): Promise<{ status: number; body: T }> {
    const target = new URL(path.replace(/^\/+/, ''), base);
    if (requestOptions.query) {
      for (const [key, value] of Object.entries(requestOptions.query)) target.searchParams.set(key, String(value));
    }

    const headers = new Headers({ accept: 'application/json' });
    if (contentType) headers.set('content-type', contentType);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('OpenSearch request timed out', 'TimeoutError')),
      requestOptions.timeoutMs ?? defaultTimeoutMs,
    );
    const request: RequestInit = {
      method,
      headers,
      signal: controller.signal,
    };
    if (method !== 'HEAD' && body !== undefined) request.body = body;
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(target, request);
      responseText = await readResponse(response, controller, responseLimit);
    } catch (error) {
      // Fetch/parser errors can carry configured credentials or response excerpts. Do not retain them as causes.
      throw new SearchUnavailableError(unavailableMessage(error));
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new SearchUnavailableError(`OpenSearch is unavailable (HTTP ${response.status})`);
    }
    let responseBody: unknown;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText) as unknown;
      } catch {
        if (response.status < 400) throw new SearchUnavailableError();
        // Non-JSON native errors retain their HTTP classification without retaining a raw response payload.
      }
    }
    if (response.status >= 400) throw new OpenSearchError(response.status, responseBody);
    return { status: response.status, body: responseBody as T };
  }

  return {
    request<T = unknown>(
      method: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'HEAD',
      path: string,
      body?: unknown,
      requestOptions?: { query?: SearchQuery; timeoutMs?: number },
    ): Promise<{ status: number; body: T }> {
      let json: string | undefined;
      if (body !== undefined) json = JSON.stringify(body);
      return send<T>(method, path, json, body === undefined ? undefined : 'application/json', requestOptions);
    },

    bulk<T = unknown>(
      lines: readonly unknown[],
      requestOptions?: { query?: SearchQuery; timeoutMs?: number },
    ): Promise<T> {
      const serialized = lines.map((line) => {
        const value = JSON.stringify(line);
        if (value === undefined) throw new TypeError('Bulk lines must be JSON serializable values');
        return value;
      });
      return send<T>('POST', '/_bulk', `${serialized.join('\n')}\n`, 'application/x-ndjson', requestOptions).then(
        (response) => response.body,
      );
    },
  };
}
