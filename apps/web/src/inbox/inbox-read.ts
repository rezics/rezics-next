import type { KernelClient } from '@rezics/client';
import { documentText, type DocumentSnapshot } from '@rezics/document';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import { readPageAuthors } from '../identity/read';
import { isPlatformClosedError } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { reporterStatusResponse } from '../moderation/reporter-status-model';
import { MediaProblem } from '../media/kernel';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { threadLocation } from '../threads/thread-href';
import { unavailableInboxWatch, type InboxWatchBinding } from './watch-notices';

export const INBOX_PAGE_SIZE = 20;
/** One private list read, one batched author read, and at most one target read per notice. */
export const INBOX_PAGE_KERNEL_READ_CEILING = 2 + INBOX_PAGE_SIZE;

type NoticeRead = Awaited<ReturnType<ReturnType<KernelClient['accounts']>['notifications']['get']>>;
type NativeNotice = NonNullable<NoticeRead['data']>['items'][number];
/** watch is a local presentation category, never a new native kind. */
export type InboxNotice = Omit<NativeNotice, 'kind'> & { kind: string; watch?: 'thread' | 'board' };
type NoticePage = { items: InboxNotice[]; next: string | null };
type ResolvedNotice = InboxNotice & {
  href?: string;
  text: string;
  unavailable: boolean;
  actorName?: string;
};
export type ResolvedInboxPage = { items: ResolvedNotice[]; next: string | null };
export type InboxReads = {
  post: (
    threadId: string,
    postId: string,
  ) => Promise<{ title?: string; href?: string; text?: string; id?: string; threadId?: string } | null>;
  decision: (id: string) => Promise<{ statement: string; href?: string } | null>;
  report: (id: string) => Promise<{ outcome: string; href?: string } | null>;
  /** Until Content releases a watch binding, thread-only watch targets remain unavailable. */
  thread?: (id: string) => Promise<{ id: string; title: string } | null>;
};

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

/** The native DTO declares string IDs; require a nonempty, unambiguous route segment. */
function noticeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\?#%]/.test(value) && value !== '.' && value !== '..';
}

function validNotice(value: unknown, watch = false): value is InboxNotice {
  if (
    !isRecord(value) ||
    !noticeId(value.id) ||
    (watch
      ? typeof value.kind !== 'string' ||
        !value.kind ||
        ['reply', 'mention', 'moderation_decision'].includes(value.kind)
      : value.kind !== 'reply' && value.kind !== 'mention' && value.kind !== 'moderation_decision') ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    typeof value.unread !== 'boolean'
  )
    return false;
  for (const field of ['actorId', 'threadId', 'postId', 'decisionId', 'reportId'] as const) {
    if (value[field] !== null && !noticeId(value[field])) return false;
  }
  if (value.postId !== null && value.threadId === null) return false;
  if (watch) {
    return (
      (value.watch === 'thread' || value.watch === 'board') &&
      value.threadId !== null &&
      value.decisionId === null &&
      value.reportId === null
    );
  }
  if (value.kind === 'moderation_decision') {
    // Actioned reports can carry both report and decision IDs. Decisions can also retain post/thread IDs.
    return value.actorId === null && (value.reportId !== null || value.decisionId !== null);
  }
  return value.threadId !== null && value.postId !== null && value.decisionId === null && value.reportId === null;
}

/** A rejected row fails the whole page; no filtering can claim a partial successful read. */
export function decodeInboxPage(value: unknown, binding: InboxWatchBinding = unavailableInboxWatch): NoticePage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.items) ||
    value.items.length > INBOX_PAGE_SIZE ||
    !(value.next === null || (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= 4096))
  )
    throw new InboxReadError({ status: 200 });
  const items = value.items.map((item): InboxNotice => {
    if (validNotice(item)) return projectNotice(item);
    // Only the installed owner adapter knows the native watch kinds and wire fields.
    // A malformed existing native kind must never be rescued as a watch notice.
    if (isRecord(item) && ['reply', 'mention', 'moderation_decision'].includes(String(item.kind)))
      throw new InboxReadError({ status: 200 });
    const watch = binding.decode(item);
    if (!validNotice(watch, true)) throw new InboxReadError({ status: 200 });
    return projectNotice(watch, true);
  });
  return { items, next: value.next as string | null };
}

/** Native extensions cannot smuggle stale presentation or actor fields through the private response. */
function projectNotice(item: InboxNotice, includeWatch = false): InboxNotice {
  return {
    id: item.id,
    kind: item.kind,
    createdAt: item.createdAt,
    unread: item.unread,
    actorId: item.actorId,
    threadId: item.threadId,
    postId: item.postId,
    decisionId: item.decisionId,
    reportId: item.reportId,
    ...(includeWatch && item.watch ? { watch: item.watch } : {}),
  };
}

type CurrentTarget = { href?: string; text: string; identity?: { id: string; threadId: string } };

/** Resolves thin notice identities through their existing owner reads, once per distinct target. */
export async function resolveInboxItems(page: NoticePage, reads: InboxReads): Promise<ResolvedInboxPage> {
  const cache = new Map<string, Promise<CurrentTarget | null>>();
  const resolve = (key: string, read: () => Promise<CurrentTarget | null>) => {
    let result = cache.get(key);
    if (!result) {
      result = read().catch((error: unknown) => {
        if (error instanceof InboxReadError) throw error;
        throw new InboxReadError(nativeFailure(error, isPlatformClosedError(error) ? error.status : undefined));
      });
      cache.set(key, result);
    }
    return result;
  };
  const items = await Promise.all(
    page.items.map(async (notice): Promise<ResolvedNotice> => {
      let target: CurrentTarget | null = null;
      if (!notice.watch && notice.reportId) {
        target = await resolve(`report:${notice.reportId}`, async () => {
          const report = await reads.report(notice.reportId!);
          return report
            ? { href: report.href ?? `/moderation/reports/${notice.reportId}`, text: report.outcome }
            : null;
        });
      } else if (notice.kind === 'moderation_decision' && notice.decisionId) {
        target = await resolve(`decision:${notice.decisionId}`, async () => {
          const decision = await reads.decision(notice.decisionId!);
          return decision
            ? {
                href: decision.href ?? `/moderation/decisions/${notice.decisionId}`,
                text: decision.statement,
              }
            : null;
        });
      } else if (notice.threadId && notice.postId) {
        target = await resolve(`post:${notice.threadId}:${notice.postId}`, async () => {
          const post = await reads.post(notice.threadId!, notice.postId!);
          return post
            ? {
                href: post.href ?? threadLocation(getLocale(), { id: notice.threadId! }, undefined, notice.postId!),
                text: post.text ?? post.title ?? '',
                ...(post.id && post.threadId ? { identity: { id: post.id, threadId: post.threadId } } : {}),
              }
            : null;
        });
      } else if (notice.watch && notice.threadId && reads.thread) {
        target = await resolve(`thread:${notice.threadId}`, async () => {
          const thread = await reads.thread!(notice.threadId!);
          if (!thread) return null;
          if (thread.id !== notice.threadId || !noticeId(thread.id) || typeof thread.title !== 'string')
            throw new InboxReadError({ status: 200 });
          return { text: thread.title, href: threadLocation(getLocale(), thread) };
        });
      }
      if (
        notice.watch &&
        notice.postId &&
        target &&
        (target.identity?.id !== notice.postId || target.identity.threadId !== notice.threadId)
      )
        throw new InboxReadError({ status: 200 });
      return {
        ...projectNotice(notice, true),
        ...(!target ? { actorId: null } : {}),
        ...(target?.href ? { href: target.href } : {}),
        text: target?.text ?? '',
        unavailable: !target,
      };
    }),
  );
  return { items, next: page.next };
}

type ReadResult = { data?: unknown; error?: unknown; status?: number; headers?: HeadersInit | undefined };
type InboxKernelClient = {
  accounts: (params: { accountId: string }) => {
    notifications: {
      get: (options: unknown) => Promise<ReadResult>;
      count: { get: (options: unknown) => Promise<ReadResult> };
      $markSeen: { post: (options: unknown) => Promise<{ error?: unknown }> };
    };
  };
  posts: (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  'moderation-decisions': (params: { id: string }) => { get: (options: unknown) => Promise<ReadResult> };
  reports: KernelClient['reports'];
};
function authHeaders(authorization: string) {
  return { authorization };
}

function failTargetRead(result: ReadResult): boolean {
  if (!result.error && result.status === 200) return false;
  const failure = nativeFailure(result.error, result.status, result.headers);
  if (
    failure.code !== 'platform_closed' &&
    (failure.status === 401 || failure.status === 403 || failure.status === 404)
  )
    return true;
  throw new InboxReadError(failure);
}

async function readNoticePage(
  client: InboxKernelClient,
  accountId: string,
  authorization: string,
  cursor: string | undefined,
  binding: InboxWatchBinding,
) {
  const result = await client.accounts({ accountId }).notifications.get({
    query: { limit: INBOX_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    headers: authHeaders(authorization),
  });
  if (result.error || result.status !== 200)
    throw new InboxReadError(nativeFailure(result.error, result.status, result.headers));
  return decodeInboxPage(result.data, binding);
}

async function currentInboxReads(client: InboxKernelClient, authorization: string): Promise<InboxReads> {
  return {
    post: async (threadId, postId) => {
      const result = await client.posts({ id: postId }).get({ headers: authHeaders(authorization) });
      if (failTargetRead(result)) return null;
      const data = result.data as
        | { post?: { id?: string; threadId?: string; availability?: string; removed?: boolean; body?: unknown } }
        | undefined;
      if (
        result.error ||
        !data?.post ||
        data.post.threadId !== threadId ||
        (data.post.id !== undefined && data.post.id !== postId) ||
        data.post.availability === 'erased' ||
        data.post.removed === true
      )
        return null;
      return { text: postText(data.post), id: data.post.id, threadId: data.post.threadId };
    },
    decision: async (id) => {
      const result = await client['moderation-decisions']({ id }).get({ headers: authHeaders(authorization) });
      if (failTargetRead(result)) return null;
      const data = result.data as { statement?: string } | undefined;
      if (result.error || !data?.statement) return null;
      return { statement: data.statement, href: `/moderation/decisions/${id}` };
    },
    report: async (id) => {
      const result = await client.reports({ id }).get({ headers: authHeaders(authorization) });
      if (failTargetRead(result)) return null;
      // Moderator inspection is a different authorized response, never an own-status notice.
      if (!result.data?.report || !('targetAvailability' in result.data.report)) return null;
      const report = reporterStatusResponse(result.data);
      if (report.id !== id) throw new InboxReadError({ status: result.status });
      return {
        outcome:
          report.outcome === 'actioned'
            ? m.moderation_actioned()
            : report.outcome === 'dismissed'
              ? m.moderation_dismissed()
              : m.reporter_status_pending(),
        href: `/moderation/reports/${report.id}`,
      };
    },
  };
}

function postText(post: unknown): string {
  if (!post || typeof post !== 'object') return '';
  const record = post as Record<string, unknown>;
  const revision =
    record.revision && typeof record.revision === 'object' ? (record.revision as Record<string, unknown>) : record;
  const document = record.body ?? revision.body ?? revision.document;
  if (!document || typeof document !== 'object') return '';
  if ('doc' in document) return documentText(document as DocumentSnapshot);
  const text: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const value = node as Record<string, unknown>;
    if (value.type === 'text' && typeof value.text === 'string') text.push(value.text);
    if (Array.isArray(value.content)) value.content.forEach(visit);
  };
  visit(document);
  return text.join('');
}

/** One native page, its distinct targets and one batched public identity read. */
export async function loadInboxPage(
  client: KernelClient,
  accountId: string,
  authorization: string,
  cursor?: string,
  binding: InboxWatchBinding = unavailableInboxWatch,
): Promise<ResolvedInboxPage> {
  const typedClient = client as unknown as InboxKernelClient;
  const page = await readNoticePage(typedClient, accountId, authorization, cursor, binding);
  const reads = await currentInboxReads(typedClient, authorization);
  const resolved = await resolveInboxItems(page, {
    ...reads,
    thread: (id) => binding.readThread(id, { client, authorization }),
  });
  const authorIds = resolved.items.flatMap((item) => (!item.unavailable && item.actorId ? [item.actorId] : []));
  const authors = await readPageAuthors(client, authorIds);
  const items = resolved.items.map((item) => {
    const author = authors?.[item.actorId ?? ''] as { displayName?: string | null; handle?: string | null } | undefined;
    const actorName = author?.displayName?.trim() || author?.handle?.trim();
    return actorName ? { ...item, actorName } : item;
  });
  return { items, next: resolved.next };
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
        ...(await loadInboxPage(kernelClient(), accountId, authorization, data.cursor)),
      };
    } catch (error) {
      return inboxReadFailure(error);
    }
  });

export type UnreadCount =
  | { signedIn: false }
  | { signedIn: true; state: 'ready'; count: number; capped: boolean }
  | { signedIn: true; state: 'unavailable'; failure: NativeInboxFailure };

/** The badge has one private count read. A dependency failure never becomes a zero count. */
export async function loadUnreadCount(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
): Promise<UnreadCount> {
  try {
    await prepareSession(request, sessionEnv, { refresh: false });
    const authorization = viewerCredential(request);
    const accountId = sessionSubject(request);
    if (!authorization || !accountId) return { signedIn: false };
    const result = await client
      .accounts({ accountId })
      .notifications.count.get({ headers: authHeaders(authorization) });
    if (result.error || !result.data)
      throw new InboxReadError(nativeFailure(result.error, result.status, result.headers));
    const count = result.data;
    if (
      !Number.isInteger(count.count) ||
      count.count < 0 ||
      count.count > 100 ||
      typeof count.capped !== 'boolean' ||
      (count.capped && count.count !== 100)
    )
      throw new InboxReadError({ status: result.status });
    return { signedIn: true, state: 'ready', count: count.count, capped: count.capped };
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
  return loadUnreadCount(kernelClient(), getRequest(), env as Partial<SessionEnv>);
});

export type InboxSeenAttempt = { through: string; idempotencyKey: string };

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
