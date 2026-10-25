import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const DEADLINE_MS = 5000;
const MAX_RESPONSE_BYTES = 8192;

export type TurnstileConfiguration = { secret: string; fetch?: typeof fetch };

export class TurnstileUnavailableError extends Error {
  override readonly name = 'TurnstileUnavailableError';
  constructor() {
    super('Turnstile Siteverify unavailable');
  }
}

/** Only a single literal address from Cloudflare's edge header is forwarded. */
export function sanitizedClientIp(request: Request): string | undefined {
  const value = request.headers.get('cf-connecting-ip')?.trim();
  return value && isIP(value) ? value : undefined;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new TurnstileUnavailableError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new TurnstileUnavailableError();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const bytes = Buffer.concat(chunks, size);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new TurnstileUnavailableError();
  }
}

/** Verify one sign-up token using a bounded Siteverify request. */
export async function verifyTurnstile(
  configuration: TurnstileConfiguration,
  input: { token: string; hostname: string; remoteIp?: string },
): Promise<boolean> {
  if (typeof configuration.secret !== 'string' || !configuration.secret || configuration.secret.length > 4096)
    throw new TurnstileUnavailableError();

  const form = new URLSearchParams({
    secret: configuration.secret,
    response: input.token,
    ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
    idempotency_key: randomUUID(),
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TurnstileUnavailableError());
    }, DEADLINE_MS);
  });
  const request = (async () => {
    const response = await (configuration.fetch ?? fetch)(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new TurnstileUnavailableError();
    const value = await boundedJson(response);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TurnstileUnavailableError();
    const result = value as Record<string, unknown>;
    if (typeof result.success !== 'boolean') throw new TurnstileUnavailableError();
    if (!result.success) return false;
    return result.action === 'signup' && result.hostname === input.hostname;
  })();

  try {
    return await Promise.race([request, deadline]);
  } catch {
    throw new TurnstileUnavailableError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort();
  }
}
