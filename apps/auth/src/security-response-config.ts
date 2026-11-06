import { createServerOnlyFn } from '@tanstack/react-start';
import { securityResponseByteBudgets, securityScopeLimit } from '@rezics/auth-contract';

export type SecurityInventoryView = 'clients' | 'consents';

export type SecurityResponseConfiguration = {
  scopeLimit: number;
  sessionBytes: number;
};

/** Parse the trusted native catalogue mode injected into the Auth server build. */
export function parseSecurityResponseConfiguration(value: unknown): SecurityResponseConfiguration | null {
  let scopeLimit: number;
  if (value === 'native-no-catalogue') scopeLimit = securityScopeLimit();
  else if (typeof value === 'string') {
    const match = /^catalogue:([1-9]\d*)$/.exec(value);
    if (!match) return null;
    scopeLimit = Number(match[1]);
    if (!Number.isSafeInteger(scopeLimit) || scopeLimit < 3) return null;
  } else return null;

  try {
    const budgets = securityResponseByteBudgets(scopeLimit, 20);
    const sessionBytes = budgets.session;
    return Number.isSafeInteger(sessionBytes) && sessionBytes > 0 ? Object.freeze({ scopeLimit, sessionBytes }) : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

export function securityInventoryResponseByteBudget(
  view: SecurityInventoryView,
  configuration: unknown,
): number | null {
  const parsed = parseSecurityResponseConfiguration(configuration);
  if (!parsed) return null;
  try {
    const budget = securityResponseByteBudgets(parsed.scopeLimit, 20)[view];
    return Number.isSafeInteger(budget) && budget > 0 ? budget : null;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** The browser cannot choose C. The Worker binding comes from trusted Auth composition. */
export const trustedSecurityResponseConfiguration = createServerOnlyFn(async () => {
  const { env } = await import('cloudflare:workers');
  return parseSecurityResponseConfiguration(
    (env as { AUTH_SECURITY_SCOPE_CONFIGURATION?: unknown }).AUTH_SECURITY_SCOPE_CONFIGURATION,
  );
});

export const serverSecurityInventoryResponseByteBudget = createServerOnlyFn(async (view: SecurityInventoryView) => {
  const { env } = await import('cloudflare:workers');
  return securityInventoryResponseByteBudget(view, env.AUTH_SECURITY_SCOPE_CONFIGURATION);
});

type SecurityResponseReader<T> = (response: Response, signal: AbortSignal) => Promise<T>;
type SecurityIssuerRequestStart = () => void;

/**
 * The Auth origin that may read the issuer for this caller, or null to refuse. Browsers send Origin on POST but not
 * on same-origin or typed GET navigations, so those identify the caller by fetch metadata instead.
 */
export function securityIssuerCallerOrigin(headers: Headers, origin: string, issuer: string): string | null {
  const declared = headers.get('origin');
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site') return null;
  if (declared === null) return site === 'same-origin' || site === 'none' ? origin : null;
  return declared === origin || declared === issuer ? declared : null;
}

function raceAbort<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** One private Auth issuer transport, shared by Security inventory and account-session receiving. */
export const readSecurityIssuerResponse = createServerOnlyFn(
  async <T>(
    path: string,
    body: unknown | undefined,
    read: SecurityResponseReader<T>,
    requestStart?: SecurityIssuerRequestStart,
  ): Promise<T> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    const request = getRequest();
    setResponseHeader('Cache-Control', 'private, no-store');
    const origin = new URL(request.url).origin;
    const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
    const signal = request.signal;
    const callerOrigin = securityIssuerCallerOrigin(request.headers, origin, issuer);
    if (callerOrigin === null) return read(new Response(null, { status: 403 }), signal);

    // The originating privateAuthRead signal bounds headers, body consumption and delivery.
    signal.throwIfAborted();
    requestStart?.();
    const response = await raceAbort(
      signal,
      fetch(new URL(path, issuer), {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          Accept: 'application/json',
          Origin: callerOrigin,
          Cookie: request.headers.get('cookie') ?? '',
        },
        redirect: 'manual',
        cache: 'no-store',
        signal,
      }),
    );
    if (response.status >= 300 && response.status < 400) throw new Error('Unexpected issuer redirect');
    return raceAbort(signal, read(response, signal));
  },
);
