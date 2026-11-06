import type { KernelClient } from '@rezics/client';
import { isNotFound, isRedirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { MediaProblem } from '../media/kernel';
import {
  decodeInboxPage,
  decodeUnreadCount,
  InboxReadError,
  isInboxSelection,
  isRecord,
  nativeFailure,
  noticeId,
  resolveInboxItems,
  type InboxSelection,
  type NativeInboxFailure,
  type ResolvedInboxPage,
} from './inbox-decode';
import { INBOX_PAGE_SIZE, MAX_INBOX_CURSOR_LENGTH } from './inbox-work';

export { INBOX_PAGE_KERNEL_READ_CEILING, INBOX_PAGE_SIZE } from './inbox-work';
export {
  DEFAULT_INBOX_SELECTION,
  decodeInboxPage,
  decodeUnreadCount,
  inboxKindLabel,
  inboxOpenHref,
  inboxPageActions,
  inboxTargetContext,
  INBOX_SELECTIONS,
  InboxReadError,
  isInboxSelection,
  nativeInboxEnvelope,
  noticeId,
  readyInboxPage,
  resolveInboxItems,
  type InboxNotice,
  type InboxPageActions,
  type InboxPageMarkSeen,
  type InboxPageViewer,
  type InboxSelection,
  type NativeActor,
  type NativeInboxFailure,
  type NativeTarget,
  type NoticePage,
  type ResolvedInboxPage,
  type ResolvedNotice,
  type UnreadCountReady,
} from './inbox-decode';

export type InboxPage =
  | { signedIn: false }
  | {
      signedIn: true;
      state: 'ready';
      items: ResolvedInboxPage['items'];
      next: string | null;
      viewer: ResolvedInboxPage['viewer'];
      selection: InboxSelection;
      actions: ResolvedInboxPage['actions'];
    }
  | {
      signedIn: true;
      state: 'closed' | 'preparing' | 'unavailable';
      failure: NativeInboxFailure;
    };

function rethrowFrameworkControlFlow(error: unknown): void {
  if (isNotFound(error) || isRedirect(error)) throw error;
}

function failureState(failure: NativeInboxFailure): 'closed' | 'preparing' | 'unavailable' {
  if (failure.code === 'platform_closed') return 'closed';
  // Neither the native notice API nor its current target reads declare a preparation problem.
  return 'unavailable';
}

function transportFailure(value: unknown, status?: number, headers?: HeadersInit): NativeInboxFailure {
  const fromProblem = value instanceof MediaProblem ? value.headers : undefined;
  return nativeFailure(value, status, headers ?? fromProblem);
}

export function inboxReadFailure(error: unknown): Extract<InboxPage, { failure: NativeInboxFailure }> {
  rethrowFrameworkControlFlow(error);
  const failure =
    error instanceof InboxReadError
      ? error.failure
      : transportFailure(error, isPlatformClosedError(error) ? error.status : undefined);
  return { signedIn: true, state: failureState(failure), failure };
}

function authHeaders(authorization: string) {
  return { authorization };
}

export type InboxPageQuery = { selection: InboxSelection; cursor?: string };

async function readNoticePage(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  authorization: string,
  query: InboxPageQuery,
  signal?: AbortSignal,
) {
  const result = await client.accounts({ accountId }).notifications.get({
    query: {
      limit: INBOX_PAGE_SIZE,
      selection: query.selection,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    },
    headers: authHeaders(authorization),
    ...(signal ? { fetch: { signal } } : {}),
  });
  if (result.error || result.status !== 200)
    throw new InboxReadError(transportFailure(result.error, result.status, result.headers));
  return decodeInboxPage(result.data, accountId);
}

async function inboxSessionEnv(): Promise<Partial<SessionEnv>> {
  const { env } = await import('cloudflare:workers');
  return env as Partial<SessionEnv>;
}

async function inboxKernelClient() {
  const { kernelClient } = await import('../kernel/client');
  // Promise resolution reads `then`; keep the Eden proxy nested inside a plain container.
  return { client: kernelClient() };
}

function inboxPageQueryOf(value: InboxPageQuery | string | undefined): InboxPageQuery {
  if (value === undefined) return { selection: 'all' };
  if (typeof value === 'string') return { selection: 'all', cursor: value };
  return { selection: value.selection, ...(value.cursor ? { cursor: value.cursor } : {}) };
}

/** One native page contains all current disclosure and exact admitted destinations. */
export async function loadInboxPage(
  client: KernelClient,
  accountId: string,
  authorization: string,
  query: InboxPageQuery | string = { selection: 'all' },
  signal?: AbortSignal,
): Promise<ResolvedInboxPage> {
  return resolveInboxItems(await readNoticePage(client, accountId, authorization, inboxPageQueryOf(query), signal));
}

export const setInboxResponsePolicy = createServerFn({ method: 'GET' }).handler(() => {
  setResponseHeader('cache-control', 'private, no-store');
  return null;
});

export const readInboxPage = createServerFn({ method: 'GET' })
  .validator((input: unknown): InboxPageQuery => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      'cursor' in value &&
      value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || value.cursor.length > MAX_INBOX_CURSOR_LENGTH)
    )
      throw new Error('Invalid inbox cursor');
    const selection = value.selection === undefined ? 'all' : value.selection;
    if (!isInboxSelection(selection)) throw new Error('Invalid inbox selection');
    return {
      selection,
      ...(typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {}),
    };
  })
  .handler(async ({ data }): Promise<InboxPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      await prepareSession(request, await inboxSessionEnv());
      const authorization = viewerCredential(request);
      const accountId = sessionSubject(request);
      if (!authorization || !accountId) return { signedIn: false };
      const { client } = await inboxKernelClient();
      return {
        signedIn: true,
        state: 'ready',
        ...(await loadInboxPage(client, accountId, authorization, data, request.signal)),
      };
    } catch (error) {
      return inboxReadFailure(error);
    }
  });

export type UnreadCount =
  | { signedIn: false }
  | {
      signedIn: true;
      state: 'ready';
      count: number;
      capped: boolean;
      basis: 'current-visible-unread' | 'current-visible-lower-bound';
      witness: { kind: 'current-disclosure'; at: string };
    }
  | { signedIn: true; state: 'unavailable'; failure: NativeInboxFailure };

/** The badge has one private count read. A dependency failure never becomes a zero count. */
export async function loadUnreadCount(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  signal?: AbortSignal,
): Promise<UnreadCount> {
  try {
    await prepareSession(request, sessionEnv, { refresh: false });
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    const result = await client.accounts({ accountId }).notifications.count.get({
      headers: authHeaders(authorization),
      ...(signal ? { fetch: { signal } } : {}),
    });
    if (result.error || !result.data)
      throw new InboxReadError(transportFailure(result.error, result.status, result.headers));
    const count = decodeUnreadCount(result.data, result.status);
    return { signedIn: true, state: 'ready', ...count };
  } catch (error) {
    return unreadCountUnavailable(error);
  }
}

function unreadCountUnavailable(error: unknown): Extract<UnreadCount, { state: 'unavailable' }> {
  rethrowFrameworkControlFlow(error);
  const failure =
    error instanceof InboxReadError
      ? error.failure
      : transportFailure(error, isPlatformClosedError(error) ? error.status : undefined);
  return {
    signedIn: true,
    state: 'unavailable',
    failure: inboxSeenFailure(new InboxSeenError(failure)).failure,
  };
}

export const readUnreadCount = createServerFn({ method: 'GET' }).handler(async (): Promise<UnreadCount> => {
  setResponseHeader('cache-control', 'private, no-store');
  try {
    const request = getRequest();
    const { client } = await inboxKernelClient();
    return await loadUnreadCount(client, request, await inboxSessionEnv(), request.signal);
  } catch (error) {
    return unreadCountUnavailable(error);
  }
});

export type InboxSeenAttempt = { through: string; idempotencyKey: string };
export type InboxNoticeSeenAttempt = { accountId: string; noticeId: string; idempotencyKey: string };

/** Success keeps the original signedIn envelope; failures cross the wire as data, never Error fields. */
export type InboxSeenResult = { signedIn: boolean } | { signedIn: true; failure: NativeInboxFailure };

export class InboxSeenError extends Error {
  constructor(readonly failure: NativeInboxFailure) {
    super('Native inbox mark seen could not be confirmed');
    this.name = 'InboxSeenError';
  }
}

/** Project only bounded native diagnostics. Body text, credentials and body-supplied waits stay private. */
export function inboxSeenFailure(error: unknown): Extract<InboxSeenResult, { failure: NativeInboxFailure }> {
  rethrowFrameworkControlFlow(error);
  const native = error instanceof InboxSeenError ? error.failure : transportFailure(error);
  const bounded = (value: string | undefined) =>
    value && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
  const code = bounded(native.code);
  const requestId = bounded(native.requestId);
  const retryAfter = bounded(native.retryAfter);
  return {
    signedIn: true,
    failure: {
      status:
        native.status !== null && Number.isInteger(native.status) && native.status >= 100 && native.status <= 599
          ? native.status
          : null,
      ...(code ? { code } : {}),
      ...(typeof native.retryable === 'boolean' ? { retryable: native.retryable } : {}),
      ...(requestId ? { requestId } : {}),
      ...(retryAfter ? { retryAfter } : {}),
    },
  };
}

/** Replay the same marker and key after an unknown outcome; only native 204 confirms it. */
export async function markInboxThrough(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  authorization: string,
  attempt: InboxSeenAttempt,
): Promise<void> {
  const result = await client
    .accounts({ accountId })
    .notifications.$markSeen.post(
      { through: attempt.through },
      { headers: { ...authHeaders(authorization), 'idempotency-key': JSON.stringify(attempt.idempotencyKey) } },
    );
  if (result.error || result.status !== 204)
    throw new InboxSeenError(transportFailure(result.error, result.status, result.headers));
}

/** A chosen notice has its own native identity; it never advances the bulk through frontier. */
export async function markInboxNoticeSeen(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  authorization: string,
  attempt: InboxNoticeSeenAttempt,
): Promise<void> {
  if (attempt.accountId !== accountId || !noticeId(attempt.noticeId))
    throw new InboxSeenError({ status: 403, code: 'forbidden', retryable: false });
  const result = await client
    .accounts({ accountId })
    .notifications({ noticeId: attempt.noticeId })
    .$markSeen.post(undefined, {
      headers: { ...authHeaders(authorization), 'idempotency-key': JSON.stringify(attempt.idempotencyKey) },
    });
  if (result.error || result.status !== 204)
    throw new InboxSeenError(transportFailure(result.error, result.status, result.headers));
}

/** The private server-function result, including session/CSRF refusals, has one serializable failure shape. */
export async function loadInboxSeen(
  client: Pick<KernelClient, 'accounts'>,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  attempt: InboxSeenAttempt,
): Promise<InboxSeenResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    await markInboxThrough(client, accountId, authorization, attempt);
    return { signedIn: true };
  } catch (error) {
    return inboxSeenFailure(error);
  }
}

export const markInboxSeen = createServerFn({ method: 'POST' })
  .validator((input: unknown) => {
    if (
      !isRecord(input) ||
      typeof input.through !== 'string' ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
    )
      throw new Error('Invalid notice id');
    return { through: input.through, idempotencyKey: input.idempotencyKey };
  })
  .handler(async ({ data }): Promise<InboxSeenResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadInboxSeen((await inboxKernelClient()).client, getRequest(), await inboxSessionEnv(), data);
  });

export async function loadInboxNoticeSeen(
  client: Pick<KernelClient, 'accounts'>,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  attempt: InboxNoticeSeenAttempt,
): Promise<InboxSeenResult> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    await markInboxNoticeSeen(client, accountId, authorization, attempt);
    return { signedIn: true };
  } catch (error) {
    return inboxSeenFailure(error);
  }
}

export const markInboxItemSeen = createServerFn({ method: 'POST' })
  .validator((input: unknown): InboxNoticeSeenAttempt => {
    if (
      !isRecord(input) ||
      !noticeId(input.accountId) ||
      !noticeId(input.noticeId) ||
      typeof input.idempotencyKey !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.idempotencyKey)
    )
      throw new Error('Invalid notice id');
    return { accountId: input.accountId, noticeId: input.noticeId, idempotencyKey: input.idempotencyKey };
  })
  .handler(async ({ data }): Promise<InboxSeenResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    return loadInboxNoticeSeen((await inboxKernelClient()).client, getRequest(), await inboxSessionEnv(), data);
  });
