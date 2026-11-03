import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import { mapSourceAdmissionPort } from '../rich-private-entry/admission';
import { admitPrivateSourceObservation } from '../rich-private-entry/native';
import {
  MAL_FIELD_CAP,
  MAL_PAGE,
  SUBJECT_ID,
  type MalApplyBody,
  type MalApplyPage,
  type MalApplyResult,
  type MalCommand,
  type MalFailure,
  type MalFailureKind,
  type MalImportPort,
  type MalMutateResult,
  type MalPage,
  type MalPageResult,
  type MalPreviewResult,
  type MalPreviewRow,
  type MalReviewInput,
  type MalReviewResult,
  type MalUnknown,
} from './contract';

type NativeResult = {
  data?: unknown;
  error?: { value?: unknown };
  status: number;
};

type PreviewResource = {
  post: (body: { xml: string }, options: { headers: Record<string, string> }) => Promise<NativeResult>;
};
type IdResource = {
  get: (options: { query?: { after?: number }; headers: Record<string, string> }) => Promise<NativeResult>;
  source: { get: (options: { headers: Record<string, string> }) => Promise<NativeResult> };
  review: { post: (body: MalReviewInput, options: { headers: Record<string, string> }) => Promise<NativeResult> };
  apply: { post: (body: MalApplyBody, options: { headers: Record<string, string> }) => Promise<NativeResult> };
  cancel: {
    post: (body: Record<string, never>, options: { headers: Record<string, string> }) => Promise<NativeResult>;
  };
  delete: (body: undefined, options: { headers: Record<string, string> }) => Promise<NativeResult>;
};
type MalSurface = ((params: { id: string }) => IdResource) & {
  $preview?: PreviewResource;
  preview?: PreviewResource;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bind the mounted MAL methods when present. Do not invent a path or a successful body. */
export function nativeMalImport(client: KernelClient): MalSurface | undefined {
  const mal = (client.libraryImports as typeof client.libraryImports & { mal?: MalSurface }).mal;
  if (typeof mal !== 'function') return undefined;
  const preview = mal.$preview ?? mal.preview;
  if (!preview || typeof preview.post !== 'function') return undefined;
  return mal;
}

function publicDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  if (/[<>]|myanimelist|<!DOCTYPE|<!ENTITY/i.test(detail)) return undefined;
  return detail;
}

function failureKind(status: number, body: unknown): MalFailureKind {
  const detail = record(body) && typeof body.detail === 'string' ? body.detail : '';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 413 || /2 MiB|4 MiB|too large|content_too_large/i.test(detail)) return 'too-large';
  if (/DTD|entity/i.test(detail)) return 'security';
  if (status === 422) return 'idempotency';
  if (status === 409) return 'conflict';
  if (status === 400 || /malformed|root|row |identifier|expected/i.test(detail)) return 'malformed';
  return 'unavailable';
}

function failure(status: number, body: unknown): MalFailure {
  const kind = failureKind(status, body);
  const detail = publicDetail(record(body) ? body.detail : undefined);
  return detail ? { kind, detail } : { kind };
}

function unknown(command: MalCommand): MalUnknown {
  return { kind: 'unknown', command };
}

function outcomeOf(status: number, body: unknown, command: MalCommand): MalFailure | MalUnknown {
  if (status === 0 || status >= 500) return unknown(command);
  return failure(status, body);
}

function isValue(value: unknown): value is MalPreviewRow['status'] {
  if (!record(value) || typeof value.kind !== 'string') return false;
  return ['missing', 'unknown', 'invalid', 'zero', 'value'].includes(value.kind);
}

function isRow(value: unknown): value is MalPreviewRow {
  if (!record(value) || typeof value.index !== 'number' || (value.kind !== 'anime' && value.kind !== 'manga'))
    return false;
  if (typeof value.title !== 'string' || !record(value.identifier)) return false;
  const match = value.match;
  if (
    match !== 'matched' &&
    match !== 'already-matched' &&
    match !== 'unmatched' &&
    match !== 'unavailable' &&
    match !== 'ambiguous'
  )
    return false;
  return isValue(value.status) && isValue(value.score) && Array.isArray(value.retained);
}

function isPage(value: unknown): value is MalPage {
  if (!record(value) || typeof value.id !== 'string' || !SUBJECT_ID.test(value.id)) return false;
  if (typeof value.canceled !== 'boolean' || typeof value.total !== 'number' || !Array.isArray(value.rows))
    return false;
  if (typeof value.sourcePath !== 'string') return false;
  if (value.next !== null && typeof value.next !== 'number') return false;
  if (!record(value.limits) || typeof value.limits.page !== 'number') return false;
  return value.rows.every(isRow);
}

function isApply(value: unknown): value is MalApplyPage {
  if (
    !record(value) ||
    typeof value.id !== 'string' ||
    !Array.isArray(value.outcomes) ||
    !Array.isArray(value.remaining)
  )
    return false;
  return typeof value.stopped === 'boolean';
}

function idOf(value: unknown): string | undefined {
  return record(value) && typeof value.id === 'string' && SUBJECT_ID.test(value.id) ? value.id : undefined;
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<{ authorization: string } | MalFailure> {
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

export function kernelMalPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): MalImportPort {
  const headers = (authorization: string, key?: string) => ({
    authorization,
    ...(key ? { 'idempotency-key': key } : {}),
  });
  async function call<T>(
    command: MalCommand,
    send: (mal: MalSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | MalFailure | MalUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const mal = nativeMalImport(client);
    if (!mal) return { kind: 'unavailable' };
    try {
      const result = await send(mal, session.authorization);
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
    async preview(command) {
      const result = await call(
        command,
        (mal, authorization) => {
          const preview = mal.$preview ?? mal.preview;
          if (!preview) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return preview.post({ xml: command.xml }, { headers: headers(authorization, command.key) });
        },
        (data) => {
          const id = idOf(data);
          return id ? ({ kind: 'previewed', id } as const) : undefined;
        },
      );
      return result;
    },
    async page(command) {
      const result = await call(
        command,
        (mal, authorization) =>
          mal({ id: command.id }).get({
            query: { after: command.after },
            headers: headers(authorization),
          }),
        (data) => (isPage(data) ? ({ kind: 'page', page: data } as const) : undefined),
      );
      return result;
    },
    async review(command) {
      const result = await call(
        command,
        (mal, authorization) =>
          mal({ id: command.id }).review.post(command.input, { headers: headers(authorization, command.key) }),
        (data) => {
          const id = idOf(data);
          return id ? ({ kind: 'reviewed', id } as const) : undefined;
        },
      );
      return result;
    },
    async apply(command) {
      if (command.body.rows.length === 0 || command.body.rows.length > MAL_PAGE) return { kind: 'malformed' };
      if (command.body.rows.some((row) => row.fields.length > MAL_FIELD_CAP)) return { kind: 'malformed' };
      const result = await call(
        command,
        (mal, authorization) => mal({ id: command.id }).apply.post(command.body, { headers: headers(authorization) }),
        (data) => (isApply(data) ? ({ kind: 'applied', result: data } as const) : undefined),
      );
      return result;
    },
    async cancel(command) {
      const result = await call(
        command,
        (mal, authorization) =>
          mal({ id: command.id }).cancel.post({}, { headers: headers(authorization, command.key) }),
        (data) => {
          const id = idOf(data);
          return id ? ({ kind: 'done', id } as const) : undefined;
        },
      );
      return result;
    },
    async delete(command) {
      const result = await call(
        command,
        (mal, authorization) =>
          mal({ id: command.id }).delete(undefined, { headers: headers(authorization, command.key) }),
        (data) => {
          const id = idOf(data);
          return id ? ({ kind: 'done', id } as const) : undefined;
        },
      );
      return result;
    },
    async admitSource(command) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      try {
        const result = await admitPrivateSourceObservation(client, {
          subjectId: command.subjectId,
          body: command.body,
          key: command.key,
          authorization: session.authorization,
        });
        return mapSourceAdmissionPort(result, command);
      } catch (error) {
        if (isPlatformClosedError(error)) return { kind: 'unavailable' };
        return { kind: 'unknown', command };
      }
    },
  };
}

export type { MalApplyResult, MalMutateResult, MalPageResult, MalPreviewResult, MalReviewResult };
