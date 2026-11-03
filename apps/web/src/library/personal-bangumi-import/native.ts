import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import type { SessionEnv } from '../../session/client';
import { prepareSession, viewerCredential } from '../../session/request';
import {
  BANGUMI_APPLY,
  BANGUMI_PAGE,
  SUBJECT_ID,
  quotedIdempotencyKey,
  type BangumiApplyBody,
  type BangumiApplyCallResult,
  type BangumiApplyResult,
  type BangumiChoice,
  type BangumiCommand,
  type BangumiCurrent,
  type BangumiEvidence,
  type BangumiFailure,
  type BangumiFailureKind,
  type BangumiGuard,
  type BangumiImportPort,
  type BangumiMatch,
  type BangumiMutateResult,
  type BangumiOutcome,
  type BangumiPage,
  type BangumiPageResult,
  type BangumiPreviewResult,
  type BangumiRetainedField,
  type BangumiReview,
  type BangumiReviewResult,
  type BangumiRow,
  type BangumiUnknown,
} from './contract';

type NativeResult = { data?: unknown; error?: { value?: unknown }; status: number };
type NativeHeaders = { authorization: string; 'idempotency-key'?: string };
type PreviewResource = {
  post: (body: { upload: string }, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type ReviewResource = {
  post: (
    body: { ordinal: number; target?: string },
    options: { headers: NativeHeaders },
  ) => Promise<NativeResult>;
};
type ApplyResource = {
  post: (body: BangumiApplyBody, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type CancelResource = {
  post: (body?: Record<string, never>, options?: { headers: NativeHeaders }) => Promise<NativeResult>;
};
type IdResource = {
  get: (options: { query?: { after?: number }; headers: NativeHeaders }) => Promise<NativeResult>;
  $review?: ReviewResource;
  review?: ReviewResource;
  $apply?: ApplyResource;
  apply?: ApplyResource;
  $cancel?: CancelResource;
  cancel?: CancelResource;
  delete: (body: undefined, options: { headers: NativeHeaders }) => Promise<NativeResult>;
};
export type BangumiSurface = ((params: { uploadId: string }) => IdResource) & {
  $preview?: PreviewResource;
  preview?: PreviewResource;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSurface(value: unknown): BangumiSurface | undefined {
  if (typeof value !== 'function') return undefined;
  const surface = value as BangumiSurface;
  const preview = surface.$preview ?? surface.preview;
  if (!preview || typeof preview.post !== 'function') return undefined;
  return surface;
}

/** Bind installed `libraryImports.bangumi` methods. Missing methods stay unavailable. */
export function nativeBangumiImport(client: KernelClient): BangumiSurface | undefined {
  const imports = client.libraryImports;
  if (!imports || typeof imports !== 'object' || !('bangumi' in imports)) return undefined;
  return asSurface(imports.bangumi);
}

function publicDetail(detail: unknown): string | undefined {
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  if (/[<>]|bangumi\.tv|collections\s*:/i.test(detail)) return undefined;
  return detail;
}

function failureKind(status: number, body: unknown): BangumiFailureKind {
  const detail = record(body) && typeof body.detail === 'string' ? body.detail : '';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not-found';
  if (status === 413 || /256 KiB|too large|content_too_large/i.test(detail)) return 'too-large';
  if (status === 422) return 'idempotency';
  if (status === 409) return 'conflict';
  if (status === 400 || /malformed|format|collections|invalid_request/i.test(detail)) return 'malformed';
  return 'unavailable';
}

function failure(status: number, body: unknown): BangumiFailure {
  const kind = failureKind(status, body);
  const detail = publicDetail(record(body) ? body.detail : undefined);
  return detail ? { kind, detail } : { kind };
}

function unknown(command: BangumiCommand): BangumiUnknown {
  return { kind: 'unknown', command };
}

function outcomeOf(status: number, body: unknown, command: BangumiCommand): BangumiFailure | BangumiUnknown {
  if (status === 0 || status >= 500) return unknown(command);
  return failure(status, body);
}

const matches: readonly BangumiMatch[] = [
  'matched',
  'already_matched',
  'ambiguous',
  'unmatched',
  'unavailable',
  'chosen',
];

function isMatch(value: unknown): value is BangumiMatch {
  return typeof value === 'string' && (matches as readonly string[]).includes(value);
}

function isJson(value: unknown): value is import('./contract').BangumiJson {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJson);
  if (!record(value)) return false;
  return Object.values(value).every(isJson);
}

function isField(value: unknown): value is BangumiRetainedField {
  if (!record(value) || typeof value.field !== 'string' || typeof value.reason !== 'string') return false;
  if (!('value' in value) || !isJson(value.value)) return false;
  return value.meaning === 'known' || value.meaning === 'unknown' || value.meaning === 'invalid';
}

function isEvidence(value: unknown): value is BangumiEvidence {
  if (!record(value) || !isJson(value.source) || typeof value.source !== 'object' || value.source === null || Array.isArray(value.source))
    return false;
  if (!Array.isArray(value.fields) || typeof value.medium !== 'string') return false;
  if (value.stateRole !== null && typeof value.stateRole !== 'string') return false;
  return value.fields.every(isField);
}

function isGuard(value: unknown): value is BangumiGuard {
  return (
    record(value) &&
    typeof value.subjectId === 'string' &&
    SUBJECT_ID.test(value.subjectId) &&
    typeof value.releaseDigest === 'string' &&
    typeof value.identityEpoch === 'string'
  );
}

function isCurrent(value: unknown): value is BangumiCurrent {
  if (!record(value) || typeof value.state !== 'string' || typeof value.revision !== 'number') return false;
  if ('incarnationId' in value && value.incarnationId !== null && typeof value.incarnationId !== 'string') return false;
  return true;
}

function isReview(value: unknown): value is BangumiReview {
  if (!record(value) || typeof value.token !== 'string' || !SUBJECT_ID.test(value.token)) return false;
  if (!isMatch(value.match) || !Array.isArray(value.candidates) || typeof value.conflict !== 'boolean') return false;
  if (value.target !== null && (typeof value.target !== 'string' || !SUBJECT_ID.test(value.target))) return false;
  if (value.guard !== null && !isGuard(value.guard)) return false;
  if (value.proposedState !== null && typeof value.proposedState !== 'string') return false;
  if (value.current !== null && !isCurrent(value.current)) return false;
  return value.candidates.every((id) => typeof id === 'string' && SUBJECT_ID.test(id));
}

function isOutcome(value: unknown): value is BangumiOutcome {
  if (!record(value) || typeof value.ordinal !== 'number' || !Array.isArray(value.applied) || !Array.isArray(value.retained))
    return false;
  return (
    value.status === 'applied' ||
    value.status === 'skipped' ||
    value.status === 'stale' ||
    value.status === 'unsupported' ||
    value.status === 'failed'
  );
}

function isRow(value: unknown): value is BangumiRow {
  if (!record(value) || typeof value.ordinal !== 'number' || !isEvidence(value.evidence)) return false;
  if (value.review !== null && !isReview(value.review)) return false;
  if (value.outcome !== null && !isOutcome(value.outcome)) return false;
  return true;
}

function isPage(value: unknown): value is BangumiPage {
  if (!record(value) || typeof value.uploadId !== 'string' || !SUBJECT_ID.test(value.uploadId)) return false;
  if (typeof value.cancelled !== 'boolean' || !Array.isArray(value.rows) || value.rows.length > BANGUMI_PAGE)
    return false;
  if (value.next !== null && typeof value.next !== 'number') return false;
  return value.rows.every(isRow);
}

function isApply(value: unknown): value is BangumiApplyResult {
  if (!record(value) || typeof value.uploadId !== 'string' || !Array.isArray(value.outcomes) || !Array.isArray(value.remaining))
    return false;
  return value.outcomes.every(isOutcome) && value.remaining.every((ordinal) => typeof ordinal === 'number');
}

function isChoice(value: unknown): value is BangumiChoice {
  if (!record(value) || typeof value.ordinal !== 'number' || typeof value.reviewToken !== 'string') return false;
  if (!SUBJECT_ID.test(value.reviewToken) || typeof value.skip !== 'boolean') return false;
  return value.state === 'preserve' || value.state === 'replace' || value.state === 'omit';
}

async function withSession(
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): Promise<{ authorization: string } | BangumiFailure> {
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

export function kernelBangumiPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): BangumiImportPort {
  const headers = (authorization: string, key?: string): NativeHeaders => ({
    authorization,
    ...(key ? { 'idempotency-key': quotedIdempotencyKey(key) } : {}),
  });
  async function call<T>(
    command: BangumiCommand,
    send: (bangumi: BangumiSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | BangumiFailure | BangumiUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const bangumi = nativeBangumiImport(client);
    if (!bangumi) return { kind: 'unavailable' };
    try {
      const result = await send(bangumi, session.authorization);
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
        (bangumi, authorization) => {
          const preview = bangumi.$preview ?? bangumi.preview;
          if (!preview) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return preview.post({ upload: command.upload }, { headers: headers(authorization, command.key) });
        },
        (data) => {
          if (!record(data) || typeof data.uploadId !== 'string' || !SUBJECT_ID.test(data.uploadId)) return undefined;
          if (typeof data.count !== 'number' || !Number.isInteger(data.count) || data.count < 1) return undefined;
          return { kind: 'previewed' as const, uploadId: data.uploadId, count: data.count };
        },
      );
    },
    async page(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).get({
            query: { after: command.after },
            headers: headers(authorization),
          }),
        (data) => (isPage(data) ? ({ kind: 'page', page: data } as const) : undefined),
      );
    },
    async review(command) {
      return call(
        command,
        (bangumi, authorization) => {
          const resource = bangumi({ uploadId: command.uploadId });
          const review = resource.$review ?? resource.review;
          if (!review) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return review.post(
            command.target ? { ordinal: command.ordinal, target: command.target } : { ordinal: command.ordinal },
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
      if (command.body.rows.length === 0 || command.body.rows.length > BANGUMI_APPLY) return { kind: 'malformed' };
      if (!command.body.rows.every(isChoice)) return { kind: 'malformed' };
      return call(
        command,
        (bangumi, authorization) => {
          const resource = bangumi({ uploadId: command.uploadId });
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
        (bangumi, authorization) => {
          const resource = bangumi({ uploadId: command.uploadId });
          const cancel = resource.$cancel ?? resource.cancel;
          if (!cancel) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return cancel.post({}, { headers: headers(authorization, command.key) });
        },
        (data) => {
          if (!record(data) || typeof data.uploadId !== 'string' || data.cancelled !== true) return undefined;
          return { kind: 'cancelled' as const, uploadId: data.uploadId };
        },
      );
    },
    async delete(command) {
      return call(
        command,
        (bangumi, authorization) =>
          bangumi({ uploadId: command.uploadId }).delete(undefined, { headers: headers(authorization, command.key) }),
        (data) => (record(data) && data.deleted === true ? ({ kind: 'deleted' } as const) : undefined),
      );
    },
  };
}

export type {
  BangumiApplyCallResult,
  BangumiMutateResult,
  BangumiPageResult,
  BangumiPreviewResult,
  BangumiReviewResult,
};
