import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { MediaProblem } from '../media/kernel';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { threadLocation } from '../threads/thread-href';

export const INBOX_PAGE_SIZE = 20;
/** One composed private list read; disclosure and destinations arrive with each admitted item. */
export const INBOX_PAGE_KERNEL_READ_CEILING = 1;

type NoticeRead = Awaited<ReturnType<ReturnType<KernelClient['accounts']>['notifications']['get']>>;
type NativeNotice = NonNullable<NoticeRead['data']>['items'][number];
type NativeActor = NativeNotice['actor'];
type NativeTarget = NativeNotice['target'];
type NativeActions = NativeNotice['actions'];
type NativeNoticeDetail = Readonly<{ viewer: Readonly<{ state: 'current' }>; notice: NativeNotice }>;
export type InboxNoticeDetailWire = NativeNoticeDetail;
type NativeNoticeDetailResult = Readonly<{
  data?: NativeNoticeDetail | null;
  error?: unknown;
  status: number;
  headers?: HeadersInit;
}>;
type NativeNoticeDetailRoute = Readonly<{
  get(options: { headers: HeadersInit; fetch?: { signal?: AbortSignal } }): Promise<NativeNoticeDetailResult>;
}>;

/** Optional composed fields keep presentational test seams small; native decoding requires every field. */
export type InboxNotice = {
  id: string;
  kind: string;
  createdAt: string;
  unread: boolean;
  actorId: string | null;
  threadId: string | null;
  postId: string | null;
  decisionId: string | null;
  reportId: string | null;
  actor?: NativeActor;
  target?: NativeTarget;
  summary?: string;
  actions?: NativeActions;
  /** Retained for older presentation fixtures; the native wire uses thread_watch/board_activity. */
  watch?: 'thread' | 'board';
};
type NoticePage = { items: InboxNotice[]; next: string | null };
type ResolvedNotice = InboxNotice & {
  href?: string;
  text: string;
  unavailable: boolean;
  actorName?: string;
  context?: string;
};
export type ResolvedInboxPage = { items: ResolvedNotice[]; next: string | null };

export type NativeInboxFailure = {
  status: number | null;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};

export type InboxPage =
  | { signedIn: false }
  | { signedIn: true; state: 'ready'; items: ResolvedNotice[]; next: string | null }
  | {
      signedIn: true;
      state: 'closed' | 'preparing' | 'unavailable';
      failure: NativeInboxFailure;
    };
export type InboxNoticePage =
  | { signedIn: false }
  | { signedIn: true; state: 'ready'; notice: ResolvedNotice }
  | { signedIn: true; state: 'unavailable'; failure: NativeInboxFailure };

class InboxReadError extends Error {
  constructor(readonly failure: NativeInboxFailure) {
    super('Native inbox read failed');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nativeFailure(value: unknown, status?: number, headers?: HeadersInit): NativeInboxFailure {
  const root = isRecord(value) ? value : undefined;
  const problem = root && isRecord(root.value) ? root.value : root && isRecord(root.problem) ? root.problem : root;
  const retryAfter =
    (headers === undefined ? undefined : new Headers(headers).get('retry-after')) ??
    (value instanceof MediaProblem ? new Headers(value.headers).get('retry-after') : undefined);
  return {
    status:
      status ??
      (root && typeof root.status === 'number'
        ? root.status
        : problem && typeof problem.status === 'number'
          ? problem.status
          : null),
    ...(problem && typeof problem.code === 'string' ? { code: problem.code } : {}),
    ...(problem && typeof problem.retryable === 'boolean' ? { retryable: problem.retryable } : {}),
    ...(problem && typeof problem.request_id === 'string'
      ? { requestId: problem.request_id }
      : problem && typeof problem.requestId === 'string'
        ? { requestId: problem.requestId }
        : {}),
    ...(retryAfter ? { retryAfter } : {}),
  };
}

function failureState(failure: NativeInboxFailure): 'closed' | 'preparing' | 'unavailable' {
  if (failure.code === 'platform_closed') return 'closed';
  // Neither the native notice API nor its current target reads declare a preparation problem.
  return 'unavailable';
}

export function inboxReadFailure(error: unknown): Extract<InboxPage, { failure: NativeInboxFailure }> {
  const failure =
    error instanceof InboxReadError
      ? error.failure
      : nativeFailure(error, isPlatformClosedError(error) ? error.status : undefined);
  return { signedIn: true, state: failureState(failure), failure };
}

export function inboxNoticeFailure(error: unknown): Extract<InboxNoticePage, { failure: NativeInboxFailure }> {
  const failure =
    error instanceof InboxReadError
      ? error.failure
      : nativeFailure(error, isPlatformClosedError(error) ? error.status : undefined);
  return { signedIn: true, state: 'unavailable', failure };
}

/** The native DTO declares string IDs; require a nonempty, unambiguous route segment. */
function noticeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\?#%]/.test(value) && value !== '.' && value !== '..';
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validActor(value: unknown): value is NativeActor {
  if (!isRecord(value)) return false;
  if (value.state === 'available')
    return (
      exactKeys(value, ['state', 'accountId', 'displayName', 'handle', 'avatarUrl', 'automated']) &&
      noticeId(value.accountId) &&
      typeof value.displayName === 'string' &&
      (value.handle === null || typeof value.handle === 'string') &&
      (value.avatarUrl === null || typeof value.avatarUrl === 'string') &&
      typeof value.automated === 'boolean'
    );
  if (value.state === 'withheld')
    return (
      exactKeys(value, ['state', 'displayName', 'handle', 'avatarUrl']) &&
      value.displayName === 'Former or unavailable account' &&
      value.handle === null &&
      value.avatarUrl === null
    );
  return (
    exactKeys(value, ['state', 'displayName', 'handle', 'avatarUrl']) &&
    value.state === 'system' &&
    value.displayName === 'Moderation team' &&
    value.handle === null &&
    value.avatarUrl === null
  );
}

function validTarget(value: unknown): value is NativeTarget {
  if (!isRecord(value) || !exactKeys(value, ['state', 'threadId', 'postId', 'boardId', 'threadTitle', 'boardTitle']))
    return false;
  if (value.state !== 'available' && value.state !== 'withheld') return false;
  for (const field of ['threadId', 'postId', 'boardId'] as const)
    if (value[field] !== null && !noticeId(value[field])) return false;
  for (const field of ['threadTitle', 'boardTitle'] as const)
    if (value[field] !== null && typeof value[field] !== 'string') return false;
  return true;
}

function validOpenAction(value: unknown): value is NativeActions['open'] {
  if (value === null) return true;
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'board') return exactKeys(value, ['kind', 'boardId']) && noticeId(value.boardId);
  if (value.kind === 'thread') return exactKeys(value, ['kind', 'threadId']) && noticeId(value.threadId);
  if (value.kind === 'thread_post')
    return exactKeys(value, ['kind', 'threadId', 'postId']) && noticeId(value.threadId) && noticeId(value.postId);
  if (value.kind === 'moderation_decision')
    return exactKeys(value, ['kind', 'decisionId']) && noticeId(value.decisionId);
  if (value.kind === 'report_outcome') return exactKeys(value, ['kind', 'reportId']) && noticeId(value.reportId);
  return false;
}

function openMatchesNotice(open: NativeActions['open'], item: Record<string, unknown>) {
  if (open === null) return true;
  const target = item.target as NativeTarget;
  if (open.kind === 'board') return target.state === 'available' && target.boardId === open.boardId;
  if (open.kind === 'thread') return target.state === 'available' && target.threadId === open.threadId;
  if (open.kind === 'thread_post')
    return target.state === 'available' && target.threadId === open.threadId && target.postId === open.postId;
  if (open.kind === 'moderation_decision')
    return item.kind === 'moderation_decision' && item.decisionId === open.decisionId;
  return item.kind === 'moderation_decision' && item.reportId === open.reportId;
}

function validNotice(value: unknown, accountId?: string): value is NativeNotice {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'id',
      'kind',
      'createdAt',
      'actorId',
      'threadId',
      'postId',
      'decisionId',
      'reportId',
      'actor',
      'target',
      'summary',
      'actions',
      'unread',
    ]) ||
    !noticeId(value.id) ||
    !['reply', 'mention', 'moderation_decision', 'thread_watch', 'board_activity'].includes(String(value.kind)) ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    typeof value.unread !== 'boolean' ||
    typeof value.summary !== 'string' ||
    !validActor(value.actor) ||
    !validTarget(value.target) ||
    !isRecord(value.actions) ||
    !exactKeys(value.actions, ['open', 'markSeen']) ||
    !validOpenAction(value.actions.open) ||
    !isRecord(value.actions.markSeen) ||
    !exactKeys(value.actions.markSeen, ['method', 'path']) ||
    value.actions.markSeen.method !== 'POST' ||
    typeof value.actions.markSeen.path !== 'string'
  )
    return false;
  for (const field of ['actorId', 'threadId', 'postId', 'decisionId', 'reportId'] as const)
    if (value[field] !== null && !noticeId(value[field])) return false;
  if (value.postId !== null && value.threadId === null) return false;
  if (value.actor.state === 'system' && value.kind !== 'moderation_decision') return false;
  if (value.actor.state === 'available' && value.actorId !== value.actor.accountId) return false;
  const expectedPath = accountId
    ? `/v1/accounts/${encodeURIComponent(accountId)}/notifications/${encodeURIComponent(value.id)}:markSeen`
    : /^\/v1\/accounts\/[^/]+\/notifications\/[^/]+:markSeen$/.test(value.actions.markSeen.path)
      ? value.actions.markSeen.path
      : '';
  if (!expectedPath || value.actions.markSeen.path !== expectedPath) return false;
  const target = value.target;
  if (value.threadId !== target.threadId || value.postId !== target.postId) return false;
  const open = value.actions.open as NativeActions['open'];
  if (value.kind === 'reply' || value.kind === 'mention')
    return (
      target.state === 'available' &&
      target.threadId !== null &&
      target.postId !== null &&
      value.decisionId === null &&
      value.reportId === null &&
      openMatchesNotice(open, value)
    );
  if (value.kind === 'thread_watch')
    return (
      target.state === 'available' &&
      target.threadId !== null &&
      value.decisionId === null &&
      value.reportId === null &&
      openMatchesNotice(open, value)
    );
  if (value.kind === 'board_activity')
    return (
      target.state === 'available' &&
      target.boardId !== null &&
      value.decisionId === null &&
      value.reportId === null &&
      openMatchesNotice(open, value)
    );
  if (value.kind === 'moderation_decision') {
    if (value.decisionId === null && value.reportId === null) return open === null;
    if (value.decisionId !== null && value.reportId !== null) return false;
    return openMatchesNotice(open, value);
  }
  return false;
}

function projectNativeNotice(item: NativeNotice): InboxNotice {
  const target: NativeTarget =
    item.target.state === 'withheld'
      ? { state: 'withheld', threadId: null, postId: null, boardId: null, threadTitle: null, boardTitle: null }
      : item.target;
  return {
    id: item.id,
    kind: item.kind,
    createdAt: item.createdAt,
    unread: item.unread,
    actorId: item.actor.state === 'available' ? item.actor.accountId : null,
    threadId: target.threadId,
    postId: target.postId,
    decisionId: item.decisionId,
    reportId: item.reportId,
    actor: item.actor,
    target,
    summary: item.summary,
    actions: item.actions,
  };
}

/** A malformed or unknown row fails the complete page; the native page already owns disclosure and destinations. */
export function decodeInboxPage(value: unknown, accountId?: string): NoticePage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['items', 'next']) ||
    !Array.isArray(value.items) ||
    value.items.length > INBOX_PAGE_SIZE ||
    !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 4096))
  )
    throw new InboxReadError({ status: 200 });
  const items = value.items.map((item) => {
    if (!validNotice(item, accountId)) throw new InboxReadError({ status: 200 });
    return projectNativeNotice(item);
  });
  return { items, next: value.next as string | null };
}

/** The exact response has the same strict closed item as the list and binds it to the current viewer. */
export function decodeInboxNoticeDetail(value: unknown, accountId: string, expectedId: string): NativeNotice {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['viewer', 'notice']) ||
    !isRecord(value.viewer) ||
    !exactKeys(value.viewer, ['state']) ||
    value.viewer.state !== 'current' ||
    !validNotice(value.notice, accountId) ||
    value.notice.id !== expectedId
  )
    throw new InboxReadError({ status: 200 });
  return projectNativeNotice(value.notice);
}

/** Convert only native action identities to existing localized routes; never consume a supplied URL. */
export function inboxOpenHref(item: InboxNotice): string | undefined {
  const open = item.actions?.open;
  if (
    !open ||
    !item.target ||
    (item.target.state !== 'available' && open.kind !== 'report_outcome' && open.kind !== 'moderation_decision')
  )
    return undefined;
  if (open.kind === 'board' && item.target.boardId === open.boardId)
    return localizeHref(`/boards/${encodeURIComponent(open.boardId)}`);
  if (open.kind === 'thread' && item.target.threadId === open.threadId)
    return threadLocation(getLocale(), { id: open.threadId, title: item.target.threadTitle });
  if (open.kind === 'thread_post' && item.target.threadId === open.threadId && item.target.postId === open.postId)
    return threadLocation(getLocale(), { id: open.threadId, title: item.target.threadTitle }, undefined, open.postId);
  if (open.kind === 'moderation_decision' && item.kind === 'moderation_decision' && item.decisionId === open.decisionId)
    return localizeHref(`/moderation/decisions/${encodeURIComponent(open.decisionId)}`);
  if (open.kind === 'report_outcome' && item.kind === 'moderation_decision' && item.reportId === open.reportId)
    return localizeHref(`/moderation/reports/${encodeURIComponent(open.reportId)}`);
  return undefined;
}

export function inboxTargetContext(target: NativeTarget | undefined): string | undefined {
  if (!target || target.state !== 'available') return undefined;
  const titles = [target.threadTitle, target.boardTitle].filter(
    (title): title is string => typeof title === 'string' && title.trim().length > 0,
  );
  return titles.length ? titles.join(' · ') : undefined;
}

/** The composed response supplies owner summary, current actor and target disclosure without point reads. */
export async function resolveInboxItems(page: NoticePage): Promise<ResolvedInboxPage> {
  return {
    items: page.items.map((notice) => {
      const native = notice.actor && notice.target && notice.actions;
      const actorName = notice.actor?.state === 'available' ? notice.actor.displayName.trim() : undefined;
      const context = inboxTargetContext(notice.target);
      const href = inboxOpenHref(notice);
      return {
        ...notice,
        ...(href ? { href } : {}),
        text: notice.summary ?? '',
        unavailable: !native || notice.target?.state === 'withheld',
        ...(actorName ? { actorName } : {}),
        ...(context ? { context } : {}),
      };
    }),
    next: page.next,
  };
}

function authHeaders(authorization: string) {
  return { authorization };
}

async function readNoticePage(
  client: Pick<KernelClient, 'accounts'>,
  accountId: string,
  authorization: string,
  cursor: string | undefined,
  signal?: AbortSignal,
) {
  const result = await client.accounts({ accountId }).notifications.get({
    query: { limit: INBOX_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    headers: authHeaders(authorization),
    ...(signal ? { fetch: { signal } } : {}),
  });
  if (result.error || result.status !== 200)
    throw new InboxReadError(nativeFailure(result.error, result.status, result.headers));
  return decodeInboxPage(result.data, accountId);
}

/** One native page contains all current disclosure and exact admitted destinations. */
export async function loadInboxPage(
  client: KernelClient,
  accountId: string,
  authorization: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ResolvedInboxPage> {
  return resolveInboxItems(await readNoticePage(client, accountId, authorization, cursor, signal));
}

/** Keep the generated route invocation narrow; the shared strict decoder validates its closed DTO. */
function exactNoticeRoute(client: KernelClient, accountId: string, noticeId: string): NativeNoticeDetailRoute {
  const account = client.accounts({ accountId }) as unknown as {
    notifications: (params: { noticeId: string }) => NativeNoticeDetailRoute;
  };
  return account.notifications({ noticeId });
}

export async function loadInboxNotice(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  viewerId: string,
  requestedNoticeId: string,
  signal?: AbortSignal,
): Promise<InboxNoticePage> {
  try {
    await prepareSession(request, sessionEnv);
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    if (accountId !== viewerId) {
      return {
        signedIn: true,
        state: 'unavailable',
        failure: { status: 404, code: 'not_found', retryable: false },
      };
    }
    const result = await exactNoticeRoute(client, accountId, requestedNoticeId).get({
      headers: authHeaders(authorization),
      ...(signal ? { fetch: { signal } } : {}),
    });
    if (result.error || result.status !== 200 || !result.data)
      throw new InboxReadError(nativeFailure(result.error, result.status, result.headers));
    const native = decodeInboxNoticeDetail(result.data, accountId, requestedNoticeId);
    const resolved = await resolveInboxItems({ items: [native], next: null });
    const notice = resolved.items[0];
    if (!notice) throw new InboxReadError({ status: result.status });
    return { signedIn: true, state: 'ready', notice };
  } catch (error) {
    return {
      signedIn: true,
      state: 'unavailable',
      failure: error instanceof InboxReadError ? error.failure : nativeFailure(error),
    };
  }
}

export const setInboxResponsePolicy = createServerFn({ method: 'GET' }).handler(() => {
  setResponseHeader('cache-control', 'private, no-store');
  return null;
});

export const readInboxPage = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      'cursor' in value &&
      value.cursor !== undefined &&
      (typeof value.cursor !== 'string' || value.cursor.length > 4096)
    )
      throw new Error('Invalid inbox cursor');
    return typeof value.cursor === 'string' && value.cursor ? { cursor: value.cursor } : {};
  })
  .handler(async ({ data }): Promise<InboxPage> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      await prepareSession(request, env as Partial<SessionEnv>);
      const authorization = viewerCredential(request);
      const accountId = sessionSubject(request);
      if (!authorization || !accountId) return { signedIn: false };
      return {
        signedIn: true,
        state: 'ready',
        ...(await loadInboxPage(kernelClient(), accountId, authorization, data.cursor, request.signal)),
      };
    } catch (error) {
      return inboxReadFailure(error);
    }
  });

export const readInboxNotice = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
    if (
      typeof value.viewerId !== 'string' ||
      !noticeId(value.viewerId) ||
      typeof value.noticeId !== 'string' ||
      !noticeId(value.noticeId)
    )
      throw new Error('Invalid notice identity');
    return { viewerId: value.viewerId, noticeId: value.noticeId };
  })
  .handler(async ({ data }): Promise<InboxNoticePage> => {
    setResponseHeader('cache-control', 'private, no-store');
    try {
      const request = getRequest();
      return await loadInboxNotice(
        kernelClient(),
        request,
        env as Partial<SessionEnv>,
        data.viewerId,
        data.noticeId,
        request.signal,
      );
    } catch (error) {
      return {
        signedIn: true,
        state: 'unavailable',
        failure: error instanceof InboxReadError ? error.failure : nativeFailure(error),
      };
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
      throw new InboxReadError(nativeFailure(result.error, result.status, result.headers));
    const count = result.data;
    if (
      !Number.isInteger(count.count) ||
      count.count < 0 ||
      count.count > 100 ||
      typeof count.capped !== 'boolean' ||
      (count.capped && count.count !== 100) ||
      (count.basis !== 'current-visible-unread' && count.basis !== 'current-visible-lower-bound') ||
      !isRecord(count.witness) ||
      !exactKeys(count.witness, ['kind', 'at']) ||
      count.witness.kind !== 'current-disclosure' ||
      typeof count.witness.at !== 'string' ||
      !Number.isFinite(Date.parse(count.witness.at)) ||
      new Date(count.witness.at).toISOString() !== count.witness.at
    )
      throw new InboxReadError({ status: result.status });
    return {
      signedIn: true,
      state: 'ready',
      count: count.count,
      capped: count.capped,
      basis: count.basis,
      witness: { kind: count.witness.kind, at: count.witness.at },
    };
  } catch (error) {
    return {
      signedIn: true,
      state: 'unavailable',
      failure: error instanceof InboxReadError ? error.failure : nativeFailure(error),
    };
  }
}

export const readUnreadCount = createServerFn({ method: 'GET' }).handler(async (): Promise<UnreadCount> => {
  setResponseHeader('cache-control', 'private, no-store');
  const request = getRequest();
  return loadUnreadCount(kernelClient(), request, env as Partial<SessionEnv>, request.signal);
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
  const native = error instanceof InboxSeenError ? error.failure : nativeFailure(error);
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
    throw new InboxSeenError(nativeFailure(result.error, result.status, result.headers));
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
    throw new InboxSeenError(nativeFailure(result.error, result.status, result.headers));
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
    return loadInboxSeen(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
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
    return loadInboxNoticeSeen(kernelClient(), getRequest(), env as Partial<SessionEnv>, data);
  });
