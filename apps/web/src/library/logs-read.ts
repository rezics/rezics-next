import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import {
  LIBRARY_PAGE_LIMIT,
  libraryFullQuery,
  libraryListQuery,
  readLibraryResult,
  StaleCursorError,
  subjectOf,
  type LibraryLabel,
  type LibraryAccount,
  type LibrarySubject,
} from './reads';

type RawPublishedLog = {
  id: string;
  accountId: string;
  subjectId: string;
  sessionState: 'active' | 'completed' | 'abandoned';
  startedAt: string;
  completedAt: string | null;
  note: string | null;
  publishedAt: string;
  subject?: {
    id: string;
    type: string;
    types?: readonly string[];
    label: LibraryLabel;
    cover?: unknown;
  } | null;
  account?: { id: string; handle: string | null; displayName: string | null } | null;
};

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

/** Reads the public snapshot and determines ownership from the current authenticated identity. */
export async function loadPublishedLog(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { id: string },
): Promise<{ log: PublishedLog; isOwner: boolean }> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const result = await client.publishedLogs({ logId: input.id }).get({
    query: libraryFullQuery(),
    ...(authorization ? { headers: { authorization } } : {}),
  });
  const log = readLibraryResult(result).publishedLog as RawPublishedLog;
  return { log: present(log), isOwner: Boolean(sessionSubject(request) && sessionSubject(request) === log.accountId) };
}

async function readLogPage(client: KernelClient, accountId: string, authorization: string, cursor?: string) {
  const result = await client.publishedLogs.get({
    query: { ...libraryListQuery(cursor, LIBRARY_PAGE_LIMIT), accountId },
    headers: { authorization },
  });
  // Keep an owner's progress page usable while published-log listing is unavailable.
  if (statusOf(result) === 404) return { publishedLogs: [], next: null };
  return readLibraryResult(result) as { publishedLogs: RawPublishedLog[]; next: string | null };
}

/** Reads one newest-first page of the viewer's own public snapshots. */
export async function loadMyPublishedLogs(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  input: { cursor?: string },
): Promise<PublishedLogPage> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  const accountId = sessionSubject(request);
  if (!authorization || !accountId) return { signedIn: false, logs: [], next: null };

  let page: { publishedLogs: RawPublishedLog[]; next: string | null };
  try {
    page = await readLogPage(client, accountId, authorization, input.cursor);
  } catch (error) {
    if (!(error instanceof StaleCursorError) || !input.cursor) throw error;
    page = await readLogPage(client, accountId, authorization);
  }
  return { signedIn: true, logs: page.publishedLogs.map(present), next: page.next };
}

export type PublishedLogWriteResult =
  | { ok: true; id: string }
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
  await prepareSession(request, sessionEnv);
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
  input: { id: string; idempotencyKey: string },
): Promise<PublishedLogWriteResult> {
  await prepareSession(request, sessionEnv);
  const authorization = viewerCredential(request);
  if (!authorization) return { ok: false, reason: 'forbidden' };
  if (!routeIdPattern.test(input.id) || !idempotencyKeyPattern.test(input.idempotencyKey))
    return { ok: false, reason: 'invalid' };

  try {
    const result = await client.publishedLogs({ logId: input.id }).delete(undefined, {
      headers: writeHeaders(authorization, input.idempotencyKey),
    });
    const status = statusOf(result);
    const id = result.data?.publishedLog?.id;
    if (status >= 400 || result.error || !id) return writeFailure(result);
    return { ok: true, id };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    return { ok: false, reason: 'unavailable' };
  }
}
