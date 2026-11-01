import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import {
  KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS,
  KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES,
  kindConsentEnrollmentResultValid,
  kindConsentOperationBound,
  kindConsentWorkWithin,
} from '@rezics/auth-contract';
import type { KindConsentEnrollmentInput, KindConsentEnrollmentResult, KindConsentParticipant } from '@rezics/auth-contract';
import { withKindConsentEnrollmentDeadline } from './kind-consent.ts';
import { createCurrentConsentReader, validConsentInput } from './current-consent.ts';

const readPath = '/internal/v1/consents:read';
const enrollPath = '/internal/v1/kind-consents:enroll';

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

async function bodyOf(request: Request, maxBytes: number, deadline: number): Promise<BoundedBody> {
  const contentLength = request.headers.get('content-length');
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes))
  )
    throw new Error('Denied');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Denied');
  let expired = false;
  const duration = Math.min(KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS, deadline - Date.now());
  if (duration <= 0) throw new Error('Deadline');
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, duration);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Denied');
      chunks.push(value);
    }
    if (expired || Date.now() >= deadline) throw new Error('Deadline');
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes: size };
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function boundedResponse(value: unknown, maxBytes: number, status: number): Response {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > maxBytes) throw new Error('Response bound exceeded');
  return new Response(encoded, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
  });
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Deadline')), Math.max(1, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
export function createInternalConsentHandler(config: {
  database: Pool;
  kindConsentParticipant?: KindConsentParticipant;
} & InternalConsentAccessConfiguration): (request: Request) => Promise<Response> {
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
  const keys = createRemoteJWKSet(jwksUrl, { timeoutDuration: KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS });
  const { readCurrentConsent } = createCurrentConsentReader({ database });

  return async (request) => {
    let route: string;
    try {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.search || url.hash) throw new Error('Denied');
      route = url.pathname;
      if (route !== readPath && route !== enrollPath) throw new Error('Denied');
    } catch {
      return json({ error: 'denied' }, 403);
    }

    // The current-consent read retains its original fixed three-second window.
    // Enrollment still consumes the caller's absolute deadline after it is read.
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

    let input: KindConsentEnrollmentInput;
    let deadline: number;
    try {
      const body = await bodyOf(request, KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES, Date.now() + KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS);
      if (!exactRecord(body.value, ['input', 'deadline'])) throw new Error('Denied');
      const rawDeadline = body.value.deadline;
      if (typeof rawDeadline !== 'number' || !Number.isSafeInteger(rawDeadline) || rawDeadline <= Date.now())
        throw new Error('Deadline');
      deadline = rawDeadline as number;
      const candidate = body.value.input;
      const bound = kindConsentOperationBound(candidate as KindConsentEnrollmentInput);
      if (!bound) throw new Error('Denied');
      input = candidate as KindConsentEnrollmentInput;
    } catch (error) {
      if (error instanceof Error && error.message === 'Deadline')
        return boundedResponse(
          { result: { status: 'unavailable' }, work: { status: 'unavailable' } },
          KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
          503,
        );
      return json({ error: 'denied' }, 403);
    }
    if (!kindConsentParticipant) {
      return boundedResponse(
        { result: { status: 'unavailable' }, work: { status: 'unavailable' } },
        KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
        503,
      );
    }
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
      const result = await withKindConsentEnrollmentDeadline(deadline, () => kindConsentParticipant.enroll(input));
      const work = kindConsentParticipant.enroll.actual(input, result);
      if (
        Date.now() >= deadline ||
        !kindConsentEnrollmentResultValid(input, result) ||
        !work ||
        !kindConsentWorkWithin(work, canonicalBound)
      )
        return boundedResponse(
          { result: { status: 'unavailable' }, work: { status: 'unavailable' } },
          KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
          503,
        );
      return boundedResponse({ result, work }, KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES, 200);
    } catch {
      return boundedResponse(
        { result: { status: 'unavailable' }, work: { status: 'unavailable' } },
        KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
        503,
      );
    }
  };
}
