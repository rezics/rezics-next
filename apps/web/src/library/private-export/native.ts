import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  EXPORT_COMPLETENESS,
  EXPORT_CURSOR_CHARS,
  EXPORT_FORMAT,
  EXPORT_PAGE_ROWS,
  EXPORT_PRIVACY,
  EXPORT_VERSION,
  SUBJECT_ID,
  quotedIdempotencyKey,
  type ExportCommand,
  type ExportCoverage,
  type ExportFailure,
  type ExportFailureKind,
  type ExportJson,
  type ExportManifest,
  type ExportOmissions,
  type ExportPage,
  type ExportPort,
  type ExportRecord,
  type ExportState,
  type ExportStatus,
  type ExportUnknown,
} from './contract';

type NativeResult = { data?: unknown; error?: { value?: unknown }; status: number };
type NativeHeaders = { authorization: string; 'idempotency-key'?: string };
type PageResource = {
  get: (options: { query: { cursor: string }; headers: NativeHeaders }) => Promise<NativeResult>;
};
type IdResource = {
  get: (options: { headers: NativeHeaders }) => Promise<NativeResult>;
  delete: (body: undefined, options: { headers: NativeHeaders }) => Promise<NativeResult>;
  pages?: PageResource;
};
export type LibraryExportSurface = ((params: { id: string }) => IdResource) & {
  post: (body: undefined, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSurface(value: unknown): LibraryExportSurface | undefined {
  if (typeof value !== 'function') return undefined;
  const surface = value as LibraryExportSurface;
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

/** Bind installed `libraryExports` methods. Missing methods stay unavailable. */
export function nativeLibraryExport(client: KernelClient): LibraryExportSurface | undefined {
  return asSurface(Reflect.get(client, 'libraryExports'));
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

function isJson(value: unknown): value is ExportJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (!record(value)) return false;
  return Object.values(value).every(isJson);
}

function isRecord(value: unknown): value is ExportRecord {
  return record(value) && isJson(value);
}

const states: readonly ExportState[] = ['collecting', 'ready', 'stale', 'cancelled', 'expired', 'limit'];

function isState(value: unknown): value is ExportState {
  return typeof value === 'string' && (states as readonly string[]).includes(value);
}

function isOmissions(value: unknown): value is ExportOmissions {
  if (!record(value)) return false;
  return Object.values(value).every((item) => typeof item === 'string');
}

function isCoverage(value: unknown): value is ExportCoverage {
  if (!record(value)) return false;
  if (value.format !== EXPORT_FORMAT || value.version !== EXPORT_VERSION) return false;
  if (typeof value.exportId !== 'string' || !SUBJECT_ID.test(value.exportId)) return false;
  if (typeof value.capturedAt !== 'string' || typeof value.expiresAt !== 'string') return false;
  if (value.privacy !== EXPORT_PRIVACY || value.completeness !== EXPORT_COMPLETENESS) return false;
  if (value.fullExport !== false || !Array.isArray(value.sections) || !isOmissions(value.omissions)) return false;
  return value.sections.every((section) => typeof section === 'string');
}

function isStatus(value: unknown): value is ExportStatus {
  if (!isCoverage(value) || !isState(value.state)) return false;
  if (value.first !== null && (typeof value.first !== 'string' || value.first.length > EXPORT_CURSOR_CHARS))
    return false;
  return true;
}

function isManifest(value: unknown): value is ExportManifest {
  if (!isCoverage(value) || typeof value.rows !== 'number' || typeof value.recordBytes !== 'number') return false;
  return Number.isInteger(value.rows) && value.rows >= 0 && Number.isInteger(value.recordBytes) && value.recordBytes >= 0;
}

function isPage(value: unknown): value is ExportPage {
  if (!record(value) || typeof value.exportId !== 'string' || !SUBJECT_ID.test(value.exportId)) return false;
  if (!isState(value.state) || !Array.isArray(value.records) || value.records.length > EXPORT_PAGE_ROWS) return false;
  if (value.next !== null && (typeof value.next !== 'string' || value.next.length > EXPORT_CURSOR_CHARS)) return false;
  if (value.manifest !== null && !isManifest(value.manifest)) return false;
  return value.records.every(isRecord);
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
  const headers = (authorization: string, key?: string): NativeHeaders => ({
    authorization,
    ...(key ? { 'idempotency-key': quotedIdempotencyKey(key) } : {}),
  });
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
      if (result.error) return outcomeOf(result.status, result.error.value, command);
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
        (data) => (isStatus(data) ? ({ kind: 'status' as const, status: data } as const) : undefined),
      );
    },
    async status(command) {
      return call(
        command,
        (surface, authorization) => surface({ id: command.exportId }).get({ headers: headers(authorization) }),
        (data) => (isStatus(data) ? ({ kind: 'status' as const, status: data } as const) : undefined),
      );
    },
    async page(command) {
      return call(
        command,
        (surface, authorization) => {
          const pages = surface({ id: command.exportId }).pages;
          if (!pages) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return pages.get({ query: { cursor: command.cursor }, headers: headers(authorization) });
        },
        (data) => (isPage(data) ? ({ kind: 'page' as const, page: data } as const) : undefined),
      );
    },
    async cancel(command) {
      return call(
        command,
        (surface, authorization) =>
          surface({ id: command.exportId }).delete(undefined, { headers: headers(authorization) }),
        (data) => (isStatus(data) ? ({ kind: 'cancelled' as const, status: data } as const) : undefined),
      );
    },
  };
}
