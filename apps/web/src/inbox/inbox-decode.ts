import type { KernelClient } from '@rezics/client';
import { m } from '../paraglide/messages.js';
import { getLocale, localizeHref } from '../paraglide/runtime.js';
import { threadLocation } from '../threads/thread-href';
import { INBOX_PAGE_SIZE, MAX_INBOX_CURSOR_LENGTH } from './inbox-work';

export const INBOX_SELECTIONS = ['all', 'unread'] as const;
export type InboxSelection = (typeof INBOX_SELECTIONS)[number];
export const DEFAULT_INBOX_SELECTION: InboxSelection = 'all';

export type InboxPageMarkSeen = { method: 'POST'; path: string; through: string };
export type InboxPageActions = { markSeen: InboxPageMarkSeen | null };
export type InboxPageViewer = { accountId: string };

type NoticeRead = Awaited<ReturnType<ReturnType<KernelClient['accounts']>['notifications']['get']>>;
type NativeNotice = NonNullable<NoticeRead['data']>['items'][number];
export type NativeActor = NativeNotice['actor'];
export type NativeTarget = NativeNotice['target'];
export type NativeActions = NativeNotice['actions'];

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

export type NoticePage = {
  items: InboxNotice[];
  next: string | null;
  viewer: InboxPageViewer;
  selection: InboxSelection;
  actions: InboxPageActions;
};

export type ResolvedNotice = InboxNotice & {
  href?: string;
  text: string;
  unavailable: boolean;
  actorName?: string;
  context?: string;
};

export type ResolvedInboxPage = {
  items: ResolvedNotice[];
  next: string | null;
  viewer: InboxPageViewer;
  selection: InboxSelection;
  actions: InboxPageActions;
};

export type NativeInboxFailure = {
  status: number | null;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};

export class InboxReadError extends Error {
  constructor(readonly failure: NativeInboxFailure) {
    super('Native inbox read failed');
  }
}

export type UnreadCountWitness = { kind: 'current-disclosure'; at: string };
export type UnreadCountReady = {
  count: number;
  capped: boolean;
  basis: 'current-visible-unread' | 'current-visible-lower-bound';
  witness: UnreadCountWitness;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nativeFailure(value: unknown, status?: number, headers?: HeadersInit): NativeInboxFailure {
  const root = isRecord(value) ? value : undefined;
  const problem = root && isRecord(root.value) ? root.value : root && isRecord(root.problem) ? root.problem : root;
  const retryAfter = headers === undefined ? undefined : new Headers(headers).get('retry-after');
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

/** The native DTO declares string IDs; require a nonempty, unambiguous route segment. */
export function noticeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/[\s/\\?#%]/.test(value) && value !== '.' && value !== '..';
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function validAvatarSummary(value: unknown): boolean {
  if (value === null) return true;
  if (
    !isRecord(value) ||
    !exactKeys(value, ['media', 'width', 'height', 'placeholder', 'variants', 'focalPoint', 'credit']) ||
    !noticeId(value.media) ||
    !positiveInteger(value.width) ||
    !positiveInteger(value.height) ||
    value.credit !== null
  )
    return false;
  const placeholder = value.placeholder;
  if (
    !isRecord(placeholder) ||
    !exactKeys(placeholder, ['thumbhash', 'color']) ||
    typeof placeholder.thumbhash !== 'string' ||
    placeholder.thumbhash.length > 44 ||
    typeof placeholder.color !== 'string' ||
    !/^#[0-9a-f]{6}$/.test(placeholder.color)
  )
    return false;
  if (!Array.isArray(value.variants) || value.variants.length > 12) return false;
  for (const variant of value.variants) {
    if (
      !isRecord(variant) ||
      !exactKeys(variant, ['format', 'width']) ||
      (variant.format !== 'avif' && variant.format !== 'webp') ||
      !positiveInteger(variant.width)
    )
      return false;
  }
  if (value.focalPoint === null) return true;
  return (
    isRecord(value.focalPoint) &&
    exactKeys(value.focalPoint, ['x', 'y']) &&
    typeof value.focalPoint.x === 'number' &&
    value.focalPoint.x >= 0 &&
    value.focalPoint.x <= 1 &&
    typeof value.focalPoint.y === 'number' &&
    value.focalPoint.y >= 0 &&
    value.focalPoint.y <= 1
  );
}

function validClosedActorLabels(
  value: Record<string, unknown>,
  state: 'withheld' | 'system',
  displayName: 'Former or unavailable account' | 'Moderation team',
): boolean {
  const installed = exactKeys(value, ['state', 'displayName', 'handle', 'avatar', 'avatarUrl']);
  const retained = exactKeys(value, ['state', 'displayName', 'handle', 'avatarUrl']);
  return (
    (installed || retained) &&
    value.state === state &&
    value.displayName === displayName &&
    value.handle === null &&
    value.avatarUrl === null &&
    (!installed || value.avatar === null)
  );
}

function validActor(value: unknown): value is NativeActor {
  if (!isRecord(value)) return false;
  if (value.state === 'available') {
    const installed = exactKeys(value, [
      'state',
      'accountId',
      'displayName',
      'handle',
      'avatar',
      'avatarUrl',
      'automated',
    ]);
    const retained = exactKeys(value, ['state', 'accountId', 'displayName', 'handle', 'avatarUrl', 'automated']);
    return (
      (installed || retained) &&
      noticeId(value.accountId) &&
      typeof value.displayName === 'string' &&
      (value.handle === null || typeof value.handle === 'string') &&
      typeof value.automated === 'boolean' &&
      (installed
        ? validAvatarSummary(value.avatar) && value.avatarUrl === null
        : value.avatarUrl === null || typeof value.avatarUrl === 'string')
    );
  }
  if (value.state === 'withheld') return validClosedActorLabels(value, 'withheld', 'Former or unavailable account');
  return validClosedActorLabels(value, 'system', 'Moderation team');
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

export function isInboxSelection(value: unknown): value is InboxSelection {
  return value === 'all' || value === 'unread';
}

function validPageViewer(value: unknown, accountId?: string): value is InboxPageViewer {
  return (
    isRecord(value) &&
    exactKeys(value, ['accountId']) &&
    noticeId(value.accountId) &&
    (accountId === undefined || value.accountId === accountId)
  );
}

function bulkMarkSeenPath(accountId: string) {
  return `/v1/accounts/${encodeURIComponent(accountId)}/notifications:markSeen`;
}

function validPageActions(
  value: unknown,
  items: readonly InboxNotice[],
  next: string | null,
  selection: InboxSelection,
  accountId: string,
): value is InboxPageActions {
  if (!isRecord(value) || !exactKeys(value, ['markSeen'])) return false;
  const admitted = value.markSeen;
  if (admitted === null) return true;
  if (
    !isRecord(admitted) ||
    !exactKeys(admitted, ['method', 'path', 'through']) ||
    admitted.method !== 'POST' ||
    admitted.path !== bulkMarkSeenPath(accountId) ||
    !noticeId(admitted.through)
  )
    return false;
  const through = items.find((item) => item.id === admitted.through);
  if (!through || !items.some((item) => item.unread)) return false;
  if (selection === 'unread' && next !== null) return false;
  return through.id === items[0]?.id;
}

export function inboxPageActions(
  items: readonly { id: string; unread: boolean }[],
  next: string | null,
  selection: InboxSelection,
  accountId: string,
): InboxPageActions {
  const newest = items[0];
  if (!newest || !items.some((item) => item.unread) || (selection === 'unread' && next !== null))
    return { markSeen: null };
  return { markSeen: { method: 'POST', path: bulkMarkSeenPath(accountId), through: newest.id } };
}

export function nativeInboxEnvelope<T extends { id: string; unread: boolean }>(
  items: readonly T[],
  next: string | null,
  accountId: string,
  selection: InboxSelection = DEFAULT_INBOX_SELECTION,
) {
  return {
    items: [...items],
    next,
    viewer: { accountId },
    selection,
    actions: inboxPageActions(items, next, selection, accountId),
  };
}

export function readyInboxPage<T extends { id: string; unread: boolean }>(
  items: readonly T[],
  next: string | null,
  accountId: string,
  selection: InboxSelection = DEFAULT_INBOX_SELECTION,
) {
  return {
    signedIn: true as const,
    state: 'ready' as const,
    ...nativeInboxEnvelope(items, next, accountId, selection),
  };
}

/** A malformed or unknown row fails the complete page; the native page already owns disclosure and destinations. */
export function decodeInboxPage(value: unknown, accountId?: string): NoticePage {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['items', 'next', 'viewer', 'selection', 'actions']) ||
    !Array.isArray(value.items) ||
    value.items.length > INBOX_PAGE_SIZE ||
    !(
      value.next === null ||
      (typeof value.next === 'string' && value.next.length > 0 && value.next.length <= MAX_INBOX_CURSOR_LENGTH)
    ) ||
    !isInboxSelection(value.selection)
  )
    throw new InboxReadError({ status: 200 });
  const viewer = value.viewer;
  if (!validPageViewer(viewer, accountId)) throw new InboxReadError({ status: 200 });
  const items = value.items.map((item) => {
    if (!validNotice(item, accountId ?? viewer.accountId)) throw new InboxReadError({ status: 200 });
    return projectNativeNotice(item);
  });
  const next = value.next as string | null;
  const selection = value.selection;
  const actions = value.actions;
  if (!validPageActions(actions, items, next, selection, viewer.accountId)) throw new InboxReadError({ status: 200 });
  return { items, next, viewer, selection, actions };
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
    viewer: page.viewer,
    selection: page.selection,
    actions: page.actions,
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

export function decodeUnreadCount(value: unknown, status?: number): UnreadCountReady {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.count) ||
    value.count < 0 ||
    value.count > 100 ||
    typeof value.capped !== 'boolean' ||
    (value.capped && value.basis === 'current-visible-unread' && value.count !== 100) ||
    (!value.capped && value.basis === 'current-visible-lower-bound') ||
    (value.basis !== 'current-visible-unread' && value.basis !== 'current-visible-lower-bound') ||
    !isRecord(value.witness) ||
    !exactKeys(value.witness, ['kind', 'at']) ||
    value.witness.kind !== 'current-disclosure' ||
    typeof value.witness.at !== 'string' ||
    !Number.isFinite(Date.parse(value.witness.at)) ||
    new Date(value.witness.at).toISOString() !== value.witness.at
  )
    throw new InboxReadError({ status: status ?? 200 });
  return {
    count: value.count,
    capped: value.capped,
    basis: value.basis,
    witness: { kind: value.witness.kind, at: value.witness.at },
  };
}

export function inboxKindLabel(item: Pick<InboxNotice, 'kind' | 'watch' | 'reportId'>): string {
  if (item.kind === 'thread_watch' || item.watch === 'thread') return m.inbox_kind_thread_activity();
  if (item.kind === 'board_activity' || item.watch === 'board') return m.inbox_kind_board_activity();
  if (item.reportId || item.kind === 'moderation_decision') return m.inbox_kind_moderation();
  if (item.kind === 'mention') return m.inbox_kind_mention();
  if (item.kind === 'reply') return m.inbox_kind_reply();
  return m.inbox_kind_unknown();
}
