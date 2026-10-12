import { getEndpoints, getSession } from 'better-auth/api';
import type { AuthContext, BetterAuthOptions } from 'better-auth';
import type { GenericEndpointContext } from '@better-auth/core';
import { createInternalContext, type EndpointOptions } from 'better-call';
import type { AccountAuth } from './http.ts';
import { AsyncLocalStorage } from 'node:async_hooks';

const jsonAuthenticationPaths = new Set([
  '/api/auth/sign-in/email', '/api/auth/request-password-reset', '/api/auth/reset-password',
  '/api/auth/passkey/verify-authentication', '/api/auth/passkey/verify-registration',
]);

/** Refuse provider forms before selecting a lock, activity or budget owner.
 * OAuth token and introspection forms retain their provider contract. */
export async function authenticationMediaTypeFailure(request: Request): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || (!jsonAuthenticationPaths.has(path)
    && !path.startsWith('/api/auth/two-factor/verify-'))) return null;
  const mediaType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') return Response.json({ error: 'unsupported_media_type' },
    { status: 415, headers: { 'cache-control': 'no-store' } });
  try { await authenticationBody(request); return null; }
  catch { return Response.json({ error: 'invalid_request' },
    { status: 400, headers: { 'cache-control': 'no-store' } }); }
}

const bodies = new WeakMap<Request, Record<string, unknown>>();

/** Parse before selecting any lock or limiter owner. Duplicate keys must not
 * disappear at the provider boundary, including escaped keys and response.id. */
export async function authenticationBody(request: Request): Promise<Record<string, unknown>> {
  const cached = bodies.get(request);
  if (cached) return cached;
  const text = await request.clone().text();
  let at = 0;
  const invalid = (): never => { throw new Error('invalid authentication JSON'); };
  const space = () => { while (/[\t\r\n ]/.test(text[at] ?? '') && at < text.length) at++; };
  const string = (): string => {
    if (text[at++] !== '"') return invalid();
    let result = '';
    while (at < text.length) {
      const char = text[at++]!;
      if (char === '"') return result;
      if (char.charCodeAt(0) < 32) return invalid();
      if (char !== '\\') { result += char; continue; }
      const escape = text[at++];
      if (escape === 'u') {
        const hex = text.slice(at, at + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return invalid();
        result += String.fromCharCode(Number.parseInt(hex, 16));
        at += 4;
      } else {
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/',
          b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (escape === undefined || !Object.hasOwn(escapes, escape)) return invalid();
        result += escapes[escape];
      }
    }
    return invalid();
  };
  const value = (depth: number): unknown => {
    if (depth > 32) return invalid();
    space();
    if (text[at] === '"') return string();
    const open = text[at];
    if (open === '{' || open === '[') {
      at++;
      const end = open === '{' ? '}' : ']';
      const fields = Object.create(null) as Record<string, unknown>;
      const items: unknown[] = [];
      const seen = new Set<string>();
      space();
      if (text[at] === end) { at++; return open === '{' ? fields : items; }
      for (;;) {
        space();
        if (open === '{') {
          const key = string();
          const canonical = key.trim().toLowerCase();
          if (seen.has(canonical) || (['email', 'token', 'response', 'id'].includes(canonical)
            && key !== canonical)) return invalid();
          seen.add(canonical);
          space();
          if (text[at++] !== ':') return invalid();
          fields[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        space();
        if (text[at] === end) { at++; return open === '{' ? fields : items; }
        if (text[at++] !== ',') return invalid();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at))?.[0];
    if (!token) return invalid();
    at += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const number = Number(token);
    return Number.isFinite(number) ? number : invalid();
  };
  const parsed = value(0);
  space();
  if (at !== text.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
  const body = parsed as Record<string, unknown>;
  bodies.set(request, body);
  return body;
}

export type AuthenticationProvider = PreparationProvider & { api?: Pick<AccountAuth['api'], 'getSession'> };
type PreparationProvider = { options: BetterAuthOptions; $context: Promise<Pick<AuthContext,
  'baseURL' | 'options' | 'createAuthCookie' | 'secret' | 'getPlugin'>> };
export type AuthenticationSession = NonNullable<Awaited<ReturnType<AccountAuth['api']['getSession']>>>;
export type PreparedAuthentication = Readonly<{
  kind: 'http' | 'provider-context' | 'session';
  path: string;
  method: string;
  endpointPath?: string;
  body: Record<string, unknown>;
  query: Record<string, unknown>;
  sessionQuery: { disableCookieCache?: boolean; disableRefresh?: boolean };
  headers: Headers;
  session?: AuthenticationSession;
  providerContext?: GenericEndpointContext;
}>;
type ProviderInput = { kind: 'provider-context'; context: GenericEndpointContext };
const invalidInput = () => Response.json({ error: 'invalid_request' },
  { status: 400, headers: { 'cache-control': 'no-store' } });

/** Admission and schema validation run once, without middleware, endpoint
 * work or proof consumption. Provider hooks keep their original extra fields. */
export async function prepareAuthentication(auth: PreparationProvider, source: Request | ProviderInput): Promise<
  { kind: 'prepared'; input: PreparedAuthentication } | { kind: 'reject'; response: Response }
> {
  const provider = await auth.$context;
  // The initialized object is intact. Erase only the provider's invariant
  // adapter option generic at this public endpoint-discovery boundary.
  const { api } = getEndpoints(auth.$context as Promise<AuthContext>, auth.options);
  const embedded = !(source instanceof Request);
  const method = embedded ? source.context.method ?? 'POST' : source.method;
  const path = embedded ? `/api/auth${source.context.path}` : new URL(source.url).pathname;
  const headers = new Headers(embedded ? source.context.headers : source.headers);
  const query: Record<string, unknown> = embedded ? { ...source.context.query } : Object.create(null);
  if (!embedded) new URL(source.url).searchParams.forEach((value, key) => {
    if (Object.hasOwn(query, key)) query[key] = Array.isArray(query[key]) ? [...query[key], value] : [query[key], value];
    else query[key] = value;
  });
  const basePath = new URL(provider.baseURL).pathname.replace(/\/+$/, '');
  const providerPath = embedded ? source.context.path : path.slice(basePath.length);
  const endpoint = Object.values(api).find(endpoint => {
    const options: EndpointOptions = endpoint.options;
    return (embedded || path.startsWith(`${basePath}/`)) && endpoint.path === providerPath
      && (Array.isArray(options.method)
        ? options.method.some(value => value === method) : options.method === method);
  });
  const endpointOptions: EndpointOptions | undefined = endpoint?.options;
  let body: Record<string, unknown> = embedded ? source.context.body ?? {} : {};
  try {
    if (!embedded) {
      const failure = await authenticationMediaTypeFailure(source);
      if (failure) return { kind: 'reject', response: failure };
      // Other provider APIs retain their own media parser and their own owner.
      // Only credential operations need a prepared HTTP body here.
      if (method === 'POST' && (jsonAuthenticationPaths.has(path)
        || path.startsWith('/api/auth/two-factor/verify-'))) body = await authenticationBody(source);
    }
    const validation = await createInternalContext({ body, query, headers, method },
      { options: { method, body: embedded || Object.keys(body).length || jsonAuthenticationPaths.has(path)
        || path.startsWith('/api/auth/two-factor/verify-') ? endpointOptions?.body : undefined,
      query: endpointOptions?.query } });
    // signInEmail's route schema accepts a string; its handler applies the
    // provider's email schema before looking up any owner. Reuse that schema.
    if (endpoint?.path === '/sign-in/email') await createInternalContext({ body: { email: validation.body.email } },
      { options: { method: 'POST', body: api.sendVerificationEmail.options.body } });
    const sessionOptions = await createInternalContext({ query, headers },
      { options: { method: 'GET', query: api.getSession.options.query } });
    return { kind: 'prepared', input: Object.freeze({ kind: embedded ? 'provider-context' : 'http',
      path, method, endpointPath: endpoint?.path, body: Object.freeze(validation.body ?? {}),
      query: Object.freeze(validation.query ?? {}), sessionQuery: Object.freeze(sessionOptions.query ?? {}), headers,
      ...(embedded ? { providerContext: source.context } : {}) }) };
  } catch { return { kind: 'reject', response: invalidInput() }; }
}

/** Elysia already validated the explicit custom proof body and origin. Carry
 * its provider-derived actor instead of inventing another HTTP body grammar. */
export function prepareSessionAuthentication(request: Request, session: AuthenticationSession,
  body: Record<string, unknown>): PreparedAuthentication {
  return Object.freeze({ kind: 'session', path: new URL(request.url).pathname, method: request.method,
    body: Object.freeze(body), query: {}, sessionQuery: {}, headers: new Headers(request.headers), session });
}

export async function authenticationSession(auth: AuthenticationProvider, input: PreparedAuthentication) {
  if (input.kind === 'session') return input.session ?? null;
  if (input.providerContext) {
    if (input.providerContext.context.session) return input.providerContext.context.session;
    // Use the helper's own endpoint with its real initialized context. The
    // helper catches storage errors as null; admission must preserve outages.
    return getSession()({ ...input.providerContext, headers: input.headers, method: 'GET', asResponse: false,
      returnHeaders: false, returnStatus: false, query: input.sessionQuery });
  }
  // Direct provider errors stay visible: a session-store outage cannot turn
  // into anonymous challenge authorization through the helper's null catch.
  if (!auth.api) throw new Error('HTTP authentication needs the provider session API');
  return auth.api.getSession({ headers: input.headers, query: input.sessionQuery });
}

type AuthenticationEvidence = { authenticatedUserIds: Set<string>; issuedTokens: Set<string>;
  providerPasskeys: Map<string, string> };
const exchanges = new AsyncLocalStorage<AuthenticationEvidence>();
const proofResponses = new WeakSet<Response>();

/** Provider hooks report their actual computation; this is output evidence,
 * never another parser or a predicted owner. Embedded calls may report too. */
export function recordAuthenticatedSubject(userId: string, issuedToken?: string) {
  const evidence = exchanges.getStore();
  evidence?.authenticatedUserIds.add(userId);
  if (issuedToken) evidence?.issuedTokens.add(issuedToken);
}
/** Keep the provider adapter's returned row until its verification callback.
 * This snapshot reports the provider's own computation; no second lookup can
 * substitute a different owner between verified assertion and session issue. */
export function recordProviderPasskey(row: unknown) {
  if (!row || typeof row !== 'object') return;
  const key = row as { credentialID?: unknown; userId?: unknown };
  if (typeof key.credentialID === 'string' && typeof key.userId === 'string') {
    exchanges.getStore()?.providerPasskeys.set(key.credentialID, key.userId);
  }
}
export function recordVerifiedPasskey(credentialId: string): boolean {
  const evidence = exchanges.getStore();
  if (!evidence) return true;
  const owner = evidence.providerPasskeys.get(credentialId);
  if (!owner) return false;
  evidence.authenticatedUserIds.add(owner);
  return true;
}
export async function runAuthenticationExchange<T>(work: () => Promise<T>) {
  const evidence: AuthenticationEvidence = { authenticatedUserIds: new Set(), issuedTokens: new Set(), providerPasskeys: new Map() };
  const result = await exchanges.run(evidence, work);
  return { result, ...evidence };
}
export async function authenticationProviderResponse(auth: Pick<AccountAuth, 'handler'>, request: Request) {
  const response = await auth.handler(request);
  proofResponses.add(response);
  return response;
}
export function isAuthenticationProofResponse(response: Response) { return proofResponses.has(response); }
