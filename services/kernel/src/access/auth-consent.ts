import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
export type CurrentConsent = Readonly<{
  actorAccountId: string;
  clientId: string;
  scopes: readonly string[];
}>;
export type CurrentConsentReader = (input: {
  actorAccountId: string;
  clientId: string;
  deadline: number;
}) => Promise<CurrentConsent | null>;

function id(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value);
}
function scopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 100 &&
    value.every(
      (scope) => typeof scope === 'string' && scope.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    )
  );
}
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    Number(response.headers.get('content-length') ?? 0) > 32768
  )
    throw new Error('Unavailable');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) throw new Error('Unavailable');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/** Trusted server composition for durable person-attributed steps only. Supply
 * the exact private HTTPS Tunnel/Access URL and service token credentials; never
 * accept these from request fields. Exact loopback HTTP is for isolated tests.
 * No Auth database, keys, cookies or provider introspection enter the kernel.
 * Every invocation obtains Auth's native current fact, independently of Access's
 * evaluator T/clock. Inject into the restorer; do not install in requestJSON.
 */
export function createAuthConsentReader(config: {
  url: string;
  serviceTokenId: string;
  serviceTokenSecret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): CurrentConsentReader {
  const url = new URL(config.url);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  const { serviceTokenId, serviceTokenSecret } = config;
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/internal/v1/consents:read' ||
    !id(serviceTokenId) ||
    !id(serviceTokenSecret)
  )
    throw new Error('Invalid Auth consent configuration');
  const target = url.href;
  const transport = config.fetch ?? globalThis.fetch;
  return async (input) => {
    if (
      !input ||
      Object.keys(input).length !== 3 ||
      !Object.hasOwn(input, 'actorAccountId') ||
      !Object.hasOwn(input, 'clientId') ||
      !Object.hasOwn(input, 'deadline') ||
      !id(input.actorAccountId) ||
      !id(input.clientId) ||
      !Number.isFinite(input.deadline)
    )
      return null;
    const { actorAccountId, clientId, deadline } = input;
    requireAccessDeadline(deadline);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AccessUnavailableError('deadline'));
        controller.abort();
      }, deadline - Date.now());
    });
    const operation = async (): Promise<CurrentConsent | null> => {
      let response: Response | undefined;
      const abort = () => {
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      try {
        response = await transport(target, {
          method: 'POST',
          redirect: 'error',
          cache: 'no-store',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'CF-Access-Client-Id': serviceTokenId,
            'CF-Access-Client-Secret': serviceTokenSecret,
          },
          body: JSON.stringify({ actorAccountId, clientId }),
        });
        if (
          controller.signal.aborted ||
          response.status !== 200 ||
          response.redirected ||
          (response.url && response.url !== target)
        )
          return null;
        const value: unknown = await boundedJson(response, controller.signal);
        requireAccessDeadline(deadline);
        if (!value || typeof value !== 'object' || Array.isArray(value) || controller.signal.aborted) return null;
        const record = value as Record<string, unknown>;
        if (
          Object.keys(record).length !== 3 ||
          record.actorAccountId !== actorAccountId ||
          record.clientId !== clientId ||
          !scopes(record.scopes)
        )
          return null;
        return { actorAccountId, clientId, scopes: [...new Set(record.scopes)].sort() };
      } catch (error) {
        throwAccessUnavailable(error, deadline);
        return null;
      } finally {
        controller.signal.removeEventListener('abort', abort);
        if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      }
    };
    try {
      const result = await Promise.race([operation(), expired]);
      requireAccessDeadline(deadline);
      return result;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
