import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  isExportPage,
  isExportStatus,
  quotedIdempotencyKey,
  type ExportCommand,
  type ExportFailure,
  type ExportFailureKind,
  type ExportPort,
  type ExportUnknown,
} from './contract';

type NativeResult = { data: unknown; error: unknown; status: number };
type NativeHeaders = Record<string, string> & { authorization: string };
type NativeWriteHeaders = NativeHeaders & { 'idempotency-key': string };
export type LibraryExportSurface = KernelClient['libraryExports'];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSurface(surface: LibraryExportSurface): LibraryExportSurface | undefined {
  if (typeof surface !== 'function') return undefined;
  if (typeof surface.post !== 'function') return undefined;
  try {
    const resource = surface({ id: '00000000-0000-4000-8000-000000000000' });
    if (typeof resource.get !== 'function' || typeof resource.delete !== 'function') return undefined;
    if (!resource.pages || typeof resource.pages.get !== 'function') return undefined;
  } catch {
    return undefined;
  }
  return surface;
}

/** Use only the mounted generated `libraryExports` surface; absent methods stay unavailable. */
export function nativeLibraryExport(client: KernelClient): LibraryExportSurface | undefined {
  return asSurface(client.libraryExports);
}

function publicDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  if (/[<>]|authorization|bearer|password/i.test(detail)) return undefined;
  return detail;
}

function failureKind(status: number, body: unknown): ExportFailureKind {
  const detail = record(body) && typeof body.detail === 'string' ? body.detail : '';
  const code = record(body) && typeof body.code === 'string' ? body.code : '';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 422) return 'idempotency';
  if (status === 400 || code === 'invalid_cursor' || /invalid_cursor/i.test(detail)) return 'invalid-cursor';
  return 'unavailable';
}

function failure(status: number, body: unknown): ExportFailure {
  const kind = failureKind(status, body);
  const detail = publicDetail(record(body) ? body.detail : undefined);
  return detail ? { kind, detail } : { kind };
}

function unknown(command: ExportCommand): ExportUnknown {
  return { kind: 'unknown', command };
}

function outcomeOf(status: number, body: unknown, command: ExportCommand): ExportFailure | ExportUnknown {
  if (status === 0 || status >= 500) return unknown(command);
  return failure(status, body);
}

function errorBody(value: unknown): unknown {
  return record(value) && Object.hasOwn(value, 'value') ? value.value : value;
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<{ authorization: string } | ExportFailure> {
  if (!originConfigured) return { kind: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    return { authorization };
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    return { kind: 'unavailable' };
  }
}

export function kernelExportPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): ExportPort {
  function headers(authorization: string): NativeHeaders;
  function headers(authorization: string, key: string): NativeWriteHeaders;
  function headers(authorization: string, key?: string): NativeHeaders | NativeWriteHeaders {
    return key ? { authorization, 'idempotency-key': quotedIdempotencyKey(key) } : { authorization };
  }
  async function call<T>(
    command: ExportCommand,
    send: (surface: LibraryExportSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | ExportFailure | ExportUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const surface = nativeLibraryExport(client);
    if (!surface) return { kind: 'unavailable' };
    try {
      const result = await send(surface, session.authorization);
      if (result.error) return outcomeOf(result.status, errorBody(result.error), command);
      const value = read(result.data);
      if (!value) return { kind: 'unavailable' };
      return value;
    } catch (error) {
      if (isPlatformClosedError(error)) return { kind: 'unavailable' };
      return unknown(command);
    }
  }
  return {
    async create(command) {
      return call(
        command,
        (surface, authorization) => surface.post(undefined, { headers: headers(authorization, command.key) }),
        (data) => (isExportStatus(data) ? ({ kind: 'status' as const, status: data } as const) : undefined),
      );
    },
    async status(command) {
      return call(
        command,
        (surface, authorization) => surface({ id: command.exportId }).get({ headers: headers(authorization) }),
        (data) => (isExportStatus(data) ? ({ kind: 'status' as const, status: data } as const) : undefined),
      );
    },
    async page(command) {
      return call(
        command,
        (surface, authorization) => {
          const pages = surface({ id: command.exportId }).pages;
          if (!pages) return Promise.resolve({ data: null, status: 503, error: { value: { code: 'unavailable' } } });
          return pages.get({ query: { cursor: command.cursor }, headers: headers(authorization) });
        },
        (data) => (isExportPage(data) ? ({ kind: 'page' as const, page: data } as const) : undefined),
      );
    },
    async cancel(command) {
      return call(
        command,
        (surface, authorization) => surface({ id: command.exportId }).delete({ headers: headers(authorization) }),
        (data) => (isExportStatus(data) ? ({ kind: 'cancelled' as const, status: data } as const) : undefined),
      );
    },
  };
}
