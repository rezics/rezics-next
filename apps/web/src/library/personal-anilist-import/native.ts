import { aniListLabelRequests } from './label-native';
import type { KernelClient } from '@rezics/client';
import { readSubjectLabelAssignments } from '../subject-labels.ts';
import { archiveTransportLost } from '../archive-entry-recovery/native';
import { isPlatformClosedError } from '../../kernel/platform-closed';
import { QUESTION } from '../../features/pages/subject-ratings';
import { readHomeQuestion } from '../../features/pages/home-feed-questions';
import type { SessionEnv } from '../../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import { mapSourceAdmissionPort, type SourceAdmissionCustody } from '../rich-private-entry/admission';
import { captureAnnotationCredential, originalAnnotationCredential } from '../rich-private-entry/credential';
import { admitPrivateSourceObservation } from '../rich-private-entry/native';
import {
  ANILIST_APPLY,
  ANILIST_PAGE,
  SUBJECT_ID,
  boundedHeader,
  completenessOf,
  isScoreFormat,
  quotedIdempotencyKey,
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
  type AniListQuestionResult,
  type AniListRecord,
  type AniListReview,
  type AniListReviewInput,
  type AniListReviewResult,
  type AniListRow,
  type AniListSource,
  type AniListSourceField,
  type AniListUnknown,
} from './contract';

type NativeResult<T = unknown> = { data?: T; error?: { value?: unknown } | null; status: number };
type AniListSurface = NonNullable<KernelClient['libraryImports']['anilist']>;
type IdResource = ReturnType<AniListSurface>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asSurface(value: unknown): AniListSurface | undefined {
  if (typeof value !== 'function') return undefined;
  const surface = value as AniListSurface;
  const preview = surface.$preview;
  if (!preview || typeof preview.post !== 'function') return undefined;
  return surface;
}

/** Bind installed `libraryImports.anilist` methods. Missing methods stay unavailable. */
export function nativeAniListImport(client: KernelClient): AniListSurface | undefined {
  return asSurface(client.libraryImports?.anilist);
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
  if (value.score !== undefined && !isReviewScore(value.score)) return false;
  return true;
}

function isReviewScore(value: unknown): boolean {
  if (!record(value) || typeof value.questionId !== 'string' || !SUBJECT_ID.test(value.questionId)) return false;
  if (!Number.isSafeInteger(value.questionRevision) || (value.questionRevision as number) < 1) return false;
  if (value.action === 'clear') return true;
  return value.action === 'vote' && Number.isSafeInteger(value.units) && (value.units as number) >= 0;
}

function isReview(value: unknown): value is AniListReview {
  if (!record(value) || typeof value.id !== 'string' || !SUBJECT_ID.test(value.id)) return false;
  if (typeof value.commandKey !== 'string' || typeof value.clientId !== 'string') return false;
  if (value.requestedBy !== null && typeof value.requestedBy !== 'string') return false;
  if (!isMatch(value.match) || !isReviewInput(value.input)) return false;
  if (value.score !== undefined && !isRecord(value.score)) return false;
  return value.observation === null || isObservation(value.observation);
}

function isOutcome(value: unknown): value is AniListOutcome {
  if (!record(value) || typeof value.ordinal !== 'number' || !Array.isArray(value.retained)) return false;
  if (!value.retained.every((field) => typeof field === 'string')) return false;
  if (value.score !== undefined && !isRecord(value.score)) return false;
  return (
    value.status === 'applied' ||
    value.status === 'skipped' ||
    value.status === 'stale' ||
    value.status === 'unsupported' ||
    value.status === 'failed' ||
    value.status === 'unavailable'
  );
}

function isHeader(value: unknown): value is AniListHeader {
  if (!record(value) || typeof value.count !== 'number' || typeof value.cancelled !== 'boolean') return false;
  if (typeof value.rawUpload !== 'string') return false;
  if (value.document !== null && !isJson(value.document)) return false;
  if (value.scoreFormat !== null && !isScoreFormat(value.scoreFormat)) return false;
  return true;
}

function isRow(value: unknown): value is AniListRow {
  if (!record(value) || typeof value.ordinal !== 'number' || !isSource(value.source) || !isMatch(value.match))
    return false;
  if (value.proposal !== null && value.proposal !== undefined && !isObservation(value.proposal)) return false;
  if (value.review !== null && value.review !== undefined && !isReview(value.review)) return false;
  if (value.outcome !== null && value.outcome !== undefined && !isOutcome(value.outcome)) return false;
  if (value.currentScore !== undefined && value.currentScore !== null && !isCurrentScore(value.currentScore))
    return false;
  if (value.scoreLexeme !== undefined && typeof value.scoreLexeme !== 'string') return false;
  return true;
}

function isCurrentScore(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.status === 'unavailable') return typeof value.reason === 'string';
  if (value.status !== 'current' || !record(value.question)) return false;
  return (
    typeof value.question.id === 'string' &&
    typeof value.question.revision === 'number' &&
    (value.vote === null ||
      (record(value.vote) && Number.isSafeInteger(value.vote.units) && typeof value.vote.revision === 'number'))
  );
}

function normalizeRow(value: AniListRow): AniListRow {
  return {
    ...value,
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

function pointFailure(status: string): AniListFailure {
  if (status === 'auth' || status === 'denied') return { kind: 'denied' };
  if (status === 'lost') return { kind: 'not-found' };
  if (status === 'invalid') return { kind: 'malformed' };
  return { kind: 'unavailable' };
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

async function retainedAdmitCommand(
  command: Extract<AniListCommand, { kind: 'admit-source' }>,
  session: { authorization: string },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<Extract<AniListCommand, { kind: 'admit-source' }> | AniListFailure> {
  if (command.custody) return command;
  const viewer = sessionSubject(request);
  const csrfToken = requestCsrfToken(request);
  if (!viewer || !csrfToken) return { kind: 'denied' };
  const custody: SourceAdmissionCustody = {
    viewer,
    csrfToken,
    credential: await captureAnnotationCredential(
      request,
      sessionEnv,
      { viewer, csrfToken, authorization: session.authorization },
      command.subjectId,
    ),
  };
  return { ...command, custody };
}

async function admitAuthorization(
  command: Extract<AniListCommand, { kind: 'admit-source' }>,
  session: { authorization: string },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  original?: string,
): Promise<string | null> {
  const custody = command.custody;
  if (!custody) return original ?? session.authorization;
  return originalAnnotationCredential(
    request,
    sessionEnv,
    { ...session, viewer: custody.viewer, csrfToken: custody.csrfToken },
    {
      viewer: custody.viewer,
      csrfToken: custody.csrfToken,
      subjectId: command.subjectId,
      credential: custody.credential,
    },
  );
}

export function kernelAniListPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
  originalAuthorization?: string,
): AniListImportPort {
  const authorizationHeaders = (authorization: string) => ({ authorization });
  const idempotencyHeaders = (authorization: string, key: string) => ({
    authorization,
    'idempotency-key': quotedIdempotencyKey(key),
  });
  async function call<T, Data>(
    command: AniListCommand,
    send: (anilist: AniListSurface, authorization: string) => Promise<NativeResult<Data>>,
    read: (data: NonNullable<Data>) => T | undefined,
  ): Promise<T | AniListFailure | AniListUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const anilist = nativeAniListImport(client);
    if (!anilist) return { kind: 'unavailable' };
    try {
      const result = await send(anilist, originalAuthorization ?? session.authorization);
      if (result.error) return outcomeOf(result.status, result.error.value, command);
      const value = read(result.data!);
      if (!value) return { kind: 'unavailable' };
      return value;
    } catch (error) {
      if (isPlatformClosedError(error)) return { kind: 'unavailable' };
      if (archiveTransportLost(error)) return unknown(command);
      throw error;
    }
  }
  return {
    async reviewLabels(command) {
      return call(
        command,
        (_anilist, authorization) =>
          aniListLabelRequests(client, authorization).review(command.importId, command.body, command.key),
        (data) => ({ kind: 'labels-reviewed' as const, ordinal: data.ordinal, review: data.review }),
      );
    },
    async applyLabels(command) {
      return call(
        command,
        (_anilist, authorization) => aniListLabelRequests(client, authorization).apply(command.importId, command.body),
        (data) => ({ kind: 'labels-applied' as const, result: data }),
      );
    },
    async readLabels(command) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      return {
        kind: 'labels-read',
        labels: await readSubjectLabelAssignments(client, command.subjectId, session.authorization),
      };
    },
    async labelTargets(query, cursor) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const result = await client.libraryLabels.get({
        query: { q: query, limit: 20, ...(cursor ? { cursor } : {}) },
        headers: authorizationHeaders(session.authorization),
      });
      if (result.error) return failure(result.status, result.error.value);
      return { kind: 'label-targets', labels: result.data!.labels, next: result.data!.next };
    },
    async question(): Promise<AniListQuestionResult> {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const result = await readHomeQuestion(client, QUESTION, session.authorization);
      return result.status === 'ready' ? { kind: 'question', question: result.question } : pointFailure(result.status);
    },
    async preview(command) {
      return call(
        command,
        (anilist, authorization) => {
          const preview = anilist.$preview;
          if (!preview) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          const body = command.scoreFormat
            ? { upload: command.upload, scoreFormat: command.scoreFormat }
            : { upload: command.upload };
          // The installed route accepts scoreFormat; the generated client currently marks it `never`.
          return preview.post(body as never, { headers: idempotencyHeaders(authorization, command.key) });
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
            headers: authorizationHeaders(authorization),
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
          const review = resource.$review;
          if (!review) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return review.post(
            {
              ordinal: command.ordinal,
              fields: command.fields,
              replace: command.replace,
              ...(command.subjectId ? { subjectId: command.subjectId } : {}),
              ...(command.skip ? { skip: true } : {}),
              ...(command.score === undefined ? {} : { score: command.score }),
            },
            { headers: idempotencyHeaders(authorization, command.key) },
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
          const apply = resource.$apply;
          if (!apply) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return apply.post(command.body, { headers: authorizationHeaders(authorization) });
        },
        (data) => (isApply(data) ? ({ kind: 'applied', result: data } as const) : undefined),
      );
    },
    async cancel(command) {
      return call(
        command,
        (anilist, authorization) => {
          const resource = anilist({ importId: command.importId });
          const cancel = resource.$cancel;
          if (!cancel) return Promise.resolve({ status: 503, error: { value: { code: 'unavailable' } } });
          return cancel.post({ remove: command.remove }, { headers: idempotencyHeaders(authorization, command.key) });
        },
        (data) => {
          if (!record(data) || data.cancelled !== true) return undefined;
          return { kind: 'cancelled' as const, removed: command.remove };
        },
      );
    },
    async admitSource(command) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const retained = await retainedAdmitCommand(command, session, request, sessionEnv);
      if ('kind' in retained && retained.kind !== 'admit-source') return retained;
      const working = retained;
      const authorization = await admitAuthorization(working, session, request, sessionEnv, originalAuthorization);
      if (!authorization) return { kind: 'denied' };
      try {
        const result = await admitPrivateSourceObservation(client, {
          subjectId: working.subjectId,
          body: working.body,
          key: working.key,
          authorization,
        });
        const mapped = mapSourceAdmissionPort(result, working);
        if (mapped.kind !== 'unknown' || command.custody) return mapped;
        return { kind: 'unknown', command: working };
      } catch (error) {
        if (isPlatformClosedError(error)) return { kind: 'unavailable' };
        return unknown(working);
      }
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
