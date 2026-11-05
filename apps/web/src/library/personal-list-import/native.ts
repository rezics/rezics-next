import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../../session/request';
import {
  quotedVndbKey,
  type VndbCommand,
  type VndbFailure,
  type VndbPage,
  type VndbPort,
  type VndbUnknown,
} from './contract';

type VndbSurface = KernelClient['libraryImports']['vndb'];

/** The installed generated client binds the mounted VNDB route directly. */
export function nativeVndbImport(client: KernelClient): VndbSurface | undefined {
  return client.libraryImports?.vndb;
}

function failureKind(status: number): VndbFailure['kind'] {
  if (status === 400) return 'admission';
  if (status === 413) return 'wire-too-large';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'idempotency';
  return 'rejected';
}

function failure(status: number, body: unknown): VndbFailure {
  const value = body as { value?: { code?: string }; code?: string } | null;
  const code = value?.value?.code ?? value?.code;
  return code ? { kind: failureKind(status), status, code } : { kind: failureKind(status), status };
}

function unknown(command: VndbCommand): VndbUnknown {
  return { kind: 'unknown', command };
}

export async function withVndbSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
  expectedSubject: string,
): Promise<{ authorization: string } | VndbFailure> {
  if (!originConfigured) return { kind: 'unavailable', status: 503 };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    return authorization && sessionSubject(request) === expectedSubject
      ? { authorization }
      : { kind: 'denied', status: 401 };
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable', status: 503 };
    throw error;
  }
}

export function kernelVndbPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
  expectedSubject: string,
): VndbPort {
  function headers(authorization: string): { authorization: string };
  function headers(authorization: string, key: string): { authorization: string; 'idempotency-key': string };
  function headers(authorization: string, key?: string) {
    return { authorization, ...(key ? { 'idempotency-key': quotedVndbKey(key) } : {}) };
  }
  const route = nativeVndbImport(client);

  async function call<T, R>(
    command: VndbCommand,
    send: (authorization: string) => Promise<{ status: number; data: T | null; error: unknown }>,
    resultOf: (value: T) => R,
  ): Promise<R | VndbFailure | VndbUnknown> {
    if (!route) return { kind: 'unavailable', status: 503 };
    const auth = await withVndbSession(request, sessionEnv, originConfigured, expectedSubject);
    if ('kind' in auth) return auth;
    try {
      const result = await send(auth.authorization);
      if (!result || result.status === 0 || result.status >= 500) return unknown(command);
      if (result.status >= 400) return failure(result.status, result.error);
      return result.data === null ? unknown(command) : resultOf(result.data);
    } catch (error) {
      if (error instanceof TypeError || error instanceof DOMException || error instanceof SyntaxError)
        return unknown(command);
      throw error;
    }
  }

  return {
    preview(command) {
      return call(
        command,
        (authorization) => route!.$preview.post({ xml: command.xml }, { headers: headers(authorization, command.key) }),
        (value) => ({ kind: 'previewed', value }),
      );
    },
    page(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).get({
            query: { offset: command.offset },
            headers: headers(authorization),
          }),
        // Retained evidence comes from the importer's stored JSON, typed unknown by the emitter.
        (value) => ({ kind: 'page', value: value as VndbPage }),
      );
    },
    source(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).source.get({
            headers: headers(authorization),
          }),
        (value) => ({ kind: 'source', xml: value.xml }),
      );
    },
    review(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$review.post(command.body, {
            headers: headers(authorization, command.key),
          }),
        (value) => ({ kind: 'reviewed', value }),
      );
    },
    apply(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$apply.post(command.body, { headers: headers(authorization) }),
        (value) => ({ kind: 'applied', value }),
      );
    },
    cancel(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).$cancel.post({}, { headers: headers(authorization, command.key) }),
        () => ({ kind: 'cancelled' }),
      );
    },
    delete(command) {
      return call(
        command,
        (authorization) =>
          route!({ uploadId: command.uploadId }).delete(undefined, { headers: headers(authorization, command.key) }),
        () => ({ kind: 'deleted' }),
      );
    },
  };
}
