import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { MediaProblem } from '../media/kernel';
import { acceptLanguage, kernelClient, requestLocale } from '../kernel/client';
import { recordPageReadCacheControl } from '../security/page-cache';
import type { SessionEnv } from '../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../session/request';
import {
  cancelNativeOperation,
  operationAddress,
  readNativeOperation,
  readBulkOperationFromNative,
  readBulkOperationPageFromNative,
  sendCapturedBulkCancelCommand,
  type BulkRead,
  type CancelCommand,
  type CancelResult,
  type CapturedCancelCommand,
  type OperationAddress,
} from './bulk-operation-recovery-native';
import {
  type LibraryBulkCancelIntent,
  type LibraryBulkOperation,
  type LibraryBulkOutcomePageRead,
  type LibraryBulkRecoveryRead,
} from './bulk-operation-recovery';

const operationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const recoveryDomain = 'rezics.library-bulk-cancel.v1';

function validateOperationId(input: unknown): { operationId: string } {
  if (!input || typeof input !== 'object' || !('operationId' in input))
    throw new TypeError('Invalid operation address');
  const operationId = input.operationId;
  if (typeof operationId !== 'string' || !operationIdPattern.test(operationId))
    throw new TypeError('Invalid operation address');
  return { operationId };
}

function validatePageInput(input: unknown): { operationId: string; cursor: string } {
  const { operationId } = validateOperationId(input);
  const cursor = (input as { cursor?: unknown }).cursor;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 4096)
    throw new TypeError('Invalid operation cursor');
  return { operationId, cursor };
}

function validateCancelInput(input: unknown): { operationId: string; capture: string } {
  const { operationId } = validateOperationId(input);
  const capture = (input as { capture?: unknown }).capture;
  if (typeof capture !== 'string' || capture.length === 0 || capture.length > 4096)
    throw new TypeError('Invalid cancellation capture');
  return { operationId, capture };
}

function cryptoBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function cryptoContext(sessionEnv: Partial<SessionEnv>): ArrayBuffer {
  return cryptoBuffer(
    new TextEncoder().encode(
      JSON.stringify([recoveryDomain, sessionEnv.AUTH_ISSUER, sessionEnv.API_RESOURCE, sessionEnv.WEBSITE_CLIENT_ID]),
    ),
  );
}

function captureBinding(request: Request, sender: string): string {
  return JSON.stringify([new URL(request.url).origin, sender]);
}

async function recoveryKey(sessionEnv: Partial<SessionEnv>): Promise<CryptoKey> {
  if (!sessionEnv.WEBSITE_CLIENT_KEY) throw new Error('Missing web credential key');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${recoveryDomain}\n${sessionEnv.WEBSITE_CLIENT_KEY}`),
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function encodeCapture(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeCapture(value: string): Uint8Array {
  return Uint8Array.from(
    atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)),
    (character) => character.charCodeAt(0),
  );
}

async function sealCancelCommand(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  command: CapturedCancelCommand,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const envelope = new TextEncoder().encode(
    JSON.stringify({ binding: captureBinding(request, command.sender), command }),
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: cryptoBuffer(iv), additionalData: cryptoContext(sessionEnv) },
      await recoveryKey(sessionEnv),
      envelope,
    ),
  );
  const token = encodeCapture(new Uint8Array([...iv, ...encrypted]));
  if (token.length > 4096) throw new Error('Bulk cancellation capture exceeds bound');
  return token;
}

async function openCancelCommand(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  sender: string,
  token: string,
): Promise<CapturedCancelCommand | null> {
  try {
    const bytes = decodeCapture(token);
    if (bytes.length < 29 || bytes.length > 4096) return null;
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: cryptoBuffer(bytes.slice(0, 12)), additionalData: cryptoContext(sessionEnv) },
      await recoveryKey(sessionEnv),
      bytes.slice(12),
    );
    const envelope = JSON.parse(new TextDecoder().decode(decrypted)) as {
      binding?: unknown;
      command?: CapturedCancelCommand;
    };
    if (envelope.binding !== captureBinding(request, sender)) return null;
    const command = envelope.command;
    if (
      !command ||
      command.version !== 1 ||
      command.operationId === '' ||
      command.sender !== sender ||
      command.method !== 'POST' ||
      command.path !== `/v1/libraryOperations/${command.operationId}:cancel` ||
      !operationIdPattern.test(command.operationId) ||
      typeof command.locale !== 'string' ||
      !command.headers?.authorization ||
      !command.headers['idempotency-key'] ||
      !command.headers['accept-language'] ||
      command.headers['content-type'] !== 'application/json' ||
      !command.body ||
      Object.keys(command.body).length !== 0
    )
      return null;
    return command;
  } catch {
    return null;
  }
}

function recoveryUnavailable(operationId: string): LibraryBulkRecoveryRead {
  return { state: 'unavailable', operationId };
}

export const readBulkOperationRecovery = createServerFn({ method: 'GET' })
  .validator(validateOperationId)
  .handler(async ({ data }): Promise<LibraryBulkRecoveryRead> => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(request, 'private, no-store');
    try {
      if (await prepareSession(request, env as Partial<SessionEnv>))
        return { state: 'forbidden', operationId: data.operationId };
      const authorization = viewerCredential(request);
      if (!authorization) return { state: 'forbidden', operationId: data.operationId };
      return await readBulkOperationFromNative(kernelClient(), data.operationId, authorization);
    } catch {
      return recoveryUnavailable(data.operationId);
    }
  });

export const readBulkOperationRecoveryPage = createServerFn({ method: 'GET' })
  .validator(validatePageInput)
  .handler(async ({ data }): Promise<LibraryBulkOutcomePageRead> => {
    const request = getRequest();
    setResponseHeader('cache-control', 'private, no-store');
    recordPageReadCacheControl(request, 'private, no-store');
    try {
      if (await prepareSession(request, env as Partial<SessionEnv>))
        return { state: 'forbidden', operationId: data.operationId };
      const authorization = viewerCredential(request);
      if (!authorization) return { state: 'forbidden', operationId: data.operationId };
      return await readBulkOperationPageFromNative(kernelClient(), data.operationId, data.cursor, authorization);
    } catch {
      return { state: 'unavailable', operationId: data.operationId };
    }
  });

export const captureBulkOperationCancel = createServerFn({ method: 'GET' })
  .validator(validateOperationId)
  .handler(
    async ({
      data,
    }): Promise<
      | { state: 'ready'; intent: LibraryBulkCancelIntent; csrfToken: string }
      | { state: 'csrf_unavailable' | 'forbidden' | 'unavailable' }
    > => {
      const request = getRequest();
      setResponseHeader('cache-control', 'private, no-store');
      recordPageReadCacheControl(request, 'private, no-store');
      try {
        if (await prepareSession(request, env as Partial<SessionEnv>)) return { state: 'forbidden' };
        const authorization = viewerCredential(request);
        const sender = sessionSubject(request);
        const csrfToken = requestCsrfToken(request);
        const sessionEnv = env as Partial<SessionEnv>;
        if (!authorization || !sender) return { state: 'forbidden' };
        if (!csrfToken) return { state: 'csrf_unavailable' };
        const locale = requestLocale(request) ?? 'en';
        const idempotencyKey = crypto.randomUUID();
        const command: CapturedCancelCommand = {
          version: 1,
          operationId: data.operationId,
          sender,
          method: 'POST',
          path: `/v1/libraryOperations/${data.operationId}:cancel`,
          locale,
          headers: {
            authorization,
            'idempotency-key': idempotencyKey,
            'accept-language': acceptLanguage(locale),
            'content-type': 'application/json',
          },
          body: {},
        };
        const capture = await sealCancelCommand(request, sessionEnv, command);
        return {
          state: 'ready',
          intent: { operationId: data.operationId, sender, idempotencyKey, locale, capture },
          csrfToken,
        };
      } catch {
        return { state: 'unavailable' };
      }
    },
  );

export const cancelBulkOperationRecovery = createServerFn({ method: 'POST' })
  .validator(validateCancelInput)
  .handler(
    async ({
      data,
    }): Promise<
      | { state: 'accepted'; operation: LibraryBulkOperation }
      | { state: 'forbidden' | 'unavailable' | 'uncertain' | 'refused'; operationId: string }
    > => {
      const request = getRequest();
      setResponseHeader('cache-control', 'private, no-store');
      recordPageReadCacheControl(request, 'private, no-store');
      let command: CapturedCancelCommand | null = null;
      try {
        const sessionEnv = env as Partial<SessionEnv>;
        if (await prepareSession(request, sessionEnv)) return { state: 'forbidden', operationId: data.operationId };
        const sender = sessionSubject(request);
        if (!sender || !viewerCredential(request) || !requestCsrfToken(request))
          return { state: 'forbidden', operationId: data.operationId };
        command = await openCancelCommand(request, sessionEnv, sender, data.capture);
        if (!command || command.operationId !== data.operationId)
          return { state: 'forbidden', operationId: data.operationId };
      } catch {
        return { state: 'forbidden', operationId: data.operationId };
      }

      try {
        const result = await sendCapturedBulkCancelCommand(kernelClient(command.locale), command);
        if (result.status === 200 && !result.error && result.data?.operation)
          return { state: 'accepted', operation: result.data.operation };
        if (result.status === 401 || result.status === 403)
          return { state: 'forbidden', operationId: data.operationId };
        if (result.status === 404) return { state: 'unavailable', operationId: data.operationId };
        if (result.status >= 500 || result.status === 0) return { state: 'uncertain', operationId: data.operationId };
        return { state: 'refused', operationId: data.operationId };
      } catch {
        return { state: 'uncertain', operationId: data.operationId };
      }
    },
  );

/** Compatibility transport for the existing private in-memory recovery model. */
async function credential(viewer: string, csrf?: string) {
  const request = new Request(getRequest());
  const stale = await prepareSession(request, env as Partial<SessionEnv>);
  if (stale || request.headers.has('authorization') || sessionSubject(request) !== viewer) return null;
  if (
    csrf !== undefined &&
    (!csrf || requestCsrfToken(request) !== csrf || request.headers.get('x-csrf-token') !== csrf)
  )
    return null;
  return viewerCredential(request);
}

export const readBulkOperation = createServerFn({ method: 'GET' })
  .validator(operationAddress)
  .handler(async ({ data }: { data: OperationAddress }): Promise<BulkRead> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await credential(data.viewer);
      return authorization ? readNativeOperation(kernelClient(), authorization, data) : { state: 'forbidden' };
    } catch (error) {
      return { state: error instanceof MediaProblem && error.problem.status === 403 ? 'forbidden' : 'unavailable' };
    }
  });

export const cancelBulkOperation = createServerFn({ method: 'POST' })
  .validator((input: CancelCommand): CancelCommand => {
    const address = operationAddress(input);
    if (typeof input.key !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.key) || typeof input.csrf !== 'string')
      throw new Error('Invalid cancellation');
    return { id: address.id, viewer: address.viewer, key: input.key, csrf: input.csrf };
  })
  .handler(async ({ data }): Promise<CancelResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const authorization = await credential(data.viewer, data.csrf);
      return authorization ? cancelNativeOperation(kernelClient(), authorization, data) : { state: 'forbidden' };
    } catch (error) {
      return { state: error instanceof MediaProblem && error.problem.status === 403 ? 'forbidden' : 'unavailable' };
    }
  });
