import { notFound } from '@tanstack/react-router';
import { deletionEvidence, nativeRevision, type DeletionEvidence } from './copies-receipt';
import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { assertPublicCacheReadAllowed } from '../security/page-cache';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { PublishedLogListError, requireMyLogsSearch } from './my-logs';
import {
  LIBRARY_PAGE_LIMIT,
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type LibraryAccount,
  type LibrarySubject,
} from './reads';

type NativePublishedLogPage = Extract<
  NonNullable<Awaited<ReturnType<KernelClient['publishedLogs']['get']>>['data']>,
  { publishedLogs: unknown[] }
>;
type RawPublishedLog = NativePublishedLogPage['publishedLogs'][number];

export type PublishedLog = {
  id: string;
  sessionState: RawPublishedLog['sessionState'];
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
  subject: LibrarySubject | null;
  account: LibraryAccount | null;
};

export type PublishedLogPage = {
  signedIn: boolean;
  logs: PublishedLog[];
  next: string | null;
  restarted?: true;
};

function present(log: RawPublishedLog): PublishedLog {
  return {
    id: log.id,
    sessionState: log.sessionState,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    note: log.note,
    publishedAt: log.publishedAt,
    subject: subjectOf(log.subject),
    account: log.account ? { handle: log.account.handle, displayName: log.account.displayName } : null,
  };
}

export type PublishedLogDetail = { log: PublishedLog; isOwner: boolean; revision?: number };
export type PublishedLogOwner = { sessionSubject: string; accountId: string; id: string; revision: number };
export type PublishedLogCurrentRead = PublishedLogDetail & { requestedId: string; owner: PublishedLogOwner | null };

async function readPublishedLogSnapshot(
  client: KernelClient,
  sourceRequest: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string },
): Promise<PublishedLogCurrentRead> {
  assertPublicCacheReadAllowed(sourceRequest, 'session');
  const headers = new Headers(sourceRequest.headers);
  const cookie = sourceRequest.headers.get('cookie');
  if (cookie !== null) headers.set('cookie', cookie);
  const request = new Request(sourceRequest, { headers });
  const refused = await prepareSession(request, sessionEnv);
  const authorization = refused ? null : viewerCredential(request);
  // Capture the successful preparation before dispatch, never from a later preparation
  // or an explicit bearer's unrelated retained Request subject.
  const accountId =
    refused || !authorization || request.headers.has('authorization') ? undefined : sessionSubject(request);
  const result = await client.publishedLogs({ logId: input.id }).get({
    query: libraryFullQuery(),
    fetch: { cache: 'no-store', redirect: 'manual' },
    ...(authorization ? { headers: { authorization } } : {}),
  });
  const log = readLibraryResult(result).publishedLog;
  if ('deleted' in log) throw notFound();
  const isOwner = Boolean(accountId && accountId === log.accountId);
  const revision = isOwner ? nativeRevision(result.response.headers.get('Library-Published-Log-Revision')) : undefined;
  const owner =
    isOwner && accountId && log.id === input.id && revision !== undefined
      ? { sessionSubject: accountId, accountId: log.accountId, id: input.id, revision }
      : null;
  return { log: present(log), isOwner, ...(revision === undefined ? {} : { revision }), requestedId: input.id, owner };
}

/** Compatible pure public reader; owner metadata never comes from the public account handle. */
export async function loadPublishedLog(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string },
): Promise<PublishedLogDetail> {
  const { log, isOwner, revision } = await readPublishedLogSnapshot(client, request, sessionEnv, input);
  return { log, isOwner, ...(revision === undefined ? {} : { revision }) };
}

/** One preparation and one point read, with no retained Request WeakMap provenance. */
export function loadPublishedLogCurrent(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string },
): Promise<PublishedLogCurrentRead> {
  return readPublishedLogSnapshot(client, request, sessionEnv, input);
}

async function readLogPage(client: KernelClient, accountId: string, authorization: string, cursor?: string) {
  const result = await client.publishedLogs.get({
    query: { ...libraryListQuery(cursor, LIBRARY_PAGE_LIMIT), accountId },
    headers: { authorization },
    fetch: { cache: 'no-store', redirect: 'manual' },
  });
  const status = result.response.status;
  if (status === 202) throw new PublishedLogListError('preparing');
  if (status === 401 || status === 403 || status === 404) throw new PublishedLogListError('denied');
  const page = readLibraryResult(result);
  if (!('publishedLogs' in page) || !Array.isArray(page.publishedLogs)) throw new PublishedLogListError('unavailable');
  return page;
}

/** Reads one newest-first page of the viewer's own public snapshots. */
export async function loadMyPublishedLogs(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<PublishedLogPage> {
  const { cursor } = requireMyLogsSearch(input);
  if (await prepareSession(request, sessionEnv)) return { signedIn: false, logs: [], next: null };
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, logs: [], next: null };

  let page: NativePublishedLogPage;
  let restarted = false;
  try {
    page = await readLogPage(client, accountId, authorization, cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !cursor) throw error;
    page = await readLogPage(client, accountId, authorization);
    restarted = true;
  }
  return {
    signedIn: true,
    logs: page.publishedLogs.map(present),
    next: page.next,
    ...(restarted ? { restarted: true } : {}),
  };
}

export type PublishedLogWriteResult =
  | { ok: true; id: string; undo?: DeletionEvidence; revision?: number }
  | { ok: false; reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable' };

type WriteResult<T> = { data?: T | null; error?: unknown; status?: number };

function statusOf(result: WriteResult<unknown>): number {
  if (typeof result.status === 'number') return result.status;
  if (result.error && typeof result.error === 'object' && 'status' in result.error) {
    const status = (result.error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('value' in error)) return undefined;
  const value = (error as { value: unknown }).value;
  if (!value || typeof value !== 'object' || !('code' in value)) return undefined;
  const code = (value as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function writeHeaders(authorization: string, idempotencyKey: string) {
  return { authorization, 'idempotency-key': JSON.stringify(idempotencyKey) } as { 'idempotency-key': string };
}

function writeFailure(result: WriteResult<unknown>): PublishedLogWriteResult {
  const status = statusOf(result);
  const code = codeOf(result.error);
  if (code === 'platform_closed') return { ok: false, reason: 'closed' };
  if (status === 409 || code === 'conflict') return { ok: false, reason: 'conflict' };
  if (status === 400 || status === 422 || code === 'validation' || code === 'invalid_request')
    return { ok: false, reason: 'invalid' };
  if (status === 401 || status === 403) return { ok: false, reason: 'forbidden' };
  return { ok: false, reason: 'unavailable' };
}

const idempotencyKeyPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const routeIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;

/** Publishes exactly the session the owner chose, with no revision-sensitive follow-up read. */
export async function publishProgressLog(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { sessionId: string; note?: string; idempotencyKey: string },
): Promise<PublishedLogWriteResult> {
  if (await prepareSession(request, sessionEnv)) return { ok: false, reason: 'forbidden' };
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  const note = input.note?.trim();
  if (
    !routeIdPattern.test(input.sessionId) ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    (note !== undefined && note.length > 1000)
  )
    return { ok: false, reason: 'invalid' };

  try {
    const result = await client.publishedLogs.post(
      { sessionId: input.sessionId, ...(note ? { note } : {}) },
      { headers: writeHeaders(authorization, input.idempotencyKey) },
    );
    const status = statusOf(result);
    const id = result.data?.publishedLog?.id;
    if (status >= 400 || result.error || !id) return writeFailure(result);
    return { ok: true, id };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** Retracts one snapshot with the owner's idempotency key; the kernel conceals non-owner records. */
export async function deletePublishedLog(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; revision?: number; idempotencyKey: string },
): Promise<PublishedLogWriteResult> {
  if (await prepareSession(request, sessionEnv)) return { ok: false, reason: 'forbidden' };
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  if (
    !routeIdPattern.test(input.id) ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    (input.revision !== undefined &&
      (!Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2147483644))
  )
    return { ok: false, reason: 'invalid' };

  try {
    const result = await client.publishedLogs({ logId: input.id }).delete(undefined, {
      ...(input.revision === undefined ? {} : { query: { revision: input.revision } }),
      headers: writeHeaders(authorization, input.idempotencyKey),
    });
    const status = statusOf(result);
    const id = result.data?.publishedLog?.id;
    if (status >= 400 || result.error || !id) return writeFailure(result);
    const undo = deletionEvidence(result.response.headers, 'Published-Log');
    return { ok: true, id, ...(undo ? { undo } : {}) };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** Reinstates the original public snapshot with its exact retained episode, never the current session. */
export async function restorePublishedLog(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string; deletionId: string; revision: number; idempotencyKey: string },
): Promise<PublishedLogWriteResult> {
  if (
    !routeIdPattern.test(input.id) ||
    !idempotencyKeyPattern.test(input.idempotencyKey) ||
    !idempotencyKeyPattern.test(input.deletionId) ||
    !Number.isSafeInteger(input.revision) ||
    input.revision < 1 ||
    input.revision > 2147483646
  )
    return { ok: false, reason: 'invalid' };
  if (await prepareSession(request, sessionEnv)) return { ok: false, reason: 'forbidden' };
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  try {
    const result = await client
      .publishedLogs({ logId: input.id })
      .$restore.post(
        { deletionId: input.deletionId, revision: input.revision },
        { headers: writeHeaders(authorization, input.idempotencyKey) },
      );
    if (result.error || !result.data?.publishedLog) return writeFailure(result);
    const revision = nativeRevision(result.response.headers.get('Library-Published-Log-Revision'));
    return { ok: true, id: result.data.publishedLog.id, ...(revision === undefined ? {} : { revision }) };
  } catch (error) {
    return { ok: false, reason: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
