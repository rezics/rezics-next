import { MAX_CONSENTED_SCOPES, MAX_CONSENTED_SCOPE_OCTETS } from '@rezics/auth-contract';
import { ConfigError } from '../commerce/config.ts';
import { AccessUnavailableError, requireAccessDeadline, throwAccessUnavailable } from './unavailable.ts';
export type AuthConsentConfig = Readonly<{
  url: string;
  serviceTokenId: string;
  serviceTokenSecret: string;
}>;

export const AUTH_CONSENT_VARIABLES = Object.freeze([
  'KERNEL_AUTH_CONSENT_URL',
  'CF_ACCESS_CLIENT_ID',
  'CF_ACCESS_CLIENT_SECRET',
] as const);

/** Shared host configuration for every module that restores an initiator.
 * The group is absent or complete; errors name a variable, never its value. */
export function readAuthConsentConfig(env: Readonly<Record<string, string | undefined>>): AuthConsentConfig | null {
  if (!AUTH_CONSENT_VARIABLES.some((variable) => env[variable] !== undefined)) return null;
  const url = consentValue(env, 'KERNEL_AUTH_CONSENT_URL');
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.pathname !== '/internal/v1/consents:read' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error();
  } catch {
    throw new ConfigError('KERNEL_AUTH_CONSENT_URL');
  }
  return Object.freeze({
    url,
    serviceTokenId: consentValue(env, 'CF_ACCESS_CLIENT_ID'),
    serviceTokenSecret: consentValue(env, 'CF_ACCESS_CLIENT_SECRET'),
  });
}

/** Consent values keep the historical visible-ASCII bound. */
function consentValue(env: Readonly<Record<string, string | undefined>>, variable: string): string {
  const value = env[variable];
  if (!value || !/^[\x21-\x7e]{1,1024}$/.test(value)) throw new ConfigError(variable);
  return value;
}

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
    value.length <= MAX_CONSENTED_SCOPES &&
    value.every(
      (scope) => typeof scope === 'string' && scope.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    )
  );
}
// JSON adds two quotes per scope, punctuation, two bounded IDs and field names.
const consentResponseOctets = MAX_CONSENTED_SCOPE_OCTETS + 2 * MAX_CONSENTED_SCOPES + 2 * 1024 + 128;
async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    Number(response.headers.get('content-length') ?? 0) > consentResponseOctets
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
      if (size > consentResponseOctets) throw new Error('Unavailable');
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
export function createAuthConsentReader(
  config: AuthConsentConfig & {
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
  },
): CurrentConsentReader {
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
