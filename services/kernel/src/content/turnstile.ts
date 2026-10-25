const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 2_048;

export type TurnstileVerification =
  | { ok: true; hostname: string; action: string; challengeTimestamp?: string }
  | { ok: false; reason: 'invalid' | 'unavailable' };

export type TurnstileVerifyOptions = { signal?: AbortSignal; deadline?: number };

export type TurnstileVerifier = {
  verify(token: string, options?: TurnstileVerifyOptions): Promise<TurnstileVerification>;
};

export type TurnstileVerifierConfig = {
  secret: string | undefined;
  hostname: string | undefined;
  action: string | undefined;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Override only for a trusted provider fixture or a controlled deployment endpoint. */
  siteverifyUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

type ProviderResponse = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  challenge_ts?: unknown;
};

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return 0;
  return value;
}

function validConfiguration(config: TurnstileVerifierConfig): boolean {
  if (!config.secret?.trim() || !config.hostname?.trim() || !config.action?.trim()) return false;
  if (config.secret.length > 4096 || config.hostname.length > 253 || config.action.length > 32) return false;
  if (config.hostname !== config.hostname.trim() || config.action !== config.action.trim()) return false;
  if (!/^[a-z0-9_-]+$/i.test(config.action)) return false;
  const timeout = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maximum = boundedInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  if (!timeout || !maximum) return false;
  try {
    const url = new URL(config.siteverifyUrl ?? SITEVERIFY_URL);
    return url.protocol === 'https:' || (config.siteverifyUrl !== undefined && url.protocol === 'http:');
  } catch {
    return false;
  }
}

function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maximum) throw new Error('response-too-large');
  if (!response.body) return Promise.resolve('');
  return (async () => {
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        if (signal.aborted) throw new Error('aborted');
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          void reader.cancel();
          throw new Error('response-too-large');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  })();
}

function invalid(): TurnstileVerification {
  return { ok: false, reason: 'invalid' };
}

function unavailable(): TurnstileVerification {
  return { ok: false, reason: 'unavailable' };
}

/** Creates a bounded Siteverify adapter; successful proof facts are not authorization. */
export function createTurnstileVerifier(config: TurnstileVerifierConfig): TurnstileVerifier {
  if (!validConfiguration(config)) return { verify: async () => unavailable() };

  const secret = config.secret!;
  const hostname = config.hostname!;
  const action = config.action!;
  const endpoint = config.siteverifyUrl ?? SITEVERIFY_URL;
  const fetcher = config.fetch ?? globalThis.fetch;
  const timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxResponseBytes = boundedInteger(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);

  return {
    async verify(token: string, options: TurnstileVerifyOptions = {}): Promise<TurnstileVerification> {
      if (typeof token !== 'string' || token.length < 1 || token.length > MAX_TOKEN_LENGTH) return invalid();
      if (options.signal?.aborted) return unavailable();
      if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || options.deadline <= Date.now()))
        return unavailable();

      const remaining = options.deadline === undefined ? timeoutMs : Math.min(timeoutMs, options.deadline - Date.now());
      if (remaining <= 0) return unavailable();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener('abort', forwardAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), remaining);

      try {
        const work = async (): Promise<TurnstileVerification> => {
          const body = new URLSearchParams({ secret, response: token });
          const response = await fetcher(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body,
            signal: controller.signal,
          });
          if (!response.ok) return unavailable();
          const text = await readBounded(response, maxResponseBytes, controller.signal);
          let data: ProviderResponse;
          try {
            data = JSON.parse(text) as ProviderResponse;
          } catch {
            return unavailable();
          }
          if (data.success !== true) return invalid();
          if (data.hostname !== hostname || data.action !== action) return invalid();
          return {
            ok: true,
            hostname,
            action,
            ...(typeof data.challenge_ts === 'string' ? { challengeTimestamp: data.challenge_ts } : {}),
          };
        };
        const timeout = new Promise<TurnstileVerification>((resolve) => {
          const check = () => resolve(unavailable());
          controller.signal.addEventListener('abort', check, { once: true });
        });
        return await Promise.race([work(), timeout]);
      } catch {
        return unavailable();
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', forwardAbort);
      }
    },
  };
}
