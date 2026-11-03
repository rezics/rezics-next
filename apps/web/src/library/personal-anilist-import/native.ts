import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  ANILIST_APPLY,
  ANILIST_PAGE,
  SUBJECT_ID,
  boundedHeader,
  completenessOf,
  isScoreFormat,
  quotedIdempotencyKey,
  type AniListApplyBody,
  type AniListApplyCallResult,
  type AniListApplyResult,
  type AniListCommand,
  type AniListConfirmation,
  type AniListCurrent,
  type AniListFailure,
  type AniListFailureKind,
  type AniListHeader,
  type AniListIdentifier,
  type AniListImportPort,
  type AniListJson,
  type AniListMatch,
  type AniListMutateResult,
  type AniListObservation,
  type AniListOutcome,
  type AniListPage,
  type AniListPageResult,
  type AniListPreviewResult,
  type AniListRecord,
  type AniListReview,
  type AniListReviewInput,
  type AniListReviewResult,
  type AniListRow,
  type AniListSource,
  type AniListSourceField,
  type AniListUnknown,
} from './contract';

type NativeResult = { data?: unknown; error?: { value?: unknown }; status: number };
type NativeHeaders = { authorization: string; 'idempotency-key'?: string };
type PreviewResource = {
  post: (body: { upload: string; scoreFormat?: string }, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type ReviewResource = {
  post: (
    body: { ordinal: number; subjectId?: string; skip?: boolean; fields: string[]; replace?: boolean },
    options: { headers: NativeHeaders },
  ) => Promise<NativeResult>;
};
type ApplyResource = {
  post: (body: AniListApplyBody, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type CancelResource = {
  post: (body: { remove?: boolean }, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type IdResource = {
  get: (options: { query?: { after?: number }; headers: NativeHeaders }) => Promise<NativeResult>;
  $review?: ReviewResource;
  review?: ReviewResource;
  $apply?: ApplyResource;
  apply?: ApplyResource;
  $cancel?: CancelResource;
  cancel?: CancelResource;
};
export type AniListSurface = ((params: { importId: string }) => IdResource) & {
  $preview?: PreviewResource;
  preview?: PreviewResource;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSurface(value: unknown): AniListSurface | undefined {
  if (typeof value !== 'function') return undefined;
  const surface = value as AniListSurface;
  const preview = surface.$preview ?? surface.preview;
  if (!preview || typeof preview.post !== 'function') return undefined;
  return surface;
}

/** Bind installed `libraryImports.anilist` methods. Missing methods stay unavailable. */
export function nativeAniListImport(client: KernelClient): AniListSurface | undefined {
  const imports = client.libraryImports;
  if (!imports || typeof imports !== 'object' || !('anilist' in imports)) return undefined;
  return asSurface(Reflect.get(imports, 'anilist'));
}

function publicDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  if (/[<>]|anilist\.co|MediaList|statusLists|customLists/i.test(detail)) return undefined;
  return detail;
}

function failureKind(status: number, body: unknown): AniListFailureKind {
  const detail = record(body) && typeof body.detail === 'string' ? body.detail : '';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 413 || /1,?048,576|1 MiB|too large|content_too_large/i.test(detail)) return 'too-large';
  if (status === 422) return 'idempotency';
  if (status === 409) return 'conflict';
  if (status === 400 || /malformed|invalid_request|statusLists|customLists/i.test(detail)) return 'malformed';
  return 'unavailable';
}

function failure(status: number, body: unknown): AniListFailure {
  const kind = failureKind(status, body);
  const detail = publicDetail(record(body) ? body.detail : undefined);
  return detail ? { kind, detail } : { kind };
}

function unknown(command: AniListCommand): AniListUnknown {
  return { kind: 'unknown', command };
}

function outcomeOf(status: number, body: unknown, command: AniListCommand): AniListFailure | AniListUnknown {
  if (status === 0 || status >= 500) return unknown(command);
  return failure(status, body);
}

function isJson(value: unknown): value is AniListJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (!record(value)) return false;
  return Object.values(value).every(isJson);
}

function isRecord(value: unknown): value is AniListRecord {
  return record(value) && isJson(value) && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is AniListIdentifier {
  if (!record(value) || typeof value.externalId !== 'string') return false;
  return value.source === 'anilist' || value.source === 'myanimelist';
}

function isField(value: unknown): value is AniListSourceField {
  if (!record(value) || typeof value.field !== 'string' || typeof value.reason !== 'string') return false;
  return value.validity === 'valid' || value.validity === 'unknown' || value.validity === 'invalid';
}

function isSource(value: unknown): value is AniListSource {
  if (!record(value) || !isRecord(value.evidence) || !Array.isArray(value.identifiers) || !Array.isArray(value.fields))
    return false;
  if (value.group !== null && !isRecord(value.group)) return false;
  return value.identifiers.every(isIdentifier) && value.fields.every(isField);
}

function isMatch(value: unknown): value is AniListMatch {
  if (!record(value) || typeof value.fingerprint !== 'string' || !Array.isArray(value.candidates)) return false;
  if (
    value.state !== 'matched' &&
    value.state !== 'ambiguous' &&
    value.state !== 'unmatched' &&
    value.state !== 'unavailable'
  )
    return false;
  return value.candidates.every((id) => typeof id === 'string' && SUBJECT_ID.test(id));
}

function isCurrent(value: unknown): value is AniListCurrent {
  if (!record(value) || typeof value.state !== 'string' || typeof value.revision !== 'number') return false;
  return value.incarnationId === null || typeof value.incarnationId === 'string';
}

function isObservation(value: unknown): value is AniListObservation {
  if (!record(value) || typeof value.subjectId !== 'string' || !SUBJECT_ID.test(value.subjectId)) return false;
  if (typeof value.epoch !== 'string' || !Array.isArray(value.states)) return false;
  if (value.pin !== null && !isJson(value.pin)) return false;
  if (value.proposedState !== null && typeof value.proposedState !== 'string') return false;
  if (value.current !== null && !isCurrent(value.current)) return false;
  return value.states.every(
    (state) =>
      record(state) && typeof state.id === 'string' && (state.role === undefined || typeof state.role === 'string'),
  );
}

function isReviewInput(value: unknown): value is AniListReviewInput {
  if (!record(value) || !Array.isArray(value.fields) || !value.fields.every((field) => typeof field === 'string'))
    return false;
  if (value.subjectId !== undefined && (typeof value.subjectId !== 'string' || !SUBJECT_ID.test(value.subjectId)))
    return false;
  if (value.skip !== undefined && typeof value.skip !== 'boolean') return false;
  if (value.replace !== undefined && typeof value.replace !== 'boolean') return false;
  return true;
}

function isReview(value: unknown): value is AniListReview {
  if (!record(value) || typeof value.id !== 'string' || !SUBJECT_ID.test(value.id)) return false;
  if (typeof value.commandKey !== 'string' || typeof value.clientId !== 'string') return false;
  if (value.requestedBy !== null && typeof value.requestedBy !== 'string') return false;
  if (!isMatch(value.match) || !isReviewInput(value.input)) return false;
  return value.observation === null || isObservation(value.observation);
}

function isOutcome(value: unknown): value is AniListOutcome {
  if (!record(value) || typeof value.ordinal !== 'number' || !Array.isArray(value.retained)) return false;
  if (!value.retained.every((field) => typeof field === 'string')) return false;
  return (
    value.status === 'applied' ||
    value.status === 'skipped' ||
    value.status === 'stale' ||
    value.status === 'unsupported' ||
    value.status === 'failed'
  );
}

function isHeader(value: unknown): value is AniListHeader {
  if (!record(value) || typeof value.count !== 'number' || typeof value.cancelled !== 'boolean') return false;
  if (typeof value.rawUpload !== 'string') return false;
  if (value.document !== null && value.document !== undefined && !isJson(value.document)) return false;
  if (value.scoreFormat !== null && !isScoreFormat(value.scoreFormat)) return false;
  return true;
}

function isRow(value: unknown): value is AniListRow {
  if (!record(value) || typeof value.ordinal !== 'number' || !isSource(value.source) || !isMatch(value.match))
    return false;
  if (value.proposal !== null && value.proposal !== undefined && !isObservation(value.proposal)) return false;
  if (value.review !== null && value.review !== undefined && !isReview(value.review)) return false;
  if (value.outcome !== null && value.outcome !== undefined && !isOutcome(value.outcome)) return false;
  return true;
}

function normalizeRow(value: AniListRow): AniListRow {
  return {
    ordinal: value.ordinal,
    source: value.source,
    match: value.match,
    proposal: value.proposal ?? null,
    review: value.review ?? null,
    started: value.started === true,
    outcome: value.outcome ?? null,
  };
}

function isPage(importId: string, value: unknown): AniListPage | undefined {
  if (!record(value) || !isHeader(value.header) || !Array.isArray(value.rows) || value.rows.length > ANILIST_PAGE)
    return undefined;
  if (value.next !== null && typeof value.next !== 'number') return undefined;
  if (!value.rows.every(isRow)) return undefined;
  const rows = value.rows.map((row) => normalizeRow(row as AniListRow));
  return {
    importId,
    header: boundedHeader(value.header),
    completeness: completenessOf(value.header.document, rows),
    rows,
    next: value.next,
  };
}

function isApply(value: unknown): value is AniListApplyResult {
  if (!record(value) || !Array.isArray(value.outcomes) || typeof value.complete !== 'boolean') return false;
  return value.outcomes.every(isOutcome);
}

function isConfirmation(value: unknown): value is AniListConfirmation {
  return (
    record(value) &&
    typeof value.ordinal === 'number' &&
    typeof value.reviewId === 'string' &&
    SUBJECT_ID.test(value.reviewId)
  );
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<{ authorization: string } | AniListFailure> {
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

export function kernelAniListPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): AniListImportPort {
  const headers = (authorization: string, key?: string): NativeHeaders => ({
    authorization,
    ...(key ? { 'idempotency-key': quotedIdempotencyKey(key) } : {}),
  });
  async function call<T>(
    command: AniListCommand,
    send: (anilist: AniListSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | AniListFailure | AniListUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const anilist = nativeAniListImport(client);
    if (!anilist) return { kind: 'unavailable' };
    try {
      const result = await send(anilist, session.authorization);
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
      return call(
        command,
        (anilist, authorization) => {
          const preview = anilist.$preview ?? anilist.preview;
          if (!preview) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return preview.post(
            command.scoreFormat
              ? { upload: command.upload, scoreFormat: command.scoreFormat }
              : { upload: command.upload },
            { headers: headers(authorization, command.key) },
          );
        },
        (data) => {
          if (!record(data) || typeof data.id !== 'string' || !SUBJECT_ID.test(data.id)) return undefined;
          if (typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 1) return undefined;
          return { kind: 'previewed' as const, importId: data.id, count: data.count };
        },
      );
    },
    async page(command) {
      return call(
        command,
        (anilist, authorization) =>
          anilist({ importId: command.importId }).get({
            query: { after: command.after },
            headers: headers(authorization),
          }),
        (data) => {
          const page = isPage(command.importId, data);
          return page ? ({ kind: 'page', page } as const) : undefined;
        },
      );
    },
    async review(command) {
      return call(
        command,
        (anilist, authorization) => {
          const resource = anilist({ importId: command.importId });
          const review = resource.$review ?? resource.review;
          if (!review) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return review.post(
            {
              ordinal: command.ordinal,
              fields: command.fields,
              replace: command.replace,
              ...(command.subjectId ? { subjectId: command.subjectId } : {}),
              ...(command.skip ? { skip: true } : {}),
            },
            { headers: headers(authorization, command.key) },
          );
        },
        (data) => {
          if (!record(data) || typeof data.ordinal !== 'number' || !isReview(data.review)) return undefined;
          return { kind: 'reviewed' as const, ordinal: data.ordinal, review: data.review };
        },
      );
    },
    async apply(command) {
      if (command.body.confirmations.length === 0 || command.body.confirmations.length > ANILIST_APPLY)
        return { kind: 'malformed' };
      if (!command.body.confirmations.every(isConfirmation)) return { kind: 'malformed' };
      return call(
        command,
        (anilist, authorization) => {
          const resource = anilist({ importId: command.importId });
          const apply = resource.$apply ?? resource.apply;
          if (!apply) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return apply.post(command.body, { headers: headers(authorization) });
        },
        (data) => (isApply(data) ? ({ kind: 'applied', result: data } as const) : undefined),
      );
    },
    async cancel(command) {
      return call(
        command,
        (anilist, authorization) => {
          const resource = anilist({ importId: command.importId });
          const cancel = resource.$cancel ?? resource.cancel;
          if (!cancel) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return cancel.post({ remove: command.remove }, { headers: headers(authorization, command.key) });
        },
        (data) => {
          if (!record(data) || data.cancelled !== true) return undefined;
          return { kind: 'cancelled' as const, removed: command.remove };
        },
      );
    },
  };
}

export type {
  AniListApplyCallResult,
  AniListMutateResult,
  AniListPageResult,
  AniListPreviewResult,
  AniListReviewResult,
};
