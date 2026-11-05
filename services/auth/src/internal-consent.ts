import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import type { FetchImplementation } from 'jose';
import type { Pool } from 'pg';
import {
  KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS,
  KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES,
  kindConsentEnrollmentVerifiedBound,
  kindConsentEnrollmentVerifiedActual,
  kindConsentEnrollmentResultValid,
  kindConsentOperationBound,
  kindConsentWorkWithin,
} from '@rezics/auth-contract';
import type {
  KindConsentEnrollmentInput,
  KindConsentParticipant,
  KindConsentEnrollmentVerificationUsage,
} from '@rezics/auth-contract';
import { withKindConsentEnrollmentDeadline } from './kind-consent.ts';
import { createCurrentConsentReader, validConsentInput } from './current-consent.ts';

const readPath = '/internal/v1/consents:read';
const enrollPath = '/internal/v1/kind-consents:enroll';
const enrollmentDeadlineHeader = 'X-Rezics-Kind-Deadline';

type VerificationUsage = {
  accessTokenBytes: number;
  jwksRequestBytes: number;
  jwksResponseBytes: number;
  httpControlBytes: number;
};

class ResourceLimitError extends Error {
  constructor() {
    super('Private consent resource limit exceeded');
  }
}

class EnrollmentDeadlineError extends Error {
  constructor() {
    super('Private consent enrollment deadline expired');
  }
}

function parseCanonicalDeadlineHeader(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const deadline = Number(value);
  return Number.isSafeInteger(deadline) && deadline > 0 && String(deadline) === value ? deadline : undefined;
}

function deadlineSignal(request: Request, deadline: number): Readonly<{ signal: AbortSignal; close(): void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (request.signal.aborted) abort();
  else request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    },
  };
}

function bytesOf(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function headerBytes(headers: Headers, except?: string): number {
  let total = 0;
  for (const [name, value] of headers) {
    if (name.toLowerCase() === except?.toLowerCase()) continue;
    total += bytesOf(name) + bytesOf(value);
  }
  return total;
}

function requestControlBytes(request: Request): number {
  return bytesOf(request.url) + bytesOf(request.method) + headerBytes(request.headers, 'Cf-Access-Jwt-Assertion');
}

function privateResponseHeaders(): Headers {
  return new Headers({
    'cache-control': 'private, no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
}

function trustedUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid consent trust configuration');
  return url;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

type BoundedBody = Readonly<{ value: unknown; bytes: number }>;

async function bodyOf(
  request: Request,
  maxBytes: number,
  deadline: number,
  signal?: AbortSignal,
): Promise<BoundedBody> {
  const contentLength = request.headers.get('content-length');
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') throw new Error('Denied');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new Error('Denied');
    if (Number(contentLength) > maxBytes) throw new ResourceLimitError();
  }
  const duration = deadline - Date.now();
  if (duration <= 0 || signal?.aborted) throw new EnrollmentDeadlineError();
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Denied');
  let expired = false;
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, duration);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ResourceLimitError();
      chunks.push(value);
    }
    if (expired || signal?.aborted || Date.now() >= deadline) throw new EnrollmentDeadlineError();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes: size };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function boundedResponse(value: unknown, maxBytes: number, status: number, deadline?: number): Response {
  if (deadline !== undefined && Date.now() >= deadline) throw new EnrollmentDeadlineError();
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > maxBytes) throw new ResourceLimitError();
  if (deadline !== undefined && Date.now() >= deadline) throw new EnrollmentDeadlineError();
  const headers = privateResponseHeaders();
  return new Response(encoded, {
    status,
    headers,
  });
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const cancelled = signal
    ? new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new EnrollmentDeadlineError());
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      })
    : undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new EnrollmentDeadlineError()), Math.max(1, deadline - Date.now()));
      }),
      ...(cancelled ? [cancelled] : []),
    ]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function boundedJwksFetch(
  url: string,
  options: Parameters<FetchImplementation>[1],
  deadline: number,
  operationSignal: AbortSignal,
  usage: VerificationUsage,
): Promise<Response> {
  const requestHeaders = new Headers(options.headers);
  const requestBytes = bytesOf(url) + bytesOf(options.method ?? 'GET') + headerBytes(requestHeaders);
  if (requestBytes > KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES) throw new ResourceLimitError();
  usage.jwksRequestBytes += requestBytes;
  if (usage.jwksRequestBytes > KIND_CONSENT_ENROLLMENT_JWKS_REQUEST_MAX_BYTES) throw new ResourceLimitError();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal.addEventListener('abort', abort, { once: true });
  operationSignal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted || operationSignal.aborted) abort();
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancel = () => void reader?.cancel().catch(() => {});
  controller.signal.addEventListener('abort', cancel, { once: true });
  try {
    response = await fetch(url, { ...options, signal: controller.signal });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return response;
    }
    usage.httpControlBytes += headerBytes(response.headers);
    if (usage.httpControlBytes > KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES) throw new ResourceLimitError();
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      if (!/^\d+$/.test(contentLength)) throw new ResourceLimitError();
      if (Number(contentLength) > KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES) throw new ResourceLimitError();
    }
    if (!response.body) throw new ResourceLimitError();
    reader = response.body.getReader();
    if (controller.signal.aborted) cancel();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES) throw new ResourceLimitError();
      chunks.push(value);
    }
    if (controller.signal.aborted || Date.now() >= deadline) throw new EnrollmentDeadlineError();
    usage.jwksResponseBytes += size;
    if (usage.jwksResponseBytes > KIND_CONSENT_ENROLLMENT_JWKS_RESPONSE_MAX_BYTES) throw new ResourceLimitError();
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } finally {
    controller.signal.removeEventListener('abort', cancel);
    options.signal.removeEventListener('abort', abort);
    operationSignal.removeEventListener('abort', abort);
    if (reader) await reader.cancel().catch(() => {});
    else if (response?.body) await response.body.cancel().catch(() => {});
  }
}

/** Private Auth listener only. Compose on a dedicated private socket/listener
 * reachable solely through Cloudflare Tunnel, with NO public hostname or mount
 * on AuthService.handler. Configure Access Service Auth policy for the kernel
 * worker's existing service token. Supply that application's issuer, certs URL,
 * AUD and Client ID allowlist from trusted deployment configuration. Bind e.g.
 * Bun.serve({ hostname: '127.0.0.1', port: privatePort, fetch: handler }) behind
 * the Tunnel; keep the Auth-owned pool and listener in the existing Auth host.
 * Production URLs use HTTPS; exact loopback HTTP supports isolated test JWKS.
 * Access, not provider JWTs/cookies, supplies Cf-Access-Jwt-Assertion.
 */
export type InternalConsentAccessConfiguration = Readonly<{
  issuer: string;
  jwksUrl: string;
  audience: string;
  allowedServiceTokenIds: readonly string[];
}>;

/** Auth's private consent listener accepts only current reads and canonical
 * Kind enrollment. The enrollment callable is the actual installed participant.
 */
export function createInternalConsentHandler(
  config: {
    database: Pool;
    kindConsentParticipant?: KindConsentParticipant;
  } & InternalConsentAccessConfiguration,
): (request: Request) => Promise<Response> {
  const { database, issuer, audience, kindConsentParticipant } = config;
  const issuerUrl = trustedUrl(issuer);
  const jwksUrl = trustedUrl(config.jwksUrl);
  if (
    issuerUrl.origin !== issuer ||
    !database ||
    typeof audience !== 'string' ||
    !/^[\x21-\x7e]{1,256}$/.test(audience) ||
    !Array.isArray(config.allowedServiceTokenIds) ||
    !config.allowedServiceTokenIds.length ||
    config.allowedServiceTokenIds.length > 64 ||
    config.allowedServiceTokenIds.some((id) => typeof id !== 'string' || !/^[\x21-\x7e]{1,256}\.access$/.test(id))
  )
    throw new Error('Invalid consent trust configuration');
  const identities = new Set(config.allowedServiceTokenIds);
  if (jwksUrl.href.length > 2048) throw new Error('Invalid consent trust configuration');
  const keys = createRemoteJWKSet(jwksUrl, { timeoutDuration: KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS });
  const { readCurrentConsent } = createCurrentConsentReader({ database });

  const unavailableEnrollment = (deadline?: number): Response => {
    const value = { result: { status: 'unavailable' }, work: { status: 'unavailable' } };
    try {
      return boundedResponse(value, KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES, 503, deadline);
    } catch {
      return boundedResponse(value, KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES, 503);
    }
  };

  const handleEnrollment = async (request: Request, arrival: number): Promise<Response> => {
    const originalDeadline = parseCanonicalDeadlineHeader(request.headers.get(enrollmentDeadlineHeader));
    if (originalDeadline === undefined) return json({ error: 'denied' }, 403);
    const deadline = Math.min(originalDeadline, arrival + KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS);
    if (Date.now() >= deadline) return unavailableEnrollment();
    const operation = deadlineSignal(request, deadline);
    const verificationUsage: VerificationUsage = {
      accessTokenBytes: 0,
      jwksRequestBytes: 0,
      jwksResponseBytes: 0,
      httpControlBytes: requestControlBytes(request),
    };
    try {
      if (verificationUsage.httpControlBytes > KIND_CONSENT_ENROLLMENT_HTTP_CONTROL_MAX_BYTES)
        return unavailableEnrollment(deadline);
      const enrollmentKeys = createRemoteJWKSet(jwksUrl, {
        timeoutDuration: KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS,
        [customFetch]: (url, options) => boundedJwksFetch(url, options, deadline, operation.signal, verificationUsage),
      });
      let token: string;
      try {
        token = request.headers.get('Cf-Access-Jwt-Assertion') ?? '';
        if (!token) throw new Error('Denied');
        verificationUsage.accessTokenBytes = bytesOf(token);
        if (verificationUsage.accessTokenBytes > KIND_CONSENT_ENROLLMENT_ACCESS_TOKEN_MAX_BYTES)
          throw new ResourceLimitError();
        if (!/^[\x21-\x7e]+$/.test(token)) throw new Error('Denied');
        const verification = jwtVerify(token, enrollmentKeys, {
          issuer,
          audience,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'iat', 'exp'],
          clockTolerance: 0,
        });
        const { payload } = await withinDeadline(verification, deadline, operation.signal);
        if (
          payload.type !== 'app' ||
          payload.sub !== '' ||
          typeof payload.common_name !== 'string' ||
          !identities.has(payload.common_name) ||
          payload.email !== undefined ||
          !Array.isArray(payload.aud) ||
          payload.aud.length !== 1 ||
          payload.aud[0] !== audience ||
          !Number.isSafeInteger(payload.iat) ||
          !Number.isSafeInteger(payload.exp) ||
          payload.iat! > Math.floor(Date.now() / 1000) ||
          payload.exp! <= payload.iat!
        )
          throw new Error('Denied');
      } catch (error) {
        if (
          error instanceof ResourceLimitError ||
          error instanceof EnrollmentDeadlineError ||
          operation.signal.aborted ||
          Date.now() >= deadline
        )
          return unavailableEnrollment(deadline);
        return json({ error: 'denied' }, 403);
      }

      let input: KindConsentEnrollmentInput;
      try {
        const body = await bodyOf(request, KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES, deadline, operation.signal);
        if (!exactRecord(body.value, ['input', 'deadline'])) throw new Error('Denied');
        if (body.value.deadline !== originalDeadline) throw new Error('Denied');
        const candidate = body.value.input;
        if (!kindConsentOperationBound(candidate as KindConsentEnrollmentInput)) throw new Error('Denied');
        input = candidate as KindConsentEnrollmentInput;
      } catch (error) {
        if (
          error instanceof ResourceLimitError ||
          error instanceof EnrollmentDeadlineError ||
          operation.signal.aborted ||
          Date.now() >= deadline
        )
          return unavailableEnrollment(deadline);
        return json({ error: 'denied' }, 403);
      }

      if (operation.signal.aborted || Date.now() >= deadline) return unavailableEnrollment(deadline);
      if (!kindConsentParticipant) return unavailableEnrollment(deadline);
      const canonicalBound = kindConsentOperationBound(input);
      const declaredBound = kindConsentParticipant.enroll.bound(input);
      if (
        !canonicalBound ||
        !declaredBound ||
        !kindConsentWorkWithin(declaredBound, canonicalBound) ||
        !kindConsentWorkWithin(canonicalBound, declaredBound)
      )
        return json({ error: 'denied' }, 403);
      try {
        const result = await withKindConsentEnrollmentDeadline(
          deadline,
          () => kindConsentParticipant.enroll(input),
          operation.signal,
        );
        const nativeWork = kindConsentParticipant.enroll.actual(input, result);
        verificationUsage.httpControlBytes += headerBytes(privateResponseHeaders());
        const work = nativeWork
          ? kindConsentEnrollmentVerifiedActual(
              input,
              nativeWork,
              verificationUsage satisfies KindConsentEnrollmentVerificationUsage,
            )
          : undefined;
        const verifiedBound = kindConsentEnrollmentVerifiedBound(input);
        if (
          operation.signal.aborted ||
          Date.now() >= deadline ||
          !kindConsentEnrollmentResultValid(input, result) ||
          !verifiedBound ||
          !work ||
          !kindConsentWorkWithin(work, verifiedBound)
        )
          return unavailableEnrollment(deadline);
        return boundedResponse({ result, work }, KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES, 200, deadline);
      } catch {
        return unavailableEnrollment(deadline);
      }
    } finally {
      operation.close();
    }
  };

  return async (request) => {
    const arrival = Date.now();
    let route: string;
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.search || url.hash) throw new Error('Denied');
      route = url.pathname;
      if (route !== readPath && route !== enrollPath) throw new Error('Denied');
    } catch {
      return json({ error: 'denied' }, 403);
    }

    if (route === enrollPath) return handleEnrollment(request, arrival);

    // The current-consent read retains its original fixed three-second window.
    const verifyDeadline = Date.now() + KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS;
    try {
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16384) throw new Error('Denied');
      const verification = jwtVerify(token, keys, {
        issuer,
        audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp'],
        clockTolerance: 0,
      });
      const { payload } = await withinDeadline(verification, verifyDeadline);
      // Cloudflare's service JWT has an empty subject; common_name is the
      // service token Client ID. A human JWT or org cookie cannot supply it.
      if (
        payload.type !== 'app' ||
        payload.sub !== '' ||
        typeof payload.common_name !== 'string' ||
        !identities.has(payload.common_name) ||
        payload.email !== undefined ||
        !Array.isArray(payload.aud) ||
        payload.aud.length !== 1 ||
        payload.aud[0] !== audience ||
        !Number.isSafeInteger(payload.iat) ||
        !Number.isSafeInteger(payload.exp) ||
        payload.iat! > Math.floor(Date.now() / 1000) ||
        payload.exp! <= payload.iat!
      )
        throw new Error('Denied');
    } catch {
      return json({ error: 'denied' }, 403);
    }

    if (route === readPath) {
      let input: { actorAccountId: string; clientId: string };
      try {
        const body = await bodyOf(request, 16384, Date.now() + KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS);
        if (!validConsentInput(body.value)) throw new Error('Denied');
        input = body.value;
      } catch {
        return json({ error: 'denied' }, 403);
      }
      try {
        return json(await readCurrentConsent(input));
      } catch {
        return json({ error: 'unavailable' }, 503);
      }
    }

    return json({ error: 'denied' }, 403);
  };
}
