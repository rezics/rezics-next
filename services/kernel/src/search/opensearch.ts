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
    super(reason ?? `OpenSearch request failed with HTTP ${status}`);
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

function parseResponse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function unavailableMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return 'OpenSearch request timed out';
  return 'OpenSearch is unavailable';
}

export function createOpenSearch(url: string, options: { timeoutMs?: number } = {}): OpenSearch {
  const base = new URL(url.endsWith('/') ? url : `${url}/`);
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
    const request: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(requestOptions.timeoutMs ?? defaultTimeoutMs),
    };
    if (method !== 'HEAD' && body !== undefined) request.body = body;
    let response: Response;
    let responseText: string;
    try {
      response = await fetch(target, request);
      responseText = await response.text();
    } catch (error) {
      throw new SearchUnavailableError(unavailableMessage(error), { cause: error });
    }

    const responseBody = parseResponse(responseText);
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      throw new SearchUnavailableError(`OpenSearch is unavailable (HTTP ${response.status})`);
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
