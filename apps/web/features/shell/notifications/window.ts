import type { MainClient } from '../../feed/types.ts';
import { settle, type Loaded } from '../../feed/types.ts';

// Main pages filtered matches newest first with `before`. Its continuation owns
// coverage: sequence gaps cannot tell the client whether more matches remain.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type StreamPage = Ok<MainClient['v1']['me']['notifications']['get']>;
export type NotificationCount = Ok<MainClient['v1']['me']['notifications']['unread-count']['get']>;
export type NotificationDelivery = Ok<ReturnType<MainClient['v1']['deliveries']>['get']>;
export type StreamItem = StreamPage['items'][number];
type StreamGroup = StreamPage['groups'][number];

/** Matches per page: Main's largest page. */
const NOTIFICATION_WINDOW = 50;

/**
 * Main filters with `view` and `reason`. A reason is why this person receives a
 * correction (`steward`, `author`, `reviewer`, `manual`). Mentions stay in the
 * inbox as the social topic `mention`; the API has no mention reason to filter.
 */
export const inboxViews = ['inbox', 'saved', 'done'] as const;
export type InboxView = (typeof inboxViews)[number];
export const inboxReasons = ['steward', 'author', 'reviewer', 'manual'] as const;
export type InboxReason = (typeof inboxReasons)[number];
export interface NotificationSelection { view: InboxView; reason: InboxReason | null }

/** Unknown query values are the inbox with no reason, which is what Main serves when they are omitted. */
export function parseSelection(search: { view?: string; reason?: string }): NotificationSelection {
  const view = (inboxViews as readonly string[]).includes(search.view ?? '') ? search.view as InboxView : 'inbox';
  const reason = (inboxReasons as readonly string[]).includes(search.reason ?? '') ? search.reason as InboxReason : null;
  return { view, reason };
}

/** Inbox with no reason has a clean URL; every other selection is in the query so a reload asks Main again. */
export function notificationsHref(selection: NotificationSelection): string {
  const params = new URLSearchParams();
  if (selection.view !== 'inbox') params.set('view', selection.view);
  if (selection.reason) params.set('reason', selection.reason);
  const query = params.toString();
  return query ? `/notifications?${query}` : '/notifications';
}

export interface NotificationWindow {
  generation: string;
  head: string;
  readThrough: string;
  reset: boolean;
  /** Newest first, as Main returns this page. */
  items: StreamItem[];
  groups: StreamGroup[];
  /** Main's older-page continuation, or null after the oldest matching item. */
  next: string | null;
  /** Main's count, never inferred from this filtered or partial window. */
  unreadCount?: Loaded<NotificationCount>;
}

/** The triage owner revision wins independently of page and count completion order. */
export function mergeNotificationTriage(item: StreamItem,
  triage: Pick<StreamItem, 'saved' | 'done' | 'triageRevision'>): StreamItem {
  if (BigInt(triage.triageRevision ?? '0') <= BigInt(item.triageRevision ?? '0')) return item;
  return { ...item, saved: triage.saved, done: triage.done, triageRevision: triage.triageRevision };
}

/** Read at most 50 matches using Main's continuation unchanged. */
export async function readWindow(main: MainClient, before: string | null,
  selection: NotificationSelection = { view: 'inbox', reason: null }):
  Promise<Loaded<NotificationWindow>> {
  const query: { before: string; limit: number; view?: 'saved' | 'done'; reason?: InboxReason } = {
    before: before ?? 'latest', limit: NOTIFICATION_WINDOW };
  if (selection.view !== 'inbox') query.view = selection.view;
  if (selection.reason) query.reason = selection.reason;
  const page = await settle(() => main.v1.me.notifications.get({ query }));
  if (!page.ok) return page;
  return { ok: true, data: { generation: page.data.generation, head: page.data.head,
    readThrough: page.data.readThrough, reset: page.data.reset,
    items: page.data.items, groups: page.data.groups, next: page.data.next } };
}

/** Start the selected list; the page response carries the current head too. */
export async function readLatest(main: MainClient,
  selection: NotificationSelection = { view: 'inbox', reason: null }): Promise<Loaded<NotificationWindow>> {
  const [page, unreadCount] = await Promise.all([readWindow(main, null, selection), readNotificationCount(main)]);
  if (!page.ok) return page;
  if (!unreadCount.ok && unreadCount.failure === 'sign-in') return unreadCount;
  return { ok: true, data: { ...page.data, unreadCount } };
}

export function readNotificationCount(main: MainClient): Promise<Loaded<NotificationCount>> {
  return settle(() => main.v1.me.notifications['unread-count'].get());
}

/** Delivery authority belongs to Main's recipient read, independently of item/process authority. */
export async function readNotificationDelivery(main: MainClient, delivery: string,
  item?: string): Promise<Loaded<NotificationDelivery>> {
  const result = await settle(() => main.v1.deliveries({ delivery }).get());
  if (result.ok && (result.data.id !== delivery || (item !== undefined && result.data.itemId !== item)))
    return { ok: false, failure: 'unavailable' };
  return result;
}
