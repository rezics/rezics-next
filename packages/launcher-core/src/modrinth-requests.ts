import { getJson } from './catalog.ts';

const apiOrigin = 'https://api.modrinth.com';
const cdnOrigin = 'https://cdn.modrinth.com';
export const modrinthApi = `${apiOrigin}/v2`;

function milliseconds(value: string | null | undefined) {
  if (!value || !/^\d+$/u.test(value.trim())) return;
  const delay = Number(value) * 1000;
  return Number.isSafeInteger(delay) ? delay : undefined;
}

function retryDelay(headers: Headers) {
  const after = headers.get('retry-after')?.trim();
  const delta = milliseconds(after);
  if (delta !== undefined) return delta;
  if (after?.endsWith('GMT')) {
    const date = Date.parse(after);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return milliseconds(headers.get('x-ratelimit-reset')) ?? 10_000;
}

export class ModrinthRequests {
  private readonly retryAt = new Map<string, number>();
  private readonly agent: string;

  constructor(
    private readonly fetcher: typeof fetch,
    launcherVersion: string,
  ) {
    this.agent = `REZICS/launcher-${launcherVersion} (https://rezics.com)`;
  }

  metadata(url: URL, signal?: AbortSignal) {
    return getJson(this.fetch, url, signal);
  }

  readonly fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const { origin } = url;
    if (origin !== apiOrigin && origin !== cdnOrigin) return this.fetcher(input, init);

    const signal = init?.signal;
    signal?.throwIfAborted();
    const service = origin === apiOrigin ? 'Modrinth' : 'The Modrinth download service';
    const rateLimit = () => {
      const seconds = Math.max(1, Math.ceil(((this.retryAt.get(origin) ?? 0) - performance.now()) / 1000));
      return new Error(`${service} is rate limiting requests. Retry in ${seconds}s.`);
    };
    if ((this.retryAt.get(origin) ?? 0) > performance.now()) throw rateLimit();

    const headers = new Headers(init?.headers);
    headers.set('user-agent', this.agent);
    let response: Response;
    try {
      response = await this.fetcher(input, { ...init, credentials: 'omit', headers });
    } catch {
      signal?.throwIfAborted();
      throw new Error(`${service} could not be reached. Check your connection and retry.`);
    }
    if (response.status < 400) return response;
    if (response.status === 429) {
      this.retryAt.set(
        origin,
        Math.max(this.retryAt.get(origin) ?? 0, performance.now() + retryDelay(response.headers)),
      );
    }
    await response.body?.cancel().catch(() => {});
    signal?.throwIfAborted();
    if (response.status === 429) throw rateLimit();
    if (response.status >= 500) throw new Error(`${service} is temporarily unavailable (HTTP ${response.status}).`);
    if (response.status === 404)
      throw new Error('The requested Modrinth project, release or file is unavailable (HTTP 404).');
    throw new Error(`${service} rejected the request (HTTP ${response.status}).`);
  }) as typeof fetch;
}
