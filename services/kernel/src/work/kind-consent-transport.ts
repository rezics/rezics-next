import {
  KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS,
  KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES,
  KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES,
  kindConsentEnrollmentVerifiedBound,
  kindConsentEnrollmentResultValid,
  kindConsentTransportActual,
  kindConsentTransportBound,
  kindConsentWorkWithin,
} from '@rezics/auth-contract';
import type {
  KindConsentEnrollmentInput,
  KindConsentEnrollmentResult,
  KindConsentParticipant,
  KindConsentWorkDeclaration,
} from '@rezics/auth-contract';
import type { AuthConsentConfig } from '../access/auth-consent.ts';
import { nativeWork } from '../history/application/index.ts';

type TransportOptions = Readonly<{ fetch?: (url: string, init: RequestInit) => Promise<Response> }>;
type Invocation = Readonly<{
  input: KindConsentEnrollmentInput;
  work: KindConsentWorkDeclaration;
  requestBytes: number;
  responseBytes: number;
  kernelControlBytes: number;
  deadline: number;
}>;

const unavailable = (): KindConsentEnrollmentResult => Object.freeze({ status: 'unavailable' });
const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

function requestControlBytes(target: string, headers: Headers): number {
  return (
    byteLength(target) +
    byteLength('POST') +
    [...headers].reduce((sum, [name, value]) => sum + byteLength(name) + byteLength(value), 0)
  );
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function privateEnrollmentUrl(config: AuthConsentConfig): string {
  let source: URL;
  try {
    source = new URL(config.url);
  } catch {
    throw new Error('Invalid Auth consent configuration');
  }
  const loopback = ['127.0.0.1', '[::1]'].includes(source.hostname);
  if (
    (source.protocol !== 'https:' && !(loopback && source.protocol === 'http:')) ||
    source.pathname !== '/internal/v1/consents:read' ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    !/^[\x21-\x7e]{1,1024}$/.test(config.serviceTokenId) ||
    !/^[\x21-\x7e]{1,1024}$/.test(config.serviceTokenSecret) ||
    config.url.length > 2048
  )
    throw new Error('Invalid Auth consent configuration');
  const target = new URL('/internal/v1/kind-consents:enroll', source.origin).href;
  if (target.length > 2048) throw new Error('Invalid Auth consent configuration');
  return target;
}

async function responseBody(response: Response, signal: AbortSignal): Promise<{ value: unknown; bytes: number }> {
  const contentLength = response.headers.get('content-length');
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' ||
    (contentLength !== null &&
      (!/^\d+$/.test(contentLength) || Number(contentLength) > KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES))
  )
    throw new Error('Invalid private consent response');
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > KIND_CONSENT_ENROLLMENT_RESPONSE_MAX_BYTES) throw new Error('Private consent response too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), bytes: size };
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

function freezeResult(result: KindConsentEnrollmentResult): KindConsentEnrollmentResult {
  if (result.status === 'unavailable') return Object.freeze({ status: 'unavailable' });
  return Object.freeze({
    status: 'enrolled',
    reference: Object.freeze({ kind: 'auth-kind-consent', id: result.reference.id }),
    effectiveScopes: Object.freeze([...result.effectiveScopes]),
  });
}

/** Build one deadline-bound Auth participant over the dedicated private service
 * token. No Auth package runtime, database or signing material enters Kernel.
 */
export function createKindConsentParticipantTransport(
  config: AuthConsentConfig,
  deadline: number,
  options: TransportOptions = {},
): KindConsentParticipant {
  const target = privateEnrollmentUrl(config);
  const transport = options.fetch ?? globalThis.fetch;
  const invocations = new WeakMap<object, Invocation>();

  const enroll = async (input: KindConsentEnrollmentInput): Promise<KindConsentEnrollmentResult> => {
    const bound = kindConsentTransportBound(input);
    if (!bound || !Number.isSafeInteger(deadline) || Date.now() >= deadline) return unavailable();
    let request: string;
    let requestBytes: number;
    const headers = new Headers({
      'content-type': 'application/json',
      'CF-Access-Client-Id': config.serviceTokenId,
      'CF-Access-Client-Secret': config.serviceTokenSecret,
      'X-Rezics-Kind-Deadline': String(deadline),
    });
    const kernelControlBytes = requestControlBytes(target, headers);
    if (kernelControlBytes > KIND_CONSENT_ENROLLMENT_KERNEL_CONTROL_MAX_BYTES) return unavailable();
    try {
      request = JSON.stringify({ input, deadline });
      requestBytes = new TextEncoder().encode(request).byteLength;
    } catch {
      return unavailable();
    }
    if (requestBytes > KIND_CONSENT_ENROLLMENT_REQUEST_MAX_BYTES) return unavailable();

    const controller = new AbortController();
    const remaining = Math.min(KIND_CONSENT_ENROLLMENT_MAX_DURATION_MS, deadline - Date.now());
    if (remaining <= 0) return unavailable();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Private consent deadline expired'));
      }, remaining);
    });
    try {
      const pending = transport(target, {
        method: 'POST',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
        headers,
        body: request,
      });
      response = await Promise.race([pending, expired]);
      if (
        controller.signal.aborted ||
        Date.now() >= deadline ||
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== target)
      )
        return unavailable();
      const envelope = await responseBody(response, controller.signal);
      if (controller.signal.aborted || Date.now() >= deadline || !exactRecord(envelope.value, ['result', 'work']))
        return unavailable();
      const resultValue = envelope.value.result;
      const nativeWork = envelope.value.work;
      const verifiedBound = kindConsentEnrollmentVerifiedBound(input);
      if (
        !verifiedBound ||
        !kindConsentEnrollmentResultValid(input, resultValue) ||
        !kindConsentWorkWithin(nativeWork, verifiedBound)
      )
        return unavailable();
      const measured = kindConsentTransportActual(input, nativeWork, requestBytes, envelope.bytes, kernelControlBytes);
      if (!measured || !kindConsentWorkWithin(measured, bound)) return unavailable();
      const result = freezeResult(resultValue);
      invocations.set(result, {
        input,
        work: nativeWork,
        requestBytes,
        responseBytes: envelope.bytes,
        kernelControlBytes,
        deadline,
      });
      return result;
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
    }
  };

  return {
    enroll: Object.assign(enroll, {
      bound: kindConsentTransportBound,
      actual(input: KindConsentEnrollmentInput, result: KindConsentEnrollmentResult) {
        if (!result || typeof result !== 'object') return undefined;
        const invocation = invocations.get(result);
        if (!invocation) return undefined;
        invocations.delete(result);
        const verifiedBound = kindConsentEnrollmentVerifiedBound(input);
        if (
          invocation.input !== input ||
          invocation.deadline !== deadline ||
          Date.now() >= deadline ||
          !kindConsentEnrollmentResultValid(input, result) ||
          !verifiedBound ||
          !kindConsentWorkWithin(invocation.work, verifiedBound)
        )
          return undefined;
        return kindConsentTransportActual(
          input,
          invocation.work,
          invocation.requestBytes,
          invocation.responseBytes,
          invocation.kernelControlBytes,
        );
      },
    }),
  };
}
