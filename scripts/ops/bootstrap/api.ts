import {
  assertOperationOutcome,
  type OperationOutcome,
} from '../../../services/main/src/modules/operation/outcome.ts';

export class BootstrapApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly path: string,
  ) {
    super(`Bootstrap ${path}: HTTP ${status} (${code})`);
  }
}
export interface BootstrapApi {
  read<T>(path: string, publicRead?: boolean): Promise<T>;
  write<T>(method: 'POST' | 'PUT', path: string, body: unknown, key: string): Promise<T>;
}
export type BootstrapFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** One sequential caller keeps Account's rate-limit class. A 202 is pending,
 * never success; a lost response is recovered with the identical command key.
 * Error text from a remote server is never logged with credentials or cookies. */
export class HttpBootstrapApi implements BootstrapApi {
  private readonly startedAt = Date.now();
  constructor(
    private readonly origin: string,
    private readonly token: () => string,
    private readonly fetcher: BootstrapFetch = fetch,
    private readonly pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly wallBudgetMs = 600_000,
  ) {}
  read<T>(path: string, publicRead = false): Promise<T> {
    return this.exchange<T>('GET', path, undefined, undefined, publicRead);
  }
  write<T>(method: 'POST' | 'PUT', path: string, body: unknown, key: string): Promise<T> {
    return this.exchange<T>(method, path, body, key, false);
  }
  private async exchange<T>(
    method: string,
    path: string,
    body: unknown,
    key: string | undefined,
    publicRead: boolean,
  ): Promise<T> {
    if (!path.startsWith('/v1/') || path.startsWith('//'))
      throw new Error('Bootstrap requires a Main public API path');
    for (let attempt = 0; attempt < 8; attempt++) {
      const remaining = this.wallBudgetMs - (Date.now() - this.startedAt);
      if (remaining <= 0)
        throw new Error(
          'Bootstrap exceeded its 600-second preparation budget; resume the same plan',
        );
      const response = await this.fetcher(new URL(path, this.origin), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(30_000, remaining)),
        headers: {
          ...(publicRead ? {} : { authorization: `Bearer ${this.token()}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key ? { 'idempotency-key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if ([202, 429, 503].includes(response.status) && attempt < 7) {
        const retry = response.headers.get('retry-after');
        const seconds = retry === null ? 1 : Number(retry);
        // Refuse a long wait; the journal retains the command for the next run.
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 5) {
          await response.body?.cancel();
          await this.pause(Math.max(100, seconds * 1000));
          continue;
        }
      }
      const parsed: unknown = await response.json().catch(() => null);
      if (!response.ok || response.status === 202) {
        const code =
          parsed &&
          typeof parsed === 'object' &&
          'code' in parsed &&
          typeof parsed.code === 'string' &&
          /^[a-z0-9_-]{1,100}$/.test(parsed.code)
            ? parsed.code
            : 'unconfirmed';
        throw new BootstrapApiError(response.status, code, path);
      }
      if (!parsed || typeof parsed !== 'object')
        throw new Error(`Bootstrap ${path}: invalid API response`);
      if ('operationId' in parsed && 'status' in parsed && 'items' in parsed) {
        const outcome = parsed as OperationOutcome;
        assertOperationOutcome(outcome);
        if (outcome.status !== 'completed')
          throw new BootstrapApiError(response.status, 'operation_unconfirmed', path);
      }
      return parsed as T;
    }
    throw new Error(`Bootstrap ${path}: retries exhausted`);
  }
}
