import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../../session/reading-policy';
import { archiveTransportLost } from '../archive-entry-recovery/native';
import type { SessionEnv } from '../../session/client';
import { prepareSession, requestCsrfToken, sessionSubject, viewerCredential } from '../../session/request';
import { mapSourceAdmissionPort, type SourceAdmissionCustody } from '../rich-private-entry/admission';
import { captureAnnotationCredential, originalAnnotationCredential } from '../rich-private-entry/credential';
import { admitPrivateSourceObservation } from '../rich-private-entry/native';
import { readOriginalOwnVote } from '../../ratings/own-votes/readback';
import { readRatingQuestion } from '../../ratings/question-read';
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
  type MalOwnVoteReadback,
  type MalQuestion,
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
  /** Treaty success responses carry `error: null`. */
  error?: { value?: unknown } | null;
  status: number;
};

type InstalledMal = KernelClient['libraryImports']['mal'];
type InstalledMalId = ReturnType<InstalledMal>;
type InstalledReview = InstalledMalId['review'];
type ReviewMethod = InstalledReview['post'];
type IdResource = Omit<InstalledMalId, 'review'> & {
  review: Omit<InstalledReview, 'post'> & {
    post: (body: MalReviewInput, options: Parameters<ReviewMethod>[1]) => ReturnType<ReviewMethod>;
  };
};
type MalSurface = ((params: Parameters<InstalledMal>[0]) => IdResource) & Pick<InstalledMal, '$preview'>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Bind the mounted MAL methods when present. Do not invent a path or a successful body. */
export function nativeMalImport(client: KernelClient): MalSurface | undefined {
  const mal = client.libraryImports?.mal as MalSurface | undefined;
  if (typeof mal !== 'function') return undefined;
  const preview = mal.$preview;
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
): Promise<{ authorization: string; viewer: string; csrfToken: string } | MalFailure> {
  if (!originConfigured) return { kind: 'unavailable' };
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    if (!authorization) return { kind: 'denied' };
    const viewer = sessionSubject(request);
    const csrfToken = requestCsrfToken(request);
    if (!viewer || !csrfToken) return { kind: 'denied' };
    return { authorization, viewer, csrfToken };
  } catch (error) {
    if (isPlatformClosedError(error)) return { kind: 'unavailable' };
    throw error;
  }
}

async function retainedCommand(
  command: MalCommand,
  session: { authorization: string; viewer: string; csrfToken: string },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<MalCommand> {
  if (command.custody) return command;
  const custody: SourceAdmissionCustody = {
    viewer: session.viewer,
    csrfToken: session.csrfToken,
    credential: await captureAnnotationCredential(
      request,
      sessionEnv,
      { viewer: session.viewer, csrfToken: session.csrfToken, authorization: session.authorization },
      command.kind === 'admit-source' ? command.subjectId : session.viewer,
    ),
  };
  return { ...command, custody } as MalCommand;
}

async function originalAuthorization(
  command: MalCommand,
  session: { authorization: string; viewer: string; csrfToken: string },
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<string | null> {
  const custody = command.custody;
  if (!custody) return session.authorization;
  return originalAnnotationCredential(request, sessionEnv, session, {
    viewer: custody.viewer,
    csrfToken: custody.csrfToken,
    subjectId: command.kind === 'admit-source' ? command.subjectId : custody.viewer,
    credential: custody.credential,
  });
}

export function kernelMalPort(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  originConfigured: boolean,
): MalImportPort {
  const headers = (authorization: string) => ({ authorization });
  const keyedHeaders = (authorization: string, key: string) => ({ authorization, 'idempotency-key': key });
  async function call<T>(
    command: MalCommand,
    send: (mal: MalSurface, authorization: string) => Promise<NativeResult>,
    read: (data: unknown) => T | undefined,
  ): Promise<T | MalFailure | MalUnknown> {
    const session = await withSession(request, sessionEnv, originConfigured);
    if ('kind' in session) return session;
    const authorization = await originalAuthorization(command, session, request, sessionEnv);
    if (!authorization) return { kind: 'denied' };
    const mal = nativeMalImport(client);
    if (!mal) return { kind: 'unavailable' };
    try {
      const result = await send(mal, authorization);
      if (result.error) {
        const uncertain = result.status === 0 || result.status >= 500;
        const exact = uncertain ? await retainedCommand(command, session, request, sessionEnv) : command;
        return outcomeOf(result.status, result.error.value, exact);
      }
      const value = read(result.data);
      if (!value) return { kind: 'unavailable' };
      return value;
    } catch (error) {
      if (isPlatformClosedError(error)) return { kind: 'unavailable' };
      if (archiveTransportLost(error)) return unknown(await retainedCommand(command, session, request, sessionEnv));
      throw error;
    }
  }
  return {
    async readQuestion() {
      const question: MalQuestion | null = await readRatingQuestion(client);
      return question ? { kind: 'question', question } : { kind: 'unavailable' };
    },
    async readVote(input) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const value: MalOwnVoteReadback = await readOriginalOwnVote(
        client,
        session.authorization,
        input.targetId,
        input.questionId,
        'REVIEW',
      );
      return { kind: 'vote', value };
    },
    async source(id) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const result = await client.libraryImports.mal({ id }).source.get({ headers: headers(session.authorization) });
      if (result.error) return failure(result.status, result.error.value);
      return { kind: 'source', xml: result.data.xml };
    },
    async assignments(subjectId) {
      const session = await withSession(request, sessionEnv, originConfigured);
      if ('kind' in session) return session;
      const result = await client.libraryLabelAssignments.get({
        query: { subjectId, limit: 32 },
        headers: headers(session.authorization),
      });
      if (result.error) return failure(result.status, result.error.value);
      return { kind: 'assignments', assignments: result.data.assignments };
    },
    async preview(command) {
      const result = await call(
        command,
        (mal, authorization) => {
          return mal.$preview.post({ xml: command.xml }, { headers: keyedHeaders(authorization, command.key) });
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
          mal({ id: command.id }).review.post(command.input, { headers: keyedHeaders(authorization, command.key) }),
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
          mal({ id: command.id }).cancel.post({}, { headers: keyedHeaders(authorization, command.key) }),
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
          mal({ id: command.id }).delete(undefined, { headers: keyedHeaders(authorization, command.key) }),
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
      const authorization = await originalAuthorization(command, session, request, sessionEnv);
      if (!authorization) return { kind: 'denied' };
      try {
        const result = await admitPrivateSourceObservation(client, {
          subjectId: command.subjectId,
          body: command.body,
          key: command.key,
          authorization,
        });
        const mapped = mapSourceAdmissionPort(result, command);
        if (mapped.kind !== 'unknown' || command.custody) return mapped;
        return { kind: 'unknown', command: await retainedCommand(command, session, request, sessionEnv) };
      } catch (error) {
        if (isPlatformClosedError(error)) return { kind: 'unavailable' };
        if (archiveTransportLost(error))
          return { kind: 'unknown', command: await retainedCommand(command, session, request, sessionEnv) };
        throw error;
      }
    },
  };
}

export type { MalApplyResult, MalMutateResult, MalPageResult, MalPreviewResult, MalReviewResult };
